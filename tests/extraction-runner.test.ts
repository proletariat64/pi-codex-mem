import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "@earendil-works/pi-ai";
import { computeWorkspaceIdentity } from "../src/identity.ts";
import { openStateDb, recordSnapshot } from "../src/store/db.ts";
import { writeSnapshotFile } from "../src/store/snapshot-files.ts";
import { claimDueExtractions, enqueueExtraction } from "../src/store/jobs.ts";
import { renderV1Request } from "../src/extraction/v1.ts";
import { runV1Extraction, type MemoryModelPort, type MemoryResponse, type ResolvedMemoryModel } from "../src/extraction/runner.ts";

const NOW = Date.UTC(2024, 0, 2, 12);
const sourceId = "source-1";
const modelRef = { provider: "mock", modelId: "extract" };
const limits = { outputBytes: 49_152, dailyInputTokens: 100_000, dailyOutputTokens: 20_000, dailyRequests: 20 };

function setup(t: test.TestContext, items?: { entryId: string; role: string; origin: string | null; text: string; timestamp: number }[]) {
  const root = mkdtempSync(join(tmpdir(), "pi-memory-extract-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, "repo"); mkdirSync(cwd);
  execFileSync("git", ["init", "-q"], { cwd });
  const memoryRoot = join(root, "agent", "memory");
  const db = openStateDb(memoryRoot);
  t.after(() => db.close());
  const workspace = computeWorkspaceIdentity(cwd);
  const snapshot = { schemaVersion: 1, sourceId, items: items ?? [
    { entryId: "u1", role: "user", origin: "unknown", text: "User chose TypeScript over Rust", timestamp: NOW - 30_000 },
  ] };
  const saved = writeSnapshotFile(memoryRoot, "l".repeat(64), "v".repeat(64), snapshot);
  recordSnapshot(db, { workspace, session: { sessionKey: "s".repeat(64), path: join(root, "history.jsonl"),
    headerId: "historical-1", parentKey: null, branchId: "branch-1", mode: "tui" },
    revision: { sourceId, lineageKey: "l".repeat(64), revisionHash: "v".repeat(64), leafId: "u1",
      snapshotPath: saved.path, snapshotHash: saved.hash, sourceTime: NOW - 30_000 }, capturedAt: NOW - 20_000 });
  const promptHash = renderV1Request({ snapshotPath: saved.path, cwd, items: snapshot.items }).promptHash;
  enqueueExtraction(db, { sourceId, memoryVersion: "v1", promptHash, now: NOW });
  const [job] = claimDueExtractions(db, { owner: "runner", now: NOW, limit: 1 });
  assert.ok(job);
  return { db, job, root: memoryRoot };
}

function fakePort(replies: MemoryResponse[]) {
  const calls: { text: string; tools: Context["tools"]; signal: AbortSignal }[] = [];
  const port: MemoryModelPort = {
    resolve: () => ({ provider: "mock", modelId: "extract", contextWindow: 200_000, maxTokens: 8_000 }),
    request: async (_model: ResolvedMemoryModel, context: Context,
      options: { signal: AbortSignal; maxTokens: number; timeoutMs: number; toolChoice: "none" }) => {
      calls.push({ text: JSON.stringify(context), tools: context.tools, signal: options.signal });
      const response = replies.shift();
      if (!response) throw new Error("no fake reply");
      return response;
    },
  };
  return { port, calls };
}

const response = (text: string): MemoryResponse => ({ stopReason: "stop", text,
  usage: { input: 100, output: 20 } });

test("run --now stores a sanitized v1 extraction with model, prompt, usage, and output hash provenance", async (t) => {
  const { db, job, root } = setup(t);
  const { port, calls } = fakePort([response(JSON.stringify({ raw_memory: "Use TypeScript sk-ABCDEFGHIJKLMNOPQRSTUVWX",
    rollout_summary: "User adopted TypeScript", rollout_slug: "TS Choice" }))]);

  const result = await runV1Extraction({ db, root, job, modelRef, port, now: NOW + 1,
    timezone: "UTC", limits, signal: new AbortController().signal });

  assert.deepEqual(result, { status: "succeeded" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.tools?.length, 0);
  const row = db.prepare("SELECT * FROM extractions").get() as Record<string, unknown>;
  assert.equal(row.raw_memory, "Use TypeScript [REDACTED]");
  assert.equal(row.model_provider, "mock");
  assert.equal(row.model_id, "extract");
  assert.equal(row.prompt_hash, job.promptHash);
  assert.equal(row.usage_input, 100);
  assert.equal(row.usage_output, 20);
  assert.match(String(row.output_hash), /^[a-f0-9]{64}$/);
});

test("rendered input fits a conservative 70% context budget and prioritizes user rationale", async (t) => {
  const { db, job, root } = setup(t, [
    { entryId: "u1", role: "user", origin: "unknown", text: "User decided TypeScript for reproducibility", timestamp: NOW - 30_000 },
    { entryId: "tool1", role: "tool", origin: null, text: "verbose tool log: " + "X".repeat(50_000), timestamp: NOW - 20_000 },
  ]);
  const { port, calls } = fakePort([response('{"raw_memory":"TypeScript chosen","rollout_summary":"TypeScript chosen","rollout_slug":"typescript"}')]);
  port.resolve = () => ({ provider: "mock", modelId: "extract", contextWindow: 60_000, maxTokens: 8_000 });

  assert.deepEqual(await runV1Extraction({ db, root, job, modelRef, port, now: NOW + 1,
    timezone: "UTC", limits, signal: new AbortController().signal }), { status: "succeeded" });
  assert.equal(calls.length, 1);
  assert.match(calls[0]?.text ?? "", /User decided TypeScript for reproducibility/);
  assert.doesNotMatch(calls[0]?.text ?? "", /verbose tool log/);
  assert.match(calls[0]?.text ?? "", /omitted for model context budget/);
});

test("a model with insufficient context blocks before spending budget", async (t) => {
  const { db, job, root } = setup(t);
  const { port, calls } = fakePort([]);
  port.resolve = () => ({ provider: "mock", modelId: "extract", contextWindow: 8_000, maxTokens: 8_000 });
  const result = await runV1Extraction({ db, root, job, modelRef, port, now: NOW + 1,
    timezone: "UTC", limits, signal: new AbortController().signal });
  assert.deepEqual(result, { status: "blocked" });
  assert.equal(calls.length, 0);
  assert.equal((db.prepare("SELECT error_code FROM jobs").get() as { error_code: string }).error_code, "context_too_small");
});

test("one invalid JSON reply gets exactly one budgeted repair; no-output records once", async (t) => {
  const { db, job, root } = setup(t);
  const { port, calls } = fakePort([response("not JSON"), response('{"raw_memory":"","rollout_summary":"","rollout_slug":""}')]);

  const result = await runV1Extraction({ db, root, job, modelRef, port, now: NOW + 1,
    timezone: "UTC", limits, signal: new AbortController().signal });

  assert.deepEqual(result, { status: "no_output" });
  assert.equal(calls.length, 2);
  assert.match(calls[1]?.text ?? "", /not JSON/);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM budget_reservations").get() as { n: number }).n, 2);
  assert.equal((db.prepare("SELECT outcome FROM extractions").get() as { outcome: string }).outcome, "no_output");
  assert.equal((db.prepare("SELECT attempt_count FROM jobs").get() as { attempt_count: number }).attempt_count, 2);
});

test("a late provider response cannot commit after its source revision is superseded", async (t) => {
  const { db, job, root } = setup(t);
  let release: ((value: MemoryResponse) => void) | undefined;
  const pending = new Promise<MemoryResponse>((resolve) => { release = resolve; });
  const { port } = fakePort([]);
  port.request = async () => pending;
  const running = runV1Extraction({ db, root, job, modelRef, port, now: NOW + 1,
    timezone: "UTC", limits, signal: new AbortController().signal });
  await new Promise<void>((resolve) => setImmediate(resolve));
  db.prepare("UPDATE source_revisions SET status = 'superseded' WHERE source_id = ?").run(sourceId);
  assert.ok(release);
  release(response('{"raw_memory":"decision","rollout_summary":"summary","rollout_slug":"choice"}'));

  assert.deepEqual(await running, { status: "superseded" });
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM extractions").get() as { n: number }).n, 0);
});

test("two invalid model replies block without a third request", async (t) => {
  const { db, job, root } = setup(t);
  const { port, calls } = fakePort([response("not JSON"), response("still not JSON")]);

  const result = await runV1Extraction({ db, root, job, modelRef, port, now: NOW + 1,
    timezone: "UTC", limits, signal: new AbortController().signal });

  assert.deepEqual(result, { status: "blocked" });
  assert.equal(calls.length, 2);
  assert.equal((db.prepare("SELECT status FROM jobs").get() as { status: string }).status, "blocked");
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM extractions").get() as { n: number }).n, 0);
});

test("budget deferral after a spent invalid call retains its attempt and resumes next local day", async (t) => {
  const { db, job, root } = setup(t);
  const first = fakePort([response("not JSON")]);
  const deferred = await runV1Extraction({ db, root, job, modelRef, port: first.port, now: NOW + 1,
    timezone: "UTC", limits: { ...limits, dailyRequests: 1 }, signal: new AbortController().signal });
  assert.deepEqual(deferred, { status: "budget_deferred", reason: "request_budget" });
  assert.equal(first.calls.length, 1);
  assert.equal((db.prepare("SELECT attempt_count FROM jobs").get() as { attempt_count: number }).attempt_count, 1);
  const tomorrow = Date.UTC(2024, 0, 3, 0);
  const [next] = claimDueExtractions(db, { owner: "tomorrow", now: tomorrow, limit: 1 });
  assert.ok(next);
  const second = fakePort([response('{"raw_memory":"decision","rollout_summary":"summary","rollout_slug":"decision"}')]);
  assert.deepEqual(await runV1Extraction({ db, root, job: next, modelRef, port: second.port, now: tomorrow + 1,
    timezone: "UTC", limits: { ...limits, dailyRequests: 1 }, signal: new AbortController().signal }),
  { status: "succeeded" });
  assert.equal((db.prepare("SELECT attempt_count FROM jobs").get() as { attempt_count: number }).attempt_count, 2);
});

test("after three spent network calls invalid JSON blocks without stranding lease or reserving a fourth", async (t) => {
  const { db, job, root } = setup(t);
  const first = fakePort([response("not JSON"), { stopReason: "error", text: "", errorMessage: "503 temporary" }]);
  assert.deepEqual(await runV1Extraction({ db, root, job, modelRef, port: first.port, now: NOW + 1,
    timezone: "UTC", limits, signal: new AbortController().signal }), { status: "retry_wait" });
  const [last] = claimDueExtractions(db, { owner: "last", now: NOW + 300_002, limit: 1 });
  assert.ok(last);
  const final = fakePort([response("still not JSON")]);
  assert.deepEqual(await runV1Extraction({ db, root, job: last, modelRef, port: final.port, now: NOW + 300_003,
    timezone: "UTC", limits, signal: new AbortController().signal }), { status: "blocked" });
  assert.equal(final.calls.length, 1);
  assert.equal((db.prepare("SELECT status FROM jobs").get() as { status: string }).status, "blocked");
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM budget_reservations").get() as { n: number }).n, 3);
});

test("provider-error or aborted result never enters JSON repair", async (t) => {
  for (const stopReason of ["error", "aborted"] as const) {
    const { db, job, root } = setup(t);
    const { port, calls } = fakePort([{ stopReason, text: "{bad", errorMessage: "temporary provider failure" }]);
    const result = await runV1Extraction({ db, root, job, modelRef, port, now: NOW + 1,
      timezone: "UTC", limits, signal: new AbortController().signal });
    assert.equal(result.status, stopReason === "error" ? "retry_wait" : "cancelled");
    assert.equal(calls.length, 1);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM extractions").get() as { n: number }).n, 0);
  }
});

test("a blocked missing model resumes only after its persisted configuration epoch changes", async (t) => {
  const { db, job, root } = setup(t);
  const missing = fakePort([]);
  missing.port.resolve = () => undefined;
  assert.deepEqual(await runV1Extraction({ db, root, job, modelRef, port: missing.port, now: NOW + 1,
    timezone: "UTC", limits, signal: new AbortController().signal }), { status: "blocked" });
  enqueueExtraction(db, { sourceId, memoryVersion: "v1", promptHash: job.promptHash, now: NOW + 2 });
  assert.deepEqual(claimDueExtractions(db, { owner: "same-model", now: NOW + 3, limit: 1 }), []);
  enqueueExtraction(db, { sourceId, memoryVersion: "v1", promptHash: job.promptHash,
    configEpoch: "new-model-epoch", now: NOW + 4 });
  const [next] = claimDueExtractions(db, { owner: "changed-model", now: NOW + 5, limit: 1 });
  assert.ok(next);
  const available = fakePort([response('{"raw_memory":"decision","rollout_summary":"summary","rollout_slug":"decision"}')]);
  assert.deepEqual(await runV1Extraction({ db, root, job: next, modelRef, port: available.port, now: NOW + 6,
    timezone: "UTC", limits, signal: new AbortController().signal }), { status: "succeeded" });
  assert.equal((db.prepare("SELECT attempt_count FROM jobs").get() as { attempt_count: number }).attempt_count, 1);
});

test("provider error with zero reported usage conservatively charges the reservation", async (t) => {
  const { db, job, root } = setup(t);
  const { port } = fakePort([{ stopReason: "error", text: "", errorMessage: "503 temporary",
    usage: { input: 0, output: 0 } }]);
  assert.deepEqual(await runV1Extraction({ db, root, job, modelRef, port, now: NOW + 1,
    timezone: "UTC", limits, signal: new AbortController().signal }), { status: "retry_wait" });
  const row = db.prepare("SELECT actual_input, actual_output, call_count FROM budget_usage")
    .get() as { actual_input: number; actual_output: number; call_count: number };
  assert.ok(row.actual_input > 0);
  assert.equal(row.actual_output, 6_000);
  assert.equal(row.call_count, 1);
});

test("authentication failure blocks rather than hot-retrying or repairing JSON", async (t) => {
  const { db, job, root } = setup(t);
  const { port, calls } = fakePort([{ stopReason: "error", text: "", errorMessage: "401 unauthorized" }]);

  const result = await runV1Extraction({ db, root, job, modelRef, port, now: NOW + 1,
    timezone: "UTC", limits, signal: new AbortController().signal });

  assert.deepEqual(result, { status: "blocked" });
  assert.equal(calls.length, 1);
  assert.equal((db.prepare("SELECT error_code FROM jobs").get() as { error_code: string }).error_code, "auth_or_model");
});

test("provider Retry-After hints extend transient backoff without persisting raw errors", async (t) => {
  const { db, job, root } = setup(t);
  const { port } = fakePort([{ stopReason: "error", text: "", errorMessage: "429 Retry-After: 600" }]);
  const result = await runV1Extraction({ db, root, job, modelRef, port, now: NOW + 1,
    timezone: "UTC", limits, signal: new AbortController().signal });
  assert.deepEqual(result, { status: "retry_wait" });
  const row = db.prepare("SELECT due_at, error_code FROM jobs").get() as { due_at: number; error_code: string };
  assert.equal(row.due_at, NOW + 1 + 600_000);
  assert.equal(row.error_code, "provider_error");
});

test("exhausted daily budget defers work without making a model request", async (t) => {
  const { db, job, root } = setup(t);
  const { port, calls } = fakePort([]);
  const result = await runV1Extraction({ db, root, job, modelRef, port, now: NOW + 1,
    timezone: "UTC", limits: { ...limits, dailyInputTokens: 100 }, signal: new AbortController().signal });
  assert.deepEqual(result, { status: "budget_deferred", reason: "input_budget" });
  assert.equal(calls.length, 0);
  assert.equal((db.prepare("SELECT status FROM jobs").get() as { status: string }).status, "retry_wait");
  assert.equal((db.prepare("SELECT attempt_count FROM jobs").get() as { attempt_count: number }).attempt_count, 0);
});
