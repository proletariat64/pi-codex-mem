// pi-memory configuration: load, validate, atomically update (spec §14).
// This module is pure Node — no pi imports — so it is unit-testable and
// reusable from a future standalone CLI.

import { linkSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
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
  return { status: "ok", config: raw as MemoryConfig, path };
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
    const token = acquireLock(lockDir);
    if (!token) {
      return { status: "missing", path };
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
    const token = acquireLock(lockDir);
    if (!token) {
      briefSleep(25 * (i + 1));
      continue; // another process holds the control lock
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
      const tmp = `${path}.tmp-${process.pid}-${i}`;
      writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
      if (!verifyLockOwnership(lockDir, token)) {
        rmSync(tmp, { force: true });
        briefSleep(25 * (i + 1));
        continue;
      }
      renameSync(tmp, path);
      if (!verifyLockOwnership(lockDir, token)) {
        return { ok: false, reason: "control lock displaced during commit; re-run the command to reconcile" };
      }
      return { ok: true, config: next };
    } finally {
      releaseLock(lockDir, token);
    }
  }
  return { ok: false, reason: "config control lock held by another process" };
}

/**
 * Store control lock: a single FILE (config.json.lock) claimed atomically
 * via link(2) — the token is fully written to a temp file first, then
 * hard-linked into place; linkSync fails with EEXIST if the lock exists,
 * so creation and ownership are one atomic step with no mid-claim window
 * (a mkdir lock dir plus a separately-written owner file was observed to
 * admit overlapping holders under race; see tests/lock-race.test.ts).
 *
 * A lock is stale when its owner PID is dead, its Linux process-birth value
 * proves PID reuse, or its owner is unreadable and its mtime is old. A live
 * owner is NEVER expired by age: a writer could have passed its pre-commit
 * fence, so stealing its lock would allow a lost update. A hung live holder
 * requires manual intervention on platforms without process-birth evidence.
 * Breaking moves the lock aside and re-checks that moved instance (also
 * supports the pre-upgrade directory/owner format). Callers fence before
 * and after committing a write.
 */
const LOCK_STALE_MS = 30_000;
const LEGACY_LOCK_OWNER_FILE = "owner";

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but is not ours to signal.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** PID of the lock owner, or NaN when the content is missing/malformed. */
function ownerPid(content: string | undefined): number {
  if (!content) return NaN;
  const pid = Number(content.split(":")[0]);
  return Number.isInteger(pid) && pid > 0 ? pid : NaN;
}

function readLock(lockPath: string): string | undefined {
  try {
    return readFileSync(lockPath, "utf8");
  } catch {
    return undefined;
  }
}

/** Linux process birth from /proc, unlike PID alone, survives PID reuse. */
function processBirth(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? null;
  } catch {
    return null; // non-Linux or unavailable: fail closed for a live PID
  }
}

interface LockState { content: string | undefined; mtimeMs: number }

/** Read a file token or the pre-upgrade directory/owner format. */
function readLockState(path: string): LockState | undefined {
  try {
    const stat = statSync(path);
    let content: string | undefined;
    try {
      content = readFileSync(stat.isDirectory() ? join(path, LEGACY_LOCK_OWNER_FILE) : path, "utf8");
    } catch {
      content = undefined; // ownerless or unreadable; only break after age
    }
    return { content, mtimeMs: stat.mtimeMs };
  } catch {
    return undefined; // lock path vanished
  }
}

/** A verified dead owner or reused PID is stale; never age-break a live owner. */
function isStale({ content, mtimeMs }: LockState): boolean {
  const pid = ownerPid(content);
  if (!Number.isNaN(pid)) {
    if (!isPidAlive(pid)) return true;
    const claimedBirth = content!.split(":")[1];
    const actualBirth = processBirth(pid);
    return Boolean(/^\d+$/.test(claimedBirth ?? "") && actualBirth && claimedBirth !== actualBirth);
  }
  return Date.now() - mtimeMs > LOCK_STALE_MS;
}

/** Atomically claim the lock file; false when it already exists. */
function tryClaimFile(lockPath: string, token: string): boolean {
  const tmp = `${lockPath}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
  try {
    writeFileSync(tmp, token, { mode: 0o600 });
    linkSync(tmp, lockPath); // atomic; EEXIST when held
    return true;
  } catch {
    return false;
  } finally {
    rmSync(tmp, { force: true });
  }
}

export function acquireLock(lockPath: string): string | false {
  const token = `${process.pid}:${processBirth(process.pid) ?? "unknown"}:${randomBytes(8).toString("hex")}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (tryClaimFile(lockPath, token)) return token;
    // The first read may span two lock generations; the moved-file re-read
    // below is authoritative before we delete anything.
    const held = readLockState(lockPath);
    if (!held) continue; // vanished between claim and read
    if (!isStale(held)) return false;
    const trash = `${lockPath}.stale-${process.pid}-${randomBytes(8).toString("hex")}`;
    try {
      renameSync(lockPath, trash);
    } catch {
      continue; // another breaker moved it first
    }
    const moved = readLockState(trash);
    if (!moved || !isStale(moved)) {
      // A normal file can be restored with link(2) only if the path is still
      // vacant. rename(2) here would OVERWRITE a newer holder's lock.
      // Directory-format locks cannot be hard-linked: retain their moved
      // instance for manual reconciliation rather than risk replacement.
      try {
        if (statSync(trash).isFile()) {
          linkSync(trash, lockPath);
          rmSync(trash, { force: true });
        }
      } catch {
        // Newly claimed path or unreadable instance: retain trash intact.
      }
      return false;
    }
    rmSync(trash, { recursive: true, force: true });
    // Loop around to claim after discarding the verified stale instance.
    briefSleep(10 * (attempt + 1));
  }
  return false;
}

/** Fencing check: true only while the lock still belongs to this token. */
export function verifyLockOwnership(lockPath: string, token: string): boolean {
  return readLock(lockPath) === token;
}

/** Release only if we still own the lock — never delete another holder's. */
export function releaseLock(lockPath: string, token: string): void {
  if (verifyLockOwnership(lockPath, token)) {
    rmSync(lockPath, { force: true });
  }
}

/** Synchronous short sleep for lock contention backoff (ms). */
function briefSleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
