import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { buildStaging, evidencePath, workspaceDiff } from "../src/pipeline/staging.ts";
import { createWorkspaceTools, readWorkspaceUtf8, workspaceInventory } from "../src/pipeline/workspace-tools.ts";
import type { ConsolidationSnapshot } from "../src/store/consolidation.ts";

export const sampleSnapshot = (): ConsolidationSnapshot => ({ memoryVersion: "v1", baseGenerationId: null, controlEpoch: 0, sources: [
  { extractionId: "e-b", sourceId: "b", lineageKey: "l-b", sessionKey: "s-b", workspaceKey: "w", cwd: "/repo", sourceUpdatedAt: 1, outputHash: "hash-b", rolloutSummary: "B summary", rolloutSlug: "choice-b", rawMemory: "B raw" },
  { extractionId: "e-a", sourceId: "a", lineageKey: "l-a", sessionKey: "s-a", workspaceKey: "w", cwd: "/repo", sourceUpdatedAt: 2, outputHash: "hash-a", rolloutSummary: "A summary", rolloutSlug: "choice-a", rawMemory: "A raw" },
], notes: [], selectionHash: "selection", retentionDeadline: 99, maxSources: 256, maxUnusedDays: 30 });

test("writer can read deterministic note IDs and scope in the host manifest before consolidation", async () => {
  const root = mkdtempSync(join(tmpdir(), "memory-note-scope-"));
  try {
    mkdirSync(join(root, "notes"));
    const text = "Plan first for this repository.\n";
    writeFileSync(join(root, "notes", "local-note.md"), text);
    const snapshot = { ...sampleSnapshot(), sources: [], notes: [{ noteId: "local-note", textPath: "notes/local-note.md",
      textHash: createHash("sha256").update(text).digest("hex"), scope: "/repo-a" }] };
    const stage = buildStaging({ root, jobId: "note-scope", snapshot, promptHash: "prompt" });
    const manifest = JSON.parse(readWorkspaceUtf8(stage.directory, "manifest.json"));
    assert.deepEqual(manifest.notes, [{ noteId: "local-note", path: "notes/local-note.md", textHash: snapshot.notes[0]!.textHash, scope: "/repo-a" }]);
    const tools = createWorkspaceTools(stage.directory);
    const read = await tools.find((tool) => tool.name === "workspace_read")!.execute("read", { path: "manifest.json" });
    assert.match(JSON.stringify(read), /\/repo-a/);
    await assert.rejects(tools.find((tool) => tool.name === "workspace_write")!.execute("write", { path: "manifest.json", content: "forged" }), /allowlist/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("staging deterministically merges stable source IDs and retains read-only evidence provenance", () => {
  const root = mkdtempSync(join(tmpdir(), "memory-stage-"));
  try {
    const snapshot = sampleSnapshot();
    const a = buildStaging({ root, jobId: "job-a", snapshot, promptHash: "prompt" });
    const b = buildStaging({ root, jobId: "job-b", snapshot: { ...snapshot, sources: [...snapshot.sources].reverse() }, promptHash: "prompt" });
    assert.equal(a.inputHash, b.inputHash);
    const raw = readFileSync(join(a.directory, "raw_memories.md"), "utf8");
    assert.ok(raw.indexOf("A raw") < raw.indexOf("B raw"));
    assert.match(readFileSync(join(a.directory, evidencePath("a", "choice-a")), "utf8"), /source_id: a/);
    assert.match(readFileSync(join(a.directory, "phase2_workspace_diff.md"), "utf8"), /--- \/dev\/null/);
    assert.equal(a.unchanged, false);
    assert.deepEqual(a.manifest.sources.map((source) => source.sourceId), ["a", "b"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("unchanged content skips consolidation while removed evidence and changed outputs force rebuilding", () => {
  const root = mkdtempSync(join(tmpdir(), "memory-dirty-"));
  try {
    const snapshot = sampleSnapshot();
    const first = buildStaging({ root, jobId: "first", snapshot, promptHash: "prompt" });
    writeFileSync(join(first.directory, "MEMORY.md"), "handbook\n");
    writeFileSync(join(first.directory, "memory_summary.md"), "summary\n");
    const fileHashes = Object.fromEntries(["MEMORY.md", "memory_summary.md", "raw_memories.md", "phase2_workspace_diff.md", ...first.manifest.sources.map((source) => source.path)]
      .map((path) => [path, createHash("sha256").update(readFileSync(join(first.directory, path))).digest("hex")]));
    writeFileSync(join(first.directory, "manifest.json"), JSON.stringify({ ...first.manifest, fileHashes }));
    const unchanged = buildStaging({ root, jobId: "unchanged", snapshot, promptHash: "prompt", priorDir: first.directory });
    assert.equal(unchanged.unchanged, true);
    const removed = buildStaging({ root, jobId: "removed", snapshot: { ...snapshot, sources: [snapshot.sources[1]!] }, promptHash: "prompt", priorDir: first.directory });
    assert.equal(removed.unchanged, false);
    assert.match(readFileSync(join(removed.directory, "phase2_workspace_diff.md"), "utf8"), /deleted: rollout_summaries\/b__choice-b.md/);
    assert.equal(removed.manifest.fileHashes["MEMORY.md"], undefined);
    writeFileSync(join(first.directory, "MEMORY.md"), "tampered\n");
    const dirty = buildStaging({ root, jobId: "dirty", snapshot, promptHash: "prompt", priorDir: first.directory });
    assert.equal(dirty.unchanged, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("diff fallback includes every changed and deleted path beyond 4 MiB", () => {
  const root = mkdtempSync(join(tmpdir(), "memory-big-diff-"));
  try {
    const snapshot = sampleSnapshot();
    const huge = { ...snapshot.sources[1]!, rawMemory: "A".repeat(4 * 1024 * 1024 + 100) };
    const next = buildStaging({ root, jobId: "next", snapshot: { ...snapshot, sources: [huge] }, promptHash: "prompt" });
    assert.equal(next.diffFallback, true);
    const diff = readFileSync(join(next.directory, "phase2_workspace_diff.md"), "utf8");
    assert.match(diff, /added: raw_memories.md/);
    assert.match(diff, /added: rollout_summaries\/a__choice-a.md/);
    assert.equal(next.manifest.diffFallbackReason, "size");
    assert.ok(Buffer.byteLength(diff) < 4096);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("unified diff preserves an old file's missing final newline", () => {
  const root = mkdtempSync(join(tmpdir(), "memory-newline-"));
  try {
    writeFileSync(join(root, "old.md"), "without newline");
    writeFileSync(join(root, "new.md"), "without newline\n");
    const diff = workspaceDiff(new Map([["file.md", readFileSync(join(root, "old.md"), "utf8")]]), new Map([["file.md", readFileSync(join(root, "new.md"), "utf8")]]));
    assert.match(diff.text, /-without newline\n\\ No newline at end of file\n\+without newline/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("removed support and changed shared epoch produce deletion indexes without prior plaintext", () => {
  const root = mkdtempSync(join(tmpdir(), "memory-private-diff-"));
  try {
    const marker = "PRIVATE RETIRED CONTENT";
    const snapshot = sampleSnapshot();
    snapshot.sources[0] = { ...snapshot.sources[0]!, rolloutSummary: marker, rawMemory: marker };
    const first = buildStaging({ root, jobId: "first", snapshot, promptHash: "prompt" });
    writeFileSync(join(first.directory, "MEMORY.md"), marker);
    writeFileSync(join(first.directory, "memory_summary.md"), marker);
    const fileHashes = Object.fromEntries(workspaceInventory(first.directory).map((path) => [path, createHash("sha256").update(readFileSync(join(first.directory, path))).digest("hex")]));
    writeFileSync(join(first.directory, "manifest.json"), JSON.stringify({ ...first.manifest, fileHashes }));
    const variants: [string, ConsolidationSnapshot][] = [
      ["expired", { ...snapshot, sources: [snapshot.sources[1]!] }],
      ["invalidated", { ...snapshot, sources: [snapshot.sources[1]!], controlEpoch: 1 }],
    ];
    for (const [jobId, nextSnapshot] of variants) {
      const next = buildStaging({ root, jobId, snapshot: nextSnapshot, promptHash: "prompt", priorDir: first.directory });
      assert.equal(next.diffFallback, true);
      assert.equal(next.manifest.diffFallbackReason, "privacy_or_retention");
      assert.match(readFileSync(join(next.directory, "phase2_workspace_diff.md"), "utf8"), /deleted: rollout_summaries\/b__choice-b.md/);
      for (const path of workspaceInventory(next.directory)) assert.doesNotMatch(readFileSync(join(next.directory, path), "utf8"), /PRIVATE RETIRED CONTENT/);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
