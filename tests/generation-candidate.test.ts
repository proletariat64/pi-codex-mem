import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig, type MemoryVersion } from "../src/config.ts";
import { openStateDb } from "../src/store/db.ts";
import { claimConsolidation, finishConsolidation, getPublishedGeneration, selectConsolidation } from "../src/store/consolidation.ts";
import { consolidationPromptHash } from "../src/pipeline/consolidate.ts";
import { prepareGenerationCandidate } from "../src/pipeline/candidate.ts";
import { MINIMAL_V1_SUMMARY } from "../src/pipeline/validate.ts";

const NOW = Date.UTC(2026, 8, 29);
const hash = (text: string) => createHash("sha256").update(text).digest("hex");

function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "pi-generation-candidate-"));
  const db = openStateDb(root);
  const config = defaultConfig("UTC");
  let revision = 0;
  t.after(() => { if (db.isOpen) db.close(); rmSync(root, { recursive: true, force: true }); });
  function prepare(version: MemoryVersion) {
    const snapshot = selectConsolidation(db, { memoryVersion: version, now: NOW });
    const lease = claimConsolidation(db, { memoryVersion: version, owner: "candidate-test",
      now: NOW, promptHash: consolidationPromptHash(config, version), inputRevisionHash: String(++revision), modelRequired: false });
    assert.ok(lease);
    const controller = new AbortController();
    const candidate = prepareGenerationCandidate({ db, root, lease, snapshot, config,
      signal: controller.signal, clock: () => NOW });
    // Tests know the leased path; the candidate interface does not expose it.
    const staging = join(root, "versions", version, "staging", `${lease.jobId}-${lease.fence}`);
    return { candidate, staging, lease, controller };
  }
  function published(version: MemoryVersion) {
    const generation = getPublishedGeneration(db, version, NOW);
    assert.ok(generation);
    return generation;
  }
  return { root, db, config, prepare, published };
}

for (const version of ["v1", "v2"] as const) {
  test(`${version} lease rejects an opposite-version candidate before staging or writer access`, t => {
    const f = fixture(t);
    const legitimate = f.prepare(version);
    const other = version === "v1" ? "v2" : "v1";
    const snapshot = selectConsolidation(f.db, { memoryVersion: other, now: NOW });
    const job = f.db.prepare("SELECT * FROM jobs WHERE job_id = ?").get(legitimate.lease.jobId);
    assert.throws(() => prepareGenerationCandidate({ db: f.db, root: f.root, config: f.config,
      lease: legitimate.lease, snapshot, signal: new AbortController().signal,
      clock: () => { assert.fail("mismatched candidates must be rejected before clock or prior access"); } }),
    /publication version mismatch/);
    assert.equal(existsSync(join(f.root, "versions", other, "staging", `${legitimate.lease.jobId}-${legitimate.lease.fence}`)), false);
    assert.equal(existsSync(legitimate.staging), true);
    assert.deepEqual(f.db.prepare("SELECT * FROM jobs WHERE job_id = ?").get(legitimate.lease.jobId), job);
    assert.equal(getPublishedGeneration(f.db, other, NOW), null);
    legitimate.candidate.dispose();
  });

  test(`${version} candidate publishes validated artifacts and releases only its staging path`, t => {
    const f = fixture(t);
    const { candidate, staging } = f.prepare(version);
    assert.equal("directory" in candidate, false);
    assert.equal("manifest" in candidate, false);
    assert.equal(candidate.checkUnchanged(), false);
    candidate.writeMinimal();
    assert.equal(candidate.publish(), true);
    const generation = f.published(version);
    const manifestText = readFileSync(join(generation.directory, "manifest.json"), "utf8");
    const manifest = JSON.parse(manifestText);
    assert.equal(hash(manifestText), generation.manifestHash);
    assert.equal(manifest.memoryVersion, version);
    assert.equal(manifest.controlEpoch, generation.controlEpoch);
    for (const [path, digest] of Object.entries(manifest.fileHashes)) {
      assert.equal(hash(readFileSync(join(generation.directory, path), "utf8")), digest);
    }
    assert.equal(readFileSync(join(generation.directory, "memory_summary.md"), "utf8"), MINIMAL_V1_SUMMARY);
    assert.equal(existsSync(join(generation.directory, "MEMORY.md")), version === "v1");
    candidate.dispose();
    assert.equal(existsSync(staging), false);
    assert.equal(existsSync(generation.directory), true);
    assert.equal(f.published(version).generationId, generation.generationId);
  });

  test(`${version} candidate validates unchanged reused outputs before lease completion`, t => {
    const f = fixture(t);
    const first = f.prepare(version);
    first.candidate.writeMinimal();
    assert.equal(first.candidate.publish(), true);
    first.candidate.dispose();
    const generation = f.published(version);
    const next = f.prepare(version);
    assert.equal(next.candidate.checkUnchanged(), true);
    writeFileSync(join(next.staging, "memory_summary.md"), "invalid summary\n");
    assert.throws(() => next.candidate.checkUnchanged());
    assert.equal(f.db.prepare("SELECT status FROM jobs WHERE job_id = ?").get(next.lease.jobId)?.status, "leased");
    next.candidate.dispose();
    assert.equal(existsSync(next.staging), false);
    assert.equal(f.published(version).generationId, generation.generationId);
  });

  test(`${version} candidate refuses invalid outputs without finalizing provenance or publishing`, t => {
    const f = fixture(t);
    const { candidate, staging, lease } = f.prepare(version);
    candidate.writeMinimal();
    writeFileSync(join(staging, "memory_summary.md"), "invalid summary\n");
    assert.throws(() => candidate.publish());
    assert.equal(getPublishedGeneration(f.db, version, NOW), null);
    assert.deepEqual(JSON.parse(readFileSync(join(staging, "manifest.json"), "utf8")).fileHashes, {});
    candidate.dispose();
    assert.equal(existsSync(staging), false);
    // The scheduler, not candidate disposal, owns failure classification and lease release.
    assert.equal(f.db.prepare("SELECT status FROM jobs WHERE job_id = ?").get(lease.jobId)?.status, "leased");
    assert.equal(finishConsolidation(f.db, lease, "blocked", "validation_failed", NOW), true);
  });

  test(`${version} candidate rejects cancellation before finalization and preserves the prior Generation`, t => {
    const f = fixture(t);
    const first = f.prepare(version);
    first.candidate.writeMinimal();
    assert.equal(first.candidate.publish(), true);
    first.candidate.dispose();
    const generation = f.published(version);
    const { candidate, staging, controller } = f.prepare(version);
    candidate.writeMinimal();
    controller.abort();
    assert.throws(() => candidate.publish(), /cancelled/);
    assert.deepEqual(JSON.parse(readFileSync(join(staging, "manifest.json"), "utf8")).fileHashes, {});
    candidate.dispose();
    assert.equal(existsSync(staging), false);
    assert.equal(f.published(version).generationId, generation.generationId);
  });

  test(`${version} candidate does not inherit a prior manifest whose stored proof differs`, t => {
    const f = fixture(t);
    const first = f.prepare(version);
    first.candidate.writeMinimal();
    assert.equal(first.candidate.publish(), true);
    first.candidate.dispose();
    const generation = f.published(version);
    // A manifest can have valid JSON yet differ from the DB-selected artifact proof.
    writeFileSync(join(generation.directory, "manifest.json"), "{}\n");
    const next = f.prepare(version);
    assert.equal(next.candidate.checkUnchanged(), false);
    assert.equal(existsSync(join(next.staging, "memory_summary.md")), false);
    assert.equal(existsSync(join(next.staging, "MEMORY.md")), false);
    next.candidate.writeMinimal();
    assert.equal(next.candidate.publish(), true);
    next.candidate.dispose();
    assert.notEqual(f.published(version).generationId, generation.generationId);
    assert.equal(existsSync(generation.directory), true);
  });

  test(`${version} candidate reports CAS rejection without owning global orphan cleanup`, t => {
    const f = fixture(t);
    const { candidate, staging, lease } = f.prepare(version);
    candidate.writeMinimal();
    f.db.prepare("UPDATE jobs SET fence = fence + 1 WHERE job_id = ?").run(lease.jobId);
    assert.equal(candidate.publish(), false);
    assert.equal(getPublishedGeneration(f.db, version, NOW), null);
    const generations = join(f.root, "versions", version, "generations");
    assert.equal(readdirSync(generations).length, 1);
    candidate.dispose();
    assert.equal(existsSync(staging), false);
    assert.equal(readdirSync(generations).length, 1, "renamed orphan stays with the global cleanup protocol");
    assert.equal(f.db.prepare("SELECT status FROM jobs WHERE job_id = ?").get(lease.jobId)?.status, "leased");
  });

  test(`${version} expired candidate disposal cannot delete its reclaimed lease's successor workspace`, t => {
    const f = fixture(t);
    const dead = f.prepare(version);
    const later = dead.lease.leaseExpiresAt + 1;
    const lease = claimConsolidation(f.db, { memoryVersion: version, owner: "successor", now: later,
      promptHash: dead.lease.promptHash, inputRevisionHash: "1", modelRequired: false });
    assert.ok(lease);
    assert.equal(lease.jobId, dead.lease.jobId);
    assert.ok(lease.fence > dead.lease.fence);
    const snapshot = selectConsolidation(f.db, { memoryVersion: version, now: later });
    const successor = prepareGenerationCandidate({ db: f.db, root: f.root, config: f.config, lease, snapshot,
      signal: new AbortController().signal, clock: () => later });
    const successorPath = join(f.root, "versions", version, "staging", `${lease.jobId}-${lease.fence}`);
    successor.writeMinimal();
    dead.candidate.dispose();
    assert.equal(existsSync(dead.staging), false);
    assert.equal(existsSync(successorPath), true);
    assert.equal(successor.publish(), true);
    successor.dispose();
    const generation = getPublishedGeneration(f.db, version, later);
    assert.ok(generation);
    assert.equal(readFileSync(join(generation.directory, "memory_summary.md"), "utf8"), MINIMAL_V1_SUMMARY);
  });
}
