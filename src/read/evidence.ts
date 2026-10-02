import { createHash } from "node:crypto";
import { lstatSync, readFileSync, existsSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import type { DatabaseSync } from "node:sqlite";
import type { MemoryVersion } from "../config.ts";
import { getPublishedGeneration, recordSourceUsage } from "../store/consolidation.ts";
import { validateSummaryFormat } from "../pipeline/artifacts.ts";

import type { StagingManifest } from "../pipeline/staging.ts";
import { readWorkspaceUtf8, safeWorkspacePath } from "../pipeline/workspace-tools.ts";
import { renderMemoryCarrier, renderMemorySection } from "./inject.ts";
import type { MemoryCarrier, MemoryCarrierBudget, MemoryCarrierView } from "./inject.ts";

interface ArtifactView extends MemoryCarrierView {
  retentionDeadline: number | null;
  extractionPromptHash?: string;
}

export interface PinAcquisition {
  pin: MemoryReadPin | null;
  failure?: { error: boolean; reason: string };
}

export interface PinValidationContext {
  db: DatabaseSync; root: string; maxUnusedDays: number; now?: number;
}
export interface EvidenceAccessContext {
  root: string; db: () => DatabaseSync | null; now?: () => number; maxUnusedDays?: () => number;
}
export interface EvidenceConsumer { consumerSession: string; runId: string }
export interface DetailUse { path: string; startLine: number; endLine: number }
export interface EvidenceOperation<T> {
  /** Complete response formatting/budget admission after the post-read validity check. */
  complete(): T;
  detailUse?: DetailUse;
}
export interface AttributedEvidence {
  readonly lines: readonly string[];
  readonly attribution: readonly (readonly string[])[];
}
export interface EvidenceAccess {
  isReadablePath(path: string): boolean;
  paths(prefix?: unknown): string[];
  read(path: string): string;
  sources(path: string, text: string): string[];
  attributedLines(path: string): AttributedEvidence;
  sourceMetadata(sourceIds: readonly string[]): {
    sourceIds: string[]; sourceIdsTruncated?: boolean; omittedSourceIds?: number; sourceUnavailable?: boolean;
  };
}

/** Opaque artifact proof, with only read-only lifecycle identity exposed to its caller. */
export interface MemoryReadPin {
  readonly memoryVersion: MemoryVersion;
  readonly generationId: string;
  readonly controlEpoch: number;
  readonly retentionDeadline: number | null;
  readonly identity: string;
  validate(context: PinValidationContext): ReadValidation;
  renderCarrier(cwd: string, budget: MemoryCarrierBudget): MemoryCarrier;
  renderSection(cwd: string): string;
  withEvidence<T>(context: EvidenceAccessContext,
    operation: (access: EvidenceAccess) => EvidenceOperation<T>, consumer?: () => EvidenceConsumer | null): T;
}

const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

/** Fail open using only the DB-selected generation; never discover staging or orphans. */
function acquireArtifactView(input: {
  db: DatabaseSync; root: string; memoryVersion: MemoryVersion; now?: number; summaryBytes?: number; maxUnusedDays?: number;
  extractionPromptHash?: string; generationId?: string;
  onFailure?: (reason: "refresh_timeout" | "artifact_integrity" | "read_invalidated") => void;
}): ArtifactView | null {
  const started = performance.now();
  const fail = (reason: "refresh_timeout" | "artifact_integrity" | "read_invalidated" = "artifact_integrity") => {
    input.onFailure?.(reason); return null;
  };
  try {
    const generation = getPublishedGeneration(input.db, input.memoryVersion, input.now ?? Date.now(),
      { generationId: input.generationId, maxUnusedDays: input.maxUnusedDays, extractionPromptHash: input.extractionPromptHash });
    if (!generation) return null;
    const expected = resolve(input.root, "versions", input.memoryVersion, "generations", generation.generationId);
    if (resolve(generation.directory) !== expected) return fail();
    const tail = relative(resolve(input.root), expected);
    if (tail.startsWith("..") || tail.startsWith(sep)) return fail();
    let parent = resolve(input.root);
    if (!lstatSync(parent).isDirectory() || lstatSync(parent).isSymbolicLink()) return fail();
    for (const part of tail.split(sep)) {
      parent = join(parent, part);
      const stat = lstatSync(parent);
      if (stat.isSymbolicLink() || !stat.isDirectory()) return fail();
    }
    const read = (name: string, maximum: number) => {
      const path = join(expected, name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || !stat.isFile() || stat.size > maximum) throw new Error("invalid memory artifact");
      return readFileSync(path);
    };
    const manifestBytes = read("manifest.json", 1024 * 1024);
    if (hash(manifestBytes) !== generation.manifestHash) return fail();
    const manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(manifestBytes)) as {
      memoryVersion?: unknown; controlEpoch?: unknown; fileHashes?: Record<string, string>;
      sources?: Array<{ cwd?: unknown }>;
    };
    if (manifest.memoryVersion !== input.memoryVersion || manifest.controlEpoch !== generation.controlEpoch || !manifest.fileHashes) return fail();
    // Use the existing workspace file safety ceiling, not the writer's length target.
    const maximum = input.memoryVersion === "v2" ? 9_999 : 16 * 1024 * 1024;
    const summaryBytes = read("memory_summary.md", maximum);
    if (hash(summaryBytes) !== manifest.fileHashes["memory_summary.md"]) return fail();
    const summary = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(summaryBytes);
    validateSummaryFormat(summary, input.memoryVersion);
    if (input.memoryVersion === "v1") {
      const handbook = lstatSync(join(expected, "MEMORY.md"));
      if (handbook.isSymbolicLink() || !handbook.isFile()) return fail();
    }
    if (performance.now() - started > 200) return fail("refresh_timeout");
    // Epoch/retention can change while reading files; do not serve a stale cache.
    const latest = getPublishedGeneration(input.db, input.memoryVersion, input.now ?? Date.now(),
      { generationId: generation.generationId, maxUnusedDays: input.maxUnusedDays, extractionPromptHash: input.extractionPromptHash });
    if (latest?.generationId !== generation.generationId || latest.controlEpoch !== generation.controlEpoch) return fail("read_invalidated");
    if (latest.manifestHash !== generation.manifestHash || latest.directory !== generation.directory) return fail();
    if (performance.now() - started > 200) return fail("refresh_timeout");
    return { memoryVersion: input.memoryVersion, generationId: generation.generationId, directory: expected,
      controlEpoch: generation.controlEpoch, manifestHash: generation.manifestHash, summary, retentionDeadline: generation.retentionDeadline,
      extractionPromptHash: input.extractionPromptHash, applicability: [...new Set((manifest.sources ?? []).flatMap((source) => typeof source.cwd === "string" ? [source.cwd] : []))] };
  } catch { return fail(); }
}

export interface ReadValidation { valid: boolean; reason: string; recoverable?: boolean; error?: boolean }

/** Recheck the pinned generation, not the current publication pointer. */
function validateArtifactView(db: DatabaseSync, root: string, pin: ArtifactView, maxUnusedDays: number,
  now = Date.now()): ReadValidation {
  try {
    const epoch = db.prepare("SELECT control_epoch FROM store_state WHERE singleton = 1").get()?.control_epoch;
    if (epoch !== pin.controlEpoch) return { valid: false, reason: "control_epoch_changed" };
    const pipeline = db.prepare("SELECT read_blocked, block_reason FROM pipeline_state WHERE memory_version = ?").get(pin.memoryVersion);
    if (pipeline?.read_blocked) return { valid: false, reason: String(pipeline.block_reason ?? "read_invalidated") };
    const generation = getPublishedGeneration(db, pin.memoryVersion, now, { generationId: pin.generationId,
      maxUnusedDays, extractionPromptHash: pin.extractionPromptHash });
    if (!generation) {
      const identity = db.prepare("SELECT status, manifest_hash, directory FROM generations WHERE generation_id = ? AND memory_version = ?")
        .get(pin.generationId, pin.memoryVersion);
      if (identity?.status !== "published" || identity.manifest_hash !== pin.manifestHash || identity.directory !== pin.directory) {
        return { valid: false, reason: "generation_ineligible" };
      }
      // Recovery is allowed only for proven expiry at the unchanged control epoch.
      // Branch retirement, deletion, unknown invalidity and prompt changes are not expiry.
      const expired = db.prepare(`SELECT 1 FROM generation_sources gs
        JOIN source_revisions r ON r.source_id = gs.source_id
        JOIN branch_heads h ON h.session_key = r.session_key AND h.branch_id = r.branch_id
        JOIN extractions e ON e.extraction_id = gs.extraction_id
        LEFT JOIN source_stats st ON st.lineage_key = r.lineage_key AND st.memory_version = ?
        WHERE gs.generation_id = ? AND r.status = 'captured' AND h.state = 'active'
          AND h.latest_revision = r.source_id AND e.prompt_hash = ?
          AND COALESCE(st.last_used_at, r.source_time) < ? LIMIT 1`).get(pin.memoryVersion, pin.generationId,
        pin.extractionPromptHash ?? "", now - maxUnusedDays * 86_400_000);
      const unsafe = db.prepare(`SELECT 1 FROM generation_sources gs
        JOIN source_revisions r ON r.source_id = gs.source_id
        JOIN branch_heads h ON h.session_key = r.session_key AND h.branch_id = r.branch_id
        JOIN extractions e ON e.extraction_id = gs.extraction_id
        WHERE gs.generation_id = ? AND (r.status != 'captured' OR h.state != 'active'
          OR h.latest_revision != r.source_id OR e.prompt_hash != ?) LIMIT 1`).get(pin.generationId, pin.extractionPromptHash ?? "");
      return expired && !unsafe ? { valid: false, reason: "retention_expired", recoverable: true }
        : { valid: false, reason: "generation_ineligible" };
    }
    if (generation.manifestHash !== pin.manifestHash || generation.directory !== pin.directory) {
      return { valid: false, reason: "pin_integrity", error: true };
    }
    let failureReason: string = "artifact_integrity";
    const fresh = acquireArtifactView({ db, root, memoryVersion: pin.memoryVersion, generationId: pin.generationId,
      maxUnusedDays, now, extractionPromptHash: pin.extractionPromptHash, onFailure: reason => { failureReason = reason; } });
    if (!fresh) return { valid: false, reason: failureReason, error: failureReason === "artifact_integrity" };
    if (fresh.manifestHash !== pin.manifestHash || fresh.summary !== pin.summary) {
      return { valid: false, reason: "artifact_integrity", error: true };
    }
    pin.retentionDeadline = fresh.retentionDeadline;
    return { valid: true, reason: "valid" };
  } catch { return { valid: false, reason: "validation_unavailable", error: true }; }
}


const allowed = (path: string, version: string) => /^rollout_summaries\/[A-Za-z0-9_-]+\.md$/.test(path) ||
  (version === "v1" && (path === "MEMORY.md" || /^skills\/[a-z0-9][a-z0-9-]{0,63}\/SKILL\.md$/.test(path)));
const permittedPrefix = (path: string, version: string) => path === "." || allowed(path, version) ||
  path === "rollout_summaries" || (version === "v1" && (path === "skills" || /^skills\/[a-z0-9][a-z0-9-]{0,63}$/.test(path)));


const sources = (manifest: StagingManifest, path: string, text: string): string[] => [...new Set(manifest.sources
    .filter(source => source.path === path || text.includes(source.path) || new RegExp(`\\bsource_id\\s*[:=]\\s*${source.sourceId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(text))
    .map(source => source.sourceId))];
  const attributedLines = (manifest: StagingManifest, path: string, text: string) => {
    const lines = text.split("\n");
    const all = sources(manifest, path, text);
    const attribution = lines.map(() => all);
    if (path === "MEMORY.md") {
      const groups = [0, ...lines.flatMap((line, index) => index > 0 && /^# Task Group: /.test(line) ? [index] : []), lines.length];
      for (let g = 0; g < groups.length - 1; g++) {
        const start = groups[g]!; const end = groups[g + 1]!;
        // Attribute every section (and the group preamble) by its own text, not
        // by the whole task group: a reusable-knowledge line supported by one
        // task must not extend retention of unrelated tasks' sources.
        const sections = [start, ...lines.slice(start, end).flatMap((line, index) => /^## /.test(line) ? [start + index] : []), end];
        for (let s = 0; s < sections.length - 1; s++) {
          const first = sections[s]!; const last = sections[s + 1]!;
          const sectionSources = sources(manifest, path, lines.slice(first, last).join("\n"));
          for (let index = first; index < last; index++) attribution[index] = sectionSources;
        }
      }
    }
    return { lines, attribution };
  };


/** Foreground acquisition distinguishes missing eligibility from failed artifact preparation. */
export function prepareEvidencePin(input: Parameters<typeof acquireArtifactView>[0]): PinAcquisition {
  const published = getPublishedGeneration(input.db, input.memoryVersion, input.now ?? Date.now(), {
    generationId: input.generationId, maxUnusedDays: input.maxUnusedDays,
    extractionPromptHash: input.extractionPromptHash,
  });
  if (!published) return { pin: null, failure: { error: false, reason: "no_eligible_generation" } };
  let failureReason: string = "artifact_integrity";
  const pin = acquireEvidencePin({ ...input, onFailure: reason => { failureReason = reason; input.onFailure?.(reason); } });
  return pin ? { pin } : { pin: null, failure: { error: failureReason === "artifact_integrity", reason: failureReason } };
}

/** Acquire only the DB-selected published generation; artifact proof stays private. */
export function acquireEvidencePin(input: Parameters<typeof acquireArtifactView>[0]): MemoryReadPin | null {
  const view = acquireArtifactView(input);
  return view ? new StoredReadPin(view) : null;
}

class StoredReadPin implements MemoryReadPin {
  #view: ArtifactView;
  constructor(view: ArtifactView) { this.#view = view; }
  get memoryVersion() { return this.#view.memoryVersion; }
  get generationId() { return this.#view.generationId; }
  get controlEpoch() { return this.#view.controlEpoch; }
  get retentionDeadline() { return this.#view.retentionDeadline; }
  get identity() {
    return JSON.stringify([this.memoryVersion, this.generationId, this.controlEpoch, this.#view.manifestHash]);
  }
  validate(context: PinValidationContext): ReadValidation {
    return validateArtifactView(context.db, context.root, this.#view, context.maxUnusedDays, context.now);
  }
  renderCarrier(cwd: string, budget: MemoryCarrierBudget): MemoryCarrier {
    return renderMemoryCarrier(this.#view, cwd, budget);
  }
  renderSection(cwd: string): string { return renderMemorySection(this.#view, cwd); }

  /** One synchronous borrow: initial/post-read/post-use checks cannot be skipped by the adapter. */
  withEvidence<T>(context: EvidenceAccessContext,
    operation: (access: EvidenceAccess) => EvidenceOperation<T>, consumer?: () => EvidenceConsumer | null): T {
    const view = this.#view;
    const db = context.db(); const now = context.now?.() ?? Date.now();
    if (!db) throw new Error("memory_unavailable");
    const valid = () => {
      const generation = getPublishedGeneration(db, view.memoryVersion, context.now?.() ?? Date.now(),
        { generationId: view.generationId, maxUnusedDays: context.maxUnusedDays?.(),
          extractionPromptHash: view.extractionPromptHash });
      if (!generation || generation.controlEpoch !== view.controlEpoch || generation.manifestHash !== view.manifestHash || generation.directory !== view.directory ||
          resolve(view.directory) !== resolve(context.root, "versions", view.memoryVersion, "generations", view.generationId)) throw new Error("memory_unavailable");
      return generation;
    };
    const generation = valid();
    safeWorkspacePath(context.root, `versions/${view.memoryVersion}/generations/${view.generationId}/manifest.json`);
    const manifestText = readWorkspaceUtf8(view.directory, "manifest.json");
    if (hash(manifestText) !== generation.manifestHash) throw new Error("memory_unavailable");
    let manifest: StagingManifest;
    try { manifest = JSON.parse(manifestText) as StagingManifest; }
    catch { throw new Error("memory_unavailable"); }
    if (manifest.memoryVersion !== view.memoryVersion || manifest.controlEpoch !== view.controlEpoch ||
        !manifest.fileHashes || !Array.isArray(manifest.sources)) throw new Error("memory_unavailable");

    let open = true;
    const assertOpen = () => { if (!open) throw new Error("memory_unavailable"); };
    const attributed = new Map<string, AttributedEvidence>();
    const unavailableSources = new Map<string, boolean>();
    const access: EvidenceAccess = {
      isReadablePath: path => { assertOpen(); return allowed(path, view.memoryVersion); },
      paths: (prefix = ".") => {
        assertOpen();
        const path = prefix ?? ".";
        if (typeof path !== "string" || !permittedPrefix(path, view.memoryVersion)) throw new Error("path_not_available_for_version");
        const files = Object.keys(manifest.fileHashes).filter(file => allowed(file, view.memoryVersion)).sort();
        return path === "." ? files : files.filter(file => file === path || file.startsWith(`${path}/`));
      },
      read: path => {
        assertOpen();
        if (!allowed(path, view.memoryVersion)) throw new Error("path_not_available_for_version");
        const text = readWorkspaceUtf8(view.directory, path);
        if (hash(text) !== manifest.fileHashes[path]) throw new Error("memory_unavailable");
        return text;
      },
      sources: (path, text) => { assertOpen(); return sources(manifest, path, text); },
      attributedLines: path => {
        assertOpen();
        const raw = attributedLines(manifest, path, access.read(path));
        const value: AttributedEvidence = Object.freeze({ lines: Object.freeze(raw.lines),
          attribution: Object.freeze(raw.attribution.map(ids => Object.freeze(ids))) });
        attributed.set(path, value); return value;
      },
      sourceMetadata: sourceIds => {
        assertOpen();
        const shown = sourceIds.slice(0, 12); const currentDb = context.db();
        const sourceUnavailable = sourceIds.some(id => {
          if (unavailableSources.has(id)) return unavailableSources.get(id)!;
          const source = currentDb?.prepare("SELECT s.path FROM source_revisions r JOIN sessions s ON s.session_key = r.session_key WHERE r.source_id = ?").get(id);
          const unavailable = typeof source?.path === "string" && !existsSync(source.path);
          unavailableSources.set(id, unavailable); return unavailable;
        });
        return { sourceIds: shown, ...(sourceIds.length > 12 ? { sourceIdsTruncated: true, omittedSourceIds: sourceIds.length - 12 } : {}),
          ...(sourceUnavailable ? { sourceUnavailable: true } : {}) };
      },
    };
    try {
      const pending = operation(access);
      open = false;
      valid();
      const output = pending.complete();
      if (pending.detailUse) {
        const { path, startLine, endLine } = pending.detailUse;
        const evidence = attributed.get(path);
        if (!evidence || !Number.isSafeInteger(startLine) || !Number.isSafeInteger(endLine) ||
            startLine < 1 || endLine < startLine || endLine > evidence.lines.length) throw new Error("memory_unavailable");
        const actor = consumer?.();
        if (actor) for (const sourceId of new Set(evidence.attribution.slice(startLine - 1, endLine).flat())) {
          recordSourceUsage(db, { memoryVersion: view.memoryVersion, sourceId, ...actor, now });
        }
        valid();
      }
      return output;
    } finally { open = false; }
  }
}
