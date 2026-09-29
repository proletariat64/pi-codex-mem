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
import { createVersionRun, finishVersionRun, versionRunConfig } from "../src/control/switch.ts";

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

test("an explicit version grant waits until idle, executes one bounded pass and never arms another provider pass", async (t) => {
  const fx = setup(t); let now = NOW; let completed = 0;
  const grant = createVersionRun(fx.db, fx.config, "v2", now);
  fx.port.request = async (_model, context) => { fx.calls.push(context); return { stopReason: "stop",
    text: '{"rollout_summary":"v2 evidence","rollout_slug":"history"}' }; };
  const queued = new ExtractionScheduler({ db: fx.db, root: fx.root,
    config: () => versionRunConfig(fx.db, grant, fx.config), request: grant,
    now: () => now, modelPort: () => fx.port, isForegroundIdle: () => true,
    timer: { schedule(run, delay) { fx.scheduled.push({ run, delay, cancelled: false }); return { cancel() {} }; } },
    onPassComplete: results => { assert.equal(results.length, 1); completed++; finishVersionRun(fx.db, grant, fx.config); } });
  t.after(() => queued.stop());
  assert.deepEqual(await queued.runPass(), []); assert.equal(fx.calls.length, 0);
  assert.equal(fx.scheduled.at(-1)!.delay, 40_000);
  assert.equal(fx.db.prepare("SELECT status FROM version_run_grants").get()!.status, "active");
  now += 40_000; await fx.scheduled.at(-1)!.run();
  assert.equal(fx.calls.length, 1); assert.equal(completed, 1);
  assert.equal(fx.db.prepare("SELECT status FROM version_run_grants").get()!.status, "completed");
  assert.deepEqual(await queued.runPass(true), []); assert.equal(fx.calls.length, 1);
});

test("a policy change in another process releases a cancelled queued run at its idle wakeup", async (t) => {
  const fx = setup(t); let completed = 0;
  const grant = createVersionRun(fx.db, fx.config, "v2", NOW);
  const queued = new ExtractionScheduler({ db: fx.db, root: fx.root, request: grant,
    config: () => versionRunConfig(fx.db, grant, fx.config), now: () => NOW,
    modelPort: () => fx.port, isForegroundIdle: () => true,
    timer: { schedule(run, delay) { fx.scheduled.push({ run, delay, cancelled: false }); return { cancel() {} }; } },
    onPassComplete: results => { assert.deepEqual(results, []); completed++; } });
  t.after(() => queued.stop());
  await queued.runPass(); assert.equal(completed, 0);
  fx.config.generate = false;
  await fx.scheduled.at(-1)!.run();
  assert.equal(completed, 1); assert.equal(fx.calls.length, 0);
  assert.equal(fx.db.prepare("SELECT status FROM version_run_grants").get()!.status, "cancelled");
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

test("switching to v2 enrolls the same captured source without reusing v1's no-output watermark", async (t) => {
  const fx = setup(t);
  fx.config.schedule.minIdleMinutes = 0;
  fx.port.request = async (_model, context) => { fx.calls.push(context); return { stopReason: "stop",
    text: context.systemPrompt?.includes("You are part of an agent memory system")
      ? '{"rollout_summary":"Decision retained in v2","rollout_slug":"decision"}'
      : '{"raw_memory":"","rollout_summary":"","rollout_slug":""}' }; };
  fx.scheduler.trigger();
  assert.deepEqual(await fx.scheduler.runPass(), [{ status: "no_output" }]);
  fx.config.version = "v2";
  fx.scheduler.trigger();
  assert.deepEqual(await fx.scheduler.runPass(), [{ status: "succeeded" }]);
  assert.equal(fx.calls.length, 2);
  assert.deepEqual(fx.db.prepare("SELECT memory_version, outcome, raw_memory FROM extractions ORDER BY memory_version").all()
    .map((row) => ({ ...row })), [
    { memory_version: "v1", outcome: "no_output", raw_memory: "" },
    { memory_version: "v2", outcome: "succeeded", raw_memory: null },
  ]);
});

test("dual writing extracts each version once within a shared two-job pass", async (t) => {
  const fx = setup(t);
  fx.config.schedule.minIdleMinutes = 0;
  fx.config.dualWrite = true;
  fx.port.request = async (_model, context) => { fx.calls.push(context); return { stopReason: "stop",
    text: context.systemPrompt?.includes("You are part of an agent memory system")
      ? '{"rollout_summary":"Separate v2 history","rollout_slug":"history"}'
      : '{"raw_memory":"v1 learning","rollout_summary":"v1 history","rollout_slug":"history"}' }; };
  fx.scheduler.trigger();
  assert.deepEqual(await fx.scheduler.runPass(), [{ status: "succeeded" }, { status: "succeeded" }]);
  assert.equal(fx.calls.length, 2);
  assert.deepEqual(fx.db.prepare("SELECT memory_version FROM extractions ORDER BY memory_version").all()
    .map((row) => row.memory_version), ["v1", "v2"]);
  assert.equal((fx.db.prepare("SELECT SUM(call_count) AS n FROM budget_usage").get() as { n: number }).n, 2);
  fx.scheduler.trigger();
  assert.deepEqual(await fx.scheduler.runPass(), []);
  assert.equal(fx.calls.length, 2);
});

test("a v1 provider failure cannot suppress successful v2 dual-write work", async (t) => {
  const fx = setup(t);
  fx.config.schedule.minIdleMinutes = 0;
  fx.config.dualWrite = true;
  let failV1 = true;
  fx.port.request = async (_model, context) => { fx.calls.push(context);
    if (context.systemPrompt?.includes("You are part of an agent memory system")) return {
      stopReason: "stop", text: '{"rollout_summary":"Independent v2 history","rollout_slug":"history"}',
    };
    if (failV1) return { stopReason: "error", text: "", errorMessage: "503 temporary" };
    return { stopReason: "stop", text: '{"raw_memory":"v1 lesson","rollout_summary":"history","rollout_slug":"history"}' };
  };
  fx.scheduler.trigger();
  assert.deepEqual(await fx.scheduler.runPass(), [{ status: "retry_wait" }, { status: "succeeded" }]);
  assert.deepEqual(fx.db.prepare("SELECT memory_version FROM extractions").all().map((row) => row.memory_version), ["v2"]);
  assert.equal((fx.db.prepare("SELECT SUM(call_count) AS n FROM budget_usage").get() as { n: number }).n, 2);
  failV1 = false;
  fx.setNow(NOW + 60_001);
  assert.deepEqual(await fx.scheduler.runPass(), [{ status: "succeeded" }]);
  assert.deepEqual(fx.db.prepare("SELECT memory_version FROM extractions ORDER BY memory_version").all()
    .map((row) => row.memory_version), ["v1", "v2"]);
  assert.equal(fx.calls.length, 3);
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

test("configuration changes during a model call prevent a paid repair request", async (t) => {
  const fx = setup(t);
  fx.config.schedule.minIdleMinutes = 0;
  let finish: ((reply: { stopReason: "stop"; text: string }) => void) | undefined;
  const first = new Promise<{ stopReason: "stop"; text: string }>((resolve) => { finish = resolve; });
  let requests = 0;
  fx.port.request = async () => { requests++; return first; };
  const running = fx.scheduler.runPass();
  await new Promise<void>((resolve) => setImmediate(resolve));
  fx.config.generate = false;
  assert.ok(finish);
  finish({ stopReason: "stop", text: "invalid JSON" });
  assert.deepEqual(await running, [{ status: "retry_wait" }]);
  assert.equal(requests, 1);
  assert.equal((fx.db.prepare("SELECT error_code FROM jobs").get() as { error_code: string }).error_code,
    "configuration_changed");
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
