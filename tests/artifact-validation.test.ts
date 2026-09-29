import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, writeFileSync, rmSync, readFileSync, readdirSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactFormatError } from "../src/pipeline/artifacts.ts";
import { buildStaging, evidencePath } from "../src/pipeline/staging.ts";
import { validateV1Artifacts, validateV2Artifacts, writeMinimalV1, writeMinimalV2 } from "../src/pipeline/validate.ts";
import type { ConsolidationSnapshot } from "../src/store/consolidation.ts";

const snapshot = (): ConsolidationSnapshot => ({ memoryVersion: "v1", baseGenerationId: null, controlEpoch: 0, sources: [
  { extractionId: "e-a", sourceId: "a", lineageKey: "l-a", sessionKey: "s-a", workspaceKey: "w", cwd: "/repo", sourceUpdatedAt: 2, outputHash: "hash-a", rolloutSummary: "用户选择 TypeScript", rolloutSlug: "choice", rawMemory: "User chose TypeScript" },
], notes: [], selectionHash: "selection", retentionDeadline: 99, maxSources: 256, maxUnusedDays: 30 });
const handbook = () => `# Task Group: TypeScript choice\nscope: /repo implementation\napplies_to: cwd=/repo; reuse_rule=typed interfaces\n\n## Task 1: Use TypeScript\n\n### rollout_summary_files\n- ${evidencePath("a", "choice")}\n\n### keywords\n- TypeScript\n\n## Reusable knowledge\n- 用户选择 TypeScript。\n`;
const summary = () => `v1\n\n## User Profile\n\n## User preferences\n\n## General Tips\n\n## What's in Memory\n### Local CLI prototype\n#### 2026-09-27\n- TypeScript choice: MEMORY.md; ${evidencePath("a", "choice")}\n  - desc: scoped decision\n  - learnings: reuse parser\n`;

test("v1 accepts long summaries and handbook prose; required files, marker and secrets remain enforced", () => {
  const root = mkdtempSync(join(tmpdir(), "memory-validate-"));
  try {
    const snap = snapshot();
    const stage = buildStaging({ root, jobId: "valid", snapshot: snap, promptHash: "prompt" });
    writeFileSync(join(stage.directory, "MEMORY.md"), handbook());
    writeFileSync(join(stage.directory, "memory_summary.md"), summary());
    const valid = validateV1Artifacts({ directory: stage.directory, snapshot: snap });
    assert.equal(valid.summary, summary());
    assert.ok(valid.fileHashes["MEMORY.md"]);
    const longSummary = summary() + "界".repeat(4_000);
    writeFileSync(join(stage.directory, "memory_summary.md"), longSummary);
    assert.equal(validateV1Artifacts({ directory: stage.directory, snapshot: snap, summaryBytes: 100 }).summary, longSummary);
    writeFileSync(join(stage.directory, "memory_summary.md"), summary().replace(/^v1/, "v2"));
    assert.throws(() => validateV1Artifacts({ directory: stage.directory, snapshot: snap }), ArtifactFormatError);
    writeFileSync(join(stage.directory, "memory_summary.md"), summary());
    rmSync(join(stage.directory, "MEMORY.md"));
    assert.throws(() => validateV1Artifacts({ directory: stage.directory, snapshot: snap }), /required|MEMORY\.md/i);
    writeFileSync(join(stage.directory, "MEMORY.md"), handbook());
    rmSync(join(stage.directory, "memory_summary.md"));
    assert.throws(() => validateV1Artifacts({ directory: stage.directory, snapshot: snap }), /required|memory_summary\.md/i);
    writeFileSync(join(stage.directory, "memory_summary.md"), summary());
    const path = join(stage.directory, evidencePath("a", "choice"));
    const evidence = readFileSync(path, "utf8");
    chmodSync(path, 0o600);
    writeFileSync(path, "altered host-staged input");
    assert.throws(() => validateV1Artifacts({ directory: stage.directory, snapshot: snap }), error =>
      error instanceof Error && !(error instanceof ArtifactFormatError) && /evidence missing or changed/.test(error.message));
    writeFileSync(path, evidence);
    writeFileSync(join(stage.directory, "MEMORY.md"), handbook() + "sk-ABCDEFGHIJKLMNOPQRSTUVWX");
    assert.throws(() => validateV1Artifacts({ directory: stage.directory, snapshot: snap }), /secret/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("v1 ignores untrusted prose references and handbook fields but rejects invalid UTF-8 and unsafe artifacts", () => {
  const root = mkdtempSync(join(tmpdir(), "memory-invalid-"));
  try {
    const snap = snapshot();
    const stage = buildStaging({ root, jobId: "invalid", snapshot: snap, promptHash: "prompt" });
    const validate = () => validateV1Artifacts({ directory: stage.directory, snapshot: snap });
    writeFileSync(join(stage.directory, "MEMORY.md"), "# Notes\nNo required handbook fields.\nrollout_summaries/missing.md source_id: missing note:missing\n");
    const prose = summary().replace("MEMORY.md", "MEMORY.md#does-not-exist").replace(evidencePath("a", "choice"), "rollout_summaries/missing.md source_id: missing note:missing");
    writeFileSync(join(stage.directory, "memory_summary.md"), prose);
    assert.equal(validate().summary, prose);
    writeFileSync(join(stage.directory, "memory_summary.md"), summary());
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
    const alternate = first.summary.replace("## User Profile", "## User Profile\nNo preferences confirmed.");
    writeFileSync(join(dir, "memory_summary.md"), alternate);
    assert.equal(validateV1Artifacts({ directory: dir, snapshot: snap }).summary, alternate);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

const snapshotV2 = (): ConsolidationSnapshot => ({ ...snapshot(), memoryVersion: "v2",
  sources: snapshot().sources.map(source => ({ ...source, rawMemory: null })) });
const summaryV2 = () => `v1\n\n## User Profile\n\n## User preferences\n\n## General Tips\n\n## What's in Memory\n\n### /repo\n\n#### 1970-01-01\n\n- TypeScript: ${evidencePath("a", "choice")} explains when typed interfaces matter; source_id: a; session_key: s-a.\n\n### Older Memory Topics\n`;

test("T25 v2: 9,999-byte valid summary passes, 10,000 fails, marker remains v1", () => {
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
    assert.throws(() => validateV2Artifacts({ directory: stage.directory, snapshot: snap, summaryBytes: 20_000 }), ArtifactFormatError);
    writeFileSync(join(stage.directory, "memory_summary.md"), prefix.replace(/^v1/, "v2"));
    assert.throws(() => validateV2Artifacts({ directory: stage.directory, snapshot: snap }), /marker/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("v2 accepts prose references without treating them as file access, but protects selected inputs and output allowlist", () => {
  const root = mkdtempSync(join(tmpdir(), "memory-v2-contract-"));
  try {
    const snap = snapshotV2();
    const stage = buildStaging({ root, jobId: "v2-contract", snapshot: snap, promptHash: "prompt" });
    const validate = () => validateV2Artifacts({ directory: stage.directory, snapshot: snap });
    for (const text of [
      summaryV2().replace(evidencePath("a", "choice"), "rollout_summaries/other.md"),
      summaryV2().replace(evidencePath("a", "choice"), `${evidencePath("a", "choice")}.bak`),
      summaryV2().replace("source_id: a", "source_id: other"),
      summaryV2().replace("session_key: s-a", "session_key: other"),
      summaryV2().replace(evidencePath("a", "choice"), "no source pointer; note:missing"),
      summaryV2().replace(evidencePath("a", "choice"), `/versions/v1/generations/old/${evidencePath("a", "choice")}`),
      summaryV2().replace(evidencePath("a", "choice"), `/${evidencePath("a", "choice")}`),
      summaryV2().replace(evidencePath("a", "choice"), "MEMORY.md#missing"),
    ]) {
      writeFileSync(join(stage.directory, "memory_summary.md"), text);
      assert.equal(validate().summary, text);
    }
    writeFileSync(join(stage.directory, "memory_summary.md"), summaryV2() + "sk-ABCDEFGHIJKLMNOPQRSTUVWX");
    assert.throws(validate, /secret/i);
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

for (const version of ["v1", "v2"] as const) test(`${version}: recent topics require project and valid calendar date; older topics require project`, () => {
  const root = mkdtempSync(join(tmpdir(), `memory-${version}-groups-`));
  try {
    const snap = version === "v1" ? snapshot() : snapshotV2();
    const stage = buildStaging({ root, jobId: `${version}-groups`, snapshot: snap, promptHash: "prompt" });
    if (version === "v1") writeFileSync(join(stage.directory, "MEMORY.md"), "# Notes\n");
    const validate = () => version === "v1" ? validateV1Artifacts({ directory: stage.directory, snapshot: snap }) :
      validateV2Artifacts({ directory: stage.directory, snapshot: snap });
    const index = "v1\n\n## User Profile\n- Profile text does not require grouping.\n\n## User preferences\n\n## General Tips\n\n## What's in Memory\n";
    const valid = `${index}### Project description\n#### 2024-02-29\n- Choice: TypeScript\n  - desc: nested child inherits project and date\n  - learnings: no citation required\n### Another project\n#### 2026-09-27\n- Another decision\n### Older Memory Topics\n#### Legacy workspace\n- Old decision\n  - desc: no date required here\n## After index\n- This bullet is outside the index.\n`;
    writeFileSync(join(stage.directory, "memory_summary.md"), valid);
    assert.equal(validate().summary, valid);
    for (const invalid of [
      `${index}- No project or date\n`,
      `${index}### Project description\n- No date\n`,
      `${index}###   \n#### 2026-09-27\n- Empty project\n`,
      `${index}### Project description\n#### 2026-09-27\n- Valid\n### Second project\n- Date must reset\n`,
      `${index}### Project description\n#### 2026-02-30\n- Impossible date\n`,
      `${index}### Project description\n#### 2025-02-29\n- Non-leap date\n`,
      `${index}### Project description\n#### 2026-9-27\n- Malformed date\n`,
      `${index}### Older Memory Topics\n- Missing older project\n`,
      `${index}### Project description\n#### 2026-09-27\n- Recent\n### Older Memory Topics\n- Recent project cannot scope old topic\n`,
      `${index}### Older Memory Topics\n####   \n- Empty older project\n`,
    ]) {
      writeFileSync(join(stage.directory, "memory_summary.md"), invalid);
      assert.throws(validate, ArtifactFormatError, invalid);
    }
    writeFileSync(join(stage.directory, "memory_summary.md"), index);
    assert.equal(validate().summary, index, "empty index is valid");
    if (version === "v1") {
      const absent = "v1\n\nNo index or fixed headings required for v1.\n";
      writeFileSync(join(stage.directory, "memory_summary.md"), absent);
      assert.equal(validate().summary, absent);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("v2 requires four headings by presence only, without order, uniqueness or configured lower size limit", () => {
  const root = mkdtempSync(join(tmpdir(), "memory-v2-headings-"));
  try {
    const snap = snapshotV2();
    const stage = buildStaging({ root, jobId: "v2-headings", snapshot: snap, promptHash: "prompt" });
    const validate = () => validateV2Artifacts({ directory: stage.directory, snapshot: snap, summaryBytes: 100 });
    const unordered = "v1\n\n  ## What's in Memory  \n## General Tips\n## User preferences\n## User Profile\n## User Profile\n## Extra heading\n";
    writeFileSync(join(stage.directory, "memory_summary.md"), unordered);
    assert.equal(validate().summary, unordered);
    for (const heading of ["What's in Memory", "General Tips", "User preferences", "User Profile"]) {
      writeFileSync(join(stage.directory, "memory_summary.md"), unordered.replaceAll(`## ${heading}`, `## Missing ${heading}`));
      assert.throws(validate, /heading|section|missing/i, heading);
    }
    rmSync(join(stage.directory, "memory_summary.md"));
    assert.throws(validate, /required|memory_summary\.md/i);
    writeFileSync(join(stage.directory, "memory_summary.md"), Buffer.from([0xc3, 0x28]));
    assert.throws(validate, /encoded data|UTF-8/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("T36 v2: empty evidence and notes produce deterministic minimal summary without exact-template gate", () => {
  const root = mkdtempSync(join(tmpdir(), "memory-v2-notes-"));
  try {
    mkdirSync(join(root, "notes"));
    const text = "用户要求中文回答。\n";
    writeFileSync(join(root, "notes", "n1.md"), text);
    const snap = { ...snapshotV2(), notes: [{ noteId: "n1", textPath: "notes/n1.md", textHash: createHash("sha256").update(text).digest("hex"), scope: "global" }] };
    const stage = buildStaging({ root, jobId: "v2-older", snapshot: snap, promptHash: "prompt" });
    const olderSummary = summaryV2().replace(/### \/repo[\s\S]+/, `### Older Memory Topics\n\n#### Language support\n- User language: note:n1 applies when choosing a response language.\n  - desc: read the user's note when needed\n`);
    writeFileSync(join(stage.directory, "memory_summary.md"), olderSummary);
    assert.equal(validateV2Artifacts({ directory: stage.directory, snapshot: snap }).summary, olderSummary);
    const prose = olderSummary.replace("note:n1", "notes/n1.md");
    writeFileSync(join(stage.directory, "memory_summary.md"), prose);
    assert.equal(validateV2Artifacts({ directory: stage.directory, snapshot: snap }).summary, prose);
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
    const alternate = minimal.summary.replace("## User Profile", "## User Profile\nNo preferences confirmed.");
    writeFileSync(join(empty, "memory_summary.md"), alternate);
    assert.equal(validateV2Artifacts({ directory: empty, snapshot: { ...snapshotV2(), sources: [], notes: [] } }).summary, alternate);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
