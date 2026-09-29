import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { MemoryConfig, MemoryVersion } from "../config.ts";
import { claimDueExtractions, enqueueExtraction, extractionConfigEpoch, recoverExpiredExtractions } from "../store/jobs.ts";
import { runV1Extraction, runV2Extraction, type MemoryModelPort, type V1RunResult } from "./runner.ts";
import { v1PromptHash } from "./v1.ts";
import { v2PromptHash } from "./v2.ts";
import { recoverEnrolledSnapshots } from "../control/switch.ts";

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
  request?: { requestId: string; policyHash: string };
  onPassComplete?: (results: V1RunResult[]) => Promise<void> | void;
}

/** Enroll active, previously captured snapshots after restart or configuration changes. */
export function targetVersions(config: MemoryConfig): MemoryVersion[] {
  if (!config.dualWrite) return [config.version];
  return [config.version, config.version === "v1" ? "v2" : "v1"];
}

export function enqueueActiveExtractions(db: DatabaseSync, now: number, config: MemoryConfig, root?: string,
  request?: { requestId: string; policyHash: string }): void {
  const recovery = root ? recoverEnrolledSnapshots({ db, root, config, now }) : { unavailable: [] as string[], restored: [] as string[] };
  const rows = db.prepare(
    `SELECT r.source_id FROM source_revisions r JOIN branch_heads h
     ON h.session_key = r.session_key AND h.branch_id = r.branch_id
     WHERE r.status = 'captured' AND h.state = 'active' AND h.latest_revision = r.source_id`,
  ).all() as { source_id: string }[];
  for (const version of targetVersions(config)) {
    const promptHash = version === "v1" ? v1PromptHash() : v2PromptHash();
    for (const row of rows) enqueueExtraction(db, {
      sourceId: row.source_id, memoryVersion: version, promptHash,
      configEpoch: extractionConfigEpoch(config), now, request,
    });
    for (const row of rows) {
      if (recovery.unavailable.includes(row.source_id)) {
        db.prepare(`UPDATE jobs SET status = 'blocked', error_code = 'source_unavailable_for_version' WHERE source_id = ?
          AND memory_version = ? AND prompt_hash = ? AND status IN ('queued', 'retry_wait')`).run(row.source_id, version, promptHash);
      } else if (recovery.restored.includes(row.source_id)) {
        db.prepare(`UPDATE jobs SET status = 'queued', error_code = NULL, due_at = ? WHERE source_id = ? AND memory_version = ?
          AND prompt_hash = ? AND status = 'blocked' AND error_code = 'source_unavailable_for_version'`).run(now, row.source_id, version, promptHash);
      }
    }
  }
}

/** One-shot scheduling at the earliest eligible due/idle/busy/lease boundary. */
export class ExtractionScheduler {
  private readonly options: ExtractionSchedulerOptions;
  private timer: TimerHandle | null = null;
  private stopped = false;
  private running = false;
  private backoffUntil = 0;
  private nextVersion: MemoryVersion | null = null;
  private requestFinished = false;
  private requestForce = false;
  private readonly controllers = new Set<AbortController>();
  private readonly inFlight = new Set<Promise<V1RunResult>>();

  constructor(options: ExtractionSchedulerOptions) { this.options = options; }

  trigger(): void {
    if (this.stopped) return;
    const cfg = this.options.config();
    if (cfg?.enabled && cfg.generate) {
      recoverExpiredExtractions(this.options.db, this.options.now());
      enqueueActiveExtractions(this.options.db, this.options.now(), cfg, this.options.root, this.options.request);
    }
    if (this.options.request && !cfg && !this.running) {
      void this.completeRequest([]).catch(error => this.options.onError?.(error));
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
    if (this.options.request && force) this.requestForce = true;
    if (this.stopped || this.running || this.requestFinished || !this.options.isForegroundIdle()) return [];
    const cfg = this.options.config();
    const port = this.options.modelPort();
    if (!cfg || !cfg.enabled || !cfg.generate || !port || !cfg.models.extract) {
      if (this.options.request) await this.completeRequest([]);
      return [];
    }
    const modelRef = cfg.models.extract;
    this.timer?.cancel();
    this.timer = null;
    this.running = true;
    try {
      enqueueActiveExtractions(this.options.db, this.options.now(), cfg, this.options.root, this.options.request);
      const configEpoch = extractionConfigEpoch(cfg);
      const now = this.options.now();
      const jobs = claimDueExtractions(this.options.db, { owner: randomUUID(), now,
        limit: cfg.schedule.maxExtractionsPerPass, slots: cfg.schedule.extractionConcurrency,
        versions: targetVersions(cfg), preferredVersion: this.nextVersion ?? cfg.version, request: this.options.request,
        minIdleMs: force ? 0 : cfg.schedule.minIdleMinutes * 60_000,
        maxAgeMs: cfg.schedule.maxSourceAgeDays * 86_400_000 });
      const last = jobs.at(-1);
      if (cfg.dualWrite && last) this.nextVersion = last.memoryVersion === "v1" ? "v2" : "v1";
      const tasks = jobs.map((job) => {
        const controller = new AbortController();
        this.controllers.add(controller);
        const input = { db: this.options.db, root: this.options.root,
          job, modelRef, port, now, clock: this.options.now,
          canStartRequest: () => {
            if (this.stopped || !this.options.isForegroundIdle()) return "foreground_active" as const;
            const latest = this.options.config();
            if (!latest || !latest.enabled || !latest.generate ||
                !targetVersions(latest).includes(job.memoryVersion) ||
                extractionConfigEpoch(latest) !== configEpoch) return "configuration_changed" as const;
            return "ready" as const;
          },
          timezone: cfg.timezone, limits: {
            outputBytes: cfg.limits.extractionOutputBytes,
            v2RolloutSummaryBytes: cfg.limits.v2RolloutSummaryBytes,
            dailyInputTokens: cfg.limits.dailyInputTokens,
            dailyOutputTokens: cfg.limits.dailyOutputTokens,
            dailyRequests: cfg.limits.dailyRequests,
          }, signal: controller.signal };
        const task = job.memoryVersion === "v2" ? runV2Extraction(input) : runV1Extraction(input);
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
      if (this.options.request && jobs.length) await this.completeRequest(results);
      return results;
    } catch (err) {
      this.backoffUntil = this.options.now() + 60_000;
      this.options.onError?.(err);
      return [];
    } finally {
      this.running = false;
      if (!this.stopped) {
        const scheduled = this.schedule();
        if (this.options.request && !scheduled && this.options.isForegroundIdle()) await this.completeRequest([]);
      }
    }
  }

  private async completeRequest(results: V1RunResult[]): Promise<void> {
    if (this.requestFinished) return;
    this.requestFinished = true;
    await this.options.onPassComplete?.(results);
  }

  private schedule(): boolean {
    this.timer?.cancel();
    this.timer = null;
    if (this.stopped || this.running || this.requestFinished || !this.options.isForegroundIdle()) return false;
    const cfg = this.options.config();
    if (!cfg || !cfg.enabled || !cfg.generate || !cfg.models.extract || !this.options.modelPort()) return false;
    const now = this.options.now();
    const minimum = this.requestForce ? 0 : cfg.schedule.minIdleMinutes * 60_000;
    const rows = this.options.db.prepare(
      `SELECT j.due_at, r.source_time, s.last_activity_at, s.session_key,
         (SELECT MAX(p.expires_at) FROM process_activity p WHERE p.session_key = s.session_key
            AND p.activity_state = 'active' AND p.expires_at > ?) AS busy_until
       FROM jobs j JOIN source_revisions r ON r.source_id = j.source_id
       JOIN sessions s ON s.session_key = r.session_key
       JOIN branch_heads h ON h.session_key = r.session_key AND h.branch_id = r.branch_id
       WHERE j.kind = 'extract' AND j.memory_version IN (?, ?)
         AND j.status IN ('queued', 'retry_wait') AND j.attempt_count < 3
         AND r.status = 'captured' AND h.state = 'active'
         AND h.latest_revision = r.source_id AND r.source_time >= ?`,
    ).all(now, cfg.version, cfg.dualWrite ? (cfg.version === "v1" ? "v2" : "v1") : cfg.version,
      now - cfg.schedule.maxSourceAgeDays * 86_400_000) as {
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
    if (!candidates.length) return false;
    const next = Math.max(now, this.backoffUntil, Math.min(...candidates));
    this.timer = (this.options.timer ?? realTimer).schedule(async () => {
      try { await this.runPass(this.requestForce); }
      catch (err) { this.options.onError?.(err); }
    }, next - now);
    return true;
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
