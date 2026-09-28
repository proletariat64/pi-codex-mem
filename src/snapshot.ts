import type { SessionEntry, SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import { redactSensitive } from "./sensitive.ts";

/**
 * Branch snapshot normalization (spec §7.1–7.3).
 * applyContextEdits → latest branch-local edit wins; null excludes.
 * normalizeEvidence → §7.2 inclusion/exclusion table, honest origin labels,
 * §7.3 byte budgets with tiered selection and an omissions manifest.
 */

export const NORMALIZATION_POLICY_VERSION = "norm-1";

/** Custom message types that must never become evidence (T15 self-exclusion). */
export const OWN_CUSTOM_TYPE = "pi_memory";

/** §7.1: apply the latest branch-local context_edit to each target. */
export function applyContextEdits<T extends SessionEntry>(entries: T[]): T[] {
  // Latest edit per target wins (entries are chronological on the branch).
  const edits = new Map<string, { content: unknown } | null>();
  for (const e of entries) {
    if (e.type === "context_edit") {
      const ce = e as { type: "context_edit"; targetId: string; replacement: { content: unknown } | null };
      edits.set(ce.targetId, ce.replacement);
    }
  }
  const out: T[] = [];
  for (const e of entries) {
    if (e.type === "context_edit") continue; // consumed
    if (edits.has(e.id)) {
      const replacement = edits.get(e.id);
      if (replacement === null || replacement === undefined) continue; // excluded
      if (e.type === "message") {
        out.push({ ...e, message: { ...e.message, content: replacement.content } } as T);
        continue;
      }
      if (e.type === "custom_message") {
        // These entries are excluded from evidence, but preserve correct
        // projection semantics for any future explicit custom adapter.
        out.push({ ...e, content: replacement.content } as T);
        continue;
      }
    }
    out.push(e);
  }
  return out;
}

export interface EvidenceItem {
  sourceId: string;
  entryId: string;
  /** Stable across copied fork ancestry when the parent snapshot is known. */
  evidenceKey?: string;
  timestamp: number;
  toolCallId?: string;
  role: "user" | "assistant" | "tool";
  text: string;
  origin: "human_observed" | "programmatic" | "unknown" | null;
  isError: boolean;
  truncated: boolean;
}

export interface Omission {
  entryId: string;
  reason: string;
}

export interface NormalizeResult {
  items: EvidenceItem[];
  omissions: Omission[];
  policyVersion: string;
}

export interface NormalizeLimits {
  itemBytes: number;
  toolResultBytes: number;
  totalBytes: number;
}

export const DEFAULT_NORMALIZE_LIMITS: NormalizeLimits = {
  itemBytes: 64 * 1024,
  toolResultBytes: 8 * 1024,
  totalBytes: 256 * 1024,
};

/** Truncate at a UTF-8 boundary, appending an explicit omission marker. */
export function truncateUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const buf = Buffer.from(text, "utf8");
  if (buf.byteLength <= maxBytes) return { text, truncated: false };
  const marker = "\n[…truncated]";
  const budget = Math.max(0, maxBytes - Buffer.byteLength(marker, "utf8"));
  let end = budget;
  // Find the start of the character containing the first excluded byte.
  let lead = end;
  while (lead > 0 && (buf[lead]! & 0b1100_0000) === 0b1000_0000) lead--;
  const b = buf[lead]!;
  const len = b < 0x80 ? 1 : b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : (b & 0b1100_0000) === 0b1100_0000 ? 2 : 1;
  if (lead + len > budget) end = lead; // a character spans the boundary: cut before it
  return { text: buf.subarray(0, end).toString("utf8") + marker, truncated: true };
}

interface ContentBlock {
  type?: string;
  text?: string;
  thinking?: string;
  data?: string;
  mimeType?: string;
  id?: string;
  name?: string;
  arguments?: unknown;
}

function renderBlocks(blocks: ContentBlock[], role: "user" | "assistant" | "tool"): string[] {
  const parts: string[] = [];
  for (const b of blocks) {
    if (b.type === "text" && typeof b.text === "string") {
      parts.push(b.text);
    } else if (["image", "audio", "video", "binary", "file"].includes(b.type ?? "") || typeof b.data === "string") {
      const mime = typeof b.mimeType === "string" && /^[a-z]+\/[a-z0-9.+-]{1,32}$/i.test(b.mimeType)
        ? b.mimeType : "unknown";
      parts.push(`[omitted media: ${mime}]`); // §7.2: never interpret
    } else if (b.type === "thinking") {
      // §7.2: reasoning excluded entirely
    } else if (b.type === "toolCall" && role === "assistant") {
      parts.push(`[tool call: ${b.name ?? "unknown"}(${JSON.stringify(b.arguments ?? {})})]`);
    }
  }
  return parts;
}

/** §7.2/§7.3: filter, bound, redact, tier-select, and record omissions. */
export function normalizeEvidence(
  entries: SessionEntry[],
  opts?: { limits?: NormalizeLimits },
): NormalizeResult {
  const limits = opts?.limits ?? DEFAULT_NORMALIZE_LIMITS;
  const omissions: Omission[] = [];
  const candidates: EvidenceItem[] = [];

  for (const e of entries) {
    const parsedTime = Date.parse(e.timestamp);
    const timestamp = Number.isFinite(parsedTime) ? parsedTime : 0;
    const base = { sourceId: e.id, entryId: e.id, timestamp };
    if (e.type === "message") {
      const m = (e as SessionMessageEntry).message as {
        role: string;
        content: unknown;
        toolName?: string;
        isError?: boolean;
      };
      const blocks: ContentBlock[] = typeof m.content === "string" ? [{ type: "text", text: m.content }] : Array.isArray(m.content) ? (m.content as ContentBlock[]) : [];
      if (m.role === "user") {
        const text = renderBlocks(blocks, "user").join("\n");
        if (text === "") {
          omissions.push({ entryId: e.id, reason: "empty-after-filtering" });
          continue;
        }
        const t = truncateUtf8(redactSensitive(text), limits.itemBytes);
        // pi persists programmatic text as role=user; absent known origin
        // metadata, label it unknown rather than inventing human authorship.
        const claimedOrigin = (m as { origin?: unknown }).origin;
        const origin = claimedOrigin === "human_observed" || claimedOrigin === "programmatic"
          ? claimedOrigin : "unknown";
        candidates.push({ ...base, role: "user", text: t.text, origin, isError: false, truncated: t.truncated });
      } else if (m.role === "assistant") {
        if (blocks.some((b) => b.type === "toolCall" && (b.name === "pi_memory" || b.name?.startsWith("pi_memory_")))) {
          omissions.push({ entryId: e.id, reason: "own-memory-tool-call-excluded" });
          continue;
        }
        const visible = blocks.filter((b) => b.type !== "toolCall");
        const text = renderBlocks(visible, "assistant").join("\n");
        if (text) {
          const t = truncateUtf8(redactSensitive(text), limits.itemBytes);
          candidates.push({ ...base, role: "assistant", text: t.text, origin: null, isError: false, truncated: t.truncated });
        }
        for (const call of blocks.filter((b) => b.type === "toolCall")) {
          const rendered = `[tool call: ${call.name ?? "unknown"}(${JSON.stringify(call.arguments ?? {})})]`;
          const t = truncateUtf8(redactSensitive(rendered), limits.toolResultBytes);
          candidates.push({ ...base, role: "tool", toolCallId: call.id, text: t.text, origin: null, isError: false, truncated: t.truncated });
        }
        if (!text && !blocks.some((b) => b.type === "toolCall")) {
          omissions.push({ entryId: e.id, reason: blocks.some((b) => b.type === "thinking") ? "reasoning-excluded" : "empty-after-filtering" });
        }
      } else if (m.role === "toolResult") {
        if (m.toolName === "pi_memory" || m.toolName?.startsWith("pi_memory_")) {
          omissions.push({ entryId: e.id, reason: "own-memory-tool-result-excluded" });
          continue;
        }
        const text = renderBlocks(blocks, "tool").join("\n");
        if (text === "") {
          omissions.push({ entryId: e.id, reason: "empty-after-filtering" });
          continue;
        }
        const t = truncateUtf8(redactSensitive(text), limits.toolResultBytes);
        candidates.push({
          ...base,
          role: "tool",
          toolCallId: (m as { toolCallId?: string }).toolCallId,
          text: t.text,
          origin: null,
          isError: m.isError === true,
          truncated: t.truncated,
        });
      } else {
        omissions.push({ entryId: e.id, reason: "system-or-unknown-role-excluded" });
      }
    } else if (e.type === "compaction" || e.type === "branch_summary") {
      // §7.2: derived context only, never fresh user statements (T07).
      omissions.push({ entryId: e.id, reason: "compaction-summary-derived-not-evidence" });
    } else if (e.type === "custom_message" || e.type === "custom") {
      const customType = (e as { customType?: string }).customType ?? "unknown";
      omissions.push({
        entryId: e.id,
        reason: customType === OWN_CUSTOM_TYPE ? "own-memory-message-excluded" : "foreign-extension-message-excluded",
      });
    } else {
      // usage, model-change, labels, session_info, thinking_level_change: metadata only.
      omissions.push({ entryId: e.id, reason: "metadata-not-evidence" });
    }
  }

  // §7.3 total budget: tiered selection user → assistant → tool, newest wins
  // within a tier, selected items rendered chronologically.
  const tiers: Record<string, number> = { user: 0, assistant: 1, tool: 2 };
  const byTier: EvidenceItem[][] = [[], [], []];
  for (const item of candidates) byTier[tiers[item.role]!]!.push(item);

  const selected = new Set<EvidenceItem>();
  let used = 0;
  for (const tier of byTier) {
    for (const item of [...tier].reverse()) {
      if (selected.has(item)) continue;
      const index = candidates.indexOf(item);
      const previous = candidates[index - 1];
      const dependsOnQuestion = item.role === "user" && Buffer.byteLength(item.text, "utf8") <= 128 &&
        previous && (previous.role === "assistant" || previous.role === "user") && previous.text.includes("?");
      // A short reply without its adjacent question would invent certainty
      // about what was chosen. Select the pair or omit the reply (§7.3).
      const group = dependsOnQuestion && !selected.has(previous) ? [previous, item] : [item];
      const bytes = group.reduce((sum, candidate) => sum + Buffer.byteLength(candidate.text, "utf8"), 0);
      if (used + bytes <= limits.totalBytes) {
        for (const candidate of group) selected.add(candidate);
        used += bytes;
      }
    }
  }
  const items = candidates.filter((i) => {
    if (selected.has(i)) return true;
    omissions.push({ entryId: i.sourceId, reason: "budget-exceeded" });
    return false;
  }); // candidates are already chronological

  return { items, omissions, policyVersion: NORMALIZATION_POLICY_VERSION };
}
