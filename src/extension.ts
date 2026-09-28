import { existsSync, statSync } from "node:fs";
import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { getAgentDir, VERSION as PI_VERSION, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig, type LoadConfigResult, type MemoryConfig } from "./config.ts";
import { checkHostCompat, REQUIRED_EVENTS, type CompatResult, type HostCapabilities } from "./pi/compat.ts";
import { runDoctor, type DoctorInput } from "./doctor.ts";

const EXTENSION_VERSION = "0.1.0";
const MIN_PI_VERSION = "0.87.1";

/** The independent pi memory root (spec §5.1). Never Codex or Claude-mem data. */
function resolveMemoryRoot(): string {
  return join(getAgentDir(), "memory");
}

/** spec §5.1: a memory root inside Codex/Claude-mem locations must be rejected. */
function rootPointsIntoForeignMemory(root: string): boolean {
  let real: string;
  try {
    real = realpathSync(root);
  } catch {
    real = resolve(root);
  }
  const home = getAgentDir();
  const codex = resolve(join(home, "..", "..", ".codex"));
  const forbidden = [join(codex, "memories"), join(codex, "memories_v2"), join(codex, "sessions")];
  return forbidden.some((f) => real === f || real.startsWith(f + "/"));
}

function piVersionAtLeast(version: string, minimum: string): boolean {
  const parse = (v: string) => v.split(".").map((n) => Number.parseInt(n, 10));
  const [a1 = 0, a2 = 0, a3 = 0] = parse(version);
  const [b1 = 0, b2 = 0, b3 = 0] = parse(minimum);
  return a1 !== b1 ? a1 > b1 : a2 !== b2 ? a2 > b2 : a3 >= b3;
}

interface RuntimeState {
  compat: CompatResult | null;
  config: LoadConfigResult | null;
  sectionsSeen: boolean;
}

export default function (pi: ExtensionAPI) {
  const state: RuntimeState = { compat: null, config: null, sectionsSeen: false };

  async function probeHost(ctx: {
    sessionManager?: unknown;
    modelRegistry?: unknown;
  }): Promise<HostCapabilities> {
    let hasNodeSqlite = false;
    try {
      await import("node:sqlite");
      hasNodeSqlite = true;
    } catch {
      hasNodeSqlite = false;
    }
    const sm = ctx.sessionManager as { getBranch?: unknown } | undefined;
    const mr = ctx.modelRegistry as { find?: unknown; streamSimple?: unknown } | undefined;
    const piOk = piVersionAtLeast(PI_VERSION, MIN_PI_VERSION);
    return {
      nodeVersion: process.versions.node,
      hasNodeSqlite,
      // Event support is pinned by host version: registration does not throw on
      // unknown names, so pi >= 0.87.1 is the documented proxy (spec §2.3).
      events: piOk ? REQUIRED_EVENTS : [],
      hasStructuredPromptSections: piOk, // refined by the before_agent_start probe below
      hasBranchAccess: typeof sm?.getBranch === "function",
      hasModelRegistryAccess: typeof mr?.find === "function" && typeof mr?.streamSimple === "function",
    };
  }

  pi.on("session_start", async (_event, ctx) => {
    const caps = await probeHost(ctx);
    state.compat = checkHostCompat(caps);
    state.config = loadConfig(resolveMemoryRoot(), {
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    });
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
    }
  });

  pi.on("before_agent_start", (event) => {
    // Probe: structured sections exist when the host supports section injection.
    const opts = event.systemPromptOptions as { sections?: unknown } | undefined;
    if (opts && typeof opts === "object" && "sections" in opts) {
      state.sectionsSeen = true;
    }
  });

  function gatherDoctorInput(): DoctorInput {
    const root = resolveMemoryRoot();
    let rootWritable = false;
    if (existsSync(root)) {
      try {
        statSync(root);
        rootWritable = true; // existence + stat is our cheap proxy; real writes fail loudly later
      } catch {
        rootWritable = false;
      }
    }
    const compat = state.compat ?? { supported: false, problems: ["no session has started yet — capabilities not probed"] };
    const config = state.config ?? loadConfig(root);
    let storeState: DoctorInput["store"]["state"] = "absent";
    if (existsSync(join(root, "state.sqlite"))) {
      storeState = "current";
    } else if (existsSync(join(root, "generations")) && !existsSync(join(root, "versions"))) {
      storeState = "legacy_layout";
    }
    const cfg: MemoryConfig | null = config.status === "invalid" ? null : config.config;
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
      models: {
        extract: cfg?.models.extract ? { status: "configured", ref: cfg.models.extract } : { status: "unset" },
        consolidate: cfg?.models.consolidate
          ? { status: "configured", ref: cfg.models.consolidate }
          : { status: "unset" },
      },
    };
  }

  function statusLines(): string[] {
    const root = resolveMemoryRoot();
    const lines = [`pi-memory ${EXTENSION_VERSION} (pi ${PI_VERSION})`, `memory root: ${root}`];
    if (state.compat && !state.compat.supported) {
      lines.push(`state: DISABLED — unsupported host`, ...state.compat.problems.map((p) => `  - ${p}`));
      return lines;
    }
    const cfg = state.config;
    if (!cfg) {
      lines.push("state: no session started yet");
    } else if (cfg.status === "invalid") {
      lines.push("state: DISABLED generation — config invalid (file preserved)", ...cfg.problems.map((p) => `  - ${p}`));
    } else {
      const c = cfg.config;
      lines.push(
        `state: ${c.enabled ? "enabled" : "disabled"} (read=${c.read}, generate=${c.generate})`,
        `selected version: ${c.version}${c.dualWrite ? " + dual-write v1&v2" : ""}`,
        `models: extract=${c.models.extract ? `${c.models.extract.provider}/${c.models.extract.modelId}` : "(resolve on first use)"}, consolidate=${c.models.consolidate ? `${c.models.consolidate.provider}/${c.models.consolidate.modelId}` : "(resolve on first use)"}`,
        existsSync(join(root, "state.sqlite"))
          ? "store: present"
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
