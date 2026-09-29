import { createHash, randomUUID } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { MemoryConfig, MemoryVersion } from "../config.ts";
import type { SchedulerTimer } from "../extraction/scheduler.ts";
import { targetVersions } from "../extraction/scheduler.ts";
import { nextLocalDayTime } from "../store/jobs.ts";
import { claimConsolidation, finishConsolidation, getPublishedGeneration, selectConsolidation } from "../store/consolidation.ts";
import { consolidationPromptHash, runConsolidation } from "./consolidate.ts";
import type { ConsolidationModelPort } from "./model-port.ts";
import { buildStaging } from "./staging.ts";
import { cleanupGenerations, publishGeneration } from "./publish.ts";
import { generatedOutput, readWorkspaceUtf8, workspaceInventory } from "./workspace-tools.ts";
import { validateV1Artifacts, validateV2Artifacts, writeMinimalV1, writeMinimalV2 } from "./validate.ts";

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
      maxSources: Math.min(256, config.schedule.maxConsolidationSources), maxUnusedDays: config.schedule.maxUnusedDays });
  }

  private key(config: MemoryConfig, version: MemoryVersion): string {
    const snapshot = this.snapshot(config, version);
    let outputHashes: Record<string, string> | string = "unavailable";
    const generation = getPublishedGeneration(this.options.db, version, this.options.now(),
      { maxUnusedDays: config.schedule.maxUnusedDays });
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
    const snapshot = this.snapshot(config, version);
    const promptHash = consolidationPromptHash(config, version);
    const lease = claimConsolidation(db, { memoryVersion: version, owner: randomUUID(), now: clock(), promptHash,
      configEpoch: consolidationConfigEpoch(config, version), inputRevisionHash: this.inputRevision(config, version), retryBlocked,
      modelRequired: snapshot.sources.length > 0 || snapshot.notes.length > 0 });
    if (!lease) {
      // A contended input has not been checked; keep its global-lease expiry wake.
      if (!db.prepare("SELECT 1 FROM jobs WHERE kind = 'consolidate' AND status = 'leased' AND lease_expires_at > ?").get(clock())) {
        this.checkedKeys.set(version, this.key(config, version));
      }
      return [];
    }
    const validate = version === "v1" ? validateV1Artifacts : validateV2Artifacts;
    this.controller = new AbortController();
    let directory: string | undefined;
    try {
      const prior = snapshot.baseGenerationId ? db.prepare(
        "SELECT directory, manifest_hash FROM generations WHERE generation_id = ? AND memory_version = ? AND status = 'published'",
      ).get(snapshot.baseGenerationId, version) as { directory: string; manifest_hash: string } | undefined : undefined;
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
        validate({ directory, snapshot, summaryBytes: config.limits.summaryBytes });
        finishConsolidation(db, lease, "succeeded", null, clock(), clock(), { refundAttempt: true });
        this.checkedKeys.set(version, this.key(config, version));
        return [{ status: "unchanged" }];
      }
      if (!snapshot.sources.length && !snapshot.notes.length) (version === "v1" ? writeMinimalV1 : writeMinimalV2)(directory);
      else {
        const port = this.options.modelPort();
        if (!port || !config.models.consolidate) {
          finishConsolidation(db, lease, "blocked", "model_not_configured", clock());
          this.checkedKeys.set(version, this.key(config, version));
          return [{ status: "blocked", reason: "model_not_configured" }];
        }
        let requestsStarted = 0;
        const result = await runConsolidation({ db, directory, lease, config, modelRef: config.models.consolidate,
          port, signal: this.controller.signal, clock,
          onRequestStarted: () => { requestsStarted++; },
          validateOutputs: () => { validate({ directory: directory!, snapshot, summaryBytes: config.limits.summaryBytes }); },
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
      if (this.controller.signal.aborted) throw new Error("cancelled");
      const validated = validate({ directory, snapshot, summaryBytes: config.limits.summaryBytes });
      staged.manifest.fileHashes = validated.fileHashes;
      const manifestText = JSON.stringify(staged.manifest, null, 2) + "\n";
      writeFileSync(join(directory, "manifest.json"), manifestText, { mode: 0o600 });
      const published = publishGeneration({ db, root: this.options.root, stagingDir: directory,
        lease, snapshot, inputHash: staged.inputHash,
        manifestHash: createHash("sha256").update(manifestText).digest("hex"), now: clock });
      if (!published.published) finishConsolidation(db, lease, "superseded", "publication_cas", clock());
      this.checkedKeys.set(version, this.key(config, version));
      return [{ status: published.published ? "published" : "superseded" }];
    } catch (error) {
      const reason = (error as Error).message;
      finishConsolidation(db, lease, this.controller.signal.aborted ? "cancelled" : "blocked", reason, clock());
      this.checkedKeys.set(version, this.key(config, version));
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
