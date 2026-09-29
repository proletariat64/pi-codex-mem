import { DatabaseSync } from "node:sqlite";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, unlinkSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import type { WorkspaceIdentity } from "../identity.ts";

/**
 * State store (spec §12.2 — ticket #3 subset: schema_migrations, workspaces,
 * sessions, branch_heads, source_revisions). WAL + foreign keys + bounded
 * busy timeout + short transactions (§11.3). All timestamps are integer
 * UTC milliseconds.
 */

export interface SnapshotRecord {
  workspace: WorkspaceIdentity;
  session: {
    sessionKey: string;
    path: string;
    headerId: string;
    parentKey: string | null;
    branchId: string;
    mode: string;
  };
  revision: {
    sourceId: string;
    lineageKey: string;
    revisionHash: string;
    leafId: string;
    snapshotPath: string;
    snapshotHash: string;
    sourceTime: number;
  };
  capturedAt: number;
  revokedSourceIds?: string[];
  privacyTargets?: { entryId: string; allowedHashes: string; editId: string; editTime: number }[];
  privacyPolicyChanged?: boolean;
  evidenceRemoved?: boolean;
}

const SCHEMA_VERSION = 12;

const MIGRATION_1 = `
CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL
);
CREATE TABLE workspaces (
  workspace_key TEXT PRIMARY KEY,
  repo_key TEXT,
  checkout_key TEXT,
  cwd TEXT NOT NULL,
  git_branch TEXT,
  git_head TEXT,
  updated_at INTEGER NOT NULL
);
CREATE TABLE sessions (
  session_key TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  header_id TEXT NOT NULL,
  parent_key TEXT,
  workspace_key TEXT NOT NULL,
  enrolled_at INTEGER NOT NULL,
  active_branch_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  last_activity_at INTEGER NOT NULL,
  FOREIGN KEY (workspace_key) REFERENCES workspaces(workspace_key)
);
CREATE TABLE branch_heads (
  session_key TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  selected_leaf TEXT NOT NULL,
  latest_revision TEXT,
  state TEXT NOT NULL CHECK (state IN ('active', 'retired', 'suppressed')),
  PRIMARY KEY (session_key, branch_id),
  FOREIGN KEY (session_key) REFERENCES sessions(session_key)
);
CREATE TABLE source_revisions (
  source_id TEXT PRIMARY KEY,
  lineage_key TEXT NOT NULL,
  session_key TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  revision_hash TEXT NOT NULL,
  snapshot_path TEXT NOT NULL,
  snapshot_hash TEXT NOT NULL,
  leaf_id TEXT NOT NULL,
  source_time INTEGER NOT NULL,
  status TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  captured_at INTEGER NOT NULL,
  UNIQUE (session_key, branch_id, revision_hash),
  FOREIGN KEY (session_key, branch_id) REFERENCES branch_heads(session_key, branch_id)
);
`;

const MIGRATION_2 = `
CREATE TABLE store_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  control_epoch INTEGER NOT NULL
);
INSERT INTO store_state (singleton, control_epoch) VALUES (1, 0);
CREATE TABLE pipeline_state (
  memory_version TEXT PRIMARY KEY CHECK (memory_version IN ('v1', 'v2')),
  reconciled_epoch INTEGER NOT NULL DEFAULT 0,
  read_blocked INTEGER NOT NULL DEFAULT 0,
  block_reason TEXT
);
INSERT INTO pipeline_state (memory_version) VALUES ('v1'), ('v2');
`;

const MIGRATION_3 = `
CREATE TABLE privacy_edit_targets (
  entry_id TEXT PRIMARY KEY,
  allowed_hashes TEXT NOT NULL,
  applied_at INTEGER NOT NULL
);
`;

const MIGRATION_4 = `
ALTER TABLE privacy_edit_targets ADD COLUMN edit_id TEXT NOT NULL DEFAULT '';
ALTER TABLE privacy_edit_targets ADD COLUMN edit_time INTEGER NOT NULL DEFAULT 0;
`;

const MIGRATION_5 = `
CREATE TABLE jobs (
  job_id TEXT PRIMARY KEY,
  source_id TEXT REFERENCES source_revisions(source_id),
  memory_version TEXT NOT NULL CHECK (memory_version IN ('v1', 'v2')),
  kind TEXT NOT NULL CHECK (kind IN ('extract', 'consolidate')),
  work_key TEXT NOT NULL UNIQUE,
  prompt_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'leased', 'succeeded', 'no_output', 'retry_wait', 'blocked', 'cancelled', 'superseded')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  due_at INTEGER NOT NULL,
  owner TEXT,
  fence INTEGER NOT NULL DEFAULT 0,
  lease_expires_at INTEGER,
  error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (source_id, memory_version, kind, prompt_hash),
  CHECK ((kind = 'extract' AND source_id IS NOT NULL) OR
         (kind = 'consolidate' AND source_id IS NULL))
);
CREATE INDEX jobs_due ON jobs (status, due_at);
CREATE TABLE extractions (
  extraction_id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES source_revisions(source_id),
  memory_version TEXT NOT NULL CHECK (memory_version IN ('v1', 'v2')),
  prompt_hash TEXT NOT NULL,
  job_id TEXT NOT NULL REFERENCES jobs(job_id),
  raw_memory TEXT,
  rollout_summary TEXT NOT NULL,
  rollout_slug TEXT NOT NULL,
  model_provider TEXT NOT NULL,
  model_id TEXT NOT NULL,
  output_hash TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('succeeded', 'no_output')),
  usage_input INTEGER NOT NULL,
  usage_output INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (source_id, memory_version, prompt_hash),
  CHECK ((memory_version = 'v1' AND raw_memory IS NOT NULL) OR
         (memory_version = 'v2' AND raw_memory IS NULL))
);
CREATE TABLE process_activity (
  owner_id TEXT PRIMARY KEY,
  session_key TEXT NOT NULL,
  activity_state TEXT NOT NULL CHECK (activity_state IN ('active', 'idle')),
  expires_at INTEGER NOT NULL
);
CREATE INDEX process_activity_busy ON process_activity (session_key, activity_state, expires_at);
CREATE TABLE budget_usage (
  local_day TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  reserved_input INTEGER NOT NULL DEFAULT 0,
  reserved_output INTEGER NOT NULL DEFAULT 0,
  actual_input INTEGER NOT NULL DEFAULT 0,
  actual_output INTEGER NOT NULL DEFAULT 0,
  call_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (local_day, provider, model)
);
CREATE TABLE budget_reservations (
  reservation_id TEXT PRIMARY KEY,
  local_day TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  estimate_input INTEGER NOT NULL,
  estimate_output INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('reserved', 'charged')),
  actual_input INTEGER,
  actual_output INTEGER,
  FOREIGN KEY (local_day, provider, model) REFERENCES budget_usage(local_day, provider, model)
);
`;

const MIGRATION_6 = `ALTER TABLE jobs ADD COLUMN config_epoch TEXT NOT NULL DEFAULT '';`;

// Earlier releases may have deleted a revoked row while secure_delete was
// disabled. Its bytes can survive on a SQLite free page after the row is gone.
// A one-time upgrade VACUUM rebuilds from live rows to scrub that free space.
const MIGRATION_7 = `
CREATE TABLE privacy_scrub_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  legacy_vacuum_pending INTEGER NOT NULL CHECK (legacy_vacuum_pending IN (0, 1))
);
INSERT INTO privacy_scrub_state (singleton, legacy_vacuum_pending) VALUES (1, 1);
`;

const MIGRATION_8 = `
ALTER TABLE extractions ADD COLUMN truncated INTEGER NOT NULL DEFAULT 0 CHECK (truncated IN (0, 1));
ALTER TABLE extractions ADD COLUMN original_bytes INTEGER NOT NULL DEFAULT 0 CHECK (original_bytes >= 0);
ALTER TABLE extractions ADD COLUMN accepted_bytes INTEGER NOT NULL DEFAULT 0 CHECK (accepted_bytes BETWEEN 0 AND 9000);
`;

const MIGRATION_9 = `
CREATE TABLE IF NOT EXISTS source_stats (
  memory_version TEXT NOT NULL CHECK (memory_version IN ('v1', 'v2')),
  lineage_key TEXT NOT NULL,
  usage_count INTEGER NOT NULL DEFAULT 0 CHECK (usage_count >= 0),
  last_used_at INTEGER,
  retention_watermark INTEGER,
  PRIMARY KEY (memory_version, lineage_key)
);
CREATE TABLE IF NOT EXISTS memory_usage (
  memory_version TEXT NOT NULL CHECK (memory_version IN ('v1', 'v2')),
  consumer_session TEXT NOT NULL,
  run_id TEXT NOT NULL,
  source_id TEXT NOT NULL REFERENCES source_revisions(source_id),
  used_at INTEGER NOT NULL,
  PRIMARY KEY (memory_version, consumer_session, run_id, source_id)
);
CREATE TABLE IF NOT EXISTS notes (
  note_id TEXT PRIMARY KEY,
  action TEXT NOT NULL DEFAULT 'remember',
  text_path TEXT NOT NULL,
  text_hash TEXT NOT NULL,
  scope TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'superseded'))
);
CREATE TABLE IF NOT EXISTS generations (
  generation_id TEXT PRIMARY KEY,
  memory_version TEXT NOT NULL CHECK (memory_version IN ('v1', 'v2')),
  status TEXT NOT NULL CHECK (status IN ('published', 'revoked')),
  base_generation_id TEXT,
  input_hash TEXT NOT NULL,
  directory TEXT NOT NULL UNIQUE,
  manifest_hash TEXT NOT NULL,
  selection_hash TEXT NOT NULL,
  prompt_hash TEXT NOT NULL,
  control_epoch INTEGER NOT NULL,
  max_sources INTEGER NOT NULL,
  max_unused_days INTEGER NOT NULL,
  retention_deadline INTEGER,
  created_at INTEGER NOT NULL,
  published_at INTEGER NOT NULL,
  UNIQUE (generation_id, memory_version),
  FOREIGN KEY (base_generation_id, memory_version) REFERENCES generations(generation_id, memory_version)
);
CREATE TABLE IF NOT EXISTS generation_sources (
  generation_id TEXT NOT NULL REFERENCES generations(generation_id) ON DELETE CASCADE,
  extraction_id TEXT NOT NULL,
  source_id TEXT NOT NULL REFERENCES source_revisions(source_id),
  output_hash TEXT NOT NULL,
  PRIMARY KEY (generation_id, extraction_id)
);
CREATE TABLE IF NOT EXISTS note_applications (
  note_id TEXT NOT NULL REFERENCES notes(note_id),
  memory_version TEXT NOT NULL CHECK (memory_version IN ('v1', 'v2')),
  note_hash TEXT NOT NULL,
  generation_id TEXT NOT NULL,
  control_epoch INTEGER NOT NULL,
  PRIMARY KEY (note_id, memory_version),
  FOREIGN KEY (generation_id, memory_version) REFERENCES generations(generation_id, memory_version)
);
CREATE TRIGGER IF NOT EXISTS generation_source_version BEFORE INSERT ON generation_sources
WHEN NOT EXISTS (
  SELECT 1 FROM extractions e JOIN generations g ON g.generation_id = NEW.generation_id
  WHERE e.extraction_id = NEW.extraction_id AND e.memory_version = g.memory_version
    AND e.source_id = NEW.source_id AND e.output_hash = NEW.output_hash
)
BEGIN SELECT RAISE(ABORT, 'generation source version mismatch'); END;
CREATE TRIGGER IF NOT EXISTS generation_source_version_update BEFORE UPDATE ON generation_sources
BEGIN SELECT RAISE(ABORT, 'generation sources are immutable'); END;
CREATE TRIGGER IF NOT EXISTS pipeline_generation_version BEFORE UPDATE OF active_generation_id ON pipeline_state
WHEN NEW.active_generation_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM generations WHERE generation_id = NEW.active_generation_id
    AND memory_version = NEW.memory_version AND status = 'published'
)
BEGIN SELECT RAISE(ABORT, 'active generation version mismatch'); END;
`;

export function openStateDb(root: string, options?: { busyTimeoutMs?: number }): DatabaseSync {
  const busyTimeout = options?.busyTimeoutMs ?? 5_000;
  if (!Number.isSafeInteger(busyTimeout) || busyTimeout < 0 || busyTimeout > 5_000) {
    throw new Error("invalid SQLite busy timeout");
  }
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  const path = join(root, "state.sqlite");
  try {
    if (lstatSync(path).isSymbolicLink()) throw new Error("state.sqlite symlink rejected");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const db = new DatabaseSync(path);
  chmodSync(path, 0o600);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`PRAGMA busy_timeout = ${busyTimeout}`);
  // Privacy revocation must overwrite deleted payload cells, not only unlink
  // their logical rows. WAL is truncated after the removal commits below.
  db.exec("PRAGMA secure_delete = ON");
  const hasMigrations = db
    .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
    .get() as { n: number };
  let current = 0;
  if (hasMigrations.n > 0) {
    const row = db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as { v: number | null };
    current = row.v ?? 0;
  }
  if (current > SCHEMA_VERSION) {
    db.close();
    throw new Error(`state.sqlite schema ${current} is newer than supported ${SCHEMA_VERSION}`);
  }
  if (current < SCHEMA_VERSION) {
    db.exec("BEGIN");
    try {
      if (current < 1) {
        db.exec(MIGRATION_1);
        db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(1, Date.now());
      }
      if (current < 2) {
        db.exec(MIGRATION_2);
        db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(2, Date.now());
      }
      if (current < 3) {
        db.exec(MIGRATION_3);
        db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(3, Date.now());
      }
      if (current < 4) {
        db.exec(MIGRATION_4);
        db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(4, Date.now());
      }
      if (current < 5) {
        db.exec(MIGRATION_5);
        db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(5, Date.now());
      }
      if (current < 6) {
        db.exec(MIGRATION_6);
        db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(6, Date.now());
      }
      if (current < 7) {
        db.exec(MIGRATION_7);
        db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(7, Date.now());
      }
      if (current < 8) {
        db.exec(MIGRATION_8);
        db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(8, Date.now());
      }
      if (current < 9) {
        const columns = db.prepare("PRAGMA table_info(pipeline_state)").all() as { name: string }[];
        if (!columns.some(column => column.name === "active_generation_id")) {
          db.exec("ALTER TABLE pipeline_state ADD COLUMN active_generation_id TEXT");
        }
        db.exec(MIGRATION_9);
        db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(9, Date.now());
      }
      if (current < 10) {
        const columns = new Set((db.prepare("PRAGMA table_info(notes)").all() as { name: string }[]).map(column => column.name));
        for (const [name, definition] of [["consumer_session", "TEXT"], ["run_id", "TEXT"], ["user_message_id", "TEXT"],
          ["origin", "TEXT NOT NULL DEFAULT 'legacy' CHECK (origin IN ('legacy', 'command', 'tool'))"]]) {
          if (!columns.has(name!)) db.exec(`ALTER TABLE notes ADD COLUMN ${name} ${definition}`);
        }
        db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(10, Date.now());
      }
      if (current < 11) {
        db.exec(`CREATE TABLE IF NOT EXISTS suppression_tombstones (
          kind TEXT NOT NULL CHECK (kind IN ('lineage', 'session')), identity TEXT NOT NULL,
          created_at INTEGER NOT NULL, PRIMARY KEY (kind, identity))`);
        db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(11, Date.now());
      }
      if (current < 12) {
        const columns = new Set((db.prepare("PRAGMA table_info(jobs)").all() as { name: string }[]).map(column => column.name));
        for (const column of ["request_id", "scheduling_policy_hash"]) {
          if (!columns.has(column)) db.exec(`ALTER TABLE jobs ADD COLUMN ${column} TEXT`);
        }
        db.exec(`CREATE TABLE IF NOT EXISTS version_run_grants (request_id TEXT PRIMARY KEY,
          memory_version TEXT NOT NULL CHECK (memory_version IN ('v1', 'v2', 'both')), policy_hash TEXT NOT NULL,
          skip_idle INTEGER NOT NULL DEFAULT 0 CHECK (skip_idle IN (0, 1)),
          status TEXT NOT NULL CHECK (status IN ('active', 'completed', 'cancelled')), created_at INTEGER NOT NULL)`);
        db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(12, Date.now());
      }
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      db.close();
      throw err;
    }
  }
  try {
    prunePrivacyRevoked(db, root);
    sweepOrphanSnapshots(db, root);
    sweepUnindexedNotes(db, root);
    return db;
  } catch (err) {
    db.close();
    throw err;
  }
}

/** A crashed note writer/forget may leave an unindexed private file; active notes are never pruned. */
function sweepUnindexedNotes(db: DatabaseSync, root: string): void {
  const directory = join(root, "notes");
  if (!existsSync(directory)) return;
  if (lstatSync(directory).isSymbolicLink() || !lstatSync(directory).isDirectory()) throw new Error("notes symlink or special directory rejected");
  db.exec("BEGIN IMMEDIATE");
  try {
    const active = new Set((db.prepare("SELECT text_path FROM notes WHERE status = 'active'").all() as { text_path: string }[])
      .map(note => resolve(note.text_path)));
    for (const name of readdirSync(directory)) {
      if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.md$/.test(name)) continue;
      const path = join(directory, name);
      if (lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile()) throw new Error("unsafe note file rejected");
      if (!active.has(resolve(path))) unlinkSync(path);
    }
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}

/**
 * Crash after file creation but before SQLite commit leaves an unindexed
 * snapshot. Writers hold the same BEGIN IMMEDIATE lock through file+DB
 * publication, so this sweep cannot mistake an in-flight snapshot for an
 * orphan. Only extension-shaped filenames under non-symlink directories
 * are eligible for deletion.
 */
function sweepOrphanSnapshots(db: DatabaseSync, root: string): void {
  const sources = join(root, "sources");
  if (!existsSync(sources)) return;
  if (lstatSync(sources).isSymbolicLink()) throw new Error("sources symlink rejected during orphan sweep");
  db.exec("BEGIN IMMEDIATE");
  try {
    const paths = db.prepare("SELECT snapshot_path FROM source_revisions").all() as { snapshot_path: string }[];
    const indexed = new Set(paths.map((row) => {
      try { return realpathSync(row.snapshot_path); } catch { return resolve(row.snapshot_path); }
    }));
    for (const lineage of readdirSync(sources)) {
      if (!/^[a-f0-9]{64}$/.test(lineage)) continue;
      const dir = join(sources, lineage);
      if (lstatSync(dir).isSymbolicLink()) throw new Error("lineage symlink rejected during orphan sweep");
      if (!lstatSync(dir).isDirectory()) continue;
      for (const name of readdirSync(dir)) {
        const file = join(dir, name);
        if (/^\.snapshot-[a-f0-9]{24}\.tmp$/.test(name)) {
          unlinkSync(file); // interrupted atomic staging file
        } else if (/^[a-f0-9]{64}\.json$/.test(name)) {
          if (lstatSync(file).isSymbolicLink()) throw new Error("snapshot symlink rejected during orphan sweep");
          if (!indexed.has(realpathSync(file))) unlinkSync(file);
        }
      }
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/** Retry removal after a crash between DB revocation and filesystem cleanup. */
export function prunePrivacyRevoked(db: DatabaseSync, root: string): void {
  // Also purge derived text created before the current revocation policy.
  // Keep the source/job tombstone for provenance and failed late-write fences.
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`DELETE FROM extractions WHERE source_id IN
      (SELECT source_id FROM source_revisions WHERE status = 'privacy_revoked')`);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  const rows = db.prepare("SELECT snapshot_path FROM source_revisions WHERE status = 'privacy_revoked'")
    .all() as { snapshot_path: string }[];
  const legacy = db.prepare("SELECT legacy_vacuum_pending FROM privacy_scrub_state WHERE singleton = 1")
    .get() as { legacy_vacuum_pending: number };
  // Even without a surviving tombstone, a pre-secure-delete row may have
  // left plaintext in SQLite free space. Run the one-time upgrade VACUUM.
  if (rows.length === 0 && !legacy.legacy_vacuum_pending) return;
  const sourceDir = join(root, "sources");
  if (existsSync(sourceDir)) {
    if (lstatSync(sourceDir).isSymbolicLink()) throw new Error("sources symlink rejected during privacy cleanup");
    const sources = realpathSync(sourceDir);
    for (const row of rows) {
      const path = resolve(row.snapshot_path);
      if (!/^[a-f0-9]{64}\.json$/.test(path.split(sep).at(-1) ?? "")) {
        throw new Error(`invalid revoked snapshot filename: ${path}`);
      }
      try {
        // Resolve the parent to reject a symlink escaping the owned store.
        if (!realpathSync(dirname(path)).startsWith(sources + sep)) throw new Error("revoked snapshot parent escaped sources");
        unlinkSync(path);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
    }
  }
  if (legacy.legacy_vacuum_pending) {
    // secure_delete cannot erase already-freed cells from a previous release.
    // VACUUM copies only live rows into a new database image. Keep the marker
    // set on failure so a later startup retries before reporting cleanup.
    try {
      db.exec("VACUUM");
    } catch (err) {
      if (/locked|busy/i.test((err as Error).message)) {
        throw new Error("privacy WAL cleanup deferred: active SQLite reader", { cause: err });
      }
      throw err;
    }
  }
  // Secure-delete rewrites live database pages; old WAL frames may still
  // contain the superseded extraction. Do not report privacy cleanup as
  // complete while any reader prevents truncation. Startup retries cleanup.
  const checkpoint = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as
    { busy: number; log: number; checkpointed: number } | undefined;
  if (!checkpoint || checkpoint.busy !== 0) throw new Error("privacy WAL cleanup deferred: active SQLite reader");
  // Do not clear the upgrade marker until the old main DB AND WAL are gone.
  // A busy reader can delay truncation even after VACUUM succeeded.
  if (legacy.legacy_vacuum_pending) {
    db.prepare("UPDATE privacy_scrub_state SET legacy_vacuum_pending = 0 WHERE singleton = 1").run();
  }
}

function blockBothViews(db: DatabaseSync, reason: string): void {
  db.exec("UPDATE store_state SET control_epoch = control_epoch + 1 WHERE singleton = 1");
  db.prepare("UPDATE pipeline_state SET read_blocked = 1, block_reason = ?")
    .run(reason);
}

/** On resume, an active branch whose leaf advanced has not been recaptured. */
export function blockUncapturedLeaf(db: DatabaseSync, sessionKey: string, leafId: string | null): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    const heads = db.prepare(
      "SELECT latest_revision FROM branch_heads WHERE session_key = ? AND state = 'active' AND selected_leaf != ?",
    ).all(sessionKey, leafId ?? "") as { latest_revision: string | null }[];
    let changed = 0;
    for (const head of heads) {
      if (!head.latest_revision) continue;
      changed += Number(db.prepare("UPDATE source_revisions SET status = 'superseded' WHERE source_id = ? AND status = 'captured'")
        .run(head.latest_revision).changes);
    }
    if (changed > 0) blockBothViews(db, "uncaptured_branch_leaf");
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/** Transactionally record a captured snapshot (R01). Idempotent per revision. */
export function recordSnapshot(db: DatabaseSync, rec: SnapshotRecord, root?: string, transactionOwned = false): void {
  if (rec.revokedSourceIds?.length && !root) throw new Error("privacy revocation requires the owned memory root");
  if (!transactionOwned) db.exec("BEGIN IMMEDIATE");
  try {
    if (sourceSuppressed(db, rec.session.sessionKey, rec.revision.lineageKey)) throw new Error("source_suppressed");
    db.prepare(
      `INSERT INTO workspaces (workspace_key, repo_key, checkout_key, cwd, git_branch, git_head, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (workspace_key) DO UPDATE SET
         repo_key = excluded.repo_key, checkout_key = excluded.checkout_key,
         cwd = excluded.cwd, git_branch = excluded.git_branch,
         git_head = excluded.git_head, updated_at = excluded.updated_at`,
    ).run(
      rec.workspace.workspaceKey,
      rec.workspace.repoKey,
      rec.workspace.checkoutKey,
      rec.workspace.cwdReal,
      rec.workspace.gitBranch,
      rec.workspace.gitHead,
      rec.capturedAt,
    );

    db.prepare(
      `INSERT INTO sessions (session_key, path, header_id, parent_key, workspace_key, enrolled_at, active_branch_id, mode, last_activity_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (session_key) DO UPDATE SET
         active_branch_id = excluded.active_branch_id,
         mode = excluded.mode,
         last_activity_at = excluded.last_activity_at`,
    ).run(
      rec.session.sessionKey,
      rec.session.path,
      rec.session.headerId,
      rec.session.parentKey,
      rec.workspace.workspaceKey,
      rec.capturedAt,
      rec.session.branchId,
      rec.session.mode,
      rec.capturedAt,
    );

    db.prepare(
      `INSERT INTO branch_heads (session_key, branch_id, selected_leaf, latest_revision, state)
       VALUES (?, ?, ?, ?, 'active')
       ON CONFLICT (session_key, branch_id) DO UPDATE SET
         selected_leaf = excluded.selected_leaf,
         latest_revision = excluded.latest_revision,
         state = 'active'`,
    ).run(rec.session.sessionKey, rec.session.branchId, rec.revision.leafId, rec.revision.sourceId);

    db.prepare(
      `INSERT OR IGNORE INTO source_revisions
         (source_id, lineage_key, session_key, branch_id, revision_hash, snapshot_path,
          snapshot_hash, leaf_id, source_time, status, policy_version, captured_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'captured', ?, ?)`,
    ).run(
      rec.revision.sourceId,
      rec.revision.lineageKey,
      rec.session.sessionKey,
      rec.session.branchId,
      rec.revision.revisionHash,
      rec.revision.snapshotPath,
      rec.revision.snapshotHash,
      rec.revision.leafId,
      rec.revision.sourceTime,
      "norm-1",
      rec.capturedAt,
    );
    // Only the selected branch and its latest projection remain eligible.
    // A branch switch without a session_tree event must also revoke reads.
    const retired = db.prepare(
      "UPDATE branch_heads SET state = 'retired' WHERE session_key = ? AND branch_id != ? AND state = 'active'",
    ).run(rec.session.sessionKey, rec.session.branchId);
    if (retired.changes > 0) blockBothViews(db, "branch_switch");
    db.prepare(
      "UPDATE source_revisions SET status = 'superseded' WHERE session_key = ? AND source_id != ? AND status = 'captured'",
    ).run(rec.session.sessionKey, rec.revision.sourceId);
    // Re-selecting an identical historic leaf must restore its eligibility
    // unless its content was privacy-revoked (a removed statement cannot be
    // brought back by branch reactivation).
    db.prepare("UPDATE source_revisions SET status = 'captured' WHERE source_id = ? AND status != 'privacy_revoked'")
      .run(rec.revision.sourceId);
    for (const target of rec.privacyTargets ?? []) {
      db.prepare(
        `INSERT INTO privacy_edit_targets (entry_id, allowed_hashes, applied_at, edit_id, edit_time)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (entry_id) DO UPDATE SET
           allowed_hashes = excluded.allowed_hashes, applied_at = excluded.applied_at,
           edit_id = excluded.edit_id, edit_time = excluded.edit_time`,
      ).run(target.entryId, target.allowedHashes, rec.capturedAt, target.editId, target.editTime);
    }
    for (const sourceId of rec.revokedSourceIds ?? []) {
      db.prepare("UPDATE source_revisions SET status = 'privacy_revoked' WHERE source_id = ? AND source_id != ?")
        .run(sourceId, rec.revision.sourceId);
      db.prepare("DELETE FROM extractions WHERE source_id = ? AND source_id != ?")
        .run(sourceId, rec.revision.sourceId);
    }
    if (rec.revokedSourceIds?.length || rec.evidenceRemoved || rec.privacyPolicyChanged) {
      blockBothViews(db, rec.revokedSourceIds?.length || rec.privacyPolicyChanged ? "context_edit" : "evidence_removed");
    }

    if (!transactionOwned) db.exec("COMMIT");
  } catch (err) {
    if (!transactionOwned) db.exec("ROLLBACK");
    throw err;
  }
  // An external owner performs post-commit cleanup after its own COMMIT.
  if (!transactionOwned && rec.revokedSourceIds?.length) prunePrivacyRevoked(db, root!);
}

/** Explicit forget applies to future revisions and, for sessions, future branches. */
export function sourceSuppressed(db: DatabaseSync, sessionKey: string, lineageKey: string): boolean {
  return !!db.prepare(`SELECT 1 FROM suppression_tombstones
    WHERE (kind = 'session' AND identity = ?) OR (kind = 'lineage' AND identity = ?) LIMIT 1`).get(sessionKey, lineageKey);
}

/** §5.3: on session_tree, retire every head except the active one. */
export function retireOtherHeads(db: DatabaseSync, sessionKey: string, activeBranchId: string): void {
  db.exec("BEGIN");
  try {
    db.prepare(
      "UPDATE branch_heads SET state = 'retired' WHERE session_key = ? AND branch_id != ? AND state = 'active'",
    ).run(sessionKey, activeBranchId);
    // Retired heads must not supply current decisions to either pipeline.
    db.prepare(
      `UPDATE source_revisions SET status = 'superseded'
       WHERE session_key = ? AND branch_id != ? AND status = 'captured'`,
    ).run(sessionKey, activeBranchId);
    if (db.prepare("SELECT changes() AS n").get()?.n) blockBothViews(db, "session_tree");
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
