import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import memoryExtension from "../src/extension.ts";
import { makeMockPi } from "./mock-pi.ts";

test("/memory run --now follows selected v2 and reports its independent extraction", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-memory-run-v2-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, "repo"); mkdirSync(cwd);
  execFileSync("git", ["init", "-q"], { cwd });
  const agentDir = join(root, "agent");
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous; });
  const file = join(root, "session.jsonl");
  const header = { type: "session", version: 3, id: "v2-session", cwd, timestamp: new Date().toISOString() };
  const entry = { type: "message", id: "u1", parentId: null, timestamp: new Date().toISOString(),
    message: { role: "user", content: [{ type: "text", text: "选择 TypeScript 以保持兼容性" }], timestamp: Date.now() } };
  writeFileSync(file, JSON.stringify(header) + "\n" + JSON.stringify(entry) + "\n");
  const model = { provider: "mock", id: "extract", contextWindow: 200_000, maxTokens: 8_000 };
  const requests: unknown[] = [];
  const mock = makeMockPi(); memoryExtension(mock.pi);
  const notifications: string[] = [];
  const ctx = { cwd, mode: "tui", hasUI: true, isIdle: () => true, model,
    modelRegistry: {
      find: () => model,
      streamSimple: (_model: unknown, context: unknown) => { requests.push(context); return { result: async () => ({
        stopReason: "stop", content: [{ type: "text",
          text: '{"rollout_summary":"用户选定 TypeScript 以保持兼容性","rollout_slug":"typescript"}' }],
        usage: { input: 80, output: 30 },
      }) }; },
    },
    sessionManager: { getBranch: () => [entry], getHeader: () => header, getSessionFile: () => file,
      getLeafId: () => "u1" },
    ui: { notify: (message: string) => notifications.push(message) },
  };
  await mock.fire("session_start", { type: "session_start" }, ctx);
  const configPath = join(agentDir, "memory", "config.json");
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  // One shared request isolates extraction; the real writer is covered by lifecycle tests.
  writeFileSync(configPath, JSON.stringify({ ...config, version: "v2", limits: { ...config.limits, dailyRequests: 1 } }));
  await mock.fire("before_agent_start", { type: "before_agent_start", systemPromptOptions: { sections: {} } }, ctx);
  await mock.fire("agent_settled", { type: "agent_settled" }, ctx);
  await mock.commands.get("memory")!.handler("run --now", ctx);
  assert.equal(requests.length, 1);
  const db = new DatabaseSync(join(agentDir, "memory", "state.sqlite"), { readOnly: true });
  const row = db.prepare("SELECT memory_version, raw_memory, rollout_summary FROM extractions").get() as
    { memory_version: string; raw_memory: string | null; rollout_summary: string } | undefined;
  db.close();
  assert.equal(row?.memory_version, "v2");
  assert.equal(row?.raw_memory, null);
  assert.equal(row?.rollout_summary, "用户选定 TypeScript 以保持兼容性");
  await mock.commands.get("memory")!.handler("status", ctx);
  assert.match(notifications.at(-1) ?? "", /v2 extraction: extracted/);
  await mock.fire("session_shutdown", { type: "session_shutdown" }, ctx);
});

test("/memory run --now extracts a settled v1 snapshot through Pi's model registry", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-memory-run-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, "repo"); mkdirSync(cwd);
  execFileSync("git", ["init", "-q"], { cwd });
  const agentDir = join(root, "agent");
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous; });
  const file = join(root, "session.jsonl");
  const header = { type: "session", version: 3, id: "session-1", cwd, timestamp: new Date().toISOString() };
  const entry = { type: "message", id: "u1", parentId: null, timestamp: new Date().toISOString(),
    message: { role: "user", content: [{ type: "text", text: "We chose TypeScript" }], timestamp: Date.now() } };
  writeFileSync(file, JSON.stringify(header) + "\n" + JSON.stringify(entry) + "\n");
  let branch: Array<Omit<typeof entry, "parentId"> & { parentId: string | null }> = [entry];
  let leafId = "u1";
  const model = { provider: "mock", id: "extract", contextWindow: 200_000, maxTokens: 8_000 };
  const requests: unknown[] = [];
  const mock = makeMockPi(); memoryExtension(mock.pi);
  const notifications: string[] = [];
  const ctx = { cwd, mode: "tui", hasUI: true, isIdle: () => true, model,
    modelRegistry: {
      find: (provider: string, id: string) => provider === "mock" && id === "extract" ? model : undefined,
      streamSimple: (_model: unknown, context: unknown, options: unknown) => {
        requests.push({ context, options });
        return { result: async () => ({ stopReason: "stop", content: [{ type: "text",
          text: '{"raw_memory":"The user chose TypeScript","rollout_summary":"Decision: TypeScript was adopted","rollout_slug":"typescript-choice"}' }],
        usage: { input: 300, output: 60 } }) };
      },
    },
    sessionManager: { getBranch: () => branch, getHeader: () => header, getSessionFile: () => file, getLeafId: () => leafId },
    ui: { notify: (message: string) => notifications.push(message) },
  };
  await mock.fire("session_start", { type: "session_start" }, ctx);
  await mock.fire("before_agent_start", { type: "before_agent_start", systemPromptOptions: { sections: {} } }, ctx);
  await mock.fire("agent_settled", { type: "agent_settled" }, ctx);
  assert.equal(requests.length, 0, "the default six-hour idle window prevents immediate automatic work");

  // Isolate this extraction contract with one shared daily provider request.
  // Consolidation is exercised through a real Agent in consolidation-lifecycle.test.ts.
  const configurationPath = join(agentDir, "memory", "config.json");
  const beforeRun = JSON.parse(readFileSync(configurationPath, "utf8"));
  writeFileSync(configurationPath, JSON.stringify({ ...beforeRun, limits: { ...beforeRun.limits, dailyRequests: 1 } }));

  await mock.commands.get("memory")!.handler("run --now", ctx);

  const db = new DatabaseSync(join(agentDir, "memory", "state.sqlite"), { readOnly: true });
  const row = db.prepare("SELECT raw_memory, model_provider, model_id, usage_input, usage_output FROM extractions")
    .get() as { raw_memory: string; model_provider: string; model_id: string; usage_input: number; usage_output: number } | undefined;
  db.close();
  assert.equal(row?.raw_memory, "The user chose TypeScript");
  assert.equal(row?.model_provider, "mock");
  assert.equal(row?.model_id, "extract");
  assert.equal(row?.usage_input, 300);
  assert.equal(row?.usage_output, 60);
  assert.equal(requests.length, 1);
  assert.match(notifications.at(-1) ?? "", /succeeded/i);
  const cfg = JSON.parse(readFileSync(join(agentDir, "memory", "config.json"), "utf8"));
  assert.deepEqual(cfg.models.extract, { provider: "mock", modelId: "extract" });
  assert.deepEqual(cfg.models.consolidate, { provider: "mock", modelId: "extract" });
  await mock.commands.get("memory")!.handler("status", ctx);
  assert.match(notifications.at(-1) ?? "", /v1 extraction: extracted/);

  const configPath = join(agentDir, "memory", "config.json");
  writeFileSync(configPath, JSON.stringify({ ...cfg, limits: { ...cfg.limits, dailyInputTokens: 100, dailyRequests: 20 } }));
  const next = { ...entry, id: "u2", parentId: "u1", timestamp: new Date().toISOString(),
    message: { ...entry.message, content: [{ type: "text", text: "Further TypeScript decision" }] } };
  branch = [entry, next]; leafId = "u2";
  await mock.fire("before_agent_start", { type: "before_agent_start", systemPromptOptions: { sections: {} } }, ctx);
  await mock.fire("agent_settled", { type: "agent_settled" }, ctx);
  await mock.commands.get("memory")!.handler("run --now", ctx);
  assert.match(notifications.at(-1) ?? "", /budget_deferred \(input_budget\)/);
  assert.equal(requests.length, 1, "budget exhaustion must not make a provider request");
  await mock.commands.get("memory")!.handler("status", ctx);
  assert.match(notifications.at(-1) ?? "", /v1 extraction: retry_wait — input_budget/);
  await mock.fire("session_shutdown", { type: "session_shutdown" }, ctx);
});
