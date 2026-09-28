import { redactSensitive } from "../sensitive.ts";
import type { ConsolidationSnapshot } from "../store/consolidation.ts";
import { evidencePath, notePath, textHash } from "./staging.ts";
import { atomicWorkspaceWrite, generatedOutput, readWorkspaceUtf8, workspaceInventory } from "./workspace-tools.ts";
import { renderSelectedEvidence, validateSummaryFormat } from "./artifacts.ts";

export const MINIMAL_V1_SUMMARY = "v1\n\n## User Profile\n\n## User preferences\n\n## General Tips\n\n## What's in Memory\n";
export const MINIMAL_V1_HANDBOOK = "# Memory\n\nNo supported memory sources or user notes.\n";

export function writeMinimalV1(directory: string): void {
  atomicWorkspaceWrite(directory, "MEMORY.md", MINIMAL_V1_HANDBOOK);
  atomicWorkspaceWrite(directory, "memory_summary.md", MINIMAL_V1_SUMMARY);
}

const pathReferences = (text: string): string[] => [...text.matchAll(/\b(?:rollout_summaries\/[^\s`<>()[\]#,;]+\.md|notes\/[^\s`<>()[\]#,;]+\.md|skills\/[^\s`<>()[\]#,;]+\/SKILL\.md)/g)].map((match) => match[0]);
const headingAnchor = (heading: string): string => heading.toLowerCase().replace(/[^\p{L}\p{N}_\-\s]/gu, "").replace(/\s+/g, "-");

export function validateV1Artifacts(options: { directory: string; snapshot: ConsolidationSnapshot; summaryBytes?: number }): { fileHashes: Record<string, string>; summary: string } {
  const { directory, snapshot } = options;
  if (snapshot.memoryVersion !== "v1") throw new Error("v1 artifacts require v1 snapshot");
  const maximum = options.summaryBytes ?? 9999;
  const evidence = new Map(snapshot.sources.map((source) => [evidencePath(source.sourceId, source.rolloutSlug), source]));
  const notes = new Map(snapshot.notes.map((note) => [notePath(note.noteId), note]));
  const sourceIds = new Set(snapshot.sources.map((source) => source.sourceId));
  const noteIds = new Set(snapshot.notes.map((note) => note.noteId));
  const files = new Map<string, string>();
  const fileHashes: Record<string, string> = {};
  for (const path of workspaceInventory(directory)) {
    if (!(generatedOutput(path) || evidence.has(path) || notes.has(path) || path === "raw_memories.md" || path === "phase2_workspace_diff.md" || path === "manifest.json")) {
      throw new Error(`forbidden artifact: ${path}`);
    }
    const text = readWorkspaceUtf8(directory, path);
    if (redactSensitive(text) !== text) throw new Error(`secret detected in artifact: ${path}`);
    if (path === "manifest.json") continue; // Host-owned provenance; finalized after validation.
    files.set(path, text);
    fileHashes[path] = textHash(text);
  }
  const summary = files.get("memory_summary.md");
  const handbook = files.get("MEMORY.md");
  if (summary === undefined || handbook === undefined) throw new Error("required MEMORY.md and memory_summary.md are missing");
  validateSummaryFormat(summary, maximum);
  for (const [path, source] of evidence) {
    const expected = renderSelectedEvidence(source);
    if (files.get(path) !== expected) throw new Error(`selected source evidence missing or changed: ${path}`);
  }
  for (const [path, note] of notes) if (!files.has(path) || fileHashes[path] !== note.textHash) throw new Error(`selected note missing or changed: ${path}`);
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
