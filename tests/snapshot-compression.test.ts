import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { decodeSnapshot, isCompressedSnapshot, readSnapshotText, snapshotContentHash, writeSnapshotFile } from "../src/store/snapshot-files.ts";

function root(t: test.TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-snapshot-compress-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const payload = { schemaVersion: 1, sourceId: "src_x", items: Array.from({ length: 200 }, (_, index) => ({
  entryId: `e${index}`, role: "user", text: `repeated evidence line ${index % 5} `.repeat(40) })) };

test("written snapshots are gzip-compressed and round-trip to the same text", (t) => {
  const dir = root(t);
  const saved = writeSnapshotFile(dir, "lineage", "rev", payload);
  const bytes = readFileSync(saved.path);
  assert.ok(isCompressedSnapshot(bytes), "payload is stored compressed");
  assert.equal(bytes.length < 4096, true, `compressed size stays small (${bytes.length} bytes)`);
  const text = readSnapshotText(saved.path);
  assert.deepEqual(JSON.parse(text), payload);
});

test("identity hash covers decoded content, so encoding never changes a revision", (t) => {
  const dir = root(t);
  const saved = writeSnapshotFile(dir, "lineage", "rev", payload);
  const plain = Buffer.from(JSON.stringify(payload, null, 2) + "\n", "utf8");
  assert.equal(saved.hash, snapshotContentHash(plain), "plaintext hash matches the stored hash");
  assert.equal(snapshotContentHash(readFileSync(saved.path)), saved.hash, "compressed hash matches the stored hash");
  assert.equal(decodeSnapshot(gzipSync(plain)), plain.toString("utf8"));
});

test("a legacy plaintext snapshot stays readable and idempotent", (t) => {
  const dir = root(t);
  const text = JSON.stringify(payload, null, 2) + "\n";
  const legacyDir = join(dir, "sources", "lineage");
  mkdirSync(legacyDir, { recursive: true, mode: 0o700 });
  const legacyPath = join(legacyDir, "rev.json");
  writeFileSync(legacyPath, text, { mode: 0o600 });
  assert.equal(readSnapshotText(legacyPath), text);
  const saved = writeSnapshotFile(dir, "lineage", "rev", payload);
  assert.equal(saved.path, legacyPath);
  assert.equal(saved.hash, snapshotContentHash(Buffer.from(text, "utf8")));
  assert.equal(statSync(legacyPath).size, Buffer.byteLength(text), "an existing plaintext snapshot is left untouched");
});

test("compressed snapshots reject content that differs for the same revision", (t) => {
  const dir = root(t);
  writeSnapshotFile(dir, "lineage", "rev", payload);
  assert.throws(() => writeSnapshotFile(dir, "lineage", "rev", { ...payload, sourceId: "src_y" }),
    /is immutable: content differs/);
});
