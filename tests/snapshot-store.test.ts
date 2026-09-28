import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStateDb, recordSnapshot, retireOtherHeads, type SnapshotRecord } from "../src/store/db.ts";
import { writeSnapshotFile } from "../src/store/snapshot-files.ts";
import type { WorkspaceIdentity } from "../src/identity.ts";

function makeRoot(t: test.TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-memory-store-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const WS: WorkspaceIdentity = {
  workspaceKey: "w".repeat(64),
  repoKey: "r".repeat(64),
  checkoutKey: "c".repeat(64),
  cwdReal: "/repo",
  gitCommonDir: "/repo/.git",
  gitTopLevel: "/repo",
  gitBranch: "main",
  gitHead: "h".repeat(40),
};

function rec(overrides?: Partial<SnapshotRecord>): SnapshotRecord {
  return {
    workspace: WS,
    session: {
      sessionKey: "s".repeat(64),
      path: "/agent/sessions/x.jsonl",
      headerId: "sess-1",
      parentKey: null,
      branchId: "br-1",
      mode: "tui",
    },
    revision: {
      sourceId: "src-1",
      lineageKey: "l".repeat(64),
      revisionHash: "v".repeat(64),
      leafId: "leaf-1",
      snapshotPath: "sources/" + "l".repeat(64) + "/" + "v".repeat(64) + ".json",
      snapshotHash: "f".repeat(64),
      sourceTime: 1_700_000_000_000,
    },
    capturedAt: 1_700_000_001_000,
    ...overrides,
  };
}

// Spec §12.1: snapshot files at sources/<lineage-key>/<revision>.json, 0600, immutable.

test("writeSnapshotFile writes sources/<lineage>/<revision>.json with mode 0600", (t) => {
  const root = makeRoot(t);
  const { path, hash } = writeSnapshotFile(root, "l".repeat(64), "v".repeat(64), { hello: "world" });
  assert.equal(path, join(root, "sources", "l".repeat(64), "v".repeat(64) + ".json"));
  assert.equal(JSON.parse(readFileSync(path, "utf8")).hello, "world");
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(statSync(join(root, "sources", "l".repeat(64))).mode & 0o777, 0o700);
});

test("snapshot files are immutable: same content ok, different content rejected (§7.1)", (t) => {
  const root = makeRoot(t);
  writeSnapshotFile(root, "l".repeat(64), "v".repeat(64), { a: 1 });
  writeSnapshotFile(root, "l".repeat(64), "v".repeat(64), { a: 1 }); // idempotent
  assert.throws(() => writeSnapshotFile(root, "l".repeat(64), "v".repeat(64), { a: 2 }), /immutable|exists/i);
});

// Spec §12.2 + issue #3 R01: sessions / branch_heads / source_revisions rows.

test("recordSnapshot writes workspaces/sessions/branch_heads/source_revisions rows (R01)", (t) => {
  const root = makeRoot(t);
  const db = openStateDb(root);
  t.after(() => db.close());
  recordSnapshot(db, rec());

  const ws = db.prepare("SELECT * FROM workspaces WHERE workspace_key = ?").all(WS.workspaceKey) as Record<string, unknown>[];
  assert.equal(ws.length, 1);
  assert.equal(ws[0]!.repo_key, WS.repoKey);

  const sessions = db.prepare("SELECT * FROM sessions WHERE session_key = ?").all(rec().session.sessionKey) as Record<string, unknown>[];
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0]!.header_id, "sess-1");
  assert.equal(sessions[0]!.active_branch_id, "br-1");

  const heads = db.prepare("SELECT * FROM branch_heads WHERE session_key = ?").all(rec().session.sessionKey) as Record<string, unknown>[];
  assert.equal(heads.length, 1);
  assert.equal(heads[0]!.state, "active");
  assert.equal(heads[0]!.latest_revision, "src-1");

  const revs = db.prepare("SELECT * FROM source_revisions WHERE source_id = ?").all("src-1") as Record<string, unknown>[];
  assert.equal(revs.length, 1);
  assert.equal(revs[0]!.status, "captured");
  assert.equal(revs[0]!.revision_hash, "v".repeat(64));
});

test("a second snapshot on the same branch adds a revision and moves the head", (t) => {
  const root = makeRoot(t);
  const db = openStateDb(root);
  t.after(() => db.close());
  recordSnapshot(db, rec());
  recordSnapshot(
    db,
    rec({
      revision: { ...rec().revision, sourceId: "src-2", revisionHash: "w".repeat(64), leafId: "leaf-2" },
    }),
  );
  const revs = db.prepare("SELECT COUNT(*) AS n FROM source_revisions WHERE session_key = ?").get(rec().session.sessionKey) as { n: number };
  assert.equal(revs.n, 2);
  const head = db.prepare("SELECT latest_revision FROM branch_heads WHERE session_key = ? AND branch_id = ?").get(rec().session.sessionKey, "br-1") as { latest_revision: string };
  assert.equal(head.latest_revision, "src-2");
});

test("re-recording the same revision is idempotent (§11.3)", (t) => {
  const root = makeRoot(t);
  const db = openStateDb(root);
  t.after(() => db.close());
  recordSnapshot(db, rec());
  recordSnapshot(db, rec());
  const revs = db.prepare("SELECT COUNT(*) AS n FROM source_revisions").get() as { n: number };
  assert.equal(revs.n, 1);
});

test("session_tree retires other heads for the session (§5.3, T08)", (t) => {
  const root = makeRoot(t);
  const db = openStateDb(root);
  t.after(() => db.close());
  recordSnapshot(db, rec());
  recordSnapshot(
    db,
    rec({
      session: { ...rec().session, branchId: "br-2" },
      revision: { ...rec().revision, sourceId: "src-9", lineageKey: "m".repeat(64), revisionHash: "x".repeat(64) },
    }),
  );
  retireOtherHeads(db, rec().session.sessionKey, "br-2");
  const states = db.prepare("SELECT branch_id, state FROM branch_heads ORDER BY branch_id").all() as { branch_id: string; state: string }[];
  const br1 = states.find((r) => r.branch_id === "br-1");
  const br2 = states.find((r) => r.branch_id === "br-2");
  assert.equal(br1?.state, "retired");
  assert.equal(br2?.state, "active");
});
