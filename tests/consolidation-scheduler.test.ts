import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../src/config.ts";
import { openStateDb } from "../src/store/db.ts";
import { getPublishedGeneration, selectConsolidation } from "../src/store/consolidation.ts";
import { ConsolidationScheduler } from "../src/pipeline/scheduler.ts";
import { buildStaging } from "../src/pipeline/staging.ts";
import { MINIMAL_V1_SUMMARY } from "../src/pipeline/validate.ts";
import { acquireReadView } from "../src/read/view.ts";

const NOW = Date.UTC(2026, 8, 29);

function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "pi-memory-consolidation-scheduler-"));
  const db = openStateDb(root);
  const config = defaultConfig("UTC");
  let now = NOW;
  const scheduled: { run: () => Promise<void>; delay: number; cancelled: boolean }[] = [];
  const scheduler = new ConsolidationScheduler({ db, root, config: () => config,
    modelPort: () => { throw new Error("empty selection must not resolve a model"); },
    now: () => now, isForegroundIdle: () => true,
    timer: { schedule(run, delay) { const item = { run, delay, cancelled: false }; scheduled.push(item);
      return { cancel: () => { item.cancelled = true; } }; } } });
  t.after(async () => { await scheduler.stop(); db.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, db, config, scheduler, scheduled, advance: (milliseconds: number) => { now += milliseconds; } };
}

test("an expired writer's leftover staging cannot block a reclaimed lease or serve uncommitted output", async (t) => {
  const { root, db, scheduler, advance } = fixture(t);
  await scheduler.runPass();
  await scheduler.runPass();
  const before = getPublishedGeneration(db, "v1", NOW)!;
  const abandoned = db.prepare("SELECT job_id, prompt_hash, fence FROM jobs WHERE kind = 'consolidate' ORDER BY rowid DESC LIMIT 1")
    .get() as { job_id: string; prompt_hash: string; fence: number };
  db.prepare("UPDATE jobs SET status = 'leased', owner = 'dead-process', attempt_count = 1, lease_expires_at = ? WHERE job_id = ?")
    .run(NOW + 180_000, abandoned.job_id);
  const snapshot = selectConsolidation(db, { memoryVersion: "v1", now: NOW });
  // Include both an older layout and this writer's fenced directory.
  const leftovers = [abandoned.job_id, `${abandoned.job_id}-${abandoned.fence}`].map((jobId) =>
    buildStaging({ root, jobId, snapshot, promptHash: abandoned.prompt_hash }).directory);
  for (const directory of leftovers) writeFileSync(join(directory, "memory_summary.md"), "uncommitted claim");
  advance(180_001);
  assert.deepEqual(await scheduler.runPass(), [{ status: "unchanged" }]);
  assert.equal(getPublishedGeneration(db, "v1", NOW + 180_001)?.generationId, before.generationId);
  assert.equal(acquireReadView({ db, root, memoryVersion: "v1", now: NOW + 180_001 })?.summary, MINIMAL_V1_SUMMARY);
  assert.equal((db.prepare("SELECT status FROM jobs WHERE job_id = ?").get(abandoned.job_id) as { status: string }).status, "succeeded");
  assert.ok(leftovers.every((directory) => !existsSync(directory)));
});

test("empty selection publishes deterministic v1 artifacts without a model and unchanged input preserves the generation", async (t) => {
  const { root, db, scheduler, config } = fixture(t);
  assert.deepEqual(await scheduler.runPass(), [{ status: "published" }]);
  const generation = getPublishedGeneration(db, "v1", NOW);
  assert.ok(generation);
  assert.equal(acquireReadView({ db, root, memoryVersion: "v1", now: NOW })?.summary, MINIMAL_V1_SUMMARY);
  assert.deepEqual(await scheduler.runPass(), [{ status: "unchanged" }]);
  assert.equal(getPublishedGeneration(db, "v1", NOW)?.generationId, generation.generationId);
  config.version = "v2";
  assert.deepEqual(await scheduler.runPass(), []);
  assert.equal(acquireReadView({ db, root, memoryVersion: "v2", now: NOW }), null);
});

test("a valid larger source-count configuration stays within the v1 policy and can publish", async (t) => {
  const { root, db, config, scheduler } = fixture(t);
  config.schedule.maxConsolidationSources = 4096;
  assert.deepEqual(await scheduler.runPass(), [{ status: "published" }]);
  const generation = getPublishedGeneration(db, "v1", NOW)!;
  assert.equal(db.prepare("SELECT max_sources FROM generations WHERE generation_id = ?").get(generation.generationId)?.max_sources, 256);
  assert.equal(acquireReadView({ db, root, memoryVersion: "v1", now: NOW })?.summary, MINIMAL_V1_SUMMARY);
});

test("changed generated output rearms a content-based rebuild and never serves tampered summary", async (t) => {
  const { root, db, scheduler, scheduled } = fixture(t);
  await scheduler.runPass();
  const before = getPublishedGeneration(db, "v1", NOW)!;
  assert.equal(scheduled.filter((item) => !item.cancelled).length, 0);
  writeFileSync(join(before.directory, "memory_summary.md"), MINIMAL_V1_SUMMARY + "Unsupported claim\n");
  assert.equal(acquireReadView({ db, root, memoryVersion: "v1", now: NOW }), null);
  scheduler.trigger();
  const due = scheduled.filter((item) => !item.cancelled);
  assert.equal(due.length, 1);
  assert.equal(due[0]!.delay, 0);
  await due[0]!.run();
  const after = getPublishedGeneration(db, "v1", NOW)!;
  assert.notEqual(after.generationId, before.generationId);
  assert.equal(readFileSync(join(after.directory, "memory_summary.md"), "utf8"), MINIMAL_V1_SUMMARY);
});
