import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { MemoryConfig } from "../config.ts";
import { claimDueExtractions, enqueueExtraction, recoverExpiredExtractions } from "../store/jobs.ts";
import { runV1Extraction, type MemoryModelPort, type V1RunResult } from "./runner.ts";
import { v1PromptHash } from "./v1.ts";

interface TimerHandle { cancel(): void }
export interface SchedulerTimer {
  schedule(run: () => Promise<void>, delayMs: number): TimerHandle;
}

const realTimer: SchedulerTimer = {
  schedule(run, delayMs) {
    const handle = setTimeout(() => { void run(); }, Math.min(delayMs, 2_147_483_647));
    handle.unref();
    return { cancel: () => clearTimeout(handle) };
  },
};

export interface ExtractionSchedulerOptions {
  db: DatabaseSync;
  root: string;
  config: () => MemoryConfig | null;
  modelPort: () => MemoryModelPort | null;
  now: () => number;
  isForegroundIdle: () => boolean;
  timer?: SchedulerTimer;
  onResult?: (result: V1RunResult) => void;
  onError?: (error: unknown) => void;
}

/** Enroll active, previously captured snapshots after restart or configuration changes. */
export function enqueueActiveV1(db: DatabaseSync, now: number): void {
  const rows = db.prepare(
    `SELECT r.source_id FROM source_revisions r JOIN branch_heads h
     ON h.session_key = r.session_key AND h.branch_id = r.branch_id
     WHERE r.status = 'captured' AND h.state = 'active' AND h.latest_revision = r.source_id`,
  ).all() as { source_id: string }[];
  const promptHash = v1PromptHash();
  for (const row of rows) enqueueExtraction(db, {
    sourceId: row.source_id, memoryVersion: "v1", promptHash, now,
  });
}

/** One-shot scheduling at the earliest eligible due/idle/busy/lease boundary. */
export class ExtractionScheduler {
  private readonly options: ExtractionSchedulerOptions;
  private timer: TimerHandle | null = null;
  private stopped = false;
  private running = false;
  private backoffUntil = 0;
  private readonly controllers = new Set<AbortController>();
  private readonly inFlight = new Set<Promise<V1RunResult>>();

  constructor(options: ExtractionSchedulerOptions) { this.options = options; }

  trigger(): void {
    if (this.stopped) return;
    const cfg = this.options.config();
    if (cfg && (cfg.version === "v1" || cfg.dualWrite)) {
      recoverExpiredExtractions(this.options.db, this.options.now());
      enqueueActiveV1(this.options.db, this.options.now());
    }
    this.schedule();
  }

  foregroundStarted(): void {
    this.timer?.cancel();
    this.timer = null;
  }

  foregroundSettled(): void { this.trigger(); }

  /** A manual pass skips the idle interval, never the foreground/busy/age gates. */
  async runPass(force = false): Promise<V1RunResult[]> {
    if (this.stopped || this.running || !this.options.isForegroundIdle()) return [];
    const cfg = this.options.config();
    const port = this.options.modelPort();
    if (!cfg || !port || (cfg.version !== "v1" && !cfg.dualWrite) || !cfg.models.extract) return [];
    this.timer?.cancel();
    this.timer = null;
    this.running = true;
    try {
      enqueueActiveV1(this.options.db, this.options.now());
      const now = this.options.now();
      const jobs = claimDueExtractions(this.options.db, { owner: randomUUID(), now,
        limit: cfg.schedule.maxExtractionsPerPass, slots: cfg.schedule.extractionConcurrency,
        minIdleMs: force ? 0 : cfg.schedule.minIdleMinutes * 60_000,
        maxAgeMs: cfg.schedule.maxSourceAgeDays * 86_400_000 });
      const tasks = jobs.map((job) => {
        const controller = new AbortController();
        this.controllers.add(controller);
        const task = runV1Extraction({ db: this.options.db, root: this.options.root,
          job, modelRef: cfg.models.extract!, port, now, clock: this.options.now,
          canStartRequest: () => !this.stopped && this.options.isForegroundIdle(),
          timezone: cfg.timezone, limits: {
            outputBytes: cfg.limits.extractionOutputBytes,
            dailyInputTokens: cfg.limits.dailyInputTokens,
            dailyOutputTokens: cfg.limits.dailyOutputTokens,
            dailyRequests: cfg.limits.dailyRequests,
          }, signal: controller.signal });
        this.inFlight.add(task);
        void task.finally(() => {
          this.inFlight.delete(task);
          this.controllers.delete(controller);
        }).catch(() => { /* main runPass handles the failure */ });
        return task;
      });
      const results = await Promise.all(tasks);
      for (const result of results) this.options.onResult?.(result);
      this.backoffUntil = 0;
      return results;
    } catch (err) {
      this.backoffUntil = this.options.now() + 60_000;
      this.options.onError?.(err);
      return [];
    } finally {
      this.running = false;
      if (!this.stopped) this.schedule();
    }
  }

  private schedule(): void {
    this.timer?.cancel();
    this.timer = null;
    if (this.stopped || this.running || !this.options.isForegroundIdle()) return;
    const cfg = this.options.config();
    if (!cfg || !cfg.models.extract || (cfg.version !== "v1" && !cfg.dualWrite) ||
        !this.options.modelPort()) return;
    const now = this.options.now();
    const minimum = cfg.schedule.minIdleMinutes * 60_000;
    const rows = this.options.db.prepare(
      `SELECT j.due_at, r.source_time, s.last_activity_at, s.session_key,
         (SELECT MAX(p.expires_at) FROM process_activity p WHERE p.session_key = s.session_key
            AND p.activity_state = 'active' AND p.expires_at > ?) AS busy_until
       FROM jobs j JOIN source_revisions r ON r.source_id = j.source_id
       JOIN sessions s ON s.session_key = r.session_key
       JOIN branch_heads h ON h.session_key = r.session_key AND h.branch_id = r.branch_id
       WHERE j.kind = 'extract' AND j.memory_version = 'v1' AND j.status IN ('queued', 'retry_wait')
         AND j.attempt_count < 3 AND r.status = 'captured' AND h.state = 'active'
         AND h.latest_revision = r.source_id AND r.source_time >= ?`,
    ).all(now, now - cfg.schedule.maxSourceAgeDays * 86_400_000) as {
      due_at: number; source_time: number; last_activity_at: number; session_key: string; busy_until: number | null;
    }[];
    const leases = this.options.db.prepare(
      `SELECT COUNT(*) AS n, MIN(lease_expires_at) AS next_expiry FROM jobs
       WHERE status = 'leased' AND lease_expires_at > ?`,
    ).get(now) as { n: number; next_expiry: number | null };
    const candidates = rows.map((row) => Math.max(row.due_at,
      row.last_activity_at + minimum, row.busy_until ?? 0,
      leases.n >= cfg.schedule.extractionConcurrency ? leases.next_expiry ?? 0 : 0));
    // Even without queued work, an orphaned leased job needs a one-shot recovery wakeup.
    if (leases.next_expiry !== null) candidates.push(leases.next_expiry + 1);
    if (!candidates.length) return;
    const next = Math.max(now, this.backoffUntil, Math.min(...candidates));
    this.timer = (this.options.timer ?? realTimer).schedule(async () => {
      try { await this.runPass(); }
      catch (err) { this.options.onError?.(err); }
    }, next - now);
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.timer?.cancel();
    this.timer = null;
    for (const controller of this.controllers) controller.abort();
    await Promise.allSettled([...this.inFlight]);
  }
}
