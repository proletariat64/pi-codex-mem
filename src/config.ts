// pi-memory configuration: load, validate, atomically update (spec §14).
// This module is pure Node — no pi imports — so it is unit-testable and
// reusable from a future standalone CLI.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

export type MemoryVersion = "v1" | "v2";
export type CaptureMode = "tui" | "rpc" | "json" | "print";

export interface ModelRef {
  provider: string;
  modelId: string;
}

export interface MemoryConfig {
  schemaVersion: 1;
  enabled: boolean;
  read: boolean;
  generate: boolean;
  version: MemoryVersion;
  dualWrite: boolean;
  captureModes: CaptureMode[];
  excludedWorkspaces: string[];
  models: { extract: ModelRef | null; consolidate: ModelRef | null };
  schedule: {
    minIdleMinutes: number;
    maxSourceAgeDays: number;
    maxExtractionsPerPass: number;
    extractionConcurrency: number;
    maxConsolidationSources: number;
    maxUnusedDays: number;
  };
  limits: {
    inputBytes: number;
    toolResultBytes: number;
    extractionOutputBytes: number;
    summaryBytes: number;
    v2RolloutSummaryBytes: number;
    toolResponseBytes: number;
    dailyInputTokens: number;
    dailyOutputTokens: number;
    dailyRequests: number;
    maxStoreBytes: number;
  };
  timezone: string;
}

export type LoadConfigResult =
  | { status: "ok"; config: MemoryConfig; path: string }
  | { status: "created"; config: MemoryConfig; path: string }
  | { status: "invalid"; problems: string[]; path: string };

export const CONFIG_FILE = "config.json";

export function defaultConfig(timezone: string): MemoryConfig {
  return {
    schemaVersion: 1,
    enabled: true,
    read: true,
    generate: true,
    version: "v1",
    dualWrite: false,
    captureModes: ["tui"],
    excludedWorkspaces: [],
    models: { extract: null, consolidate: null },
    schedule: {
      minIdleMinutes: 360,
      maxSourceAgeDays: 10,
      maxExtractionsPerPass: 2,
      extractionConcurrency: 2,
      maxConsolidationSources: 256,
      maxUnusedDays: 30,
    },
    limits: {
      inputBytes: 262144,
      toolResultBytes: 8192,
      extractionOutputBytes: 49152,
      summaryBytes: 9999,
      v2RolloutSummaryBytes: 9000,
      toolResponseBytes: 16384,
      dailyInputTokens: 100000,
      dailyOutputTokens: 20000,
      dailyRequests: 20,
      maxStoreBytes: 209715200,
    },
    timezone,
  };
}

/** Load config.json from the memory root, creating it with defaults on first run. */
export function loadConfig(root: string, opts?: { timezone?: string }): LoadConfigResult {
  const path = join(root, CONFIG_FILE);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    const config = defaultConfig(opts?.timezone ?? "UTC");
    writeConfigAtomic(path, config);
    return { status: "created", config, path };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    // Preserve the file; caller disables generation (spec §14).
    return { status: "invalid", problems: [`config.json is not valid JSON: ${(err as Error).message}`], path };
  }
  const problems = validateConfig(raw);
  if (problems.length > 0) {
    return { status: "invalid", problems, path };
  }
  return { status: "ok", config: raw as MemoryConfig, path };
}

/** Structural and range validation. Returns a list of human-readable problems. */
export function validateConfig(raw: unknown): string[] {
  const problems: string[] = [];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return ["config must be a JSON object"];
  }
  const c = raw as Record<string, unknown>;
  if (c.schemaVersion !== 1) {
    problems.push(`unsupported schemaVersion: ${JSON.stringify(c.schemaVersion)} (expected 1)`);
  }
  for (const flag of ["enabled", "read", "generate", "dualWrite"] as const) {
    if (typeof c[flag] !== "boolean") problems.push(`${flag} must be a boolean`);
  }
  if (c.version !== "v1" && c.version !== "v2") {
    problems.push(`version must be "v1" or "v2", got ${JSON.stringify(c.version)}`);
  }
  const modes = c.captureModes;
  if (!Array.isArray(modes) || modes.some((m) => !["tui", "rpc", "json", "print"].includes(m as string))) {
    problems.push(`captureModes must be an array of tui/rpc/json/print`);
  }
  if (!Array.isArray(c.excludedWorkspaces) || c.excludedWorkspaces.some((w) => typeof w !== "string")) {
    problems.push(`excludedWorkspaces must be an array of strings`);
  }
  const models = c.models as Record<string, unknown> | undefined;
  if (typeof models !== "object" || models === null) {
    problems.push(`models must be an object with extract/consolidate`);
  } else {
    for (const key of ["extract", "consolidate"] as const) {
      const m = models[key];
      if (m === null) continue;
      if (typeof m !== "object" || m === null) {
        problems.push(`models.${key} must be null or {provider, modelId}`);
        continue;
      }
      const ref = m as Record<string, unknown>;
      if (typeof ref.provider !== "string" || typeof ref.modelId !== "string") {
        problems.push(`models.${key} requires string provider and modelId`);
      }
    }
  }
  const schedule = c.schedule as Record<string, unknown> | undefined;
  if (typeof schedule !== "object" || schedule === null) {
    problems.push(`schedule must be an object`);
  } else {
    const ranges: Record<string, [number, number]> = {
      minIdleMinutes: [0, 100000],
      maxSourceAgeDays: [1, 3650],
      maxExtractionsPerPass: [1, 64],
      extractionConcurrency: [1, 16],
      maxConsolidationSources: [1, 4096],
      maxUnusedDays: [1, 3650],
    };
    for (const [key, [min, max]] of Object.entries(ranges)) {
      const v = schedule[key];
      if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) {
        problems.push(`schedule.${key} must be an integer in [${min}, ${max}], got ${JSON.stringify(v)}`);
      }
    }
  }
  const limits = c.limits as Record<string, unknown> | undefined;
  if (typeof limits !== "object" || limits === null) {
    problems.push(`limits must be an object`);
  } else {
    // Spec §14: the v2 caps cannot be raised via configuration.
    const ranges: Record<string, [number, number]> = {
      inputBytes: [1024, 2 ** 24],
      toolResultBytes: [256, 2 ** 20],
      extractionOutputBytes: [1024, 2 ** 20],
      summaryBytes: [1024, 9999],
      v2RolloutSummaryBytes: [1024, 9000],
      toolResponseBytes: [1024, 2 ** 20],
      dailyInputTokens: [100, 100000000],
      dailyOutputTokens: [100, 100000000],
      dailyRequests: [1, 10000],
      maxStoreBytes: [2 ** 20, 2 ** 34],
    };
    for (const [key, [min, max]] of Object.entries(ranges)) {
      const v = limits[key];
      if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) {
        problems.push(`limits.${key} must be an integer in [${min}, ${max}], got ${JSON.stringify(v)}`);
      }
    }
  }
  if (typeof c.timezone !== "string" || c.timezone.length === 0) {
    problems.push(`timezone must be a non-empty IANA timezone string`);
  }
  return problems;
}

/** Atomically write config.json (tmp file + rename). */
export function writeConfigAtomic(path: string, config: MemoryConfig): void {
  mkdirSync(dirnameOf(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, path);
}

function dirnameOf(path: string): string {
  return path.slice(0, path.length - CONFIG_FILE.length - 1) || ".";
}

function contentHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Read-modify-write one config field set under a content-hash CAS so
 * concurrent /memory commands cannot clobber each other (spec §5.4).
 * Retries by re-reading and re-applying the mutation. Mutation must be pure.
 */
export function updateConfig(
  root: string,
  mutate: (config: MemoryConfig) => MemoryConfig,
  opts?: { timezone?: string; maxAttempts?: number },
): { ok: true; config: MemoryConfig } | { ok: false; reason: string } {
  const attempts = opts?.maxAttempts ?? 5;
  for (let i = 0; i < attempts; i++) {
    const loaded = loadConfig(root, opts);
    if (loaded.status === "invalid") {
      return { ok: false, reason: `config invalid: ${loaded.problems.join("; ")}` };
    }
    const next = mutate(loaded.config);
    const problems = validateConfig(next);
    if (problems.length > 0) {
      return { ok: false, reason: `mutation produced invalid config: ${problems.join("; ")}` };
    }
    const beforeHash = contentHash(readFileSync(loaded.path, "utf8"));
    const serialized = JSON.stringify(next, null, 2) + "\n";
    // Write to tmp, then re-check the live file hash right before rename.
    mkdirSync(root, { recursive: true });
    const tmp = `${loaded.path}.tmp-${process.pid}`;
    writeFileSync(tmp, serialized, { mode: 0o600 });
    let currentHash: string;
    try {
      currentHash = contentHash(readFileSync(loaded.path, "utf8"));
    } catch {
      currentHash = "__missing__";
    }
    if (currentHash === beforeHash) {
      renameSync(tmp, loaded.path);
      return { ok: true, config: next };
    }
    // Lost the race: discard and retry with fresh content.
    try {
      renameSync(tmp, `${loaded.path}.stale-${process.pid}`);
    } catch {
      /* best effort */
    }
  }
  return { ok: false, reason: "config changed concurrently too many times" };
}
