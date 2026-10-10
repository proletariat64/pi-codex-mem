import { test } from "node:test";
import assert from "node:assert/strict";
import { renderV1Request, v1PromptHash } from "../src/extraction/v1.ts";
import { renderV2Request, v2PromptHash } from "../src/extraction/v2.ts";
import { renderMemorySection } from "../src/read/inject.ts";
import type { MemoryCarrierView } from "../src/read/inject.ts";

// Foreground guidance follow-up: these checks prove issued guidance, not model obedience.
for (const version of ["v1", "v2"] as const) test(`${version} reader guides bounded identifier lookup and precise evidence-backed scope`, () => {
  const summary = "Record job-kestrel-42 applies to /projects/copper/service only; approval remains unknown.";
  const view: MemoryCarrierView = { memoryVersion: version, generationId: "generation-reader",
    directory: "/memory/pinned-generation", controlEpoch: 0, manifestHash: "hash",
    summary, applicability: ["/projects/current/service"] };
  const section = renderMemorySection(view, "/projects/current/service");
  const guidance = section.split("<historical_memory_evidence>")[0]!;
  assert.match(guidance, /pi_memory_search[\s\S]*rollout_summaries[\s\S]*exact source ID or identifier/);
  assert.match(guidance, /targeted search over directory paging/);
  assert.match(guidance, /one distinct targeted query/);
  assert.match(guidance, /Follow returned cursors for that same query[\s\S]*remaining tool\/request budget/);
  assert.match(guidance, /valid known references[\s\S]*before abstaining/);
  assert.match(guidance, /Do not traverse unrelated paths/);
  if (version === "v1") {
    assert.match(guidance, /bounded handbook search[\s\S]*before declaring the fact unavailable/);
    assert.match(guidance, /handbook miss is not evidence absence/);
    assert.match(guidance, /Read a matching returned path only[\s\S]*wording, chronology, or metadata/);
  } else {
    assert.match(guidance, /known valid rollout path directly/);
    assert.match(guidance, /exact path is unknown/);
  }
  assert.match(guidance, /relative to the pinned generation/);
  assert.match(guidance, /For pi_memory_list and pi_memory_search, omit path or use `\.`[\s\S]*allowed root/);
  assert.match(guidance, /pi_memory_read requires an explicit allowed file path/);
  assert.match(guidance, /empty string[\s\S]*current workspace's absolute path[\s\S]*not the root/);
  assert.match(guidance, /state the precise recorded project\/workspace path and scope supported by backing evidence/);
  assert.match(guidance, /not generic labels/);
  assert.match(guidance, /workspace and applicability header alone[\s\S]*not proof[\s\S]*universally/);
  assert.match(guidance, /Do not infer missing project scope or override scoped decision conditions/);
  assert.ok(!guidance.includes("job-kestrel-42"), "source identifiers stay in evidence, not host instructions");
  assert.ok(section.includes(`<historical_memory_evidence>\n${summary}\n</historical_memory_evidence>`));
});

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
  const view: MemoryCarrierView = { memoryVersion: version, generationId: "g-$&-{{ workspace }}",
    directory: "/tmp/$&-{{ memory_summary }}", controlEpoch: 0, manifestHash: "hash",
    summary: opaque, applicability: [] };
  const section = renderMemorySection(view, "/repo/$&-{{ memory_summary }}");
  assert.ok(section.includes(opaque), "injected summary must remain verbatim");
  assert.ok(section.includes(JSON.stringify(view.generationId)));
  assert.ok(section.includes(JSON.stringify(view.directory)));
});
