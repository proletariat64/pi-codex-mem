import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { MemoryVersion } from "../config.ts";

const DAY_MS = 86_400_000;
const LEASE_MS = 180_000;

export interface SelectedExtraction {
  extractionId: string; sourceId: string; lineageKey: string; sessionKey: string;
  workspaceKey: string; cwd: string; sourceUpdatedAt: number; outputHash: string;
  rolloutSummary: string; rolloutSlug: string; rawMemory: string | null;
}
export interface ActiveNote { noteId: string; textPath: string; textHash: string; scope: string; action?: string; createdAt?: number }
export interface ConsolidationSnapshot {
  memoryVersion: MemoryVersion; baseGenerationId: string | null; controlEpoch: number;
  sources: SelectedExtraction[]; notes: ActiveNote[]; selectionHash: string;
  retentionDeadline: number | null; maxSources: number; maxUnusedDays: number;
}
export interface ConsolidationLease {
  jobId: string; memoryVersion: MemoryVersion; owner: string; fence: number;
  promptHash: string; leaseExpiresAt: number;
}

/** Claim one consolidator across both namespaces; a blocked configuration requires a change. */
export function claimConsolidation(db: DatabaseSync, opts: {
  memoryVersion: MemoryVersion; owner: string; now: number; promptHash: string; configEpoch?: string;
  inputRevisionHash?: string; retryBlocked?: boolean;
}): ConsolidationLease | null {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(`UPDATE jobs SET status = CASE WHEN attempt_count >= 3 THEN 'blocked' ELSE 'queued' END,
      error_code = CASE WHEN attempt_count >= 3 THEN 'max_attempts' ELSE error_code END,
      owner = NULL, lease_expires_at = NULL, updated_at = ?
      WHERE kind = 'consolidate' AND status = 'leased' AND lease_expires_at <= ?`).run(opts.now, opts.now);
    if (db.prepare("SELECT 1 FROM jobs WHERE kind = 'consolidate' AND status = 'leased' AND lease_expires_at > ?").get(opts.now)) {
      db.exec("COMMIT"); return null;
    }
    const workKey = JSON.stringify(["consolidate", opts.memoryVersion, opts.promptHash, opts.inputRevisionHash ?? ""]);
    db.prepare(`UPDATE jobs SET status = 'superseded', owner = NULL, lease_expires_at = NULL,
      updated_at = ? WHERE kind = 'consolidate' AND memory_version = ? AND work_key != ?
      AND status IN ('queued', 'retry_wait', 'cancelled')`)
      .run(opts.now, opts.memoryVersion, workKey);
    const configEpoch = opts.configEpoch ?? "";
    const authGate = `kind = 'consolidate' AND memory_version = ? AND prompt_hash = ? AND config_epoch = ?
      AND status = 'blocked' AND error_code IN ('auth_or_model', 'model_not_found', 'model_not_configured')`;
    if (opts.retryBlocked) {
      // Clear historic gates after an explicit retry, keeping the current job
      // for its fenced reset below. A later automatic selection may then run.
      db.prepare(`UPDATE jobs SET status = 'superseded', updated_at = ? WHERE ${authGate} AND work_key != ?`)
        .run(opts.now, opts.memoryVersion, opts.promptHash, configEpoch, workKey);
    } else if (db.prepare(`SELECT 1 FROM jobs WHERE ${authGate} LIMIT 1`)
      .get(opts.memoryVersion, opts.promptHash, configEpoch)) {
      db.exec("COMMIT"); return null;
    }
    const retry = opts.retryBlocked ? 1 : 0;
    db.prepare(`INSERT INTO jobs (job_id, memory_version, kind, work_key, prompt_hash, config_epoch,
      status, due_at, created_at, updated_at) VALUES (?, ?, 'consolidate', ?, ?, ?, 'queued', ?, ?, ?)
      ON CONFLICT(work_key) DO UPDATE SET status = 'queued', config_epoch = excluded.config_epoch,
        due_at = excluded.due_at, error_code = NULL,
        attempt_count = CASE WHEN jobs.config_epoch != excluded.config_epoch OR ? = 1 THEN 0 ELSE jobs.attempt_count END,
        updated_at = excluded.updated_at
      WHERE jobs.status IN ('succeeded', 'superseded', 'cancelled')
        OR (jobs.status != 'leased' AND (jobs.config_epoch != excluded.config_epoch OR ? = 1))`)
      .run(randomUUID(), opts.memoryVersion, workKey, opts.promptHash, configEpoch, opts.now, opts.now, opts.now, retry, retry);
    const row = db.prepare(`SELECT job_id AS jobId, fence FROM jobs WHERE work_key = ?
      AND status IN ('queued', 'retry_wait') AND due_at <= ? AND attempt_count < 3`)
      .get(workKey, opts.now) as { jobId: string; fence: number } | undefined;
    if (!row) { db.exec("COMMIT"); return null; }
    const leaseExpiresAt = opts.now + LEASE_MS;
    db.prepare(`UPDATE jobs SET status = 'leased', owner = ?, fence = fence + 1,
      attempt_count = attempt_count + 1, lease_expires_at = ?, updated_at = ? WHERE job_id = ?`)
      .run(opts.owner, leaseExpiresAt, opts.now, row.jobId);
    db.exec("COMMIT");
    return { jobId: row.jobId, memoryVersion: opts.memoryVersion, owner: opts.owner,
      fence: row.fence + 1, promptHash: opts.promptHash, leaseExpiresAt };
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}

export function renewConsolidationLease(db: DatabaseSync, lease: ConsolidationLease, now: number): boolean {
  return db.prepare(`UPDATE jobs SET lease_expires_at = ?, updated_at = ? WHERE job_id = ?
    AND kind = 'consolidate' AND memory_version = ? AND prompt_hash = ? AND status = 'leased'
    AND owner = ? AND fence = ? AND lease_expires_at > ?`)
    .run(now + LEASE_MS, now, lease.jobId, lease.memoryVersion, lease.promptHash, lease.owner, lease.fence, now).changes === 1;
}

export function finishConsolidation(db: DatabaseSync, lease: ConsolidationLease,
  status: "succeeded" | "blocked" | "retry_wait" | "cancelled" | "superseded",
  errorCode: string | null, now: number, dueAt = now, options?: { refundAttempt?: boolean }): boolean {
  const refund = options?.refundAttempt ? 1 : 0;
  return db.prepare(`UPDATE jobs SET
    status = CASE WHEN ? = 'retry_wait' AND ? = 'provider_error' AND attempt_count - ? >= 3 THEN 'blocked' ELSE ? END,
    error_code = CASE WHEN ? = 'retry_wait' AND ? = 'provider_error' AND attempt_count - ? >= 3 THEN 'max_attempts' ELSE ? END,
    attempt_count = MAX(0, attempt_count - ?), due_at = ?, owner = NULL,
    lease_expires_at = NULL, updated_at = ? WHERE job_id = ? AND kind = 'consolidate'
    AND memory_version = ? AND prompt_hash = ? AND status = 'leased' AND owner = ? AND fence = ?
    AND lease_expires_at > ?`)
    .run(status, errorCode, refund, status, status, errorCode, refund, errorCode, refund,
      dueAt, now, lease.jobId, lease.memoryVersion, lease.promptHash, lease.owner, lease.fence, now).changes === 1;
}

/** Snapshot content and provenance in one SQLite view. */
export function selectConsolidation(db: DatabaseSync, opts: {
  memoryVersion: MemoryVersion; now: number; maxSources?: number; maxUnusedDays?: number;
}, transactionOwned = false): ConsolidationSnapshot {
  if (transactionOwned) return selectSnapshot(db, opts);
  db.exec("BEGIN");
  try {
    const snapshot = selectSnapshot(db, opts);
    db.exec("COMMIT"); return snapshot;
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}

function selectSnapshot(db: DatabaseSync, opts: {
  memoryVersion: MemoryVersion; now: number; maxSources?: number; maxUnusedDays?: number;
}): ConsolidationSnapshot {
  const maxSources = opts.maxSources ?? 256;
  const maxUnusedDays = opts.maxUnusedDays ?? 30;
  if (!Number.isSafeInteger(maxSources) || maxSources < 0 || maxSources > 256 ||
      !Number.isSafeInteger(maxUnusedDays) || maxUnusedDays < 1 || maxUnusedDays > 3650) {
    throw new Error("invalid consolidation selection limits");
  }
  const sources = db.prepare(`SELECT * FROM (
    SELECT e.extraction_id AS extractionId, r.source_id AS sourceId, r.lineage_key AS lineageKey,
      r.session_key AS sessionKey, s.workspace_key AS workspaceKey, w.cwd,
      r.source_time AS sourceUpdatedAt, e.output_hash AS outputHash,
      e.rollout_summary AS rolloutSummary, e.rollout_slug AS rolloutSlug, e.raw_memory AS rawMemory,
      e.outcome,
      COALESCE(st.usage_count, 0) AS usageCount, COALESCE(st.last_used_at, r.source_time) AS eligibilityTime,
      ROW_NUMBER() OVER (PARTITION BY r.lineage_key ORDER BY e.created_at DESC, e.extraction_id) AS rank
    FROM extractions e JOIN source_revisions r ON r.source_id = e.source_id
    JOIN branch_heads h ON h.session_key = r.session_key AND h.branch_id = r.branch_id
    JOIN sessions s ON s.session_key = r.session_key JOIN workspaces w ON w.workspace_key = s.workspace_key
    LEFT JOIN source_stats st ON st.memory_version = e.memory_version AND st.lineage_key = r.lineage_key
    WHERE e.memory_version = ? AND r.status = 'captured'
      AND h.state = 'active' AND h.latest_revision = r.source_id
  ) WHERE rank = 1 AND outcome = 'succeeded' AND eligibilityTime >= ?
    ORDER BY usageCount DESC, eligibilityTime DESC, sourceId LIMIT ?`)
    .all(opts.memoryVersion, opts.now - maxUnusedDays * DAY_MS, maxSources) as unknown as
    (SelectedExtraction & { usageCount: number; eligibilityTime: number; rank: number; outcome: string })[];
  const notes = db.prepare(`SELECT note_id AS noteId, text_path AS textPath, text_hash AS textHash, scope, action, created_at AS createdAt
    FROM notes WHERE status = 'active' ORDER BY note_id`).all() as unknown as ActiveNote[];
  const state = db.prepare(`SELECT p.active_generation_id AS baseGenerationId, s.control_epoch AS controlEpoch
    FROM pipeline_state p CROSS JOIN store_state s WHERE p.memory_version = ? AND s.singleton = 1`)
    .get(opts.memoryVersion) as { baseGenerationId: string | null; controlEpoch: number };
  const retentionDeadline = sources.length ? Math.min(...sources.map(s => s.eligibilityTime + maxUnusedDays * DAY_MS + 1)) : null;
  const selected = sources.map(({ usageCount: _usage, eligibilityTime: _time, rank: _rank, outcome: _outcome, ...source }) => source);
  const selectionHash = createHash("sha256").update(JSON.stringify({ memoryVersion: opts.memoryVersion,
    maxUnusedDays,
    sources: [...selected].sort((a, b) => a.sourceId.localeCompare(b.sourceId)).map(s =>
      [s.sourceId, s.extractionId, s.outputHash, s.lineageKey, s.sessionKey, s.workspaceKey, s.cwd, s.sourceUpdatedAt]),
    notes: notes.map(n => [n.noteId, n.textHash, n.scope, n.textPath, n.action, n.createdAt]) })).digest("hex");
  return { ...state, memoryVersion: opts.memoryVersion, sources: selected, notes,
    selectionHash, retentionDeadline, maxSources, maxUnusedDays };
}

export interface GenerationCommit {
  generationId: string; memoryVersion: MemoryVersion; directory: string;
  inputHash: string; manifestHash: string;
}

/** The sole publication pointer moves only after every guard passes under the write lock. */
export function commitGeneration(db: DatabaseSync, opts: {
  lease: ConsolidationLease; snapshot: ConsolidationSnapshot; generation: GenerationCommit; now: number;
}): boolean {
  const { lease, snapshot, generation, now } = opts;
  if (generation.memoryVersion !== lease.memoryVersion || snapshot.memoryVersion !== lease.memoryVersion) return false;
  db.exec("BEGIN IMMEDIATE");
  try {
    const owned = db.prepare(`SELECT 1 FROM jobs WHERE job_id = ? AND kind = 'consolidate'
      AND memory_version = ? AND prompt_hash = ? AND status = 'leased' AND owner = ? AND fence = ?
      AND lease_expires_at > ?`).get(lease.jobId, lease.memoryVersion, lease.promptHash, lease.owner, lease.fence, now);
    const current = selectConsolidation(db, { memoryVersion: snapshot.memoryVersion, now,
      maxSources: snapshot.maxSources, maxUnusedDays: snapshot.maxUnusedDays }, true);
    if (!owned || current.controlEpoch !== snapshot.controlEpoch ||
        current.baseGenerationId !== snapshot.baseGenerationId || current.selectionHash !== snapshot.selectionHash) {
      db.exec("COMMIT"); return false;
    }
    db.prepare(`INSERT INTO generations (generation_id, memory_version, status, base_generation_id,
      input_hash, directory, manifest_hash, selection_hash, prompt_hash, control_epoch,
      max_sources, max_unused_days, retention_deadline, created_at, published_at)
      VALUES (?, ?, 'published', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(generation.generationId, generation.memoryVersion, snapshot.baseGenerationId,
        generation.inputHash, generation.directory, generation.manifestHash, snapshot.selectionHash,
        lease.promptHash, snapshot.controlEpoch, snapshot.maxSources, snapshot.maxUnusedDays,
        current.retentionDeadline, now, now);
    for (const source of snapshot.sources) {
      db.prepare(`INSERT INTO generation_sources (generation_id, extraction_id, source_id, output_hash)
        VALUES (?, ?, ?, ?)`).run(generation.generationId, source.extractionId, source.sourceId, source.outputHash);
    }
    for (const note of snapshot.notes) {
      db.prepare(`INSERT INTO note_applications (note_id, memory_version, note_hash, generation_id, control_epoch)
        VALUES (?, ?, ?, ?, ?) ON CONFLICT(note_id, memory_version) DO UPDATE SET
        note_hash = excluded.note_hash, generation_id = excluded.generation_id, control_epoch = excluded.control_epoch`)
        .run(note.noteId, generation.memoryVersion, note.textHash, generation.generationId, snapshot.controlEpoch);
    }
    db.prepare(`UPDATE pipeline_state SET active_generation_id = ?, reconciled_epoch = ?,
      read_blocked = 0, block_reason = NULL WHERE memory_version = ?`)
      .run(generation.generationId, snapshot.controlEpoch, generation.memoryVersion);
    finishConsolidation(db, lease, "succeeded", null, now);
    db.exec("COMMIT"); return true;
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}

export interface PublishedGeneration {
  generationId: string; memoryVersion: MemoryVersion; directory: string; path: string;
  inputHash: string; manifestHash: string; selectionHash: string; controlEpoch: number;
  promptHash: string; createdAt: number; retentionDeadline: number | null;
}

/** Read only the DB-selected version, rechecking revoked and expired supporting evidence. */
export function getPublishedGeneration(db: DatabaseSync, memoryVersion: MemoryVersion,
  now = Date.now(), options?: { maxUnusedDays?: number; generationId?: string }): PublishedGeneration | null {
  const generation = db.prepare(`SELECT g.generation_id AS generationId, g.memory_version AS memoryVersion,
    g.directory, g.directory AS path, g.input_hash AS inputHash, g.manifest_hash AS manifestHash,
    g.selection_hash AS selectionHash, g.control_epoch AS controlEpoch, g.prompt_hash AS promptHash,
    g.created_at AS createdAt, g.retention_deadline AS retentionDeadline, g.max_unused_days AS maxUnusedDays
    FROM pipeline_state p JOIN generations g ON g.generation_id = COALESCE(?, p.active_generation_id)
      AND g.memory_version = p.memory_version CROSS JOIN store_state s
    WHERE p.memory_version = ? AND p.read_blocked = 0 AND g.status = 'published'
      AND g.control_epoch = s.control_epoch AND p.reconciled_epoch = s.control_epoch AND s.singleton = 1`)
    .get(options?.generationId ?? null, memoryVersion) as unknown as (PublishedGeneration & { maxUnusedDays: number }) | undefined;
  if (!generation) return null;
  const retentionDays = options?.maxUnusedDays ?? generation.maxUnusedDays;
  if (!Number.isSafeInteger(retentionDays) || retentionDays < 1 || retentionDays > 3650) return null;
  const unavailable = db.prepare(`SELECT 1 FROM generation_sources gs
    JOIN source_revisions r ON r.source_id = gs.source_id
    JOIN branch_heads h ON h.session_key = r.session_key AND h.branch_id = r.branch_id
    LEFT JOIN source_stats st ON st.lineage_key = r.lineage_key AND st.memory_version = ?
    WHERE gs.generation_id = ? AND (r.status != 'captured' OR h.state != 'active'
      OR h.latest_revision != r.source_id OR COALESCE(st.last_used_at, r.source_time) < ?)
    LIMIT 1`).get(memoryVersion, generation.generationId, now - retentionDays * DAY_MS);
  if (unavailable) return null;
  const deadline = db.prepare(`SELECT MIN(COALESCE(st.last_used_at, r.source_time) + ?) AS deadline
    FROM generation_sources gs JOIN source_revisions r ON r.source_id = gs.source_id
    LEFT JOIN source_stats st ON st.lineage_key = r.lineage_key AND st.memory_version = ?
    WHERE gs.generation_id = ?`).get(retentionDays * DAY_MS + 1, memoryVersion, generation.generationId) as { deadline: number | null };
  const { maxUnusedDays: _days, ...published } = generation;
  return { ...published, retentionDeadline: deadline.deadline };
}

/** Record actual detail/citation use once; injection and literal hits never call this. */
export function recordSourceUsage(db: DatabaseSync, opts: {
  memoryVersion: MemoryVersion; sourceId: string; consumerSession: string; runId: string; now: number;
}): boolean {
  db.exec("BEGIN IMMEDIATE");
  try {
    const source = db.prepare(`SELECT r.lineage_key AS lineageKey FROM source_revisions r
      JOIN branch_heads h ON h.session_key = r.session_key AND h.branch_id = r.branch_id
      WHERE r.source_id = ? AND r.status = 'captured' AND h.state = 'active' AND h.latest_revision = r.source_id
      AND EXISTS (SELECT 1 FROM extractions e WHERE e.source_id = r.source_id AND e.memory_version = ? AND e.outcome = 'succeeded')`)
      .get(opts.sourceId, opts.memoryVersion) as { lineageKey: string } | undefined;
    if (!source) { db.exec("COMMIT"); return false; }
    const inserted = db.prepare(`INSERT OR IGNORE INTO memory_usage (memory_version, consumer_session, run_id, source_id, used_at)
      VALUES (?, ?, ?, ?, ?)`).run(opts.memoryVersion, opts.consumerSession, opts.runId, opts.sourceId, opts.now).changes;
    if (inserted) {
      db.prepare(`INSERT INTO source_stats (memory_version, lineage_key, usage_count, last_used_at)
        VALUES (?, ?, 1, ?) ON CONFLICT(memory_version, lineage_key) DO UPDATE SET
          usage_count = usage_count + 1, last_used_at = MAX(COALESCE(last_used_at, 0), excluded.last_used_at)`)
        .run(opts.memoryVersion, source.lineageKey, opts.now);
    }
    db.exec("COMMIT"); return inserted === 1;
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}
