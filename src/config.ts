// pi-memory configuration: load, validate, atomically update (spec §14).
// This module is pure Node — no pi imports — so it is unit-testable and
// reusable from a future standalone CLI.

import { chmodSync, closeSync, constants as fsConstants, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";
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
  | { status: "missing"; path: string; reason?: string }
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
/** Parse + validate shared by the ordinary path and the under-lock create path. */
function parseAndValidate(text: string, path: string): LoadConfigResult {
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
  const config = raw as MemoryConfig;
  return { status: "ok", config: existsSync(join(dirname(path), "clear.pending"))
    ? { ...config, enabled: false, read: false, generate: false } : config, path };
}

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
    let token: string | false;
    try {
      token = acquireLock(lockDir);
    } catch (err) {
      return { status: "missing", path, reason: `control store unavailable: ${(err as Error).message}` };
    }
    if (!token) {
      return { status: "missing", path, reason: existsSync(lockDir) ? legacyLockRecovery(lockDir) : "config control lock busy" };
    }
    try {
      // Re-check under the lock: another process may have committed a
      // config while we waited. Adopt it instead of renaming defaults over.
      try {
        return parseAndValidate(readFileSync(path, "utf8"), path);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
          return {
            status: "invalid",
            problems: [`config.json exists but cannot be read (${(err as NodeJS.ErrnoException).code ?? "unknown"}); the file is preserved and generation is disabled`],
            path,
          };
        }
      }
      // Fence: if our lock was displaced by a stale-break race, do not write.
      if (!verifyLockOwnership(lockDir, token)) {
        return { status: "missing", path };
      }
      const config = defaultConfig(opts?.timezone ?? "UTC");
      writeConfigAtomic(path, config);
      // Post-commit fence: losing the lock mid-commit means a takeover may
      // have raced our write — fail loudly, never silently (spec §5.4).
      if (!verifyLockOwnership(lockDir, token)) {
        return {
          status: "invalid",
          problems: ["control lock was displaced during config creation; re-run the command to reconcile"],
          path,
        };
      }
      return { status: "created", config, path };
    } finally {
      releaseLock(lockDir, token);
    }
  }
  return parseAndValidate(text, path);
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
  syncPath(tmp);
  renameSync(tmp, path);
  syncPath(dirname(path));
}

function syncPath(path: string): void {
  const fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
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
  opts?: { timezone?: string; maxAttempts?: number; beginClear?: boolean },
): { ok: true; config: MemoryConfig } | { ok: false; reason: string } {
  if (!opts?.beginClear && existsSync(join(root, "clear.pending"))) {
    return { ok: false, reason: "memory clear cleanup pending; retry clear before changing memory configuration" };
  }
  const attempts = opts?.maxAttempts ?? 5;
  const lockDir = join(root, "config.json.lock");
  // The root may not exist yet (first-ever update): create it before
  // opening the control database, avoiding an ENOENT startup failure.
  mkdirSync(root, { recursive: true });
  for (let i = 0; i < attempts; i++) {
    let token: string | false;
    try {
      token = acquireLock(lockDir);
    } catch (err) {
      return { ok: false, reason: `control store unavailable: ${(err as Error).message}` };
    }
    if (!token) {
      if (existsSync(lockDir)) return { ok: false, reason: legacyLockRecovery(lockDir) };
      briefSleep(25 * (i + 1));
      continue; // another SQLite writer holds the control lock
    }
    try {
      // Fresh read under the lock: the mutation always applies to the
      // newest committed content. create:false avoids nested lock
      // acquisition; a missing file starts from in-memory defaults and is
      // created by the final write below.
      const path = join(root, CONFIG_FILE);
      let baseText: string | null;
      try {
        baseText = readFileSync(path, "utf8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          baseText = null;
        } else {
          return { ok: false, reason: `config unreadable (${(err as NodeJS.ErrnoException).code}); preserved` };
        }
      }
      const base = baseText === null ? null : parseAndValidate(baseText, path);
      if (base && base.status === "invalid") {
        return { ok: false, reason: `config invalid: ${base.problems.join("; ")}` };
      }
      const current =
        base === null ? defaultConfig(opts?.timezone ?? "UTC") : base.status === "ok" ? base.config : null;
      if (!current) return { ok: false, reason: "unexpected config state" };
      const next = mutate(current);
      if ((opts?.beginClear || existsSync(join(root, "clear.pending"))) && (next.enabled || next.read || next.generate)) {
        return { ok: false, reason: "memory clear cleanup pending; retry clear before enabling memory" };
      }
      const problems = validateConfig(next);
      if (problems.length > 0) {
        return { ok: false, reason: `mutation produced invalid config: ${problems.join("; ")}` };
      }
      // Commit protocol (spec §5.4): fence, content-hash CAS, fence, rename,
      // fence. rename() is kernel-atomic; the fences bracket it so a
      // displaced holder never commits silently.
      if (!verifyLockOwnership(lockDir, token)) {
        briefSleep(25 * (i + 1));
        continue;
      }
      let nowText: string | null;
      try {
        nowText = readFileSync(path, "utf8");
      } catch {
        nowText = null;
      }
      if (nowText !== baseText) {
        briefSleep(25 * (i + 1));
        continue; // content changed under us — reload and re-apply
      }
      if (opts?.beginClear) {
        const marker = join(root, "clear.pending");
        if (existsSync(marker)) {
          if (!lstatSync(marker).isFile() || readFileSync(marker, "utf8") !== "pi-memory-clear-v1\n") {
            return { ok: false, reason: "invalid clear recovery marker; preserve store for recovery" };
          }
        } else {
          const fd = openSync(marker, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
          try { writeFileSync(fd, "pi-memory-clear-v1\n"); fsyncSync(fd); } finally { closeSync(fd); }
          syncPath(root);
        }
      }
      const tmp = `${path}.tmp-${process.pid}-${i}`;
      writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
      syncPath(tmp);
      if (!verifyLockOwnership(lockDir, token)) {
        rmSync(tmp, { force: true });
        briefSleep(25 * (i + 1));
        continue;
      }
      renameSync(tmp, path);
      syncPath(root);
      if (!verifyLockOwnership(lockDir, token)) {
        return { ok: false, reason: "control lock displaced during commit; re-run the command to reconcile" };
      }
      // Revoke outstanding one-run grants under the same store-wide writer
      // lock. A switch away and back must not revive unconsumed requests.
      const held = heldLocks.get(token)!;
      if (JSON.stringify(current) !== JSON.stringify(next) &&
          held.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'version_run_grants'").get()) {
        held.db.prepare("UPDATE version_run_grants SET status = 'cancelled' WHERE status = 'active'").run();
        held.db.exec("COMMIT");
        held.committed = true;
      }
      return { ok: true, config: next };
    } finally {
      releaseLock(lockDir, token);
    }
  }
  return { ok: false, reason: "config control lock held by another process" };
}

/** The marker and disabled configuration share the same cross-process control lock. */
export function beginClear(root: string) {
  return updateConfig(root, config => ({ ...config, enabled: false, read: false, generate: false }), { beginClear: true });
}

/**
 * The SQLite write transaction is the control lock. BEGIN IMMEDIATE is an
 * atomic OS-backed claim across pi processes; process exit releases it, so
 * no PID, lease, stale-break, compare-and-unlink, or token-file race exists.
 * Configuration I/O happens while the transaction is open. state.sqlite is
 * also the shared store DB; its schema can be initialized later by capture.
 * Upgrade policy: stop all pre-SQLite pi processes and manually clear their
 * legacy config.json.lock file/directory. NEVER auto-delete that path: an
 * old process could replace it between inspection and deletion.
 */
const heldLocks = new Map<string, { db: DatabaseSync; lockPath: string; committed?: boolean }>();

export function legacyLockRecovery(lockPath: string): string {
  return `legacy control lock at ${lockPath}; stop all pre-upgrade pi processes, verify they have exited, then manually remove the legacy lock before retrying`;
}

export function acquireLock(lockPath: string): string | false {
  const root = dirname(lockPath);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  const dbPath = join(root, "state.sqlite");
  try {
    // Pre-create with 0600 before SQLite opens it (no transient 0644 file).
    closeSync(openSync(dbPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW, 0o600));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    if (!lstatSync(dbPath).isFile()) throw new Error("state.sqlite must be a regular file");
  }
  chmodSync(dbPath, 0o600);
  const db = new DatabaseSync(dbPath);
  try {
    // The installed Node 22.19+ SQLite API supports this pragma; a failed
    // immediate claim yields to the outer config retry loop.
    db.exec("PRAGMA busy_timeout = 0");
    db.exec("BEGIN IMMEDIATE");
  } catch (err) {
    db.close();
    if (/SQLITE_BUSY|database is locked/i.test((err as Error).message)) return false;
    throw err;
  }
  // A legacy guard is an explicit upgrade blocker, never an invitation to
  // auto-break it. A new old-version claimant after this check is excluded
  // by the operator's quiescent-upgrade precondition.
  if (existsSync(lockPath)) {
    db.exec("ROLLBACK");
    db.close();
    return false;
  }
  const token = `${process.pid}:${randomBytes(16).toString("hex")}`;
  heldLocks.set(token, { db, lockPath });
  return token;
}

/** A live connection with an IMMEDIATE transaction is our ownership fence. */
export function verifyLockOwnership(lockPath: string, token: string): boolean {
  const held = heldLocks.get(token);
  if (!held || held.lockPath !== lockPath) return false;
  try { held.db.prepare("SELECT 1").get(); return true; }
  catch { return false; }
}

/** Release only our exact connection; never unlink a successor's lock. */
export function releaseLock(lockPath: string, token: string): void {
  const held = heldLocks.get(token);
  if (!held || held.lockPath !== lockPath) return;
  heldLocks.delete(token);
  try { if (!held.committed) held.db.exec("ROLLBACK"); }
  finally { held.db.close(); }
}

/** Synchronous short sleep for lock contention backoff (ms). */
function briefSleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
