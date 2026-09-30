import type { MemoryConfig } from "./config.ts";

/**
 * Point-in-time runtime eligibility, not a lease or an authorization to commit.
 * Callers sample facts at existing check points and keep host/store safety,
 * session evidence validation, budgets and publication fences at their own seams.
 * A null config represents any load result other than status="ok".
 */
export type MemoryMode = "off" | "read" | "read-write";

export interface StoreAccessFacts {
  supported: boolean;
  foreignRoot: boolean;
  legacyLocked: boolean;
}

export interface ConfigFacts {
  config: Pick<MemoryConfig, "enabled" | "read" | "generate" | "captureModes"> | null;
  flag: MemoryMode | undefined;
}

export interface WorkspaceFacts extends ConfigFacts {
  workspaceExcluded: boolean;
}

export interface CaptureFacts extends WorkspaceFacts {
  mode: string;
}

export interface GenerationFacts extends WorkspaceFacts {
  persistent: boolean;
}

export interface ExtractionFacts extends GenerationFacts {
  mode: string;
}

/** Host/root safety, also used by management and privacy operations independently of config. */
export function canAccessStore(facts: StoreAccessFacts): boolean {
  return facts.supported && !facts.foreignRoot && !facts.legacyLocked;
}

/** A CLI read flag permits reads but never overrides disabled configuration. */
export function canReadMemory(facts: WorkspaceFacts): boolean {
  return facts.config !== null && facts.config.enabled && facts.config.read &&
    facts.flag !== "off" && !facts.workspaceExcluded;
}

function permitsEvidenceWrites(facts: ConfigFacts): boolean {
  return facts.config !== null && facts.config.enabled && facts.flag !== "off" && facts.flag !== "read";
}

/** Explicit notes do not require transcript capture, persistence or model generation. */
export function canWriteNote(facts: WorkspaceFacts): boolean {
  return permitsEvidenceWrites(facts) && !facts.workspaceExcluded;
}

export function canCaptureTranscript(facts: CaptureFacts): boolean {
  return canWriteNote(facts) && facts.config !== null && facts.config.captureModes.some(mode => mode === facts.mode);
}

/** Scheduler eligibility deliberately does not add a host/root check. */
export function canGenerateMemory(facts: GenerationFacts): boolean {
  return facts.persistent && canWriteNote(facts) && facts.config !== null && facts.config.generate;
}

export function canExtractMemory(facts: ExtractionFacts): boolean {
  return canGenerateMemory(facts) && canCaptureTranscript(facts);
}

/** Store queries remain at the caller; RPC notes can reconcile without capturing RPC transcripts. */
export function canConsolidateMemory(facts: ExtractionFacts, store: { available: boolean; reconciliationPending: boolean }): boolean {
  return canGenerateMemory(facts) && store.available &&
    (canCaptureTranscript(facts) || store.reconciliationPending);
}

/** Import filters source workspaces, not the current command's workspace. */
export function canImportHistory(facts: ConfigFacts): boolean {
  return permitsEvidenceWrites(facts);
}

/** Already inside the safe-root startup branch; a legacy lock is not a new creation gate. */
export function canCreateConfig(facts: { supported: boolean; persistent: boolean; flag: MemoryMode | undefined }): boolean {
  return facts.supported && facts.persistent && facts.flag !== "off" && facts.flag !== "read";
}
