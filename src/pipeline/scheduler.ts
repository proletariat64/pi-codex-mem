import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { MemoryConfig, MemoryVersion } from "../config.ts";
import type { SchedulerTimer } from "../extraction/scheduler.ts";
import { targetVersions } from "../extraction/scheduler.ts";
import { v1PromptHash } from "../extraction/v1.ts";
import { v2PromptHash } from "../extraction/v2.ts";
import { nextLocalDayTime } from "../store/jobs.ts";
import { claimConsolidation, finishConsolidation, getPublishedGeneration, selectConsolidation } from "../store/consolidation.ts";
import { consolidationPromptHash } from "./consolidate.ts";
import type { ConsolidationModelPort } from "./model-port.ts";
import { prepareGenerationCandidate, type GenerationCandidate } from "./candidate.ts";
import { cleanupGenerations } from "./publish.ts";
import { storeSizeBytes } from "../store/size.ts";
import { generatedOutput, readWorkspaceUtf8, workspaceInventory } from "./workspace-tools.ts";

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
  request?: { requestId: string; policyHash: string };
}

export interface ConsolidationPassResult { status: string; reason?: string }

const realTimer: SchedulerTimer = {
  schedule(run, delayMs) {
    const handle = setTimeout(() => { void run(); }, Math.min(delayMs, 2_147_483_647));
    handle.unref();
    return { cancel: () => clearTimeout(handle) };
  },
};

function consolidationConfigEpoch(config: MemoryConfig, version: MemoryVersion): string {
  return createHash("sha256").update(JSON.stringify({ promptHash: consolidationPromptHash(config, version),
    model: config.models.consolidate, enabled: config.enabled, generate: config.generate,
    version: config.version, dualWrite: config.dualWrite, captureModes: config.captureModes,
    excludedWorkspaces: config.excludedWorkspaces, limits: config.limits,
    schedule: config.schedule, timezone: config.timezone })).digest("hex");
}

/** One store-wide writer, armed only on per-version content changes or a known deadline. */
export class ConsolidationScheduler {
  private readonly options: ConsolidationSchedulerOptions;
  private timer: ReturnType<SchedulerTimer["schedule"]> | null = null;
  private stopped = false;
  private readonly checkedKeys = new Map<MemoryVersion, string>();
  private controller: AbortController | null = null;
  private running: Promise<ConsolidationPassResult[]> | null = null;
  private backoffUntil = 0;
  private nextVersion: MemoryVersion | null = null;

  constructor(options: ConsolidationSchedulerOptions) { this.options = options; }

  private config(): MemoryConfig | null {
    const config = this.options.config();
    return config?.enabled && config.generate ? config : null;
  }

  private snapshot(config: MemoryConfig, version: MemoryVersion) {
    return selectConsolidation(this.options.db, { memoryVersion: version, now: this.options.now(),
      maxSources: Math.min(256, config.schedule.maxConsolidationSources), maxUnusedDays: config.schedule.maxUnusedDays,
      extractionPromptHash: version === "v1" ? v1PromptHash() : v2PromptHash() });
  }

  private key(config: MemoryConfig, version: MemoryVersion): string {
    const snapshot = this.snapshot(config, version);
    let outputHashes: Record<string, string> | string = "unavailable";
    const generation = getPublishedGeneration(this.options.db, version, this.options.now(),
      { maxUnusedDays: config.schedule.maxUnusedDays,
        extractionPromptHash: version === "v1" ? v1PromptHash() : v2PromptHash() });
    if (generation) {
      try {
        outputHashes = Object.fromEntries(workspaceInventory(generation.directory).filter(path => generatedOutput(path, version))
          .map((path) => [path, createHash("sha256").update(readWorkspaceUtf8(generation.directory, path)).digest("hex")]));
        outputHashes["manifest.json"] = createHash("sha256")
          .update(readWorkspaceUtf8(generation.directory, "manifest.json")).digest("hex");
      } catch { outputHashes = "damaged"; }
    }
    return JSON.stringify([snapshot.selectionHash, snapshot.controlEpoch, snapshot.baseGenerationId,
      snapshot.notes, consolidationConfigEpoch(config, version), outputHashes]);
  }

  private inputRevision(config: MemoryConfig, version: MemoryVersion): string {
    return createHash("sha256").update(this.key(config, version)).digest("hex");
  }

  trigger(): void {
    if (this.options.request) return; // Explicit version grants never arm an automatic continuation.
    this.timer?.cancel();
    this.timer = null;
    if (this.stopped || this.running || !this.options.isForegroundIdle()) return;
    const config = this.config();
    if (!config) return;
    try {
      const now = this.options.now();
      const leased = this.options.db.prepare(
        "SELECT MIN(lease_expires_at) AS expiry FROM jobs WHERE kind = 'consolidate' AND status = 'leased'",
      ).get() as { expiry: number | null };
      const busy = this.options.db.prepare(
        "SELECT MAX(expires_at) AS expiry FROM process_activity WHERE activity_state = 'active' AND expires_at > ?",
      ).get(now) as { expiry: number | null };
      let next: number | null = null;
      for (const version of targetVersions(config)) {
        const snapshot = this.snapshot(config, version);
        const key = this.key(config, version);
        const promptHash = consolidationPromptHash(config, version);
        const row = this.options.db.prepare(
          `SELECT MIN(CASE WHEN status = 'leased' THEN lease_expires_at ELSE due_at END) AS due_at
             FROM jobs WHERE kind = 'consolidate' AND memory_version = ?
             AND prompt_hash = ? AND config_epoch = ? AND work_key = ?
             AND ((status IN ('queued', 'retry_wait') AND attempt_count < 3) OR status = 'leased')`,
        ).get(version, promptHash, consolidationConfigEpoch(config, version),
          JSON.stringify(["consolidate", version, promptHash, this.inputRevision(config, version)])) as { due_at: number | null };
        let due: number | null = null;
        if (this.checkedKeys.get(version) !== key || row.due_at !== null) {
          due = Math.max(now, row.due_at ?? now, leased.expiry ?? now, busy.expiry ?? now);
        }
        if (snapshot.retentionDeadline !== null && snapshot.retentionDeadline > now) {
          due = due === null ? snapshot.retentionDeadline : Math.min(due, snapshot.retentionDeadline);
        }
        if (due !== null) next = next === null ? due : Math.min(next, due);
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
    const task = this.runTargets(config, retryBlocked);
    this.running = task;
    try { const results = await task; this.backoffUntil = 0; return results; }
    catch (error) {
      this.backoffUntil = this.options.now() + 60_000;
      this.options.onError?.(error);
      return [];
    }
    finally { this.running = null; this.trigger(); }
  }

  private async runTargets(config: MemoryConfig, retryBlocked: boolean): Promise<ConsolidationPassResult[]> {
    const results: ConsolidationPassResult[] = [];
    const versions = targetVersions(config);
    if (versions.length === 1) this.nextVersion = null;
    if (this.nextVersion && versions.includes(this.nextVersion) && versions[0] !== this.nextVersion) versions.reverse();
    let rotated = false;
    for (const version of versions) {
      const latest = this.config();
      if (this.stopped || !this.options.isForegroundIdle() || !latest ||
          !targetVersions(latest).includes(version) ||
          consolidationConfigEpoch(latest, version) !== consolidationConfigEpoch(config, version)) break;
      const pass = await this.run(config, version, retryBlocked);
      // Rotate the first dirty opportunity, rather than letting the second
      // writer's budget deferral put the selected version first again.
      if (versions.length > 1 && !rotated && pass.some(result => result.status !== "unchanged")) {
        this.nextVersion = version === "v1" ? "v2" : "v1";
        rotated = true;
      }
      results.push(...pass);
    }
    return results;
  }

  private async run(config: MemoryConfig, version: MemoryVersion, retryBlocked: boolean): Promise<ConsolidationPassResult[]> {
    const clock = this.options.now;
    const db = this.options.db;
    const busy = db.prepare("SELECT 1 FROM process_activity WHERE activity_state = 'active' AND expires_at > ? LIMIT 1").get(clock());
    if (busy) return [];
    // limits.maxStoreBytes pauses generation writes at the configured cap and
    // instead prunes old recovery copies; without a gate the store grows until
    // filesystem writes fail. checkedKeys records the pause so the idle timer
    // does not spin; any config change rotates the input revision and re-arms,
    // and capture resumes once the store is below the cap again.
    const storeCap = config.limits.maxStoreBytes;
    if (Number.isSafeInteger(storeCap) && storeCap > 0 && storeSizeBytes(this.options.root) >= storeCap) {
      this.checkedKeys.set(version, this.key(config, version));
      try {
        cleanupGenerations({ db, root: this.options.root, now: clock(),
          pinnedGenerationIds: this.options.pinnedGenerationIds?.(), retainRecoveryCount: 0 });
      } catch (error) { this.options.onError?.(error); }
      return [{ status: "blocked", reason: "store_size_limit_reached" }];
    }
    const snapshot = this.snapshot(config, version);
    const promptHash = consolidationPromptHash(config, version);
    const lease = claimConsolidation(db, { memoryVersion: version, owner: randomUUID(), now: clock(), promptHash,
      configEpoch: consolidationConfigEpoch(config, version), inputRevisionHash: this.inputRevision(config, version), retryBlocked,
      modelRequired: snapshot.sources.length > 0 || snapshot.notes.length > 0, request: this.options.request });
    if (!lease) {
      // A contended input has not been checked; keep its global-lease expiry wake.
      if (!db.prepare("SELECT 1 FROM jobs WHERE kind = 'consolidate' AND status = 'leased' AND lease_expires_at > ?").get(clock())) {
        this.checkedKeys.set(version, this.key(config, version));
      }
      return [];
    }
    this.controller = new AbortController();
    let candidate: GenerationCandidate | undefined;
    try {
      candidate = prepareGenerationCandidate({ db, root: this.options.root, lease, snapshot, config,
        signal: this.controller.signal, clock });
      if (candidate.checkUnchanged()) {
        finishConsolidation(db, lease, "succeeded", null, clock(), clock(), { refundAttempt: true });
        this.checkedKeys.set(version, this.key(config, version));
        return [{ status: "unchanged" }];
      }
      if (!snapshot.sources.length && !snapshot.notes.length) candidate.writeMinimal();
      else {
        const port = this.options.modelPort();
        if (!port || !config.models.consolidate) {
          finishConsolidation(db, lease, "blocked", "model_not_configured", clock());
          this.checkedKeys.set(version, this.key(config, version));
          return [{ status: "blocked", reason: "model_not_configured" }];
        }
        let requestsStarted = 0;
        const result = await candidate.runWriter({ modelRef: config.models.consolidate, port,
          onRequestStarted: () => { requestsStarted++; },
          canStartRequest: () => {
            if (this.stopped || !this.options.isForegroundIdle()) return "foreground_active";
            const latest = this.config();
            const current = this.snapshot(config, version);
            return latest && targetVersions(latest).includes(version) && consolidationPromptHash(latest, version) === promptHash &&
              consolidationConfigEpoch(latest, version) === consolidationConfigEpoch(config, version) &&
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
          this.checkedKeys.set(version, this.key(config, version));
          return [result];
        }
      }
      const published = candidate.publish();
      if (!published) finishConsolidation(db, lease, "superseded", "publication_cas", clock());
      this.checkedKeys.set(version, this.key(config, version));
      return [{ status: published ? "published" : "superseded" }];
    } catch (error) {
      const reason = (error as Error).message;
      finishConsolidation(db, lease, this.controller.signal.aborted ? "cancelled" : "blocked", reason, clock());
      this.checkedKeys.set(version, this.key(config, version));
      this.options.onError?.(error);
      return [{ status: this.controller.signal.aborted ? "cancelled" : "blocked", reason }];
    } finally {
      candidate?.dispose();
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
