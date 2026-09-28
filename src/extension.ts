import { randomUUID } from "node:crypto";
import { accessSync, constants as fsConstants, existsSync, lstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { join, resolve } from "node:path";
import { getAgentDir, VERSION as PI_VERSION, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext, type SessionHeader } from "@earendil-works/pi-coding-agent";
import { captureSettledSession, type CaptureResult } from "./capture.ts";
import { blockUncapturedLeaf, openStateDb, retireOtherHeads } from "./store/db.ts";
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
import { claimDueExtractions, enqueueExtraction } from "./store/jobs.ts";
import { createRegistryModelPort } from "./extraction/model-port.ts";
import { runV1Extraction } from "./extraction/runner.ts";
import { v1PromptHash } from "./extraction/v1.ts";

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
    state.db?.close();
    state.db = null;
    state.capture = null;
    state.captureError = null;
    state.modelRegistry = (ctx as { modelRegistry?: { find?: unknown } }).modelRegistry ?? null;
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
          state.captureError = `resume reconciliation failed: ${(err as Error).message}`;
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
  });

  function captureNow(ctx: ExtensionContext): void {
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
      state.db ??= openStateDb(root);
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
        enqueueExtraction(state.db, { sourceId: state.capture.sourceId,
          memoryVersion: "v1", promptHash: v1PromptHash(), now: Date.now() });
      }
    } catch (err) {
      state.captureError = `capture failed: ${(err as Error).message}`;
      if (ctx.hasUI) ctx.ui.notify(`pi-memory: ${state.captureError}`, "warning");
    }
  }

  pi.on("agent_settled", (_event, ctx) => captureNow(ctx));
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
    } catch (err) {
      state.captureError = `tree reconciliation failed: ${(err as Error).message}`;
    }
  });

  pi.on("session_shutdown", (_event, ctx) => {
    try {
      captureNow(ctx);
    } finally {
      state.db?.close();
      state.db = null;
    }
  });

  pi.on("before_agent_start", (event, ctx) => {
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
        ctx.model && !rootPointsIntoForeignMemory(root) && !legacyLockPath(root) &&
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
          ? `capture: captured (${state.capture.sourceId}), pending idle window`
          : state.capture?.status === "ephemeral"
            ? "capture: ephemeral (no persistent session)"
            : "capture: pending settlement",
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
        flagMode() === "off" || flagMode() === "read" ||
        isExcludedWorkspace(ctx.cwd, cfg.config.excludedWorkspaces)) {
      report("blocked by host, configuration, mode, or workspace policy", "warning");
      return;
    }
    if (!ctx.isIdle()) { report("foreground session is busy", "warning"); return; }
    const ref = cfg.config.models.extract;
    if (!ref) { report("blocked: no extraction model configured", "warning"); return; }
    try {
      state.db ??= openStateDb(root);
      const active = state.db.prepare(
        `SELECT r.source_id FROM source_revisions r JOIN branch_heads h
         ON h.session_key = r.session_key AND h.branch_id = r.branch_id
         WHERE r.status = 'captured' AND h.state = 'active' AND h.latest_revision = r.source_id`,
      ).all() as { source_id: string }[];
      const now = Date.now();
      for (const row of active) enqueueExtraction(state.db, {
        sourceId: row.source_id, memoryVersion: "v1", promptHash: v1PromptHash(), now,
      });
      const jobs = claimDueExtractions(state.db, { owner: randomUUID(), now,
        limit: cfg.config.schedule.maxExtractionsPerPass, slots: cfg.config.schedule.extractionConcurrency,
        minIdleMs: 0, maxAgeMs: cfg.config.schedule.maxSourceAgeDays * 86_400_000 });
      if (!jobs.length) { report("no eligible settled sources"); return; }
      const port = createRegistryModelPort(ctx.modelRegistry);
      const results = await Promise.all(jobs.map(async (job) => {
        const controller = new AbortController();
        try {
          return await runV1Extraction({ db: state.db!, root, job, modelRef: ref, port,
            now, clock: Date.now, timezone: cfg.config.timezone,
            limits: { outputBytes: cfg.config.limits.extractionOutputBytes,
              dailyInputTokens: cfg.config.limits.dailyInputTokens,
              dailyOutputTokens: cfg.config.limits.dailyOutputTokens,
              dailyRequests: cfg.config.limits.dailyRequests }, signal: controller.signal });
        } finally {
          controller.abort();
        }
      }));
      report(results.map((result) => result.status === "budget_deferred"
        ? `${result.status} (${result.reason})` : result.status).join(", "));
    } catch (err) {
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
          ctx.ui.notify(`pi-memory import failed: ${(err as Error).message}`, "warning");
        }
      } else {
        ctx.ui.notify(`pi-memory: unknown subcommand "${sub}". Available: status, doctor, import, run`, "warning");
      }
    },
  });
}
