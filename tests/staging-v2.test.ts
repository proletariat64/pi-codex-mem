import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildStaging, evidencePath, textHash, type StagedWorkspace } from "../src/pipeline/staging.ts";
import { workspaceInventory } from "../src/pipeline/workspace-tools.ts";
import type { ConsolidationSnapshot } from "../src/store/consolidation.ts";

const snapshot = (): ConsolidationSnapshot => ({ memoryVersion: "v2", baseGenerationId: null, controlEpoch: 0, sources: [
  { extractionId: "v2-b", sourceId: "b", lineageKey: "l-b", sessionKey: "s-b", workspaceKey: "w", cwd: "/repo", sourceUpdatedAt: 1, outputHash: "hash-b", rolloutSummary: "B v2 summary", rolloutSlug: "choice-b", rawMemory: null },
  { extractionId: "v2-a", sourceId: "a", lineageKey: "l-a", sessionKey: "s-a", workspaceKey: "w", cwd: "/repo", sourceUpdatedAt: 2, outputHash: "hash-a", rolloutSummary: "A v2 summary", rolloutSlug: "choice-a", rawMemory: null },
], notes: [], selectionHash: "selection-v2", retentionDeadline: 99, maxSources: 256, maxUnusedDays: 30 });
const publishManifest = (stage: StagedWorkspace): void => {
  const fileHashes = Object.fromEntries(workspaceInventory(stage.directory).filter((path) => path !== "manifest.json")
    .map((path) => [path, textHash(readFileSync(join(stage.directory, path), "utf8"))]));
  writeFileSync(join(stage.directory, "manifest.json"), JSON.stringify({ ...stage.manifest, fileHashes }));
};

test("v2 staging contains only same-version evidence, notes and host operational inputs", () => {
  const root = mkdtempSync(join(tmpdir(), "memory-stage-v2-"));
  try {
    mkdirSync(join(root, "notes"));
    const text = "请使用中文。\n";
    writeFileSync(join(root, "notes", "n.md"), text);
    const snap = { ...snapshot(), notes: [{ noteId: "n", textPath: "notes/n.md", textHash: textHash(text), scope: "/repo" }] };
    const stage = buildStaging({ root, jobId: "v2-first", snapshot: snap, promptHash: "v2-prompt" });
    assert.equal(stage.directory, join(root, "versions", "v2", "staging", "v2-first"));
    assert.equal(stage.manifest.memoryVersion, "v2");
    assert.deepEqual(workspaceInventory(stage.directory), ["manifest.json", "notes/n.md", "phase2_workspace_diff.md", evidencePath("a", "choice-a"), evidencePath("b", "choice-b")]);
    assert.deepEqual(stage.manifest.sources.map((source) => source.extractionId), ["v2-a", "v2-b"]);
    assert.equal(stage.unchanged, false);
    const reordered = buildStaging({ root, jobId: "v2-reordered", snapshot: { ...snap, sources: [...snap.sources].reverse() }, promptHash: "v2-prompt" });
    assert.equal(reordered.inputHash, stage.inputHash);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("v2 omits invalidated prior plaintext while preserving deleted evidence paths", () => {
  const root = mkdtempSync(join(tmpdir(), "memory-v2-retired-"));
  try {
    const snap = snapshot();
    snap.sources[0] = { ...snap.sources[0]!, rolloutSummary: "RETIRED V2 EVIDENCE" };
    const first = buildStaging({ root, jobId: "first", snapshot: snap, promptHash: "v2-prompt" });
    writeFileSync(join(first.directory, "memory_summary.md"), "v1\nRETIRED V2 CLAIM\n");
    publishManifest(first);
    const next = buildStaging({ root, jobId: "next", snapshot: { ...snap, controlEpoch: 1, sources: [snap.sources[1]!] }, promptHash: "v2-prompt", priorDir: first.directory });
    assert.equal(next.unchanged, false);
    assert.equal(next.diffFallback, true);
    assert.match(readFileSync(join(next.directory, "phase2_workspace_diff.md"), "utf8"), /deleted: rollout_summaries\/b__choice-b.md/);
    for (const path of workspaceInventory(next.directory)) assert.doesNotMatch(readFileSync(join(next.directory, path), "utf8"), /RETIRED V2/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a prior directory in another version namespace is ignored even when its manifest claims v2", () => {
  const root = mkdtempSync(join(tmpdir(), "memory-v2-wrong-path-"));
  try {
    const snap = snapshot();
    const first = buildStaging({ root, jobId: "first", snapshot: { ...snap, memoryVersion: "v1" }, promptHash: "v2-prompt" });
    writeFileSync(join(first.directory, "memory_summary.md"), "v1\nFOREIGN NAMESPACE SUMMARY\n");
    rmSync(join(first.directory, "raw_memories.md"));
    const fileHashes = Object.fromEntries(workspaceInventory(first.directory).filter((path) => path !== "manifest.json").map((path) => [path, textHash(readFileSync(join(first.directory, path), "utf8"))]));
    writeFileSync(join(first.directory, "manifest.json"), JSON.stringify({ ...first.manifest, memoryVersion: "v2", fileHashes }));
    const next = buildStaging({ root, jobId: "next", snapshot: snap, promptHash: "v2-prompt", priorDir: first.directory });
    for (const path of workspaceInventory(next.directory)) assert.doesNotMatch(readFileSync(join(next.directory, path), "utf8"), /FOREIGN NAMESPACE/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("v2 contaminated prior inventory is rejected before forbidden artifacts can enter its diff", () => {
  const root = mkdtempSync(join(tmpdir(), "memory-v2-contaminated-"));
  try {
    const snap = snapshot();
    const first = buildStaging({ root, jobId: "first", snapshot: snap, promptHash: "v2-prompt" });
    writeFileSync(join(first.directory, "memory_summary.md"), "v1\nV2 summary\n");
    writeFileSync(join(first.directory, "MEMORY.md"), "FORBIDDEN HANDBOOK");
    writeFileSync(join(first.directory, "raw_memories.md"), "FORBIDDEN RAW");
    mkdirSync(join(first.directory, "skills", "foreign"), { recursive: true });
    writeFileSync(join(first.directory, "skills", "foreign", "SKILL.md"), "FORBIDDEN SKILL");
    publishManifest(first);
    const next = buildStaging({ root, jobId: "next", snapshot: snap, promptHash: "v2-prompt", priorDir: first.directory });
    assert.equal(next.unchanged, false);
    for (const path of workspaceInventory(next.directory)) assert.doesNotMatch(readFileSync(join(next.directory, path), "utf8"), /FORBIDDEN|MEMORY\.md|raw_memories\.md|skills\/foreign/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("v2 ignores a v1 baseline without importing its generated learning, evidence or filenames", () => {
  const root = mkdtempSync(join(tmpdir(), "memory-v2-cross-version-"));
  try {
    const snap = snapshot();
    const v1 = { ...snap, memoryVersion: "v1" as const, sources: snap.sources.map((source) => ({ ...source, extractionId: `v1-${source.sourceId}`, rolloutSlug: "v1-private-slug", rolloutSummary: "V1 PRIVATE EVIDENCE", rawMemory: "V1 PRIVATE RAW" })) };
    const prior = buildStaging({ root, jobId: "prior", snapshot: v1, promptHash: "v1-prompt" });
    writeFileSync(join(prior.directory, "MEMORY.md"), "V1 PRIVATE HANDBOOK");
    writeFileSync(join(prior.directory, "memory_summary.md"), "V1 PRIVATE SUMMARY");
    mkdirSync(join(prior.directory, "skills", "private-v1"), { recursive: true });
    writeFileSync(join(prior.directory, "skills", "private-v1", "SKILL.md"), "V1 PRIVATE PROCEDURE");
    publishManifest(prior);
    const stage = buildStaging({ root, jobId: "v2", snapshot: snap, promptHash: "v2-prompt", priorDir: prior.directory });
    assert.equal(stage.unchanged, false);
    for (const path of workspaceInventory(stage.directory)) {
      assert.doesNotMatch(path, /MEMORY|raw_memories|skills/);
      assert.doesNotMatch(readFileSync(join(stage.directory, path), "utf8"), /V1 PRIVATE|v1-private-slug|MEMORY\.md|raw_memories\.md|skills\/private-v1/);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("v2 reuses only its valid same-version summary and skips unchanged content", () => {
  const root = mkdtempSync(join(tmpdir(), "memory-v2-prior-"));
  try {
    const snap = snapshot();
    const first = buildStaging({ root, jobId: "first", snapshot: snap, promptHash: "v2-prompt" });
    writeFileSync(join(first.directory, "memory_summary.md"), "v1\nV2 ONLY SUMMARY\n");
    publishManifest(first);
    const next = buildStaging({ root, jobId: "next", snapshot: snap, promptHash: "v2-prompt", priorDir: first.directory });
    assert.equal(next.unchanged, true);
    assert.equal(readFileSync(join(next.directory, "memory_summary.md"), "utf8"), "v1\nV2 ONLY SUMMARY\n");
    assert.doesNotMatch(workspaceInventory(next.directory).join("\n"), /raw_memories|MEMORY|skills/);
    const changed = buildStaging({ root, jobId: "changed", snapshot: snap, promptHash: "changed-v2-prompt", priorDir: first.directory });
    assert.equal(changed.unchanged, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
