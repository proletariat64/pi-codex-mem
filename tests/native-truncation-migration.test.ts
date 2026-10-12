import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openStateDb, recordSnapshot } from "../src/store/db.ts";
import { claimDueExtractions, commitExtraction, enqueueExtraction } from "../src/store/jobs.ts";

function legacyStore(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "pi-native-migration-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const db = openStateDb(root);
  recordSnapshot(db, {
    workspace: { workspaceKey: "workspace", repoKey: null, checkoutKey: null, cwdReal: root,
      gitCommonDir: null, gitTopLevel: null, gitBranch: null, gitHead: null },
    session: { sessionKey: "session", path: "synthetic.jsonl", headerId: "session", parentKey: null, branchId: "branch", mode: "tui" },
    revision: { sourceId: "source", lineageKey: "lineage", revisionHash: "revision", leafId: "leaf",
      snapshotPath: "synthetic.json", snapshotHash: "hash", sourceTime: 1 }, capturedAt: 1,
  });
  enqueueExtraction(db, { sourceId: "source", memoryVersion: "v1", promptHash: "prompt", now: 2 });
  const [job] = claimDueExtractions(db, { owner: "writer", now: 3, limit: 1 });
  assert.ok(job);
  assert.ok(commitExtraction(db, job, { memoryVersion: "v1", promptHash: "prompt", model: { provider: "fake", modelId: "model" },
    rawMemory: "preserved learning", rolloutSummary: "preserved summary", rolloutSlug: "slug", outputHash: "hash",
    usage: { input: 10, output: 20 }, outcome: "succeeded" }, 4));
  // Recreate the actual v13 constraint, retaining SQLite's altered-table quoting.
  const schema = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'extractions'").get()!.sql as string;
  const triggers = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND sql LIKE '%extractions%'").all();
  db.exec("BEGIN");
  for (const trigger of triggers) db.exec(`DROP TRIGGER ${trigger.name}`);
  db.exec(schema.replace(/CREATE TABLE\s+(?:"extractions"|extractions)/i, "CREATE TABLE legacy_extractions")
    .replace("CHECK (accepted_bytes >= 0)", "CHECK (accepted_bytes BETWEEN 0 AND 9000)"));
  db.exec("INSERT INTO legacy_extractions SELECT * FROM extractions; DROP TABLE extractions; ALTER TABLE legacy_extractions RENAME TO extractions");
  for (const trigger of triggers) db.exec(trigger.sql as string);
  db.exec("DELETE FROM schema_migrations WHERE version = 14; COMMIT");
  const before = db.prepare("SELECT * FROM extractions").all();
  return { root, db, before };
}

test("v13 expansion preserves extraction rows, constraints and provenance triggers across reopen", t => {
  const { root, db, before } = legacyStore(t);
  db.exec(`VACUUM INTO '${join(root, "pre-upgrade.sqlite")}'`);
  db.close();
  const upgraded = openStateDb(root);
  assert.deepEqual(upgraded.prepare("SELECT * FROM extractions").all(), before);
  assert.equal(upgraded.prepare("SELECT MAX(version) AS v FROM schema_migrations").get()!.v, 14);
  assert.equal(upgraded.prepare("PRAGMA foreign_key_check").all().length, 0);
  assert.throws(() => upgraded.exec("UPDATE extractions SET accepted_bytes = -1"), /CHECK constraint/);
  upgraded.exec("UPDATE extractions SET accepted_bytes = 9025");
  assert.equal(upgraded.prepare("SELECT accepted_bytes FROM extractions").get()!.accepted_bytes, 9025);
  assert.ok(upgraded.prepare("SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = 'generation_source_version'").get());
  upgraded.close();
  const reopened = openStateDb(root);
  assert.equal(reopened.prepare("SELECT accepted_bytes FROM extractions").get()!.accepted_bytes, 9025);
  reopened.close();
  // Rollback recovery is the untouched backup, not a lossy truncation of new rows.
  const backup = new DatabaseSync(join(root, "pre-upgrade.sqlite"), { readOnly: true });
  assert.deepEqual(backup.prepare("SELECT * FROM extractions").all(), before);
  assert.equal(backup.prepare("SELECT MAX(version) AS v FROM schema_migrations").get()!.v, 13);
  backup.close();
});

test("failed v13 expansion rolls back rows, triggers and migration marker", t => {
  const { root, db, before } = legacyStore(t);
  db.exec("CREATE TABLE extractions_native (collision TEXT)");
  db.close();
  assert.throws(() => openStateDb(root), /already exists/);
  const preserved = new DatabaseSync(join(root, "state.sqlite"));
  assert.deepEqual(preserved.prepare("SELECT * FROM extractions").all(), before);
  assert.equal(preserved.prepare("SELECT MAX(version) AS v FROM schema_migrations").get()!.v, 13);
  assert.ok(preserved.prepare("SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = 'generation_source_version'").get());
  preserved.exec("DROP TABLE extractions_native"); preserved.close();
  const retried = openStateDb(root);
  assert.deepEqual(retried.prepare("SELECT * FROM extractions").all(), before);
  retried.close();
});
