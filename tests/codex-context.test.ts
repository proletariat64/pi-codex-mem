import { test } from "node:test";
import assert from "node:assert/strict";
import { approxTokenCount, estimateModelVisibleTokens, estimatePiMessageTokens,
  estimatedTokensAfterLastAssistant } from "../src/pipeline/codex-context.ts";

test("Codex UTF-8/4 approximation counts bytes as token estimates, not as tokens", () => {
  assert.equal(approxTokenCount(""), 0);
  assert.equal(approxTokenCount("abcde"), 2);
  assert.equal(approxTokenCount("界"), 1);
  assert.equal(approxTokenCount("界界"), 2);
});

test("P0: ~404 KB text fits a 272k-token context; old byte-token gate falsely rejected", () => {
  const context = { systemPrompt: "Consolidate memory", messages: [
    { role: "user", content: [{ type: "text", text: "x".repeat(404 * 1024) }] },
  ] };
  const tokens = estimateModelVisibleTokens(context);
  assert.ok(tokens > 100_000 && tokens < 105_000, `unexpected estimated tokens: ${tokens}`);
  assert.ok(tokens + 4_000 < 272_000);
  // The historical Pi check compared the 413,696-byte body to a 186,883
  // byte threshold derived from a TOKEN context-window limit.
  assert.ok(Buffer.byteLength(JSON.stringify(context)) > 186_883);
});

test("Only provider-visible contents count; JSON envelopes and transport metadata do not", () => {
  const original = { systemPrompt: "a", messages: [
    { role: "user", content: [{ type: "text", text: "\\\\\\\\\".repeat(128) }] },
  ] };
  const noisy = { ...original, transportId: "q".repeat(2_000_000), messages: [
    { ...original.messages[0], transportId: "q".repeat(2_000_000), metadata: { foo: "bar" } },
  ] };
  assert.equal(estimateModelVisibleTokens(original), estimateModelVisibleTokens(noisy));
  assert.ok(Buffer.byteLength(JSON.stringify(noisy)) > 4_000_000);
});

test("Codex-style provider accounting adds only messages after last assistant", () => {
  const context = { systemPrompt: "upstream", tools: [
    { name: "read", description: "staged memory", parameters: { type: "object" } },
  ], messages: [
    { role: "user", content: [{ type: "text", text: "initial question" }] },
    { role: "assistant", content: [{ type: "toolCall", name: "read", arguments: { path: "a.md" } }] },
    { role: "toolResult", toolCallId: "id-1", toolName: "read",
      content: [{ type: "text", text: "staged evidence" }], details: { noisy: "q".repeat(100_000) } },
  ] };
  assert.equal(estimatedTokensAfterLastAssistant(context),
    estimatePiMessageTokens(context.messages[2]));
  assert.ok(estimateModelVisibleTokens(context) > estimatedTokensAfterLastAssistant(context));
});

test("Tool argument JSON counts as visible content; result details are not duplicated", () => {
  const a = { role: "assistant", content: [{ type: "toolCall", name: "read",
    arguments: { path: "rollout_summaries/one.md" } }] };
  assert.ok(estimatePiMessageTokens(a) > 0);
  const base = { role: "toolResult", toolName: "read", toolCallId: "call-1",
    content: [{ type: "text", text: "hi" }] };
  assert.equal(estimatePiMessageTokens(base),
    estimatePiMessageTokens({ ...base, details: { content: "duplicate".repeat(1000) } }));
});

test("Non-text content is not silently treated as UTF-8 token text", () => {
  assert.throws(() => estimateModelVisibleTokens({ systemPrompt: "", messages: [
    { role: "user", content: [{ type: "image", data: "a".repeat(1000) }] },
  ] }), /non_text_context_unsupported/);
});
