import { accessSync, constants as fsConstants, existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { join, resolve } from "node:path";
import { getAgentDir, VERSION as PI_VERSION, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  formatModelRef,
  legacyLockRecovery,
  loadConfig,
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

const EXTENSION_VERSION = "0.1.0";

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
}

export default function (pi: ExtensionAPI) {
  const state: RuntimeState = {
    compat: null,
    config: null,
    promptSections: "unobserved",
    modelRegistry: null,
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

  pi.on("before_agent_start", (event) => {
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
    state.config = loadConfig(resolveMemoryRoot(), { create: false });
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
            : "store: not initialized yet (capture arrives in a later milestone)",
      );
    }
    return lines;
  }

  pi.registerCommand("memory", {
    description: "Pi Memory — persistent cross-session memory (status, doctor)",
    handler: async (args, ctx) => {
      const sub = args.trim().split(/\s+/).filter(Boolean)[0] ?? "status";
      if (!ctx.hasUI) return; // No status text on protocol stdout (spec §6.3).
      if (sub === "status") {
        ctx.ui.notify(statusLines().join("\n"), "info");
      } else if (sub === "doctor") {
        const report = runDoctor(gatherDoctorInput());
        ctx.ui.notify(report.format().join("\n"), report.ok ? "info" : "warning");
      } else {
        ctx.ui.notify(`pi-memory: unknown subcommand "${sub}". Available: status, doctor`, "warning");
      }
    },
  });
}
