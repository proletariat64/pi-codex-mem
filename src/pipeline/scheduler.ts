import { createHash, randomUUID } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { MemoryConfig } from "../config.ts";
import type { SchedulerTimer } from "../extraction/scheduler.ts";
import { targetVersions } from "../extraction/scheduler.ts";
import { nextLocalDayTime } from "../store/jobs.ts";
import { claimConsolidation, finishConsolidation, getPublishedGeneration, selectConsolidation } from "../store/consolidation.ts";
import { consolidationPromptHash, runConsolidation } from "./consolidate.ts";
import type { ConsolidationModelPort } from "./model-port.ts";
import { buildStaging } from "./staging.ts";
import { cleanupGenerations, publishGeneration } from "./publish.ts";
import { generatedOutput, readWorkspaceUtf8, workspaceInventory } from "./workspace-tools.ts";
import { validateV1Artifacts, writeMinimalV1 } from "./validate.ts";

export interface ConsolidationSchedulerOptions {
  db: DatabaseSync;
  root: string;
  config: () => MemoryConfig | null;
  modelPort: () => ConsolidationModelPort | null;
  now: () => number;
  isForegroundIdle: () => boolean;
  timer?: SchedulerTimer;
  onError?: (error: unknown) => void;
  pinnedGenerationIds?: () => readonly string[];
}

export interface ConsolidationPassResult { status: string; reason?: string }

const realTimer: SchedulerTimer = {
  schedule(run, delayMs) {
    const handle = setTimeout(() => { void run(); }, Math.min(delayMs, 2_147_483_647));
    handle.unref();
    return { cancel: () => clearTimeout(handle) };
  },
};

function consolidationConfigEpoch(config: MemoryConfig): string {
  return createHash("sha256").update(JSON.stringify({ promptHash: consolidationPromptHash(config),
    model: config.models.consolidate, enabled: config.enabled, generate: config.generate,
    version: config.version, dualWrite: config.dualWrite, captureModes: config.captureModes,
    excludedWorkspaces: config.excludedWorkspaces, limits: config.limits,
    schedule: config.schedule, timezone: config.timezone })).digest("hex");
}

/** One store-wide v1 writer, armed only on content changes or a known deadline. */
export class ConsolidationScheduler {
  private readonly options: ConsolidationSchedulerOptions;
  private timer: ReturnType<SchedulerTimer["schedule"]> | null = null;
  private stopped = false;
  private checkedKey: string | null = null;
  private controller: AbortController | null = null;
  private running: Promise<ConsolidationPassResult[]> | null = null;
  private backoffUntil = 0;

  constructor(options: ConsolidationSchedulerOptions) { this.options = options; }

  private config(): MemoryConfig | null {
    const config = this.options.config();
    return config?.enabled && config.generate && targetVersions(config).includes("v1") ? config : null;
  }

  private snapshot(config: MemoryConfig) {
    return selectConsolidation(this.options.db, { memoryVersion: "v1", now: this.options.now(),
      maxSources: Math.min(256, config.schedule.maxConsolidationSources), maxUnusedDays: config.schedule.maxUnusedDays });
  }

  private key(config: MemoryConfig): string {
    const snapshot = this.snapshot(config);
    let outputHashes: Record<string, string> | string = "unavailable";
    const generation = getPublishedGeneration(this.options.db, "v1", this.options.now(),
      { maxUnusedDays: config.schedule.maxUnusedDays });
    if (generation) {
      try {
        outputHashes = Object.fromEntries(workspaceInventory(generation.directory).filter(generatedOutput)
          .map((path) => [path, createHash("sha256").update(readWorkspaceUtf8(generation.directory, path)).digest("hex")]));
        outputHashes["manifest.json"] = createHash("sha256")
          .update(readWorkspaceUtf8(generation.directory, "manifest.json")).digest("hex");
      } catch { outputHashes = "damaged"; }
    }
    return JSON.stringify([snapshot.selectionHash, snapshot.controlEpoch, snapshot.baseGenerationId,
      snapshot.notes, consolidationConfigEpoch(config), outputHashes]);
  }

  private inputRevision(config: MemoryConfig): string {
    return createHash("sha256").update(this.key(config)).digest("hex");
  }

  trigger(): void {
    this.timer?.cancel();
    this.timer = null;
    if (this.stopped || this.running || !this.options.isForegroundIdle()) return;
    const config = this.config();
    if (!config) return;
    try {
      const now = this.options.now();
      const snapshot = this.snapshot(config);
      const key = this.key(config);
      const row = this.options.db.prepare(
        `SELECT MIN(due_at) AS due_at FROM jobs WHERE kind = 'consolidate' AND memory_version = 'v1'
           AND prompt_hash = ? AND config_epoch = ? AND work_key = ?
           AND status IN ('queued', 'retry_wait') AND attempt_count < 3`,
      ).get(consolidationPromptHash(config), consolidationConfigEpoch(config),
        JSON.stringify(["consolidate", "v1", consolidationPromptHash(config), this.inputRevision(config)])) as { due_at: number | null };
      const leased = this.options.db.prepare(
        "SELECT MIN(lease_expires_at) AS expiry FROM jobs WHERE kind = 'consolidate' AND status = 'leased'",
      ).get() as { expiry: number | null };
      const busy = this.options.db.prepare(
        "SELECT MAX(expires_at) AS expiry FROM process_activity WHERE activity_state = 'active' AND expires_at > ?",
      ).get(now) as { expiry: number | null };
      let next: number | null = null;
      if (this.checkedKey !== key) next = Math.max(now, row.due_at ?? now, leased.expiry ?? now, busy.expiry ?? now);
      else if (row.due_at !== null) next = Math.max(now, row.due_at, leased.expiry ?? now, busy.expiry ?? now);
      if (snapshot.retentionDeadline !== null && snapshot.retentionDeadline > now) {
        next = next === null ? snapshot.retentionDeadline : Math.min(next, snapshot.retentionDeadline);
      }
      if (next !== null) this.timer = (this.options.timer ?? realTimer).schedule(async () => {
        await this.runPass();
      }, Math.max(0, next - now, this.backoffUntil - now));
    } catch (error) { this.options.onError?.(error); }
  }

  foregroundStarted(): void { this.timer?.cancel(); this.timer = null; }
  foregroundSettled(): void { this.trigger(); }

  async runPass(retryBlocked = false): Promise<ConsolidationPassResult[]> {
    if (this.stopped || this.running || !this.options.isForegroundIdle()) return [];
    const config = this.config();
    if (!config) return [];
    this.timer?.cancel(); this.timer = null;
    const task = this.run(config, retryBlocked);
    this.running = task;
    try { const results = await task; this.backoffUntil = 0; return results; }
    catch (error) {
      this.backoffUntil = this.options.now() + 60_000;
      this.options.onError?.(error);
      return [];
    }
    finally { this.running = null; this.trigger(); }
  }

  private async run(config: MemoryConfig, retryBlocked: boolean): Promise<ConsolidationPassResult[]> {
    const clock = this.options.now;
    const db = this.options.db;
    const busy = db.prepare("SELECT 1 FROM process_activity WHERE activity_state = 'active' AND expires_at > ? LIMIT 1").get(clock());
    if (busy) return [];
    const snapshot = this.snapshot(config);
    const promptHash = consolidationPromptHash(config);
    const lease = claimConsolidation(db, { memoryVersion: "v1", owner: randomUUID(), now: clock(), promptHash,
      configEpoch: consolidationConfigEpoch(config), inputRevisionHash: this.inputRevision(config), retryBlocked });
    if (!lease) { this.checkedKey = this.key(config); return []; }
    this.controller = new AbortController();
    let directory: string | undefined;
    try {
      const prior = snapshot.baseGenerationId ? db.prepare(
        "SELECT directory, manifest_hash FROM generations WHERE generation_id = ? AND memory_version = 'v1' AND status = 'published'",
      ).get(snapshot.baseGenerationId) as { directory: string; manifest_hash: string } | undefined : undefined;
      let priorDir: string | undefined;
      if (prior) {
        try {
          const text = readWorkspaceUtf8(prior.directory, "manifest.json");
          if (createHash("sha256").update(text).digest("hex") === prior.manifest_hash) priorDir = prior.directory;
        } catch { /* A damaged previous artifact cannot become writer input. */ }
      }
      // Reclaimed leases must not reuse a dead writer's candidate or cleanup path.
      const staged = buildStaging({ root: this.options.root, jobId: `${lease.jobId}-${lease.fence}`, snapshot, promptHash,
        summaryBytes: config.limits.summaryBytes, priorDir });
      directory = staged.directory;
      if (staged.unchanged) {
        validateV1Artifacts({ directory, snapshot, summaryBytes: config.limits.summaryBytes });
        finishConsolidation(db, lease, "succeeded", null, clock(), clock(), { refundAttempt: true });
        this.checkedKey = this.key(config);
        return [{ status: "unchanged" }];
      }
      if (!snapshot.sources.length && !snapshot.notes.length) writeMinimalV1(directory);
      else {
        const port = this.options.modelPort();
        if (!port || !config.models.consolidate) {
          finishConsolidation(db, lease, "blocked", "model_not_configured", clock());
          this.checkedKey = this.key(config);
          return [{ status: "blocked", reason: "model_not_configured" }];
        }
        let requestsStarted = 0;
        const result = await runConsolidation({ db, directory, lease, config, modelRef: config.models.consolidate,
          port, signal: this.controller.signal, clock,
          onRequestStarted: () => { requestsStarted++; },
          validateOutputs: () => { validateV1Artifacts({ directory: directory!, snapshot, summaryBytes: config.limits.summaryBytes }); },
          canStartRequest: () => {
            if (this.stopped || !this.options.isForegroundIdle()) return "foreground_active";
            const latest = this.config();
            const current = this.snapshot(config);
            return latest && consolidationPromptHash(latest) === promptHash &&
              consolidationConfigEpoch(latest) === consolidationConfigEpoch(config) &&
              current.controlEpoch === snapshot.controlEpoch && current.selectionHash === snapshot.selectionHash &&
              JSON.stringify(latest.models.consolidate) === JSON.stringify(config.models.consolidate)
              ? "ready" : "configuration_changed";
          } });
        if (result.status !== "succeeded") {
          const attempt = db.prepare("SELECT attempt_count FROM jobs WHERE job_id = ?").get(lease.jobId)?.attempt_count as number;
          const backoff = attempt <= 1 ? 60_000 : attempt === 2 ? 300_000 : 1_800_000;
          const due = result.status === "budget_deferred" ? nextLocalDayTime(clock(), config.timezone)
            : result.status === "retry_wait" ? clock() + Math.max(backoff, result.retryAfterMs ?? 0) : clock();
          finishConsolidation(db, lease, result.status === "paused" || result.status === "budget_deferred" ? "retry_wait" : result.status,
            result.reason ?? result.status, clock(), due, { refundAttempt: requestsStarted === 0 });
          this.checkedKey = this.key(config);
          return [result];
        }
      }
      if (this.controller.signal.aborted) throw new Error("cancelled");
      const validated = validateV1Artifacts({ directory, snapshot, summaryBytes: config.limits.summaryBytes });
      staged.manifest.fileHashes = validated.fileHashes;
      const manifestText = JSON.stringify(staged.manifest, null, 2) + "\n";
      writeFileSync(join(directory, "manifest.json"), manifestText, { mode: 0o600 });
      const published = publishGeneration({ db, root: this.options.root, stagingDir: directory,
        lease, snapshot, inputHash: staged.inputHash,
        manifestHash: createHash("sha256").update(manifestText).digest("hex"), now: clock });
      if (!published.published) finishConsolidation(db, lease, "superseded", "publication_cas", clock());
      this.checkedKey = this.key(config);
      return [{ status: published.published ? "published" : "superseded" }];
    } catch (error) {
      const reason = (error as Error).message;
      finishConsolidation(db, lease, this.controller.signal.aborted ? "cancelled" : "blocked", reason, clock());
      this.checkedKey = this.key(config);
      this.options.onError?.(error);
      return [{ status: this.controller.signal.aborted ? "cancelled" : "blocked", reason }];
    } finally {
      if (directory) rmSync(directory, { recursive: true, force: true });
      this.controller = null;
      try { cleanupGenerations({ db, root: this.options.root, now: clock(),
        pinnedGenerationIds: this.options.pinnedGenerationIds?.() }); }
      catch (error) { this.options.onError?.(error); }
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.timer?.cancel(); this.timer = null;
    this.controller?.abort();
    if (this.running) await this.running;
  }
}
