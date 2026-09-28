import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStateDb, recordSnapshot, type SnapshotRecord } from "../src/store/db.ts";
import {
  claimDueExtractions, commitExtraction, enqueueExtraction, failExtraction,
  recordProcessActivity, reconcileModelCall, renewExtractionLease, reserveModelCall,
  type LeasedJob,
} from "../src/store/jobs.ts";

const NOW = Date.UTC(2024, 0, 2, 12);
const SOURCE_ID = "source-1";
const PROMPT_HASH = "a".repeat(64);

function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "pi-memory-jobs-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const db = openStateDb(root);
  t.after(() => { if (db.isOpen) db.close(); });
  const record: SnapshotRecord = {
    workspace: { workspaceKey: "w".repeat(64), repoKey: "r".repeat(64), checkoutKey: "c".repeat(64),
      cwdReal: root, gitCommonDir: join(root, ".git"), gitTopLevel: root, gitBranch: "main", gitHead: "h".repeat(40) },
    session: { sessionKey: "s".repeat(64), path: join(root, "session.jsonl"), headerId: "session-1",
      parentKey: null, branchId: "branch-1", mode: "tui" },
    revision: { sourceId: SOURCE_ID, lineageKey: "l".repeat(64), revisionHash: "v".repeat(64),
      leafId: "leaf-1", snapshotPath: join(root, "snapshot.json"), snapshotHash: "f".repeat(64), sourceTime: NOW - 10_000 },
    capturedAt: NOW - 9_000,
  };
  recordSnapshot(db, record);
  return { root, db, record };
}

function accepted(memoryVersion: "v1" | "v2" = "v1") {
  return { memoryVersion, promptHash: PROMPT_HASH, model: { provider: "mock", modelId: "extract" },
    rawMemory: memoryVersion === "v1" ? "decision" : null,
    rolloutSummary: "summary", rolloutSlug: "decision", outputHash: "o".repeat(64),
    usage: { input: 20, output: 10 }, outcome: "succeeded" as const,
    truncation: memoryVersion === "v2" ? { truncated: false, originalBytes: 7, acceptedBytes: 7 } : undefined };
}

function downgradeToSchema6(db: DatabaseSync): void {
  db.exec("ALTER TABLE extractions DROP COLUMN accepted_bytes");
  db.exec("ALTER TABLE extractions DROP COLUMN original_bytes");
  db.exec("ALTER TABLE extractions DROP COLUMN truncated");
  db.exec("DROP TABLE privacy_scrub_state");
  db.prepare("DELETE FROM schema_migrations WHERE version >= 7").run();
}

function commitLegacyText(db: DatabaseSync, job: LeasedJob, text: string): void {
  db.prepare(
    `INSERT INTO extractions (extraction_id, source_id, memory_version, prompt_hash, job_id,
       raw_memory, rollout_summary, rollout_slug, model_provider, model_id, output_hash,
       outcome, usage_input, usage_output, created_at)
     VALUES (?, ?, 'v1', ?, ?, ?, 'summary', 'legacy', 'mock', 'extract', ?, 'succeeded', 1, 1, ?)`,
  ).run("legacy-extraction", SOURCE_ID, PROMPT_HASH, job.jobId, text, "o".repeat(64), NOW + 1);
}

test("one durable v1 job is leased once; an expired lease fences the late response after restart", (t) => {
  const { root, db } = fixture(t);
  enqueueExtraction(db, { sourceId: SOURCE_ID, memoryVersion: "v1", promptHash: PROMPT_HASH, now: NOW });
  enqueueExtraction(db, { sourceId: SOURCE_ID, memoryVersion: "v1", promptHash: PROMPT_HASH, now: NOW });
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM jobs").get() as { n: number }).n, 1);

  const [first] = claimDueExtractions(db, { owner: "one", now: NOW, limit: 2 });
  assert.ok(first);
  assert.deepEqual(claimDueExtractions(db, { owner: "two", now: NOW + 1, limit: 2 }), []);
  db.close();
  const reopened = openStateDb(root);
  t.after(() => reopened.close());
  const [second] = claimDueExtractions(reopened, { owner: "two", now: NOW + 181_000, limit: 2 });
  assert.ok(second);
  assert.ok(second.fence > first.fence);
  assert.equal(commitExtraction(reopened, first, accepted(), NOW + 181_001), false);
  assert.equal(commitExtraction(reopened, second, accepted(), NOW + 181_002), true);
  assert.equal((reopened.prepare("SELECT COUNT(*) AS n FROM extractions").get() as { n: number }).n, 1);
  assert.deepEqual(claimDueExtractions(reopened, { owner: "three", now: NOW + 400_000, limit: 2 }), []);
});

test("v1 no-output leaves v2 independent, and v2 stores NULL raw memory with truncation metadata", (t) => {
  const { db } = fixture(t);
  enqueueExtraction(db, { sourceId: SOURCE_ID, memoryVersion: "v1", promptHash: PROMPT_HASH, now: NOW });
  const [v1] = claimDueExtractions(db, { owner: "v1", now: NOW, limit: 1 });
  assert.ok(v1);
  assert.equal(v1.memoryVersion, "v1");
  assert.equal(commitExtraction(db, v1, { ...accepted(), rawMemory: "", rolloutSummary: "",
    rolloutSlug: "", outcome: "no_output" }, NOW + 1), true);
  enqueueExtraction(db, { sourceId: SOURCE_ID, memoryVersion: "v2", promptHash: "b".repeat(64), now: NOW + 2 });
  const [v2] = claimDueExtractions(db, { owner: "v2", now: NOW + 2, limit: 1 });
  assert.ok(v2);
  assert.equal(v2.memoryVersion, "v2");
  const summary = "Decision retained\n[... remainder omitted ...]";
  const result = { ...accepted("v2"), promptHash: v2.promptHash, rolloutSummary: summary,
    truncation: { truncated: true, originalBytes: 9_230, acceptedBytes: Buffer.byteLength(summary, "utf8") } };
  assert.equal(commitExtraction(db, v2, { ...result, memoryVersion: "v1" }, NOW + 3), false);
  assert.equal(commitExtraction(db, v2, { ...result, rawMemory: "v1 leak" }, NOW + 3), false);
  assert.equal(commitExtraction(db, v2, result, NOW + 3), true);
  const row = db.prepare("SELECT raw_memory, truncated, original_bytes, accepted_bytes FROM extractions WHERE memory_version = 'v2'")
    .get() as { raw_memory: string | null; truncated: number; original_bytes: number; accepted_bytes: number };
  assert.deepEqual({ ...row }, { raw_memory: null, truncated: 1, original_bytes: 9_230,
    accepted_bytes: Buffer.byteLength(summary, "utf8") });
  assert.deepEqual(claimDueExtractions(db, { owner: "again", now: NOW + 4, limit: 2 }), []);
  assert.throws(() => db.prepare(
    `UPDATE extractions SET raw_memory = 'not allowed' WHERE memory_version = 'v2'`,
  ).run(), /CHECK constraint failed/);
});

test("privacy revocation deletes derived extraction text in the same transaction", (t) => {
  const { root, db, record } = fixture(t);
  enqueueExtraction(db, { sourceId: SOURCE_ID, memoryVersion: "v1", promptHash: PROMPT_HASH, now: NOW });
  const [job] = claimDueExtractions(db, { owner: "one", now: NOW, limit: 1 });
  assert.ok(job);
  const marker = "PRIVATE_REVOKED_EXTRACTION_a73e9f_UNIQUE";
  assert.equal(commitExtraction(db, job, { ...accepted(), rawMemory: marker }, NOW + 1), true);
  const containsDeletedText = () => ["state.sqlite", "state.sqlite-wal", "state.sqlite-shm"]
    .map((name) => join(root, name)).filter(existsSync)
    .some((path) => readFileSync(path).includes(Buffer.from(marker)));
  assert.equal(containsDeletedText(), true, "test fixture must place extracted text on disk");
  recordSnapshot(db, { ...record, revision: { ...record.revision, sourceId: "edited-source",
    revisionHash: "e".repeat(64), leafId: "edited-leaf" }, capturedAt: NOW + 2,
    revokedSourceIds: [SOURCE_ID] }, root);
  assert.equal((db.prepare("SELECT status FROM source_revisions WHERE source_id = ?")
    .get(SOURCE_ID) as { status: string }).status, "privacy_revoked");
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM extractions WHERE source_id = ?")
    .get(SOURCE_ID) as { n: number }).n, 0);
  assert.equal(containsDeletedText(), false, "privacy removal must purge SQLite and WAL bytes");
});

test("startup vacuums legacy bytes already deleted with secure_delete off", (t) => {
  const { root, db } = fixture(t);
  // Simulate a pre-upgrade store that already deleted a revoked SQL row but
  // retained its bytes in SQLite free space before secure_delete was enabled.
  downgradeToSchema6(db);
  db.exec("PRAGMA secure_delete = OFF");
  enqueueExtraction(db, { sourceId: SOURCE_ID, memoryVersion: "v1", promptHash: PROMPT_HASH, now: NOW });
  const [job] = claimDueExtractions(db, { owner: "old", now: NOW, limit: 1 });
  assert.ok(job);
  const marker = "PRIVATE_LEGACY_EXTRACTION_b53d87_UNIQUE";
  commitLegacyText(db, job, marker);
  db.prepare("UPDATE source_revisions SET status = 'privacy_revoked' WHERE source_id = ?").run(SOURCE_ID);
  db.prepare("DELETE FROM extractions WHERE source_id = ?").run(SOURCE_ID);
  db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
  db.close();
  const databasePath = join(root, "state.sqlite");
  assert.equal(readFileSync(databasePath).includes(Buffer.from(marker)), true,
    "fixture must retain already-deleted plaintext in the main DB");
  const reopened = openStateDb(root);
  t.after(() => reopened.close());
  assert.equal((reopened.prepare("SELECT COUNT(*) AS n FROM extractions").get() as { n: number }).n, 0);
  assert.equal(readFileSync(databasePath).includes(Buffer.from(marker)), false);
  const wal = databasePath + "-wal";
  if (existsSync(wal)) assert.equal(readFileSync(wal).includes(Buffer.from(marker)), false);
});

test("upgrade vacuums deleted legacy bytes even when no privacy tombstone remains", (t) => {
  const { root, db } = fixture(t);
  downgradeToSchema6(db);
  db.exec("PRAGMA secure_delete = OFF");
  enqueueExtraction(db, { sourceId: SOURCE_ID, memoryVersion: "v1", promptHash: PROMPT_HASH, now: NOW });
  const [job] = claimDueExtractions(db, { owner: "old", now: NOW, limit: 1 });
  assert.ok(job);
  const marker = "PRIVATE_NO_TOMBSTONE_e38c_UNIQUE";
  commitLegacyText(db, job, marker);
  db.prepare("DELETE FROM extractions WHERE source_id = ?").run(SOURCE_ID);
  db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
  db.close();
  const databasePath = join(root, "state.sqlite");
  assert.equal(readFileSync(databasePath).includes(Buffer.from(marker)), true);
  const reopened = openStateDb(root);
  t.after(() => reopened.close());
  assert.equal(readFileSync(databasePath).includes(Buffer.from(marker)), false);
  assert.equal((reopened.prepare("SELECT legacy_vacuum_pending FROM privacy_scrub_state")
    .get() as { legacy_vacuum_pending: number }).legacy_vacuum_pending, 0);
});

test("legacy free-space scrub retries if a reader blocks its final WAL checkpoint", (t) => {
  const { root, db } = fixture(t);
  downgradeToSchema6(db);
  db.exec("PRAGMA secure_delete = OFF");
  enqueueExtraction(db, { sourceId: SOURCE_ID, memoryVersion: "v1", promptHash: PROMPT_HASH, now: NOW });
  const [job] = claimDueExtractions(db, { owner: "old", now: NOW, limit: 1 });
  assert.ok(job);
  const marker = "PRIVATE_CHECKPOINT_RETRY_f415_UNIQUE";
  commitLegacyText(db, job, marker);
  db.prepare("DELETE FROM extractions WHERE source_id = ?").run(SOURCE_ID);
  db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
  db.close();
  const databasePath = join(root, "state.sqlite");
  assert.equal(readFileSync(databasePath).includes(Buffer.from(marker)), true);
  const reader = new DatabaseSync(databasePath, { readOnly: true });
  t.after(() => { if (reader.isOpen) reader.close(); });
  reader.exec("BEGIN");
  reader.prepare("SELECT source_id FROM source_revisions").get();
  assert.throws(() => openStateDb(root, { busyTimeoutMs: 100 }), /privacy WAL cleanup deferred/);
  reader.exec("ROLLBACK"); reader.close();
  const recovered = openStateDb(root);
  t.after(() => recovered.close());
  assert.equal(readFileSync(databasePath).includes(Buffer.from(marker)), false);
  const wal = databasePath + "-wal";
  if (existsSync(wal)) assert.equal(readFileSync(wal).includes(Buffer.from(marker)), false);
});

test("schema 5 jobs upgrade to configuration epochs without losing durable work", (t) => {
  const { root, db } = fixture(t);
  enqueueExtraction(db, { sourceId: SOURCE_ID, memoryVersion: "v1", promptHash: PROMPT_HASH, now: NOW });
  db.close();
  const legacy = new DatabaseSync(join(root, "state.sqlite"));
  legacy.exec("ALTER TABLE jobs DROP COLUMN config_epoch");
  downgradeToSchema6(legacy);
  legacy.prepare("DELETE FROM schema_migrations WHERE version >= 6").run();
  legacy.close();
  const upgraded = openStateDb(root);
  t.after(() => upgraded.close());
  assert.deepEqual({ ...upgraded.prepare("SELECT status, config_epoch FROM jobs").get() },
    { status: "queued", config_epoch: "" });
  assert.equal((upgraded.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as { v: number }).v, 8);
});

test("schema 7 migration preserves existing v1 output while adding v2 truncation metadata", (t) => {
  const { root, db } = fixture(t);
  enqueueExtraction(db, { sourceId: SOURCE_ID, memoryVersion: "v1", promptHash: PROMPT_HASH, now: NOW });
  const [job] = claimDueExtractions(db, { owner: "legacy", now: NOW, limit: 1 });
  assert.ok(job);
  assert.equal(commitExtraction(db, job, accepted(), NOW + 1), true);
  db.close();
  const legacy = new DatabaseSync(join(root, "state.sqlite"));
  legacy.exec("ALTER TABLE extractions DROP COLUMN accepted_bytes");
  legacy.exec("ALTER TABLE extractions DROP COLUMN original_bytes");
  legacy.exec("ALTER TABLE extractions DROP COLUMN truncated");
  legacy.prepare("DELETE FROM schema_migrations WHERE version = 8").run();
  legacy.close();
  const migrated = openStateDb(root);
  t.after(() => migrated.close());
  const row = migrated.prepare("SELECT raw_memory, truncated, original_bytes, accepted_bytes FROM extractions")
    .get() as { raw_memory: string; truncated: number; original_bytes: number; accepted_bytes: number };
  assert.deepEqual({ ...row }, { raw_memory: "decision", truncated: 0, original_bytes: 0, accepted_bytes: 0 });
  assert.equal((migrated.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as { v: number }).v, 8);
});

test("a conflicting extraction is never reported as a successful commit", (t) => {
  const { db } = fixture(t);
  enqueueExtraction(db, { sourceId: SOURCE_ID, memoryVersion: "v1", promptHash: PROMPT_HASH, now: NOW });
  const [job] = claimDueExtractions(db, { owner: "one", now: NOW, limit: 1 });
  assert.ok(job);
  db.prepare(
    `INSERT INTO extractions (extraction_id, source_id, memory_version, prompt_hash, job_id,
      raw_memory, rollout_summary, rollout_slug, model_provider, model_id, output_hash,
      outcome, usage_input, usage_output, created_at)
     VALUES (?, ?, 'v1', ?, ?, '', 'original', 'old', 'mock', 'extract', ?, 'succeeded', 1, 1, ?)`,
  ).run("original", SOURCE_ID, PROMPT_HASH, job.jobId, "f".repeat(64), NOW);

  assert.equal(commitExtraction(db, job, accepted(), NOW + 1), false);
  assert.equal((db.prepare("SELECT output_hash FROM extractions").get() as { output_hash: string }).output_hash, "f".repeat(64));
  assert.equal((db.prepare("SELECT status FROM jobs WHERE job_id = ?").get(job.jobId) as { status: string }).status, "leased");
});

test("store rejects a false no-output classification without consuming the lease", (t) => {
  const { db } = fixture(t);
  enqueueExtraction(db, { sourceId: SOURCE_ID, memoryVersion: "v1", promptHash: PROMPT_HASH, now: NOW });
  const [job] = claimDueExtractions(db, { owner: "one", now: NOW, limit: 1 });
  assert.ok(job);
  assert.equal(commitExtraction(db, job, { ...accepted(), outcome: "no_output" }, NOW + 1), false);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM extractions").get() as { n: number }).n, 0);
  assert.equal(commitExtraction(db, job, { ...accepted(), rawMemory: "", rolloutSummary: "",
    rolloutSlug: "", outcome: "no_output" }, NOW + 2), true);
});

test("no-output v1 result is processed once without suppressing the other version", (t) => {
  const { db } = fixture(t);
  enqueueExtraction(db, { sourceId: SOURCE_ID, memoryVersion: "v1", promptHash: PROMPT_HASH, now: NOW });
  enqueueExtraction(db, { sourceId: SOURCE_ID, memoryVersion: "v2", promptHash: PROMPT_HASH, now: NOW });
  const jobs = claimDueExtractions(db, { owner: "both", now: NOW, limit: 2 });
  assert.equal(jobs.length, 2);
  const v1 = jobs.find((job: LeasedJob) => job.memoryVersion === "v1");
  const v2 = jobs.find((job: LeasedJob) => job.memoryVersion === "v2");
  assert.ok(v1 && v2);
  assert.equal(commitExtraction(db, v1, { ...accepted(), rawMemory: "", rolloutSummary: "",
    rolloutSlug: "", outcome: "no_output" }, NOW + 1), true);
  assert.equal(commitExtraction(db, v2, accepted("v2"), NOW + 2), true);
  enqueueExtraction(db, { sourceId: SOURCE_ID, memoryVersion: "v1", promptHash: PROMPT_HASH, now: NOW + 3 });
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM jobs").get() as { n: number }).n, 2);
  assert.deepEqual(claimDueExtractions(db, { owner: "again", now: NOW + 4, limit: 2 }), []);
  const rows = db.prepare("SELECT memory_version, outcome, raw_memory FROM extractions ORDER BY memory_version")
    .all() as { memory_version: string; outcome: string; raw_memory: string | null }[];
  assert.deepEqual(rows.map((row) => ({ ...row })), [
    { memory_version: "v1", outcome: "no_output", raw_memory: "" },
    { memory_version: "v2", outcome: "succeeded", raw_memory: null },
  ]);
});

test("an active foreground session blocks extraction until settlement or heartbeat expiry", (t) => {
  const { db, record } = fixture(t);
  enqueueExtraction(db, { sourceId: SOURCE_ID, memoryVersion: "v1", promptHash: PROMPT_HASH, now: NOW });
  recordProcessActivity(db, { owner: "foreground", sessionKey: record.session.sessionKey,
    state: "active", now: NOW });
  assert.deepEqual(claimDueExtractions(db, { owner: "background", now: NOW + 1, limit: 2 }), []);
  recordProcessActivity(db, { owner: "foreground", sessionKey: record.session.sessionKey,
    state: "idle", now: NOW + 2 });
  assert.equal(claimDueExtractions(db, { owner: "background", now: NOW + 3, limit: 2 }).length, 1);
});

test("idle eligibility uses final settlement time, not an older message timestamp", (t) => {
  const { db } = fixture(t);
  enqueueExtraction(db, { sourceId: SOURCE_ID, memoryVersion: "v1", promptHash: PROMPT_HASH, now: NOW });
  assert.deepEqual(claimDueExtractions(db, { owner: "background", now: NOW, limit: 1,
    minIdleMs: 10_000 }), []);
  assert.equal(claimDueExtractions(db, { owner: "background", now: NOW + 1_001, limit: 1,
    minIdleMs: 10_000 }).length, 1);
});

test("a second process cannot claim a busy source or an already leased global slot", (t) => {
  const { root, db, record } = fixture(t);
  const peer = openStateDb(root);
  t.after(() => peer.close());
  enqueueExtraction(db, { sourceId: SOURCE_ID, memoryVersion: "v1", promptHash: PROMPT_HASH, now: NOW });
  recordProcessActivity(db, { owner: "foreground", sessionKey: record.session.sessionKey,
    state: "active", now: NOW });
  assert.deepEqual(claimDueExtractions(peer, { owner: "peer", now: NOW + 179_999, limit: 1 }), []);
  const [leased] = claimDueExtractions(peer, { owner: "peer", now: NOW + 180_001, limit: 1, slots: 1 });
  assert.ok(leased);
  assert.deepEqual(claimDueExtractions(db, { owner: "other", now: NOW + 180_002, limit: 1, slots: 1 }), []);
});

test("obsolete revisions and mismatched memory versions cannot accept a late extraction", (t) => {
  const { db, record } = fixture(t);
  enqueueExtraction(db, { sourceId: SOURCE_ID, memoryVersion: "v1", promptHash: PROMPT_HASH, now: NOW });
  const [leased] = claimDueExtractions(db, { owner: "old", now: NOW, limit: 2 });
  assert.ok(leased);
  assert.equal(commitExtraction(db, leased, accepted("v2"), NOW + 1), false);
  recordSnapshot(db, { ...record, revision: { ...record.revision, sourceId: "source-new",
    revisionHash: "n".repeat(64), leafId: "new-leaf" }, capturedAt: NOW + 2 });
  assert.equal(commitExtraction(db, leased, accepted(), NOW + 3), false);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM extractions").get() as { n: number }).n, 0);
  assert.equal((db.prepare("SELECT status FROM jobs WHERE job_id = ?").get(leased.jobId) as { status: string }).status, "superseded");
});

test("a provider failure for a superseded source never queues stale work again", (t) => {
  const { db, record } = fixture(t);
  enqueueExtraction(db, { sourceId: SOURCE_ID, memoryVersion: "v1", promptHash: PROMPT_HASH, now: NOW });
  const [job] = claimDueExtractions(db, { owner: "one", now: NOW, limit: 1 });
  assert.ok(job);
  recordSnapshot(db, { ...record, revision: { ...record.revision, sourceId: "source-new",
    revisionHash: "n".repeat(64), leafId: "new-leaf" }, capturedAt: NOW + 1 });

  assert.equal(failExtraction(db, job, "transient", "provider_error", NOW + 2), true);
  assert.equal((db.prepare("SELECT status FROM jobs WHERE job_id = ?").get(job.jobId) as { status: string }).status, "superseded");
  assert.deepEqual(claimDueExtractions(db, { owner: "two", now: NOW + 360_000, limit: 1 }), []);
});

test("lease renewal and bounded transient retry require the current owner/fence", (t) => {
  const { db } = fixture(t);
  enqueueExtraction(db, { sourceId: SOURCE_ID, memoryVersion: "v1", promptHash: PROMPT_HASH, now: NOW });
  const [one] = claimDueExtractions(db, { owner: "one", now: NOW, limit: 1 });
  assert.ok(one);
  assert.equal(renewExtractionLease(db, one, NOW + 10_000), true);
  assert.equal(failExtraction(db, one, "transient", "timeout", NOW + 11_000), true);
  assert.deepEqual(claimDueExtractions(db, { owner: "two", now: NOW + 71_000 - 1, limit: 1 }), []);
  const [two] = claimDueExtractions(db, { owner: "two", now: NOW + 71_000, limit: 1 });
  assert.ok(two);
  assert.equal(renewExtractionLease(db, one, NOW + 71_001), false);
  assert.equal(failExtraction(db, one, "blocked", "stale", NOW + 71_001), false);
  assert.equal(failExtraction(db, two, "transient", "rate_limit", NOW + 71_002), true);
  assert.deepEqual(claimDueExtractions(db, { owner: "three", now: NOW + 371_001, limit: 1 }), []);
  const [three] = claimDueExtractions(db, { owner: "three", now: NOW + 371_002, limit: 1 });
  assert.ok(three);
  assert.equal(failExtraction(db, three, "transient", "timeout", NOW + 371_003), true);
  assert.equal((db.prepare("SELECT status FROM jobs WHERE job_id = ?").get(one.jobId) as { status: string }).status, "blocked");
});

test("daily request budget rolls over on configured local day, not UTC midnight", (t) => {
  const { db } = fixture(t);
  const limits = { input: 100, output: 40, requests: 1 };
  const request = (id: string, now: number) => reserveModelCall(db, {
    id, now, timezone: "America/New_York", provider: "mock", model: "A",
    estimate: { input: 10, output: 5 }, limits,
  });
  assert.deepEqual(request("evening", Date.UTC(2024, 0, 2, 0, 30)), { ok: true });
  assert.deepEqual(request("same-local-day", Date.UTC(2024, 0, 2, 4, 30)),
    { ok: false, reason: "request_budget" });
  assert.deepEqual(request("next-local-day", Date.UTC(2024, 0, 2, 5, 30)), { ok: true });
});

test("budget reservations are shared across models and missing usage keeps the conservative charge", (t) => {
  const { db } = fixture(t);
  const limits = { input: 100, output: 40, requests: 2 };
  const first = reserveModelCall(db, { id: "request-1", now: NOW, timezone: "UTC", provider: "mock", model: "A",
    estimate: { input: 60, output: 20 }, limits });
  assert.deepEqual(first, { ok: true });
  assert.deepEqual(reserveModelCall(db, { id: "request-2", now: NOW, timezone: "UTC", provider: "mock", model: "B",
    estimate: { input: 41, output: 10 }, limits }), { ok: false, reason: "input_budget" });
  reconcileModelCall(db, "request-1", undefined); // no provider usage: keep the estimate
  assert.deepEqual(reserveModelCall(db, { id: "request-2", now: NOW, timezone: "UTC", provider: "mock", model: "B",
    estimate: { input: 40, output: 20 }, limits }), { ok: true });
  reconcileModelCall(db, "request-2", { input: 10, output: 5 });
  assert.deepEqual(reserveModelCall(db, { id: "request-3", now: NOW, timezone: "UTC", provider: "mock", model: "C",
    estimate: { input: 1, output: 1 }, limits }), { ok: false, reason: "request_budget" });
  const rows = db.prepare("SELECT SUM(actual_input) AS input, SUM(actual_output) AS output, SUM(call_count) AS calls FROM budget_usage")
    .get() as { input: number; output: number; calls: number };
  assert.deepEqual({ ...rows }, { input: 70, output: 25, calls: 2 });
});
