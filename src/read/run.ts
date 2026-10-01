import type { DatabaseSync } from "node:sqlite";
import type { MemoryVersion } from "../config.ts";
import { getPublishedGeneration } from "../store/consolidation.ts";
import { acquireReadView, type MemoryReadView } from "./view.ts";

export interface ForegroundDiagnostic {
  status: "disabled" | "error" | "active";
  reason: string;
  memoryVersion?: MemoryVersion;
  generationId?: string;
  representation?: string;
  counting?: string;
  warningCounts: Record<string, number>;
}
export interface ReadValidation { valid: boolean; reason: string; recoverable?: boolean; error?: boolean }

/** Recheck the pinned generation, not the current publication pointer. */
export function validateReadView(db: DatabaseSync, root: string, pin: MemoryReadView, maxUnusedDays: number,
  now = Date.now()): ReadValidation {
  try {
    const epoch = db.prepare("SELECT control_epoch FROM store_state WHERE singleton = 1").get()?.control_epoch;
    if (epoch !== pin.controlEpoch) return { valid: false, reason: "control_epoch_changed" };
    const pipeline = db.prepare("SELECT read_blocked, block_reason FROM pipeline_state WHERE memory_version = ?").get(pin.memoryVersion);
    if (pipeline?.read_blocked) return { valid: false, reason: String(pipeline.block_reason ?? "read_invalidated") };
    const generation = getPublishedGeneration(db, pin.memoryVersion, now, { generationId: pin.generationId,
      maxUnusedDays, extractionPromptHash: pin.extractionPromptHash });
    if (!generation) {
      const identity = db.prepare("SELECT status, manifest_hash, directory FROM generations WHERE generation_id = ? AND memory_version = ?")
        .get(pin.generationId, pin.memoryVersion);
      if (identity?.status !== "published" || identity.manifest_hash !== pin.manifestHash || identity.directory !== pin.directory) {
        return { valid: false, reason: "generation_ineligible" };
      }
      // Recovery is allowed only for proven expiry at the unchanged control epoch.
      // Branch retirement, deletion, unknown invalidity and prompt changes are not expiry.
      const expired = db.prepare(`SELECT 1 FROM generation_sources gs
        JOIN source_revisions r ON r.source_id = gs.source_id
        JOIN branch_heads h ON h.session_key = r.session_key AND h.branch_id = r.branch_id
        JOIN extractions e ON e.extraction_id = gs.extraction_id
        LEFT JOIN source_stats st ON st.lineage_key = r.lineage_key AND st.memory_version = ?
        WHERE gs.generation_id = ? AND r.status = 'captured' AND h.state = 'active'
          AND h.latest_revision = r.source_id AND e.prompt_hash = ?
          AND COALESCE(st.last_used_at, r.source_time) < ? LIMIT 1`).get(pin.memoryVersion, pin.generationId,
        pin.extractionPromptHash ?? "", now - maxUnusedDays * 86_400_000);
      const unsafe = db.prepare(`SELECT 1 FROM generation_sources gs
        JOIN source_revisions r ON r.source_id = gs.source_id
        JOIN branch_heads h ON h.session_key = r.session_key AND h.branch_id = r.branch_id
        JOIN extractions e ON e.extraction_id = gs.extraction_id
        WHERE gs.generation_id = ? AND (r.status != 'captured' OR h.state != 'active'
          OR h.latest_revision != r.source_id OR e.prompt_hash != ?) LIMIT 1`).get(pin.generationId, pin.extractionPromptHash ?? "");
      return expired && !unsafe ? { valid: false, reason: "retention_expired", recoverable: true }
        : { valid: false, reason: "generation_ineligible" };
    }
    if (generation.manifestHash !== pin.manifestHash || generation.directory !== pin.directory) {
      return { valid: false, reason: "pin_integrity", error: true };
    }
    let failureReason: string = "artifact_integrity";
    const fresh = acquireReadView({ db, root, memoryVersion: pin.memoryVersion, generationId: pin.generationId,
      maxUnusedDays, now, extractionPromptHash: pin.extractionPromptHash, onFailure: reason => { failureReason = reason; } });
    if (!fresh) return { valid: false, reason: failureReason, error: failureReason === "artifact_integrity" };
    if (fresh.manifestHash !== pin.manifestHash || fresh.summary !== pin.summary) {
      return { valid: false, reason: "artifact_integrity", error: true };
    }
    pin.retentionDeadline = fresh.retentionDeadline;
    return { valid: true, reason: "valid" };
  } catch { return { valid: false, reason: "validation_unavailable", error: true }; }
}

/** Pin and rendered cache have one owner and one synchronous invalidation seam. */
export class MemoryRunReader {
  pin: MemoryReadView | null = null;
  cache: { key: string; text: string | null; representation: string; reason: string; counting: string } | null = null;
  version: MemoryVersion | null = null;
  cwd = "";
  blocked = true;
  recoveryUsed = false;
  private recoveryEpoch: number | null = null;
  private warnings = new Set<string>();
  diagnostic: ForegroundDiagnostic = { status: "disabled", reason: "no_foreground_run", warningCounts: {} };

  report(status: ForegroundDiagnostic["status"], reason: string, extra: Partial<ForegroundDiagnostic> = {}): void {
    if (["summary_policy_clipped", "capacity_clipped", "budget_minimal", "context_budget", "capacity_unavailable", "capacity_exhausted", "carrier_overhead_exceeds_capacity", "counting_failed", "retention_expired", "mid_run_invalidated"].includes(reason)
      && !this.warnings.has(reason)) {
      this.warnings.add(reason);
      this.diagnostic.warningCounts[reason] = (this.diagnostic.warningCounts[reason] ?? 0) + 1;
    }
    this.diagnostic = { status, reason, warningCounts: this.diagnostic.warningCounts, ...extra };
  }
  begin(version: MemoryVersion | null, cwd: string): void {
    this.release(); this.version = version; this.cwd = cwd; this.blocked = false;
    this.recoveryUsed = false; this.warnings.clear();
    this.report("disabled", "preparing");
  }
  invalidate(reason: string, recoverable = false, error = false): void {
    const old = this.pin;
    this.pin = null; this.cache = null;
    this.recoveryEpoch = recoverable && !this.recoveryUsed && old ? old.controlEpoch : null;
    this.blocked = this.recoveryEpoch === null;
    this.report(error ? "error" : "disabled", reason);
    if (old) this.report(error ? "error" : "disabled", reason, {
      memoryVersion: old.memoryVersion, generationId: old.generationId });
    if (old && !this.warnings.has("mid_run_invalidated")) {
      this.warnings.add("mid_run_invalidated");
      this.diagnostic.warningCounts.mid_run_invalidated = (this.diagnostic.warningCounts.mid_run_invalidated ?? 0) + 1;
    }
  }
  recover(acquire: () => MemoryReadView | null): boolean {
    if (this.blocked || this.recoveryEpoch === null || this.recoveryUsed) return false;
    this.recoveryUsed = true;
    const epoch = this.recoveryEpoch; this.recoveryEpoch = null;
    const candidate = acquire();
    if (!candidate || candidate.memoryVersion !== this.version || candidate.controlEpoch !== epoch) {
      this.invalidate("recovery_failed"); return false;
    }
    this.pin = candidate; this.cache = null;
    return true;
  }
  release(): void {
    this.pin = null; this.cache = null; this.version = null; this.cwd = "";
    this.blocked = true; this.recoveryEpoch = null;
    this.report("disabled", "no_foreground_run");
  }
}
