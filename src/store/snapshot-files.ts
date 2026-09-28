import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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
  const dir = join(root, "sources", lineageKey);
  const path = join(dir, `${revisionHash}.json`);

  if (existsSync(path)) {
    const existing = createHash("sha256").update(readFileSync(path)).digest("hex");
    if (existing !== hash) {
      throw new Error(`snapshot ${path} is immutable: content differs for the same revision hash`);
    }
    return { path, hash }; // idempotent rewrite
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Enforce privacy even for directories created by older configurations.
  chmodSync(root, 0o700);
  chmodSync(join(root, "sources"), 0o700);
  chmodSync(dir, 0o700);
  const temp = join(dir, `.snapshot-${randomBytes(12).toString("hex")}.tmp`);
  try {
    writeFileSync(temp, content, { mode: 0o600, flag: "wx" });
    // A complete temp file becomes visible atomically; link never replaces
    // a pre-existing immutable revision, even across competing processes.
    try {
      linkSync(temp, path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const existing = createHash("sha256").update(readFileSync(path)).digest("hex");
      if (existing !== hash) throw new Error(`snapshot ${path} is immutable: content differs for the same revision hash`);
    }
  } finally {
    if (existsSync(temp)) unlinkSync(temp);
  }
  return { path, hash };
}
