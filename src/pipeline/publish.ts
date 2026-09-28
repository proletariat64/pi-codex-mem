import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync,
  readdirSync, realpathSync, renameSync, rmSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { commitGeneration, type ConsolidationLease, type ConsolidationSnapshot } from "../store/consolidation.ts";
import type { MemoryVersion } from "../config.ts";
import { validateV2Artifacts } from "./validate.ts";
import { evidencePath, notePath, type StagingManifest } from "./staging.ts";

export type PublicationBoundary = "before_fsync" | "after_fsync" | "after_rename" | "before_cas" | "after_cas";

function assertDirectory(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("publication directory must be a real directory");
}

function makeOwnedDirectory(path: string, root: string): void {
  if (path !== root) makeOwnedDirectory(dirname(path), root);
  if (!existsSync(path)) mkdirSync(path, { mode: 0o700 });
  assertDirectory(path);
}

function fsyncPath(path: string): void {
  const fd = openSync(path, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

/** Sync children before their directory entries. Reject any nonregular entry before rename. */
function fsyncTree(path: string): void {
  assertDirectory(path);
  for (const name of readdirSync(path).sort()) {
    const child = join(path, name);
    const stat = lstatSync(child);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw new Error("unsafe publication file");
    if (stat.isDirectory()) fsyncTree(child); else fsyncPath(child);
  }
  fsyncPath(path);
}

/** Caller supplies a validated candidate + manifest; the DB is the only served pointer. */
export function publishGeneration(opts: {
  db: DatabaseSync; root: string; stagingDir: string; lease: ConsolidationLease;
  snapshot: ConsolidationSnapshot; inputHash: string; manifestHash: string;
  generationId?: string; now: number | (() => number); fault?: (boundary: PublicationBoundary) => void;
}): { published: boolean; generationId: string; path: string } {
  const root = realpathSync(opts.root);
  const generationId = opts.generationId ?? randomUUID();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(generationId)) throw new Error("invalid generation ID");
  if (opts.snapshot.memoryVersion !== opts.lease.memoryVersion) throw new Error("publication version mismatch");
  const versionRoot = join(root, "versions", opts.lease.memoryVersion);
  const stagingRoot = join(versionRoot, "staging");
  const stagingDir = resolve(opts.stagingDir);
  if (dirname(stagingDir) !== stagingRoot || !stagingDir.startsWith(root + sep)) throw new Error("staging directory escaped version");
  makeOwnedDirectory(stagingRoot, root);
  assertDirectory(stagingDir);
  if (realpathSync(stagingDir) !== stagingDir) throw new Error("staging symlink rejected");
  const manifestPath = join(stagingDir, "manifest.json");
  if (lstatSync(manifestPath).isSymbolicLink() || !lstatSync(manifestPath).isFile()) throw new Error("unsafe publication manifest");
  if (createHash("sha256").update(readFileSync(manifestPath)).digest("hex") !== opts.manifestHash) throw new Error("publication manifest changed");
  if (opts.lease.memoryVersion === "v2") {
    const validated = validateV2Artifacts({ directory: stagingDir, snapshot: opts.snapshot });
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as StagingManifest;
    const entries = (hashes: Record<string, string>) => Object.entries(hashes).sort(([a], [b]) => a.localeCompare(b));
    const sources = [...opts.snapshot.sources].sort((a, b) => a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : 0).map(source => [source.sourceId, source.extractionId,
      evidencePath(source.sourceId, source.rolloutSlug), source.outputHash, source.cwd, source.workspaceKey]);
    const notes = [...opts.snapshot.notes].sort((a, b) => a.noteId < b.noteId ? -1 : a.noteId > b.noteId ? 1 : 0).map(note => [note.noteId, notePath(note.noteId), note.textHash, note.scope]);
    if (manifest.schemaVersion !== 1 || manifest.memoryVersion !== "v2" ||
        manifest.selectionHash !== opts.snapshot.selectionHash || manifest.controlEpoch !== opts.snapshot.controlEpoch ||
        manifest.promptHash !== opts.lease.promptHash || manifest.inputHash !== opts.inputHash ||
        !manifest.fileHashes || JSON.stringify(entries(manifest.fileHashes)) !== JSON.stringify(entries(validated.fileHashes)) ||
        !Array.isArray(manifest.sources) || JSON.stringify(manifest.sources.map(source =>
          [source.sourceId, source.extractionId, source.path, source.outputHash, source.cwd, source.workspaceKey])) !== JSON.stringify(sources) ||
        !Array.isArray(manifest.notes) || JSON.stringify(manifest.notes.map(note => [note.noteId, note.path, note.textHash, note.scope])) !== JSON.stringify(notes)) {
      throw new Error("v2 publication manifest does not match validated selection");
    }
  }
  const generations = join(versionRoot, "generations");
  makeOwnedDirectory(generations, root);
  const path = join(generations, generationId);
  if (existsSync(path)) throw new Error("generation directory already exists");
  opts.fault?.("before_fsync");
  fsyncTree(stagingDir);
  // Persist both directory ancestry and source/destination parent entries.
  fsyncPath(stagingRoot); fsyncPath(generations); fsyncPath(versionRoot);
  fsyncPath(join(root, "versions")); fsyncPath(root);
  opts.fault?.("after_fsync");
  renameSync(stagingDir, path);
  fsyncPath(generations); fsyncPath(stagingRoot);
  opts.fault?.("after_rename");
  opts.fault?.("before_cas");
  const published = commitGeneration(opts.db, { lease: opts.lease, snapshot: opts.snapshot,
    generation: { generationId, memoryVersion: opts.lease.memoryVersion, directory: path,
      inputHash: opts.inputHash, manifestHash: opts.manifestHash }, now: typeof opts.now === "function" ? opts.now() : opts.now });
  opts.fault?.("after_cas");
  return { published, generationId, path };
}

/** Bounded recovery plus pins. The write lock prevents new writers racing orphan cleanup. */
export function cleanupGenerations(opts: {
  db: DatabaseSync; root: string; now: number; pinnedGenerationIds?: readonly string[];
}): void {
  const { db, now } = opts;
  const root = realpathSync(opts.root);
  db.exec("BEGIN IMMEDIATE");
  try {
    // Renamed candidates have no generation row until CAS. A live consolidator
    // owns all of its staging/orphan files, so do not guess at their liveness.
    if (db.prepare("SELECT 1 FROM jobs WHERE kind = 'consolidate' AND status = 'leased' AND lease_expires_at > ?").get(now)) {
      db.exec("COMMIT"); return;
    }
    const pins = new Set(opts.pinnedGenerationIds ?? []);
    for (const version of ["v1", "v2"] as const) {
      const active = (db.prepare("SELECT active_generation_id AS id FROM pipeline_state WHERE memory_version = ?")
        .get(version) as { id: string | null }).id;
      const rows = db.prepare(`SELECT g.generation_id AS id, g.directory, g.status,
        EXISTS(SELECT 1 FROM generation_sources gs JOIN source_revisions r ON r.source_id = gs.source_id
          WHERE gs.generation_id = g.generation_id AND r.status = 'privacy_revoked') AS privateRevoked
        FROM generations g WHERE memory_version = ? ORDER BY published_at DESC, generation_id DESC`)
        .all(version) as { id: string; directory: string; status: string; privateRevoked: number }[];
      let oldCount = 0;
      const keep = new Set<string>();
      for (const row of rows) {
        const revoked = row.status === "revoked" || row.privateRevoked !== 0;
        const retain = !revoked && (row.id === active || pins.has(row.id) || oldCount < 2);
        if (retain) {
          keep.add(row.id);
          if (row.id !== active && !pins.has(row.id)) oldCount++;
          continue;
        }
        const expected = join(root, "versions", version, "generations", row.id);
        if (resolve(row.directory) !== expected) throw new Error("generation cleanup path escaped store");
        removeOwnedTree(expected, root, version, "generations");
        db.prepare("UPDATE pipeline_state SET active_generation_id = NULL WHERE active_generation_id = ?").run(row.id);
        db.prepare("UPDATE generations SET base_generation_id = NULL WHERE base_generation_id = ?").run(row.id);
        db.prepare("DELETE FROM note_applications WHERE generation_id = ?").run(row.id);
        db.prepare("DELETE FROM generations WHERE generation_id = ?").run(row.id);
      }
      for (const kind of ["generations", "staging"] as const) {
        const parent = join(root, "versions", version, kind);
        if (!existsSync(parent)) continue;
        assertDirectory(parent);
        for (const name of readdirSync(parent)) {
          if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(name)) continue;
          if (kind === "generations" && keep.has(name)) continue;
          removeOwnedTree(join(parent, name), root, version, kind);
        }
        fsyncPath(parent);
      }
    }
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}

function removeOwnedTree(path: string, root: string, version: MemoryVersion, kind: "generations" | "staging"): void {
  const parent = join(root, "versions", version, kind);
  if (dirname(path) !== parent) throw new Error("cleanup path escaped store");
  if (!existsSync(path)) return;
  assertDirectory(parent); assertDirectory(path);
  if (realpathSync(parent) !== parent || realpathSync(path) !== path) throw new Error("cleanup symlink rejected");
  rmSync(path, { recursive: true, force: true });
}
