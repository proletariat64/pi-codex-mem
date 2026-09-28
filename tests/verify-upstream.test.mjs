import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { verifyUpstream } from "../scripts/verify-upstream.mjs";

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Build a fixture root with an UPSTREAM.md manifest and the listed files. */
function makeFixture(files) {
  const root = mkdtempSync(join(tmpdir(), "pi-memory-upstream-"));
  const sources = files.map((f) => ({
    repository: "openai/codex",
    commit: "deadbeef",
    upstreamPath: `upstream/${f.path}`,
    sha256: sha256(f.content),
    localPath: f.path,
    description: "fixture",
  }));
  const manifest = `# Upstream\n\n\`\`\`json\n${JSON.stringify({ manifestVersion: 1, sources }, null, 2)}\n\`\`\`\n`;
  writeFileSync(join(root, "UPSTREAM.md"), manifest);
  for (const f of files) {
    if (f.omit) continue;
    mkdirSync(dirname(join(root, f.path)), { recursive: true });
    writeFileSync(join(root, f.path), f.write ?? f.content);
  }
  return root;
}

test("all vendored files present and unmodified: verification passes", () => {
  const root = makeFixture([
    { path: "prompts/upstream/v1/a.md", content: "prompt one" },
    { path: "prompts/upstream/v2/b.md", content: "提示二 — 中文内容" },
  ]);
  try {
    const result = verifyUpstream(root);
    assert.equal(result.ok, true);
    assert.deepEqual(result.problems, []);
    assert.equal(result.checked, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("tampered file content is reported as drift", () => {
  const root = makeFixture([
    { path: "prompts/upstream/v1/a.md", content: "original", write: "tampered" },
  ]);
  try {
    const result = verifyUpstream(root);
    assert.equal(result.ok, false);
    assert.equal(result.problems.length, 1);
    assert.match(result.problems[0], /prompts\/upstream\/v1\/a\.md/);
    assert.match(result.problems[0], /hash mismatch/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("missing vendored file is reported", () => {
  const root = makeFixture([{ path: "prompts/upstream/v1/a.md", content: "x", omit: true }]);
  try {
    const result = verifyUpstream(root);
    assert.equal(result.ok, false);
    assert.equal(result.problems.length, 1);
    assert.match(result.problems[0], /missing/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("UPSTREAM.md without a manifest is an error, not a pass", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-memory-upstream-"));
  try {
    writeFileSync(join(root, "UPSTREAM.md"), "# no manifest here\n");
    const result = verifyUpstream(root);
    assert.equal(result.ok, false);
    assert.match(result.problems[0], /manifest/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
