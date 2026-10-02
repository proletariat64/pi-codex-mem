import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs, { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { openStateDb, registerGenerationPin } from "../src/store/db.ts";
import { claimConsolidation, finishConsolidation, getPublishedGeneration, selectConsolidation } from "../src/store/consolidation.ts";
import { cleanupGenerations, publishGeneration } from "../src/pipeline/publish.ts";
import { buildStaging } from "../src/pipeline/staging.ts";
import { validateV2Artifacts, writeMinimalV2 } from "../src/pipeline/validate.ts";

const NOW = Date.UTC(2026, 8, 1);
const BOUNDARIES = ["before_fsync", "after_fsync", "before_rename", "after_rename_before_fsync", "after_rename", "before_cas", "after_cas"] as const;
function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "pi-publish-"));
  const db = openStateDb(root);
  t.after(() => { if (db.isOpen) db.close(); rmSync(root, { recursive: true, force: true }); });
  function candidate(id: string, now = NOW, memoryVersion: "v1" | "v2" = "v1") {
    const lease = claimConsolidation(db, { memoryVersion, owner: id, promptHash: "prompt", inputRevisionHash: id, now });
    assert.ok(lease);
    const snapshot = selectConsolidation(db, { memoryVersion, now });
    if (memoryVersion === "v2") {
      const stage = buildStaging({ root, jobId: lease.jobId, snapshot, promptHash: lease.promptHash });
      writeMinimalV2(stage.directory);
      stage.manifest.fileHashes = validateV2Artifacts({ directory: stage.directory, snapshot }).fileHashes;
      const manifest = JSON.stringify(stage.manifest);
      writeFileSync(join(stage.directory, "manifest.json"), manifest);
      return { db, root, stagingDir: stage.directory, lease, snapshot, inputHash: stage.inputHash,
        manifestHash: createHash("sha256").update(manifest).digest("hex"), generationId: id, now };
    }
    const stagingDir = join(root, "versions", memoryVersion, "staging", lease.jobId);
    mkdirSync(stagingDir, { recursive: true });
    writeFileSync(join(stagingDir, "MEMORY.md"), `# ${id}\n`);
    writeFileSync(join(stagingDir, "memory_summary.md"), `v1\n${id}\n`);
    const manifest = JSON.stringify({ memoryVersion: "v1", generation: id });
    writeFileSync(join(stagingDir, "manifest.json"), manifest);
    return { db, root, stagingDir, lease, snapshot, inputHash: id,
      manifestHash: createHash("sha256").update(manifest).digest("hex"), generationId: id, now };
  }
  return { root, db, candidate };
}

test("publication serves only immutable DB-selected complete directories and retains bounded recovery", (t) => {
  const { root, db, candidate } = fixture(t);
  for (let n = 0; n < 5; n++) {
    const published = publishGeneration(candidate(`generation-${n}`, NOW + n));
    assert.equal(published.published, true);
    assert.equal(readFileSync(join(published.path, "MEMORY.md"), "utf8"), `# generation-${n}\n`);
  }
  assert.equal(getPublishedGeneration(db, "v1", NOW + 6)?.generationId, "generation-4");
  cleanupGenerations({ db, root, now: NOW + 6, pinnedGenerationIds: ["generation-0"] });
  assert.deepEqual((db.prepare("SELECT generation_id FROM generations ORDER BY generation_id").all() as { generation_id: string }[])
    .map(g => g.generation_id), ["generation-0", "generation-2", "generation-3", "generation-4"]);
});

test("cleanup retains another process's registered generation pin until its lease expires", (t) => {
  const { root, db, candidate } = fixture(t);
  for (let n = 0; n < 5; n++) assert.equal(publishGeneration(candidate(`generation-${n}`, NOW + n)).published, true);
  // Another foreground run in a different process pinned generation-0 and
  // registered the lease in the shared store; this process has no local pins.
  registerGenerationPin(db, { ownerId: "other-process", generationId: "generation-0",
    memoryVersion: "v1", now: NOW + 6 });
  cleanupGenerations({ db, root, now: NOW + 6 });
  assert.deepEqual((db.prepare("SELECT generation_id FROM generations ORDER BY generation_id").all() as { generation_id: string }[])
    .map(g => g.generation_id), ["generation-0", "generation-2", "generation-3", "generation-4"]);
  assert.equal(existsSync(join(root, "versions", "v1", "generations", "generation-0")), true);
  // Once the lease lapses, the same recovery-copy bound applies again.
  cleanupGenerations({ db, root, now: NOW + 901_000 });
  assert.deepEqual((db.prepare("SELECT generation_id FROM generations ORDER BY generation_id").all() as { generation_id: string }[])
    .map(g => g.generation_id), ["generation-2", "generation-3", "generation-4"]);
  assert.equal(existsSync(join(root, "versions", "v1", "generations", "generation-0")), false);
});

test("v2 publication rejects forbidden files and directories even without caller validation", (t) => {
  const { root, db, candidate } = fixture(t);
  const old = publishGeneration(candidate("v2-old", NOW, "v2"));
  assert.equal(old.published, true);
  for (const forbidden of ["MEMORY.md", "raw_memories.md", "skills/unsafe/SKILL.md", "versions/v1/memory_summary.md", "empty-skills/"]) {
    const next = candidate(`v2-unsafe-${forbidden.replace(/[^a-z0-9]/gi, "-")}`, NOW + 1, "v2");
    const parts = forbidden.split("/").filter(Boolean);
    if (forbidden.endsWith("/")) mkdirSync(join(next.stagingDir, ...parts), { recursive: true });
    else {
      mkdirSync(join(next.stagingDir, ...parts.slice(0, -1)), { recursive: true });
      writeFileSync(join(next.stagingDir, ...parts), "forbidden");
    }
    assert.throws(() => publishGeneration(next), /forbidden v2 artifact/);
    assert.equal(existsSync(join(root, "versions", "v2", "generations", next.generationId)), false);
    assert.equal(getPublishedGeneration(db, "v2", NOW + 2)?.generationId, old.generationId);
    finishConsolidation(db, next.lease, "blocked", "invalid_artifacts", NOW + 2);
  }
});

test("failed CAS stays unserved and orphan cleanup respects live staging ownership", (t) => {
  const { root, db, candidate } = fixture(t);
  assert.equal(publishGeneration(candidate("old")).published, true);
  const next = candidate("orphan", NOW + 1);
  next.snapshot.selectionHash = "stale-selection";
  const rejected = publishGeneration(next);
  assert.equal(rejected.published, false);
  assert.equal(getPublishedGeneration(db, "v1", NOW + 2)?.generationId, "old");
  cleanupGenerations({ db, root, now: NOW + 2 });
  assert.equal(existsSync(rejected.path), true);
  assert.equal(finishConsolidation(db, next.lease, "superseded", "publication_cas", NOW + 3), true);
  cleanupGenerations({ db, root, now: NOW + 4 });
  assert.equal(existsSync(rejected.path), false);
  assert.equal(getPublishedGeneration(db, "v1", NOW + 4)?.generationId, "old");
});

test("publication rejects staged symlinks and rechecks the lease clock after disk work", (t) => {
  const { db, candidate } = fixture(t);
  const staged = candidate("unsafe");
  symlinkSync("MEMORY.md", join(staged.stagingDir, "escape.md"));
  assert.throws(() => publishGeneration(staged), /unsafe publication file/);
  rmSync(join(staged.stagingDir, "escape.md"));
  let time = NOW;
  const rejected = publishGeneration({ ...staged, now: () => time,
    fault: point => { if (point === "after_rename") time = NOW + 180_000; } });
  assert.equal(rejected.published, false);
  assert.equal(getPublishedGeneration(db, "v1", time), null);
});

test("T14 v1: actual process crashes around fsync, rename and CAS preserve complete old or new publication", (t) => {
  for (const boundary of BOUNDARIES) {
    const { root, db, candidate } = fixture(t);
    assert.equal(publishGeneration(candidate("old")).published, true);
    const next = candidate("new", NOW + 1);
    const argsPath = join(root, "args.json");
    writeFileSync(argsPath, JSON.stringify({ ...next, db: undefined }));
    const script = `import {readFileSync} from 'node:fs';
      import {openStateDb} from ${JSON.stringify(new URL("../src/store/db.ts", import.meta.url).href)};
      import {publishGeneration} from ${JSON.stringify(new URL("../src/pipeline/publish.ts", import.meta.url).href)};
      const args=JSON.parse(readFileSync(process.argv[1],'utf8'));
      const db=openStateDb(args.root);
      publishGeneration({...args,db,fault:(point)=>{if(point===process.argv[2])process.exit(71)}});`;
    db.close();
    const crashed = spawnSync(process.execPath, ["--input-type=module", "-e", script, argsPath, boundary], { encoding: "utf8" });
    assert.equal(crashed.status, 71, crashed.stderr);
    const reopened = openStateDb(root);
    try {
      const current = getPublishedGeneration(reopened, "v1", NOW + 2);
      assert.equal(current?.generationId, boundary === "after_cas" ? "new" : "old", boundary);
      assert.equal(readFileSync(join(current!.directory, "MEMORY.md"), "utf8"), `# ${current!.generationId}\n`);
      cleanupGenerations({ db: reopened, root, now: NOW + 3 });
      // A still-live lease must preserve staging/renamed files while the writer can resume.
      if (boundary !== "after_cas") assert.ok(reopened.prepare("SELECT 1 FROM jobs WHERE status = 'leased'").get());
      cleanupGenerations({ db: reopened, root, now: NOW + 180_002 });
      assert.deepEqual(readdirSync(join(root, "versions", "v1", "staging")), []);
      assert.deepEqual(readdirSync(join(root, "versions", "v1", "generations")).sort(), boundary === "after_cas" ? ["new", "old"] : ["old"]);
      assert.equal(getPublishedGeneration(reopened, "v1", NOW + 180_002)?.generationId, current!.generationId);
    } finally { reopened.close(); }
  }
});

test("v1/v2 publication CAS keeps independent bases and rejects mixed-version candidates", (t) => {
  const { root, db, candidate } = fixture(t);
  assert.equal(publishGeneration(candidate("v1-old")).published, true);
  assert.equal(publishGeneration(candidate("v2-old", NOW + 1, "v2")).published, true);
  const next = candidate("v2-new", NOW + 2, "v2");
  assert.equal(next.snapshot.baseGenerationId, "v2-old");
  assert.throws(() => publishGeneration({ ...next, snapshot: { ...next.snapshot, memoryVersion: "v1" } }), /version mismatch/);
  assert.throws(() => publishGeneration({ ...next, stagingDir: join(root, "versions", "v1", "staging", next.lease.jobId) }), /escaped version/);
  assert.equal(publishGeneration(next).published, true);
  assert.equal(getPublishedGeneration(db, "v1", NOW + 3)?.generationId, "v1-old");
  assert.equal(getPublishedGeneration(db, "v2", NOW + 3)?.generationId, "v2-new");
  const stale = candidate("v2-stale", NOW + 4, "v2");
  stale.snapshot.baseGenerationId = "v1-old";
  assert.equal(publishGeneration(stale).published, false);
  assert.equal(getPublishedGeneration(db, "v2", NOW + 5)?.generationId, "v2-new");
  assert.throws(() => db.prepare("UPDATE pipeline_state SET active_generation_id = 'v1-old' WHERE memory_version = 'v2'").run(), /version mismatch/);
});

test("v2 publication revalidates summary and provenance instead of trusting a bypassing caller", (t) => {
  const { root, db, candidate } = fixture(t);
  for (const field of ["memoryVersion", "fileHashes", "sources"] as const) {
    const next = candidate(`manifest-${field}`, NOW, "v2");
    const manifest = JSON.parse(readFileSync(join(next.stagingDir, "manifest.json"), "utf8"));
    if (field === "memoryVersion") manifest.memoryVersion = "v1";
    else if (field === "fileHashes") manifest.fileHashes["MEMORY.md"] = "forged";
    else manifest.sources = [{ sourceId: "v1-source", extractionId: "v1-extraction", path: "versions/v1/evidence.md" }];
    const text = JSON.stringify(manifest);
    writeFileSync(join(next.stagingDir, "manifest.json"), text);
    assert.throws(() => publishGeneration({ ...next, manifestHash: createHash("sha256").update(text).digest("hex") }), /manifest does not match/);
    assert.equal(existsSync(join(root, "versions", "v2", "generations", next.generationId)), false);
    finishConsolidation(db, next.lease, "blocked", "invalid_artifacts", NOW + 1);
  }
  const oversized = candidate("v2-oversized", NOW + 2, "v2");
  const summary = readFileSync(join(oversized.stagingDir, "memory_summary.md"), "utf8");
  writeFileSync(join(oversized.stagingDir, "memory_summary.md"), summary + "x".repeat(10_000 - Buffer.byteLength(summary)));
  assert.throws(() => publishGeneration(oversized), /byte/);
  assert.equal(existsSync(join(root, "versions", "v2", "generations", oversized.generationId)), false);
});

test("T14 v2: process crashes leave a complete old or new summary-only generation", (t) => {
  for (const boundary of BOUNDARIES) {
    const { root, db, candidate } = fixture(t);
    assert.equal(publishGeneration(candidate("v2-old", NOW, "v2")).published, true);
    const next = candidate("v2-new", NOW + 1, "v2");
    const argsPath = join(root, "v2-args.json");
    writeFileSync(argsPath, JSON.stringify({ ...next, db: undefined }));
    const script = `import {readFileSync} from 'node:fs';
      import {openStateDb} from ${JSON.stringify(new URL("../src/store/db.ts", import.meta.url).href)};
      import {publishGeneration} from ${JSON.stringify(new URL("../src/pipeline/publish.ts", import.meta.url).href)};
      const args=JSON.parse(readFileSync(process.argv[1],'utf8'));
      const db=openStateDb(args.root);
      publishGeneration({...args,db,fault:point=>{if(point===process.argv[2])process.exit(71)}});`;
    db.close();
    const crashed = spawnSync(process.execPath, ["--input-type=module", "-e", script, argsPath, boundary], { encoding: "utf8" });
    assert.equal(crashed.status, 71, crashed.stderr);
    const reopened = openStateDb(root);
    try {
      const current = getPublishedGeneration(reopened, "v2", NOW + 2);
      assert.equal(current?.generationId, boundary === "after_cas" ? "v2-new" : "v2-old", boundary);
      assert.equal(existsSync(join(current!.directory, "memory_summary.md")), true);
      assert.equal(existsSync(join(current!.directory, "MEMORY.md")), false);
      assert.equal(existsSync(join(current!.directory, "raw_memories.md")), false);
      assert.equal(existsSync(join(current!.directory, "skills")), false);
      cleanupGenerations({ db: reopened, root, now: NOW + 180_002 });
      assert.deepEqual(readdirSync(join(root, "versions", "v2", "staging")), []);
      assert.deepEqual(readdirSync(join(root, "versions", "v2", "generations")).sort(), boundary === "after_cas" ? ["v2-new", "v2-old"] : ["v2-old"]);
      assert.equal(getPublishedGeneration(reopened, "v2", NOW + 180_002)?.generationId, current!.generationId);
    } finally { reopened.close(); }
  }
});

for (const version of ["v1", "v2"] as const) test(`${version}: disk full during fsync preserves the old pointer and permits recovery after orphan cleanup`, t => {
  const { root, db, candidate } = fixture(t); const old = publishGeneration(candidate("old", NOW, version));
  const next = candidate("disk-full", NOW + 1, version); const sync = fs.fsyncSync;
  fs.fsyncSync = () => { throw Object.assign(new Error("disk full"), { code: "ENOSPC" }); }; syncBuiltinESMExports();
  try { assert.throws(() => publishGeneration(next), error => (error as NodeJS.ErrnoException).code === "ENOSPC"); }
  finally { fs.fsyncSync = sync; syncBuiltinESMExports(); }
  assert.equal(getPublishedGeneration(db, version, NOW + 2)?.generationId, old.generationId);
  assert.equal(existsSync(join(root, "versions", version, "generations", next.generationId)), false);
  finishConsolidation(db, next.lease, "blocked", "ENOSPC", NOW + 2);
  cleanupGenerations({ db, root, now: NOW + 3 }); assert.equal(existsSync(next.stagingDir), false);
  assert.equal(publishGeneration(candidate("recovered", NOW + 4, version)).published, true);
});
