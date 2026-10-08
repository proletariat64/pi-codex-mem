import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream, type Api, type AssistantMessage, type JsonObject,
  type Message, type Model, type SystemMessage, type TranscriptContext } from "@earendil-works/pi-ai";
import { defaultConfig, type MemoryVersion } from "../src/config.ts";
import { openStateDb } from "../src/store/db.ts";
import { claimConsolidation } from "../src/store/consolidation.ts";
import { consolidationPromptHash, runConsolidation } from "../src/pipeline/consolidate.ts";
import { createContextCalibrationStore } from "../src/pipeline/context-controller.ts";
import type { ConsolidationModelPort } from "../src/pipeline/model-port.ts";
import type { ContextCalibrationStore } from "../src/pipeline/context-controller.ts";

const NOW = Date.UTC(2026, 8, 1, 12);
const model: Model<Api> = { id: "writer", name: "Writer", api: "openai-completions", provider: "mock",
  baseUrl: "https://example.invalid", reasoning: false, input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 272_000, maxTokens: 8_000 };
/** Small window so accumulated tool-result history crosses the soft limit quickly.
 *  I = 60_000 - 4_000 - 1_024 = 54_976; soft = 38_483; hard = 49_478; target = 27_488. */
const smallWindow: Model<Api> = { ...model, contextWindow: 60_000 };
const SOFT = Math.floor((60_000 - 4_000 - 1_024) * 0.7);
const HARD = Math.floor((60_000 - 4_000 - 1_024) * 0.9);
const TARGET = Math.floor((60_000 - 4_000 - 1_024) * 0.5);
/** Segmented-fixture window: I = 38_976; soft = 27_283; hard = 35_078; target = 19_488.
 *  The writer's irreducible framing counts ~14,100 estimated units, so a clean-slate
 *  replacement with two small labeled summaries still fits the install target. */
const segmentWindow: Model<Api> = { ...model, contextWindow: 44_000 };
const SEG_HARD = Math.floor((44_000 - 4_000 - 1_024) * 0.9);
const SEG_TARGET = Math.floor((44_000 - 4_000 - 1_024) * 0.5);
/** Full-mode no-progress window: target 19,988 leaves room for framing plus only a
 *  short summary, so a valid but long summary fails the target honestly. */
const noProgressWindow: Model<Api> = { ...model, contextWindow: 45_000 };

function fixture(t: test.TestContext, memoryVersion: MemoryVersion = "v1", options?: { bigDiff?: boolean }) {
  const root = mkdtempSync(join(tmpdir(), "pi-context-compaction-"));
  const repo = join(root, "repo"); mkdirSync(repo); execFileSync("git", ["init", "-q"], { cwd: repo });
  const directory = join(root, "staging"); mkdirSync(directory); mkdirSync(join(directory, "rollout_summaries"));
  writeFileSync(join(directory, "rollout_summaries/source.md"), "User adopted TypeScript.");
  if (memoryVersion === "v1") writeFileSync(join(directory, "raw_memories.md"), "TypeScript was adopted.");
  if (options?.bigDiff) {
    // A ~42 KB CJK diff makes one full workspace_read page return ~16 KiB of tool text.
    const line = "\u754c".repeat(64) + " evidence line";
    writeFileSync(join(directory, "phase2_workspace_diff.md"), Array.from({ length: 200 }, () => line).join("\n"));
  } else writeFileSync(join(directory, "phase2_workspace_diff.md"), "Added rollout_summaries/source.md");
  const db = openStateDb(join(root, "memory"));
  t.after(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  const config = defaultConfig("UTC");
  const lease = claimConsolidation(db, { memoryVersion, owner: "compaction-test",
    promptHash: consolidationPromptHash(config, memoryVersion), now: NOW });
  assert.ok(lease);
  return { db, directory, lease, config, root };
}

function reply(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"] = "stop",
  input = 10, output = 5): AssistantMessage {
  return { role: "assistant", content, stopReason, api: model.api, model: model.id, provider: model.provider,
    timestamp: NOW, usage: { input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}
function tool(name: string, args: JsonObject = {}, id = name) {
  return { type: "toolCall" as const, name, arguments: args, id };
}
/** One scripted port step: sees the exact request the writer is about to send. */
type Step = (call: { context: TranscriptContext; options?: unknown }) =>
  AssistantMessage | Promise<AssistantMessage>;

function scriptedPort(steps: Array<Step | AssistantMessage>, portModel: Model<Api> = smallWindow) {
  const calls: { context: TranscriptContext; options?: unknown }[] = [];
  const port: ConsolidationModelPort = { resolve: () => portModel, stream: (_model, context, options) => {
    calls.push({ context: structuredClone(context), options });
    const step = steps[calls.length - 1];
    if (!step) throw new Error(`Unexpected port call #${calls.length}`);
    const bounded = createAssistantMessageEventStream();
    void (async () => {
      const message = typeof step === "function" ? await step({ context, options }) : step;
      if (message.stopReason === "error" || message.stopReason === "aborted") {
        bounded.push({ type: "error", reason: message.stopReason, error: message });
      } else {
        bounded.push({ type: "done", reason: message.stopReason as "stop" | "length" | "toolUse", message });
      }
    })();
    return bounded;
  } };
  return { port, calls };
}

/** A compaction request is tool-free: its leading system message carries no tool declarations. */
const isCompactionCall = (call: { context: TranscriptContext }) =>
  !(call.context.messages[0] as SystemMessage).toolsAdded?.length && call.context.messages[0]?.role === "system";

const run = (setup: ReturnType<typeof fixture>, port: ConsolidationModelPort,
  extra: Partial<Parameters<typeof runConsolidation>[0]> = {}) => runConsolidation({ ...setup, port,
  modelRef: { provider: "mock", modelId: "writer" }, signal: new AbortController().signal,
  clock: () => NOW + 1, contextCalibration: createContextCalibrationStore(), ...extra });
const reservations = (db: import("node:sqlite").DatabaseSync) =>
  db.prepare("SELECT estimate_input, estimate_output, actual_input, status FROM budget_reservations ORDER BY rowid").all();

test("CT05: accumulated pages crossing the soft limit compact at the settled seam and install a recounted replacement", async (t) => {
  const setup = fixture(t);
  const { port, calls } = scriptedPort([
    // Turn 1: read evidence, results settle.
    () => reply([{ type: "text", text: "界".repeat(12_000) }, tool("workspace_list")], "toolUse"),
    // Turn 2: more evidence; history now crosses the soft limit.
    () => reply([{ type: "text", text: "界".repeat(30_000) }, tool("workspace_list")], "toolUse"),
    // Call 3: the next ordinary request is never sent; this is the compaction request.
    (call) => {
      assert.ok(isCompactionCall(call), `expected a tool-free compaction request, got roles ${call.context.messages.map((m) => m.role).join(",")}`);
      assert.equal((call.options as { maxRetries?: number } | undefined)?.maxRetries, 0);
      return reply([{ type: "text", text: "Covered: read phase2_workspace_diff.md; the sources are staged; workspace_list pages were fetched. Next: write outputs with a secret sk-ABCDEFGHIJKLMNOPQRSTUV16 inline." }]);
    },
    // Call 4: writer continues from the compacted replacement.
    (call) => {
      const roles = call.context.messages.map((m) => m.role);
      assert.deepEqual(roles, ["system", "assistant", "user"]);
      assert.ok((call.context.messages[0] as SystemMessage).toolsAdded!.length >= 4, "original tool declarations and framing survive");
      const summary = call.context.messages[1] as AssistantMessage;
      assert.equal(summary.content[0]!.type, "text");
      assert.match((summary.content[0] as { text: string }).text, /^\[Derived working-context summary/);
      assert.doesNotMatch((summary.content[0] as { text: string }).text, /sk-ABCD/, "summary is redacted as writer output");
      const continuation = call.context.messages[2] as { role: string; content: { type: string; text: string }[] };
      assert.match(continuation.content[0]!.text, /Consolidate this v1 staged workspace/);
      return reply([{ type: "text", text: "Outputs written." }]);
    },
  ]);
  const calibration: ContextCalibrationStore = createContextCalibrationStore();
  assert.deepEqual(await run(setup, port, { contextCalibration: calibration }), { status: "succeeded" });
  assert.equal(calls.length, 4);
  assert.ok(!isCompactionCall(calls[0]!) && !isCompactionCall(calls[1]!), "ordinary writer requests carry tool declarations");
  const rows = reservations(setup.db) as { estimate_input: number; status: string }[];
  assert.equal(rows.length, 4, "the compaction transport consumes an ordinary request reservation");
  assert.deepEqual(rows.map((row) => row.status), ["charged", "charged", "charged", "charged"]);
  assert.ok(rows[2]!.estimate_input <= HARD, "the compaction request fits its own hard limit");
  assert.ok(rows[3]!.estimate_input <= TARGET, `the replacement is recounted at/below compactTarget (${rows[3]!.estimate_input} > ${TARGET})`);
});


// --- §5.2 segmented fallback: shared burst script on the segmentWindow fixture ---
// Turn 1 (small): ~6k units of CJK plus a listing widens the fit band so the burst
// unit fits the compactor alone while the full history cannot. Turn 2 burst: ~24.5k
// units in one settled unit (text plus one ~16 KiB read page, results counted whole).
const segmentTurn1 = () => reply([{ type: "text", text: "\u754c".repeat(7_300) }, tool("workspace_list")], "toolUse");
const segmentBurstTurn = (text = 22_000) =>
  reply([{ type: "text", text: "\u754c".repeat(text) }, tool("workspace_read", { path: "phase2_workspace_diff.md" })], "toolUse");
const smallSummary = (marker: string) =>
  reply([{ type: "text", text: `Summary ${marker}: decisions, references, corrections and next reads.` }]);

test("CT06: first segment above target and second below install exactly once atomically", async (t) => {
  const setup = fixture(t, "v1", { bigDiff: true });
  const { port, calls } = scriptedPort([
    segmentTurn1(),
    segmentBurstTurn(),
    (call) => {
      assert.ok(isCompactionCall(call), "segment 1 is a tool-free compaction request");
      assert.ok(!JSON.stringify(call.context.messages.slice(1)).includes("workspace_read"),
        "the oversized burst unit is excluded from the oldest contiguous range");
      return smallSummary("one");
    },
    (call) => {
      assert.ok(isCompactionCall(call), "segment 2 is a tool-free compaction request");
      assert.match(JSON.stringify(call.context.messages), /phase2_workspace_diff\.md/,
        "segment 2 covers the contiguous burst unit, call and results whole");
      return smallSummary("two");
    },
    (call) => {
      const roles = call.context.messages.map((m) => m.role);
      assert.deepEqual(roles, ["system", "assistant", "assistant", "user"],
        "framing + two labeled summaries + host continuation, installed once");
      const summaries = call.context.messages.filter((m) => m.role === "assistant");
      assert.equal(summaries.length, 2);
      for (const summary of summaries) {
        const text = (summary as AssistantMessage).content[0]!;
        assert.equal(text.type, "text");
        assert.match((text as { text: string }).text, /^\[Derived working-context summary\]/);
      }
      return reply([{ type: "text", text: "Outputs written." }]);
    },
  ], segmentWindow);
  assert.deepEqual(await run(setup, port), { status: "succeeded" });
  assert.equal(calls.length, 5, "writer, writer, segment, segment, resumed writer");
  const rows = reservations(setup.db) as { estimate_input: number; status: string }[];
  assert.equal(rows.length, 5);
  assert.deepEqual(rows.map((row) => row.status), Array.from({ length: 5 }, () => "charged"));
  assert.ok(rows[3]!.estimate_input <= SEG_HARD, "each segment request fits the compactor's own hard limit");
  assert.ok(rows[4]!.estimate_input <= SEG_TARGET, `the installed replacement is at/below target (${rows[4]!.estimate_input})`);
});

test("CT06: readiness lost on the second segment installs nothing", async (t) => {
  const setup = fixture(t, "v1", { bigDiff: true });
  let readiness: "ready" | "configuration_changed" = "ready";
  const { port, calls } = scriptedPort([
    segmentTurn1(),
    segmentBurstTurn(),
    () => { readiness = "configuration_changed"; return smallSummary("one"); }, // flip while the segment-2 seam re-checks
    () => { throw new Error("segment 2 must not dispatch after ownership loss"); },
  ], segmentWindow);
  assert.deepEqual(await run(setup, port, { canStartRequest: () => readiness }),
    { status: "paused", reason: "configuration_changed" });
  assert.equal(calls.length, 3, "live history is unchanged: no second segment, no resumed writer request");
  assert.equal((setup.db.prepare("SELECT COUNT(*) AS n FROM budget_reservations").get() as { n: number }).n, 3);
});

test("CT06/CT14: denied daily compactor budget on the second segment installs nothing and defers honestly", async (t) => {
  const setup = fixture(t, "v1", { bigDiff: true });
  setup.config.limits.dailyInputTokens = 28_500;
  const { port, calls } = scriptedPort([
    segmentTurn1(),
    segmentBurstTurn(),
    () => smallSummary("one"),
    () => { throw new Error("segment 2 must not dispatch when daily admission denies"); },
  ], segmentWindow);
  const result = await run(setup, port);
  assert.deepEqual(result, { status: "budget_deferred", reason: "input_budget" });
  assert.equal(calls.length, 3);
  assert.equal((setup.db.prepare("SELECT COUNT(*) AS n FROM budget_reservations").get() as { n: number }).n, 3,
    "the failed compaction keeps the prior state unpublished-by-staging and charges only spent transports");
  assert.doesNotMatch(JSON.stringify(setup.db.prepare("SELECT * FROM jobs").all()), /Summary one/, "no generated body in logs");
  assert.equal((setup.db.prepare("SELECT COUNT(*) AS n FROM generations").get() as { n: number }).n, 0);
});

test("CT06: one oversized unit cannot fit the compactor and ends context_irreducible", async (t) => {
  const setup = fixture(t, "v1", { bigDiff: true });
  const { port, calls } = scriptedPort([
    segmentTurn1(),
    segmentBurstTurn(28_000),
    () => smallSummary("one"),
    () => { throw new Error("the oversized unit must never be dispatched"); },
  ], segmentWindow);
  assert.deepEqual(await run(setup, port), { status: "blocked", reason: "context_irreducible" });
  assert.equal(calls.length, 3);
  assert.doesNotMatch(JSON.stringify(calls[2]?.context), /Outputs written/, "nothing installs over a live unchanged history");
});

test("CT06: exhausted 2-per-lease slots end compaction_limit with nothing installed", async (t) => {
  const setup = fixture(t, "v1", { bigDiff: true });
  const { port, calls } = scriptedPort([
    segmentTurn1(),
    segmentBurstTurn(),
    () => reply([{ type: "text", text: "Summary one: short decisions and reads." }]),
    // A valid (within the 16 KiB cap) but long second summary keeps the candidate above target.
    () => reply([{ type: "text", text: 'Summary two: ' + "\u754c".repeat(5_400) }]),
    () => { throw new Error("the third slot must never dispatch"); },
  ], segmentWindow);
  assert.deepEqual(await run(setup, port), { status: "blocked", reason: "compaction_limit" });
  assert.equal(calls.length, 4);
  assert.equal((setup.db.prepare("SELECT COUNT(*) AS n FROM budget_reservations").get() as { n: number }).n, 4);
});

test("CT06: an unchanged-size segment summary discards the candidate with compaction_no_progress", async (t) => {
  const setup = fixture(t, "v1", { bigDiff: true });
  const { port, calls } = scriptedPort([
    () => reply([{ type: "text", text: "\u754c".repeat(2_000) }, tool("workspace_list")], "toolUse"),
    () => reply([{ type: "text", text: "\u754c".repeat(25_000) }, tool("workspace_read", { path: "phase2_workspace_diff.md" })], "toolUse"),
    // A same-size summary of the oldest range: valid but without measurable reduction.
    () => reply([{ type: "text", text: "Same-size: " + "\u754c".repeat(5_400) }]),
  ], segmentWindow);
  assert.deepEqual(await run(setup, port), { status: "blocked", reason: "compaction_no_progress" });
  assert.equal(calls.length, 3, "the failing segment ends the attempt without dispatching the candidate");
});

test("CT06: full-mode invalid summary output ends compaction_output_invalid (empty, length-capped, oversized)", async (t) => {
  for (const response of [
    reply([]),                                         // completed but empty text
    reply([{ type: "text", text: "cut off mid-sentence" }], "length"), // output-cap hit
    reply([{ type: "text", text: "\u754c".repeat(6_000) }]),            // > 16 KiB representation
  ]) {
    const setup = fixture(t);
    const { port, calls } = scriptedPort([
      reply([{ type: "text", text: "\u754c".repeat(12_000) }, tool("workspace_list")], "toolUse"),
      reply([{ type: "text", text: "\u754c".repeat(30_000) }, tool("workspace_list")], "toolUse"),
      () => response,
    ]);
    assert.deepEqual(await run(setup, port), { status: "blocked", reason: "compaction_output_invalid" },
      `invalid summary must end the attempt (${JSON.stringify(response.stopReason)})`);
    assert.equal(calls.length, 3);
  }
});

test("CT06: a full-mode summary that cannot cross the compact target ends compaction_no_progress", async (t) => {
  const setup = fixture(t);
  const { port, calls } = scriptedPort([
    reply([{ type: "text", text: "\u754c".repeat(5_600) }, tool("workspace_list")], "toolUse"),
    reply([{ type: "text", text: "\u754c".repeat(5_600) }, tool("workspace_list")], "toolUse"),
    // A valid (~15 KiB, within cap) but long summary that cannot reach the target.
    () => reply([{ type: "text", text: "\u754c".repeat(5_000) }]),
  ], noProgressWindow);
  assert.deepEqual(await run(setup, port), { status: "blocked", reason: "compaction_no_progress" });
  assert.equal(calls.length, 3);
});
