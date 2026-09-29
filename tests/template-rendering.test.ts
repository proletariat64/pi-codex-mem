import { test } from "node:test";
import assert from "node:assert/strict";
import { renderV1Request, v1PromptHash } from "../src/extraction/v1.ts";
import { renderV2Request, v2PromptHash } from "../src/extraction/v2.ts";
import { renderMemorySection } from "../src/read/inject.ts";
import type { MemoryReadView } from "../src/read/view.ts";

const opaque = "JavaScript replacement $& $$ $` $' and literal {{ rollout_cwd }} / {{ memory_summary }}";
for (const version of ["v1", "v2"] as const) test(`${version} template rendering preserves dollar tokens and literal placeholders in evidence and metadata`, () => {
  const path = `/tmp/$&-{{ rollout_cwd }}-${version}`;
  const input = { snapshotPath: path, cwd: "/repo/$&-{{ rollout_contents }}", gitBranch: "feature/$&-{{ rollout_path }}",
    items: [{ entryId: "u1", role: "user", origin: "unknown", text: opaque }] };
  const rendered = version === "v1" ? renderV1Request(input) : renderV2Request(input);
  assert.ok(rendered.userPrompt.includes(JSON.stringify(opaque)), "user evidence must remain byte-for-byte intact");
  assert.ok(rendered.userPrompt.includes(JSON.stringify(path)));
  assert.ok(rendered.userPrompt.includes(JSON.stringify(input.cwd)));
  if (version === "v2") assert.ok(rendered.userPrompt.includes(JSON.stringify(input.gitBranch)));
  assert.equal(rendered.promptHash, version === "v1" ? v1PromptHash() : v2PromptHash());
  const view: MemoryReadView = { memoryVersion: version, generationId: "g-$&-{{ workspace }}",
    directory: "/tmp/$&-{{ memory_summary }}", controlEpoch: 0, manifestHash: "hash",
    summary: opaque, applicability: [], retentionDeadline: null };
  const section = renderMemorySection(view, "/repo/$&-{{ memory_summary }}");
  assert.ok(section.includes(opaque), "injected summary must remain verbatim");
  assert.ok(section.includes(JSON.stringify(view.generationId)));
  assert.ok(section.includes(JSON.stringify(view.directory)));
});
