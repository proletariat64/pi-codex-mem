import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseV2Output, renderV2Request, v2PromptHash } from "../src/extraction/v2.ts";

test("v2 uses its pinned prompt and accepts exactly summary plus slug", () => {
  const system = readFileSync(join("prompts", "upstream", "v2", "stage_one_system_v2.md"), "utf8");
  const template = readFileSync(join("prompts", "upstream", "v2", "stage_one_input_v2.md"), "utf8");
  const request = renderV2Request({ snapshotPath: "/memory/sources/lineage/revision.json", cwd: "/repo",
    gitBranch: "feature/v2", items: [{ entryId: "u1", role: "user", origin: "human", text: "选择 TypeScript" }] });
  assert.equal(request.systemPrompt, system);
  assert.equal(request.promptHash, v2PromptHash());
  assert.notEqual(request.promptHash, createHash("sha256").update(system + "\n" + template).digest("hex"),
    "a renderer fix must queue new work instead of reusing a terminal legacy extraction");
  assert.match(request.userPrompt, /选择 TypeScript/);
  assert.match(request.userPrompt, /feature\/v2/);
  assert.doesNotMatch(request.userPrompt, /\{\{\s*rollout_/);
  const accepted = parseV2Output('```json\n{"rollout_summary":"用户选择 TypeScript","rollout_slug":"TS Choice"}\n```', 49_152, 9_000);
  assert.equal(accepted.ok, true);
  if (accepted.ok) {
    assert.equal(accepted.output.rollout_slug, "ts-choice");
    assert.equal(accepted.output.rollout_summary, "用户选择 TypeScript");
    assert.equal(accepted.outcome, "succeeded");
    assert.deepEqual(accepted.truncation, { truncated: false, originalBytes: 23, acceptedBytes: 23 });
  }
  for (const invalid of [
    '{"rollout_summary":"test","rollout_slug":"test","raw_memory":"v1 leak"}',
    '{"rollout_summary":"test"}',
    '{"rollout_summary":"test","rollout_slug":null}',
    'before {"rollout_summary":"test","rollout_slug":"test"}',
    '{"rollout_summary":"","rollout_slug":"slug-only"}',
    '{"rollout_summary":"","rollout_slug":"!!!"}',
    '{"rollout_summary":"","rollout_slug":"   "}',
    '{"rollout_summary":"   ","rollout_slug":""}',
  ]) assert.equal(parseV2Output(invalid, 49_152, 9_000).ok, false, invalid);
  const empty = parseV2Output('{"rollout_summary":"","rollout_slug":""}', 49_152, 9_000);
  assert.equal(empty.ok, true);
  if (empty.ok) assert.equal(empty.outcome, "no_output");
});

test("v2 truncates after redaction at a complete paragraph inside 9,000 UTF-8 bytes", () => {
  const paragraph = "决策".repeat(500); // 3,000 bytes per paragraph
  const summary = `${paragraph}\n\n${paragraph}\n\n${paragraph}\n\nfinal outcome is not visible`;
  const result = parseV2Output(JSON.stringify({ rollout_summary: summary,
    rollout_slug: "decision-summary" }), 49_152, 9_000);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.outcome, "succeeded");
  assert.equal(result.output.rollout_summary, `${paragraph}\n\n${paragraph}\n[... remainder omitted ...]`);
  assert.deepEqual(result.truncation, { truncated: true, originalBytes: 9_034,
    acceptedBytes: Buffer.byteLength(`${paragraph}\n\n${paragraph}\n[... remainder omitted ...]`, "utf8") });
  assert.ok(Buffer.byteLength(result.output.rollout_summary, "utf8") <= 9_000);
});

test("T24 v2: overlong Chinese summary retains complete pointers and UTF-8 inside the 9,000-byte cap", () => {
  const line = "界".repeat(1_500); // 4,500 bytes
  const summary = `${line}\n${line}\nhttps://example.com/important/identifier-not-partial`;
  const result = parseV2Output(JSON.stringify({ rollout_summary: summary, rollout_slug: "history" }), 49_152, 9_000);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.output.rollout_summary, `${line}\n[... remainder omitted ...]`);
  assert.equal(result.truncation.truncated, true);
  assert.doesNotMatch(result.output.rollout_summary, /https:\/\//);
  assert.doesNotThrow(() => new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(result.output.rollout_summary)));
  const pointer = "https://docs.example.com/decision/TS-42";
  const retained = parseV2Output(JSON.stringify({
    rollout_summary: `${pointer}\n${"界".repeat(3_100)}`, rollout_slug: "pointer",
  }), 49_152, 9_000);
  assert.equal(retained.ok, true);
  if (retained.ok) assert.equal(retained.output.rollout_summary, `${pointer}\n[... remainder omitted ...]`);
  const unbroken = parseV2Output(JSON.stringify({
    rollout_summary: "https://example.com/" + "identifier".repeat(1_200), rollout_slug: "url",
  }), 49_152, 9_000);
  assert.equal(unbroken.ok, false, "a long unbroken URL has no complete line and must be repaired or rejected");
});

test("v2 redacts generated secrets before counting summary bytes", () => {
  const raw = "Decision sk-ABCDEFGHIJKLMNOPQRSTUVWX was revoked";
  const result = parseV2Output(JSON.stringify({ rollout_summary: raw, rollout_slug: "decision" }), 49_152, 9_000);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.output.rollout_summary, "Decision [REDACTED] was revoked");
  assert.equal(result.truncation.truncated, false);
  assert.equal(result.truncation.originalBytes, 31);
  assert.equal(result.truncation.acceptedBytes, 31);
});
