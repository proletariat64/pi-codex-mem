import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseV1Output, renderV1Request } from "../src/extraction/v1.ts";

const payload = { raw_memory: "Accepted choice: TypeScript", rollout_summary: "User chose TypeScript over Rust after comparing tooling.", rollout_slug: "typescript-choice" };

test("v1 parser accepts exactly one enclosing JSON fence and returns sanitized provenance", () => {
  const response = parseV1Output(`\`\`\`json\n${JSON.stringify({ ...payload, raw_memory: "sk-ABCDEFGHIJKLMNOPQRSTUVWX" })}\n\`\`\``, 49_152);
  assert.equal(response.ok, true);
  if (!response.ok) return;
  assert.equal(response.output.raw_memory, "[REDACTED]");
  assert.equal(response.output.rollout_slug, "typescript-choice");
  assert.equal(response.outcome, "succeeded");
  assert.match(response.outputHash, /^[a-f0-9]{64}$/);
});

test("strict v1 parser rejects unknown/missing/non-string fields and extra prose", () => {
  for (const text of [
    JSON.stringify({ ...payload, added: "do not accept" }),
    JSON.stringify({ raw_memory: "", rollout_summary: "" }),
    JSON.stringify({ ...payload, rollout_slug: null }),
    `before ${JSON.stringify(payload)}`,
    `\`\`\`json\n${JSON.stringify(payload)}\n\`\`\`\n\`\`\`json\n${JSON.stringify(payload)}\n\`\`\``,
  ]) {
    const result = parseV1Output(text, 49_152);
    assert.equal(result.ok, false, `should reject ${text.slice(0, 70)}`);
  }
});

test("v1 parser enforces UTF-8 combined field bytes, sanitizes bounded slug, and differentiates no-output", () => {
  const tooLarge = parseV1Output(JSON.stringify({ ...payload, raw_memory: "界".repeat(100) }), 128);
  assert.equal(tooLarge.ok, false);
  const noOutput = parseV1Output('{"raw_memory":"","rollout_summary":"","rollout_slug":""}', 128);
  assert.equal(noOutput.ok, true);
  if (noOutput.ok) assert.equal(noOutput.outcome, "no_output");
  const summaryOnly = parseV1Output(JSON.stringify({ raw_memory: "", rollout_summary: "Only context", rollout_slug: "" }), 128);
  assert.equal(summaryOnly.ok, true);
  if (summaryOnly.ok) assert.equal(summaryOnly.outcome, "succeeded");
  const slugOnly = parseV1Output(JSON.stringify({ raw_memory: "", rollout_summary: "", rollout_slug: "name" }), 128);
  assert.equal(slugOnly.ok, false);
  const slug = parseV1Output(JSON.stringify({ ...payload, rollout_slug: "  Unsafe ../ NAME 🎯 " + "X".repeat(100) }), 49_152);
  assert.equal(slug.ok, true);
  if (slug.ok) assert.match(slug.output.rollout_slug, /^[a-z0-9_-]{1,80}$/);
});

test("v1 request uses pinned upstream prompt and only normalized, origin-labeled evidence", () => {
  const request = renderV1Request({ snapshotPath: "/memory/sources/lineage/revision.json",
    cwd: "/repo", items: [
      { entryId: "u1", role: "user", origin: "unknown", text: "User chose TypeScript" },
      { entryId: "a1", role: "assistant", origin: null, text: "I propose Rust" },
    ] });
  const system = readFileSync(join("prompts", "upstream", "v1", "stage_one_system.md"), "utf8");
  const input = readFileSync(join("prompts", "upstream", "v1", "stage_one_input.md"), "utf8");
  assert.equal(request.systemPrompt, system);
  assert.equal(request.promptHash, createHash("sha256").update(system + "\n" + input).digest("hex"));
  assert.match(request.userPrompt, /origin=unknown.*User chose TypeScript/s);
  assert.match(request.userPrompt, /\/memory\/sources\/lineage\/revision\.json/);
  assert.doesNotMatch(request.userPrompt, /\{\{\s*rollout_/);
});
