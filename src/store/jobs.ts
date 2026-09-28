import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { MemoryVersion, ModelRef } from "../config.ts";

const LEASE_MS = 180_000;
const MAX_NETWORK_ATTEMPTS = 3;

export interface LeasedJob {
  jobId: string;
  sourceId: string;
  memoryVersion: MemoryVersion;
  promptHash: string;
  owner: string;
  fence: number;
  leaseExpiresAt: number;
  attemptCount: number;
}

export interface ExtractionResult {
  memoryVersion: MemoryVersion;
  promptHash: string;
  model: ModelRef;
  rawMemory: string | null;
  rolloutSummary: string;
  rolloutSlug: string;
  outputHash: string;
  usage: { input: number; output: number };
  outcome: "succeeded" | "no_output";
}

/** Enqueue once per immutable source revision, version and prompt hash. */
export function enqueueExtraction(db: DatabaseSync, item: {
  sourceId: string; memoryVersion: MemoryVersion; promptHash: string; now: number;
}): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    const source = db.prepare(
      `SELECT r.source_id FROM source_revisions r JOIN branch_heads h
       ON h.session_key = r.session_key AND h.branch_id = r.branch_id
       WHERE r.source_id = ? AND r.status = 'captured' AND h.state = 'active' AND h.latest_revision = r.source_id`,
    ).get(item.sourceId);
    if (source) {
      db.prepare(
        `INSERT OR IGNORE INTO jobs
         (job_id, source_id, memory_version, kind, work_key, prompt_hash, status, due_at, created_at, updated_at)
         VALUES (?, ?, ?, 'extract', ?, ?, 'queued', ?, ?, ?)`,
      ).run(randomUUID(), item.sourceId, item.memoryVersion,
        JSON.stringify(["extract", item.sourceId, item.memoryVersion, item.promptHash]),
        item.promptHash, item.now, item.now, item.now);
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

function recoverExpired(db: DatabaseSync, now: number): void {
  db.prepare(
    `UPDATE jobs SET status = 'blocked', error_code = 'max_attempts', owner = NULL, lease_expires_at = NULL
     WHERE status = 'leased' AND lease_expires_at <= ? AND attempt_count >= ?`,
  ).run(now, MAX_NETWORK_ATTEMPTS);
  db.prepare(
    `UPDATE jobs SET status = 'queued', owner = NULL, lease_expires_at = NULL
     WHERE status = 'leased' AND lease_expires_at <= ? AND attempt_count < ?`,
  ).run(now, MAX_NETWORK_ATTEMPTS);
  // A graceful shutdown cancels the live request, but not the durable work.
  db.prepare(
    `UPDATE jobs SET status = 'queued', due_at = ?, error_code = NULL
     WHERE status = 'cancelled' AND attempt_count < ?`,
  ).run(now, MAX_NETWORK_ATTEMPTS);
}

/** Recover crashed workers at startup even if no other source is already due. */
export function recoverExpiredExtractions(db: DatabaseSync, now: number): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    recoverExpired(db, now);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/** Claim bounded store-wide slots without holding SQLite open during provider I/O. */
export function claimDueExtractions(db: DatabaseSync, opts: {
  owner: string; now: number; limit: number; slots?: number; minIdleMs?: number; maxAgeMs?: number;
}): LeasedJob[] {
  db.exec("BEGIN IMMEDIATE");
  try {
    recoverExpired(db, opts.now);
    const active = (db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status = 'leased' AND lease_expires_at > ?")
      .get(opts.now) as { n: number }).n;
    const capacity = Math.max(0, Math.min(opts.limit, (opts.slots ?? 2) - active));
    const candidates = db.prepare(
      `SELECT j.job_id, j.source_id, j.memory_version, j.prompt_hash
       FROM jobs j JOIN source_revisions r ON r.source_id = j.source_id
       JOIN sessions s ON s.session_key = r.session_key
       JOIN branch_heads h ON h.session_key = r.session_key AND h.branch_id = r.branch_id
       WHERE j.kind = 'extract' AND j.status IN ('queued', 'retry_wait') AND j.due_at <= ?
         AND j.attempt_count < ? AND r.status = 'captured' AND h.state = 'active'
         AND h.latest_revision = r.source_id AND s.last_activity_at <= ?
         AND r.source_time >= ?
         AND NOT EXISTS (SELECT 1 FROM process_activity p WHERE p.session_key = r.session_key
           AND p.activity_state = 'active' AND p.expires_at > ?)
       ORDER BY j.due_at, j.created_at, j.job_id LIMIT ?`,
    ).all(opts.now, MAX_NETWORK_ATTEMPTS, opts.now - (opts.minIdleMs ?? 0),
      opts.maxAgeMs === undefined ? 0 : opts.now - opts.maxAgeMs, opts.now, capacity) as {
      job_id: string; source_id: string; memory_version: MemoryVersion; prompt_hash: string;
    }[];
    const jobs: LeasedJob[] = [];
    for (const row of candidates) {
      const expires = opts.now + LEASE_MS;
      db.prepare(
        `UPDATE jobs SET status = 'leased', owner = ?, fence = fence + 1,
          attempt_count = attempt_count + 1, lease_expires_at = ?, updated_at = ?
         WHERE job_id = ?`,
      ).run(opts.owner, expires, opts.now, row.job_id);
      const claimed = db.prepare("SELECT fence, attempt_count FROM jobs WHERE job_id = ?")
        .get(row.job_id) as { fence: number; attempt_count: number };
      jobs.push({ jobId: row.job_id, sourceId: row.source_id, memoryVersion: row.memory_version,
        promptHash: row.prompt_hash, owner: opts.owner, fence: claimed.fence,
        leaseExpiresAt: expires, attemptCount: claimed.attempt_count });
    }
    db.exec("COMMIT");
    return jobs;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/** Renewal fails closed when a different owner or later fence took over. */
export function renewExtractionLease(db: DatabaseSync, job: LeasedJob, now: number): boolean {
  return db.prepare(
    `UPDATE jobs SET lease_expires_at = ?, updated_at = ?
     WHERE job_id = ? AND status = 'leased' AND owner = ? AND fence = ? AND lease_expires_at > ?`,
  ).run(now + LEASE_MS, now, job.jobId, job.owner, job.fence, now).changes === 1;
}

/** Account for the one optional repair request within the same leased job. */
export function reserveRepairAttempt(db: DatabaseSync, job: LeasedJob, now: number): boolean {
  return db.prepare(
    `UPDATE jobs SET attempt_count = attempt_count + 1, updated_at = ?
     WHERE job_id = ? AND status = 'leased' AND owner = ? AND fence = ?
       AND lease_expires_at > ? AND attempt_count < ?`,
  ).run(now, job.jobId, job.owner, job.fence, now, MAX_NETWORK_ATTEMPTS).changes === 1;
}

/** Defer without launching a model request when the shared budget is exhausted. */
export function deferExtractionForBudget(db: DatabaseSync, job: LeasedJob,
  reason: string, now: number, nextDue: number): boolean {
  return db.prepare(
    `UPDATE jobs SET status = 'retry_wait', due_at = ?, error_code = ?,
       owner = NULL, lease_expires_at = NULL, attempt_count = attempt_count - 1, updated_at = ?
     WHERE job_id = ? AND status = 'leased' AND owner = ? AND fence = ? AND lease_expires_at > ?`,
  ).run(nextDue, reason, now, job.jobId, job.owner, job.fence, now).changes === 1;
}

/** Pause after an in-flight request when foreground work resumed. Keep consumed attempts. */
export function pauseExtraction(db: DatabaseSync, job: LeasedJob, now: number): boolean {
  return db.prepare(
    `UPDATE jobs SET status = 'retry_wait', due_at = ?, error_code = 'foreground_active',
       owner = NULL, lease_expires_at = NULL, updated_at = ?
     WHERE job_id = ? AND status = 'leased' AND owner = ? AND fence = ? AND lease_expires_at > ?`,
  ).run(now, now, job.jobId, job.owner, job.fence, now).changes === 1;
}

/** Retry transient failures with bounded backoff; never mutate another lease's job. */
export function failExtraction(
  db: DatabaseSync, job: LeasedJob, kind: "transient" | "blocked" | "cancelled",
  errorCode: string, now: number, options?: { retryAfterMs?: number },
): boolean {
  db.exec("BEGIN IMMEDIATE");
  try {
    const current = db.prepare(
      `SELECT j.attempt_count, r.status AS source_status, h.state AS branch_state, h.latest_revision
       FROM jobs j JOIN source_revisions r ON r.source_id = j.source_id
       JOIN branch_heads h ON h.session_key = r.session_key AND h.branch_id = r.branch_id
       WHERE j.job_id = ? AND j.status = 'leased' AND j.owner = ? AND j.fence = ? AND j.lease_expires_at > ?`,
    ).get(job.jobId, job.owner, job.fence, now) as {
      attempt_count: number; source_status: string; branch_state: string; latest_revision: string | null;
    } | undefined;
    if (!current) {
      db.exec("COMMIT");
      return false;
    }
    let status: "superseded" | "retry_wait" | "blocked" | "cancelled";
    if (current.source_status !== "captured" || current.branch_state !== "active" ||
        current.latest_revision !== job.sourceId) status = "superseded";
    else if (kind === "transient") status = current.attempt_count >= MAX_NETWORK_ATTEMPTS ? "blocked" : "retry_wait";
    else status = kind;
    const backoff = current.attempt_count === 1 ? 60_000 : current.attempt_count === 2 ? 300_000 : 1_800_000;
    const delay = Math.max(backoff, options?.retryAfterMs ?? 0);
    db.prepare(
      `UPDATE jobs SET status = ?, error_code = ?, due_at = ?, owner = NULL,
        lease_expires_at = NULL, updated_at = ? WHERE job_id = ?`,
    ).run(status, status === "blocked" && kind === "transient" ? "max_attempts" : errorCode,
      status === "retry_wait" ? now + delay : now, now, job.jobId);
    db.exec("COMMIT");
    return true;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/** Accept a result only for the still-active revision and exact leased fence. */
export function commitExtraction(db: DatabaseSync, job: LeasedJob, result: ExtractionResult, now: number): boolean {
  const allEmpty = (result.rawMemory ?? "") === "" && result.rolloutSummary === "" && result.rolloutSlug === "";
  if (result.memoryVersion !== job.memoryVersion || result.promptHash !== job.promptHash ||
      (job.memoryVersion === "v1" && result.rawMemory === null) ||
      (job.memoryVersion === "v2" && result.rawMemory !== null) ||
      (result.outcome === "no_output") !== allEmpty) return false;
  db.exec("BEGIN IMMEDIATE");
  try {
    const row = db.prepare(
      `SELECT j.status, j.owner, j.fence, j.lease_expires_at, r.status AS source_status,
         h.state AS branch_state, h.latest_revision
       FROM jobs j JOIN source_revisions r ON r.source_id = j.source_id
       JOIN branch_heads h ON h.session_key = r.session_key AND h.branch_id = r.branch_id
       WHERE j.job_id = ? AND j.source_id = ? AND j.memory_version = ? AND j.prompt_hash = ?`,
    ).get(job.jobId, job.sourceId, job.memoryVersion, job.promptHash) as {
      status: string; owner: string | null; fence: number; lease_expires_at: number | null;
      source_status: string; branch_state: string; latest_revision: string | null;
    } | undefined;
    if (!row || row.status !== "leased" || row.owner !== job.owner || row.fence !== job.fence ||
        row.lease_expires_at === null || row.lease_expires_at <= now) {
      db.exec("COMMIT");
      return false;
    }
    if (row.source_status !== "captured" || row.branch_state !== "active" || row.latest_revision !== job.sourceId) {
      db.prepare("UPDATE jobs SET status = 'superseded', owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE job_id = ?")
        .run(now, job.jobId);
      db.exec("COMMIT");
      return false;
    }
    const inserted = db.prepare(
      `INSERT OR IGNORE INTO extractions
       (extraction_id, source_id, memory_version, prompt_hash, job_id, raw_memory,
        rollout_summary, rollout_slug, model_provider, model_id, output_hash,
        outcome, usage_input, usage_output, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(randomUUID(), job.sourceId, job.memoryVersion, job.promptHash, job.jobId,
      result.rawMemory, result.rolloutSummary, result.rolloutSlug, result.model.provider,
      result.model.modelId, result.outputHash, result.outcome, result.usage.input,
      result.usage.output, now).changes;
    if (inserted !== 1) {
      db.exec("ROLLBACK");
      return false;
    }
    db.prepare("UPDATE jobs SET status = ?, owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE job_id = ?")
      .run(result.outcome, now, job.jobId);
    db.exec("COMMIT");
    return true;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/** 30-second foreground heartbeat with 180-second cross-process expiry. */
export function recordProcessActivity(db: DatabaseSync, item: {
  owner: string; sessionKey: string; state: "active" | "idle"; now: number;
}): void {
  db.prepare(
    `INSERT INTO process_activity (owner_id, session_key, activity_state, expires_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (owner_id) DO UPDATE SET session_key = excluded.session_key,
       activity_state = excluded.activity_state, expires_at = excluded.expires_at`,
  ).run(item.owner, item.sessionKey, item.state, item.now + LEASE_MS);
}

export function clearProcessActivity(db: DatabaseSync, owner: string): void {
  db.prepare("DELETE FROM process_activity WHERE owner_id = ?").run(owner);
}

export interface BudgetReservation {
  id: string;
  now: number;
  timezone: string;
  provider: string;
  model: string;
  estimate: { input: number; output: number };
  limits: { input: number; output: number; requests: number };
}

function localDay(now: number, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date(now));
  const value = (type: string) => parts.find((part) => part.type === type)?.value;
  return `${value("year")}-${value("month")}-${value("day")}`;
}

/** Earliest next local day, including 23/25-hour DST days. */
export function nextLocalDayTime(now: number, timezone: string): number {
  const day = localDay(now, timezone);
  let low = now;
  let high = now + 26 * 60 * 60 * 1000;
  while (localDay(high, timezone) === day) high += 24 * 60 * 60 * 1000;
  while (high - low > 1) {
    const midpoint = Math.floor((low + high) / 2);
    if (localDay(midpoint, timezone) === day) low = midpoint;
    else high = midpoint;
  }
  return high;
}

/** Reserve across all providers/models atomically, before a network request. */
export function reserveModelCall(db: DatabaseSync, request: BudgetReservation):
  { ok: true } | { ok: false; reason: "input_budget" | "output_budget" | "request_budget" } {
  const day = localDay(request.now, request.timezone);
  if (!Number.isSafeInteger(request.estimate.input) || request.estimate.input < 0 ||
      !Number.isSafeInteger(request.estimate.output) || request.estimate.output < 0) {
    throw new Error("invalid model request reservation");
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    if (db.prepare("SELECT 1 FROM budget_reservations WHERE reservation_id = ?").get(request.id)) {
      throw new Error(`duplicate model reservation ${request.id}`);
    }
    const sum = db.prepare(
      `SELECT COALESCE(SUM(reserved_input + actual_input), 0) AS input,
        COALESCE(SUM(reserved_output + actual_output), 0) AS output,
        COALESCE(SUM(call_count), 0) AS requests FROM budget_usage WHERE local_day = ?`,
    ).get(day) as { input: number; output: number; requests: number };
    let reason: "input_budget" | "output_budget" | "request_budget" | undefined;
    if (sum.requests + 1 > request.limits.requests) reason = "request_budget";
    else if (sum.input + request.estimate.input > request.limits.input) reason = "input_budget";
    else if (sum.output + request.estimate.output > request.limits.output) reason = "output_budget";
    if (reason) {
      db.exec("COMMIT");
      return { ok: false, reason };
    }
    db.prepare(
      `INSERT INTO budget_usage (local_day, provider, model, reserved_input, reserved_output, call_count)
       VALUES (?, ?, ?, ?, ?, 1)
       ON CONFLICT (local_day, provider, model) DO UPDATE SET
         reserved_input = reserved_input + excluded.reserved_input,
         reserved_output = reserved_output + excluded.reserved_output,
         call_count = call_count + 1`,
    ).run(day, request.provider, request.model, request.estimate.input, request.estimate.output);
    db.prepare(
      `INSERT INTO budget_reservations
       (reservation_id, local_day, provider, model, estimate_input, estimate_output, status)
       VALUES (?, ?, ?, ?, ?, ?, 'reserved')`,
    ).run(request.id, day, request.provider, request.model, request.estimate.input, request.estimate.output);
    db.exec("COMMIT");
    return { ok: true };
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/** Missing provider usage charges the estimate; reconciliation is idempotent. */
export function reconcileModelCall(db: DatabaseSync, id: string,
  usage: { input: number; output: number } | undefined): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    const row = db.prepare("SELECT * FROM budget_reservations WHERE reservation_id = ?").get(id) as {
      local_day: string; provider: string; model: string; estimate_input: number;
      estimate_output: number; status: string;
    } | undefined;
    if (!row) throw new Error(`unknown model reservation ${id}`);
    if (row.status === "reserved") {
      const input = usage?.input ?? row.estimate_input;
      const output = usage?.output ?? row.estimate_output;
      if (!Number.isSafeInteger(input) || input < 0 || !Number.isSafeInteger(output) || output < 0) {
        throw new Error("invalid provider usage");
      }
      db.prepare(
        `UPDATE budget_usage SET reserved_input = reserved_input - ?, reserved_output = reserved_output - ?,
          actual_input = actual_input + ?, actual_output = actual_output + ?
         WHERE local_day = ? AND provider = ? AND model = ?`,
      ).run(row.estimate_input, row.estimate_output, input, output, row.local_day, row.provider, row.model);
      db.prepare(
        `UPDATE budget_reservations SET status = 'charged', actual_input = ?, actual_output = ?
         WHERE reservation_id = ?`,
      ).run(input, output, id);
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
