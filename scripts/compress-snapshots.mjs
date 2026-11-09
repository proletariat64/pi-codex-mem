#!/usr/bin/env node
/**
 * One-time rewrite of existing plaintext snapshots into the compressed layout.
 *
 * Snapshots are immutable by content, not by encoding: each file is decoded,
 * its decoded content hash is verified against the recorded `snapshot_hash`,
 * then the same JSON text is re-encoded with gzip. A content mismatch leaves
 * that file untouched so a damaged store is never silently rewritten.
 *
 * Usage: node scripts/compress-snapshots.mjs [--memory-root DIR] [--dry-run]
 */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { gunzipSync, gzipSync } from "node:zlib";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const rootIndex = args.indexOf("--memory-root");
const root = resolve(rootIndex >= 0 ? args[rootIndex + 1] : join(homedir(), ".pi", "agent", "memory"));
const dbPath = join(root, "state.sqlite");
if (!existsSync(dbPath)) {
  console.error(`no memory store at ${root}`);
  process.exit(1);
}

const isGzip = (bytes) => bytes.length > 1 && bytes[0] === 0x1f && bytes[1] === 0x8b;
const decode = (bytes) => (isGzip(bytes) ? gunzipSync(bytes) : bytes).toString("utf8");

const db = new DatabaseSync(dbPath, { readOnly: dryRun });
const sources = resolve(join(root, "sources"));
const rows = db.prepare("SELECT source_id, snapshot_path, snapshot_hash FROM source_revisions").all();
let converted = 0, skipped = 0, bytesBefore = 0, bytesAfter = 0, damaged = 0;

for (const row of rows) {
  const path = resolve(row.snapshot_path);
  if (!path.startsWith(sources + sep)) { damaged++; console.error(`outside store: ${path}`); continue; }
  if (!existsSync(path)) { skipped++; continue; }
  if (lstatSync(path).isSymbolicLink()) { damaged++; console.error(`symlink rejected: ${path}`); continue; }
  const before = readFileSync(path);
  const text = decode(before);
  const contentHash = createHash("sha256").update(text, "utf8").digest("hex");
  if (contentHash !== row.snapshot_hash) { damaged++; console.error(`hash mismatch, left untouched: ${path}`); continue; }
  if (isGzip(before)) { skipped++; continue; }
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

db.close();
console.log(JSON.stringify({ root, dryRun, scanned: rows.length, converted, skipped, damaged,
  beforeMB: +(bytesBefore / 1e6).toFixed(1), afterMB: +(bytesAfter / 1e6).toFixed(1),
  savedMB: +((bytesBefore - bytesAfter) / 1e6).toFixed(1) }, null, 2));
if (damaged) process.exitCode = 2;
