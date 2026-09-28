import { existsSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const EXTENSION_VERSION = "0.1.0";

/** The independent pi memory root (spec §5.1). Never Codex or Claude-mem data. */
function resolveMemoryRoot(): string {
  return join(getAgentDir(), "memory");
}

function statusLines(): string[] {
  const root = resolveMemoryRoot();
  const storeExists = existsSync(join(root, "state.sqlite"));
  return [
    `pi-memory ${EXTENSION_VERSION}`,
    `memory root: ${root}`,
    storeExists
      ? "store: present"
      : "store: not initialized yet (capture and generation arrive in later milestones)",
    `upstream prompts: vendored (verify with: node scripts/verify-upstream.mjs)`,
  ];
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("memory", {
    description: "Pi Memory — persistent cross-session memory (status)",
    handler: async (args, ctx) => {
      const sub = args.trim().split(/\s+/).filter(Boolean)[0] ?? "status";
      if (sub !== "status") {
        if (ctx.hasUI) {
          ctx.ui.notify(`pi-memory: unknown subcommand "${sub}". Available: status`, "warning");
        }
        return;
      }
      if (ctx.hasUI) {
        ctx.ui.notify(statusLines().join("\n"), "info");
      }
      // Noninteractive modes stay silent: no status text on protocol stdout (spec §6.3).
    },
  });
}
