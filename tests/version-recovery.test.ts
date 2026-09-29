import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStateDb } from "../src/store/db.ts";
import { captureSettledSession } from "../src/capture.ts";
import { defaultConfig } from "../src/config.ts";
import { enqueueActiveExtractions } from "../src/extraction/scheduler.ts";
import { recoverEnrolledSnapshots } from "../src/control/switch.ts";

function fixture(t: test.TestContext) {
  const base = mkdtempSync(join(tmpdir(), "pi-recover-version-")); const cwd = join(base, "repo"); mkdirSync(cwd);
  execFileSync("git", ["init", "-q"], { cwd });
  const agentDir = join(base, "agent"); const root = join(agentDir, "memory"); const db = openStateDb(root);
  t.after(() => { db.close(); rmSync(base, { recursive: true, force: true }); });
  const file = join(base, "session.jsonl"); const header = { type: "session", version: 3, id: "source", cwd, timestamp: new Date().toISOString() };
  const entry = { type: "message", id: "u1", parentId: null, timestamp: new Date().toISOString(),
    message: { role: "user", content: [{ type: "text", text: "Original TypeScript decision" }], timestamp: Date.now() } };
  const original = [header, entry].map(value => JSON.stringify(value)).join("\n") + "\n"; writeFileSync(file, original);
  const captured = captureSettledSession({ root, agentDir, cwd, db, mode: "tui", reader: {
    getBranch: () => [entry] as never, getHeader: () => header as never, getSessionFile: () => file, getLeafId: () => "u1" } });
  assert.equal(captured.status, "captured");
  const config = defaultConfig("UTC"); config.version = "v2";
  return { root, db, file, original, captured, config, cwd, agentDir, header, entry };
}
test("T34 cross: newly enabled v2 reconstructs pruned enrolled snapshots from original JSONL read-only", (t) => {
  const f = fixture(t); unlinkSync(f.captured.snapshotPath);
  const report = recoverEnrolledSnapshots({ root: f.root, db: f.db, config: f.config, now: Date.now() });
  assert.equal(report.recovered, 1); assert.deepEqual(report.unavailable, []);
  assert.equal(existsSync(f.captured.snapshotPath), true);
  assert.match(readFileSync(f.captured.snapshotPath, "utf8"), /Original TypeScript decision/);
  assert.equal(readFileSync(f.file, "utf8"), f.original);
  enqueueActiveExtractions(f.db, Date.now(), f.config, f.root);
  assert.equal(f.db.prepare("SELECT memory_version FROM jobs WHERE kind = 'extract'").get()!.memory_version, "v2");
});

test("snapshot reconstruction does not reenroll a replaced session or an excluded workspace", (t) => {
  const f = fixture(t); unlinkSync(f.captured.snapshotPath);
  writeFileSync(f.file, f.original.replace('"id":"source"', '"id":"replacement"'));
  enqueueActiveExtractions(f.db, Date.now(), f.config, f.root);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM sessions").get()!.n, 1);
  assert.equal(existsSync(f.captured.snapshotPath), false);
  assert.equal(f.db.prepare("SELECT error_code FROM jobs WHERE memory_version = 'v2'").get()!.error_code, "source_unavailable_for_version");
  writeFileSync(f.file, f.original); f.config.excludedWorkspaces = [f.cwd];
  enqueueActiveExtractions(f.db, Date.now(), f.config, f.root);
  assert.equal(existsSync(f.captured.snapshotPath), false);
});

test("intact earlier snapshots do not starve recovery of an enrolled source beyond the first 256", (t) => {
  const f = fixture(t);
  for (let index = 0; index < 256; index++) {
    const header = { ...f.header, id: `enrolled-${index}` }; const file = join(f.cwd, `session-${index}.jsonl`);
    writeFileSync(file, [header, f.entry].map(value => JSON.stringify(value)).join("\n") + "\n");
    assert.equal(captureSettledSession({ root: f.root, agentDir: f.agentDir, cwd: f.cwd, db: f.db, mode: "tui",
      reader: { getHeader: () => header as never, getBranch: () => [f.entry] as never,
        getSessionFile: () => file, getLeafId: () => "u1" } }).status, "captured");
  }
  const last = f.db.prepare("SELECT snapshot_path FROM source_revisions ORDER BY source_id DESC LIMIT 1").get()!;
  unlinkSync(String(last.snapshot_path));
  assert.equal(recoverEnrolledSnapshots({ root: f.root, db: f.db, config: f.config, now: Date.now() }).recovered, 1);
  assert.equal(existsSync(String(last.snapshot_path)), true);
});
test("missing snapshots and original evidence block the target version without forgetting or reading other-version output", (t) => {
  const f = fixture(t); unlinkSync(f.captured.snapshotPath); unlinkSync(f.file);
  enqueueActiveExtractions(f.db, Date.now(), f.config, f.root);
  assert.deepEqual({ ...f.db.prepare("SELECT status, error_code FROM jobs WHERE memory_version = 'v2'").get() },
    { status: "blocked", error_code: "source_unavailable_for_version" });
  assert.equal(f.db.prepare("SELECT status FROM source_revisions WHERE source_id = ?").get(f.captured.sourceId)!.status, "captured");
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM suppression_tombstones").get()!.n, 0);
  writeFileSync(f.file, f.original);
  enqueueActiveExtractions(f.db, Date.now(), f.config, f.root);
  assert.equal(f.db.prepare("SELECT status FROM jobs WHERE memory_version = 'v2'").get()!.status, "queued");
});

test("reconstruction captures changed enrolled evidence as a new revision without relabelling the old source", (t) => {
  const f = fixture(t); unlinkSync(f.captured.snapshotPath);
  const changed = f.original.replace("Original TypeScript decision", "Revised TypeScript decision"); writeFileSync(f.file, changed);
  enqueueActiveExtractions(f.db, Date.now(), f.config, f.root);
  const active = f.db.prepare("SELECT latest_revision FROM branch_heads WHERE state = 'active'").get()!;
  assert.equal(typeof active.latest_revision, "string");
  assert.notEqual(active.latest_revision, f.captured.sourceId);
  const source = f.db.prepare("SELECT snapshot_path FROM source_revisions WHERE source_id = ?").get(String(active.latest_revision))!;
  assert.match(readFileSync(String(source.snapshot_path), "utf8"), /Revised TypeScript decision/);
  assert.equal(readFileSync(f.file, "utf8"), changed);
  assert.equal(f.db.prepare("SELECT source_id FROM jobs WHERE memory_version = 'v2'").get()!.source_id, active.latest_revision);
});
