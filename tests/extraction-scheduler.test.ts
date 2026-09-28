import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../src/config.ts";
import { computeWorkspaceIdentity } from "../src/identity.ts";
import { openStateDb, recordSnapshot } from "../src/store/db.ts";
import { writeSnapshotFile } from "../src/store/snapshot-files.ts";
import { claimDueExtractions, recordProcessActivity, recoverExpiredExtractions } from "../src/store/jobs.ts";
import { ExtractionScheduler, type SchedulerTimer } from "../src/extraction/scheduler.ts";
import { runV1Extraction, type MemoryModelPort } from "../src/extraction/runner.ts";

const NOW = Date.UTC(2024, 0, 2, 12);
const sourceId = "scheduler-source";

function setup(t: test.TestContext) {
  const temp = mkdtempSync(join(tmpdir(), "pi-memory-scheduler-"));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const cwd = join(temp, "repo"); mkdirSync(cwd);
  execFileSync("git", ["init", "-q"], { cwd });
  const root = join(temp, "agent", "memory");
  const db = openStateDb(root);
  let closed = false;
  t.after(() => { if (!closed) db.close(); });
  const snapshot = { schemaVersion: 1, sourceId,
    items: [{ entryId: "u1", role: "user", origin: "unknown", text: "Decision: use TypeScript" }] };
  const saved = writeSnapshotFile(root, "a".repeat(64), "b".repeat(64), snapshot);
  const sessionKey = "c".repeat(64);
  recordSnapshot(db, { workspace: computeWorkspaceIdentity(cwd),
    session: { sessionKey, path: join(temp, "session.jsonl"), headerId: "s1",
      parentKey: null, branchId: "main", mode: "tui" },
    revision: { sourceId, lineageKey: "a".repeat(64), revisionHash: "b".repeat(64),
      leafId: "u1", snapshotPath: saved.path, snapshotHash: saved.hash, sourceTime: NOW - 30_000 },
    capturedAt: NOW - 20_000 });
  const config = defaultConfig("UTC");
  config.models.extract = { provider: "mock", modelId: "extract" };
  config.schedule.minIdleMinutes = 1;
  const calls: unknown[] = [];
  const port: MemoryModelPort = {
    resolve: () => ({ provider: "mock", modelId: "extract", maxTokens: 8_000, contextWindow: 200_000 }),
    request: async (_model, context) => { calls.push(context); return {
      stopReason: "stop", text: '{"raw_memory":"Decision: use TypeScript","rollout_summary":"TypeScript chosen","rollout_slug":"typescript"}',
      usage: { input: 20, output: 10 },
    }; },
  };
  const scheduled: { run: () => Promise<void>; delay: number; cancelled: boolean }[] = [];
  const timer: SchedulerTimer = { schedule(run, delay) {
    const item = { run, delay, cancelled: false };
    scheduled.push(item);
    return { cancel: () => { item.cancelled = true; } };
  } };
  let now = NOW;
  let idle = true;
  const scheduler = new ExtractionScheduler({ db, root, config: () => config,
    modelPort: () => port, now: () => now, isForegroundIdle: () => idle, timer });
  t.after(async () => scheduler.stop());
  return { db, root, scheduler, config, port, calls, scheduled, sessionKey,
    closeDb() { db.close(); closed = true; },
    setNow(value: number) { now = value; }, setIdle(value: boolean) { idle = value; } };
}

test("startup schedules one due-time wakeup after source idle interval, then extracts once", async (t) => {
  const fx = setup(t);
  fx.scheduler.trigger();
  assert.equal(fx.scheduled.length, 1);
  assert.equal(fx.scheduled[0]?.delay, 40_000);
  assert.equal(fx.calls.length, 0);
  fx.setNow(NOW + 40_000);
  await fx.scheduled[0]!.run();
  assert.equal(fx.calls.length, 1);
  assert.equal((fx.db.prepare("SELECT outcome FROM extractions").get() as { outcome: string }).outcome, "succeeded");
  fx.scheduler.trigger();
  assert.equal(fx.calls.length, 1);
  assert.equal(fx.scheduled.filter((item) => !item.cancelled).length, 0);
});

test("no-output watermark prevents repeated model calls at startup", async (t) => {
  const fx = setup(t);
  fx.config.schedule.minIdleMinutes = 0;
  fx.port.request = async (_model, context) => { fx.calls.push(context); return {
    stopReason: "stop", text: '{"raw_memory":"","rollout_summary":"","rollout_slug":""}',
  }; };
  fx.scheduler.trigger();
  await fx.scheduler.runPass();
  assert.equal(fx.calls.length, 1);
  fx.scheduler.trigger();
  await fx.scheduler.runPass();
  assert.equal(fx.calls.length, 1);
  assert.equal((fx.db.prepare("SELECT status FROM jobs").get() as { status: string }).status, "no_output");
});

test("active foreground and another process's session heartbeat defer new requests", async (t) => {
  const fx = setup(t);
  fx.setNow(NOW + 40_000);
  fx.setIdle(false);
  fx.scheduler.trigger();
  assert.equal(fx.scheduled.length, 0);
  fx.setIdle(true);
  recordProcessActivity(fx.db, { owner: "other-process", sessionKey: fx.sessionKey,
    state: "active", now: NOW + 40_000 });
  fx.scheduler.foregroundSettled();
  assert.equal(fx.scheduled.at(-1)?.delay, 180_000);
  assert.equal(fx.calls.length, 0);
});

test("foreground work beginning mid-request pauses the repair until settlement", async (t) => {
  const fx = setup(t);
  fx.config.schedule.minIdleMinutes = 0;
  let finish: ((reply: { stopReason: "stop"; text: string }) => void) | undefined;
  const first = new Promise<{ stopReason: "stop"; text: string }>((resolve) => { finish = resolve; });
  let requests = 0;
  fx.port.request = async () => {
    requests++;
    return requests === 1 ? first : { stopReason: "stop",
      text: '{"raw_memory":"decision","rollout_summary":"summary","rollout_slug":"decision"}' };
  };
  fx.scheduler.trigger();
  const running = fx.scheduler.runPass();
  await new Promise<void>((resolve) => setImmediate(resolve));
  fx.setIdle(false);
  fx.scheduler.foregroundStarted();
  assert.ok(finish);
  finish({ stopReason: "stop", text: "not JSON" });
  assert.deepEqual(await running, [{ status: "retry_wait" }]);
  assert.equal(requests, 1);
  fx.setIdle(true);
  fx.scheduler.foregroundSettled();
  const wakeup = fx.scheduled.at(-1);
  assert.ok(wakeup);
  fx.setNow(NOW + 1);
  await wakeup.run();
  assert.equal(requests, 2);
  assert.equal((fx.db.prepare("SELECT outcome FROM extractions").get() as { outcome: string }).outcome, "succeeded");
});

test("shutdown aborts the owned model request before the store is closed", async (t) => {
  const fx = setup(t);
  fx.config.schedule.minIdleMinutes = 0;
  fx.port.request = async () => new Promise(() => {});
  const running = fx.scheduler.runPass();
  await new Promise<void>((resolve) => setImmediate(resolve));
  await fx.scheduler.stop();
  assert.deepEqual(await running, [{ status: "cancelled" }]);
  assert.equal((fx.db.prepare("SELECT COUNT(*) AS n FROM extractions").get() as { n: number }).n, 0);
  recoverExpiredExtractions(fx.db, NOW + 1);
  assert.equal((fx.db.prepare("SELECT status FROM jobs").get() as { status: string }).status, "queued");
});

test("a new runtime recovers an expired leased job and fences the crashed owner", async (t) => {
  const fx = setup(t);
  fx.scheduler.trigger();
  const [old] = claimDueExtractions(fx.db, { owner: "crashed", now: NOW, limit: 1, minIdleMs: 0 });
  assert.ok(old);
  await fx.scheduler.stop();
  fx.closeDb(); // simulate a process dying with the durable lease still outstanding
  const recovered = openStateDb(fx.root);
  t.after(() => recovered.close());
  recoverExpiredExtractions(recovered, NOW + 180_001);
  const [next] = claimDueExtractions(recovered, { owner: "new-runtime", now: NOW + 180_001,
    limit: 1, minIdleMs: 0 });
  assert.ok(next);
  assert.equal(next.fence, old.fence + 1);
  assert.deepEqual(await runV1Extraction({ db: recovered, root: fx.root, job: next,
    modelRef: { provider: "mock", modelId: "extract" }, port: fx.port, now: NOW + 180_002,
    timezone: "UTC", limits: {
      outputBytes: fx.config.limits.extractionOutputBytes,
      dailyInputTokens: fx.config.limits.dailyInputTokens,
      dailyOutputTokens: fx.config.limits.dailyOutputTokens,
      dailyRequests: fx.config.limits.dailyRequests,
    }, signal: new AbortController().signal }), { status: "succeeded" });
  assert.equal(fx.calls.length, 1);
  assert.equal((recovered.prepare("SELECT outcome FROM extractions").get() as { outcome: string }).outcome, "succeeded");
});
