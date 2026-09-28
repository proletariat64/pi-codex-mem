import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, writeFileSync, rmSync, readFileSync, readdirSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildStaging, evidencePath } from "../src/pipeline/staging.ts";
import { validateV1Artifacts, validateV2Artifacts, writeMinimalV1, writeMinimalV2 } from "../src/pipeline/validate.ts";
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

const snapshotV2 = (): ConsolidationSnapshot => ({ ...snapshot(), memoryVersion: "v2",
  sources: snapshot().sources.map(source => ({ ...source, rawMemory: null })) });
const summaryV2 = () => `v1\n\n## User Profile\n\n## User preferences\n\n## General Tips\n\n## What's in Memory\n\n### /repo\n\n#### 1970-01-01\n\n- TypeScript: ${evidencePath("a", "choice")} explains when typed interfaces matter; source_id: a; session_key: s-a.\n\n### Older Memory Topics\n`;

test("v2 validates direct grouped routes and always enforces the UTF-8 byte boundary", () => {
  const root = mkdtempSync(join(tmpdir(), "memory-v2-validate-"));
  try {
    const snap = snapshotV2();
    const stage = buildStaging({ root, jobId: "v2-valid", snapshot: snap, promptHash: "prompt" });
    const prefix = summaryV2();
    const remaining = 9999 - Buffer.byteLength(prefix);
    const bounded = prefix + "界".repeat(Math.floor(remaining / 3)) + "x".repeat(remaining % 3);
    writeFileSync(join(stage.directory, "memory_summary.md"), bounded);
    assert.equal(validateV2Artifacts({ directory: stage.directory, snapshot: snap, summaryBytes: 20_000 }).summary, bounded);
    writeFileSync(join(stage.directory, "memory_summary.md"), bounded + "x");
    assert.throws(() => validateV2Artifacts({ directory: stage.directory, snapshot: snap, summaryBytes: 20_000 }), /byte/i);
    writeFileSync(join(stage.directory, "memory_summary.md"), prefix.replace(/^v1/, "v2"));
    assert.throws(() => validateV2Artifacts({ directory: stage.directory, snapshot: snap }), /marker/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("v2 rejects unselected routes, IDs, incomplete groups, tampered evidence and cross-version artifacts", () => {
  const root = mkdtempSync(join(tmpdir(), "memory-v2-contract-"));
  try {
    const snap = snapshotV2();
    const stage = buildStaging({ root, jobId: "v2-contract", snapshot: snap, promptHash: "prompt" });
    const validate = () => validateV2Artifacts({ directory: stage.directory, snapshot: snap });
    for (const [text, error] of [
      [summaryV2().replace(evidencePath("a", "choice"), "rollout_summaries/other.md"), /selected/],
      [summaryV2().replace(evidencePath("a", "choice"), `${evidencePath("a", "choice")}.bak`), /selected/],
      [summaryV2().replace("source_id: a", "source_id: other"), /source ID/],
      [summaryV2().replace("session_key: s-a", "session_key: other"), /session key/],
      [summaryV2() + "\nnote:missing\n", /note ID/],
      [summaryV2().replace("#### 1970-01-01\n", ""), /grouping/],
      [summaryV2().replace("1970-01-01", "2026-02-30"), /valid date/],
      [summaryV2().replace(evidencePath("a", "choice"), `/versions/v1/generations/old/${evidencePath("a", "choice")}`), /forbidden/],
      [summaryV2().replace(evidencePath("a", "choice"), `/${evidencePath("a", "choice")}`), /pointer/],
      [summaryV2() + "sk-ABCDEFGHIJKLMNOPQRSTUVWX", /secret/],
    ] as const) {
      writeFileSync(join(stage.directory, "memory_summary.md"), text);
      assert.throws(validate, error);
    }
    writeFileSync(join(stage.directory, "memory_summary.md"), summaryV2());
    const path = join(stage.directory, evidencePath("a", "choice"));
    const evidence = readFileSync(path, "utf8");
    chmodSync(path, 0o600);
    writeFileSync(path, evidence.replace("session_key: s-a", "session_key: other"));
    assert.throws(validate, /evidence missing or changed/);
    writeFileSync(path, evidence);
    for (const forbidden of ["MEMORY.md", "raw_memories.md", "skills/tool/SKILL.md", "versions/v1/memory_summary.md"]) {
      const parts = forbidden.split("/");
      if (parts.length > 1) mkdirSync(join(stage.directory, ...parts.slice(0, -1)), { recursive: true });
      writeFileSync(join(stage.directory, forbidden), "forbidden");
      assert.throws(validate, /forbidden v2 artifact/);
      rmSync(join(stage.directory, parts[0]!), { recursive: true });
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("v2 older-topic and note routes remain grounded and empty inputs write only the deterministic summary", () => {
  const root = mkdtempSync(join(tmpdir(), "memory-v2-notes-"));
  try {
    mkdirSync(join(root, "notes"));
    const text = "用户要求中文回答。\n";
    writeFileSync(join(root, "notes", "n1.md"), text);
    const snap = { ...snapshotV2(), notes: [{ noteId: "n1", textPath: "notes/n1.md", textHash: createHash("sha256").update(text).digest("hex"), scope: "global" }] };
    const stage = buildStaging({ root, jobId: "v2-older", snapshot: snap, promptHash: "prompt" });
    const olderSummary = summaryV2().replace(/### \/repo[\s\S]+/, `### Older Memory Topics\n\n- /repo: ${evidencePath("a", "choice")} explains when typed interfaces matter.\n- User language: note:n1 applies when choosing a response language.\n`);
    writeFileSync(join(stage.directory, "memory_summary.md"), olderSummary);
    assert.equal(validateV2Artifacts({ directory: stage.directory, snapshot: snap }).summary, olderSummary);
    writeFileSync(join(stage.directory, "memory_summary.md"), olderSummary.replace("note:n1", "notes/n1.md"));
    assert.throws(() => validateV2Artifacts({ directory: stage.directory, snapshot: snap }), /source pointer/);
    writeFileSync(join(stage.directory, "memory_summary.md"), olderSummary);
    chmodSync(join(stage.directory, "notes", "n1.md"), 0o600);
    writeFileSync(join(stage.directory, "notes", "n1.md"), "changed user instruction");
    assert.throws(() => validateV2Artifacts({ directory: stage.directory, snapshot: snap }), /note missing or changed/);
    const empty = join(root, "empty");
    mkdirSync(empty);
    writeMinimalV2(empty);
    const minimal = validateV2Artifacts({ directory: empty, snapshot: { ...snapshotV2(), sources: [], notes: [] } });
    assert.deepEqual(readdirSync(empty), ["memory_summary.md"]);
    assert.doesNotMatch(minimal.summary, /TypeScript|rollout_summaries|note:/);
    writeMinimalV2(empty);
    assert.equal(readFileSync(join(empty, "memory_summary.md"), "utf8"), minimal.summary);
    writeFileSync(join(empty, "memory_summary.md"), minimal.summary + "The user prefers TypeScript.\n");
    assert.throws(() => validateV2Artifacts({ directory: empty, snapshot: { ...snapshotV2(), sources: [], notes: [] } }), /deterministic minimal/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
