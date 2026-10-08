import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { createAssistantMessageEventStream, type Api, type AssistantMessage, type JsonObject,
  type Message, type Model, type SystemMessage, type TranscriptContext } from "@earendil-works/pi-ai";
import { defaultConfig, type MemoryVersion } from "../src/config.ts";
import { openStateDb } from "../src/store/db.ts";
import { claimConsolidation } from "../src/store/consolidation.ts";
import { consolidationPromptHash, runConsolidation } from "../src/pipeline/consolidate.ts";
import { persistentDiagnostics } from "../src/diagnostics.ts";
import { textHash } from "../src/pipeline/staging.ts";
import { createContextCalibrationStore, createContextController } from "../src/pipeline/context-controller.ts";
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

/** Create a leased writer workspace with optional large diff input and automatic store and file cleanup. */
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

/** Build a deterministic assistant response with configurable stop reason and synthetic token usage. */
function reply(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"] = "stop",
  input = 10, output = 5): AssistantMessage {
  return { role: "assistant", content, stopReason, api: model.api, model: model.id, provider: model.provider,
    timestamp: NOW, usage: { input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}
/** Build a tool-call block with optional arguments and a stable default call identifier. */
function tool(name: string, args: JsonObject = {}, id = name) {
  return { type: "toolCall" as const, name, arguments: args, id };
}
/** One scripted port step: sees the exact request the writer is about to send. */
type Step = (call: { context: TranscriptContext; options?: unknown }) =>
  AssistantMessage | Promise<AssistantMessage>;

/** Capture requests and stream scripted messages or asynchronous responses under the supplied model capacity. */
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

/** Run the fixture writer with a fixed clock and fresh calibration state, allowing per-test overrides. */
const run = (setup: ReturnType<typeof fixture>, port: ConsolidationModelPort,
  extra: Partial<Parameters<typeof runConsolidation>[0]> = {}) => runConsolidation({ ...setup, port,
  modelRef: { provider: "mock", modelId: "writer" }, signal: new AbortController().signal,
  clock: () => NOW + 1, contextCalibration: createContextCalibrationStore(), ...extra });
/** Read reservation accounting in request order to check writer and compaction charges. */
const reservations = (db: import("node:sqlite").DatabaseSync) =>
  db.prepare("SELECT estimate_input, estimate_output, actual_input, status FROM budget_reservations ORDER BY rowid").all();

for (const version of ["v1", "v2"] as const) {
  test(`CT08 ${version}: compaction retains staged output hashes, pinned framing, tools and host lease identity`, async (t) => {
    const setup = fixture(t, version);
    const leaseBefore = structuredClone(setup.lease);
    const output = "Existing staged output before compaction.\n";
    const { port, calls } = scriptedPort([
      () => reply([{ type: "text", text: "界".repeat(40_000) }, tool("workspace_write", { path: "memory_summary.md", content: output })], "toolUse"),
      call => {
        assert.ok(isCompactionCall(call));
        assert.equal(textHash(readFileSync(join(setup.directory, "memory_summary.md"), "utf8")), textHash(output));
        return reply([{ type: "text", text: "DERIVED: preserve outputs and host identity; this creates no provenance." }]);
      },
      call => {
        assert.deepEqual(call.context.messages[0], calls[0]!.context.messages[0], "trusted original instructions and tool schemas survive exactly");
        assert.match(JSON.stringify(call.context.messages.at(-1)), new RegExp(`Consolidate this ${version}`));
        assert.equal(textHash(readFileSync(join(setup.directory, "memory_summary.md"), "utf8")), textHash(output));
        return reply([tool("workspace_write", { path: "MEMORY.md", content: "# Memory\\n" })], "toolUse");
      },
      () => reply([{ type: "text", text: "Done" }]),
    ]);
    assert.deepEqual(await run(setup, port), { status: "succeeded" });
    assert.deepEqual(setup.lease, leaseBefore);
    assert.equal(existsSync(join(setup.directory, "MEMORY.md")), version === "v1", "compaction cannot broaden the version output allowlist");
    assert.equal(textHash(readFileSync(join(setup.directory, "memory_summary.md"), "utf8")), textHash(output));
    assert.equal(setup.db.prepare("SELECT COUNT(*) AS n FROM notes").get()!.n, 0);
    assert.equal(setup.db.prepare("SELECT COUNT(*) AS n FROM generations").get()!.n, 0);
  });
}

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
  const beforeDoctor = setup.db.prepare("SELECT total_changes() AS n").get()!.n;
  const report = persistentDiagnostics(setup.db, setup.config, NOW + 2);
  const lines = report.lines.join("\n");
  assert.equal(report.selectedReadable, false, "successful working compaction is not a publication");
  assert.match(lines, /utf8_div4_estimate/);
  assert.match(lines, /estimated_tokens/);
  assert.match(lines, /compactionPolicy=1; diffPolicy=2/);
  assert.match(lines, /model=mock\/writer; transport=openai-completions/);
  assert.match(lines, /window=60000 tokens/);
  assert.match(lines, /requests=4; tools=2; compactions=1/);
  assert.match(lines, /last compaction:.*installed/);
  assert.match(lines, /observation: input=10 tokens/);
  assert.doesNotMatch(lines, /Covered:|sk-ABCD|Outputs written|界/);
  assert.equal(setup.db.prepare("SELECT total_changes() AS n").get()!.n, beforeDoctor, "doctor is read-only");
  const reader = new DatabaseSync(join(setup.root, "memory/state.sqlite"), { readOnly: true });
  try { assert.deepEqual(persistentDiagnostics(reader, setup.config, NOW + 2), report,
    "doctor's separate read-only connection observes the same store's run"); } finally { reader.close(); }
});


test("CT04: output-only compactor usage retains its input charge and denies the resumed writer", async (t) => {
  const setup = fixture(t);
  setup.config.limits.dailyInputTokens = 50_000;
  const { port, calls } = scriptedPort([
    reply([{ type: "text", text: "界".repeat(12_000) }, tool("workspace_list")], "toolUse"),
    reply([{ type: "text", text: "界".repeat(30_000) }, tool("workspace_list")], "toolUse"),
    call => {
      assert.ok(isCompactionCall(call));
      return reply([{ type: "text", text: "Short derived summary" }], "stop", 0, 5);
    },
    reply([{ type: "text", text: "Must not dispatch" }]),
  ]);
  assert.deepEqual(await run(setup, port), { status: "budget_deferred", reason: "input_budget" });
  assert.equal(calls.length, 3);
  const rows = reservations(setup.db) as { estimate_input: number; actual_input: number }[];
  assert.equal(rows[2]!.actual_input, rows[2]!.estimate_input);
});

// --- §5.2 segmented fallback: shared burst script on the segmentWindow fixture ---
// Turn 1 (small): ~6k units of CJK plus a listing widens the fit band so the burst
// unit fits the compactor alone while the full history cannot. Turn 2 burst: ~24.5k
// units in one settled unit (text plus one ~16 KiB read page, results counted whole).
const segmentTurn1 = () => reply([{ type: "text", text: "\u754c".repeat(7_300) }, tool("workspace_list")], "toolUse");
// Additional visible text keeps the segment fixture oversized now that host details are excluded.
const segmentBurstTurn = (text = 27_500) =>
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
    segmentBurstTurn(33_500),
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
    () => reply([{ type: "text", text: "\u754c".repeat(30_500) }, tool("workspace_read", { path: "phase2_workspace_diff.md" })], "toolUse"),
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

const overflowReply = () => {
  const message = reply([tool("workspace_list")], "toolUse", 17_000, 400);
  message.stopReason = "error";
  message.errorMessage = "400 This model's maximum context length is 65_536 tokens. However, your messages resulted in 70_000 tokens.";
  return message;
};

test("§7.2: a first writer overflow compacts and recounts through the same gates before the resend", async (t) => {
  const setup = fixture(t);
  const overflowWindow: Model<Api> = { ...model, contextWindow: 100_000 };
  const calibration = createContextCalibrationStore();
  const { port, calls } = scriptedPort([
    reply([{ type: "text", text: "\u754c".repeat(12_000) }, tool("workspace_list")], "toolUse"),
    () => overflowReply(), // the provider rejects the admitted request as overflow
    (call) => {
      assert.ok(isCompactionCall(call), "recovery dispatches a tool-free compaction before any resend");
      return smallSummary("recovery");
    },
    (call) => {
      assert.deepEqual(call.context.messages.map((m) => m.role), ["system", "assistant", "user"],
        "the resend carries the recounted replacement, never the unchanged payload");
      return reply([{ type: "text", text: "Outputs written." }]);
    },
  ], overflowWindow);
  assert.deepEqual(await run(setup, port, { contextCalibration: calibration }), { status: "succeeded" });
  assert.equal(calls.length, 4);
  const rows = reservations(setup.db) as { estimate_input: number }[];
  assert.equal(rows.length, 4);
  assert.equal(createContextController({ model: { provider: "mock", id: "writer", api: "openai-completions",
    contextWindow: 100_000, maxTokens: 8_000 }, calibration }).safetyMultiplier, 2.5,
    "the bounded recovery doubled the fallback multiplier once");
  const resend = rows[3]!.estimate_input;
  const candidateBase = resend / 2.5;
  assert.ok(rows[0]!.estimate_input / 1.25 * 2.4 < resend,
    `the doubled multiplier feeds the honest recount of the resend (${resend} vs base ${candidateBase})`);
});

test("§7.2: a second overflow after recovery ends provider_context_overflow without resending", async (t) => {
  const setup = fixture(t);
  const overflowWindow: Model<Api> = { ...model, contextWindow: 100_000 };
  const { port, calls } = scriptedPort([
    reply([{ type: "text", text: "\u754c".repeat(12_000) }, tool("workspace_list")], "toolUse"),
    () => overflowReply(),
    () => smallSummary("recovery"),
    () => overflowReply(), // the resend overflows again: bounded recovery is exhausted
    () => { throw new Error("no further resend after a second overflow"); },
  ], overflowWindow);
  assert.deepEqual(await run(setup, port), { status: "blocked", reason: "provider_context_overflow" });
  assert.equal(calls.length, 4);
  assert.equal((setup.db.prepare("SELECT COUNT(*) AS n FROM budget_reservations").get() as { n: number }).n, 4,
    "every failed transport stays charged; no hidden third attempt");
});

test("§7.2: overflow recovery with nothing compactable stops before any resend", async (t) => {
  const setup = fixture(t, "v1", { bigDiff: false });
  const overflowWindow: Model<Api> = { ...model, contextWindow: 100_000 };
  const { port, calls } = scriptedPort([
    () => overflowReply(), // the very first request overflows: framing alone is the history
  ], overflowWindow);
  assert.deepEqual(await run(setup, port), { status: "blocked", reason: "provider_context_overflow" });
  assert.equal(calls.length, 1, "no compaction of irreducible framing and no resend");
});

for (const reason of ["foreground_active", "configuration_changed"] as const) {
  test(`CT07: ${reason} after a provider tool-call reply pauses before workspace execution`, async (t) => {
    const setup = fixture(t);
    let readiness: "ready" | "foreground_active" = "ready";
    const { port, calls } = scriptedPort([
      () => {
        const response = reply([tool("workspace_write", {
          path: "MEMORY.md", content: "Must not be written after readiness loss.",
        })], "toolUse");
        // Lose readiness at the provider response boundary, after dispatch admission
        // but before the Agent can execute the returned workspace tool call.
        if (reason === "configuration_changed") setup.config.generate = false;
        else readiness = "foreground_active";
        return response;
      },
      () => { throw new Error("no provider dispatch after readiness loss"); },
    ]);
    const result = await run(setup, port, { canStartRequest: () => readiness });
    assert.equal(existsSync(join(setup.directory, "MEMORY.md")), false,
      "readiness loss prevents the returned workspace write");
    assert.deepEqual(result, { status: "paused", reason });
    assert.equal(calls.length, 1, "no subsequent provider dispatch");
  });
}

// --- CT07: mid-compaction fence checks with a cancellation-ignoring transport ---
const waitFor = async (predicate: () => boolean) => {
  for (let i = 0; i < 2_000 && !predicate(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
};

/** Writer replies stream immediately; the compaction call hangs until the test releases it. */
function hangingCompactionPort(writerResponses: AssistantMessage[], options?: { onCompactionDispatch?: () => void }) {
  const calls: { context: TranscriptContext }[] = [];
  let release: ((message: AssistantMessage) => void) | undefined;
  const port: ConsolidationModelPort = { resolve: () => smallWindow, stream: (_model, context) => {
    calls.push({ context: structuredClone(context) });
    const bounded = createAssistantMessageEventStream();
    if (!(context.messages[0] as SystemMessage).toolsAdded?.length) {
      options?.onCompactionDispatch?.();
      release = (message) => {
        if (message.stopReason === "error" || message.stopReason === "aborted") {
          bounded.push({ type: "error", reason: message.stopReason, error: message });
        } else bounded.push({ type: "done", reason: "stop", message });
      };
    } else {
      const message = writerResponses.shift();
      if (!message) throw new Error(`unexpected writer call #${calls.length}`);
      bounded.push({ type: "done", reason: message.stopReason === "toolUse" ? "toolUse" : "stop", message });
    }
    return bounded;
  } };
  return { port, calls, release: () => release };
}

test("CT07: a mid-compaction abort discards the late result, charges the estimate and installs nothing", async (t) => {
  const setup = fixture(t);
  const abort = new AbortController();
  const { port, calls, release } = hangingCompactionPort([
    reply([{ type: "text", text: "\u754c".repeat(12_000) }, tool("workspace_list")], "toolUse"),
    reply([{ type: "text", text: "\u754c".repeat(30_000) }, tool("workspace_list")], "toolUse"),
  ]);
  const runPromise = run(setup, port, { signal: abort.signal });
  await waitFor(() => calls.length === 3 && release() !== undefined);
  abort.abort();
  assert.deepEqual(await runPromise, { status: "cancelled", reason: "aborted" });
  const rows = reservations(setup.db) as { estimate_input: number; status: string; actual_input: number }[];
  assert.equal(rows.length, 3);
  assert.equal(rows[2]!.status, "charged");
  assert.equal(rows[2]!.actual_input, rows[2]!.estimate_input,
    "a cancellation-ignoring transport returns no usage; the estimate stays charged");
  // The result lands later; the fenced seam admits no stale request, write or install.
  release()!(reply([{ type: "text", text: "Late compaction result after abort." }]));
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls.length, 3);
});

test("CT07: foreground activation during compaction discards the candidate without installing", async (t) => {
  const setup = fixture(t);
  let readiness: "ready" | "foreground_active" = "ready";
  const { port, calls, release } = hangingCompactionPort([
    reply([{ type: "text", text: "\u754c".repeat(12_000) }, tool("workspace_list")], "toolUse"),
    reply([{ type: "text", text: "\u754c".repeat(30_000) }, tool("workspace_list")], "toolUse"),
  ], { onCompactionDispatch: () => { readiness = "foreground_active"; } });
  const runPromise = run(setup, port, { canStartRequest: () => readiness });
  await waitFor(() => calls.length === 3 && release() !== undefined);
  release()!(smallSummary("discarded"));
  assert.deepEqual(await runPromise, { status: "paused", reason: "foreground_active" });
  assert.equal(calls.length, 3, "no resumed writer request after the discarded candidate");
  assert.equal((setup.db.prepare("SELECT COUNT(*) AS n FROM budget_reservations").get() as { n: number }).n, 3);
});

test("CT07: lease loss during compaction ends lease_lost and installs nothing", async (t) => {
  const setup = fixture(t);
  const { port, calls, release } = hangingCompactionPort([
    reply([{ type: "text", text: "\u754c".repeat(12_000) }, tool("workspace_list")], "toolUse"),
    reply([{ type: "text", text: "\u754c".repeat(30_000) }, tool("workspace_list")], "toolUse"),
  ]);
  const runPromise = run(setup, port);
  await waitFor(() => calls.length === 3 && release() !== undefined);
  setup.db.prepare("UPDATE jobs SET owner = 'successor', fence = fence + 1 WHERE job_id = ?").run(setup.lease.jobId);
  release()!(smallSummary("discarded"));
  assert.deepEqual(await runPromise, { status: "blocked", reason: "lease_lost" });
  assert.equal(calls.length, 3);
});

test("CT06: call exhaustion during a compact trigger ends model_call_budget without a reset", async (t) => {
  const setup = fixture(t);
  const hundredk: Model<Api> = { ...model, contextWindow: 100_000 };
  const turns = Array.from({ length: 12 }, () =>
    reply([{ type: "text", text: "\u754c".repeat(3_600) }, tool("workspace_list")], "toolUse"));
  const { port, calls } = scriptedPort([...turns], hundredk);
  assert.deepEqual(await run(setup, port), { status: "blocked", reason: "model_call_budget" });
  assert.equal(calls.length, 12, "compaction transport shares the same call counter");
  assert.equal((setup.db.prepare("SELECT COUNT(*) AS n FROM budget_reservations").get() as { n: number }).n, 12);
});

test("CT06: the total writer timeout ends the compact seam as total_timeout", async (t) => {
  const setup = fixture(t);
  let elapsed = 0;
  const { port, calls } = scriptedPort([
    () => reply([{ type: "text", text: "\u754c".repeat(12_000) }, tool("workspace_list")], "toolUse"),
    () => { elapsed = 300_000; return reply([{ type: "text", text: "\u754c".repeat(30_000) }, tool("workspace_list")], "toolUse"); },
  ]);
  const runPromise = run(setup, port, { clock: () => NOW + 1 + elapsed });
  // The clock is spent while turn 2 settles; the next seam fences as total_timeout.
  assert.deepEqual(await runPromise, { status: "blocked", reason: "total_timeout" });
  assert.ok(calls.length < 3, "no further transport after the total timeout");
});

// --- CT08/§5.3/CT14: host repair state retention and run-owned summaries ---
const databaseDump = (db: import("node:sqlite").DatabaseSync): string => {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[];
  return tables.map((table) => {
    try { return JSON.stringify(db.prepare(`SELECT * FROM "${table.name}"`).all()); }
    catch { return ""; }
  }).join("\n");
};

test("CT08: compaction preserves the outstanding repair diagnostic verbatim next to the labeled summary", async (t) => {
  const setup = fixture(t);
  let validateCalls = 0;
  const { port, calls } = scriptedPort([
    reply([{ type: "text", text: "\u754c".repeat(12_000) }, tool("workspace_list")], "toolUse"),
    // Terminal turn with invalid artifacts: the host steers one repair diagnostic.
    () => reply([{ type: "text", text: "\u754c".repeat(30_000) }]),
    () => smallSummary("with repair state"),
    // The resumed writer must see framing, summary, repair instruction and continuation.
    (call) => {
      const roles = call.context.messages.map((m) => m.role);
      assert.deepEqual(roles, ["system", "assistant", "user", "user"],
        "framing + labeled summary + retained repair diagnostic + host continuation");
      const repair = call.context.messages[2]!.content;
      const repairText = typeof repair === "string" ? repair : (repair[0] as { text: string }).text;
      assert.match(repairText, /^Repair the staged required artifacts/);
      assert.match(repairText, /summary first-line marker/);
      assert.match(repairText, /sole validation repair opportunity/);
      return reply([{ type: "text", text: "Repaired and written." }]);
    },
  ]);
  const { ArtifactFormatError } = await import("../src/pipeline/artifacts.ts");
  const result = await run(setup, port, { validateOutputs: () => {
    validateCalls++;
    if (validateCalls === 1) throw new ArtifactFormatError("summary first-line marker must be literal v1");
  } });
  assert.deepEqual(result, { status: "succeeded" });
  assert.equal(validateCalls, 2, "the repair allowance and validation contract survive compaction");
  assert.equal(calls.length, 4);
});

test("§5.3/CT14: a successful compaction leaves no summary body in any durable table or log row", async (t) => {
  const setup = fixture(t);
  const { port, calls } = scriptedPort([
    reply([{ type: "text", text: "\u754c".repeat(12_000) }, tool("workspace_list")], "toolUse"),
    reply([{ type: "text", text: "\u754c".repeat(30_000) }, tool("workspace_list")], "toolUse"),
    () => reply([{ type: "text", text: "RunOwnedBodyMarker: covered reads and decisions; nothing else." }]),
    () => reply([{ type: "text", text: "Outputs written." }]),
  ]);
  assert.deepEqual(await run(setup, port), { status: "succeeded" });
  assert.equal(calls.length, 4);
  const dump = databaseDump(setup.db);
  assert.doesNotMatch(dump, /RunOwnedBodyMarker/, "summaries live only in run-owned memory");
  assert.doesNotMatch(dump, /Derived working-context summary/, "labels never leak into durable state either");
  assert.equal((setup.db.prepare("SELECT COUNT(*) AS n FROM generations").get() as { n: number }).n, 0,
    "a finished writer stays unpublished-by-staging until host validation and publication CAS");
});
