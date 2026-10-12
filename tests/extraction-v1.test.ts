import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseV1Output, renderV1Request, v1PromptHash } from "../src/extraction/v1.ts";

const payload = { raw_memory: "Accepted choice: TypeScript", rollout_summary: "User chose TypeScript over Rust after comparing tooling.", rollout_slug: "typescript-choice" };

test("v1 parser uses pinned nullable slug contract and preserves redacted output", () => {
  for (const slug of [null, undefined, "Unsafe ../ NAME 🎯"]) {
    const response = parseV1Output(JSON.stringify({ ...payload, raw_memory: "sk-ABCDEFGHIJKLMNOPQRSTUVWX", rollout_slug: slug }), 1);
    assert.equal(response.ok, true);
    if (!response.ok) continue;
    assert.equal(response.output.raw_memory, "[REDACTED]");
    assert.equal(response.output.rollout_slug, slug ?? "");
    assert.equal(response.outcome, "succeeded");
    assert.match(response.outputHash, /^[a-f0-9]{64}$/);
  }
});

test("v1 parser rejects unknown fields, invalid required fields and non-JSON wrappers", () => {
  for (const text of [
    JSON.stringify({ ...payload, added: "extra" }),
    JSON.stringify({ rollout_summary: "summary" }),
    JSON.stringify({ ...payload, raw_memory: null }),
    JSON.stringify({ ...payload, rollout_slug: 42 }),
    `before ${JSON.stringify(payload)}`,
    `\`\`\`json\n${JSON.stringify(payload)}\n\`\`\``,
  ]) assert.equal(parseV1Output(text, 49_152).ok, false);
});

test("v1 requires both nonempty fields for useful output, without whitespace or slug heuristics", () => {
  for (const output of [
    { raw_memory: "", rollout_summary: "summary", rollout_slug: "slug" },
    { raw_memory: "memory", rollout_summary: "", rollout_slug: null },
    { raw_memory: "", rollout_summary: "" },
  ]) {
    const result = parseV1Output(JSON.stringify(output), 1);
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.outcome, "no_output");
  }
  const whitespace = parseV1Output(JSON.stringify({ ...payload, raw_memory: " ", rollout_summary: " " }), 1);
  assert.equal(whitespace.ok, true);
  if (whitespace.ok) assert.equal(whitespace.outcome, "succeeded");
});

test("v1 request uses pinned upstream prompt and only normalized, origin-labeled evidence", () => {
  const request = renderV1Request({ snapshotPath: "/memory/sources/lineage/revision.json",
    cwd: "/repo", manifest: { sourceId: "src_123", branchId: "main", omittedSourceItems: 2,
      omissionReasons: ["unsupported media"] }, items: [
      { entryId: "u1", role: "user", origin: "unknown", text: "User chose TypeScript" },
      { entryId: "a1", role: "assistant", origin: null, text: "I propose Rust" },
    ] });
  const system = readFileSync(join("prompts", "upstream", "v1", "stage_one_system.md"), "utf8");
  const input = readFileSync(join("prompts", "upstream", "v1", "stage_one_input.md"), "utf8");
  assert.equal(request.systemPrompt, system);
  assert.equal(request.promptHash, v1PromptHash());
  assert.notEqual(request.promptHash, createHash("sha256").update(system + "\n" + input).digest("hex"),
    "a renderer fix must queue new work instead of reusing a terminal legacy extraction");
  assert.match(request.userPrompt, /origin=unknown.*User chose TypeScript/s);
  assert.match(request.userPrompt, /source manifest.*src_123/);
  assert.match(request.userPrompt, /2 source items omitted during normalization/);
  assert.match(request.userPrompt, /\/memory\/sources\/lineage\/revision\.json/);
  assert.doesNotMatch(request.userPrompt, /\{\{\s*rollout_/);
});
