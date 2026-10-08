import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { ConsolidationSnapshot } from "../store/consolidation.ts";
import type { MemoryVersion } from "../config.ts";
import { renderSelectedEvidence } from "./artifacts.ts";
import { diffFileHunks, DIFF_POLICY_VERSION, DIFF_TOTAL_WORK, type WorkBudget } from "./diff.ts";
import { generatedOutput, readWorkspaceUtf8, safeWorkspacePath, workspaceInventory } from "./workspace-tools.ts";

export const textHash = (text: string): string => createHash("sha256").update(text).digest("hex");
const safeId = (value: string): string => /^[A-Za-z0-9_-]{1,160}$/.test(value) ? value : textHash(value);
export const evidencePath = (sourceId: string, slug: string): string => `rollout_summaries/${safeId(sourceId)}__${slug.replace(/[^a-z0-9_-]/g, "-").slice(0, 80) || "summary"}.md`;
export const notePath = (noteId: string): string => `notes/${safeId(noteId)}.md`;

export interface StagingManifest {
  schemaVersion: 1;
  memoryVersion: MemoryVersion;
  selectionHash: string;
  controlEpoch: number;
  promptHash: string;
  inputHash: string;
  contentKey: string;
  retentionDeadline: number | null;
  sources: { sourceId: string; extractionId: string; path: string; outputHash: string; cwd: string; workspaceKey: string }[];
  notes: { noteId: string; path: string; textHash: string; scope: string; action?: string; createdAt?: number }[];
  fileHashes: Record<string, string>;
  /** Diff policy of the producing writer; optional so legacy manifests stay readable (spec §9). */
  diffPolicyVersion?: number;
  diffFallbackReason?: DiffFallbackReason;
}

/** Recorded in the manifest whenever a diff falls back to the path-only index. */
export type DiffFallbackReason = "privacy_or_retention" | "size" | "computation_limit";

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
    manifest = JSON.parse(readWorkspaceUtf8(directory, "manifest.json")) as StagingManifest;
    if (manifest.memoryVersion !== snapshot.memoryVersion) return { files, paths: [], manifest: null, valid: false };
    const inventory = workspaceInventory(directory);
    paths = inventory.filter((path) => path !== "manifest.json" && path !== "phase2_workspace_diff.md");
    if (snapshot.memoryVersion === "v2") {
      const allowed = (path: string): boolean => path === "memory_summary.md" || /^(?:rollout_summaries|notes)\/[A-Za-z0-9_-]+\.md$/.test(path);
      const filtered = paths.filter(allowed);
      if (filtered.length !== paths.length) return { files, paths: filtered, manifest: null, valid: false };
    }
    if (manifest.schemaVersion !== 1 || !manifest.fileHashes || !Array.isArray(manifest.sources) || !Array.isArray(manifest.notes)) {
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
  const changes: { path: string; kind: "added" | "deleted" | "modified" }[] = [];
  for (const path of paths) {
    const current = next.get(path);
    const had = priorPaths.includes(path);
    if (had && current !== undefined && priorHashes[path] === textHash(current)) continue;
    changes.push({ path, kind: !had ? "added" : current === undefined ? "deleted" : "modified" });
  }
  return `# Workspace changes\n\nPrior plaintext omitted because support, retention, invalidation epoch, or integrity changed. Read added/modified staged files separately and remove claims supported only by deleted inputs. Complete changed-path index:\n\n${indexLines(changes)}\n`;
}

const indexLines = (changes: { path: string; kind: "added" | "deleted" | "modified" }[]): string =>
  changes.map(({ path, kind }) => `- ${kind}: ${path}`).join("\n");

/** Deterministic line-level unified diff with an always-present authoritative path index (spec §6). */
export function workspaceDiff(prior: Map<string, string>, next: Map<string, string>): { text: string; fallback: boolean; reason: "size" | "computation_limit" | null } {
  const paths = [...new Set([...prior.keys(), ...next.keys()])].sort();
  const changes: { path: string; kind: "added" | "deleted" | "modified" }[] = [];
  for (const path of paths) {
    const old = prior.get(path);
    const current = next.get(path);
    if (old === current) continue;
    changes.push({ path, kind: old === undefined ? "added" : current === undefined ? "deleted" : "modified" });
  }
  if (!changes.length) return { text: "# Workspace changes\n\nNo content changes.\n", fallback: false, reason: null };
  const budget: WorkBudget = { left: DIFF_TOTAL_WORK };
  let bytes = 0;
  let reason: "size" | "computation_limit" | null = null;
  const sections: string[] = [];
  for (const { path, kind } of changes) {
    if (reason) continue;
    const outcome = diffFileHunks(prior.get(path) ?? "", next.get(path) ?? "", budget);
    if (outcome.overrun) { reason = outcome.overrun; sections.length = 0; continue; }
    if (!outcome.hunks) continue;
    // Added and deleted files show their complete text; modified files show local hunks.
    const section = `--- ${kind === "added" ? "/dev/null" : `a/${path}`}\n+++ ${kind === "deleted" ? "/dev/null" : `b/${path}`}\n${outcome.hunks}`;
    bytes += Buffer.byteLength(section);
    if (bytes > 4 * 1024 * 1024) { reason = "size"; sections.length = 0; continue; }
    sections.push(section);
  }
  if (!reason) {
    // Sections can be empty when every change involves empty files.
    const text = sections.length ? `# Workspace changes\n\n${indexLines(changes)}\n\n${sections.join("\n")}` : `# Workspace changes\n\n${indexLines(changes)}\n`;
    if (Buffer.byteLength(text, "utf8") <= 4 * 1024 * 1024) return { text, fallback: false, reason: null };
    // The ceiling covers headings, the authoritative index and separators too.
    // Discard all plaintext detail; never truncate the complete changed-path index.
    reason = "size";
  }
  const notice = reason === "size"
    ? "Unified diff omitted: output exceeds the 4 MiB ceiling. Read every added or modified staged file separately and remove claims supported only by deleted inputs. "
    : "Unified diff omitted: the bounded diff algorithm exceeded its computation limit. Read every added or modified staged file separately and remove claims supported only by deleted inputs. ";
  return { text: `# Workspace changes\n\n${notice}Complete changed-path index:\n\n${indexLines(changes)}\n`, fallback: true, reason };
}

export function buildStaging(options: { root: string; jobId: string; snapshot: ConsolidationSnapshot; promptHash: string; summaryBytes?: number; priorDir?: string }): StagedWorkspace {
  const { root, snapshot, promptHash } = options;
  const memoryVersion = snapshot.memoryVersion;
  if (memoryVersion !== "v1" && memoryVersion !== "v2") throw new Error("invalid staging memory version");
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(options.jobId)) throw new Error("unsafe staging job ID");
  const directory = join(root, "versions", memoryVersion, "staging", options.jobId);
  // Check each root-relative component before recursive creation.
  safeWorkspacePath(root, `versions/${memoryVersion}/staging/${options.jobId}`, true);
  mkdirSync(safeWorkspacePath(root, `versions/${memoryVersion}/staging`, true), { recursive: true, mode: 0o700 });
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
  if (memoryVersion === "v1") files.set("raw_memories.md", sources.map((source) => `# Source: ${source.sourceId}\nrollout_summary: ${evidencePath(source.sourceId, source.rolloutSlug)}\ncwd: ${source.cwd}\n\n${source.rawMemory ?? ""}\n`).join("\n"));
  const noteManifest = notes.map((note) => {
    const relativePath = relative(resolve(root), resolve(root, note.textPath)).split("\\").join("/");
    const text = readWorkspaceUtf8(root, relativePath);
    if (textHash(text) !== note.textHash) throw new Error("note changed during staging");
    const path = notePath(note.noteId);
    if (files.has(path)) throw new Error("duplicate note path");
    files.set(path, text);
    return { noteId: note.noteId, path, textHash: note.textHash, scope: note.scope,
      action: note.action ?? "remember", createdAt: note.createdAt ?? 0 };
  });
  const contentKey = textHash(JSON.stringify({ memoryVersion, selectionHash: snapshot.selectionHash, sourceHashes: sourceManifest, notes: noteManifest, promptHash, controlEpoch: snapshot.controlEpoch, summaryBytes: options.summaryBytes ?? 9999 }));
  let priorDir = options.priorDir;
  if (priorDir) {
    const priorRelative = relative(resolve(root), resolve(priorDir)).split("\\").join("/");
    if (!new RegExp(`^versions/${memoryVersion}/(?:generations|staging)/[A-Za-z0-9_-]+$`).test(priorRelative)) priorDir = undefined;
    else {
      try { safeWorkspacePath(root, priorRelative); }
      catch { priorDir = undefined; }
    }
  }
  const prior = priorFiles(priorDir, snapshot, sourceManifest, noteManifest);
  const supportRetained = prior.valid;
  if (supportRetained) for (const [path, text] of prior.files) if (generatedOutput(path, memoryVersion)) files.set(path, text);
  const outputHashes = Object.fromEntries([...files].filter(([path]) => generatedOutput(path, memoryVersion)).map(([path, text]) => [path, textHash(text)]));
  const inputHash = textHash(JSON.stringify({ contentKey, outputHashes }));
  const privacyFallback = Boolean(options.priorDir && !prior.valid);
  const diff = privacyFallback ? { text: changedPathIndex(prior.paths, prior.manifest?.fileHashes ?? {}, files), fallback: true, reason: "privacy_or_retention" as const } : workspaceDiff(prior.files, files);
  files.set("phase2_workspace_diff.md", diff.text);
  for (const [path, text] of files) {
    const absolute = safeWorkspacePath(directory, path, true);
    const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : null;
    if (parent) mkdirSync(safeWorkspacePath(directory, parent, true), { recursive: true, mode: 0o700 });
    writeFileSync(absolute, text, { flag: "wx", mode: generatedOutput(path, memoryVersion) || path === "phase2_workspace_diff.md" ? 0o600 : 0o400 });
  }
  const diffFallbackReason: DiffFallbackReason | undefined = diff.fallback ? (privacyFallback ? "privacy_or_retention" : diff.reason ?? "size") : undefined;
  const manifest: StagingManifest = { schemaVersion: 1, memoryVersion, selectionHash: snapshot.selectionHash, controlEpoch: snapshot.controlEpoch, promptHash, inputHash, contentKey, retentionDeadline: snapshot.retentionDeadline, sources: sourceManifest, notes: noteManifest, fileHashes: {}, diffPolicyVersion: DIFF_POLICY_VERSION, ...(diffFallbackReason ? { diffFallbackReason } : {}) };
  // Host-owned note IDs and applicability are available before the model writes claims.
  // Workspace tools can read the manifest but cannot replace it.
  writeFileSync(safeWorkspacePath(directory, "manifest.json", true), JSON.stringify(manifest, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  return { directory, inputHash, manifest, diffFallback: diff.fallback, unchanged: Boolean(supportRetained && prior.manifest?.contentKey === contentKey && (memoryVersion === "v2" || files.has("MEMORY.md")) && files.has("memory_summary.md")) };
}
