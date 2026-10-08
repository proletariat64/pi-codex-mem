import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream, type Api, type AssistantMessage, type Model,
  type TranscriptContext, type JsonObject } from "@earendil-works/pi-ai";
import { defaultConfig, type MemoryVersion } from "../src/config.ts";
import { openStateDb } from "../src/store/db.ts";
import { claimConsolidation } from "../src/store/consolidation.ts";
import { consolidationPromptHash, runConsolidation } from "../src/pipeline/consolidate.ts";
import { createContextCalibrationStore, createContextController } from "../src/pipeline/context-controller.ts";
import type { ConsolidationModelPort, ConsolidationTokenCount } from "../src/pipeline/model-port.ts";
import type { ContextCalibrationStore, NormalizedRequest } from "../src/pipeline/context-controller.ts";

const NOW = Date.UTC(2026, 8, 1, 12);
const model: Model<Api> = { id: "writer", name: "Writer", api: "openai-completions", provider: "mock",
  baseUrl: "https://example.invalid", reasoning: false, input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 272_000, maxTokens: 8_000 };
const summary = "v1\n\n## User Profile\n\n## User preferences\n\n## General Tips\n\n## What's in Memory\n";
const handbook = "# Task Group: TypeScript\nscope: project\napplies_to: cwd=/repo; reuse_rule=project\n\n" +
  "## Task 1: chosen language\n### rollout_summary_files\n- rollout_summaries/source.md\n### keywords\n- TypeScript\n";
// ~404 KB of English-heavy transcript text (~101k tokens at utf8_div4).
const englishHeavy = "The quick brown fox jumps over the lazy dog while reviewing consolidation evidence summaries. ".repeat(
  Math.ceil(404_000 / "The quick brown fox jumps over the lazy dog while reviewing consolidation evidence summaries. ".length));

function fixture(t: test.TestContext, memoryVersion: MemoryVersion = "v1") {
  const root = mkdtempSync(join(tmpdir(), "pi-context-admission-"));
  const repo = join(root, "repo"); mkdirSync(repo); execFileSync("git", ["init", "-q"], { cwd: repo });
  const directory = join(root, "staging"); mkdirSync(directory); mkdirSync(join(directory, "rollout_summaries"));
  writeFileSync(join(directory, "rollout_summaries/source.md"), "User adopted TypeScript.");
  if (memoryVersion === "v1") writeFileSync(join(directory, "raw_memories.md"), "TypeScript was adopted.");
  writeFileSync(join(directory, "phase2_workspace_diff.md"), "Added rollout_summaries/source.md");
  const db = openStateDb(join(root, "memory"));
  t.after(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  const config = defaultConfig("UTC");
  const lease = claimConsolidation(db, { memoryVersion, owner: "admission-test",
    promptHash: consolidationPromptHash(config, memoryVersion), now: NOW });
  assert.ok(lease);
  return { db, directory, lease, config };
}

function reply(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"] = "stop",
  input = 10, output = 5): AssistantMessage {
  return { role: "assistant", content, stopReason, api: model.api, model: model.id, provider: model.provider,
    timestamp: NOW, usage: { input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}
function tool(name: string, args: JsonObject, id = name) {
  return { type: "toolCall" as const, name, arguments: args, id };
}
function fakePort(responses: AssistantMessage[], resolved: Model<Api> = model,
  counter?: (request: NormalizedRequest) => ConsolidationTokenCount | undefined) {
  const calls: { context: TranscriptContext; maxTokens?: number; maxRetries?: number }[] = [];
  const port: ConsolidationModelPort = { resolve: () => resolved, stream: (_model, context, options) => {
    calls.push({ context: structuredClone(context), maxTokens: options?.maxTokens, maxRetries: options?.maxRetries });
    const message = responses.shift();
    if (!message) throw new Error("Unexpected extra model request");
    const stream = createAssistantMessageEventStream();
    if (message.stopReason === "error" || message.stopReason === "aborted") {
      stream.push({ type: "error", reason: message.stopReason, error: message });
    } else {
      stream.push({ type: "done", reason: message.stopReason as "stop" | "length" | "toolUse", message });
    }
    return stream;
  } };
  if (counter) port.countTokens = (_model, request) => counter(request);
  return { port, calls };
}
const reservations = (db: import("node:sqlite").DatabaseSync) =>
  db.prepare("SELECT estimate_input, estimate_output, actual_input, actual_output, status FROM budget_reservations ORDER BY rowid").all();
const run = (setup: ReturnType<typeof fixture>, port: ConsolidationModelPort,
  extra: Partial<Parameters<typeof runConsolidation>[0]> = {}) => runConsolidation({ ...setup, port,
  modelRef: { provider: "mock", modelId: "writer" }, signal: new AbortController().signal,
  clock: () => NOW + 1, contextCalibration: createContextCalibrationStore(), ...extra });
const controllerIdentityModel = { provider: "mock", id: "writer", api: "openai-completions",
  contextWindow: model.contextWindow, maxTokens: model.maxTokens };

test("CT01: a fitting ~404 KB English-heavy transcript is admitted under estimated token admission, not bytes", async (t) => {
  const setup = fixture(t);
  const { port, calls } = fakePort([
    reply([{ type: "text", text: englishHeavy }, tool("workspace_list", {})], "toolUse"),
    reply([{ type: "text", text: "Written." }]),
  ]);
  assert.deepEqual(await run(setup, port), { status: "succeeded" });
  assert.equal(calls.length, 2, "the byte-count regression must not block the accumulated request");
  const rows = reservations(setup.db) as { estimate_input: number; estimate_output: number }[];
  assert.equal(rows.length, 2);
  assert.ok(rows[0]!.estimate_input > 10_000, "writer prompt and tool declarations are counted once as tokens");
  assert.ok(rows[0]!.estimate_input < 30_000, "reservation is estimated tokens, not the old byte count");
  assert.ok(rows[1]!.estimate_input > 110_000, "the 404 KB body is part of the safety-adjusted estimate");
  assert.ok(rows[1]!.estimate_input < 200_000, "estimated tokens, never 400k+ bytes");
  assert.ok(rows[1]!.estimate_input > rows[0]!.estimate_input, "each accumulated request reserves its full context");
});

test("CT01: exact matching-tokenizer admission reserves exact tokens without a safety multiplier", async (t) => {
  const setup = fixture(t);
  const { port, calls } = fakePort([
    reply([{ type: "text", text: englishHeavy }, tool("workspace_list", {})], "toolUse"),
    reply([{ type: "text", text: "Written." }], "stop", 0, 0),
  ], model, () => ({ tokens: 150_000, counterIdentity: { provider: "mock", modelId: "writer" } }));
  assert.deepEqual(await run(setup, port), { status: "succeeded" });
  assert.equal(calls.length, 2);
  const rows = reservations(setup.db) as { estimate_input: number }[];
  assert.equal(rows[0]!.estimate_input, 150_000);
  assert.equal(rows[1]!.estimate_input, 150_000, "exact counts are not multiplied");
});

test("unusable model capacity is blocked as context_capacity_unavailable before any transport", async (t) => {
  const setup = fixture(t);
  const broken: Model<Api> = { ...model, contextWindow: 0 };
  const { port, calls } = fakePort([], broken);
  assert.deepEqual(await run(setup, port), { status: "blocked", reason: "context_capacity_unavailable" });
  assert.equal(calls.length, 0);
  assert.equal((setup.db.prepare("SELECT COUNT(*) AS n FROM budget_reservations").get() as { n: number }).n, 0);
});

test("above the soft limit with compactable history stops at the settled seam when compaction is unavailable", async (t) => {
  const setup = fixture(t);
  const small: Model<Api> = { ...model, contextWindow: 60_000 };
  const { port, calls } = fakePort([
    reply([{ type: "text", text: "界".repeat(30_000) }, tool("workspace_list", {})], "toolUse"),
  ], small);
  assert.deepEqual(await run(setup, port), { status: "blocked", reason: "compaction_limit" });
  assert.equal(calls.length, 1, "only the first request is sent; no resend on the unchanged payload");
  assert.equal((setup.db.prepare("SELECT COUNT(*) AS n FROM budget_reservations").get() as { n: number }).n, 1);
});

test("an irreducible first request — framing alone above the soft limit — never dispatches", async (t) => {
  const setup = fixture(t);
  const tiny: Model<Api> = { ...model, contextWindow: 25_000 };
  const { port, calls } = fakePort([], tiny);
  assert.deepEqual(await run(setup, port), { status: "blocked", reason: "context_irreducible" });
  assert.equal(calls.length, 0);
  assert.equal((setup.db.prepare("SELECT COUNT(*) AS n FROM budget_reservations").get() as { n: number }).n, 0);
});

test("CT04: explicit provider context overflow is classified distinctly and bumps the estimated multiplier at least 2x", async (t) => {
  const setup = fixture(t);
  const calibration = createContextCalibrationStore();
  const overflow = { ...reply([tool("workspace_list", {})], "toolUse", 17_000, 400), stopReason: "error" as const,
    errorMessage: "400 This model's maximum context length is 65_536 tokens. However, your messages resulted in 70_000 tokens." };
  const first = fakePort([overflow]);
  assert.deepEqual(await run(setup, first.port, { contextCalibration: calibration }),
    { status: "blocked", reason: "provider_context_overflow" });
  assert.equal(first.calls.length, 1, "no hidden resend of the unchanged payload");
  const charged = reservations(setup.db) as { estimate_input: number; actual_input: number; status: string }[];
  assert.equal(charged.length, 1);
  assert.ok(charged[0]!.estimate_input < 30_000, "failed transport reserved estimated tokens, not bytes");
  assert.equal(charged[0]!.actual_input, 17_000, "failed transport is accounted honestly");
  assert.equal(charged[0]!.status, "charged");
  assert.doesNotMatch(JSON.stringify(setup.db.prepare("SELECT * FROM jobs").all()), /maximum context length/);
  const observed = createContextController({ model: controllerIdentityModel, calibration }).safetyMultiplier;
  assert.equal(observed, 2.5, "the bounded recovery raises the fallback multiplier to at least twice its value");
  // A second overflow after re-admission still ends blocked in the bounded gate.
  const secondSetup = fixture(t);
  const second = fakePort([overflow]);
  assert.deepEqual(await run(secondSetup, second.port, { contextCalibration: calibration }),
    { status: "blocked", reason: "provider_context_overflow" });
  const bumps = reservations(secondSetup.db) as { estimate_input: number }[];
  assert.ok(bumps[0]!.estimate_input > charged[0]!.estimate_input * 1.9, "the raised multiplier feeds the next reservation");
});

test("CT04: exact-count mode reports overflow without raising the multiplier", async (t) => {
  const setup = fixture(t);
  const calibration = createContextCalibrationStore();
  const counter = () => ({ tokens: 150_000, counterIdentity: { provider: "mock", modelId: "writer" } });
  const overflow = { ...reply([], "error", 150_000, 0), errorMessage: "prompt is too long: 150_012 tokens > 150_000 maximum" };
  const { port, calls } = fakePort([overflow], model, counter);
  assert.deepEqual(await run(setup, port, { contextCalibration: calibration }),
    { status: "blocked", reason: "provider_context_overflow" });
  assert.equal(calls.length, 1);
  const rows = reservations(setup.db) as { estimate_input: number }[];
  assert.equal(rows[0]!.estimate_input, 150_000);
  const observed = createContextController({ model: controllerIdentityModel, calibration }).safetyMultiplier;
  assert.equal(observed, 1.25, "exact-count transport mismatch keeps normal protocol reserves");
});

test("CT03: a generic 400, timeout or malformed response is never inferred as context overflow", async (t) => {
  const setup = fixture(t);
  const response = { ...reply([], "error"), errorMessage: "400 malformed request body" };
  const { port, calls } = fakePort([response]);
  assert.deepEqual(await run(setup, port), { status: "retry_wait", reason: "provider_error" });
  assert.equal(calls.length, 1);
});

test("CT04: underestimation is calibrated into the next estimate and cannot grant requests beyond the daily allowance", async (t) => {
  const setup = fixture(t);
  setup.config.limits.dailyInputTokens = 50_000;
  const { port, calls } = fakePort([
    reply([tool("workspace_list", {})], "toolUse", 120_000, 500),
  ]);
  assert.deepEqual(await run(setup, port), { status: "budget_deferred", reason: "input_budget" });
  assert.equal(calls.length, 1);
  const budget = setup.db.prepare("SELECT actual_input FROM budget_usage").get() as { actual_input: number };
  assert.equal(budget.actual_input, 120_000, "the underestimate is charged honestly");
  assert.equal((setup.db.prepare("SELECT COUNT(*) AS n FROM budget_reservations").get() as { n: number }).n, 1,
    "the second request is denied at daily admission, not dispatched");
});

test("CT02: unicode-heavy accumulated history that fits the window is admitted where bytes previously blocked it", async (t) => {
  const setup = fixture(t);
  const medium: Model<Api> = { ...model, contextWindow: 120_000 };
  const { port, calls } = fakePort([
    reply([{ type: "text", text: "界".repeat(30_000) }, tool("workspace_list", {})], "toolUse"),
    reply([{ type: "text", text: "Written." }]),
  ], medium);
  assert.deepEqual(await run(setup, port), { status: "succeeded" });
  assert.equal(calls.length, 2);
});