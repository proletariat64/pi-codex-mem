import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../src/config.ts";
import { openStateDb } from "../src/store/db.ts";
import { claimConsolidation, getPublishedGeneration, selectConsolidation } from "../src/store/consolidation.ts";
import { ConsolidationScheduler } from "../src/pipeline/scheduler.ts";
import { buildStaging, textHash } from "../src/pipeline/staging.ts";
import { MINIMAL_V1_SUMMARY } from "../src/pipeline/validate.ts";
import { acquireEvidencePin, type MemoryReadPin } from "../src/read/evidence.ts";
import type { ConsolidationModelPort } from "../src/pipeline/model-port.ts";
import { createAssistantMessageEventStream, type Api, type AssistantMessage, type Model } from "@earendil-works/pi-ai";

const NOW = Date.UTC(2026, 8, 29);
function renderedSummary(pin: MemoryReadPin, cwd: string): string {
  const section = pin.renderSection(cwd);
  const open = "<historical_memory_evidence>\n"; const close = "\n</historical_memory_evidence>";
  const start = section.indexOf(open); const end = section.lastIndexOf(close);
  assert.ok(start >= 0 && end >= start + open.length, "rendered section includes its evidence boundary");
  return section.slice(start + open.length, end);
}

function fixture(t: test.TestContext, modelPort: () => ConsolidationModelPort | null = () => { throw new Error("empty selection must not resolve a model"); }) {
  const root = mkdtempSync(join(tmpdir(), "pi-memory-consolidation-scheduler-"));
  const db = openStateDb(root);
  const config = defaultConfig("UTC");
  let now = NOW;
  const scheduled: { run: () => Promise<void>; delay: number; cancelled: boolean }[] = [];
  const scheduler = new ConsolidationScheduler({ db, root, config: () => config,
    modelPort,
    now: () => now, isForegroundIdle: () => true,
    timer: { schedule(run, delay) { const item = { run, delay, cancelled: false }; scheduled.push(item);
      return { cancel: () => { item.cancelled = true; } }; } } });
  t.after(async () => { await scheduler.stop(); db.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, db, config, scheduler, scheduled, advance: (milliseconds: number) => { now += milliseconds; } };
}

test("an expired writer's leftover staging cannot block a reclaimed lease or serve uncommitted output", async (t) => {
  const { root, db, scheduler, advance, scheduled } = fixture(t);
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
  assert.deepEqual(await scheduler.runPass(), [], "a live foreign lease must not be stolen");
  assert.equal(scheduled.filter(item => !item.cancelled).at(-1)?.delay, 180_000,
    "lease contention keeps a recovery wake even when content is unchanged");
  advance(180_001);
  assert.deepEqual(await scheduler.runPass(), [{ status: "unchanged" }]);
  assert.equal(getPublishedGeneration(db, "v1", NOW + 180_001)?.generationId, before.generationId);
  assert.equal(renderedSummary(acquireEvidencePin({ db, root, memoryVersion: "v1", now: NOW + 180_001 })!, root), MINIMAL_V1_SUMMARY);
  assert.equal((db.prepare("SELECT status FROM jobs WHERE job_id = ?").get(abandoned.job_id) as { status: string }).status, "succeeded");
  assert.ok(leftovers.every((directory) => !existsSync(directory)));
});

test("two dirty versions rotate the first model opportunity after a transport retry", async (t) => {
  const order: string[] = [];
  const model: Model<Api> = { provider: "mock", id: "writer", name: "Writer", api: "openai-completions", baseUrl: "https://unused.invalid",
    reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 8_000 };
  const port: ConsolidationModelPort = { resolve: () => model, stream: (_model, context) => {
    const tools = context.messages.flatMap(message => message.role === "system" ? message.toolsAdded ?? [] : []);
    order.push(tools.some(tool => tool.name === "workspace_delete") ? "v1" : "v2");
    const stream = createAssistantMessageEventStream();
    const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
      content: [], stopReason: "error", errorMessage: "temporary provider error", timestamp: NOW,
      usage: { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 11,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    stream.push({ type: "error", reason: "error", error: message });
    return stream;
  } };
  const { root, db, config, scheduler, advance } = fixture(t, () => port);
  config.dualWrite = true;
  config.models.consolidate = { provider: "mock", modelId: "writer" };
  const note = "Preserve the project's explicit TypeScript decision.\n";
  const path = join(root, "rotation-note.md"); writeFileSync(path, note);
  db.prepare("INSERT INTO notes (note_id, text_path, text_hash, scope, created_at) VALUES ('rotation', ?, ?, 'global', ?)")
    .run(path, textHash(note), NOW);
  assert.ok((await scheduler.runPass()).every(result => result.status === "retry_wait"));
  advance(60_000);
  assert.ok((await scheduler.runPass()).every(result => result.status === "retry_wait"));
  assert.deepEqual(order, ["v1", "v2", "v2", "v1"]);
});

test("v2 blocked by another version's live lease wakes after expiry without another input event", async (t) => {
  const { root, db, config, scheduler, advance, scheduled } = fixture(t);
  config.version = "v2";
  assert.ok(claimConsolidation(db, { memoryVersion: "v1", owner: "dead-writer", promptHash: "other-version", now: NOW }));
  assert.deepEqual(await scheduler.runPass(), []);
  const wake = scheduled.filter(item => !item.cancelled).at(-1);
  assert.ok(wake);
  assert.equal(wake.delay, 180_000);
  advance(180_001);
  await wake.run();
  assert.ok(getPublishedGeneration(db, "v2", NOW + 180_001));
  assert.equal(getPublishedGeneration(db, "v1", NOW + 180_001), null);
  assert.equal(renderedSummary(acquireEvidencePin({ db, root, memoryVersion: "v2", now: NOW + 180_001 })!, root), MINIMAL_V1_SUMMARY);
});

test("empty selection publishes deterministic v1 artifacts without a model and unchanged input preserves the generation", async (t) => {
  const { root, db, scheduler, config } = fixture(t);
  assert.deepEqual(await scheduler.runPass(), [{ status: "published" }]);
  const generation = getPublishedGeneration(db, "v1", NOW);
  assert.ok(generation);
  assert.equal(renderedSummary(acquireEvidencePin({ db, root, memoryVersion: "v1", now: NOW })!, root), MINIMAL_V1_SUMMARY);
  assert.deepEqual(await scheduler.runPass(), [{ status: "unchanged" }]);
  assert.equal(getPublishedGeneration(db, "v1", NOW)?.generationId, generation.generationId);
  config.version = "v2";
  assert.equal(acquireEvidencePin({ db, root, memoryVersion: "v2", now: NOW }), null);
});

test("selected v2 publishes without a handbook and dual writing preserves independent current generations", async (t) => {
  const { root, db, config, scheduler } = fixture(t);
  config.version = "v2";
  assert.deepEqual(await scheduler.runPass(), [{ status: "published" }]);
  const v2 = getPublishedGeneration(db, "v2", NOW)!;
  assert.ok(v2);
  assert.equal(getPublishedGeneration(db, "v1", NOW), null);
  assert.equal(existsSync(join(v2.directory, "MEMORY.md")), false);
  assert.equal(existsSync(join(v2.directory, "raw_memories.md")), false);
  assert.equal(readFileSync(join(v2.directory, "memory_summary.md"), "utf8"), MINIMAL_V1_SUMMARY);
  config.dualWrite = true;
  assert.deepEqual(await scheduler.runPass(), [{ status: "unchanged" }, { status: "published" }]);
  assert.equal(getPublishedGeneration(db, "v2", NOW)?.generationId, v2.generationId);
  assert.ok(getPublishedGeneration(db, "v1", NOW));
  assert.equal(acquireEvidencePin({ db, root, memoryVersion: "v2", now: NOW })?.memoryVersion, "v2");
});

test("a valid larger source-count configuration stays within the v1 policy and can publish", async (t) => {
  const { root, db, config, scheduler } = fixture(t);
  config.schedule.maxConsolidationSources = 4096;
  assert.deepEqual(await scheduler.runPass(), [{ status: "published" }]);
  const generation = getPublishedGeneration(db, "v1", NOW)!;
  assert.equal(db.prepare("SELECT max_sources FROM generations WHERE generation_id = ?").get(generation.generationId)?.max_sources, 256);
  assert.equal(renderedSummary(acquireEvidencePin({ db, root, memoryVersion: "v1", now: NOW })!, root), MINIMAL_V1_SUMMARY);
});

test("changed generated output rearms a content-based rebuild and never serves tampered summary", async (t) => {
  const { root, db, scheduler, scheduled } = fixture(t);
  await scheduler.runPass();
  const before = getPublishedGeneration(db, "v1", NOW)!;
  assert.equal(scheduled.filter((item) => !item.cancelled).length, 0);
  writeFileSync(join(before.directory, "memory_summary.md"), MINIMAL_V1_SUMMARY + "Unsupported claim\n");
  assert.equal(acquireEvidencePin({ db, root, memoryVersion: "v1", now: NOW }), null);
  scheduler.trigger();
  const due = scheduled.filter((item) => !item.cancelled);
  assert.equal(due.length, 1);
  assert.equal(due[0]!.delay, 0);
  await due[0]!.run();
  const after = getPublishedGeneration(db, "v1", NOW)!;
  assert.notEqual(after.generationId, before.generationId);
  assert.equal(readFileSync(join(after.directory, "memory_summary.md"), "utf8"), MINIMAL_V1_SUMMARY);
});

test("at-cap store pauses generation writes and prunes old recovery copies", async (t) => {
  const { root, db, config, scheduler, scheduled } = fixture(t);
  // First pass publishes normally below the cap.
  assert.ok((await scheduler.runPass()).some(result => result.status === "published" || result.status === "unchanged"));

  // Put the owned store over limits.maxStoreBytes.
  const generation = getPublishedGeneration(db, "v1", NOW)!.directory;
  config.limits = { ...config.limits, maxStoreBytes: 2 ** 20 };
  writeFileSync(join(generation, "cap-fixture.bin"), Buffer.alloc(2 ** 21));

  const before = getPublishedGeneration(db, "v1", NOW)!.generationId;
  assert.deepEqual(await scheduler.runPass(), [{ status: "blocked", reason: "store_size_limit_reached" }]);
  getPublishedGeneration(db, "v1", NOW);
  // The paused pass must not rearm a busy idle-loop wake.
  assert.equal(scheduled.length, 0);
  scheduler.trigger();
  assert.equal(scheduled.length, 0, "an unchanged store still above the cap stays paused");
  // The published generation survived; no new generation was written.
  assert.equal(getPublishedGeneration(db, "v1", NOW)?.generationId, before);
});

test("pruning recovery copies below the store cap continues pending consolidation", async (t) => {
  const { root, db, config, scheduler, scheduled } = fixture(t);
  assert.deepEqual(await scheduler.runPass(), [{ status: "published" }]);
  const recovery = getPublishedGeneration(db, "v1", NOW)!;
  writeFileSync(join(recovery.directory, "memory_summary.md"), MINIMAL_V1_SUMMARY + "Unsupported claim\n");
  assert.deepEqual(await scheduler.runPass(), [{ status: "published" }]);
  const before = getPublishedGeneration(db, "v1", NOW)!;
  assert.ok(existsSync(recovery.directory), "the old generation is retained for recovery");

  config.limits = { ...config.limits, maxStoreBytes: 2 ** 20 };
  writeFileSync(join(recovery.directory, "cap-fixture.bin"), Buffer.alloc(2 ** 21));
  writeFileSync(join(before.directory, "memory_summary.md"), MINIMAL_V1_SUMMARY + "Another unsupported claim\n");

  assert.deepEqual(await scheduler.runPass(), [{ status: "published" }],
    "reclaimed capacity permits the pending rebuild without another input event");
  assert.equal(existsSync(recovery.directory), false);
  const after = getPublishedGeneration(db, "v1", NOW)!;
  assert.notEqual(after.generationId, before.generationId);
  assert.equal(readFileSync(join(after.directory, "memory_summary.md"), "utf8"), MINIMAL_V1_SUMMARY);
  assert.equal(scheduled.filter(item => !item.cancelled).length, 0);
});
