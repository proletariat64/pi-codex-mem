import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { buildStaging, type StagedWorkspace } from "../src/pipeline/staging.ts";
import { workspaceInventory } from "../src/pipeline/workspace-tools.ts";
import type { ConsolidationSnapshot } from "../src/store/consolidation.ts";

const sha = (text: string): string => createHash("sha256").update(text).digest("hex");

/** A large alternating document so a single-line edit stays a local change. */
const bigRaw = (edited: boolean): string => {
  const lines: string[] = [];
  for (let i = 0; i < 40_000; i++) lines.push(i % 2 === 0 ? `u${i}${edited && i === 30_000 ? "-edited" : ""}` : "common");
  return lines.map((line) => `${line}\n`).join("");
};

const source = (id: string, rawMemory: string, summary = `${id} summary`): ConsolidationSnapshot["sources"][number] => ({
  extractionId: `e-${id}`, sourceId: id, lineageKey: `l-${id}`, sessionKey: `s-${id}`, workspaceKey: "w", cwd: "/repo",
  sourceUpdatedAt: 1, outputHash: `hash-${id}`, rolloutSummary: summary, rolloutSlug: `choice-${id}`, rawMemory,
});

const snap = (sources: ConsolidationSnapshot["sources"], controlEpoch = 0): ConsolidationSnapshot => ({
  memoryVersion: "v1", baseGenerationId: null, controlEpoch, sources, notes: [], selectionHash: "selection",
  retentionDeadline: 99, maxSources: 256, maxUnusedDays: 30,
});

/** Finalizes a staged generation the way publication tests do; legacy drops new diagnostic fields. */
const publish = (stage: StagedWorkspace, legacy = false): void => {
  const manifest = JSON.parse(JSON.stringify(stage.manifest)) as Record<string, unknown>;
  manifest.fileHashes = Object.fromEntries(workspaceInventory(stage.directory).filter((path) => path !== "manifest.json")
    .map((path) => [path, sha(readFileSync(join(stage.directory, path), "utf8"))]));
  if (legacy) delete manifest.diffPolicyVersion;
  writeFileSync(join(stage.directory, "manifest.json"), JSON.stringify(manifest));
};

test("local hunks against a legacy published baseline record the diff policy without fallback", () => {
  const root = mkdtempSync(join(tmpdir(), "memory-incremental-"));
  try {
    const first = buildStaging({ root, jobId: "first", snapshot: snap([source("a", bigRaw(false))]), promptHash: "prompt" });
    writeFileSync(join(first.directory, "MEMORY.md"), "handbook\n");
    writeFileSync(join(first.directory, "memory_summary.md"), "v1\nsummary\n");
    publish(first, true);
    // Second run: source a is re-extracted with one edited raw line (same output
    // hash, so support is retained), and source b is newly selected.
    const nextSnap = snap([source("a", bigRaw(true)), source("b", "B raw\n")]);
    const next = buildStaging({ root, jobId: "next", snapshot: nextSnap, promptHash: "prompt", priorDir: first.directory });
    assert.equal(next.diffFallback, false, "a legacy baseline must remain a valid incremental baseline");
    assert.equal(next.manifest.schemaVersion, 1);
    assert.equal(next.manifest.diffPolicyVersion, 1);
    assert.equal(next.manifest.diffFallbackReason, undefined);
    const text = readFileSync(join(next.directory, "phase2_workspace_diff.md"), "utf8");
    assert.equal(
      text.split("\n").filter((line) => /^- (added|deleted|modified): /.test(line)).join("\n"),
      "- modified: raw_memories.md\n- added: rollout_summaries/b__choice-b.md",
    );
    assert.match(text, /-u30000\n\+u30000-edited/);
    assert.doesNotMatch(text, /-u0\n/, "whole-file replacement for an unchanged head");
    assert.doesNotMatch(text, /-common\n/, "whole-file replacement for unchanged lines");
    assert.ok(Buffer.byteLength(text) < 3000, "a one-line edit to a large baseline must stay local");
    const repeat = buildStaging({ root, jobId: "repeat", snapshot: nextSnap, promptHash: "prompt", priorDir: first.directory });
    assert.equal(readFileSync(join(repeat.directory, "phase2_workspace_diff.md"), "utf8"), text);
    assert.equal(repeat.manifest.diffPolicyVersion, 1);
    assert.equal(repeat.manifest.diffFallbackReason, undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("revoked prior plaintext never enters a diff even with oversized content", () => {
  const root = mkdtempSync(join(tmpdir(), "memory-revoked-"));
  const marker = "PRIVATE RETIRED CONTENT";
  try {
    const big = "b".repeat(4 * 1024 * 1024 + 512);
    const first = buildStaging({ root, jobId: "first", snapshot: snap([source("a", "safe\n"), source("b", big, marker)]), promptHash: "prompt" });
    writeFileSync(join(first.directory, "MEMORY.md"), marker);
    writeFileSync(join(first.directory, "memory_summary.md"), `v1\n${marker}\n`);
    publish(first);
    const next = buildStaging({ root, jobId: "next", snapshot: snap([source("a", "safe\n")], 1), promptHash: "prompt", priorDir: first.directory });
    assert.equal(next.diffFallback, true);
    assert.equal(next.manifest.diffFallbackReason, "privacy_or_retention");
    assert.equal(next.manifest.diffPolicyVersion, 1);
    const text = readFileSync(join(next.directory, "phase2_workspace_diff.md"), "utf8");
    assert.match(text, /Prior plaintext omitted/);
    assert.match(text, /- deleted: rollout_summaries\/b__choice-b\.md/);
    assert.ok(Buffer.byteLength(text) < 4096);
    for (const path of workspaceInventory(next.directory)) {
      assert.doesNotMatch(readFileSync(join(next.directory, path), "utf8"), new RegExp(marker));
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});