import { test } from "node:test";
import assert from "node:assert/strict";
import type { Message } from "@earendil-works/pi-ai";
import {
  DEFAULT_CONTEXT_COUNTING_POLICY,
  countModelVisibleRequest,
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
    + div4("read_file") + div4(resultText) + div4(JSON.stringify(resultDetails)) + policy.toolResultFramingTokens;
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