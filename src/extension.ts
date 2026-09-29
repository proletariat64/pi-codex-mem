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
  beginClear,
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
import { ConsolidationScheduler } from "./pipeline/scheduler.ts";
import { createConsolidationModelPort } from "./pipeline/model-port.ts";
import { acquireReadView, type MemoryReadView } from "./read/view.ts";
import { renderMemorySection } from "./read/inject.ts";
import { cleanupGenerations } from "./pipeline/publish.ts";
import { createMemoryTools, type MemoryConsumer } from "./read/tools.ts";
import { getPublishedGeneration } from "./store/consolidation.ts";
import { Type } from "typebox";
import { addNote, cleanupRevokedNotes, forgetNote, type NoteProvenance } from "./control/notes.ts";
import { clearMemoryStore, DELETION_LIMITS, forgetEvidence, resumeClear } from "./control/forget.ts";
import { createVersionRun, finishVersionRun, setDualWrite, setMemoryVersion, versionRunConfig, type VersionRunGrant, type VersionRunTarget } from "./control/switch.ts";

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
  promptSections: DoctorInput["promptSections"];
  modelRegistry: { find?: unknown } | null;
  db: DatabaseSync | null;
  capture: CaptureResult | null;
  captureError: string | null;
  readDiagnostic: string | null;
}

interface ExplicitMemoryRun {
  extraction: ExtractionScheduler;
  consolidation: ConsolidationScheduler | null;
  grant: VersionRunGrant;
  db: DatabaseSync;
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
    readDiagnostic: null,
  };
  const activityOwner = randomUUID();
  let scheduler: ExtractionScheduler | null = null;
  let consolidator: ConsolidationScheduler | null = null;
  let explicitRun: ExplicitMemoryRun | null = null;
  let runtimePort: ReturnType<typeof createRegistryModelPort> | null = null;
  let consolidationPort: ReturnType<typeof createConsolidationModelPort> | null = null;
  let readerPin: MemoryReadView | null = null;
  let foregroundRun: MemoryConsumer | null = null;
  let foregroundPrompt: string | null = null;
  let foregroundOptions: { sections?: unknown; forceSystemPrompt?: unknown } | null = null;
  let persistentCapture = true;
  let retentionTimer: NodeJS.Timeout | null = null;
  let heartbeat: NodeJS.Timeout | null = null;
  let privacyRetryTimer: NodeJS.Timeout | null = null;
  let privacyRetryCount = 0;
  let foregroundIdle = true;
  let activeCwd = "";
  let activeMode = "";

  for (const tool of createMemoryTools({ root: resolveMemoryRoot(), db: () => state.db,
    view: () => readerPin, consumer: () => foregroundRun,
    maxUnusedDays: () => state.config?.status === "ok" ? state.config.config.schedule.maxUnusedDays : 30 })) {
    pi.registerTool({ ...tool, async execute(id, args, signal, _update, ctx) {
      const root = resolveMemoryRoot(); const config = loadConfig(root, { create: false });
      if (!state.compat?.supported || !foregroundRun || config.status !== "ok" || !config.config.enabled ||
          !config.config.read || flagMode() === "off" || rootPointsIntoForeignMemory(root) ||
          legacyLockPath(root) || isExcludedWorkspace(ctx.cwd, config.config.excludedWorkspaces)) {
        return { content: [{ type: "text", text: "Memory unavailable." }],
          details: { items: [], truncated: false, cursor: null, error: "memory_unavailable" } };
      }
      return tool.execute(id, args, signal);
    } });
  }
  pi.registerTool({ name: "pi_memory_note", label: "Remember or correct memory",
    description: "Record a scoped remember/correct note only when the user explicitly asks to remember or correct something. Text is user evidence, not a trusted instruction. Host records triggering run and user-message provenance. No delete capability; use deterministic /memory forget note <note-id> commands for removal.",
    parameters: Type.Object({ action: Type.Union([Type.Literal("remember"), Type.Literal("correct")]),
      text: Type.String({ minLength: 1, maxLength: 16_384 }), scope: Type.String({ minLength: 1, maxLength: 1024 }) }, { additionalProperties: false }),
    async execute(_id, args, signal, _update, ctx) {
      try {
        if (signal?.aborted || !foregroundRun) throw new Error("memory_write_unavailable");
        const note = persistNote(ctx, args.action, args.text, args.scope, "tool");
        return { content: [{ type: "text", text: `Saved ${args.action} note ${note.noteId} (${note.scope}).` }],
          details: { noteId: note.noteId, action: args.action, scope: note.scope, readingBlocked: args.action === "correct" } };
      } catch (error) {
        const code = (error as Error).message === "invalid_note" ? "invalid_note" : "memory_write_unavailable";
        return { content: [{ type: "text", text: code }], details: { error: code } };
      }
    },
  });

  function writableNoteStore(ctx: ExtensionContext): { root: string; db: DatabaseSync } {
    const root = resolveMemoryRoot(); const config = loadConfig(root, { create: false });
    if (!state.compat?.supported || rootPointsIntoForeignMemory(root) || legacyLockPath(root) || config.status !== "ok" ||
        !config.config.enabled || flagMode() === "off" || flagMode() === "read" ||
        isExcludedWorkspace(ctx.cwd, config.config.excludedWorkspaces)) throw new Error("memory_write_unavailable");
    state.db ??= openStateDb(root);
    ensureScheduler(ctx);
    return { root, db: state.db };
  }
  function hostNoteProvenance(ctx: ExtensionContext, origin: "command" | "tool"): NoteProvenance {
    let consumerSession = foregroundRun?.consumerSession ?? null;
    let userMessageId: string | null = null;
    try {
      const file = ctx.sessionManager.getSessionFile(); const header = ctx.sessionManager.getHeader();
      if (file && header) consumerSession = computeSessionKey(getAgentDir(), file, header.id);
    } catch { /* A command outside a persisted foreground run has no transcript pointer. */ }
    if (origin === "tool" && foregroundPrompt !== null) {
      try {
        const latestUser = ctx.sessionManager.getBranch().findLast(entry => entry.type === "message" && entry.message.role === "user");
        if (latestUser?.type === "message" && latestUser.message.role === "user") {
          const content = latestUser.message.content;
          const text = typeof content === "string" ? content : content.filter(part => part.type === "text").map(part => part.text).join("\n");
          if (text === foregroundPrompt) userMessageId = latestUser.id;
        }
      } catch { /* No pointer is preferable to attributing this request to an older user message. */ }
    }
    return { consumerSession, runId: foregroundRun?.runId ?? null, userMessageId, origin };
  }
  function afterNoteChange(root: string, corrected: boolean): void {
    if (corrected) {
      readerPin = null;
      if (retentionTimer) clearTimeout(retentionTimer);
      retentionTimer = null;
      try { if (state.db) cleanupRevokedNotes({ root, db: state.db }); }
      catch {
        state.captureError = "privacy cleanup deferred: revoked views remain unavailable";
        schedulePrivacyCleanup(root);
      }
    }
    triggerScheduler();
  }
  function persistNote(ctx: ExtensionContext, action: "remember" | "correct", text: string, scope: string, origin: "command" | "tool") {
    const store = writableNoteStore(ctx);
    const resolvedScope = scope === "workspace" ? `workspace:${realpathSync(ctx.cwd)}` : scope;
    const note = addNote({ ...store, action, text, scope: resolvedScope, provenance: hostNoteProvenance(ctx, origin) });
    afterNoteChange(store.root, action === "correct");
    return note;
  }

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

  function eligibleGenerationConfig(root: string): MemoryConfig | null {
    if (!persistentCapture) return null;
    const loaded = loadConfig(root, { create: false });
    if (loaded.status !== "ok") return null;
    const config = loaded.config;
    if (!config.enabled || !config.generate || flagMode() === "off" || flagMode() === "read" ||
        isExcludedWorkspace(activeCwd, config.excludedWorkspaces)) return null;
    return config;
  }

  function eligibleExtractionConfig(root: string): MemoryConfig | null {
    const config = eligibleGenerationConfig(root);
    return config?.captureModes.includes(activeMode as MemoryConfig["captureModes"][number]) ? config : null;
  }

  function eligibleConsolidationConfig(root: string): MemoryConfig | null {
    const config = eligibleGenerationConfig(root);
    if (!config || !state.db) return null;
    if (config.captureModes.includes(activeMode as MemoryConfig["captureModes"][number])) return config;
    // Explicit notes must reconcile even when automatic transcript capture is disabled in this runtime.
    for (const version of targetVersions(config)) {
      const pending = state.db.prepare(`SELECT 1 FROM notes n
        LEFT JOIN note_applications a ON a.note_id = n.note_id AND a.memory_version = ?
        JOIN pipeline_state p ON p.memory_version = ?
        JOIN store_state s ON s.singleton = 1
        WHERE n.status = 'active' AND (a.note_id IS NULL OR a.note_hash != n.text_hash OR
          a.control_epoch != s.control_epoch OR p.active_generation_id IS NULL OR
          a.generation_id != p.active_generation_id) LIMIT 1`).get(version, version);
      const revoked = state.db.prepare(`SELECT 1 FROM pipeline_state WHERE memory_version = ? AND read_blocked = 1
        AND block_reason IN ('user_correction', 'note_forgotten', 'source_forgotten')`).get(version);
      if (pending || revoked) return config;
    }
    return null;
  }

  function ensureScheduler(ctx?: ExtensionContext): void {
    if (ctx?.modelRegistry && !runtimePort) runtimePort = createRegistryModelPort(ctx.modelRegistry);
    if (ctx?.modelRegistry && !consolidationPort) consolidationPort = createConsolidationModelPort(ctx.modelRegistry);
    if (!state.db || !state.compat?.supported || !runtimePort) return;
    const root = resolveMemoryRoot();
    if (rootPointsIntoForeignMemory(root) || legacyLockPath(root)) return;
    const port = runtimePort;
    if (!consolidator && consolidationPort) {
      const writerPort = consolidationPort;
      consolidator = new ConsolidationScheduler({ db: state.db, root, modelPort: () => writerPort,
        now: Date.now, isForegroundIdle: () => foregroundIdle,
        config: () => eligibleConsolidationConfig(root),
        pinnedGenerationIds: () => readerPin ? [readerPin.generationId] : [],
        onError: (err) => { state.captureError = `consolidation failed: ${(err as Error).message}`; },
      });
    }
    if (scheduler) return;
    scheduler = new ExtractionScheduler({ db: state.db, root, modelPort: () => port,
      now: Date.now, isForegroundIdle: () => foregroundIdle,
      onError: (err) => { state.captureError = `scheduler failed: ${(err as Error).message}`; },
      onResult: () => consolidator?.trigger(),
      config: () => eligibleExtractionConfig(root),
    });
  }

  function triggerScheduler(): void { scheduler?.trigger(); consolidator?.trigger(); explicitRun?.extraction.trigger(); }

  async function stopExplicitRun(): Promise<void> {
    if (!explicitRun) return;
    const run = explicitRun;
    const stopped = Promise.allSettled([run.extraction.stop(), run.consolidation?.stop()]);
    let timeout: number | undefined;
    try {
      timeout = Number(run.db.prepare("PRAGMA busy_timeout").get()!.timeout);
      run.db.exec("PRAGMA busy_timeout = 100");
      run.db.prepare("UPDATE version_run_grants SET status = 'cancelled' WHERE request_id = ? AND status = 'active'").run(run.grant.requestId);
    } catch (error) { state.captureError = `explicit run cleanup skipped: ${(error as Error).message}`; }
    finally {
      const failure = (await stopped).find(result => result.status === "rejected");
      if (failure?.status === "rejected") state.captureError = `explicit run cleanup skipped: ${String(failure.reason)}`;
      try { if (run.db.isOpen && timeout !== undefined) run.db.exec(`PRAGMA busy_timeout = ${timeout}`); }
      catch (error) { state.captureError = `explicit run cleanup skipped: ${(error as Error).message}`; }
    }
    if (explicitRun === run) explicitRun = null;
  }

  async function stopGeneration(ctx: ExtensionContext): Promise<void> {
    const previousError = state.captureError;
    try { state.db?.exec("PRAGMA busy_timeout = 100"); }
    catch (error) { state.captureError = `background cleanup skipped: ${(error as Error).message}`; }
    const results = await Promise.allSettled([scheduler?.stop(), consolidator?.stop(), stopExplicitRun()]);
    const failure = results.find(result => result.status === "rejected");
    if (failure?.status === "rejected") state.captureError = `background cleanup skipped: ${String(failure.reason)}`;
    if (state.captureError && state.captureError !== previousError && ctx.hasUI) ctx.ui.notify(`pi-memory: ${state.captureError}`, "warning");
  }

  function armReaderRetention(): void {
    if (retentionTimer) clearTimeout(retentionTimer);
    retentionTimer = null;
    const pin = readerPin;
    if (!pin || pin.retentionDeadline === null) return;
    retentionTimer = setTimeout(() => {
      retentionTimer = null;
      if (readerPin !== pin) return;
      try {
        const live = state.db ? getPublishedGeneration(state.db, pin.memoryVersion, Date.now(),
          { generationId: pin.generationId, maxUnusedDays: state.config?.status === "ok" ? state.config.config.schedule.maxUnusedDays : 30,
            extractionPromptHash: pin.extractionPromptHash }) : null;
        if (live && live.controlEpoch === pin.controlEpoch && live.manifestHash === pin.manifestHash) {
          pin.retentionDeadline = live.retentionDeadline;
          armReaderRetention();
          return;
        }
      } catch { /* An unavailable store cannot keep a cached view readable. */ }
      readerPin = null;
      consolidator?.trigger();
    }, Math.max(0, Math.min(2_147_483_647, pin.retentionDeadline - Date.now())));
    retentionTimer.unref();
  }

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
        cleanupGenerations({ db: state.db, root, now: Date.now(),
          pinnedGenerationIds: readerPin ? [readerPin.generationId] : [] });
        ensureScheduler();
        triggerScheduler();
        privacyRetryCount = 0;
        if (state.captureError?.startsWith("privacy cleanup deferred:")) state.captureError = null;
      } catch (err) {
        if (!notePrivacyCleanupFailure(err, root)) {
          state.captureError = "privacy cleanup deferred: storage cleanup unavailable; revoked views remain unavailable";
          schedulePrivacyCleanup(root);
        }
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
    consolidator?.foregroundStarted();
    explicitRun?.extraction.foregroundStarted();
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
    foregroundRun = null;
    foregroundPrompt = null;
    foregroundOptions = null;
    readerPin = null;
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = null;
    foregroundIdle = true;
    try {
      if (state.db) clearProcessActivity(state.db, activityOwner);
      scheduler?.foregroundSettled();
      consolidator?.foregroundSettled();
      explicitRun?.extraction.foregroundSettled();
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
    await stopGeneration(ctx);
    scheduler = null;
    consolidator = null;
    runtimePort = null;
    consolidationPort = null;
    readerPin = null;
    foregroundRun = null;
    foregroundOptions = null;
    if (retentionTimer) clearTimeout(retentionTimer);
    retentionTimer = null;
    try {
      if (state.db) { state.db.exec("PRAGMA busy_timeout = 100"); clearProcessActivity(state.db, activityOwner); }
    } catch (error) {
      if (ctx.hasUI) ctx.ui.notify(`pi-memory: previous session cleanup skipped: ${(error as Error).message}`, "warning");
    } finally { state.db?.close(); state.db = null; }
    state.capture = null;
    state.captureError = null;
    state.modelRegistry = (ctx as { modelRegistry?: { find?: unknown } }).modelRegistry ?? null;
    activeCwd = ctx.cwd;
    activeMode = ctx.mode;
    persistentCapture = true;
    try {
      if (typeof ctx.sessionManager.getSessionFile === "function" && typeof ctx.sessionManager.getHeader === "function") {
        persistentCapture = Boolean(ctx.sessionManager.getSessionFile() && ctx.sessionManager.getHeader());
      }
    } catch { persistentCapture = false; }
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
      if (state.compat.supported && !legacyLockPath(root) && existsSync(join(root, "clear.pending"))) {
        try {
          if (resumeClear(root).cleanupPending) state.captureError = "memory clear cleanup pending; memory remains disabled";
        } catch { state.captureError = "memory clear cleanup pending; memory remains disabled"; }
      }
      state.config = loadConfig(root, {
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
        create: state.compat.supported && persistentCapture && flagMode() !== "off" && flagMode() !== "read",
      });
      if (state.config.status === "invalid") state.captureError = state.config.problems.join("; ");
      else if (state.config.status === "missing" && state.config.reason) state.captureError = state.config.reason;
      if (!persistentCapture) state.capture = { status: "ephemeral", reason: "persistent session header/path unavailable" };
      if (storeSchemaState(root) === "unavailable") state.captureError = "memory store unavailable or corrupt; files preserved; generation disabled";
      // On resume, a different selected leaf may be active before any new
      // agent_settled event. Revoke stale heads before future reads (§5.3).
      if (state.compat.supported && persistentCapture && !legacyLockPath(root) && !existsSync(join(root, "clear.pending")) && storeSchemaState(root) === "current") {
        try {
          state.db = openStateDb(root);
          cleanupGenerations({ db: state.db, root, now: Date.now() });
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
    if (state.captureError && ctx.hasUI) ctx.ui.notify(`pi-memory: ${state.captureError}`, "warning");
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
      cleanupGenerations({ db: state.db, root, now: Date.now(),
        pinnedGenerationIds: readerPin ? [readerPin.generationId] : [] });
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

  function diagnosePromptConflict(ctx: ExtensionContext): boolean {
    if (foregroundOptions?.forceSystemPrompt === undefined) return false;
    const diagnosed = state.promptSections === "conflict";
    state.promptSections = "conflict"; readerPin = null;
    if (retentionTimer) clearTimeout(retentionTimer); retentionTimer = null;
    const sections = foregroundOptions.sections;
    if (sections && typeof sections === "object" && !Array.isArray(sections)) delete (sections as Record<string, string>).pi_memory;
    if (!diagnosed && ctx.hasUI) ctx.ui.notify("pi-memory: section_injection_conflict — another extension forced a full system prompt; memory injection disabled for this run", "warning");
    return true;
  }

  pi.on("agent_start", (_event, ctx) => { markForegroundActive(ctx); diagnosePromptConflict(ctx); });
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
      readerPin = null;
      state.capture = null;
      triggerScheduler();
    } catch (err) {
      if (!notePrivacyCleanupFailure(err, root)) {
        state.captureError = `tree reconciliation failed: ${(err as Error).message}`;
      }
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    foregroundRun = null;
    foregroundOptions = null;
    cancelPrivacyCleanup();
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = null;
    await stopGeneration(ctx);
    scheduler = null;
    consolidator = null;
    readerPin = null;
    if (retentionTimer) clearTimeout(retentionTimer);
    retentionTimer = null;
    try {
      if (state.db) {
        state.db.exec("PRAGMA busy_timeout = 100");
        clearProcessActivity(state.db, activityOwner);
      }
      captureNow(ctx, { busyTimeoutMs: 100 });
    } catch (error) {
      state.captureError = `shutdown cleanup skipped: ${(error as Error).message}`;
      if (ctx.hasUI) ctx.ui.notify(`pi-memory: ${state.captureError}`, "warning");
    } finally {
      cancelPrivacyCleanup();
      runtimePort = null;
      consolidationPort = null;
      state.db?.close();
      state.db = null;
    }
  });

  pi.on("before_agent_start", (event, ctx) => {
    markForegroundActive(ctx);
    let consumerSession: string = activityOwner;
    try {
      const file = ctx.sessionManager.getSessionFile(); const header = ctx.sessionManager.getHeader();
      if (file && header) consumerSession = computeSessionKey(getAgentDir(), file, header.id);
    } catch { /* Ephemeral sessions still get a process-local consumer identity. */ }
    foregroundRun = { consumerSession, runId: randomUUID() };
    foregroundPrompt = typeof event.prompt === "string" ? event.prompt : null;
    const opts = event.systemPromptOptions as { sections?: unknown; forceSystemPrompt?: unknown } | undefined;
    foregroundOptions = opts ?? null;
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
    if (state.compat?.supported && persistentCapture && cfg.status === "ok" && cfg.config.enabled && cfg.config.generate &&
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
    readerPin = null;
    state.readDiagnostic = null;
    if (retentionTimer) clearTimeout(retentionTimer);
    retentionTimer = null;
    const latest = state.config;
    if (diagnosePromptConflict(ctx)) return;
    const sections = opts?.sections;
    if (!sections || typeof sections !== "object" || Array.isArray(sections)) return;
    const sectionMap = sections as Record<string, string>;
    delete sectionMap.pi_memory;
    if (!state.compat?.supported || typeof ctx.cwd !== "string" || latest.status !== "ok" || !latest.config.enabled ||
        !latest.config.read || flagMode() === "off" || rootPointsIntoForeignMemory(root) ||
        legacyLockPath(root) || isExcludedWorkspace(ctx.cwd, latest.config.excludedWorkspaces)) return;
    let readerDb: DatabaseSync | undefined;
    try {
      if (!state.db) {
        const path = join(root, "state.sqlite");
        if (!existsSync(path) || lstatSync(path).isSymbolicLink()) return;
        readerDb = new DatabaseSync(path, { readOnly: true });
        readerDb.exec("PRAGMA busy_timeout = 50");
      }
      readerPin = acquireReadView({ db: state.db ?? readerDb!, root,
        memoryVersion: latest.config.version, summaryBytes: latest.config.limits.summaryBytes,
        maxUnusedDays: latest.config.schedule.maxUnusedDays,
        extractionPromptHash: latest.config.version === "v1" ? v1PromptHash() : v2PromptHash() });
      if (!readerPin) return;
      const section = renderMemorySection(readerPin, ctx.cwd);
      const usage = ctx.getContextUsage?.();
      const window = usage?.contextWindow ?? ctx.model?.contextWindow;
      // Same conservative byte/token margin as generation, independent of summaryBytes.
      if (window && Buffer.byteLength(section, "utf8") > Math.max(0, (window - (usage?.tokens ?? 0)) * 0.7 - 1024)) {
        state.readDiagnostic = "memory injection omitted: context_budget (generation remains valid)";
        if (ctx.hasUI) ctx.ui.notify(`pi-memory: ${state.readDiagnostic}`, "warning");
      } else {
        sectionMap.pi_memory = section;
      }
      armReaderRetention();
    } catch (readError) {
      // Fail open, but keep the failure visible to /memory doctor instead of
      // a fully silent injection loss (observed as a transient sqlite race
      // during the #16 smoke tests).
      state.readDiagnostic = `memory injection skipped: ${(readError as Error).message}`;
    }
    finally { readerDb?.close(); }
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
        `SELECT j.status, j.error_code, j.due_at, s.last_activity_at,
         COALESCE((SELECT skip_idle FROM version_run_grants g WHERE g.request_id = j.request_id AND g.status = 'active'), 0) AS skip_idle,
         (SELECT MAX(expires_at) FROM process_activity p WHERE p.session_key = r.session_key
           AND p.activity_state = 'active' AND p.expires_at > ?) AS busy_until FROM jobs j
         JOIN source_revisions r ON r.source_id = j.source_id
         JOIN sessions s ON s.session_key = r.session_key
         JOIN branch_heads h ON h.session_key = r.session_key AND h.branch_id = r.branch_id
         WHERE j.kind = 'extract' AND j.memory_version = ?
           AND h.state = 'active' AND h.latest_revision = r.source_id
         ORDER BY j.updated_at DESC LIMIT 1`,
      ).get(Date.now(), version) as { status: string; error_code: string | null; due_at: number;
        last_activity_at: number; busy_until: number | null; skip_idle: number } | undefined;
      if (!row) return `${version} extraction: not queued`;
      const outcome = row.status === "leased" ? "extracting" : row.status === "succeeded" ? "extracted" : row.status;
      const reason = row.error_code ? ` — ${row.error_code}` : "";
      const idleUntil = row.last_activity_at + (row.skip_idle ? 0 : state.config?.status === "ok" ? state.config.config.schedule.minIdleMinutes : 360) * 60_000;
      const nextDue = Math.max(row.due_at, idleUntil, row.busy_until ?? 0);
      const pending = row.status === "queued" && idleUntil > Date.now() ? "pending idle window; " : "";
      const due = ["queued", "retry_wait"].includes(row.status) ? ` (${pending}next due ${new Date(nextDue).toISOString()})` : "";
      return `${version} extraction: ${outcome}${reason}${due}`;
    } catch {
      return `${version} extraction: store unavailable`;
    } finally {
      if (!state.db) db.close();
    }
  }

  function statusLines(): string[] {
    const root = resolveMemoryRoot();
    state.config = loadConfig(root, { create: false });
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
      if (state.capture?.status === "ephemeral") lines.push("capture: ephemeral (no persistent session)");
    } else if (cfg.status === "invalid") {
      lines.push("state: DISABLED generation — config invalid (file preserved)", ...cfg.problems.map((p) => `  - ${p}`));
    } else {
      const c = cfg.config;
      const readiness = (["v1", "v2"] as const).map(version => pipelineReadiness(root, version));
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
        ...readiness,
        `generation targets: ${targetVersions(c).join(", ")}`,
        ...(c.dualWrite ? [`dual-write: ${readiness.every(line => line.endsWith(": published")) ? "published both" : "partial"}`] : []),
        ...(state.captureError ? [`capture error: ${state.captureError}`] : []),
        ...(state.readDiagnostic ? [state.readDiagnostic] : []),
      );
    }
    return lines;
  }

  function pipelineReadiness(root: string, version: MemoryVersion): string {
    if (storeSchemaState(root) !== "current") return `${version} readiness: warming_up`;
    let db: DatabaseSync | undefined;
    try {
      db = state.db ?? new DatabaseSync(join(root, "state.sqlite"), { readOnly: true });
      const pipeline = db.prepare("SELECT read_blocked, block_reason FROM pipeline_state WHERE memory_version = ?").get(version);
      if (pipeline?.read_blocked) return `${version} readiness: read invalidated (${pipeline.block_reason})`;
      const config = state.config;
      if (getPublishedGeneration(db, version, Date.now(), { maxUnusedDays: config?.status === "ok" ? config.config.schedule.maxUnusedDays : 30,
        extractionPromptHash: version === "v1" ? v1PromptHash() : v2PromptHash() })) {
        return `${version} readiness: published`;
      }
      const writer = db.prepare("SELECT status, error_code FROM jobs WHERE kind = 'consolidate' AND memory_version = ? ORDER BY updated_at DESC LIMIT 1").get(version);
      const extraction = db.prepare("SELECT status, error_code FROM jobs WHERE kind = 'extract' AND memory_version = ? ORDER BY updated_at DESC LIMIT 1").get(version);
      const captured = db.prepare("SELECT 1 FROM source_revisions WHERE status = 'captured' LIMIT 1").get();
      const progress = writer?.status === "leased" ? "; consolidating" : writer?.status === "blocked" ? `; blocked (${writer.error_code})`
        : extraction?.status === "leased" ? "; extracting" : extraction?.status === "blocked" ? `; blocked (${extraction.error_code})`
        : captured ? "; captured" : "";
      return `${version} readiness: warming_up${progress}`;
    } catch { return `${version} readiness: store unavailable`; }
    finally { if (db && db !== state.db) db.close(); }
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

  async function runNow(ctx: ExtensionCommandContext, version?: VersionRunTarget, force = false): Promise<void> {
    const report = (text: string, level: "info" | "warning" = "info") => {
      if (ctx.hasUI) ctx.ui.notify(`pi-memory run: ${text}`, level);
    };
    const root = resolveMemoryRoot();
    const cfg = loadConfig(root, { create: false });
    if (!state.compat?.supported || !persistentCapture || rootPointsIntoForeignMemory(root) || legacyLockPath(root) ||
        cfg.status !== "ok" || !cfg.config.enabled || !cfg.config.generate ||
        !cfg.config.captureModes.includes(ctx.mode) ||
        flagMode() === "off" || flagMode() === "read" ||
        isExcludedWorkspace(ctx.cwd, cfg.config.excludedWorkspaces)) {
      report("blocked by host, configuration, mode, or workspace policy", "warning");
      return;
    }
    if (!ctx.isIdle() || !foregroundIdle) { report("foreground session is busy", "warning"); return; }
    if (explicitRun) { report("another explicit pass is running", "warning"); return; }
    if (!cfg.config.models.extract) {
      report("blocked: no extraction model configured", "warning"); return;
    }
    let manual: ExplicitMemoryRun | null = null;
    let completed = false;
    try {
      state.db ??= openStateDb(root);
      ensureScheduler(ctx);
      if (!scheduler) { report("scheduler unavailable", "warning"); return; }
      let extraction = scheduler; let consolidation = consolidator;
      if (version || !force) {
        const db = state.db;
        const request = createVersionRun(db, cfg.config, version ?? (cfg.config.dualWrite ? "both" : cfg.config.version), Date.now(), force);
        const config = () => versionRunConfig(db, request, eligibleExtractionConfig(root));
        scheduler.foregroundStarted(); consolidator?.foregroundStarted();
        extraction = new ExtractionScheduler({ db, root, config, modelPort: () => runtimePort,
          now: Date.now, isForegroundIdle: () => foregroundIdle, request,
          onError: (err) => { state.captureError = `scheduler failed: ${(err as Error).message}`; },
          onPassComplete: async results => {
            completed = true;
            try {
              const consolidated = await consolidation?.runPass(true) ?? [];
              reportRunResults(results, consolidated);
            } finally {
              await Promise.all([extraction.stop(), consolidation?.stop()]);
              if (state.db === db) finishVersionRun(db, request, eligibleExtractionConfig(root));
              if (explicitRun?.grant.requestId === request.requestId) explicitRun = null;
              triggerScheduler();
            }
          } });
        consolidation = consolidationPort ? new ConsolidationScheduler({ db, root, config,
          modelPort: () => consolidationPort, now: Date.now, isForegroundIdle: () => foregroundIdle, request,
          pinnedGenerationIds: () => readerPin ? [readerPin.generationId] : [],
          onError: (err) => { state.captureError = `consolidation failed: ${(err as Error).message}`; } }) : null;
        manual = { extraction, consolidation, grant: request, db }; explicitRun = manual;
      }
      const results = await extraction.runPass(force);
      if (manual) {
        if (!completed) report(`queued bounded pass for ${manual.grant.version}; waiting for source idle, due time or lease`);
        return;
      }
      const consolidated = await consolidation?.runPass(true) ?? [];
      reportRunResults(results, consolidated);
    } catch (err) {
      if (manual) await stopExplicitRun();
      notePrivacyCleanupFailure(err, root);
      report(`failed: ${(err as Error).message}`, "warning");
    }

    function reportRunResults(results: Awaited<ReturnType<ExtractionScheduler["runPass"]>>,
      consolidated: Awaited<ReturnType<ConsolidationScheduler["runPass"]>>) {
      let message = "no eligible settled sources";
      if (results.length) {
        message = results.map((result) => result.status === "budget_deferred"
          ? `${result.status} (${result.reason})` : result.status).join(", ");
      } else if (state.captureError?.startsWith("scheduler failed:")) {
        message = state.captureError;
      }
      if (consolidated.length) message += `; consolidation: ${consolidated.map((result) =>
        result.reason ? `${result.status} (${result.reason})` : result.status).join(", ")}`;
      report(message, message.startsWith("scheduler failed:") ? "warning" : "info");
    }
  }

  pi.registerCommand("memory", {
    description: "Pi Memory — persistent cross-session memory (status, doctor, import, run, remember, correct, forget, clear)",
    handler: async (args, ctx) => {
      const sub = args.trim().split(/\s+/).filter(Boolean)[0] ?? "status";
      if (sub === "version" || sub === "dual-write") {
        const root = resolveMemoryRoot();
        const match = sub === "version" ? /^version\s+(v1|v2)$/.exec(args.trim()) : /^dual-write\s+(on|off)$/.exec(args.trim());
        if (!match) { if (ctx.hasUI) ctx.ui.notify(`usage: /memory ${sub} ${sub === "version" ? "v1|v2" : "on|off"}`, "warning"); return; }
        if (!state.compat?.supported || rootPointsIntoForeignMemory(root) || legacyLockPath(root)) {
          if (ctx.hasUI) ctx.ui.notify("pi-memory: configuration update unavailable", "warning"); return;
        }
        const saved = sub === "version" ? setMemoryVersion(root, match[1] as MemoryVersion) : setDualWrite(root, match[1] === "on");
        if (saved.ok) {
          state.config = { status: "ok", config: saved.config, path: join(root, "config.json") };
          ensureScheduler(ctx); triggerScheduler();
        }
        if (ctx.hasUI) ctx.ui.notify(saved.ok ? `pi-memory: ${sub} ${match[1]} saved; ${sub === "version"
          ? `${pipelineReadiness(root, saved.config.version)}; reading changes at the next foreground run`
          : `generation targets: ${targetVersions(saved.config).join(", ")}`}`
          : `pi-memory: ${saved.reason}`, saved.ok ? "info" : "warning");
        return;
      }
      if (sub === "remember" || sub === "correct") {
        const text = args.trim().slice(sub.length).trim();
        try {
          const note = persistNote(ctx, sub, text, "workspace", "command");
          if (ctx.hasUI) ctx.ui.notify(`pi-memory: saved ${sub} note ${note.noteId} (${note.scope}); consolidation follows generation settings`, "info");
        } catch (error) {
          if (ctx.hasUI) ctx.ui.notify(`pi-memory: ${(error as Error).message === "invalid_note" ? `usage: /memory ${sub} <text>` : "note write unavailable"}`, "warning");
        }
        return;
      }
      if (sub === "forget") {
        const match = /^forget\s+(note|source|session)\s+([A-Za-z0-9_-]{1,160})$/.exec(args.trim());
        if (!match) { if (ctx.hasUI) ctx.ui.notify(`usage: /memory forget source|session|note <concrete-id>. ${DELETION_LIMITS}`, "warning"); return; }
        try {
          const store = writableNoteStore(ctx);
          if (match[1] === "note") {
            const result = forgetNote({ ...store, noteId: match[2]! });
            if (result.removed) afterNoteChange(store.root, true);
            if (ctx.hasUI) ctx.ui.notify(`pi-memory: ${result.removed ? "removed" : "no active note found for"} ${result.noteId}. ${result.explanation} ${DELETION_LIMITS}`, "info");
          } else {
            const result = forgetEvidence({ ...store, kind: match[1] as "source" | "session", id: match[2]! });
            if (result.forgotten) afterNoteChange(store.root, true);
            if (result.cleanupPending) schedulePrivacyCleanup(store.root);
            if (ctx.hasUI) ctx.ui.notify(`pi-memory: ${result.forgotten ? "forgot" : "no enrolled target found for"} ${match[1]} ${match[2]}. ${result.cleanupPending ? "Cleanup pending; revoked views remain unavailable. " : ""}${result.explanation}`, result.cleanupPending ? "warning" : "info");
          }
        } catch { if (ctx.hasUI) ctx.ui.notify("pi-memory: removal unavailable; committed revocation remains effective", "warning"); }
        return;
      }
      if (sub === "clear") {
        if (args.trim() !== "clear --confirm") { if (ctx.hasUI) ctx.ui.notify(`usage: /memory clear --confirm. ${DELETION_LIMITS}`, "warning"); return; }
        const root = resolveMemoryRoot();
        if (!state.compat?.supported || rootPointsIntoForeignMemory(root) || legacyLockPath(root)) {
          if (ctx.hasUI) ctx.ui.notify("pi-memory: clear unavailable for this store", "warning"); return;
        }
        try {
          const disabled = beginClear(root);
          if (!disabled.ok) throw new Error(disabled.reason);
          readerPin = null; foregroundRun = null;
          if (retentionTimer) clearTimeout(retentionTimer); retentionTimer = null;
          cancelPrivacyCleanup();
          await scheduler?.stop(); await consolidator?.stop(); scheduler = null; consolidator = null;
          await stopExplicitRun();
          const db = state.db ?? openStateDb(root); state.db = null;
          const result = clearMemoryStore({ root, db, confirmed: true });
          state.config = loadConfig(root, { create: false }); state.capture = null;
          state.captureError = result.cleanupPending ? "memory clear cleanup pending; memory remains disabled" : null;
          if (ctx.hasUI) ctx.ui.notify(`pi-memory: ${result.cleanupPending ? "clear cleanup pending" : "memory cleared"}; capture, reading and generation disabled. ${result.explanation}`, result.cleanupPending ? "warning" : "info");
        } catch { if (ctx.hasUI) ctx.ui.notify("pi-memory: clear incomplete; retry after resolving configuration/storage errors. Files preserved for recovery.", "warning"); }
        return;
      }
      if (sub === "run") {
        const parts = args.trim().split(/\s+/).slice(1);
        let force = false; let version: VersionRunTarget | undefined; let valid = true;
        for (let index = 0; index < parts.length; index++) {
          if (parts[index] === "--now" && !force) force = true;
          else if (parts[index] === "--version" && !version && ["v1", "v2", "both"].includes(parts[index + 1] ?? "")) version = parts[++index] as VersionRunTarget;
          else { valid = false; break; }
        }
        if (valid) await runNow(ctx, version, force);
        else if (ctx.hasUI) ctx.ui.notify("usage: /memory run [--version v1|v2|both] [--now]", "warning");
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
