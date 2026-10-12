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
  const accepted = parseV2Output('{"rollout_summary":"用户选择 TypeScript","rollout_slug":"TS Choice"}', 49_152, 9_000);
  assert.equal(accepted.ok, true);
  if (accepted.ok) {
    assert.equal(accepted.output.rollout_slug, "TS Choice");
    assert.equal(accepted.output.rollout_summary, "用户选择 TypeScript");
    assert.equal(accepted.outcome, "succeeded");
    assert.deepEqual(accepted.truncation, { truncated: false, originalBytes: 23, acceptedBytes: 23 });
  }
  for (const invalid of [
    '{"rollout_summary":"test","rollout_slug":"test","raw_memory":"v1 leak"}',
    '{"rollout_summary":"test"}',
    '{"rollout_summary":"test","rollout_slug":null}',
    'before {"rollout_summary":"test","rollout_slug":"test"}',
    '```json\n{"rollout_summary":"test","rollout_slug":"test"}\n```',
  ]) assert.equal(parseV2Output(invalid, 49_152, 9_000).ok, false, invalid);
  const empty = parseV2Output('{"rollout_summary":"","rollout_slug":""}', 49_152, 9_000);
  assert.equal(empty.ok, true);
  if (empty.ok) assert.equal(empty.outcome, "no_output");
});

test("v2 matches native 9000-byte head/tail truncation and character marker", () => {
  const summary = "A".repeat(4500) + "界🙂".repeat(100) + "Z".repeat(4500);
  const result = parseV2Output(JSON.stringify({ rollout_summary: summary, rollout_slug: "Original Slug" }), 1, 1);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.output.rollout_summary, "A".repeat(4500) + "…200 chars truncated…" + "Z".repeat(4500));
  assert.equal(result.output.rollout_slug, "Original Slug");
  assert.deepEqual(result.truncation, { truncated: true, originalBytes: 9700, acceptedBytes: 9025 });
});

test("T24 v2: middle truncation keeps UTF-8 boundaries and final evidence on unbroken lines", () => {
  const result = parseV2Output(JSON.stringify({ rollout_summary: "界".repeat(3100), rollout_slug: "unicode" }), 49_152, 9000);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.output.rollout_summary, "界".repeat(1500) + "…100 chars truncated…" + "界".repeat(1500));
  const tail = "https://example.com/final-evidence";
  const unbroken = parseV2Output(JSON.stringify({ rollout_summary: "x".repeat(10000) + tail, rollout_slug: "url" }), 49_152, 9000);
  assert.equal(unbroken.ok, true);
  if (unbroken.ok) assert.ok(unbroken.output.rollout_summary.endsWith(tail));
});

test("native truncation marker may grow a summary just above the cutoff", () => {
  const result = parseV2Output(JSON.stringify({ rollout_summary: "x".repeat(9001), rollout_slug: "near" }), 1, 1);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.output.rollout_summary, "x".repeat(4500) + "…1 chars truncated…" + "x".repeat(4500));
  assert.ok(result.truncation.acceptedBytes > result.truncation.originalBytes);
  assert.equal(result.truncation.truncated, true);
});

test("v2 no-output depends on literal empty summary only", () => {
  for (const [summary, expected] of [["", "no_output"], ["   ", "succeeded"]]) {
    const result = parseV2Output(JSON.stringify({ rollout_summary: summary, rollout_slug: "slug" }), 1, 1);
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.outcome, expected);
  }
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
