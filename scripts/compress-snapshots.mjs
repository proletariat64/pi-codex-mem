#!/usr/bin/env node
/**
 * One-time rewrite of existing plaintext snapshots into the compressed layout.
 *
 * Snapshots are immutable by content, not by encoding: each file is decoded,
 * its decoded content hash is verified against the recorded `snapshot_hash`,
 * then the same JSON text is re-encoded with gzip. A content mismatch, an
 * undecodable file or an unsafe path leaves that entry untouched so a damaged
 * store is never silently rewritten.
 *
 * Usage: node scripts/compress-snapshots.mjs [--memory-root DIR] [--dry-run]
 */
import { existsSync, lstatSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { gzipSync } from "node:zlib";
import { decodeSnapshot, isCompressedSnapshot, snapshotContentHash } from "../src/store/snapshot-files.ts";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const rootIndex = args.indexOf("--memory-root");
const rootArg = rootIndex >= 0 ? args[rootIndex + 1] : undefined;
if (rootIndex >= 0 && !rootArg) {
  console.error("--memory-root requires a directory");
  process.exit(1);
}
// Mirror the extension's store resolution so the migration never touches a
// different store than the one pi reads.
const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const root = resolve(rootArg ?? join(agentDir, "memory"));
const dbPath = join(root, "state.sqlite");
if (!existsSync(dbPath)) {
  console.error(`no memory store at ${root}`);
  process.exit(1);
}

// SELECT-only: never checkpoint, journal or otherwise write during migration.
const db = new DatabaseSync(dbPath, { readOnly: true });
const sources = resolve(join(root, "sources"));
const rows = db.prepare("SELECT snapshot_path, snapshot_hash FROM source_revisions").all();
let converted = 0, skipped = 0, bytesBefore = 0, bytesAfter = 0, damaged = 0;

try {
  for (const row of rows) {
    const path = resolve(row.snapshot_path);
    if (!path.startsWith(sources + sep)) { damaged++; console.error(`outside store: ${path}`); continue; }
    if (!existsSync(path)) { skipped++; continue; }
    if (lstatSync(path).isSymbolicLink() || lstatSync(dirname(path)).isSymbolicLink()) {
      damaged++;
      console.error(`symlink rejected: ${path}`);
      continue;
    }
    const before = readFileSync(path);
    let text;
    try {
      text = decodeSnapshot(before);
    } catch {
      damaged++;
      console.error(`undecodable snapshot, left untouched: ${path}`);
      continue;
    }
    if (snapshotContentHash(before) !== row.snapshot_hash) {
      damaged++;
      console.error(`hash mismatch, left untouched: ${path}`);
      continue;
    }
    if (isCompressedSnapshot(before)) { skipped++; continue; }
    const after = gzipSync(Buffer.from(text, "utf8"), { level: 9 });
    if (after.length >= before.length) { skipped++; continue; }
    if (!dryRun) {
      const temp = join(dirname(path), `.compress-${process.pid}-${Date.now()}.tmp`);
      writeFileSync(temp, after, { mode: 0o600, flag: "wx" });
      renameSync(temp, path);
    }
    converted++;
    bytesBefore += before.length;
    bytesAfter += after.length;
  }
} finally {
  db.close();
}

console.log(JSON.stringify({ root, dryRun, scanned: rows.length, converted, skipped, damaged,
  beforeMB: +(bytesBefore / 1e6).toFixed(1), afterMB: +(bytesAfter / 1e6).toFixed(1),
  savedMB: +((bytesBefore - bytesAfter) / 1e6).toFixed(1) }, null, 2));
if (damaged) process.exitCode = 2;
