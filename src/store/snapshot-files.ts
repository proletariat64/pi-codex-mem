import { createHash, randomBytes } from "node:crypto";
import { chmodSync, closeSync, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function syncDirectory(path: string): void {
  const fd = openSync(path, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
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
  const hash = createHash("sha256").update(content).digest("hex");
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
    const existing = createHash("sha256").update(readFileSync(path)).digest("hex");
    if (existing !== hash) {
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
    writeFileSync(temp, content, { mode: 0o600, flag: "wx" });
    const fd = openSync(temp, "r");
    try { fsyncSync(fd); } finally { closeSync(fd); }
    // A complete, durable temp file becomes visible atomically; link never replaces
    // a pre-existing immutable revision, even across competing processes.
    try {
      linkSync(temp, path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      if (lstatSync(path).isSymbolicLink()) throw new Error("snapshot symlink rejected");
      const existing = createHash("sha256").update(readFileSync(path)).digest("hex");
      if (existing !== hash) throw new Error(`snapshot ${path} is immutable: content differs for the same revision hash`);
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
