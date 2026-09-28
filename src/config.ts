// pi-memory configuration: load, validate, atomically update (spec §14).
// This module is pure Node — no pi imports — so it is unit-testable and
// reusable from a future standalone CLI.

import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

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
  | { status: "missing"; path: string }
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

/**
 * Load config.json from the memory root, creating it with defaults on first
 * run. Pass `create: false` from read-only paths (e.g. /memory doctor) to get
 * "missing" instead of writing a file.
 */
export function loadConfig(root: string, opts?: { timezone?: string; create?: boolean }): LoadConfigResult {
  const path = join(root, CONFIG_FILE);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      // The file exists but cannot be read (EACCES, EISDIR, …). Never treat
      // that as missing: creating defaults here would rename over the user's
      // settings. Preserve and report instead (spec §14).
      return {
        status: "invalid",
        problems: [`config.json exists but cannot be read (${code ?? "unknown error"}); the file is preserved and generation is disabled`],
        path,
      };
    }
    if (opts?.create === false) {
      return { status: "missing", path };
    }
    // Create under the same control lock updateConfig uses, so a locked
    // update in another process can never be renamed over (and vice versa).
    // If the lock is held, report missing rather than racing the writer.
    const lockDir = join(root, "config.json.lock");
    mkdirSync(root, { recursive: true });
    if (!acquireLock(lockDir)) {
      return { status: "missing", path };
    }
    try {
      // Re-check under the lock: another process may have committed a
      // config while we waited. Adopt it instead of renaming defaults over.
      try {
        const committed = readFileSync(path, "utf8");
        let raw: unknown;
        try {
          raw = JSON.parse(committed);
        } catch (err) {
          return { status: "invalid", problems: [`config.json is not valid JSON: ${(err as Error).message}`], path };
        }
        const problems = validateConfig(raw);
        return problems.length > 0
          ? { status: "invalid", problems, path }
          : { status: "ok", config: raw as MemoryConfig, path };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
          return {
            status: "invalid",
            problems: [`config.json exists but cannot be read (${(err as NodeJS.ErrnoException).code ?? "unknown"}); the file is preserved and generation is disabled`],
            path,
          };
        }
      }
      const config = defaultConfig(opts?.timezone ?? "UTC");
      writeConfigAtomic(path, config);
      return { status: "created", config, path };
    } finally {
      rmSync(lockDir, { recursive: true, force: true });
    }
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
    validateRanges("schedule", schedule, {
      minIdleMinutes: [0, 100000],
      maxSourceAgeDays: [1, 3650],
      maxExtractionsPerPass: [1, 64],
      extractionConcurrency: [1, 16],
      maxConsolidationSources: [1, 4096],
      maxUnusedDays: [1, 3650],
    }, problems);
  }
  const limits = c.limits as Record<string, unknown> | undefined;
  if (typeof limits !== "object" || limits === null) {
    problems.push(`limits must be an object`);
  } else {
    // Spec §14: the v2 caps cannot be raised via configuration.
    validateRanges("limits", limits, {
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
    }, problems);
  }
  if (typeof c.timezone !== "string" || c.timezone.length === 0 || !isValidTimezone(c.timezone)) {
    problems.push(`timezone must be a valid IANA timezone string, got ${JSON.stringify(c.timezone)}`);
  }
  return problems;
}

/** IANA timezone validation via Intl — rejects unrecognized names like Foo/Bar. */
function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function validateRanges(
  section: string,
  obj: Record<string, unknown>,
  ranges: Record<string, [number, number]>,
  problems: string[],
): void {
  for (const [key, [min, max]] of Object.entries(ranges)) {
    const v = obj[key];
    if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) {
      problems.push(`${section}.${key} must be an integer in [${min}, ${max}], got ${JSON.stringify(v)}`);
    }
  }
}

/** Canonical `provider/modelId` rendering for status and diagnostics. */
export function formatModelRef(ref: ModelRef | null): string {
  return ref ? `${ref.provider}/${ref.modelId}` : "(resolve on first use)";
}

/** Atomically write config.json (tmp file + rename). */
export function writeConfigAtomic(path: string, config: MemoryConfig): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, path);
}

/**
 * Read-modify-write one config field set under a short store-wide control
 * lock (spec §5.4). The mutation is applied to content read *while holding
 * the lock*, so a concurrent change can never be silently overwritten.
 * Mutation must be pure; on contention we wait briefly and retry.
 */
export function updateConfig(
  root: string,
  mutate: (config: MemoryConfig) => MemoryConfig,
  opts?: { timezone?: string; maxAttempts?: number },
): { ok: true; config: MemoryConfig } | { ok: false; reason: string } {
  const attempts = opts?.maxAttempts ?? 5;
  const lockDir = join(root, "config.json.lock");
  // The root may not exist yet (first-ever update): create it before
  // acquiring the lock, otherwise mkdir of the lock dir fails ENOENT and
  // the update would be misreported as lock contention.
  mkdirSync(root, { recursive: true });
  for (let i = 0; i < attempts; i++) {
    if (!acquireLock(lockDir)) {
      briefSleep(25 * (i + 1));
      continue; // another process holds the control lock
    }
    try {
      // Fresh read under the lock: the mutation always applies to the
      // newest committed content. create:false avoids nested lock
      // acquisition; a missing file starts from in-memory defaults and is
      // created by the final write below.
      const loaded = loadConfig(root, { ...opts, create: false });
      if (loaded.status === "invalid") {
        return { ok: false, reason: `config invalid: ${loaded.problems.join("; ")}` };
      }
      const current =
        loaded.status === "missing"
          ? defaultConfig(opts?.timezone ?? "UTC")
          : loaded.config;
      const next = mutate(current);
      const problems = validateConfig(next);
      if (problems.length > 0) {
        return { ok: false, reason: `mutation produced invalid config: ${problems.join("; ")}` };
      }
      writeConfigAtomic(join(root, CONFIG_FILE), next);
      return { ok: true, config: next };
    } finally {
      rmSync(lockDir, { recursive: true, force: true });
    }
  }
  return { ok: false, reason: "config control lock held by another process" };
}

/** Locks are held for milliseconds; anything older is a crashed holder. */
const LOCK_STALE_MS = 30_000;

/** Atomic lock via mkdir; breaks locks abandoned by crashed processes. Exported for concurrency tests. */
export function acquireLock(lockDir: string): boolean {
  try {
    mkdirSync(lockDir);
    return true;
  } catch {
    // exists — maybe stale
  }
  try {
    const held = statSync(lockDir);
    if (Date.now() - held.mtimeMs <= LOCK_STALE_MS) return false;
    // Break the stale lock without a TOCTOU race: move it aside atomically
    // and verify the moved directory is the SAME inode we statted. If it
    // isn't, we grabbed someone's fresh live lock — put it back and yield.
    const trash = `${lockDir}.stale-${process.pid}`;
    rmSync(trash, { recursive: true, force: true });
    try {
      renameSync(lockDir, trash);
    } catch {
      return false; // another breaker moved it first
    }
    if (statSync(trash).ino !== held.ino) {
      try {
        renameSync(trash, lockDir); // restore the live lock we disturbed
      } catch {
        // a third process already claimed the path; the lock survives as trash
      }
      return false;
    }
    rmSync(trash, { recursive: true, force: true });
    try {
      mkdirSync(lockDir);
      return true;
    } catch {
      return false; // another breaker won the recreate
    }
  } catch {
    return false;
  }
}

/** Synchronous short sleep for lock contention backoff (ms). */
function briefSleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
