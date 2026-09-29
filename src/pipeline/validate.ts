import { redactSensitive } from "../sensitive.ts";
import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ConsolidationSnapshot } from "../store/consolidation.ts";
import { evidencePath, notePath, textHash } from "./staging.ts";
import { atomicWorkspaceWrite, generatedOutput, readWorkspaceUtf8, workspaceInventory } from "./workspace-tools.ts";
import { ArtifactFormatError, renderSelectedEvidence, validateSummaryFormat } from "./artifacts.ts";

export const MINIMAL_V1_SUMMARY = "v1\n\n## User Profile\n\n## User preferences\n\n## General Tips\n\n## What's in Memory\n";
export const MINIMAL_V1_HANDBOOK = "# Memory\n\nNo supported memory sources or user notes.\n";
export const MINIMAL_V2_SUMMARY = MINIMAL_V1_SUMMARY;

export function writeMinimalV1(directory: string): void {
  atomicWorkspaceWrite(directory, "MEMORY.md", MINIMAL_V1_HANDBOOK);
  atomicWorkspaceWrite(directory, "memory_summary.md", MINIMAL_V1_SUMMARY);
}

export function writeMinimalV2(directory: string): void {
  atomicWorkspaceWrite(directory, "memory_summary.md", MINIMAL_V2_SUMMARY);
}

function selectedInputs(snapshot: ConsolidationSnapshot) {
  return {
    evidence: new Map(snapshot.sources.map(source => [evidencePath(source.sourceId, source.rolloutSlug), source])),
    notes: new Map(snapshot.notes.map(note => [notePath(note.noteId), note])),
  };
}

interface ArtifactCollection { files: Map<string, string>; fileHashes: Record<string, string> }

function collectArtifacts(directory: string, allowed: (path: string) => boolean, forbiddenLabel: string): ArtifactCollection {
  const files = new Map<string, string>();
  const fileHashes: Record<string, string> = {};
  for (const path of workspaceInventory(directory)) {
    if (!allowed(path)) throw new Error(`${forbiddenLabel}: ${path}`);
    const text = readWorkspaceUtf8(directory, path);
    if (redactSensitive(text) !== text) throw new Error(`secret detected in artifact: ${path}`);
    if (path === "manifest.json") continue; // Host-owned provenance; finalized after validation.
    files.set(path, text);
    fileHashes[path] = textHash(text);
  }
  return { files, fileHashes };
}

function validateSelectedIntegrity(collection: ArtifactCollection, inputs: ReturnType<typeof selectedInputs>): void {
  const { files, fileHashes } = collection;
  for (const [path, source] of inputs.evidence) if (files.get(path) !== renderSelectedEvidence(source)) {
    throw new Error(`selected source evidence missing or changed: ${path}`);
  }
  for (const [path, note] of inputs.notes) if (!files.has(path) || fileHashes[path] !== note.textHash) {
    throw new Error(`selected note missing or changed: ${path}`);
  }
}

export function validateV1Artifacts(options: { directory: string; snapshot: ConsolidationSnapshot; summaryBytes?: number }): { fileHashes: Record<string, string>; summary: string } {
  const { directory, snapshot } = options;
  if (snapshot.memoryVersion !== "v1") throw new Error("v1 artifacts require v1 snapshot");
  const inputs = selectedInputs(snapshot);
  const { evidence, notes } = inputs;
  const collection = collectArtifacts(directory, path => generatedOutput(path) || evidence.has(path) || notes.has(path) ||
    path === "raw_memories.md" || path === "phase2_workspace_diff.md" || path === "manifest.json", "forbidden artifact");
  const { files, fileHashes } = collection;
  validateSelectedIntegrity(collection, inputs);
  const summary = files.get("memory_summary.md");
  const handbook = files.get("MEMORY.md");
  if (summary === undefined || handbook === undefined) throw new ArtifactFormatError("required MEMORY.md and memory_summary.md are missing");
  validateSummaryFormat(summary, snapshot.memoryVersion);
  return { fileHashes, summary };
}

/** V2 retains only direct source routes; it cannot publish v1 learning layers. */
export function validateV2Artifacts(options: { directory: string; snapshot: ConsolidationSnapshot; summaryBytes?: number }): { fileHashes: Record<string, string>; summary: string } {
  const { directory, snapshot } = options;
  if (snapshot.memoryVersion !== "v2") throw new Error("v2 artifacts require v2 snapshot");
  const inputs = selectedInputs(snapshot);
  const { evidence, notes } = inputs;
  const collection = collectArtifacts(directory, path => path === "memory_summary.md" || evidence.has(path) || notes.has(path) ||
    path === "phase2_workspace_diff.md" || path === "manifest.json", "forbidden v2 artifact");
  const { files, fileHashes } = collection;
  // Inventory lists files; empty forbidden directories also violate v2.
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (!lstatSync(path).isDirectory()) continue;
    if (name !== "rollout_summaries" && name !== "notes") throw new Error(`forbidden v2 artifact: ${name}/`);
    for (const child of readdirSync(path)) if (lstatSync(join(path, child)).isDirectory()) {
      throw new Error(`forbidden v2 artifact: ${name}/${child}/`);
    }
  }
  validateSelectedIntegrity(collection, inputs);
  const summary = files.get("memory_summary.md");
  if (summary === undefined) throw new ArtifactFormatError("required memory_summary.md is missing");
  validateSummaryFormat(summary, snapshot.memoryVersion);
  return { fileHashes, summary };
}
