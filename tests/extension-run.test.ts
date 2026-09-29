import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import memoryExtension from "../src/extension.ts";
import { makeMockPi } from "./mock-pi.ts";
import { createVersionRun } from "../src/control/switch.ts";
import { recordProcessActivity } from "../src/store/jobs.ts";

for (const scenario of ["selected", "explicit", "late-valid", "late-invalid", "queued", "queued-default", "queued-force-busy", "both"]) test({
  selected: "/memory run --now follows selected v2 and reports its independent extraction",
  explicit: "/memory run --version v2 grants one bounded pass without changing the selected v1 reader",
  "late-valid": "a cancelled version grant accepts an in-flight valid result only in its original namespace",
  "late-invalid": "a cancelled version grant cannot repair after switching away and back",
  queued: "/memory run --version v2 waits for idle and shutdown cancels only its owned grant",
  "queued-default": "/memory run queues the configured target without skipping idle",
  "queued-force-busy": "forced explicit passes report the busy boundary without imposing the ordinary idle window",
  both: "/memory run --version both --now uses one shared two-job pass and preserves single-version reading",
}[scenario]!, async (t) => {
  const explicit = scenario !== "selected" && scenario !== "queued-default";
  let finish: (() => void) | undefined;
  const waiting = new Promise<void>(resolve => { finish = resolve; });
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
      streamSimple: (_model: unknown, context: unknown) => { requests.push(context); return { result: async () => {
        if (scenario.startsWith("late-")) await waiting;
        return ({
        stopReason: "stop", content: [{ type: "text",
          text: scenario === "late-invalid" ? "invalid JSON" : scenario === "both" &&
            !(context as { systemPrompt?: string }).systemPrompt?.includes("You are part of an agent memory system")
            ? '{"raw_memory":"v1 decision","rollout_summary":"v1 history","rollout_slug":"typescript"}'
            : '{"rollout_summary":"用户选定 TypeScript 以保持兼容性","rollout_slug":"typescript"}' }],
        usage: { input: 80, output: 30 },
      }); } }; },
    },
    sessionManager: { getBranch: () => [entry], getHeader: () => header, getSessionFile: () => file,
      getLeafId: () => "u1" },
    ui: { notify: (message: string) => notifications.push(message) },
  };
  await mock.fire("session_start", { type: "session_start" }, ctx);
  const configPath = join(agentDir, "memory", "config.json");
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  // One shared request isolates extraction; the real writer is covered by lifecycle tests.
  writeFileSync(configPath, JSON.stringify({ ...config, version: explicit ? "v1" : "v2", limits: { ...config.limits, dailyRequests: scenario === "both" ? 2 : 1 } }));
  await mock.fire("before_agent_start", { type: "before_agent_start", systemPromptOptions: { sections: {} } }, ctx);
  await mock.fire("agent_settled", { type: "agent_settled" }, ctx);
  let busyUntil = 0;
  if (scenario === "queued-force-busy") {
    const db = new DatabaseSync(join(agentDir, "memory", "state.sqlite"));
    const sessionKey = String(db.prepare("SELECT session_key FROM sessions").get()!.session_key);
    const now = Date.now(); busyUntil = now + 180_000;
    recordProcessActivity(db, { owner: "other-process", sessionKey, state: "active", now }); db.close();
  }
  const running = mock.commands.get("memory")!.handler(scenario === "queued-default" ? "run" : scenario === "queued" ? "run --version v2"
    : scenario === "both" ? "run --version both --now" : explicit ? "run --now --version v2" : "run --now", ctx);
  if (scenario.startsWith("late-")) {
    await new Promise<void>(resolve => setImmediate(resolve));
    await mock.commands.get("memory")!.handler("version v2", ctx);
    await mock.commands.get("memory")!.handler("version v1", ctx);
    finish!();
  }
  await running;
  if (scenario.startsWith("queued")) {
    assert.equal(requests.length, 0);
    await mock.commands.get("memory")!.handler("status", ctx);
    if (scenario === "queued-force-busy") {
      assert.match(notifications.at(-1) ?? "", /v2 extraction: queued \(next due/);
      assert.ok((notifications.at(-1) ?? "").includes(new Date(busyUntil).toISOString()));
    } else assert.match(notifications.at(-1) ?? "", /v2 extraction: queued.*pending idle window.*next due/);
    const db = new DatabaseSync(join(agentDir, "memory", "state.sqlite"));
    const own = db.prepare("SELECT request_id, status FROM version_run_grants").get()!;
    assert.equal(own.status, "active");
    assert.equal(db.prepare("SELECT status FROM jobs WHERE kind = 'extract' AND memory_version = 'v2'").get()!.status, "queued");
    const other = createVersionRun(db, JSON.parse(readFileSync(configPath, "utf8")), "v1", Date.now());
    await mock.fire("session_shutdown", { type: "session_shutdown" }, ctx);
    assert.equal(db.prepare("SELECT status FROM version_run_grants WHERE request_id = ?").get(String(own.request_id))!.status, "cancelled");
    assert.equal(db.prepare("SELECT status FROM version_run_grants WHERE request_id = ?").get(other.requestId)!.status, "active");
    db.close(); return;
  }
  assert.equal(requests.length, scenario === "both" ? 2 : 1);
  const db = new DatabaseSync(join(agentDir, "memory", "state.sqlite"), { readOnly: true });
  const row = db.prepare("SELECT memory_version, raw_memory, rollout_summary FROM extractions WHERE memory_version = 'v2'").get() as
    { memory_version: string; raw_memory: string | null; rollout_summary: string } | undefined;
  if (scenario === "late-invalid") {
    assert.equal(row, undefined);
    assert.equal(db.prepare("SELECT error_code FROM jobs WHERE memory_version = 'v2' AND kind = 'extract'").get()!.error_code, "configuration_changed");
  } else {
    assert.equal(row?.memory_version, "v2");
    assert.equal(row?.raw_memory, null);
    assert.equal(row?.rollout_summary, "用户选定 TypeScript 以保持兼容性");
  }
  if (explicit) {
    assert.equal(JSON.parse(readFileSync(configPath, "utf8")).version, "v1");
    const grant = db.prepare("SELECT request_id, memory_version, policy_hash, status FROM version_run_grants").get()!;
    assert.equal(grant.memory_version, scenario === "both" ? "both" : "v2"); assert.equal(grant.status, scenario.startsWith("late-") ? "cancelled" : "completed");
    const job = db.prepare("SELECT request_id, scheduling_policy_hash FROM jobs WHERE kind = 'extract' AND memory_version = 'v2'").get()!;
    assert.equal(job.request_id, grant.request_id); assert.equal(job.scheduling_policy_hash, grant.policy_hash);
  }
  if (scenario === "both") {
    assert.deepEqual(db.prepare("SELECT memory_version FROM extractions ORDER BY memory_version").all().map(row => row.memory_version), ["v1", "v2"]);
    assert.equal(JSON.parse(readFileSync(configPath, "utf8")).dualWrite, false);
  }
  db.close();
  await mock.commands.get("memory")!.handler("status", ctx);
  assert.match(notifications.at(-1) ?? "", scenario === "late-invalid" ? /v2 extraction: retry_wait/ : /v2 extraction: extracted/);
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
