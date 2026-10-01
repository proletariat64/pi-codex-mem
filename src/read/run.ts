import type { MemoryVersion } from "../config.ts";
import type { MemoryReadPin } from "./evidence.ts";
export type { ReadValidation } from "./evidence.ts";

import type { ForegroundDiagnostic, CarrierRepresentation, CarrierCounting } from "./carrier.ts";
export type { ForegroundDiagnostic } from "./carrier.ts";

const WARNING_REASONS = new Set(["summary_policy_clipped", "capacity_clipped", "budget_minimal", "context_budget", "capacity_unavailable", "capacity_exhausted", "carrier_overhead_exceeds_capacity", "counting_failed", "retention_expired", "mid_run_invalidated"]);

/** Pin and rendered cache have one owner and one synchronous invalidation seam. */
export class MemoryRunReader {
  pin: MemoryReadPin | null = null;
  cache: { key: string; text: string | null; representation: CarrierRepresentation; reason: string; counting: CarrierCounting } | null = null;
  version: MemoryVersion | null = null;
  cwd = "";
  blocked = true;
  recoveryUsed = false;
  private recoveryEpoch: number | null = null;
  private warnings = new Set<string>();
  diagnostic: ForegroundDiagnostic & { warningCounts: Record<string, number> } = { status: "disabled", reason: "no_foreground_run", warningCounts: {} };

  private warn(reason: string): void {
    if (this.warnings.has(reason)) return;
    this.warnings.add(reason);
    this.diagnostic.warningCounts[reason] = (this.diagnostic.warningCounts[reason] ?? 0) + 1;
  }
  report(status: ForegroundDiagnostic["status"], reason: string,
    extra: Partial<Omit<ForegroundDiagnostic, "warningCounts">> = {}): void {
    if (WARNING_REASONS.has(reason)) this.warn(reason);
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
    if (old) this.warn("mid_run_invalidated");
  }
  recover(acquire: () => MemoryReadPin | null): boolean {
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
