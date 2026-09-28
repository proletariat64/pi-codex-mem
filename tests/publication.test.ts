import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { openStateDb } from "../src/store/db.ts";
import { claimConsolidation, finishConsolidation, getPublishedGeneration, selectConsolidation } from "../src/store/consolidation.ts";
import { cleanupGenerations, publishGeneration } from "../src/pipeline/publish.ts";

const NOW = Date.UTC(2026, 8, 1);
function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "pi-publish-"));
  const db = openStateDb(root);
  t.after(() => { if (db.isOpen) db.close(); rmSync(root, { recursive: true, force: true }); });
  function candidate(id: string, now = NOW) {
    const lease = claimConsolidation(db, { memoryVersion: "v1", owner: id, promptHash: "prompt", inputRevisionHash: id, now });
    assert.ok(lease);
    const snapshot = selectConsolidation(db, { memoryVersion: "v1", now });
    const stagingDir = join(root, "versions", "v1", "staging", lease.jobId);
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

test("actual process crashes around fsync, rename and CAS preserve complete old or new publication", (t) => {
  for (const boundary of ["before_fsync", "after_fsync", "after_rename", "before_cas", "after_cas"] as const) {
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
    } finally { reopened.close(); }
  }
});
