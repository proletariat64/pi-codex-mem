import type { DatabaseSync } from "node:sqlite";
import type { MemoryVersion } from "../config.ts";
import type { ContextDiagnostics, TokenUnits } from "./context-controller.ts";

/** Body-free, process-local observations. No schema change, transcript or summary storage.
 * Reader connections in this process can inspect the latest run for the same store.
 * Other processes/restarts explicitly report unavailable, never inferred counters. */
export interface WriterObservation {
  jobId: string;
  promptHash: string;
  context: ContextDiagnostics;
  selectedSources?: number;
  selectedNotes?: number;
  diffMode?: "unified" | "path_index";
  diffFallback?: string;
  requests: number;
  tools: number;
  compactions: number;
  elapsedMs: number;
  status: string;
  reason?: string;
  lastCompaction?: { before?: number; after?: number; units?: TokenUnits; result: string };
}
const observations = new Map<string, Partial<Record<MemoryVersion, WriterObservation>>>();
function storeKey(db: DatabaseSync): string | undefined {
  // SELECT-only PRAGMA, works on separate read-only connections used by doctor.
  const row = db.prepare("PRAGMA database_list").get() as { file: string } | undefined;
  return row?.file || undefined;
}
export function recordWriterObservation(db: DatabaseSync, version: MemoryVersion, observation: WriterObservation): void {
  const key = storeKey(db);
  if (!key) return;
  const latest = observations.get(key) ?? {};
  latest[version] = structuredClone(observation);
  observations.set(key, latest);
}
export function writerObservation(db: DatabaseSync, version: MemoryVersion, jobId: string): WriterObservation | undefined {
  const key = storeKey(db);
  const latest = key ? observations.get(key)?.[version] : undefined;
  return latest?.jobId === jobId ? structuredClone(latest) : undefined;
}
