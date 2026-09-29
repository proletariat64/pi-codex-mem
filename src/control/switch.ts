import { updateConfig, type MemoryConfig, type MemoryVersion } from "../config.ts";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { enrollHistoricalImport, planHistoricalImport } from "../historical-import.ts";
import { createHash, randomUUID } from "node:crypto";
import { computeSessionKey } from "../identity.ts";
import { isExcludedWorkspace } from "../workspace-policy.ts";

export function setMemoryVersion(root: string, version: MemoryVersion) {
  if (version !== "v1" && version !== "v2") return { ok: false as const, reason: "version must be v1 or v2" };
  return updateConfig(root, config => ({ ...config, version }));
}

export function setDualWrite(root: string, enabled: boolean) {
  if (typeof enabled !== "boolean") return { ok: false as const, reason: "dual-write must be on or off" };
  return updateConfig(root, config => ({ ...config, dualWrite: enabled }));
}

/** Reconstruct only already enrolled active heads; original transcripts are never modified. */
export function recoverEnrolledSnapshots(input: { root: string; db: DatabaseSync; config: MemoryConfig; now: number }) {
  const { root, db, config, now } = input;
  const unavailable: string[] = []; const restored: string[] = []; let recovered = 0;
  if (!config.enabled || !config.generate) return { recovered, unavailable, restored };
  const sources = db.prepare(`SELECT r.source_id, r.session_key, r.snapshot_path, s.path, h.selected_leaf FROM source_revisions r
    JOIN branch_heads h ON h.session_key = r.session_key AND h.branch_id = r.branch_id
    JOIN sessions s ON s.session_key = r.session_key WHERE r.status = 'captured' AND h.state = 'active'
    AND h.latest_revision = r.source_id AND r.source_time >= ? ORDER BY r.source_id`)
    .all(now - config.schedule.maxSourceAgeDays * 86_400_000);
  for (const source of sources) {
    if (existsSync(String(source.snapshot_path))) continue;
    if (db.prepare("SELECT 1 FROM process_activity WHERE session_key = ? AND activity_state = 'active' AND expires_at > ?")
      .get(source.session_key!, now)) continue;
    const report = planHistoricalImport(String(source.path), { leaf: String(source.selected_leaf) });
    report.candidates = report.candidates.filter(candidate =>
      !isExcludedWorkspace(candidate.header.cwd, config.excludedWorkspaces) &&
      computeSessionKey(dirname(root), candidate.path, candidate.header.id) === source.session_key);
    const enrolled = enrollHistoricalImport(report, { root, agentDir: dirname(root), db,
      limits: { itemBytes: 65_536, toolResultBytes: config.limits.toolResultBytes, totalBytes: config.limits.inputBytes } });
    if (enrolled.imported) { recovered++; restored.push(String(source.source_id)); }
    else unavailable.push(String(source.source_id));
  }
  return { recovered, unavailable, restored };
}

export type VersionRunTarget = MemoryVersion | "both";
export interface VersionRunGrant { requestId: string; version: VersionRunTarget; policyHash: string }
const policyHash = (config: MemoryConfig) => createHash("sha256").update(JSON.stringify(config)).digest("hex");

export function createVersionRun(db: DatabaseSync, config: MemoryConfig, version: VersionRunTarget, now: number, skipIdle = false): VersionRunGrant {
  if (!config.enabled || !config.generate || !["v1", "v2", "both"].includes(version)) throw new Error("version_run_unavailable");
  const grant = { requestId: randomUUID(), version, policyHash: policyHash(config) };
  db.prepare("INSERT INTO version_run_grants (request_id, memory_version, policy_hash, skip_idle, status, created_at) VALUES (?, ?, ?, ?, 'active', ?)")
    .run(grant.requestId, version, grant.policyHash, skipIdle ? 1 : 0, now);
  return grant;
}

/** Fresh policy is checked before every request; cancelled grants cannot be revived by switching back. */
export function versionRunConfig(db: DatabaseSync, grant: VersionRunGrant, config: MemoryConfig | null): MemoryConfig | null {
  if (!db.prepare("SELECT 1 FROM version_run_grants WHERE request_id = ? AND status = 'active'").get(grant.requestId)) return null;
  if (!config?.enabled || !config.generate || policyHash(config) !== grant.policyHash) {
    db.prepare("UPDATE version_run_grants SET status = 'cancelled' WHERE request_id = ? AND status = 'active'").run(grant.requestId);
    return null;
  }
  return { ...config, version: grant.version === "both" ? config.version : grant.version, dualWrite: grant.version === "both" };
}

export function finishVersionRun(db: DatabaseSync, grant: VersionRunGrant, config: MemoryConfig | null): void {
  if (versionRunConfig(db, grant, config)) {
    db.prepare("UPDATE version_run_grants SET status = 'completed' WHERE request_id = ? AND status = 'active'").run(grant.requestId);
  }
}
