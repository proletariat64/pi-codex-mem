import type { MemoryVersion } from "../config.ts";

/** One attribution tag for carrier insertion, detection and removal. */
export const MEMORY_CARRIER_TYPE = "pi_memory";
export type CarrierRepresentation = "full" | "clipped" | "minimal" | "omitted";
export type CarrierCounting = "tokenizer" | "utf8_upper_estimate";

/** Metadata only; active means a carrier was actually projected. */
export interface ForegroundDiagnostic {
  status: "disabled" | "error" | "active";
  reason: string;
  memoryVersion?: MemoryVersion;
  generationId?: string;
  representation?: CarrierRepresentation;
  counting?: CarrierCounting;
  /** Read-only to diagnostic consumers; the run owner maintains the counts. */
  warningCounts?: Readonly<Record<string, number>>;
  /** Budget omission does not itself revoke the retrieval pin. */
  pinAvailable?: boolean;
}
