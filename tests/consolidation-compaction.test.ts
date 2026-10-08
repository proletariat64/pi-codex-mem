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

function fixture(t: test.TestContext, memoryVersion: MemoryVersion = "v1") {
  const root = mkdtempSync(join(tmpdir(), "pi-context-compaction-"));
  const repo = join(root, "repo"); mkdirSync(repo); execFileSync("git", ["init", "-q"], { cwd: repo });
  const directory = join(root, "staging"); mkdirSync(directory); mkdirSync(join(directory, "rollout_summaries"));
  writeFileSync(join(directory, "rollout_summaries/source.md"), "User adopted TypeScript.");
  if (memoryVersion === "v1") writeFileSync(join(directory, "raw_memories.md"), "TypeScript was adopted.");
  writeFileSync(join(directory, "phase2_workspace_diff.md"), "Added rollout_summaries/source.md");
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

function scriptedPort(steps: Step[]) {
  const calls: { context: TranscriptContext; options?: unknown }[] = [];
  const port: ConsolidationModelPort = { resolve: () => smallWindow, stream: (_model, context, options) => {
    calls.push({ context: structuredClone(context), options });
    const step = steps[calls.length - 1];
    if (!step) throw new Error(`Unexpected port call #${calls.length}`);
    const bounded = createAssistantMessageEventStream();
    void (async () => {
      const message = await step({ context, options });
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

