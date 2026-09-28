import { randomUUID } from "node:crypto";
import { accessSync, constants as fsConstants, existsSync, lstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { join, resolve } from "node:path";
import { getAgentDir, VERSION as PI_VERSION, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext, type SessionHeader } from "@earendil-works/pi-coding-agent";
import { captureSettledSession, type CaptureResult } from "./capture.ts";
import { blockUncapturedLeaf, openStateDb, prunePrivacyRevoked, retireOtherHeads } from "./store/db.ts";
import { computeSessionKey } from "./identity.ts";
import { isExcludedWorkspace } from "./workspace-policy.ts";
import { enrollHistoricalImport, planHistoricalImport } from "./historical-import.ts";
import {
  formatModelRef,
  legacyLockRecovery,
  loadConfig,
  updateConfig,
  type LoadConfigResult,
  type MemoryConfig,
} from "./config.ts";
import {
  checkHostCompat,
  MIN_PI_VERSION,
  REQUIRED_EVENTS,
  semverAtLeast,
  type CompatResult,
  type HostCapabilities,
} from "./pi/compat.ts";
import { runDoctor, type DoctorInput } from "./doctor.ts";
import { clearProcessActivity, enqueueExtraction, extractionConfigEpoch, recordProcessActivity } from "./store/jobs.ts";
import { createRegistryModelPort } from "./extraction/model-port.ts";
import { ExtractionScheduler, targetVersions } from "./extraction/scheduler.ts";
import { v1PromptHash } from "./extraction/v1.ts";
import { v2PromptHash } from "./extraction/v2.ts";
import type { MemoryVersion } from "./config.ts";

const EXTENSION_VERSION = "0.1.0";

/** Parse command words without invoking a shell or splitting quoted paths. */
function importWords(text: string): string[] | null {
  const words: string[] = [];
  let word = "";
  let quote: "'" | '"' | null = null;
  let escaping = false;
  let started = false;
  for (const char of text) {
    if (escaping) { word += char; escaping = false; started = true; }
    else if (char === "\\") { escaping = true; }
    else if (quote) { if (char === quote) quote = null; else word += char; }
    else if (char === "'" || char === '"') { quote = char; started = true; }
    else if (/\s/u.test(char)) { if (started) words.push(word); word = ""; started = false; }
    else { word += char; started = true; }
  }
  if (quote || escaping) return null;
  if (started) words.push(word);
  return words;
}

/** Effective runtime mode (spec §6.3): flag > config-derived. */
type MemoryMode = "off" | "read" | "read-write";

/** The independent pi memory root (spec §5.1). Never Codex or Claude-mem data. */
function resolveMemoryRoot(): string {
  return join(getAgentDir(), "memory");
}

function legacyLockPath(root: string): string | null {
  const path = join(root, "config.json.lock");
  return existsSync(path) ? path : null;
}

/**
 * spec §5.1: a memory root inside Codex/Claude-mem locations must be rejected.
 * Computed from the home directory, not derived from the agent dir, so a
 * relocated PI_CODING_AGENT_DIR cannot confuse the check.
 */
function rootPointsIntoForeignMemory(root: string): boolean {
  let real: string;
  try {
    real = realpathSync(root);
  } catch {
    real = resolve(root);
  }
  const home = homedir();
  const forbidden = [
    join(home, ".codex", "memories"),
    join(home, ".codex", "memories_v2"),
    join(home, ".codex", "sessions"),
    join(home, ".claude-mem"),
  ];
  return forbidden.some((f) => real === f || real.startsWith(f + "/"));
}

/** Mode derived from configuration alone (spec §14 distinctions). */
function modeFromConfig(config: MemoryConfig): MemoryMode {
  if (!config.enabled) return "off";
  if (config.read && config.generate) return "read-write";
  if (config.read) return "read";
  return "off";
}

function describeMode(mode: MemoryMode, source: "flag" | "config"): string {
  return `${mode} (from ${source})`;
}

interface RuntimeState {
  compat: CompatResult | null;
  config: LoadConfigResult | null;
  promptSections: "confirmed" | "unobserved" | "unavailable";
  modelRegistry: { find?: unknown } | null;
  db: DatabaseSync | null;
  capture: CaptureResult | null;
  captureError: string | null;
}

export default function (pi: ExtensionAPI) {
  const state: RuntimeState = {
    compat: null,
    config: null,
    promptSections: "unobserved",
    modelRegistry: null,
    db: null,
    capture: null,
    captureError: null,
  };
  const activityOwner = randomUUID();
  let scheduler: ExtractionScheduler | null = null;
  let runtimePort: ReturnType<typeof createRegistryModelPort> | null = null;
  let heartbeat: NodeJS.Timeout | null = null;
  let privacyRetryTimer: NodeJS.Timeout | null = null;
  let privacyRetryCount = 0;
  let foregroundIdle = true;
  let activeCwd = "";
  let activeMode = "";

  pi.registerFlag("pi-memory-mode", {
    description: "Pi Memory runtime mode: off | read | read-write (overrides config)",
    type: "string",
  });

  function flagMode(): MemoryMode | undefined {
    const raw = pi.getFlag("pi-memory-mode");
    if (raw === "off" || raw === "read" || raw === "read-write") return raw;
    return undefined;
  }

  function effectiveMode(): { mode: MemoryMode; source: "flag" | "config" } {
    const flag = flagMode();
    if (flag) return { mode: flag, source: "flag" };
    const cfg = state.config;
    if (cfg && cfg.status !== "invalid" && cfg.status !== "missing") {
      return { mode: modeFromConfig(cfg.config), source: "config" };
    }
    return { mode: "off", source: "config" };
  }

  function eligibleExtractionConfig(root: string): MemoryConfig | null {
    const loaded = loadConfig(root, { create: false });
    if (loaded.status !== "ok") return null;
    const config = loaded.config;
    if (!config.enabled || !config.generate || flagMode() === "off" || flagMode() === "read" ||
        !config.captureModes.includes(activeMode as MemoryConfig["captureModes"][number]) ||
        isExcludedWorkspace(activeCwd, config.excludedWorkspaces)) return null;
    return config;
  }

  function ensureScheduler(ctx?: ExtensionContext): void {
    if (ctx?.modelRegistry && !runtimePort) runtimePort = createRegistryModelPort(ctx.modelRegistry);
    if (scheduler || !state.db || !state.compat?.supported || !runtimePort) return;
    const root = resolveMemoryRoot();
    if (rootPointsIntoForeignMemory(root) || legacyLockPath(root)) return;
    const port = runtimePort;
    scheduler = new ExtractionScheduler({ db: state.db, root, modelPort: () => port,
      now: Date.now, isForegroundIdle: () => foregroundIdle,
      onError: (err) => { state.captureError = `scheduler failed: ${(err as Error).message}`; },
      config: () => eligibleExtractionConfig(root),
    });
  }

  function triggerScheduler(): void { scheduler?.trigger(); }

  /** One-shot, bounded-backoff retry when another SQLite reader holds WAL frames. */
  function schedulePrivacyCleanup(root: string): void {
    if (privacyRetryTimer) return;
    const delay = Math.min(30_000, 1_000 * 2 ** Math.min(privacyRetryCount++, 5));
    privacyRetryTimer = setTimeout(() => {
      privacyRetryTimer = null;
      if (resolveMemoryRoot() !== root) return;
      try {
        if (state.db) prunePrivacyRevoked(state.db, root);
        else state.db = openStateDb(root);
        ensureScheduler();
        triggerScheduler();
        privacyRetryCount = 0;
        if (state.captureError?.startsWith("privacy cleanup deferred:")) state.captureError = null;
      } catch (err) {
        notePrivacyCleanupFailure(err, root);
      }
    }, delay);
    privacyRetryTimer.unref();
  }

  function notePrivacyCleanupFailure(error: unknown, root: string): boolean {
    const message = (error as Error).message;
    if (!message.startsWith("privacy WAL cleanup deferred")) return false;
    state.captureError = `privacy cleanup deferred: ${message}`;
    schedulePrivacyCleanup(root);
    return true;
  }

  function cancelPrivacyCleanup(): void {
    if (privacyRetryTimer) clearTimeout(privacyRetryTimer);
    privacyRetryTimer = null;
    privacyRetryCount = 0;
  }

  function markForegroundActive(ctx: ExtensionContext): void {
    foregroundIdle = false;
    scheduler?.foregroundStarted();
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = null;
    try {
      const header = ctx.sessionManager.getHeader();
      const file = ctx.sessionManager.getSessionFile();
      if (!state.db || !header || !file) return;
      const sessionKey = computeSessionKey(getAgentDir(), file, header.id);
      const beat = () => {
        try {
          if (state.db) recordProcessActivity(state.db, { owner: activityOwner, sessionKey,
            state: "active", now: Date.now() });
        } catch (err) {
          state.captureError = `activity heartbeat failed: ${(err as Error).message}`;
        }
      };
      beat();
      heartbeat = setInterval(beat, 30_000);
      heartbeat.unref();
    } catch {
      // Ephemeral/unavailable session metadata must not break the foreground run.
    }
  }

  function markForegroundSettled(): void {
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = null;
    foregroundIdle = true;
    try {
      if (state.db) clearProcessActivity(state.db, activityOwner);
      scheduler?.foregroundSettled();
    } catch (err) {
      state.captureError = `scheduler failed: ${(err as Error).message}`;
    }
  }

  async function probeHost(ctx: { sessionManager?: unknown; modelRegistry?: unknown }): Promise<HostCapabilities> {
    let hasNodeSqlite = false;
    try {
      await import("node:sqlite");
      hasNodeSqlite = true;
    } catch {
      hasNodeSqlite = false;
    }
    const sm = ctx.sessionManager as { getBranch?: unknown } | undefined;
    const mr = ctx.modelRegistry as { find?: unknown; streamSimple?: unknown } | undefined;
    const piOk = semverAtLeast(PI_VERSION, MIN_PI_VERSION);
    return {
      nodeVersion: process.versions.node,
      hasNodeSqlite,
      // Event support is pinned by host version: registration does not throw
      // on unknown names, so pi >= MIN_PI_VERSION is the documented proxy.
      events: piOk ? REQUIRED_EVENTS : [],
      // Refined at runtime by the before_agent_start probe below.
      hasStructuredPromptSections: piOk,
      hasBranchAccess: typeof sm?.getBranch === "function",
      hasModelRegistryAccess: typeof mr?.find === "function" && typeof mr?.streamSimple === "function",
    };
  }

  pi.on("session_start", async (_event, ctx) => {
    cancelPrivacyCleanup();
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = null;
    await scheduler?.stop();
    scheduler = null;
    runtimePort = null;
    if (state.db) clearProcessActivity(state.db, activityOwner);
    state.db?.close();
    state.db = null;
    state.capture = null;
    state.captureError = null;
    state.modelRegistry = (ctx as { modelRegistry?: { find?: unknown } }).modelRegistry ?? null;
    activeCwd = ctx.cwd;
    activeMode = ctx.mode;
    foregroundIdle = typeof ctx.isIdle === "function" ? ctx.isIdle() : true;
    // Per-session observations reset: a previous session's missing-sections
    // run must not poison this session's diagnostics.
    state.promptSections = "unobserved";
    const caps = await probeHost(ctx);
    state.compat = checkHostCompat(caps);
    const root = resolveMemoryRoot();
    // Reject foreign roots BEFORE any write: creating config.json inside
    // Codex/Claude-mem locations is exactly what spec §5.1 forbids.
    if (rootPointsIntoForeignMemory(root)) {
      state.compat = {
        supported: false,
        problems: [`memory root ${root} points into Codex/Claude-mem data — rejected (spec §5.1)`],
      };
      state.config = { status: "missing", path: join(root, "config.json") };
    } else {
      state.config = loadConfig(root, {
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
      });
      // On resume, a different selected leaf may be active before any new
      // agent_settled event. Revoke stale heads before future reads (§5.3).
      if (state.compat.supported && !legacyLockPath(root) && storeSchemaState(root) === "current") {
        try {
          state.db = openStateDb(root);
          const header = ctx.sessionManager.getHeader();
          const file = ctx.sessionManager.getSessionFile();
          if (header && file) {
            const key = computeSessionKey(getAgentDir(), file, header.id);
            const heads = state.db.prepare("SELECT selected_leaf FROM branch_heads WHERE session_key = ? AND state = 'active'")
              .all(key) as { selected_leaf: string }[];
            const ancestry = new Set(ctx.sessionManager.getBranch().map((entry) => entry.id));
            if (heads.some((head) => !ancestry.has(head.selected_leaf))) {
              retireOtherHeads(state.db, key, "");
            } else if (heads.some((head) => head.selected_leaf !== ctx.sessionManager.getLeafId())) {
              // The old leaf is still an ancestor, but appended edits or
              // decisions are not yet reflected in its captured projection.
              blockUncapturedLeaf(state.db, key, ctx.sessionManager.getLeafId());
            }
          }
        } catch (err) {
          if (!notePrivacyCleanupFailure(err, root)) {
            state.captureError = `resume reconciliation failed: ${(err as Error).message}`;
          }
        }
      }
    }
    const badFlag = pi.getFlag("pi-memory-mode");
    if (badFlag !== undefined && flagMode() === undefined && ctx.hasUI) {
      ctx.ui.notify(
        `pi-memory: ignoring invalid --pi-memory-mode "${String(badFlag)}" (expected off|read|read-write); using configured mode`,
        "warning",
      );
    }
    if (!state.compat.supported && ctx.hasUI) {
      // One diagnostic, then memory behavior stays disabled (spec §2.3).
      ctx.ui.notify(
        `pi-memory disabled — unsupported host:\n${state.compat.problems.join("\n")}`,
        "error",
      );
    } else if (state.config.status === "invalid" && ctx.hasUI) {
      ctx.ui.notify(
        `pi-memory: config.json invalid — file preserved, generation disabled:\n${state.config.problems.join("\n")}`,
        "warning",
      );
    } else if (state.config.status === "missing" && state.config.reason && ctx.hasUI) {
      ctx.ui.notify(`pi-memory: ${state.config.reason}; capture disabled`, "warning");
    }
    const legacy = legacyLockPath(root);
    if (legacy && ctx.hasUI && state.config.status !== "missing") {
      ctx.ui.notify(`pi-memory: ${legacyLockRecovery(legacy)}; configuration updates blocked`, "warning");
    }
    try {
      ensureScheduler(ctx);
      triggerScheduler();
    } catch (err) {
      state.captureError = `scheduler startup failed: ${(err as Error).message}`;
    }
  });

  function captureNow(ctx: ExtensionContext, options?: { busyTimeoutMs?: number }): void {
    const root = resolveMemoryRoot();
    if (!state.compat?.supported || rootPointsIntoForeignMemory(root) || legacyLockPath(root)) return;
    // §6.3: captureModes is independent of generate (which only controls
    // model calls). Explicit read/off flags must not write new evidence.
    const config = loadConfig(root, { create: false });
    if (config.status !== "ok" || !config.config.enabled ||
        !config.config.captureModes.includes(ctx.mode) ||
        isExcludedWorkspace(ctx.cwd, config.config.excludedWorkspaces) ||
        flagMode() === "off" || flagMode() === "read") return;
    try {
      if (!ctx.sessionManager.getSessionFile() || !ctx.sessionManager.getHeader() || !ctx.sessionManager.getLeafId()) {
        state.capture = { status: "ephemeral", reason: "persistent session header/path/leaf unavailable" };
        return;
      }
      state.db ??= openStateDb(root, options);
      state.capture = captureSettledSession({
        root, agentDir: getAgentDir(), cwd: ctx.cwd, mode: ctx.mode,
        reader: ctx.sessionManager, db: state.db,
        limits: {
          itemBytes: 64 * 1024,
          toolResultBytes: config.config.limits.toolResultBytes,
          totalBytes: config.config.limits.inputBytes,
        },
      });
      state.captureError = null;
      if (state.capture.status === "captured" && config.config.generate) {
        for (const version of targetVersions(config.config)) {
          enqueueExtraction(state.db, { sourceId: state.capture.sourceId,
            memoryVersion: version, promptHash: version === "v1" ? v1PromptHash() : v2PromptHash(),
            configEpoch: extractionConfigEpoch(config.config), now: Date.now() });
        }
      }
    } catch (err) {
      if (!notePrivacyCleanupFailure(err, root)) {
        state.captureError = `capture failed: ${(err as Error).message}`;
      }
      if (ctx.hasUI) ctx.ui.notify(`pi-memory: ${state.captureError}`, "warning");
    }
  }

  pi.on("agent_start", (_event, ctx) => markForegroundActive(ctx));
  pi.on("agent_settled", (_event, ctx) => {
    captureNow(ctx);
    // A brand-new memory root only creates its store on first capture.
    // Construct the scheduler now, before the settled transition arms its timer.
    try { ensureScheduler(ctx); }
    catch (err) { state.captureError = `scheduler startup failed: ${(err as Error).message}`; }
    markForegroundSettled();
  });
  pi.on("session_before_compact", (_event, ctx) => captureNow(ctx));

  pi.on("session_tree", (_event, ctx) => {
    const root = resolveMemoryRoot();
    if (!state.compat?.supported || rootPointsIntoForeignMemory(root) || legacyLockPath(root)) return;
    try {
      // A resumed session can navigate before its first settlement. Reopen
      // an initialized store rather than leaving the old head eligible.
      if (!state.db && storeSchemaState(root) === "current") state.db = openStateDb(root);
      if (!state.db) return;
      const header = ctx.sessionManager.getHeader();
      const file = ctx.sessionManager.getSessionFile();
      if (!header || !file) return;
      const key = computeSessionKey(getAgentDir(), file, header.id);
      // All previous selected heads are conservatively retired until the
      // new branch is captured and validated (§5.3, T08).
      retireOtherHeads(state.db, key, "");
      state.capture = null;
      scheduler?.trigger();
    } catch (err) {
      if (!notePrivacyCleanupFailure(err, root)) {
        state.captureError = `tree reconciliation failed: ${(err as Error).message}`;
      }
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    cancelPrivacyCleanup();
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = null;
    await scheduler?.stop();
    scheduler = null;
    try {
      if (state.db) {
        state.db.exec("PRAGMA busy_timeout = 100");
        clearProcessActivity(state.db, activityOwner);
      }
      captureNow(ctx, { busyTimeoutMs: 100 });
    } finally {
      cancelPrivacyCleanup();
      runtimePort = null;
      state.db?.close();
      state.db = null;
    }
  });

  pi.on("before_agent_start", (event, ctx) => {
    markForegroundActive(ctx);
    const opts = event.systemPromptOptions as { sections?: unknown } | undefined;
    if (opts && typeof opts === "object" && "sections" in opts) {
      state.promptSections = "confirmed";
    } else {
      // A real foreground run without structured sections: injection cannot
      // work here. Diagnose it (doctor reports this as unavailable) instead
      // of leaving the capability looking merely unobserved.
      state.promptSections = "unavailable";
    }
    // spec §5.4: sample configuration before each foreground run, so
    // mid-session edits take effect here rather than only at restart.
    // Read-only: never creates the file.
    const root = resolveMemoryRoot();
    state.config = loadConfig(root, { create: false });
    const cfg = state.config;
    if (state.compat?.supported && cfg.status === "ok" && cfg.config.enabled && cfg.config.generate &&
        ctx.model && cfg.config.captureModes.includes(ctx.mode) &&
        flagMode() !== "off" && flagMode() !== "read" &&
        !rootPointsIntoForeignMemory(root) && !legacyLockPath(root) &&
        !isExcludedWorkspace(ctx.cwd, cfg.config.excludedWorkspaces) &&
        (cfg.config.models.extract === null || cfg.config.models.consolidate === null)) {
      const ref = { provider: ctx.model.provider, modelId: ctx.model.id };
      const saved = updateConfig(root, (current) => ({ ...current,
        models: { extract: current.models.extract ?? ref, consolidate: current.models.consolidate ?? ref } }));
      if (saved.ok) state.config = { status: "ok", config: saved.config, path: join(root, "config.json") };
      else if (ctx.hasUI) ctx.ui.notify(`pi-memory: model default not saved — ${saved.reason}`, "warning");
    }
  });

  function storeSchemaState(root: string): "absent" | "current" | "unavailable" {
    const path = join(root, "state.sqlite");
    if (!existsSync(path)) return "absent";
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(path, { readOnly: true });
      const rows = db.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('schema_migrations', 'source_revisions')",
      ).all() as { name: string }[];
      return rows.length === 2 ? "current" : "absent";
    } catch {
      return "unavailable";
    } finally {
      db?.close();
    }
  }

  function gatherDoctorInput(): DoctorInput {
    const root = resolveMemoryRoot();
    let rootWritable = false;
    if (existsSync(root)) {
      try {
        accessSync(root, fsConstants.W_OK);
        rootWritable = true;
      } catch {
        rootWritable = false;
      }
    }
    const compat =
      state.compat ?? { supported: false, problems: ["no session has started yet — capabilities not probed"] };
    // Read-only and fresh: always re-read the file so mid-session edits are
    // reported accurately; never create config.json from the doctor path.
    const config = loadConfig(root, { create: false });
    let storeState: DoctorInput["store"]["state"] = "absent";
    storeState = storeSchemaState(root);
    if (storeState === "absent" && existsSync(join(root, "generations")) && !existsSync(join(root, "versions"))) {
      storeState = "legacy_layout";
    }
    const cfg: MemoryConfig | null =
      config.status === "ok" || config.status === "created" ? config.config : null;
    const resolveRef = (ref: { provider: string; modelId: string } | null) => {
      if (!ref) return { status: "unset" } as const;
      const find = state.modelRegistry?.find;
      const resolved =
        typeof find === "function"
          ? Boolean((find as (p: string, m: string) => unknown).call(state.modelRegistry, ref.provider, ref.modelId))
          : false;
      return { status: "configured", ref, resolved } as const;
    };
    return {
      compat,
      config,
      paths: {
        memoryRoot: root,
        rootExists: existsSync(root),
        rootWritable,
        rootIsCodex: rootPointsIntoForeignMemory(root),
      },
      store: { state: storeState },
      legacyControlLock: legacyLockPath(root),
      models: { extract: resolveRef(cfg?.models.extract ?? null), consolidate: resolveRef(cfg?.models.consolidate ?? null) },
      promptSections: state.promptSections,
    };
  }

  function extractionStatusLine(root: string, version: MemoryVersion): string {
    const storePath = join(root, "state.sqlite");
    if (!state.db && (storeSchemaState(root) !== "current" || lstatSync(storePath).isSymbolicLink())) {
      return `${version} extraction: not queued`;
    }
    const db = state.db ?? new DatabaseSync(storePath, { readOnly: true });
    try {
      const row = db.prepare(
        `SELECT j.status, j.error_code, j.due_at FROM jobs j
         JOIN source_revisions r ON r.source_id = j.source_id
         JOIN branch_heads h ON h.session_key = r.session_key AND h.branch_id = r.branch_id
         WHERE j.kind = 'extract' AND j.memory_version = ?
           AND h.state = 'active' AND h.latest_revision = r.source_id
         ORDER BY j.updated_at DESC LIMIT 1`,
      ).get(version) as { status: string; error_code: string | null; due_at: number } | undefined;
      if (!row) return `${version} extraction: not queued`;
      const outcome = row.status === "leased" ? "extracting" : row.status === "succeeded" ? "extracted" : row.status;
      const reason = row.error_code ? ` — ${row.error_code}` : "";
      const due = row.status === "retry_wait" ? ` (next due ${new Date(row.due_at).toISOString()})` : "";
      return `${version} extraction: ${outcome}${reason}${due}`;
    } catch {
      return `${version} extraction: store unavailable`;
    } finally {
      if (!state.db) db.close();
    }
  }

  function statusLines(): string[] {
    const root = resolveMemoryRoot();
    const lines = [`pi-memory ${EXTENSION_VERSION} (pi ${PI_VERSION})`, `memory root: ${root}`];
    const legacy = legacyLockPath(root);
    if (legacy) lines.push(`upgrade BLOCKED: ${legacyLockRecovery(legacy)}`);
    if (state.compat && !state.compat.supported) {
      lines.push(`state: DISABLED — unsupported host`, ...state.compat.problems.map((p) => `  - ${p}`));
      return lines;
    }
    const cfg = state.config;
    const { mode, source } = effectiveMode();
    if (!cfg || cfg.status === "missing") {
      lines.push(cfg?.status === "missing" && cfg.reason ? `state: DISABLED — ${cfg.reason}` : "state: no session started yet");
    } else if (cfg.status === "invalid") {
      lines.push("state: DISABLED generation — config invalid (file preserved)", ...cfg.problems.map((p) => `  - ${p}`));
    } else {
      const c = cfg.config;
      lines.push(
        `mode: ${describeMode(mode, source)}`,
        `selected version: ${c.version}${c.dualWrite ? " + dual-write v1&v2" : ""}`,
        `models: extract=${formatModelRef(c.models.extract)}, consolidate=${formatModelRef(c.models.consolidate)}`,
        storeSchemaState(root) === "current"
          ? "store: present"
          : storeSchemaState(root) === "unavailable"
            ? "store: unavailable or corrupt (preserved)"
            : "store: not initialized yet",
        state.capture?.status === "captured"
          ? `capture: captured (${state.capture.sourceId})`
          : state.capture?.status === "ephemeral"
            ? "capture: ephemeral (no persistent session)"
            : "capture: pending settlement",
        extractionStatusLine(root, "v1"),
        extractionStatusLine(root, "v2"),
        ...(state.captureError ? [`capture error: ${state.captureError}`] : []),
      );
    }
    return lines;
  }

  function selectedImportLeaf(file: string, header: SessionHeader): string | undefined {
    const root = resolveMemoryRoot();
    const storePath = join(root, "state.sqlite");
    if (!state.db) {
      if (storeSchemaState(root) !== "current" || lstatSync(storePath).isSymbolicLink()) return undefined;
    }
    const db = state.db ?? new DatabaseSync(storePath, { readOnly: true });
    try {
      const row = db.prepare(
        `SELECT h.selected_leaf FROM sessions s JOIN branch_heads h ON h.session_key = s.session_key
         WHERE s.path = ? AND s.header_id = ? AND h.state = 'active'
         ORDER BY s.last_activity_at DESC LIMIT 1`,
      ).get(file, header.id) as { selected_leaf: string } | undefined;
      return row?.selected_leaf;
    } finally {
      if (!state.db) db.close();
    }
  }

  async function runNow(ctx: ExtensionCommandContext): Promise<void> {
    const report = (text: string, level: "info" | "warning" = "info") => {
      if (ctx.hasUI) ctx.ui.notify(`pi-memory run: ${text}`, level);
    };
    const root = resolveMemoryRoot();
    const cfg = loadConfig(root, { create: false });
    if (!state.compat?.supported || rootPointsIntoForeignMemory(root) || legacyLockPath(root) ||
        cfg.status !== "ok" || !cfg.config.enabled || !cfg.config.generate ||
        !cfg.config.captureModes.includes(ctx.mode) ||
        flagMode() === "off" || flagMode() === "read" ||
        isExcludedWorkspace(ctx.cwd, cfg.config.excludedWorkspaces)) {
      report("blocked by host, configuration, mode, or workspace policy", "warning");
      return;
    }
    if (!ctx.isIdle() || !foregroundIdle) { report("foreground session is busy", "warning"); return; }
    if (!cfg.config.models.extract) {
      report("blocked: no extraction model configured", "warning"); return;
    }
    try {
      state.db ??= openStateDb(root);
      ensureScheduler(ctx);
      if (!scheduler) { report("scheduler unavailable", "warning"); return; }
      const results = await scheduler.runPass(true);
      let message = "no eligible settled sources";
      if (results.length) {
        message = results.map((result) => result.status === "budget_deferred"
          ? `${result.status} (${result.reason})` : result.status).join(", ");
      } else if (state.captureError?.startsWith("scheduler failed:")) {
        message = state.captureError;
      }
      report(message, message.startsWith("scheduler failed:") ? "warning" : "info");
    } catch (err) {
      notePrivacyCleanupFailure(err, root);
      report(`failed: ${(err as Error).message}`, "warning");
    }
  }

  pi.registerCommand("memory", {
    description: "Pi Memory — persistent cross-session memory (status, doctor, import, run)",
    handler: async (args, ctx) => {
      const sub = args.trim().split(/\s+/).filter(Boolean)[0] ?? "status";
      if (sub === "run") {
        if (args.trim() === "run --now") await runNow(ctx);
        else if (ctx.hasUI) ctx.ui.notify("usage: /memory run --now", "warning");
        return;
      }
      if (!ctx.hasUI) return; // No status text on protocol stdout (spec §6.3).
      if (sub === "status") {
        ctx.ui.notify(statusLines().join("\n"), "info");
      } else if (sub === "doctor") {
        const report = runDoctor(gatherDoctorInput());
        ctx.ui.notify(report.format().join("\n"), report.ok ? "info" : "warning");
      } else if (sub === "import") {
        const parts = importWords(args);
        const file = parts?.[1];
        const dryRun = parts?.includes("--dry-run") ?? false;
        const run = parts?.includes("--run") ?? false;
        if (!parts || !file || dryRun === run) {
          ctx.ui.notify("usage: /memory import <path> --dry-run|--run [--leaf ID]", "warning");
          return;
        }
        const leafIndex = parts.indexOf("--leaf");
        const leaf = leafIndex < 0 ? undefined : parts[leafIndex + 1];
        if (leafIndex >= 0 && (!leaf || leaf.startsWith("--"))) {
          ctx.ui.notify("--leaf requires an entry ID", "warning");
          return;
        }
        try {
          const report = planHistoricalImport(resolve(ctx.cwd, file), {
            leaf,
            resolveSelectedLeaf: selectedImportLeaf,
          });
          const root = resolveMemoryRoot();
          const cfg = loadConfig(root, { create: false });
          const excluded = cfg.status === "ok" ? report.candidates.filter((candidate) =>
            isExcludedWorkspace(candidate.header.cwd, cfg.config.excludedWorkspaces)) : [];
          const eligible = cfg.status === "ok" ? report.candidates.filter((candidate) => !excluded.includes(candidate)) : [];
          const lines = [`candidates: ${eligible.length}`, `bytes: ${report.totalBytes}`];
          if (cfg.status !== "ok") {
            lines.push(`parsed candidates: ${report.candidates.length}; eligibility not confirmed: configuration ${cfg.status}`);
            for (const item of report.candidates) lines.push(`${item.path}: parsed leaf ${item.leafId}; not eligible until configuration is valid`);
          }
          for (const item of eligible) {
            lines.push(`${item.path}: leaf ${item.leafId}; scope: ${item.workspace.repoKey ? `repo ${item.workspace.repoKey}` : `cwd ${item.workspace.cwdReal}`}; bytes: ${item.bytes}`);
          }
          for (const item of excluded) lines.push(`${item.path}: excluded workspace — not eligible`);
          for (const item of report.ambiguous) lines.push(`${item.path}: ambiguous leaves ${item.leaves.join(", ")}; use --leaf`);
          for (const item of report.unsupported) lines.push(`${item.path}: unsupported — ${item.reason}`);
          for (const item of report.deferred) lines.push(`${item.path}: deferred — ${item.reason}`);
          if (run) {
            if (!state.compat?.supported || rootPointsIntoForeignMemory(root) || legacyLockPath(root) || cfg.status !== "ok" ||
                !cfg.config.enabled || flagMode() === "off" || flagMode() === "read") {
              ctx.ui.notify("pi-memory: import blocked by unsupported host, memory root, legacy lock, configuration, or runtime mode", "warning");
              return;
            }
            if (eligible.length > 0) {
              state.db ??= openStateDb(root);
              const result = enrollHistoricalImport({ ...report, candidates: eligible }, {
                root, agentDir: getAgentDir(), db: state.db,
                limits: { itemBytes: 64 * 1024, toolResultBytes: cfg.config.limits.toolResultBytes,
                  totalBytes: cfg.config.limits.inputBytes },
              });
              lines.push(`imported: ${result.imported}`);
              for (const item of result.skipped) lines.push(`${item.path}: skipped — ${item.reason}`);
            } else {
              lines.push("imported: 0");
            }
          }
          ctx.ui.notify(lines.join("\n"), "info");
        } catch (err) {
          notePrivacyCleanupFailure(err, resolveMemoryRoot());
          ctx.ui.notify(`pi-memory import failed: ${(err as Error).message}`, "warning");
        }
      } else {
        ctx.ui.notify(`pi-memory: unknown subcommand "${sub}". Available: status, doctor, import, run`, "warning");
      }
    },
  });
}
