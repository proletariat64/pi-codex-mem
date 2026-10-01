import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { MemoryConfig } from "../config.ts";
import { getPublishedGeneration, type ConsolidationLease, type ConsolidationSnapshot } from "../store/consolidation.ts";
import { runConsolidation, type ConsolidationRunInput, type ConsolidationRunResult } from "./consolidate.ts";
import { publishGeneration } from "./publish.ts";
import { buildStaging, textHash } from "./staging.ts";
import { readWorkspaceUtf8 } from "./workspace-tools.ts";
import { validateV1Artifacts, validateV2Artifacts, writeMinimalV1, writeMinimalV2 } from "./validate.ts";

interface CandidateInput {
  db: DatabaseSync;
  root: string;
  lease: ConsolidationLease;
  snapshot: ConsolidationSnapshot;
  config: MemoryConfig;
  signal: AbortSignal;
  clock: () => number;
}

type WriterInput = Pick<ConsolidationRunInput, "modelRef" | "port" | "onRequestStarted" | "canStartRequest">;

/** Candidate files and provenance stay private; scheduling and lease outcomes stay with the caller. */
export interface GenerationCandidate {
  /** Reused outputs must pass validation before the caller can finish an unchanged lease. */
  checkUnchanged(): boolean;
  writeMinimal(): void;
  runWriter(input: WriterInput): Promise<ConsolidationRunResult>;
  /** Check cancellation, validate and finalize the manifest, then use the existing publication protocol. */
  publish(): boolean;
  /** Release only this lease fence's staging path, including after publication has renamed it. */
  dispose(): void;
}

/** Prepare one lease-fenced workspace without exposing its directory or mutable manifest. */
export function prepareGenerationCandidate(input: CandidateInput): GenerationCandidate {
  const { db, root, lease, snapshot, config, signal, clock } = input;
  if (lease.memoryVersion !== snapshot.memoryVersion) throw new Error("publication version mismatch");
  const version = snapshot.memoryVersion;
  const validate = version === "v1" ? validateV1Artifacts : validateV2Artifacts;
  const prior = snapshot.baseGenerationId ? db.prepare(
    "SELECT directory, manifest_hash FROM generations WHERE generation_id = ? AND memory_version = ? AND status = 'published'",
  ).get(snapshot.baseGenerationId, version) as { directory: string; manifest_hash: string } | undefined : undefined;
  let priorDir: string | undefined;
  if (prior && getPublishedGeneration(db, version, clock(), { generationId: snapshot.baseGenerationId ?? undefined,
    maxUnusedDays: config.schedule.maxUnusedDays, extractionPromptHash: snapshot.extractionPromptHash })) {
    try {
      const text = readWorkspaceUtf8(prior.directory, "manifest.json");
      if (textHash(text) === prior.manifest_hash) priorDir = prior.directory;
    } catch { /* A damaged previous artifact cannot become writer input. */ }
  }
  // Reclaimed leases must not reuse a dead writer's candidate or cleanup path.
  const staged = buildStaging({ root, jobId: `${lease.jobId}-${lease.fence}`, snapshot, promptHash: lease.promptHash,
    summaryBytes: config.limits.summaryBytes, priorDir });
  const validateOutputs = () => validate({ directory: staged.directory, snapshot, summaryBytes: config.limits.summaryBytes });
  return {
    checkUnchanged() {
      if (!staged.unchanged) return false;
      validateOutputs();
      return true;
    },
    writeMinimal() { (version === "v1" ? writeMinimalV1 : writeMinimalV2)(staged.directory); },
    runWriter(writer) {
      // Forward the original promise: do not add a yield around writer completion or cancellation.
      return runConsolidation({ ...writer, db, directory: staged.directory, lease, config, signal, clock,
        validateOutputs });
    },
    publish() {
      if (signal.aborted) throw new Error("cancelled");
      const validated = validateOutputs();
      staged.manifest.fileHashes = validated.fileHashes;
      const manifestText = JSON.stringify(staged.manifest, null, 2) + "\n";
      writeFileSync(join(staged.directory, "manifest.json"), manifestText, { mode: 0o600 });
      return publishGeneration({ db, root, stagingDir: staged.directory, lease, snapshot,
        inputHash: staged.inputHash,
        manifestHash: textHash(manifestText), now: clock }).published;
    },
    dispose() { rmSync(staged.directory, { recursive: true, force: true }); },
  };
}
