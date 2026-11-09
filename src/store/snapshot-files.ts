import { createHash, randomBytes } from "node:crypto";
import { chmodSync, closeSync, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";
import { join } from "node:path";

function syncDirectory(path: string): void {
  const fd = openSync(path, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

/** Snapshots are stored gzip-compressed: a revision carries the whole branch, so
 * plaintext copies made every settle cost quadratic space. The identity hash
 * always covers the decoded JSON text, keeping compression an encoding detail. */
const GZIP_MAGIC = [0x1f, 0x8b] as const;

export function isCompressedSnapshot(bytes: Buffer): boolean {
  return bytes.length > 1 && bytes[0] === GZIP_MAGIC[0] && bytes[1] === GZIP_MAGIC[1];
}

/** Decode a snapshot payload, accepting both compressed and legacy plaintext files. */
export function decodeSnapshot(bytes: Buffer): string {
  return (isCompressedSnapshot(bytes) ? gunzipSync(bytes) : bytes).toString("utf8");
}

/** Content identity of a stored snapshot, independent of its on-disk encoding. */
export function snapshotContentHash(bytes: Buffer): string {
  return createHash("sha256").update(decodeSnapshot(bytes), "utf8").digest("hex");
}

/** Read a snapshot's decoded JSON text from the owned store. */
export function readSnapshotText(path: string): string {
  return decodeSnapshot(readFileSync(path));
}

/**
 * Immutable snapshot files (spec §12.1): sources/<lineage-key>/<revision>.json
 * Directory mode 0700, file mode 0600. Snapshots are immutable (§7.1):
 * rewriting identical content is a no-op; different content at the same
 * revision path is an error (revision hashes must change with content).
 */
export function writeSnapshotFile(
  root: string,
  lineageKey: string,
  revisionHash: string,
  snapshot: unknown,
): { path: string; hash: string } {
  const content = JSON.stringify(snapshot, null, 2) + "\n";
  const hash = createHash("sha256").update(content, "utf8").digest("hex");
  const payload = gzipSync(Buffer.from(content, "utf8"), { level: 9 });
  const sources = join(root, "sources");
  const dir = join(sources, lineageKey);
  const path = join(dir, `${revisionHash}.json`);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  // Never follow an existing sources/lineage symlink into an unrelated tree.
  if (existsSync(sources) && lstatSync(sources).isSymbolicLink()) throw new Error("sources symlink rejected");
  mkdirSync(sources, { recursive: true, mode: 0o700 });
  if (lstatSync(sources).isSymbolicLink()) throw new Error("sources symlink rejected");
  if (existsSync(dir) && lstatSync(dir).isSymbolicLink()) throw new Error("lineage symlink rejected");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (lstatSync(dir).isSymbolicLink()) throw new Error("lineage symlink rejected");

  if (existsSync(path)) {
    if (lstatSync(path).isSymbolicLink()) throw new Error("snapshot symlink rejected");
    if (snapshotContentHash(readFileSync(path)) !== hash) {
      throw new Error(`snapshot ${path} is immutable: content differs for the same revision hash`);
    }
    syncDirectory(dir); // also makes a recovered pre-commit link durable
    return { path, hash }; // idempotent rewrite
  }
  // Enforce privacy even for directories created by older configurations.
  chmodSync(root, 0o700);
  chmodSync(join(root, "sources"), 0o700);
  chmodSync(dir, 0o700);
  // Persist the newly created sources/ and lineage/ directory entries.
  syncDirectory(root);
  syncDirectory(sources);
  const temp = join(dir, `.snapshot-${randomBytes(12).toString("hex")}.tmp`);
  try {
    writeFileSync(temp, payload, { mode: 0o600, flag: "wx" });
    const fd = openSync(temp, "r");
    try { fsyncSync(fd); } finally { closeSync(fd); }
    // A complete, durable temp file becomes visible atomically; link never replaces
    // a pre-existing immutable revision, even across competing processes.
    try {
      linkSync(temp, path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      if (lstatSync(path).isSymbolicLink()) throw new Error("snapshot symlink rejected");
      if (snapshotContentHash(readFileSync(path)) !== hash) throw new Error(`snapshot ${path} is immutable: content differs for the same revision hash`);
    }
  } finally {
    if (existsSync(temp)) unlinkSync(temp);
  }
  // The file and its directory entry are both stable before SQLite commits
  // the referencing row. If this fails, the caller rolls back and sweep can
  // remove the unindexed file on next startup.
  syncDirectory(dir);
  return { path, hash };
}
