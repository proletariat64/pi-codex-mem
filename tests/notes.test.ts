import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStateDb } from "../src/store/db.ts";
import { claimConsolidation, getPublishedGeneration, selectConsolidation } from "../src/store/consolidation.ts";
import { addNote, cleanupRevokedNotes, forgetNote } from "../src/control/notes.ts";
import { buildStaging, textHash } from "../src/pipeline/staging.ts";
import { MINIMAL_V1_SUMMARY, validateV1Artifacts, validateV2Artifacts, writeMinimalV1, writeMinimalV2 } from "../src/pipeline/validate.ts";
import { publishGeneration } from "../src/pipeline/publish.ts";
import { acquireReadView } from "../src/read/view.ts";
import { defaultConfig } from "../src/config.ts";
import { ConsolidationScheduler } from "../src/pipeline/scheduler.ts";
import type { Api, Model } from "@earendil-works/pi-ai";

function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "pi-notes-")); const db = openStateDb(root);
  t.after(() => { if (db.isOpen) db.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, db };
}
const provenance = { consumerSession: "session", runId: "run", userMessageId: "u1", origin: "tool" } as const;
function publish(root: string, db: ReturnType<typeof openStateDb>, memoryVersion: "v1" | "v2", generationId: string, now: number) {
  const snapshot = selectConsolidation(db, { memoryVersion, now });
  const lease = claimConsolidation(db, { memoryVersion, owner: "writer", promptHash: "writer", inputRevisionHash: snapshot.selectionHash, now }); assert.ok(lease);
  const stage = buildStaging({ root, snapshot, jobId: lease.jobId, promptHash: "writer" });
  if (!snapshot.notes.length) (memoryVersion === "v1" ? writeMinimalV1 : writeMinimalV2)(stage.directory);
  else {
    const latest = [...snapshot.notes].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0)).at(-1)!;
    const text = readFileSync(latest.textPath, "utf8");
    writeFileSync(join(stage.directory, "memory_summary.md"), MINIMAL_V1_SUMMARY.replace("## User preferences\n", `## User preferences\n- ${text}; note:${latest.noteId}\n`));
    if (memoryVersion === "v1") writeFileSync(join(stage.directory, "MEMORY.md"), `# Task Group: Notes\nscope: Explicit user preferences\napplies_to: global\n## Task 1: Current rule\n### user_notes\n- note:${latest.noteId}\n### keywords\n- preference\n## User preferences\n- ${text} [Task 1]\n`);
  }
  stage.manifest.fileHashes = (memoryVersion === "v1" ? validateV1Artifacts : validateV2Artifacts)({ directory: stage.directory, snapshot }).fileHashes;
  const manifest = JSON.stringify(stage.manifest); writeFileSync(join(stage.directory, "manifest.json"), manifest);
  assert.equal(publishGeneration({ root, db, stagingDir: stage.directory, lease, snapshot, inputHash: stage.inputHash,
    manifestHash: textHash(manifest), generationId, now }).published, true);
  return acquireReadView({ root, db, memoryVersion, now });
}
test("explicit notes survive reopening with shared scope and host-provided provenance", (t) => {
  const { root, db } = fixture(t);
  const note = addNote({ root, db, action: "remember", text: "中文偏好：使用 TypeScript", scope: "workspace:/repo",
    provenance: { consumerSession: "reader", runId: "run", userMessageId: "u1", origin: "tool" }, now: 100 });
  assert.equal(readFileSync(note.textPath, "utf8"), "中文偏好：使用 TypeScript");
  db.close(); const reopened = openStateDb(root); t.after(() => reopened.close());
  for (const memoryVersion of ["v1", "v2"] as const) {
    assert.deepEqual(selectConsolidation(reopened, { memoryVersion, now: 100 }).notes.map(note => note.noteId), [note.noteId]);
  }
  const stored = reopened.prepare("SELECT consumer_session, run_id, user_message_id, origin, scope FROM notes WHERE note_id = ?").get(note.noteId);
  assert.deepEqual({ ...stored }, { consumer_session: "reader", run_id: "run", user_message_id: "u1", origin: "tool", scope: "workspace:/repo" });
});

test("correction fences old writers and each version independently reconciles its note application", (t) => {
  const { root, db } = fixture(t);
  const v1 = publish(root, db, "v1", "old-v1", 100); const v2 = publish(root, db, "v2", "old-v2", 101);
  assert.ok(v1); assert.ok(v2);
  const old = claimConsolidation(db, { memoryVersion: "v1", owner: "obsolete", promptHash: "writer", now: 102 }); assert.ok(old);
  const correction = addNote({ root, db, action: "correct", text: "Answer in Chinese", scope: "global", provenance, now: 103 });
  assert.equal(correction.controlEpoch, 1);
  assert.equal(getPublishedGeneration(db, "v1", 104), null); assert.equal(getPublishedGeneration(db, "v2", 104), null);
  assert.equal((db.prepare("SELECT status FROM jobs WHERE job_id = ?").get(old.jobId) as { status: string }).status, "superseded");
  cleanupRevokedNotes({ root, db, now: 104 });
  assert.equal(existsSync(v1.directory), false); assert.equal(existsSync(v2.directory), false);
  const next = publish(root, db, "v1", "new-v1", 105); assert.match(next!.summary, /Answer in Chinese/);
  assert.equal(getPublishedGeneration(db, "v2", 106), null, "v1 success cannot unblock inactive v2");
  assert.deepEqual(db.prepare("SELECT memory_version FROM note_applications WHERE note_id = ?").all(correction.noteId).map(row => row.memory_version), ["v1"]);
  const other = publish(root, db, "v2", "new-v2", 107); assert.match(other!.summary, /Answer in Chinese/);
  assert.deepEqual(db.prepare("SELECT memory_version, note_hash FROM note_applications WHERE note_id = ? ORDER BY memory_version").all(correction.noteId)
    .map(row => [row.memory_version, row.note_hash]), [["v1", correction.textHash], ["v2", correction.textHash]]);
});

test("forgetting one note removes its evidence, revokes both views and explains independently supported older evidence", (t) => {
  const { root, db } = fixture(t);
  const remembered = addNote({ root, db, action: "remember", text: "Use TypeScript", scope: "global", provenance, now: 100 });
  const correction = addNote({ root, db, action: "correct", text: "Use Rust", scope: "global", provenance, now: 101 });
  publish(root, db, "v1", "corrected", 102);
  const forgotten = forgetNote({ root, db, noteId: correction.noteId, now: 103 });
  assert.equal(forgotten.removed, true); assert.match(forgotten.explanation, /older independently supported source evidence applicable again/);
  assert.equal(existsSync(correction.textPath), false); assert.equal(existsSync(remembered.textPath), true);
  assert.equal(getPublishedGeneration(db, "v1", 104), null); assert.equal(getPublishedGeneration(db, "v2", 104), null);
  cleanupRevokedNotes({ root, db, now: 104 });
  const rebuilt = publish(root, db, "v1", "remembered", 105); assert.match(rebuilt!.summary, /Use TypeScript/); assert.doesNotMatch(rebuilt!.summary, /Use Rust/);
  assert.equal(forgetNote({ root, db, noteId: correction.noteId, now: 106 }).removed, false);
});

test("schema 9 notes migrate without changing their text, hash, scope or applications", (t) => {
  const { root, db } = fixture(t);
  const note = addNote({ root, db, action: "remember", text: "Legacy preference", scope: "global", provenance, now: 100 });
  publish(root, db, "v1", "legacy", 101);
  db.exec(`ALTER TABLE notes DROP COLUMN consumer_session; ALTER TABLE notes DROP COLUMN run_id;
    ALTER TABLE notes DROP COLUMN user_message_id; ALTER TABLE notes DROP COLUMN origin;
    DELETE FROM schema_migrations WHERE version = 10;`);
  db.close(); const migrated = openStateDb(root); t.after(() => migrated.close());
  const row = migrated.prepare("SELECT text_hash, scope, origin, run_id FROM notes WHERE note_id = ?").get(note.noteId);
  assert.deepEqual({ ...row }, { text_hash: note.textHash, scope: "global", origin: "legacy", run_id: null });
  assert.equal(readFileSync(note.textPath, "utf8"), "Legacy preference");
  assert.equal(getPublishedGeneration(migrated, "v1", 102)?.generationId, "legacy");
  assert.equal(migrated.prepare("SELECT COUNT(*) AS n FROM note_applications").get()!.n, 1);
});

test("startup sweeps interrupted note files, keeps active notes and rejects a symlinked note namespace", (t) => {
  const { root, db } = fixture(t);
  const note = addNote({ root, db, action: "remember", text: "Keep active", scope: "global", provenance, now: 100 });
  const orphan = join(root, "notes", "00000000-0000-0000-0000-000000000000.md"); writeFileSync(orphan, "uncommitted note");
  db.close(); const reopened = openStateDb(root); t.after(() => { if (reopened.isOpen) reopened.close(); });
  assert.equal(existsSync(orphan), false); assert.equal(readFileSync(note.textPath, "utf8"), "Keep active");
  reopened.close();
  rmSync(join(root, "notes"), { recursive: true });
  const outside = join(root, "outside"); mkdirSync(outside); symlinkSync(outside, join(root, "notes"));
  assert.throws(() => openStateDb(root), /notes symlink/);
  assert.throws(() => addNote({ root, db: reopened, action: "remember", text: "escape", scope: "global", provenance }), /symlink/);
});

test("a provider outage after correction keeps both versions unavailable and notes durable", async (t) => {
  const { root, db } = fixture(t);
  publish(root, db, "v1", "old-v1", 100); publish(root, db, "v2", "old-v2", 101);
  const note = addNote({ root, db, action: "correct", text: "Use TypeScript", scope: "global", provenance, now: 102 });
  const config = defaultConfig("UTC"); config.models.consolidate = { provider: "fixture", modelId: "writer" };
  const model: Model<Api> = { provider: "fixture", id: "writer", api: "openai-completions", name: "Writer", baseUrl: "https://unused.invalid",
    contextWindow: 200_000, maxTokens: 8_000, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const scheduler = new ConsolidationScheduler({ root, db, config: () => config, now: () => 103,
    isForegroundIdle: () => true, modelPort: () => ({ resolve: () => model, stream: () => { throw new Error("provider unavailable"); } }) });
  try {
    const result = await scheduler.runPass(); assert.equal(result[0]!.status, "retry_wait");
    assert.equal(acquireReadView({ root, db, memoryVersion: "v1", now: 104 }), null);
    assert.equal(acquireReadView({ root, db, memoryVersion: "v2", now: 104 }), null);
    assert.equal(readFileSync(note.textPath, "utf8"), "Use TypeScript");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM note_applications WHERE note_id = ?").get(note.noteId)!.n, 0);
  } finally { await scheduler.stop(); }
});

test("committed correction priority survives a backward or repeated wall clock", (t) => {
  const { root, db } = fixture(t);
  addNote({ root, db, action: "correct", text: "Use Rust", scope: "global", provenance, now: 100 });
  const current = addNote({ root, db, action: "correct", text: "Use TypeScript", scope: "global", provenance, now: 99 });
  const notes = selectConsolidation(db, { memoryVersion: "v1", now: 100 }).notes.sort((a, b) => a.createdAt! - b.createdAt!);
  assert.deepEqual(notes.map(note => note.createdAt), [100, 101]); assert.equal(notes.at(-1)!.noteId, current.noteId);
  assert.match(publish(root, db, "v1", "current", 102)!.summary, /Use TypeScript/);
});
