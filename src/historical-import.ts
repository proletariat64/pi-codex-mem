import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import type { SessionEntry, SessionHeader } from "@earendil-works/pi-coding-agent";
import { computeWorkspaceIdentity, type WorkspaceIdentity } from "./identity.ts";
import { captureSettledSession } from "./capture.ts";
import type { NormalizeLimits } from "./snapshot.ts";

/** Read-only report for explicit historical enrollment (spec §7.4). */
export interface ImportCandidate {
  path: string;
  header: SessionHeader;
  branch: SessionEntry[];
  leafId: string;
  bytes: number;
  contentHash: string;
  workspace: WorkspaceIdentity;
}

export interface ImportReport {
  candidates: ImportCandidate[];
  unsupported: { path: string; reason: string }[];
  deferred: { path: string; reason: string }[];
  ambiguous: { path: string; leaves: string[] }[];
  totalBytes: number;
}

export function planHistoricalImport(path: string, options: {
  leaf?: string;
  resolveSelectedLeaf?: (file: string, header: SessionHeader) => string | undefined;
} = {}): ImportReport {
  const file = resolve(path);
  const report: ImportReport = { candidates: [], unsupported: [], deferred: [], ambiguous: [], totalBytes: 0 };
  let before: ReturnType<typeof lstatSync>;
  try {
    before = lstatSync(file);
  } catch (err) {
    report.unsupported.push({ path: file, reason: `source unavailable: ${(err as Error).message}` });
    return report;
  }
  if (before.isDirectory()) {
    for (const name of readdirSync(file).sort((a, b) => a.localeCompare(b))) {
      const childPath = resolve(file, name);
      try {
        const child = planHistoricalImport(childPath, options);
        report.candidates.push(...child.candidates);
        report.unsupported.push(...child.unsupported);
        report.deferred.push(...child.deferred);
        report.ambiguous.push(...child.ambiguous);
        report.totalBytes += child.totalBytes;
      } catch (err) {
        report.unsupported.push({ path: childPath, reason: `unreadable: ${(err as Error).message}` });
      }
    }
    return report;
  }
  if (!before.isFile() || !file.endsWith(".jsonl")) {
    report.unsupported.push({ path: file, reason: before.isSymbolicLink() ? "symlink source rejected" : "not a regular JSONL session file" });
    report.totalBytes = before.isFile() ? before.size : 0;
    return report;
  }
  let bytes: Buffer;
  try {
    bytes = readFileSync(file);
  } catch (err) {
    report.unsupported.push({ path: file, reason: `unreadable: ${(err as Error).message}` });
    report.totalBytes = before.size;
    return report;
  }
  const after = lstatSync(file);
  report.totalBytes = bytes.length;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    report.unsupported.push({ path: file, reason: "invalid UTF-8 JSONL source" });
    return report;
  }
  const lines = text.split("\n");
  const terminated = bytes.at(-1) === 0x0a;
  if (terminated) lines.pop();
  // A live append can expose half of a final JSON record. Never repair the
  // original; wait for a quiescent source before considering that last line.
  const stable = before.size === after.size && before.mtimeMs === after.mtimeMs && Date.now() - after.mtimeMs >= 1000;
  if (!terminated && !stable) {
    report.deferred.push({ path: file, reason: "trailing incomplete or unterminated record; retry when stable" });
    return report;
  }
  const parsed: unknown[] = [];
  for (const [index, line] of lines.entries()) {
    try {
      parsed.push(JSON.parse(line) as unknown);
    } catch {
      report.unsupported.push({ path: file, reason: `line ${index + 1}: malformed JSONL` });
      return report;
    }
  }
  const header = parsed[0] as Partial<SessionHeader> | undefined;
  if (header?.type === "session" && typeof header.version === "number" && header.version !== 3) {
    report.unsupported.push({ path: file, reason: `version ${header.version} unsupported (requires JSONL v3)` });
    return report;
  }
  if (!header || header.type !== "session" || header.version !== 3 || typeof header.id !== "string" ||
      typeof header.cwd !== "string" || typeof header.timestamp !== "string") {
    report.unsupported.push({ path: file, reason: "unsupported session header or version" });
    return report;
  }
  const entries: SessionEntry[] = [];
  const byId = new Map<string, SessionEntry>();
  for (const [index, value] of parsed.slice(1).entries()) {
    const item = value as { type?: unknown; id?: unknown; parentId?: unknown; timestamp?: unknown } | null;
    if (!item || typeof item !== "object" || typeof item.type !== "string" ||
        typeof item.id !== "string" || !item.id ||
        (item.parentId !== null && typeof item.parentId !== "string") ||
        typeof item.timestamp !== "string" || item.type === "session") {
      report.unsupported.push({ path: file, reason: `line ${index + 2}: invalid v3 session entry` });
      return report;
    }
    if (item.type === "message") {
      const message = (value as { message?: unknown }).message;
      const role = message && typeof message === "object" ? (message as { role?: unknown }).role : undefined;
      const content = message && typeof message === "object" ? (message as { content?: unknown }).content : undefined;
      if (typeof role !== "string" || !(typeof content === "string" || Array.isArray(content))) {
        report.unsupported.push({ path: file, reason: `line ${index + 2}: invalid message payload` });
        return report;
      }
      if (Array.isArray(content) && content.some((block) =>
        !block || typeof block !== "object" || typeof block.type !== "string")) {
        report.unsupported.push({ path: file, reason: `line ${index + 2}: invalid content block` });
        return report;
      }
    }
    if (item.type === "context_edit") {
      const edit = value as { targetId?: unknown; replacement?: unknown };
      if (typeof edit.targetId !== "string" || !edit.targetId ||
          (edit.replacement !== null && (!edit.replacement || typeof edit.replacement !== "object" ||
            !("content" in edit.replacement)))) {
        report.unsupported.push({ path: file, reason: `line ${index + 2}: invalid context edit` });
        return report;
      }
    }
    if (byId.has(item.id)) {
      report.unsupported.push({ path: file, reason: `line ${index + 2}: duplicate entry ID ${item.id}` });
      return report;
    }
    if (item.parentId && !byId.has(item.parentId)) {
      report.unsupported.push({ path: file, reason: `line ${index + 2}: missing parent ${item.parentId}` });
      return report;
    }
    // SAFETY: the v3 tree base fields and append-order parent have been
    // validated; unknown extensible entry kinds are inert metadata in capture.
    const entry = item as unknown as SessionEntry;
    entries.push(entry);
    byId.set(entry.id, entry);
  }
  const parents = new Set(entries.map((entry) => entry.parentId));
  const leaves = entries.filter((entry) => !parents.has(entry.id));
  const captured = leaves.length === 1 ? undefined : options.resolveSelectedLeaf?.(file, header as SessionHeader);
  const leafId = options.leaf ?? (captured && byId.has(captured) ? captured : undefined) ??
    (leaves.length === 1 ? leaves[0]?.id : undefined);
  if (!leafId) {
    report.ambiguous.push({ path: file, leaves: leaves.map((entry) => entry.id) });
    return report;
  }
  const branch: SessionEntry[] = [];
  const visited = new Set<string>();
  let current: string | null = leafId;
  while (current !== null) {
    const entry: SessionEntry | undefined = byId.get(current);
    if (!entry || visited.has(current)) {
      report.unsupported.push({ path: file, reason: `leaf ${leafId}: missing or cyclic ancestry at ${current}` });
      return report;
    }
    branch.push(entry);
    visited.add(current);
    current = entry.parentId;
  }
  report.candidates.push({
    path: file, header: header as SessionHeader, branch: branch.toReversed(),
    leafId, bytes: bytes.length,
    contentHash: createHash("sha256").update(bytes).digest("hex"),
    workspace: computeWorkspaceIdentity(header.cwd),
  });
  return report;
}

/** Enroll only explicitly planned, supported branches through live capture's policy. */
export function enrollHistoricalImport(
  report: ImportReport,
  options: { root: string; agentDir: string; db: DatabaseSync; limits: NormalizeLimits; maxStoreBytes?: number },
): { imported: number; skipped: { path: string; reason: string }[] } {
  let imported = 0;
  const skipped: { path: string; reason: string }[] = [];
  for (const candidate of report.candidates) {
    try {
      if (lstatSync(candidate.path).isSymbolicLink() ||
          createHash("sha256").update(readFileSync(candidate.path)).digest("hex") !== candidate.contentHash) {
        skipped.push({ path: candidate.path, reason: "source changed since import plan" });
        continue;
      }
      const result = captureSettledSession({
        root: options.root, agentDir: options.agentDir, db: options.db,
        cwd: candidate.header.cwd, mode: "import", limits: options.limits,
        maxStoreBytes: options.maxStoreBytes,
        reader: {
          getBranch: () => candidate.branch,
          getHeader: () => candidate.header,
          getSessionFile: () => candidate.path,
          getLeafId: () => candidate.leafId,
        },
      });
      if (result.status === "captured") imported++;
      else skipped.push({ path: candidate.path, reason: result.reason });
    } catch (err) {
      skipped.push({ path: candidate.path, reason: (err as Error).message });
    }
  }
  return { imported, skipped };
}
