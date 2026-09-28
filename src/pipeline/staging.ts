import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { ConsolidationSnapshot } from "../store/consolidation.ts";
import { renderSelectedEvidence } from "./artifacts.ts";
import { generatedOutput, readWorkspaceUtf8, safeWorkspacePath, workspaceInventory } from "./workspace-tools.ts";

export const textHash = (text: string): string => createHash("sha256").update(text).digest("hex");
const safeId = (value: string): string => /^[A-Za-z0-9_-]{1,160}$/.test(value) ? value : textHash(value);
export const evidencePath = (sourceId: string, slug: string): string => `rollout_summaries/${safeId(sourceId)}__${slug.replace(/[^a-z0-9_-]/g, "-").slice(0, 80) || "summary"}.md`;
export const notePath = (noteId: string): string => `notes/${safeId(noteId)}.md`;

export interface StagingManifest {
  schemaVersion: 1;
  memoryVersion: "v1";
  selectionHash: string;
  controlEpoch: number;
  promptHash: string;
  inputHash: string;
  contentKey: string;
  retentionDeadline: number | null;
  sources: { sourceId: string; extractionId: string; path: string; outputHash: string; cwd: string; workspaceKey: string }[];
  notes: { noteId: string; path: string; textHash: string; scope: string }[];
  fileHashes: Record<string, string>;
  diffFallbackReason?: "privacy_or_retention" | "size";
}

export interface StagedWorkspace {
  directory: string;
  inputHash: string;
  manifest: StagingManifest;
  unchanged: boolean;
  diffFallback: boolean;
}

function priorFiles(directory: string | undefined, snapshot: ConsolidationSnapshot, sources: StagingManifest["sources"], notes: StagingManifest["notes"]): { files: Map<string, string>; paths: string[]; manifest: StagingManifest | null; valid: boolean } {
  const files = new Map<string, string>();
  let paths: string[] = [];
  let manifest: StagingManifest | null = null;
  if (!directory) return { files, paths, manifest, valid: false };
  try {
    const inventory = workspaceInventory(directory);
    paths = inventory.filter((path) => path !== "manifest.json" && path !== "phase2_workspace_diff.md");
    manifest = JSON.parse(readWorkspaceUtf8(directory, "manifest.json")) as StagingManifest;
    if (manifest.schemaVersion !== 1 || manifest.memoryVersion !== "v1" || !manifest.fileHashes || !Array.isArray(manifest.sources) || !Array.isArray(manifest.notes)) {
      return { files, paths, manifest: null, valid: false };
    }
    // Never read prior learning/evidence once its backing source/note or epoch is revoked.
    const supportRetained = manifest.controlEpoch === snapshot.controlEpoch &&
      manifest.sources.every((source) => sources.some((current) => current.sourceId === source.sourceId && current.outputHash === source.outputHash && current.path === source.path)) &&
      manifest.notes.every((note) => notes.some((current) => current.noteId === note.noteId && current.textHash === note.textHash));
    if (!supportRetained) return { files, paths, manifest, valid: false };
    const priorHashes = manifest.fileHashes;
    const valid = inventory.filter((path) => path !== "manifest.json").every((path) => typeof priorHashes[path] === "string" && textHash(readWorkspaceUtf8(directory, path)) === priorHashes[path]) &&
      Object.keys(priorHashes).every((path) => path !== "manifest.json" && inventory.includes(path));
    if (valid) for (const path of paths) files.set(path, readWorkspaceUtf8(directory, path));
    return { files, paths, manifest, valid };
  } catch { return { files: new Map(), paths, manifest: null, valid: false }; }
}

function changedPathIndex(priorPaths: string[], priorHashes: Record<string, string>, next: Map<string, string>): string {
  const paths = [...new Set([...priorPaths, ...next.keys()])].sort();
  const changes = paths.flatMap((path) => {
    const current = next.get(path);
    const had = priorPaths.includes(path);
    if (had && current !== undefined && priorHashes[path] === textHash(current)) return [];
    return [`- ${!had ? "added" : current === undefined ? "deleted" : "modified"}: ${path}`];
  });
  return `# Workspace changes\n\nPrior plaintext omitted because support, retention, invalidation epoch, or integrity changed. Read added/modified staged files separately and remove claims supported only by deleted inputs. Complete changed-path index:\n\n${changes.join("\n")}\n`;
}

/** Full-file unified hunks deliberately avoid heuristic/machine-dependent diff ordering. */
export function workspaceDiff(prior: Map<string, string>, next: Map<string, string>): { text: string; fallback: boolean } {
  const changes: { path: string; kind: string }[] = [];
  const hunks: string[] = [];
  let bytes = 0;
  let fallback = false;
  for (const path of [...new Set([...prior.keys(), ...next.keys()])].sort()) {
    const old = prior.get(path), current = next.get(path);
    if (old === current) continue;
    changes.push({ path, kind: old === undefined ? "added" : current === undefined ? "deleted" : "modified" });
    if (fallback) continue;
    const oldLines = old === undefined || old === "" ? [] : old.replace(/\n$/, "").split("\n");
    const newLines = current === undefined || current === "" ? [] : current.replace(/\n$/, "").split("\n");
    const deletion = oldLines.map((line) => `-${line}`);
    if (old !== undefined && old !== "" && !old.endsWith("\n")) deletion.push("\\ No newline at end of file");
    const addition = newLines.map((line) => `+${line}`);
    if (current !== undefined && current !== "" && !current.endsWith("\n")) addition.push("\\ No newline at end of file");
    const hunk = [`--- ${old === undefined ? "/dev/null" : `a/${path}`}`, `+++ ${current === undefined ? "/dev/null" : `b/${path}`}`,
      `@@ -${oldLines.length ? 1 : 0},${oldLines.length} +${newLines.length ? 1 : 0},${newLines.length} @@`,
      ...deletion, ...addition].join("\n") + "\n";
    bytes += Buffer.byteLength(hunk);
    if (bytes > 4 * 1024 * 1024) { fallback = true; hunks.length = 0; }
    else hunks.push(hunk);
  }
  return { fallback, text: fallback ? `# Workspace changes\n\nUnified diff exceeds 4 MiB. Read every added or modified file separately; remove unsupported claims from deleted inputs. Complete changed-path index:\n\n${changes.map(({ path, kind }) => `- ${kind}: ${path}`).join("\n")}\n` : `# Workspace changes\n\n${hunks.join("\n") || "No content changes.\n"}` };
}

export function buildStaging(options: { root: string; jobId: string; snapshot: ConsolidationSnapshot; promptHash: string; summaryBytes?: number; priorDir?: string }): StagedWorkspace {
  const { root, snapshot, promptHash } = options;
  if (snapshot.memoryVersion !== "v1") throw new Error("v1 staging requires v1 snapshot");
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(options.jobId)) throw new Error("unsafe staging job ID");
  const directory = join(root, "versions", "v1", "staging", options.jobId);
  // Check each root-relative component before recursive creation.
  safeWorkspacePath(root, `versions/v1/staging/${options.jobId}`, true);
  mkdirSync(safeWorkspacePath(root, "versions/v1/staging", true), { recursive: true, mode: 0o700 });
  mkdirSync(directory, { recursive: false, mode: 0o700 });
  const sources = [...snapshot.sources].sort((a, b) => a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : 0);
  const notes = [...snapshot.notes].sort((a, b) => a.noteId < b.noteId ? -1 : a.noteId > b.noteId ? 1 : 0);
  const files = new Map<string, string>();
  const sourceManifest = sources.map((source) => {
    const path = evidencePath(source.sourceId, source.rolloutSlug);
    if (files.has(path)) throw new Error("duplicate evidence path");
    files.set(path, renderSelectedEvidence(source));
    return { sourceId: source.sourceId, extractionId: source.extractionId, path, outputHash: source.outputHash, cwd: source.cwd, workspaceKey: source.workspaceKey };
  });
  files.set("raw_memories.md", sources.map((source) => `# Source: ${source.sourceId}\nrollout_summary: ${evidencePath(source.sourceId, source.rolloutSlug)}\ncwd: ${source.cwd}\n\n${source.rawMemory ?? ""}\n`).join("\n"));
  const noteManifest = notes.map((note) => {
    const relativePath = relative(resolve(root), resolve(root, note.textPath)).split("\\").join("/");
    const text = readWorkspaceUtf8(root, relativePath);
    if (textHash(text) !== note.textHash) throw new Error("note changed during staging");
    const path = notePath(note.noteId);
    if (files.has(path)) throw new Error("duplicate note path");
    files.set(path, text);
    return { noteId: note.noteId, path, textHash: note.textHash, scope: note.scope };
  });
  const contentKey = textHash(JSON.stringify({ memoryVersion: "v1", selectionHash: snapshot.selectionHash, sourceHashes: sourceManifest, notes: noteManifest, promptHash, controlEpoch: snapshot.controlEpoch, summaryBytes: options.summaryBytes ?? 9999 }));
  const prior = priorFiles(options.priorDir, snapshot, sourceManifest, noteManifest);
  const supportRetained = prior.valid;
  if (supportRetained) for (const [path, text] of prior.files) if (generatedOutput(path)) files.set(path, text);
  const outputHashes = Object.fromEntries([...files].filter(([path]) => generatedOutput(path)).map(([path, text]) => [path, textHash(text)]));
  const inputHash = textHash(JSON.stringify({ contentKey, outputHashes }));
  const privacyFallback = Boolean(options.priorDir && !prior.valid);
  const diff = privacyFallback ? { text: changedPathIndex(prior.paths, prior.manifest?.fileHashes ?? {}, files), fallback: true } : workspaceDiff(prior.files, files);
  files.set("phase2_workspace_diff.md", diff.text);
  for (const [path, text] of files) {
    const absolute = safeWorkspacePath(directory, path, true);
    const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : null;
    if (parent) mkdirSync(safeWorkspacePath(directory, parent, true), { recursive: true, mode: 0o700 });
    writeFileSync(absolute, text, { flag: "wx", mode: generatedOutput(path) || path === "phase2_workspace_diff.md" ? 0o600 : 0o400 });
  }
  const manifest: StagingManifest = { schemaVersion: 1, memoryVersion: "v1", selectionHash: snapshot.selectionHash, controlEpoch: snapshot.controlEpoch, promptHash, inputHash, contentKey, retentionDeadline: snapshot.retentionDeadline, sources: sourceManifest, notes: noteManifest, fileHashes: {}, ...(diff.fallback ? { diffFallbackReason: privacyFallback ? "privacy_or_retention" as const : "size" as const } : {}) };
  // Host-owned note IDs and applicability are available before the model writes claims.
  // Workspace tools can read the manifest but cannot replace it.
  writeFileSync(safeWorkspacePath(directory, "manifest.json", true), JSON.stringify(manifest, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  return { directory, inputHash, manifest, diffFallback: diff.fallback, unchanged: Boolean(supportRetained && prior.manifest?.contentKey === contentKey && files.has("MEMORY.md") && files.has("memory_summary.md")) };
}
