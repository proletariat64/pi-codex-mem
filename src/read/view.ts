import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import type { DatabaseSync } from "node:sqlite";
import type { MemoryVersion } from "../config.ts";
import { getPublishedGeneration } from "../store/consolidation.ts";
import { validateSummaryFormat } from "../pipeline/artifacts.ts";

export interface MemoryReadView {
  memoryVersion: MemoryVersion;
  generationId: string;
  directory: string;
  controlEpoch: number;
  manifestHash: string;
  summary: string;
  applicability: string[];
  retentionDeadline: number | null;
  extractionPromptHash?: string;
}

const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/** Fail open using only the DB-selected generation; never discover staging or orphans. */
export function acquireReadView(input: {
  db: DatabaseSync; root: string; memoryVersion: MemoryVersion; now?: number; summaryBytes?: number; maxUnusedDays?: number;
  extractionPromptHash?: string;
}): MemoryReadView | null {
  const started = performance.now();
  try {
    const generation = getPublishedGeneration(input.db, input.memoryVersion, input.now ?? Date.now(),
      { maxUnusedDays: input.maxUnusedDays, extractionPromptHash: input.extractionPromptHash });
    if (!generation) return null;
    const expected = resolve(input.root, "versions", input.memoryVersion, "generations", generation.generationId);
    if (resolve(generation.directory) !== expected) return null;
    const tail = relative(resolve(input.root), expected);
    if (tail.startsWith("..") || tail.startsWith(sep)) return null;
    let parent = resolve(input.root);
    if (!lstatSync(parent).isDirectory() || lstatSync(parent).isSymbolicLink()) return null;
    for (const part of tail.split(sep)) {
      parent = join(parent, part);
      const stat = lstatSync(parent);
      if (stat.isSymbolicLink() || !stat.isDirectory()) return null;
    }
    const read = (name: string, maximum: number) => {
      const path = join(expected, name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || !stat.isFile() || stat.size > maximum) throw new Error("invalid memory artifact");
      return readFileSync(path);
    };
    const manifestBytes = read("manifest.json", 1024 * 1024);
    if (hash(manifestBytes) !== generation.manifestHash) return null;
    const manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(manifestBytes)) as {
      memoryVersion?: unknown; controlEpoch?: unknown; fileHashes?: Record<string, string>;
      sources?: Array<{ cwd?: unknown }>;
    };
    if (manifest.memoryVersion !== input.memoryVersion || manifest.controlEpoch !== generation.controlEpoch || !manifest.fileHashes) return null;
    // Use the existing workspace file safety ceiling, not the writer's length target.
    const maximum = input.memoryVersion === "v2" ? 9_999 : 16 * 1024 * 1024;
    const summaryBytes = read("memory_summary.md", maximum);
    if (hash(summaryBytes) !== manifest.fileHashes["memory_summary.md"]) return null;
    const summary = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(summaryBytes);
    validateSummaryFormat(summary, input.memoryVersion);
    if (input.memoryVersion === "v1") {
      const handbook = lstatSync(join(expected, "MEMORY.md"));
      if (handbook.isSymbolicLink() || !handbook.isFile()) return null;
    }
    if (performance.now() - started > 200) return null;
    // Epoch/retention can change while reading files; do not serve a stale cache.
    const latest = getPublishedGeneration(input.db, input.memoryVersion, input.now ?? Date.now(),
      { maxUnusedDays: input.maxUnusedDays, extractionPromptHash: input.extractionPromptHash });
    if (latest?.generationId !== generation.generationId || latest.controlEpoch !== generation.controlEpoch) return null;
    return { memoryVersion: input.memoryVersion, generationId: generation.generationId, directory: expected,
      controlEpoch: generation.controlEpoch, manifestHash: generation.manifestHash, summary, retentionDeadline: generation.retentionDeadline,
      extractionPromptHash: input.extractionPromptHash, applicability: [...new Set((manifest.sources ?? []).flatMap((source) => typeof source.cwd === "string" ? [source.cwd] : []))] };
  } catch { return null; }
}
