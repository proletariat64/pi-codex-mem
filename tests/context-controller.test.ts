import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeContext, type Message } from "@earendil-works/pi-ai";
import {
  DEFAULT_CONTEXT_COUNTING_POLICY,
  countModelVisibleRequest,
  createContextController,
  deriveModelCapacity,
} from "../src/pipeline/context-controller.ts";

/** Spec §3.3 worked example: the 272k-token window from spec §1.1. */
const window272k = { contextWindow: 272_000, maxTokens: 8_192 };

const div4 = (text: string): number => Math.ceil(Buffer.byteLength(text, "utf8") / 4);
const policy = DEFAULT_CONTEXT_COUNTING_POLICY;

/** Host-only usage payload that must never inflate a fallback text count. */
const hostUsage = {
  input: 999_999, output: 888_888, cacheRead: 777, cacheWrite: 666, totalTokens: 1_900_000,
  cost: { input: 1.5, output: 2.5, cacheRead: 0, cacheWrite: 0, total: 4 },
};

/** CT02: every model-visible item counted exactly once, with an independently written ledger. */
const visibleLedger = (noisy = false) => {
  const instruction = "You are the consolidation writer.";
  const section = "Summarize decided facts.";
  const tool = {
    name: "read_file",
    description: "Read a file from the staged workspace.",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  };
  const userText = "Consolidate this staged workspace.";
  const assistantText = "Reading the diff first.";
  const callArguments = { path: "phase2_workspace_diff.md" };
  const resultText = "diff body";
  const resultDetails = { bytes: 9 };
  const expected = div4(instruction) + div4(section) + div4("summary") + policy.messageFramingTokens
    + div4(tool.name) + div4(tool.description) + div4(JSON.stringify(tool.parameters)) + policy.toolDeclarationFramingTokens
    + div4(userText) + policy.messageFramingTokens
    + div4(assistantText) + policy.messageFramingTokens
    + div4("read_file") + div4(JSON.stringify(callArguments)) + policy.toolCallFramingTokens
    + div4("read_file") + div4(resultText) + policy.toolResultFramingTokens;
  const messages: Message[] = noisy ? [
    { role: "system", content: instruction, sections: { summary: section }, toolsAdded: [tool], timestamp: 1 },
    { role: "user", content: userText, timestamp: 2 },
    { role: "assistant", usage: { ...hostUsage, totalTokens: 9_000_000 }, timestamp: 9_999,
      api: "anthropic-messages", provider: "anthropic", model: "claude-x-long-name-host-only",
      responseId: "a-much-longer-host-response-id-123456", rawStopReason: "tool_calls", stopReason: "toolUse",
      content: [{ type: "text", text: assistantText },
        { type: "toolCall", id: "a-far-longer-host-tool-call-identifier-987654321", name: "read_file", arguments: callArguments }] },
    { role: "toolResult", toolCallId: "a-far-longer-host-tool-call-identifier-987654321", toolName: "read_file",
      isError: false, timestamp: 8_888, usage: hostUsage,
      nestedCalls: { complete: true, calls: [{ id: "nested", name: "other", status: "ok", durationMs: 5,
        arguments: { huge: "x".repeat(4000) } }] },
      content: [{ type: "text", text: resultText }], details: resultDetails },
  ] : [
    { role: "system", content: instruction, sections: { summary: section }, toolsAdded: [tool], timestamp: 1 },
    { role: "user", content: userText, timestamp: 2 },
    { role: "assistant", usage: hostUsage, timestamp: 3, api: "anthropic-messages", provider: "anthropic", model: "claude-x",
      responseId: "resp_host_only", stopReason: "toolUse",
      content: [{ type: "text", text: assistantText },
        { type: "toolCall", id: "call-1", name: "read_file", arguments: callArguments }] },
    { role: "toolResult", toolCallId: "call-1", toolName: "read_file", isError: false, timestamp: 4,
      content: [{ type: "text", text: resultText }], details: resultDetails },
  ];
  return { messages, expected };
};

/** Controller fixtures: the 272k-token writer model from spec §1.1. */
const writer = { provider: "fake", id: "writer", api: "openai-completions", contextWindow: 272_000, maxTokens: 8_192 };
const matchingCounter = (tokens: number) => ({
  count: () => ({ tokens, identity: { provider: "fake", modelId: "writer" } }),
});
const mismatchedCounter = (tokens: number) => ({
  count: () => ({ tokens, identity: { provider: "other-provider", modelId: "sibling-tokenizer" } }),
});

/** CT01: a settled tool transcript whose evidence body is ~404 KB of English text. */
const english404kb = (() => {
  const sentence = "The consolidated writer preserves decided facts, corrections and conflicts across sessions. ";
  const body = sentence.repeat(Math.ceil((404 * 1024) / Buffer.byteLength(sentence))).slice(0, 404 * 1024);
  const tool = { name: "read_file", description: "Read a file from the staged workspace.",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } };
  const messages: Message[] = [
    { role: "system", content: "You are the consolidation writer for this staged workspace.",
      sections: { boundaries: "Preserve corrections and conflicts verbatim." }, toolsAdded: [tool], timestamp: 1 },
    { role: "user", content: "Consolidate this staged workspace; read phase2_workspace_diff.md first.", timestamp: 2 },
    { role: "assistant", usage: hostUsage, api: "openai-completions", provider: "fake", model: "writer",
      stopReason: "toolUse", timestamp: 3,
      content: [{ type: "text", text: "Reading the diff first." },
        { type: "toolCall", id: "call-1", name: "read_file", arguments: { path: "phase2_workspace_diff.md" } }] },
    { role: "toolResult", toolCallId: "call-1", toolName: "read_file", isError: false, timestamp: 4,
      content: [{ type: "text", text: body }] },
  ];
  return messages;
})();

test("CT01: 272k window admits a ~404 KB English request under estimated admission while the old byte compare rejects it", () => {
  const controller = createContextController({ model: writer });
  // The §1.1 regression, reproduced at module level: bytes, not tokens, cross the old gate.
  const legacyBytes = Buffer.byteLength(JSON.stringify({ messages: english404kb }), "utf8");
  const legacyLimit = Math.floor((272_000 - 4_000 - 1_024) * 0.7);
  assert.ok(legacyBytes > legacyLimit, `legacy byte compare rejects at ${legacyBytes} > ${legacyLimit}`);
  assert.ok(legacyBytes >= 404 * 1024);
  const decision = controller.admission({ messages: english404kb });
  assert.equal(decision.action, "admit");
  assert.ok(decision.count.ok);
  assert.equal(decision.count.method, "utf8_div4_estimate");
  assert.equal(decision.count.units, "estimated_tokens");
  assert.ok(decision.admissionEstimate > Math.ceil((404 * 1024) / 4) * 1.25,
    "full framing and reserves are included, not just the body");
  assert.ok(decision.admissionEstimate <= decision.capacity.softLimit);
  assert.equal(decision.estimateUnits, "estimated_tokens");
});

test("CT01: exact-count mode admits the same request through a matching counter", () => {
  const controller = createContextController({ model: writer, counter: matchingCounter(101_000) });
  const decision = controller.admission({ messages: english404kb });
  assert.equal(decision.action, "admit");
  assert.ok(decision.count.ok);
  assert.equal(decision.count.method, "tokens");
  assert.equal(decision.count.units, "tokens");
  assert.equal(decision.count.exact, true);
  assert.equal(decision.admissionEstimate, 101_000);
  assert.equal(decision.estimateUnits, "tokens");
});

// Bands: soft=186_883, hard=240_278, compactTarget=133_488 for the 272k window.
test("admission bands: at/below soft admits; above soft compacts at the next safe seam", () => {
  const at = (tokens: number, mode?: "ordinary" | "compaction") =>
    createContextController({ model: writer, counter: matchingCounter(tokens) }).admission({ messages: [] }, { mode });
  assert.equal(at(133_488).action, "admit");
  assert.equal(at(186_883).action, "admit");
  const soft = at(186_884);
  assert.equal(soft.action, "compact");
  assert.equal(soft.atOrAboveHardLimit, false);
  const atHard = at(240_278);
  assert.equal(atHard.action, "compact");
  assert.equal(atHard.atOrAboveHardLimit, false);
  const aboveHard = at(240_279);
  assert.equal(aboveHard.action, "compact");
  assert.equal(aboveHard.atOrAboveHardLimit, true, "no ordinary request may be sent above the hard limit");
});

test("admission bands: compaction requests use their own hard limit", () => {
  const at = (tokens: number) =>
    createContextController({ model: writer, counter: matchingCounter(tokens) }).admission({ messages: [] }, { mode: "compaction" });
  assert.equal(at(240_278).action, "admit");
  const oversized = at(240_279);
  assert.equal(oversized.action, "blocked");
  assert.equal(oversized.reason, "compaction_input_oversized");
});

test("estimated admission applies the ceiling of baseEstimate times the safety multiplier", () => {
  const controller = createContextController({ model: writer, counter: mismatchedCounter(101) });
  const decision = controller.admission({ messages: [] });
  assert.equal(decision.action, "admit");
  assert.ok(decision.count.ok);
  assert.equal(decision.count.method, "tokenizer_estimate", "wrong tokenizer identity is an estimate, not exact (CT03)");
  assert.equal(decision.count.exact, false);
  assert.equal(decision.count.units, "estimated_tokens");
  assert.equal(decision.admissionEstimate, 127, "ceil(101 * 1.25)");
  assert.equal(decision.estimateUnits, "estimated_tokens");
});

test("admission is blocked when capacity is unusable or content is unsupported", () => {
  const broken = createContextController({ model: { ...writer, contextWindow: -1 } });
  const capacityDecision = broken.admission({ messages: [] });
  assert.equal(capacityDecision.action, "blocked");
  assert.equal(capacityDecision.reason, "context_capacity_unavailable");
  const controller = createContextController({ model: writer });
  const binary = controller.admission({ messages: [
    { role: "user", content: [{ type: "image", data: "b", mimeType: "image/png" }], timestamp: 1 },
  ] as Message[] });
  assert.equal(binary.action, "blocked");
  assert.equal(binary.reason, "unsupported_content");
});

test("countModelVisibleRequest counts instructions, tools, calls, arguments and results exactly once (CT02)", () => {
  const { messages, expected } = visibleLedger();
  const result = countModelVisibleRequest({ messages });
  assert.ok(result.ok);
  assert.equal(result.baseEstimate, expected);
  assert.equal(result.method, "utf8_div4_estimate");
  assert.equal(result.units, "estimated_tokens");
  assert.equal(result.exact, false);
});

test("countModelVisibleRequest ignores host-only metadata, IDs and serialization escaping (CT02)", () => {
  const plain = countModelVisibleRequest({ messages: visibleLedger().messages });
  const padded = countModelVisibleRequest({ messages: visibleLedger(true).messages });
  assert.ok(plain.ok && padded.ok);
  assert.equal(padded.baseEstimate, plain.baseEstimate);
  // The old byte-compare baseline would differ; the normalized count must not.
  assert.notEqual(Buffer.byteLength(JSON.stringify({ messages: visibleLedger().messages }), "utf8"),
    Buffer.byteLength(JSON.stringify({ messages: visibleLedger(true).messages }), "utf8"));
});

test("CT02: normalized 16 KiB tool content is counted once regardless of host display details", () => {
  const text = "x".repeat(16_384);
  const messages: Message[] = [
    { role: "assistant", api: "openai-completions", provider: "fake", model: "writer", usage: hostUsage,
      timestamp: 1, stopReason: "toolUse", content: [
        { type: "thinking", thinking: "Replay reasoning", thinkingSignature: "reasoning_content" },
        { type: "toolCall", id: "read", name: "read_file", arguments: {} },
      ] },
    { role: "toolResult", toolCallId: "read", toolName: "read_file", timestamp: 2, isError: false,
      content: [{ type: "text", text }] },
  ];
  const plain = normalizeContext({ messages });
  const decorated = normalizeContext({ messages: messages.map(message => message.role === "toolResult"
    ? { ...message, details: { text, bytes: 16_384 } } : message) });
  assert.deepEqual(decorated.messages[1]!.content, plain.messages[1]!.content);
  assert.deepEqual(countModelVisibleRequest(decorated), countModelVisibleRequest(plain));
  const withoutReasoning = countModelVisibleRequest({ messages: [messages[1]!] });
  const withReasoning = countModelVisibleRequest(plain);
  assert.ok(withoutReasoning.ok && withReasoning.ok);
  assert.ok(withReasoning.baseEstimate > withoutReasoning.baseEstimate, "replayed assistant content is not discarded with host details");
});

test("countModelVisibleRequest counts each effective tool declaration exactly once (CT02)", () => {
  const tool = {
    name: "read_file",
    description: "Read a file from the staged workspace.",
    parameters: { type: "object", properties: { path: { type: "string" } } },
  };
  const other = { ...tool, name: "list_dir", description: "List staged files." };
  const once: Message[] = [
    { role: "system", content: "Prompts.", toolsAdded: [tool, other], timestamp: 1 },
  ];
  const redeclared: Message[] = [
    { role: "system", content: "Prompts.", toolsAdded: [tool], timestamp: 1 },
    { role: "system", content: "Update.", toolsRemoved: [{ name: "read_file" }], timestamp: 2 },
    { role: "system", content: "Update.", toolsAdded: [tool], timestamp: 3 },
    { role: "system", content: "Update.", toolsAdded: [tool, other], timestamp: 4 },
  ];
  const a = countModelVisibleRequest({ messages: once });
  const b = countModelVisibleRequest({ messages: redeclared });
  assert.ok(a.ok && b.ok);
  assert.equal(b.baseEstimate - a.baseEstimate,
    3 * div4("Update.") + 3 * policy.messageFramingTokens,
    "re-declared tools settle to the same single effective declaration");
});

test("countModelVisibleRequest accepts system content blocks but not their signatures as text", () => {
  const text = "Section body text.";
  const plain = countModelVisibleRequest({ messages: [
    { role: "system", content: text, timestamp: 1 },
  ] as Message[] });
  const blocks = countModelVisibleRequest({ messages: [
    { role: "system", content: [{ type: "text", text, textSignature: "opaque-host-payload" }], timestamp: 1 },
  ] as Message[] });
  assert.ok(plain.ok && blocks.ok);
  assert.equal(blocks.baseEstimate, plain.baseEstimate);
});

test("countModelVisibleRequest rejects binary/image content instead of assigning zero tokens (spec §3.1)", () => {
  const result = countModelVisibleRequest({ messages: [
    { role: "system", content: "instruction", timestamp: 1 },
    { role: "assistant", usage: hostUsage, api: "anthropic-messages", provider: "anthropic", model: "m",
      stopReason: "toolUse", timestamp: 2, content: [{ type: "toolCall", id: "c1", name: "read_file", arguments: {} }] },
    { role: "toolResult", toolCallId: "c1", toolName: "read_file", isError: false, timestamp: 3,
      content: [{ type: "image", data: "binary-payload", mimeType: "image/png" }] },
  ] as Message[] });
  assert.ok(!result.ok);
  assert.deepEqual(result, { ok: false, reason: "unsupported_content", kind: "image" });
  const withUserImage = countModelVisibleRequest({ messages: [
    { role: "user", content: [{ type: "text", text: "text" }, { type: "image", data: "b", mimeType: "image/png" }], timestamp: 1 },
  ] as Message[] });
  assert.ok(!withUserImage.ok);
  assert.equal(withUserImage.reason, "unsupported_content");
});

test("countModelVisibleRequest applies utf8_div4 to English, Chinese, emoji and code/JSON text (CT03)", () => {
  const cases: [label: string, text: string][] = [
    ["english", "four score and seven tokens ago"],
    ["chinese", "你好世界"],
    ["emoji", "🎉"],
    ["code", "const x = {\"a\": 1};\nreturn x;"],
    ["json", JSON.stringify({ a: [1, 2, 3], b: "c" })],
  ];
  for (const [label, text] of cases) {
    const result = countModelVisibleRequest({ messages: [{ role: "user", content: text, timestamp: 1 }] });
    assert.ok(result.ok, label);
    assert.equal(result.baseEstimate, div4(text) + policy.messageFramingTokens, label);
    assert.equal(result.method, "utf8_div4_estimate", label);
    assert.equal(result.units, "estimated_tokens", label);
  }
});

test("deriveModelCapacity derives token-valued W/O/H/I and soft/hard/compact limits", () => {
  const result = deriveModelCapacity(window272k);
  assert.ok(result.ok);
  const { capacity } = result;
  assert.equal(capacity.window, 272_000);
  assert.equal(capacity.outputReserve, 4_000);
  assert.equal(capacity.overheadReserve, 1_024);
  assert.equal(capacity.inputLimit, 266_976);
  assert.equal(capacity.softLimit, 186_883);
  assert.equal(capacity.hardLimit, 240_278);
  assert.equal(capacity.compactTarget, 133_488);
  assert.equal(capacity.units, "tokens");
});

test("deriveModelCapacity caps the output reserve at min(outputReserve, maxTokens)", () => {
  const result = deriveModelCapacity({ contextWindow: 100_000, maxTokens: 1_000 });
  assert.ok(result.ok);
  assert.equal(result.capacity.outputReserve, 1_000);
  assert.equal(result.capacity.inputLimit, 100_000 - 1_000 - DEFAULT_CONTEXT_COUNTING_POLICY.overheadReserve);
});

test("deriveModelCapacity rejects missing, non-finite, non-integral or non-positive capacity", () => {
  const invalid: (Parameters<typeof deriveModelCapacity>[0] | undefined)[] = [
    undefined,
    { contextWindow: NaN, maxTokens: 8_192 },
    { contextWindow: 0, maxTokens: 8_192 },
    { contextWindow: -1, maxTokens: 8_192 },
    { contextWindow: 272_000.5, maxTokens: 8_192 },
    { contextWindow: 272_000, maxTokens: NaN },
    { contextWindow: 272_000, maxTokens: 0 },
    { contextWindow: 4_600, maxTokens: 8_192 },
  ];
  for (const input of invalid) {
    const result = input === undefined ? deriveModelCapacity(input as never) : deriveModelCapacity(input);
    assert.equal(result.ok, false, `expected rejection for ${JSON.stringify(input)}`);
    assert.equal(result.reason, "capacity_invalid");
  }
});

test("deriveModelCapacity accepts a small but positive input limit", () => {
  const result = deriveModelCapacity({ contextWindow: 6_100, maxTokens: 1_000 });
  assert.ok(result.ok);
  assert.equal(result.capacity.inputLimit, 6_100 - 1_000 - 1_024);
  assert.equal(result.capacity.softLimit, Math.floor(result.capacity.inputLimit * 0.7));
});