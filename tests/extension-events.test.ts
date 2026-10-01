import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import extension from "../src/extension.ts";
import { makeMockPi, projectRequest } from "./mock-pi.ts";
import { defaultConfig } from "../src/config.ts";
import { openStateDb } from "../src/store/db.ts";
import { ConsolidationScheduler } from "../src/pipeline/scheduler.ts";

function mockCtx(notifyLog: string[]) {
  return {
    cwd: process.cwd(),
    hasUI: true,
    model: { provider: "mock", id: "memory", contextWindow: 200_000, maxTokens: 8_000 },
    ui: { notify: (msg: string) => notifyLog.push(msg) },
    sessionManager: { getBranch: () => [] },
    modelRegistry: { find: () => undefined, streamSimple: () => undefined },
  };
}

test("config edited mid-session takes effect at the next foreground run", async (t) => {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-memory-agent-"));
  t.after(() => rmSync(agentDir, { recursive: true, force: true }));
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => delete process.env.PI_CODING_AGENT_DIR);

  const mock = makeMockPi();
  const notifyLog: string[] = [];
  extension(mock.pi);
  const ctx = mockCtx(notifyLog);
  t.after(async () => { await mock.fire("session_shutdown", {}, ctx); });

  // session_start creates config.json with defaults (read-write).
  await mock.fire("session_start", {}, ctx);
  const configPath = join(agentDir, "memory", "config.json");
  const created = JSON.parse(readFileSync(configPath, "utf8"));
  assert.equal(created.generate, true);

  // User edits config mid-session: read-only.
  writeFileSync(configPath, JSON.stringify({ ...created, generate: false }));

  // The next foreground run re-samples config (spec §5.4).
  const options = { sections: {} as Record<string, string> };
  await mock.fire("before_agent_start", { systemPromptOptions: options }, ctx);
  assert.equal(options.sections.pi_memory, undefined, "preparation adds no section");

  // /memory status reflects the edited configuration.
  await mock.commands.get("memory")!.handler("status", ctx);
  const status = notifyLog.find((m) => m.includes("mode:"));
  assert.ok(status, "status notify emitted");
  assert.match(status, /mode: read \(from config\)/);
  assert.match(status, /store: not initialized yet/, "control DB alone is not a captured store");
  await mock.commands.get("memory")!.handler("doctor", ctx);
  assert.ok(notifyLog.some((m) => m.includes("state.sqlite not initialized")));
});

test("existing valid config plus legacy lock is diagnosed by status and doctor", async (t) => {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-memory-agent-"));
  t.after(() => rmSync(agentDir, { recursive: true, force: true }));
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => delete process.env.PI_CODING_AGENT_DIR);
  const mock = makeMockPi();
  const notifyLog: string[] = [];
  extension(mock.pi);
  const ctx = mockCtx(notifyLog);
  t.after(async () => { await mock.fire("session_shutdown", {}, ctx); });
  await mock.fire("session_start", {}, ctx); // Creates valid config first.
  mkdirSync(join(agentDir, "memory", "config.json.lock"));
  await mock.commands.get("memory")!.handler("status", ctx);
  await mock.commands.get("memory")!.handler("doctor", ctx);
  assert.ok(notifyLog.some((m) => m.includes("upgrade BLOCKED") && m.includes("manually remove")));
  assert.ok(notifyLog.some((m) => m.includes("control-lock") && m.includes("pre-upgrade Pi processes")));
});

test("missing structured sections does not disable request-local projection; next session resets observations", async (t) => {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-memory-agent-"));
  t.after(() => rmSync(agentDir, { recursive: true, force: true }));
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => delete process.env.PI_CODING_AGENT_DIR);

  const mock = makeMockPi();
  const notifyLog: string[] = [];
  extension(mock.pi);
  const ctx = mockCtx(notifyLog);
  t.after(async () => { await mock.fire("session_shutdown", {}, ctx); });

  await mock.fire("session_start", {}, ctx);
  const root = join(agentDir, "memory");
  const db = openStateDb(root);
  const writer = new ConsolidationScheduler({ root, db, config: () => defaultConfig("UTC"), modelPort: () => null,
    now: Date.now, isForegroundIdle: () => true });
  try { await writer.runPass(); await writer.stop(); } finally { db.close(); }
  await mock.fire("before_agent_start", {}, ctx);
  assert.match((await projectRequest(mock, ctx)).memory ?? "", /Memory version: v1/,
    "request-local projection does not require structured system sections");
  await mock.commands.get("memory")!.handler("doctor", ctx);
  assert.ok(notifyLog.some((m) => /active: .* carrier projected/.test(m)));
  assert.ok(!notifyLog.some((m) => /structured system-prompt sections|section_injection_conflict/.test(m)));

  // A new session in the same runtime resets request observations.
  await mock.fire("session_start", {}, ctx);
  notifyLog.length = 0;
  await mock.commands.get("memory")!.handler("doctor", ctx);
  assert.ok(notifyLog.some((m) => m.includes("no_foreground_run")));
  assert.ok(!notifyLog.some((m) => /active: .* carrier projected/.test(m)));
});
