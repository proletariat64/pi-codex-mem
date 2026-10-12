import { truncateTextTokens, truncateTextBytes } from "../codex-truncation.ts";
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type, type TSchema } from "typebox";
import type { EvidenceAccess, EvidenceOperation, MemoryReadPin } from "./evidence.ts";

export interface MemoryItem {
  path: string; startLine: number; endLine: number; sourceIds: string[]; content?: string; truncated?: boolean;
  sourceIdsTruncated?: boolean; omittedSourceIds?: number;
  sourceUnavailable?: boolean;
  retainedRanges?: { startLine: number; endLine: number }[];
  entryType?: "file" | "directory"; matchLineNumber?: number; matchedQueries?: string[];
}
export interface MemoryToolDetails {
  memoryVersion?: string; generationId?: string; items: MemoryItem[];
  truncated: boolean; cursor: string | null; error?: string; nextStartLine?: number | null;
}
export interface MemoryConsumer { consumerSession: string; runId: string }
export interface MemoryToolsInput {
  root: string; db: () => DatabaseSync | null; pin: () => MemoryReadPin | null;
  consumer: () => MemoryConsumer | null; now?: () => number; maxUnusedDays?: () => number;
}
// Pi response envelope ceiling: pagination and excerpts remain bounded even when
// Codex result/token limits admit more content. Never bypass pinned evidence access.
const CAP = 16_384;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
function boundedInteger(value: unknown, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error("invalid_arguments");
  return value;
}
function clip(text: string, maximum = 3_000): string {
  const bytes = Buffer.from(text);
  let end = Math.min(maximum, bytes.length);
  while ((bytes[end]! & 0xc0) === 0x80) end--;
  let excerpt = bytes.subarray(0, end).toString("utf8");
  // Text is serialized twice in the readable result and once in details.
  while (Buffer.byteLength(JSON.stringify(JSON.stringify(excerpt))) > 5_000) {
    excerpt = clip(excerpt, Math.floor(Buffer.byteLength(excerpt) / 2));
  }
  return excerpt;
}
function result(details: MemoryToolDetails) {
  return { content: [{ type: "text" as const, text: JSON.stringify(details) }], details };
}

/** All data access stays within a host-selected immutable pin, revalidated at each boundary. */
export function createMemoryTools(input: MemoryToolsInput): AgentTool<TSchema, MemoryToolDetails>[] {
  const tool = (name: string, description: string, parameters: TSchema,
    operation: (args: Record<string, unknown>, pin: MemoryReadPin, access: EvidenceAccess) => MemoryToolDetails): AgentTool<TSchema, MemoryToolDetails> => ({
    name, label: name, description, parameters,
    async execute(_id, raw, signal) {
      let pin: MemoryReadPin | null = null;
      try {
        if (signal?.aborted) throw new Error("aborted");
        pin = input.pin();
        if (!pin) {
          input.db();
          input.now?.() ?? Date.now();
          throw new Error("memory_unavailable");
        }
        return pin.withEvidence({ root: input.root, db: input.db, now: input.now, maxUnusedDays: input.maxUnusedDays },
          (access): EvidenceOperation<ReturnType<typeof result>> => {
            if (!raw || typeof raw !== "object" || Array.isArray(raw) || "version" in raw || "memoryVersion" in raw || "generationId" in raw) throw new Error("invalid_arguments");
            const args = raw as Record<string, unknown>;
            const details = operation(args.path === undefined ? args : { ...args, path: access.normalizePath(args.path) }, pin!, access);
            const first = details.items[0];
            const last = details.items[details.items.length - 1];
            const detailUse = name === "pi_memory_read" && first && last
              ? { path: first.path, startLine: first.startLine, endLine: last.endLine,
                  ...(first.retainedRanges ? { ranges: first.retainedRanges } : {}) }
              : undefined;
            return {
              complete: () => {
                const output = result(details);
                if (Buffer.byteLength(JSON.stringify(output)) > CAP) throw new Error("response_too_large");
                return output;
              },
              ...(detailUse ? { detailUse } : {}),
            };
          }, input.consumer);
      } catch (error) {
        const known = ["memory_unavailable", "path_not_available_for_version", "invalid_arguments", "invalid_cursor", "response_too_large", "aborted", "line_offset_exceeds_file_length"];
        const message = (error as Error).message;
        return result({ ...(pin ? { memoryVersion: pin.memoryVersion, generationId: pin.generationId } : {}),
          items: [], truncated: false, cursor: null, error: known.includes(message) ? message : "memory_unavailable" });
      }
    },
  });
  const page = (args: Record<string, unknown>, pin: MemoryReadPin, fingerprint: string, items: MemoryItem[], limit: number): MemoryToolDetails => {
    const queryHash = hash(fingerprint);
    let offset = 0;
    if (args.cursor !== undefined) {
      try {
        if (typeof args.cursor !== "string" || args.cursor.length > 2048) throw new Error();
        const cursor = JSON.parse(Buffer.from(args.cursor, "base64url").toString("utf8"));
        if (cursor.memoryVersion !== pin.memoryVersion || cursor.generationId !== pin.generationId || cursor.queryHash !== queryHash ||
            !Number.isSafeInteger(cursor.offset) || cursor.offset < 0 || cursor.offset > items.length) throw new Error();
        offset = cursor.offset;
      } catch { throw new Error("invalid_cursor"); }
    }
    const output: MemoryToolDetails = { memoryVersion: pin.memoryVersion, generationId: pin.generationId, items: [], truncated: false, cursor: null };
    const update = () => { output.truncated = offset < items.length || output.items.some(item => item.truncated || item.sourceIdsTruncated);
      output.cursor = offset < items.length ? Buffer.from(JSON.stringify({ memoryVersion: pin.memoryVersion, generationId: pin.generationId, queryHash, offset })).toString("base64url") : null; };
    update();
    while (offset < items.length && output.items.length < limit) {
      output.items.push(items[offset++]!); update();
      if (Buffer.byteLength(JSON.stringify(result(output))) > CAP) { output.items.pop(); offset--; update(); break; }
    }
    if (!output.items.length && offset < items.length) throw new Error("response_too_large");
    return output;
  };
  const pathArg = Type.Optional(Type.String({ maxLength: 512 }));
  return [tool("pi_memory_search", "Search pinned evidence with literal or alphanumeric-normalized queries, same-line or minimal multi-line matches and context. Results are paginated under the host response byte ceiling.", Type.Object({
    queries: Type.Array(Type.String({ minLength: 1, maxLength: 1024 }), { minItems: 1, maxItems: 8 }), path: pathArg,
    match: Type.Union([Type.Literal("any"), Type.Literal("all"), Type.Literal("all_on_same_line"), Type.Literal("all_within_lines")]),
    lineCount: Type.Optional(Type.Integer({ minimum: 1 })), contextLines: Type.Optional(Type.Integer({ minimum: 0 })),
    normalized: Type.Optional(Type.Boolean()), caseSensitive: Type.Optional(Type.Boolean()),
    maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })), cursor: Type.Optional(Type.String()),
  }, { additionalProperties: false }), (args, pin, access) => {
    if (!Array.isArray(args.queries) || args.queries.length < 1 || args.queries.length > 8 ||
        args.queries.some(query => typeof query !== "string" || !query.trim() || query.length > 1024) ||
        !["any", "all", "all_on_same_line", "all_within_lines"].includes(args.match as string) ||
        (args.caseSensitive !== undefined && typeof args.caseSensitive !== "boolean") ||
        (args.normalized !== undefined && typeof args.normalized !== "boolean")) throw new Error("invalid_arguments");
    const fold = (text: string) => {
      const folded = args.caseSensitive === false ? text.toLowerCase() : text;
      return args.normalized ? folded.replace(/[^\p{Alphabetic}\p{N}]/gu, "") : folded;
    };
    const rawQueries = (args.queries as string[]).map(query => query.trim());
    const queries = rawQueries.map(fold);
    if (queries.some(query => !query)) throw new Error("invalid_arguments");
    const window = args.match === "all_within_lines" ? boundedInteger(args.lineCount, 1, Number.MAX_SAFE_INTEGER) : 1;
    const context = args.contextLines === undefined ? 0 : args.contextLines;
    if (typeof context !== "number" || !Number.isSafeInteger(context) || context < 0) throw new Error("invalid_arguments");
    const items: MemoryItem[] = [];
    for (const path of access.paths(args.path ?? ".")) {
      const { lines: rawLines, attribution } = access.attributedLines(path);
      // Rust str::lines omits the final empty line and strips CR in CRLF.
      const lines = rawLines.slice(0, rawLines.length - (rawLines.at(-1) === "" ? 1 : 0)).map(line => line.endsWith("\r") ? line.slice(0, -1) : line);
      const flags = lines.map(line => queries.map(query => fold(line).includes(query)));
      const windows: [number, number, boolean[]][] = [];
      if (args.match === "all_within_lines") {
        // Keep query occurrence counts over [start, right). Each boundary moves
        // forward once, including when a requested query is absent everywhere.
        const counts = queries.map(() => 0);
        let right = 0;
        let missing = queries.length;
        for (let start = 0; start < lines.length; start++) {
          const last = Math.min(lines.length, start + window);
          while (right < last && missing > 0) {
            flags[right]!.forEach((matched, index) => {
              if (matched && counts[index]!++ === 0) missing--;
            });
            right++;
          }
          if (missing === 0 && flags[start]!.some(Boolean)) {
            windows.push([start, right - 1, queries.map(() => true)]);
          }
          if (start < right) flags[start]!.forEach((matched, index) => {
            if (matched && --counts[index]! === 0) missing++;
          });
        }
      } else {
        flags.forEach((matched, index) => {
          if (args.match === "any" ? matched.some(Boolean) : matched.every(Boolean)) {
            windows.push([index, index, matched]);
          }
        });
      }
      // Starts are strictly increasing. A later window is contained in this
      // one exactly when its end is no greater; retain the suffix minimum ends
      // in one reverse pass rather than comparing every pair of matches.
      const minimalWindows: typeof windows = [];
      let minimumEnd = Infinity;
      for (let index = windows.length - 1; index >= 0; index--) {
        const candidate = windows[index]!;
        if (candidate[1] < minimumEnd) minimalWindows.push(candidate);
        minimumEnd = Math.min(minimumEnd, candidate[1]);
      }
      for (const [start, end, matched] of minimalWindows.reverse()) {
        const first = Math.max(0, start - context); const last = Math.min(lines.length, end + context + 1);
        const original = lines.slice(first, last).join("\n"); const content = clip(original);
        items.push({ path, startLine: first + 1, endLine: last, matchLineNumber: start + 1,
          matchedQueries: rawQueries.filter((_, index) => matched[index]), content,
          ...access.sourceMetadata([...new Set(attribution.slice(first, last).flat())]), ...(content !== original ? { truncated: true } : {}) });
      }
    }
    return page(args, pin, JSON.stringify(["search", args.path ?? ".", rawQueries, args.match, args.caseSensitive ?? true, args.normalized ?? false, window, context]), items, Math.min(boundedInteger(args.maxResults, 200, Number.MAX_SAFE_INTEGER), 200));
  }),
  tool("pi_memory_list", "List immediate reader-allowed child files and directories in the pinned generation. The host byte ceiling may paginate before the 2000-entry limit.", Type.Object({
    path: pathArg, limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 2000 })), cursor: Type.Optional(Type.String()),
  }, { additionalProperties: false }), (args, pin, access) => {
    const scope = args.path ?? ".";
    const files = access.paths(scope);
    const entries = new Map<string, MemoryItem>();
    for (const path of files) {
      const tail = scope === "." ? path : path === scope ? "" : path.slice((scope as string).length + 1);
      const child = tail.split("/")[0]!;
      const entry = tail.includes("/") ? (scope === "." ? child : `${scope}/${child}`) : path;
      if (entries.has(entry)) continue;
      if (entry !== path) entries.set(entry, { path: entry, entryType: "directory", startLine: 1, endLine: 1, sourceIds: [] });
      else {
        const text = access.read(path);
        entries.set(entry, { path, entryType: "file", startLine: 1, endLine: text.split("\n").length, ...access.sourceMetadata(access.sources(path, text)) });
      }
    }
    const items = [...entries.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    return page(args, pin, JSON.stringify(["list", scope]), items, Math.min(boundedInteger(args.limit, 2000, Number.MAX_SAFE_INTEGER), 2000));
  }),
  tool("pi_memory_read", "Read allowed pinned evidence from a 1-based line offset, with optional line and token limits. startLine aliases lineOffset. The host byte ceiling can truncate before the token limit; nextStartLine continues remaining lines.", Type.Object({
    path: Type.String({ minLength: 1, maxLength: 512 }), startLine: Type.Optional(Type.Integer({ minimum: 1 })),
    lineOffset: Type.Optional(Type.Integer({ minimum: 1 })), maxLines: Type.Optional(Type.Integer({ minimum: 1 })),
    maxTokens: Type.Optional(Type.Integer({ minimum: 0 })),
  }, { additionalProperties: false }), (args, pin, access) => {
    if (typeof args.path !== "string" || !access.isReadablePath(args.path)) throw new Error("path_not_available_for_version");
    if (!access.paths(args.path).includes(args.path)) throw new Error("memory_unavailable");
    const { lines, attribution } = access.attributedLines(args.path);
    if (args.startLine !== undefined && args.lineOffset !== undefined && args.startLine !== args.lineOffset) throw new Error("invalid_arguments");
    const start = boundedInteger(args.lineOffset ?? args.startLine, 1, Number.MAX_SAFE_INTEGER);
    const limit = boundedInteger(args.maxLines, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
    if (start > lines.length) throw new Error("line_offset_exceeds_file_length");
    const tokens = args.maxTokens === 0 ? 20_000 : boundedInteger(args.maxTokens, 20_000, Number.MAX_SAFE_INTEGER);
    const details: MemoryToolDetails = { memoryVersion: pin.memoryVersion, generationId: pin.generationId,
      items: [], truncated: false, cursor: null, nextStartLine: null };
    // Apply the native token policy to the requested byte range before Pi's
    // independent response envelope ceiling. Keep original range identity for
    // attribution, including both ends of native middle-truncated content.
    const selectedEnd = Math.min(lines.length, start - 1 + limit);
    const selected = lines.slice(start - 1, selectedEnd).join("\n") + (selectedEnd < lines.length ? "\n" : "");
    const nativeContent = truncateTextTokens(selected, tokens);
    if (nativeContent !== selected) {
      const bytes = Buffer.from(selected, "utf8");
      const candidate = (byteBudget: number): MemoryToolDetails => {
        let prefixEnd = Math.floor(byteBudget / 2);
        while ((bytes[prefixEnd]! & 0xc0) === 0x80) prefixEnd--;
        let suffixStart = bytes.length - (byteBudget - Math.floor(byteBudget / 2));
        while ((bytes[suffixStart]! & 0xc0) === 0x80) suffixStart++;
        const lineAt = (offset: number) => start + bytes.subarray(0, offset).toString("utf8").split("\n").length - 1;
        const ranges = [
          ...(prefixEnd > 0 ? [{ startLine: start, endLine: lineAt(prefixEnd - 1) }] : []),
          ...(suffixStart < bytes.length ? [{ startLine: lineAt(suffixStart), endLine: selectedEnd }] : []),
        ];
        const content = truncateTextBytes(selected, byteBudget);
        const sources = [...new Set(ranges.flatMap(range => attribution.slice(range.startLine - 1, range.endLine).flat()))];
        return { ...details, items: [{ path: args.path as string, startLine: start, endLine: selectedEnd,
          content, truncated: true, retainedRanges: ranges, ...access.sourceMetadata(sources) }], truncated: true,
          // Resume at the first omitted line (including a partially returned line).
          nextStartLine: Math.min(lineAt(prefixEnd), selectedEnd) };
      };
      // Preserve both ends and the native marker; admit the entire JSON envelope
      // instead of silently clipping off the suffix after native truncation.
      let lower = 1;
      let upper = Math.min(bytes.length - 1, tokens * 4);
      let admitted: MemoryToolDetails | null = null;
      while (lower <= upper) {
        const middle = Math.floor((lower + upper) / 2);
        const output = candidate(middle);
        if (Buffer.byteLength(JSON.stringify(result(output))) <= CAP) { admitted = output; lower = middle + 1; }
        else upper = middle - 1;
      }
      if (!admitted || !admitted.items[0]!.retainedRanges!.length) throw new Error("response_too_large");
      return admitted;
    }
    let end = start - 1;
    while (end < lines.length && details.items.length < limit) {
      const line = lines[end]!;
      const content = clip(line);
      details.items.push({ path: args.path, startLine: end + 1, endLine: end + 1, content,
        ...access.sourceMetadata(attribution[end]!), ...(content !== line ? { truncated: true } : {}) });
      end++;
      if (Buffer.byteLength(JSON.stringify(result(details))) > CAP - 128) { details.items.pop(); end--; break; }
    }
    if (!details.items.length && end < lines.length) throw new Error("response_too_large");
    details.truncated = end < lines.length || details.items.some(item => item.truncated || item.sourceIdsTruncated);
    details.nextStartLine = end < lines.length ? end + 1 : null;
    return details;
  })];
}
