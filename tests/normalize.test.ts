import { test } from "node:test";
import assert from "node:assert/strict";
import type { SessionEntry, SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import { DEFAULT_NORMALIZE_LIMITS, NORMALIZATION_POLICY_VERSION, normalizeEvidence } from "../src/snapshot.ts";

function entry(partial: Record<string, unknown> & { id: string }): SessionEntry {
  return { parentId: null, timestamp: new Date(0).toISOString(), ...partial } as unknown as SessionEntry;
}

function userMsg(id: string, text: string): SessionMessageEntry {
  return entry({ type: "message", id, message: { role: "user", content: [{ type: "text", text }], timestamp: 0 } }) as SessionMessageEntry;
}

function assistantMsg(id: string, blocks: unknown[]): SessionMessageEntry {
  return entry({
    type: "message",
    id,
    message: {
      role: "assistant",
      content: blocks,
      api: "openai-completions",
      provider: "openai",
      model: "m",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop",
      timestamp: 0,
    },
  }) as SessionMessageEntry;
}

function toolResultMsg(id: string, text: string, isError = false): SessionMessageEntry {
  return entry({
    type: "message",
    id,
    message: { role: "toolResult", toolCallId: "tc1", toolName: "bash", content: [{ type: "text", text }], isError, timestamp: 0 },
  }) as SessionMessageEntry;
}

// Spec §7.2 inclusion table

test("user and assistant text retained with provenance; origin labeled honestly (§7.2)", () => {
  const out = normalizeEvidence([userMsg("u1", "use option 1"), assistantMsg("a1", [{ type: "text", text: "done" }])]);
  assert.equal(out.policyVersion, NORMALIZATION_POLICY_VERSION);
  assert.deepEqual(out.items.map((i) => [i.sourceId, i.role]), [["u1", "user"], ["a1", "assistant"]]);
  assert.equal(out.items[0]!.origin, "unknown", "unmarked user role is honestly unknown");
  assert.equal(out.items[1]!.origin, null);
});

test("reasoning/thinking blocks excluded (§7.2)", () => {
  const out = normalizeEvidence([
    assistantMsg("a1", [
      { type: "thinking", thinking: "secret chain of thought" },
      { type: "text", text: "visible answer" },
    ]),
  ]);
  assert.equal(out.items.length, 1);
  assert.equal(out.items[0]!.text, "visible answer");
  assert.ok(!JSON.stringify(out).includes("secret chain of thought"));
});

test("media replaced by explicit omitted-media marker, never interpreted (§7.2)", () => {
  const out = normalizeEvidence([
    entry({ type: "message", id: "u1", message: { role: "user", content: [{ type: "image", data: "AAAA", mimeType: "image/png" }], timestamp: 0 } }),
  ]);
  assert.equal(out.items.length, 1);
  assert.match(out.items[0]!.text, /\[omitted media: image\/png\]/);
  assert.ok(!out.items[0]!.text.includes("AAAA"), "no base64 payload");
});

test("compaction summaries are not fresh evidence (§7.2, T07)", () => {
  const out = normalizeEvidence([
    userMsg("u1", "original decision: use TypeScript"),
    entry({ type: "compaction", id: "c1", summary: "summary of u1", firstKeptEntryId: "u1", tokensBefore: 100 }),
  ]);
  assert.deepEqual(out.items.map((i) => i.sourceId), ["u1"]);
  assert.ok(out.omissions.some((o) => o.entryId === "c1" && o.reason.includes("compaction")));
});

test("own pi_memory messages and other extensions' custom messages excluded (§7.2, T15)", () => {
  const out = normalizeEvidence([
    userMsg("u1", "real user text"),
    entry({ type: "custom_message", id: "cm1", customType: "pi_memory", content: "memory tool output", display: false }),
    entry({ type: "custom_message", id: "cm2", customType: "other_ext", content: "foreign", display: false }),
    entry({ type: "custom", id: "cu1", customType: "other_ext", details: {} }),
  ]);
  assert.deepEqual(out.items.map((i) => i.sourceId), ["u1"]);
  assert.equal(out.omissions.length, 3);
});

test("redaction precedes truncation so cut-off secret prefixes cannot leak", () => {
  const secret = "sk-ABCDEFGHIJKLMNOPQRSTUVWX";
  const out = normalizeEvidence([userMsg("u1", "preamble ".repeat(3) + secret + "y".repeat(200))],
    { limits: { itemBytes: 40, toolResultBytes: 40, totalBytes: 100 } });
  assert.ok(!out.items[0]!.text.includes("sk-"));
  assert.ok(Buffer.byteLength(out.items[0]!.text, "utf8") <= 40);
});

test("assistant prose and tool calls retain distinct roles and bounds", () => {
  const out = normalizeEvidence([assistantMsg("a1", [
    { type: "text", text: "I propose TypeScript" },
    { type: "toolCall", id: "tc1", name: "bash", arguments: { command: "x".repeat(20_000) } },
  ])]);
  assert.deepEqual(out.items.map((i) => i.role), ["assistant", "tool"]);
  assert.equal(out.items[0]!.text, "I propose TypeScript");
  assert.ok(Buffer.byteLength(out.items[1]!.text, "utf8") <= DEFAULT_NORMALIZE_LIMITS.toolResultBytes);
});

test("tool calls and results included with bounds; failed tools are eligible (§7.2)", () => {
  const out = normalizeEvidence([
    assistantMsg("a1", [{ type: "toolCall", id: "tc1", name: "bash", arguments: { command: "ls" } }]),
    toolResultMsg("t1", "file.txt", true),
  ]);
  const call = out.items.find((i) => i.sourceId === "a1");
  const result = out.items.find((i) => i.sourceId === "t1");
  assert.equal(call?.role, "tool");
  assert.match(call?.text ?? "", /bash/);
  assert.equal(result?.role, "tool");
  assert.equal(result?.isError, true, "failed tool kept as eligible evidence");
});

// Spec §7.3 budgets

test("per-item budget: 64 KiB user text truncated at a UTF-8 boundary with marker (T06)", () => {
  const big = "界".repeat(30_000); // 90 KB of 3-byte chars
  const out = normalizeEvidence([userMsg("u1", big)]);
  const item = out.items[0]!;
  assert.equal(item.truncated, true);
  assert.ok(Buffer.byteLength(item.text, "utf8") <= DEFAULT_NORMALIZE_LIMITS.itemBytes);
  assert.match(item.text, /truncated/);
  assert.ok(!item.text.includes("\uFFFD"), "no broken UTF-8");
});

test("tool results bounded to 8 KiB", () => {
  const out = normalizeEvidence([toolResultMsg("t1", "x".repeat(20_000))]);
  assert.equal(out.items[0]!.truncated, true);
  assert.ok(Buffer.byteLength(out.items[0]!.text, "utf8") <= DEFAULT_NORMALIZE_LIMITS.toolResultBytes);
});

test("total budget: tiered selection user→assistant→tool, newest wins, chronological render, omissions manifest (§7.3)", () => {
  const limits = { itemBytes: 1024, toolResultBytes: 512, totalBytes: 3 * 1024 };
  const entries: SessionEntry[] = [];
  for (let i = 0; i < 6; i++) entries.push(userMsg(`u${i}`, `user-${i}-` + "u".repeat(500)));
  for (let i = 0; i < 6; i++) entries.push(toolResultMsg(`t${i}`, "t".repeat(500)));
  const out = normalizeEvidence(entries, { limits });
  const total = out.items.reduce((n, i) => n + Buffer.byteLength(i.text, "utf8"), 0);
  assert.ok(total <= limits.totalBytes, `total ${total} <= ${limits.totalBytes}`);
  assert.ok(out.items.every((i) => i.role === "user"), "user tier outranks tool tier");
  const ids = out.items.map((i) => i.sourceId);
  assert.deepEqual(ids, [...ids].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1))), "rendered chronologically");
  assert.ok(out.items.some((i) => i.sourceId === "u5"), "newest user evidence wins within tier");
  assert.ok(out.omissions.filter((o) => o.reason === "budget-exceeded").length >= 6, "omissions manifest records drops");
});

test("secrets are redacted in evidence (spec §7 issue body)", () => {
  const out = normalizeEvidence([userMsg("u1", "my key is sk-ABCDEFGHIJKLMNOPQRSTUVWX ok")]);
  assert.ok(!out.items[0]!.text.includes("sk-ABCDEFGHIJKLMNOPQRSTUVWX"));
  assert.ok(out.items[0]!.text.includes("[REDACTED]"));
});

test("T06: Chinese rationale and identifiers survive intact", () => {
  const out = normalizeEvidence([userMsg("u1", "决定使用 TypeScript 而不是 Rust，因为类型更安全")]);
  assert.equal(out.items[0]!.text, "决定使用 TypeScript 而不是 Rust，因为类型更安全");
});
