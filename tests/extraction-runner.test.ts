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
import { renderV2Request } from "../src/extraction/v2.ts";
import { runV1Extraction, runV2Extraction, type MemoryModelPort, type MemoryResponse, type ResolvedMemoryModel } from "../src/extraction/runner.ts";

const NOW = Date.UTC(2024, 0, 2, 12);
const sourceId = "source-1";
const modelRef = { provider: "mock", modelId: "extract" };
const limits = { outputBytes: 49_152, dailyInputTokens: 100_000, dailyOutputTokens: 20_000, dailyRequests: 20 };

function setup(t: test.TestContext, items?: { entryId: string; role: string; origin: string | null; text: string; timestamp: number }[],
  version: "v1" | "v2" = "v1") {
  const root = mkdtempSync(join(tmpdir(), "pi-memory-extract-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, "repo"); mkdirSync(cwd);
  execFileSync("git", ["init", "-q"], { cwd });
  execFileSync("git", ["symbolic-ref", "HEAD", "refs/heads/captured-branch"], { cwd });
  const memoryRoot = join(root, "agent", "memory");
  const db = openStateDb(memoryRoot);
  t.after(() => db.close());
  const workspace = computeWorkspaceIdentity(cwd);
  const snapshot = { schemaVersion: 1, sourceId, workspace, items: items ?? [
    { entryId: "u1", role: "user", origin: "unknown", text: "User chose TypeScript over Rust", timestamp: NOW - 30_000 },
  ] };
  const saved = writeSnapshotFile(memoryRoot, "l".repeat(64), "v".repeat(64), snapshot);
  recordSnapshot(db, { workspace, session: { sessionKey: "s".repeat(64), path: join(root, "history.jsonl"),
    headerId: "historical-1", parentKey: null, branchId: "branch-1", mode: "tui" },
    revision: { sourceId, lineageKey: "l".repeat(64), revisionHash: "v".repeat(64), leafId: "u1",
      snapshotPath: saved.path, snapshotHash: saved.hash, sourceTime: NOW - 30_000 }, capturedAt: NOW - 20_000 });
  const input = { snapshotPath: saved.path, cwd, items: snapshot.items, gitBranch: workspace.gitBranch };
  const promptHash = version === "v1" ? renderV1Request(input).promptHash : renderV2Request(input).promptHash;
  enqueueExtraction(db, { sourceId, memoryVersion: version, promptHash, now: NOW });
  const [job] = claimDueExtractions(db, { owner: "runner", now: NOW, limit: 1 });
  assert.ok(job);
  return { db, job, root: memoryRoot };
}

function fakePort(replies: MemoryResponse[]) {
  const calls: { text: string; tools: Context["tools"]; signal: AbortSignal; version: "v1" | "v2" }[] = [];
  const port: MemoryModelPort = {
    resolve: () => ({ provider: "mock", modelId: "extract", contextWindow: 200_000, maxTokens: 8_000 }),
    request: async (_model: ResolvedMemoryModel, context: Context,
      options: Parameters<MemoryModelPort["request"]>[2]) => {
      calls.push({ text: JSON.stringify(context), tools: context.tools, signal: options.signal, version: options.version });
      const response = replies.shift();
      if (!response) throw new Error("no fake reply");
      return response;
    },
  };
  return { port, calls };
}

const response = (text: string): MemoryResponse => ({ stopReason: "stop", text,
  usage: { input: 100, output: 20 } });

for (const version of ["v1", "v2"] as const) {
  test(`${version} rejects output headroom below the native empty response before spending budget`, async (t) => {
    const run = version === "v1" ? runV1Extraction : runV2Extraction;
    const emptyOutput = JSON.stringify(version === "v1"
      ? { raw_memory: "", rollout_summary: "", rollout_slug: "" }
      : { rollout_summary: "", rollout_slug: "" });
    const minimumTokens = Math.ceil(Buffer.byteLength(emptyOutput, "utf8") / 4);
    const probe = setup(t, undefined, version);
    const captured = fakePort([response(emptyOutput)]);
    assert.equal((await run({ ...probe, modelRef, port: captured.port, now: NOW + 1,
      timezone: "UTC", limits: { ...limits, v2RolloutSummaryBytes: 9_000 },
      signal: new AbortController().signal })).status, "no_output");
    const context = JSON.parse(captured.calls[0]!.text) as Context;
    const user = context.messages[0]!;
    assert.ok(user.role === "user" && typeof user.content === "string");
    const inputTokens = Math.ceil(Buffer.byteLength(context.systemPrompt! + user.content, "utf8") / 4);

    for (const headroom of [1, minimumTokens - 1, minimumTokens]) {
      const fixture = setup(t, undefined, version);
      const { port, calls } = fakePort([response(emptyOutput)]);
      port.resolve = () => ({ ...modelRef, contextWindow: inputTokens + headroom, maxTokens: 8_000 });
      const result = await run({ ...fixture, modelRef, port, now: NOW + 1,
        timezone: "UTC", limits: { ...limits, v2RolloutSummaryBytes: 9_000 },
        signal: new AbortController().signal });
      const accepted = headroom === minimumTokens;
      assert.equal(result.status, accepted ? "no_output" : "blocked", `headroom=${headroom}`);
      assert.equal(calls.length, accepted ? 1 : 0);
      assert.equal(fixture.db.prepare("SELECT COUNT(*) AS n FROM budget_reservations").get()!.n, accepted ? 1 : 0);
      if (!accepted) {
        assert.equal(fixture.db.prepare("SELECT error_code FROM jobs").get()!.error_code, "context_too_small");
        assert.equal(fixture.db.prepare("SELECT COUNT(*) AS n FROM extractions").get()!.n, 0);
      }
    }
    const fixture = setup(t, undefined, version);
    const { port, calls } = fakePort([]);
    port.resolve = () => ({ ...modelRef, contextWindow: 200_000, maxTokens: minimumTokens - 1 });
    assert.equal((await run({ ...fixture, modelRef, port, now: NOW + 1,
      timezone: "UTC", limits: { ...limits, v2RolloutSummaryBytes: 9_000 },
      signal: new AbortController().signal })).status, "blocked");
    assert.equal(calls.length, 0);
    assert.equal(fixture.db.prepare("SELECT COUNT(*) AS n FROM budget_reservations").get()!.n, 0);
  });
}

test("v2 runner uses the pinned prompt, stores NULL raw learning and bounded summary metadata", async (t) => {
  const { db, job, root } = setup(t, undefined, "v2");
  db.prepare("UPDATE workspaces SET git_branch = 'later-branch'").run();
  const line = "界".repeat(1_500); // 4,500 UTF-8 bytes per line
  const { port, calls } = fakePort([response(JSON.stringify({
    rollout_summary: `${line}\n${line}\nURL https://example.com/important/identifier-must-stay-whole`,
    rollout_slug: "Chinese task history",
  }))]);
  const result = await runV2Extraction({ db, root, job, modelRef, port, now: NOW + 1,
    timezone: "UTC", limits: { ...limits, v2RolloutSummaryBytes: 9_000 },
    signal: new AbortController().signal });
  assert.deepEqual(result, { status: "succeeded" });
  assert.equal(calls.length, 1);
  assert.match(calls[0]?.text ?? "", /You are part of an agent memory system/);
  assert.match(calls[0]?.text ?? "", /captured-branch/);
  assert.doesNotMatch(calls[0]?.text ?? "", /later-branch/);
  const row = db.prepare("SELECT memory_version, raw_memory, rollout_summary, truncated, original_bytes, accepted_bytes FROM extractions")
    .get() as { memory_version: string; raw_memory: string | null; rollout_summary: string;
      truncated: number; original_bytes: number; accepted_bytes: number };
  assert.equal(row.memory_version, "v2");
  assert.equal(row.raw_memory, null);
  assert.ok(row.rollout_summary.startsWith(line));
  assert.match(row.rollout_summary, /…\d+ chars truncated…/);
  assert.ok(row.rollout_summary.endsWith("URL https://example.com/important/identifier-must-stay-whole"));
  assert.equal(row.truncated, 1);
  assert.equal(row.accepted_bytes, Buffer.byteLength(row.rollout_summary, "utf8"));
  assert.ok(row.original_bytes > 9_000);
});

test("T23 v2: invalid schema fails after one sample without a repair or stored output", async (t) => {
  const { db, job, root } = setup(t, undefined, "v2");
  const { port, calls } = fakePort([
    response('{"raw_memory":"v1 leak","rollout_summary":"history","rollout_slug":"history"}'),
    response('{"rollout_summary":"corrected","rollout_slug":"corrected"}'),
  ]);
  assert.deepEqual(await runV2Extraction({ db, root, job, modelRef, port, now: NOW + 1,
    timezone: "UTC", limits: { ...limits, v2RolloutSummaryBytes: 9_000 }, signal: new AbortController().signal }), { status: "blocked" });
  assert.equal(calls.length, 1);
  assert.equal(db.prepare("SELECT error_code FROM jobs").get()!.error_code, "invalid_schema");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM extractions").get()!.n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM budget_reservations").get()!.n, 1);
});

test("v2 stores native no-output without a repair when only a slug is returned", async (t) => {
  const { db, job, root } = setup(t, undefined, "v2");
  const { port, calls } = fakePort([response('{"rollout_summary":"","rollout_slug":"unused-slug"}')]);
  assert.deepEqual(await runV2Extraction({ db, root, job, modelRef, port, now: NOW + 1,
    timezone: "UTC", limits: { ...limits, v2RolloutSummaryBytes: 9_000 },
    signal: new AbortController().signal }), { status: "no_output" });
  assert.equal(calls.length, 1);
  assert.equal((db.prepare("SELECT rollout_summary FROM extractions").get() as { rollout_summary: string }).rollout_summary, "");
});

test("v1 runner refuses a v2 job without a model call or version-mismatched commit", async (t) => {
  const { db, job, root } = setup(t, undefined, "v2");
  const { port, calls } = fakePort([]);
  assert.deepEqual(await runV1Extraction({ db, root, job, modelRef, port, now: NOW + 1,
    timezone: "UTC", limits, signal: new AbortController().signal }), { status: "blocked" });
  assert.equal(calls.length, 0);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM extractions").get() as { n: number }).n, 0);
});

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

test("400KB normalized v1 evidence fits a 272k-token model without a byte/token false rejection", async (t) => {
  const { db, job, root } = setup(t, [
    { entryId: "u1", role: "user", origin: "unknown", text: "START " + "X".repeat(404000) + " END", timestamp: NOW - 30000 },
  ]);
  const { port, calls } = fakePort([response('{"raw_memory":"decision","rollout_summary":"summary","rollout_slug":"choice"}')]);
  port.resolve = () => ({ provider: "mock", modelId: "extract", contextWindow: 272000, maxTokens: 32000 });
  assert.deepEqual(await runV1Extraction({ db, root, job, modelRef, port, now: NOW + 1,
    timezone: "UTC", limits: { ...limits, dailyInputTokens: 200000, dailyOutputTokens: 100000 },
    signal: new AbortController().signal }), { status: "succeeded" });
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.text, /START/);
  assert.match(calls[0]!.text, / END/);
  assert.doesNotMatch(calls[0]!.text, /tokens truncated/);
  const reservation = db.prepare("SELECT estimate_input, estimate_output FROM budget_reservations").get()!;
  assert.ok(Number(reservation.estimate_input) > 100000 && Number(reservation.estimate_input) < 110000);
  assert.equal(reservation.estimate_output, 32000);
});

for (const version of ["v1", "v2"] as const) test(`${version} final context never separates a short choice from its question`, async (t) => {
  const question = `QUESTION_UNIQUE options: 1 keep old database; 2 migrate database. ${"context ".repeat(30_000)} Which option?`;
  const answer = "USE_OPTION_1_UNIQUE";
  const { db, job, root } = setup(t, [
    { entryId: "a1", role: "assistant", origin: null, text: question, timestamp: NOW - 20_000 },
    { entryId: "u1", role: "user", origin: "unknown", text: answer, timestamp: NOW - 10_000 },
  ], version);
  const { port, calls } = fakePort([response(version === "v1" ?
    '{"raw_memory":"","rollout_summary":"","rollout_slug":""}' : '{"rollout_summary":"","rollout_slug":""}')]);
  port.resolve = () => ({ provider: "mock", modelId: "extract", contextWindow: 60_000, maxTokens: 6_000 });
  const result = await (version === "v1" ? runV1Extraction : runV2Extraction)({ db, root, job, modelRef, port,
    now: NOW + 1, timezone: "UTC", limits: { ...limits, v2RolloutSummaryBytes: 9_000 },
    signal: new AbortController().signal });
  assert.equal(result.status, "no_output", `${JSON.stringify({ calls: calls.length, error: db.prepare("SELECT error_code FROM jobs WHERE job_id = ?").get(job.jobId)?.error_code })}`);
  assert.equal(calls.length, 1);
  const sent = calls[0]!.text;
  assert.equal(sent.includes("QUESTION_UNIQUE"), sent.includes(answer), "answer must not be shown without its question");
  if (version === "v1") assert.match(sent, /tokens truncated/);
  else assert.match(sent, /evidence items omitted for model context budget/);
});

for (const version of ["v1", "v2"] as const) test(`${version} model-fit retains a short choice with its fitting question before verbose tool evidence`, async (t) => {
  const question = `QUESTION_UNIQUE options: 1 keep old database; 2 migrate database. ${"context ".repeat(300)} Which option?`;
  const answer = "USE_OPTION_1_UNIQUE";
  const { db, job, root } = setup(t, [
    { entryId: "a1", role: "assistant", origin: null, text: question, timestamp: NOW - 30_000 },
    { entryId: "u1", role: "user", origin: "unknown", text: answer, timestamp: NOW - 20_000 },
    { entryId: "tool1", role: "tool", origin: null, text: "verbose tool log " + "X".repeat(250_000), timestamp: NOW - 10_000 },
  ], version);
  const { port, calls } = fakePort([response(version === "v1" ?
    '{"raw_memory":"","rollout_summary":"","rollout_slug":""}' : '{"rollout_summary":"","rollout_slug":""}')]);
  port.resolve = () => ({ provider: "mock", modelId: "extract", contextWindow: 60_000, maxTokens: 6_000 });
  const result = await (version === "v1" ? runV1Extraction : runV2Extraction)({ db, root, job, modelRef, port,
    now: NOW + 1, timezone: "UTC", limits: { ...limits, v2RolloutSummaryBytes: 9_000 },
    signal: new AbortController().signal });
  assert.equal(result.status, "no_output");
  assert.match(calls[0]!.text, /QUESTION_UNIQUE/);
  assert.match(calls[0]!.text, /USE_OPTION_1_UNIQUE/);
  if (version === "v1") assert.match(calls[0]!.text, /tokens truncated/);
  else assert.doesNotMatch(calls[0]!.text, /verbose tool log/);
});

for (const version of ["v1", "v2"] as const) test(`${version} transport clamps a large output maximum to remaining context`, async t => {
  const { db, job, root } = setup(t, [{ entryId: "u1", role: "user", origin: "unknown",
    text: "context ".repeat(500), timestamp: NOW - 10000 }], version);
  let sentInput = 0;
  let sentOutput = 0;
  const port: MemoryModelPort = {
    resolve: () => ({ provider: "mock", modelId: "extract", contextWindow: 16384, maxTokens: 16384 }),
    request: async (_model, context, options) => {
      const user = context.messages[0]!;
      const text = typeof user.content === "string" ? user.content : JSON.stringify(user.content);
      sentInput = Math.ceil(Buffer.byteLength(context.systemPrompt + text, "utf8") / 4);
      sentOutput = options.maxTokens;
      assert.ok(sentInput + sentOutput <= 16384, "provider request must respect the resolved context window");
      return response(version === "v1" ? '{"raw_memory":"memory","rollout_summary":"summary","rollout_slug":"scope"}' :
        '{"rollout_summary":"summary","rollout_slug":"scope"}');
    },
  };
  assert.deepEqual(await (version === "v1" ? runV1Extraction : runV2Extraction)({ db, root, job, modelRef, port,
    now: NOW + 1, timezone: "UTC", limits: { ...limits, v2RolloutSummaryBytes: 9000 },
    signal: new AbortController().signal }), { status: "succeeded" });
  assert.ok(sentInput > 0 && sentOutput > 0 && sentOutput < 16384);
  const reservation = db.prepare("SELECT estimate_input, estimate_output FROM budget_reservations").get()!;
  assert.equal(reservation.estimate_input, sentInput);
  assert.equal(reservation.estimate_output, sentOutput);
});

test("a model with insufficient context blocks before spending budget", async (t) => {
  const { db, job, root } = setup(t);
  const { port, calls } = fakePort([]);
  port.resolve = () => ({ provider: "mock", modelId: "extract", contextWindow: 100, maxTokens: 8_000 });
  const result = await runV1Extraction({ db, root, job, modelRef, port, now: NOW + 1,
    timezone: "UTC", limits, signal: new AbortController().signal });
  assert.deepEqual(result, { status: "blocked" });
  assert.equal(calls.length, 0);
  assert.equal((db.prepare("SELECT error_code FROM jobs").get() as { error_code: string }).error_code, "context_too_small");
});

test("v1 malformed JSON fails once without replaying provider output as a repair prompt", async (t) => {
  for (const malformed of ["not JSON", '{"raw_memory":"decision","rollout_summary":"summary","rollout_slug":"choice"}}']) {
    const { db, job, root } = setup(t);
    const { port, calls } = fakePort([response(malformed), response('{"raw_memory":"valid","rollout_summary":"valid","rollout_slug":"valid"}')]);
    assert.deepEqual(await runV1Extraction({ db, root, job, modelRef, port, now: NOW + 1,
      timezone: "UTC", limits, signal: new AbortController().signal }), { status: "blocked" });
    assert.equal(calls.length, 1);
    assert.equal(db.prepare("SELECT attempt_count FROM jobs").get()!.attempt_count, 1);
    assert.equal(db.prepare("SELECT error_code FROM jobs").get()!.error_code, "invalid_schema");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM budget_reservations").get()!.n, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM extractions").get()!.n, 0);
  }
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

test("external transient retries retain reservation accounting before a terminal schema failure", async (t) => {
  const { db, job, root } = setup(t);
  let current = job;
  for (let index = 0; index < 2; index++) {
    const now = NOW + index * 300_001 + 1;
    const retry = fakePort([{ stopReason: "error", text: "", errorMessage: "503 temporary" }]);
    assert.deepEqual(await runV1Extraction({ db, root, job: current, modelRef, port: retry.port, now,
      timezone: "UTC", limits: { ...limits, dailyOutputTokens: 100000 }, signal: new AbortController().signal }), { status: "retry_wait" });
    const [next] = claimDueExtractions(db, { owner: `retry-${index}`, now: now + 300_000, limit: 1 });
    assert.ok(next);
    current = next;
  }
  const final = fakePort([response("invalid JSON")]);
  assert.deepEqual(await runV1Extraction({ db, root, job: current, modelRef, port: final.port,
    now: NOW + 600_003, timezone: "UTC", limits: { ...limits, dailyOutputTokens: 100000 }, signal: new AbortController().signal }), { status: "blocked" });
  assert.equal(final.calls.length, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM budget_reservations").get()!.n, 3);
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

for (const version of ["v1", "v2"] as const) test(`T17 ${version}: missing configured model blocks without fallback or copied credentials`, async (t) => {
  const { db, job, root } = setup(t, undefined, version);
  const missing = fakePort([]);
  missing.port.resolve = ref => {
    assert.deepEqual(ref, modelRef, "only the selected pi registry reference is resolved");
    return undefined;
  };
  assert.deepEqual(await (version === "v1" ? runV1Extraction : runV2Extraction)({
    db, root, job, modelRef, port: missing.port, now: NOW + 1, timezone: "UTC",
    limits: { ...limits, v2RolloutSummaryBytes: 9_000 }, signal: new AbortController().signal,
  }), { status: "blocked" });
  assert.equal(missing.calls.length, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM extractions").get()!.n, 0);
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
  assert.equal(row.actual_output, 8_000);
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

for (const version of ["v1", "v2"] as const) test(`T19 ${version}: exhausted budget defers work without starting another request`, async (t) => {
  const { db, job, root } = setup(t, undefined, version);
  const { port, calls } = fakePort([]);
  const result = await (version === "v1" ? runV1Extraction : runV2Extraction)({ db, root, job, modelRef, port, now: NOW + 1,
    timezone: "UTC", limits: { ...limits, v2RolloutSummaryBytes: 9_000, dailyInputTokens: 100 }, signal: new AbortController().signal });
  assert.deepEqual(result, { status: "budget_deferred", reason: "input_budget" });
  assert.equal(calls.length, 0);
  assert.equal((db.prepare("SELECT status FROM jobs").get() as { status: string }).status, "retry_wait");
  assert.equal((db.prepare("SELECT attempt_count FROM jobs").get() as { attempt_count: number }).attempt_count, 0);
});
