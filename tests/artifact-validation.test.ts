import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildStaging, evidencePath } from "../src/pipeline/staging.ts";
import { validateV1Artifacts, writeMinimalV1 } from "../src/pipeline/validate.ts";
import type { ConsolidationSnapshot } from "../src/store/consolidation.ts";

const snapshot = (): ConsolidationSnapshot => ({ memoryVersion: "v1", baseGenerationId: null, controlEpoch: 0, sources: [
  { extractionId: "e-a", sourceId: "a", lineageKey: "l-a", sessionKey: "s-a", workspaceKey: "w", cwd: "/repo", sourceUpdatedAt: 2, outputHash: "hash-a", rolloutSummary: "用户选择 TypeScript", rolloutSlug: "choice", rawMemory: "User chose TypeScript" },
], notes: [], selectionHash: "selection", retentionDeadline: 99, maxSources: 256, maxUnusedDays: 30 });
const handbook = () => `# Task Group: TypeScript choice\nscope: /repo implementation\napplies_to: cwd=/repo; reuse_rule=typed interfaces\n\n## Task 1: Use TypeScript\n\n### rollout_summary_files\n- ${evidencePath("a", "choice")}\n\n### keywords\n- TypeScript\n\n## Reusable knowledge\n- 用户选择 TypeScript。\n`;
const summary = () => `v1\n\n## User Profile\n\n## User preferences\n\n## General Tips\n\n## What's in Memory\n- TypeScript choice: MEMORY.md; ${evidencePath("a", "choice")}\n`;

test("artifact validation accepts supported task groups and rejects byte overflow, missing sources and secrets", () => {
  const root = mkdtempSync(join(tmpdir(), "memory-validate-"));
  try {
    const snap = snapshot();
    const stage = buildStaging({ root, jobId: "valid", snapshot: snap, promptHash: "prompt" });
    writeFileSync(join(stage.directory, "MEMORY.md"), handbook());
    writeFileSync(join(stage.directory, "memory_summary.md"), summary());
    const valid = validateV1Artifacts({ directory: stage.directory, snapshot: snap });
    assert.equal(valid.summary, summary());
    assert.ok(valid.fileHashes["MEMORY.md"]);
    writeFileSync(join(stage.directory, "memory_summary.md"), summary() + "界".repeat(3300));
    assert.throws(() => validateV1Artifacts({ directory: stage.directory, snapshot: snap }), /byte/i);
    writeFileSync(join(stage.directory, "memory_summary.md"), summary().replace("v1", "v2"));
    assert.throws(() => validateV1Artifacts({ directory: stage.directory, snapshot: snap }), /marker/i);
    writeFileSync(join(stage.directory, "memory_summary.md"), summary());
    writeFileSync(join(stage.directory, "MEMORY.md"), handbook().replace(evidencePath("a", "choice"), "rollout_summaries/missing.md"));
    assert.throws(() => validateV1Artifacts({ directory: stage.directory, snapshot: snap }), /source|pointer/i);
    writeFileSync(join(stage.directory, "MEMORY.md"), handbook() + "sk-ABCDEFGHIJKLMNOPQRSTUVWX");
    assert.throws(() => validateV1Artifacts({ directory: stage.directory, snapshot: snap }), /secret/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("candidate validation rejects unsupported task-local claims, bad pointers, invalid UTF-8 and forbidden executable artifacts", () => {
  const root = mkdtempSync(join(tmpdir(), "memory-invalid-"));
  try {
    const snap = snapshot();
    const stage = buildStaging({ root, jobId: "invalid", snapshot: snap, promptHash: "prompt" });
    const validate = () => validateV1Artifacts({ directory: stage.directory, snapshot: snap });
    writeFileSync(join(stage.directory, "MEMORY.md"), handbook());
    writeFileSync(join(stage.directory, "memory_summary.md"), summary().replace("MEMORY.md", "MEMORY.md#does-not-exist"));
    assert.throws(validate, /section pointer/);
    writeFileSync(join(stage.directory, "memory_summary.md"), summary());
    writeFileSync(join(stage.directory, "MEMORY.md"), handbook().replace("applies_to:", "unscoped:"));
    assert.throws(validate, /applies_to/);
    writeFileSync(join(stage.directory, "MEMORY.md"), handbook().replace(evidencePath("a", "choice"), "no support"));
    assert.throws(validate, /selected source/);
    writeFileSync(join(stage.directory, "MEMORY.md"), handbook());
    writeFileSync(join(stage.directory, "memory_summary.md"), Buffer.from([0xc3, 0x28]));
    assert.throws(validate, /encoded data|UTF-8/i);
    writeFileSync(join(stage.directory, "memory_summary.md"), summary());
    writeFileSync(join(stage.directory, "memory_summary.md"), "\uFEFF" + summary());
    assert.throws(validate, /marker/);
    writeFileSync(join(stage.directory, "memory_summary.md"), summary());
    mkdirSync(join(stage.directory, "skills", "safe"), { recursive: true });
    writeFileSync(join(stage.directory, "skills", "safe", "run.sh"), "echo not-allowed");
    assert.throws(validate, /forbidden artifact/);
    rmSync(join(stage.directory, "skills"), { recursive: true });
    symlinkSync("/etc/passwd", join(stage.directory, "link.md"));
    assert.throws(validate, /symlink/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("selected explicit user notes can support a task without fabricated rollout files", () => {
  const root = mkdtempSync(join(tmpdir(), "memory-notes-"));
  try {
    mkdirSync(join(root, "notes"));
    const text = "Please answer in Chinese.\n";
    writeFileSync(join(root, "notes", "n1.md"), text);
    const hash = createHash("sha256").update(text).digest("hex");
    const snap = { ...snapshot(), sources: [], notes: [{ noteId: "n1", textPath: "notes/n1.md", textHash: hash, scope: "global" }] };
    const stage = buildStaging({ root, jobId: "notes", snapshot: snap, promptHash: "prompt" });
    writeFileSync(join(stage.directory, "MEMORY.md"), "# Task Group: Language\nscope: User language\napplies_to: global\n\n## Task 1: Chinese\n\n### user_notes\n- note:n1\n\n### keywords\n- Chinese\n\n## User preferences\n- Answer in Chinese [Task 1]\n");
    writeFileSync(join(stage.directory, "memory_summary.md"), summary().replace(/- TypeScript[^\n]+/, "- Language: MEMORY.md; note:n1"));
    assert.equal(validateV1Artifacts({ directory: stage.directory, snapshot: snap }).summary.includes("Language"), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("empty selection publishes deterministic minimal artifacts without invented preferences or pointers", () => {
  const dir = mkdtempSync(join(tmpdir(), "memory-empty-"));
  try {
    const snap = { ...snapshot(), sources: [] };
    writeMinimalV1(dir);
    const first = validateV1Artifacts({ directory: dir, snapshot: snap });
    writeMinimalV1(dir);
    assert.equal(first.summary, readFileSync(join(dir, "memory_summary.md"), "utf8"));
    assert.doesNotMatch(first.summary, /TypeScript|rollout_summaries/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
