import { redactSensitive } from "../sensitive.ts";
import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ConsolidationSnapshot } from "../store/consolidation.ts";
import { evidencePath, notePath, textHash } from "./staging.ts";
import { atomicWorkspaceWrite, generatedOutput, readWorkspaceUtf8, workspaceInventory } from "./workspace-tools.ts";
import { renderSelectedEvidence, validateSummaryFormat } from "./artifacts.ts";

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

const pathReferences = (text: string): string[] => [...text.matchAll(/\b(?:rollout_summaries\/[^\s`<>()[\]#,;]+\.md|notes\/[^\s`<>()[\]#,;]+\.md|skills\/[^\s`<>()[\]#,;]+\/SKILL\.md)/g)].map((match) => match[0]);
const v2PathReferences = (text: string): string[] => [...text.matchAll(/\b(?:rollout_summaries|notes)\/[^\s`<>()[\]#,;]+/g)]
  .map(match => match[0].replace(/[.:!?]+$/, ""));
const headingAnchor = (heading: string): string => heading.toLowerCase().replace(/[^\p{L}\p{N}_\-\s]/gu, "").replace(/\s+/g, "-");

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
  const maximum = options.summaryBytes ?? 9999;
  const inputs = selectedInputs(snapshot);
  const { evidence, notes } = inputs;
  const sourceIds = new Set(snapshot.sources.map((source) => source.sourceId));
  const noteIds = new Set(snapshot.notes.map((note) => note.noteId));
  const collection = collectArtifacts(directory, path => generatedOutput(path) || evidence.has(path) || notes.has(path) ||
    path === "raw_memories.md" || path === "phase2_workspace_diff.md" || path === "manifest.json", "forbidden artifact");
  const { files, fileHashes } = collection;
  const summary = files.get("memory_summary.md");
  const handbook = files.get("MEMORY.md");
  if (summary === undefined || handbook === undefined) throw new Error("required MEMORY.md and memory_summary.md are missing");
  validateSummaryFormat(summary, maximum);
  validateSelectedIntegrity(collection, inputs);
  const auditReferences = (text: string): void => {
    for (const path of pathReferences(text)) if (!files.has(path) || (!evidence.has(path) && !notes.has(path) && !generatedOutput(path))) {
      throw new Error(`source or procedure pointer is not selected: ${path}`);
    }
    for (const match of text.matchAll(/\bsource_id\s*[:=]\s*([A-Za-z0-9_-]+)/g)) if (!sourceIds.has(match[1]!)) throw new Error("source ID is not selected");
    for (const match of text.matchAll(/\b(?:note_id\s*[:=]\s*|note:)([A-Za-z0-9_-]+)/g)) if (!noteIds.has(match[1]!)) throw new Error("note ID is not selected");
  };
  for (const [path, text] of files) if (generatedOutput(path)) auditReferences(text);
  const supported = snapshot.sources.length > 0 || snapshot.notes.length > 0;
  if (!supported) {
    if (handbook !== MINIMAL_V1_HANDBOOK || summary !== MINIMAL_V1_SUMMARY || [...files.keys()].some((path) => path.startsWith("skills/"))) {
      throw new Error("empty selection requires deterministic minimal artifacts");
    }
    return { fileHashes, summary };
  }
  if (handbook !== MINIMAL_V1_HANDBOOK) {
    if (!handbook.startsWith("# Task Group: ")) throw new Error("handbook must use task groups");
    const groups = handbook.split(/(?=^# Task Group: )/m).filter((group) => group.trim());
    for (const group of groups) {
      if (!/^scope:\s*\S.+$/m.test(group) || !/^applies_to:\s*\S.+$/m.test(group)) throw new Error("task group requires scope and applies_to");
      const tasks = group.split(/(?=^## Task \d+(?::|\b))/m).slice(1);
      if (!tasks.length) throw new Error("task group requires task-local source references and keywords");
      for (const task of tasks) {
        const taskBody = task.split(/^## (?:User preferences|Reusable knowledge|Failures and how to do differently)/m)[0]!;
        if (!/^### keywords\s*\r?\n(?:\s*\r?\n)*- \S/m.test(taskBody)) throw new Error("task requires non-empty task-local keywords");
        const selectedReference = pathReferences(taskBody).some((path) => evidence.has(path) || notes.has(path)) ||
          [...noteIds].some((id) => taskBody.includes(`note:${id}`) || taskBody.includes(`note_id: ${id}`));
        if (!selectedReference) throw new Error("task requires selected source files or explicit note IDs");
      }
    }
  }
  const anchors = new Set([...handbook.matchAll(/^#{1,6} (.+)$/gm)].map((match) => headingAnchor(match[1]!)));
  for (const match of summary.matchAll(/\bMEMORY\.md#([\p{L}\p{N}_-]+)/gu)) if (!anchors.has(match[1]!)) throw new Error("summary handbook section pointer does not exist");
  const index = summary.slice(summary.indexOf("## What's in Memory") + "## What's in Memory".length);
  for (const line of index.split(/\r?\n/).filter((entry) => /^\s*- /.test(entry))) {
    const explicit = pathReferences(line).some((path) => evidence.has(path)) || /\bMEMORY\.md(?:\b|#)/.test(line) || [...noteIds].some((id) => line.includes(`note:${id}`));
    const taskRoute = [...handbook.matchAll(/^# Task Group: (.+)$|^### keywords\s*\n(?:\s*\n)*- (.+)$/gm)]
      .flatMap((match) => match[1] ? [match[1]] : (match[2] ?? "").split(",").map((keyword) => keyword.trim()))
      .some((route) => route.length > 1 && line.toLowerCase().includes(route.toLowerCase()));
    if (!explicit && !taskRoute) throw new Error("summary pointer does not resolve to handbook or selected evidence");
  }
  return { fileHashes, summary };
}

/** V2 retains only direct source routes; it cannot publish v1 learning layers. */
export function validateV2Artifacts(options: { directory: string; snapshot: ConsolidationSnapshot; summaryBytes?: number }): { fileHashes: Record<string, string>; summary: string } {
  const { directory, snapshot } = options;
  if (snapshot.memoryVersion !== "v2") throw new Error("v2 artifacts require v2 snapshot");
  const maximum = Math.min(options.summaryBytes ?? 9999, 9999);
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
  const summary = files.get("memory_summary.md");
  if (summary === undefined) throw new Error("required memory_summary.md is missing");
  validateSummaryFormat(summary, maximum);
  validateSelectedIntegrity(collection, inputs);
  if (/\b(?:MEMORY\.md|raw_memories\.md|skills\/|versions\/(?:v1|v2)\/)/.test(summary)) throw new Error("forbidden v2 summary pointer");
  if (/[\\/](?:rollout_summaries|notes)\//.test(summary)) throw new Error("v2 source pointer must be an exact relative path");
  for (const path of v2PathReferences(summary)) if (!evidence.has(path)) {
    throw new Error(`source pointer is not selected: ${path}`);
  }
  const sourceIds = new Set(snapshot.sources.map(source => source.sourceId));
  const sessionKeys = new Set(snapshot.sources.map(source => source.sessionKey));
  const noteIds = new Set(snapshot.notes.map(note => note.noteId));
  for (const match of summary.matchAll(/\bsource_id\s*[:=]\s*([A-Za-z0-9_-]+)/g)) if (!sourceIds.has(match[1]!)) throw new Error("source ID is not selected");
  for (const match of summary.matchAll(/\bsession_key\s*[:=]\s*([A-Za-z0-9_-]+)/g)) if (!sessionKeys.has(match[1]!)) throw new Error("session key is not selected");
  for (const match of summary.matchAll(/\b(?:note_id\s*[:=]\s*|note:)([A-Za-z0-9_-]+)/g)) if (!noteIds.has(match[1]!)) throw new Error("note ID is not selected");
  if (!snapshot.sources.length && !snapshot.notes.length) {
    if (summary !== MINIMAL_V2_SUMMARY) throw new Error("empty selection requires deterministic minimal v2 summary");
    return { fileHashes, summary };
  }
  const index = summary.slice(summary.indexOf("## What's in Memory") + "## What's in Memory".length);
  let project: string | null = null;
  let date: string | null = null;
  let older = false;
  for (const line of index.split(/\r?\n/)) {
    if (line === "### Older Memory Topics") { older = true; project = null; date = null; continue; }
    const scopeHeading = /^### (\S.*)$/.exec(line);
    if (scopeHeading) { project = scopeHeading[1]!; date = null; continue; }
    const dateHeading = /^#### (\d{4}-\d{2}-\d{2})$/.exec(line);
    if (dateHeading) {
      const value = dateHeading[1]!;
      if (!project || Number.isNaN(Date.parse(`${value}T00:00:00Z`)) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) {
        throw new Error("recent source route requires a project and valid date group");
      }
      date = value; continue;
    }
    if (older && /^#### \S/.test(line)) { project = line.slice(5); continue; }
    if (!/^\s*- /.test(line)) continue;
    const routes = v2PathReferences(line);
    const noteRoute = [...noteIds].some(id => line.includes(`note:${id}`) || line.includes(`note_id: ${id}`));
    if (!routes.length && !noteRoute) throw new Error("v2 summary route requires an exact selected source path or note ID");
    if (routes.some(path => evidence.has(path))) {
      if (!older && (!project || !date)) throw new Error("recent source route requires project/date grouping");
      if (older && !project && !/^\s*- \S[^:]*:\s*\S/.test(line)) throw new Error("older source route requires project scope");
    }
  }
  return { fileHashes, summary };
}
