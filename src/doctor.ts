// Read-only diagnostics (spec §15: /memory doctor). Aggregates probe inputs
// gathered by the extension adapter into a report. Pure: no I/O, no model
// calls — the adapter performs those checks before calling this.

import type { CompatResult } from "./pi/compat.ts";
import type { LoadConfigResult, ModelRef } from "./config.ts";

export type ProbeStatus = "ok" | "warn" | "fail";

export interface DoctorProbe {
  id: string;
  label: string;
  status: ProbeStatus;
  detail: string;
}

export interface DoctorInput {
  compat: CompatResult;
  config: LoadConfigResult;
  paths: {
    memoryRoot: string;
    rootExists: boolean;
    rootWritable: boolean;
    /** Root points into Codex or Claude-mem data (spec §5.1: must be rejected). */
    rootIsCodex: boolean;
  };
  store: { state: "absent" | "current" | "legacy_layout" | "unavailable" };
  legacyControlLock?: string | null;
  models: {
    extract:
      | { status: "unset" }
      | { status: "configured"; ref: ModelRef; resolved: boolean };
    consolidate:
      | { status: "unset" }
      | { status: "configured"; ref: ModelRef; resolved: boolean };
  };
  /** Runtime observation of structured prompt sections (spec §2.3 probe). */
  promptSections: "confirmed" | "unobserved" | "unavailable";
}

export interface DoctorReport {
  ok: boolean;
  probes: DoctorProbe[];
  format(): string[];
}

function modelProbe(
  id: string,
  model: DoctorInput["models"]["extract"],
): DoctorProbe {
  if (model.status === "unset") {
    return {
      id,
      label: "model",
      status: "warn",
      detail: "not configured; the current foreground model becomes the default on first eligible use (spec §13)",
    };
  }
  const name = `${model.ref.provider}/${model.ref.modelId}`;
  return model.resolved
    ? { id, label: "model", status: "ok", detail: `${name} (resolves in pi's registry)` }
    : { id, label: "model", status: "fail", detail: `${name} does not resolve in pi's model registry` };
}

export function runDoctor(input: DoctorInput): DoctorReport {
  const probes: DoctorProbe[] = [];

  probes.push(
    input.compat.supported
      ? { id: "host", label: "host API", status: "ok", detail: "pi host capabilities satisfied" }
      : {
          id: "host",
          label: "host API",
          status: "fail",
          detail: `unsupported host — memory behavior disabled: ${input.compat.problems.join("; ")}`,
        },
  );

  const p = input.paths;
  probes.push(
    p.rootIsCodex
      ? {
          id: "paths",
          label: "paths",
          status: "fail",
          detail: `memory root ${p.memoryRoot} points into Codex/Claude-mem data — rejected (spec §5.1)`,
        }
      : !p.rootExists
        ? { id: "paths", label: "paths", status: "warn", detail: `memory root ${p.memoryRoot} does not exist yet` }
        : !p.rootWritable
          ? { id: "paths", label: "paths", status: "fail", detail: `memory root ${p.memoryRoot} is not writable` }
          : { id: "paths", label: "paths", status: "ok", detail: p.memoryRoot },
  );

  const c = input.config;
  if (c.status === "invalid") {
    probes.push({
      id: "config",
      label: "configuration",
      status: "fail",
      detail: `config.json invalid — file preserved, generation disabled: ${c.problems.join("; ")}`,
    });
  } else if (c.status === "missing") {
    probes.push({
      id: "config",
      label: "configuration",
      status: c.reason ? "fail" : "warn",
      detail: c.reason ?? "config.json not created yet — defaults will be written on first session",
    });
  } else {
    probes.push({
      id: "config",
      label: "configuration",
      status: "ok",
      detail:
        c.status === "created"
          ? "config.json created with defaults"
          : `valid (version=${c.config.version}, dualWrite=${c.config.dualWrite}, generate=${c.config.generate}, read=${c.config.read}, enabled=${c.config.enabled})`,
    });
  }

  if (input.legacyControlLock) {
    probes.push({
      id: "control-lock",
      label: "configuration upgrade",
      status: "fail",
      detail: `legacy control lock at ${input.legacyControlLock}; stop all pre-upgrade Pi processes and manually remove the lock`,
    });
  }

  const s = input.store;
  if (s.state === "legacy_layout") {
    probes.push({
      id: "store",
      label: "state store",
      status: "fail",
      detail: "legacy_layout_detected: unversioned generations/ layout is not supported; files preserved, generation disabled (spec §12.5)",
    });
  } else if (s.state === "unavailable") {
    probes.push({ id: "store", label: "state store", status: "fail", detail: "state.sqlite unavailable or corrupt; file preserved" });
  } else if (s.state === "absent") {
    probes.push({
      id: "store",
      label: "state store",
      status: "warn",
      detail: "state.sqlite not initialized — no sessions captured yet",
    });
  } else {
    probes.push({ id: "store", label: "state store", status: "ok", detail: "state.sqlite present" });
  }

  probes.push(modelProbe("model:extract", input.models.extract));
  probes.push(modelProbe("model:consolidate", input.models.consolidate));

  const ps = input.promptSections;
  probes.push(
    ps === "confirmed"
      ? { id: "prompt-sections", label: "prompt injection", status: "ok", detail: "structured system-prompt sections observed at runtime" }
      : ps === "unobserved"
        ? { id: "prompt-sections", label: "prompt injection", status: "warn", detail: "structured sections not yet observed (no foreground run this session)" }
        : { id: "prompt-sections", label: "prompt injection", status: "fail", detail: "host did not expose structured system-prompt sections — injection would fail" },
  );

  const ok = probes.every((probe) => probe.status !== "fail");
  return {
    ok,
    probes,
    format(): string[] {
      const icon = { ok: "✓", warn: "!", fail: "✗" } as const;
      return [
        `pi-memory doctor — ${ok ? "no blocking problems" : "BLOCKED (see failures)"}`,
        ...probes.map((probe) => `${icon[probe.status]} ${probe.id}: ${probe.detail}`),
      ];
    },
  };
}
