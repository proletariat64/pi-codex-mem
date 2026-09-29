import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import extension from "../src/extension.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;

/** Minimal mock of the pi ExtensionAPI surface the extension uses. */
function mockPi() {
  const handlers = new Map<string, Handler>();
  const commands = new Map<string, { description?: string; handler: (args: string, ctx: never) => Promise<void> }>();
  const pi = {
    registerFlag: () => {},
    getFlag: () => undefined,
    on: (event: string, handler: Handler) => {
      handlers.set(event, handler);
      return () => {};
    },
    registerCommand: (name: string, def: never) => commands.set(name, def),
    registerTool: () => {},
  };
  return { pi, handlers, commands };
}

function mockCtx(notifyLog: string[]) {
  return {
    hasUI: true,
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

  const { pi, handlers, commands } = mockPi();
  const notifyLog: string[] = [];
  extension(pi as never);
  const ctx = mockCtx(notifyLog);

  // session_start creates config.json with defaults (read-write)
  await handlers.get("session_start")!({}, ctx);
  const configPath = join(agentDir, "memory", "config.json");
  const created = JSON.parse(readFileSync(configPath, "utf8"));
  assert.equal(created.generate, true);

  // user edits config mid-session: read-only
  writeFileSync(configPath, JSON.stringify({ ...created, generate: false }));

  // next foreground run re-samples config (spec §5.4)
  await handlers.get("before_agent_start")!({ systemPromptOptions: { sections: {} } }, ctx);

  // /memory status reflects the edited configuration
  await commands.get("memory")!.handler("status", ctx as never);
  const status = notifyLog.find((m) => m.includes("mode:"));
  assert.ok(status, "status notify emitted");
  assert.match(status!, /mode: read \(from config\)/);
  assert.match(status!, /store: not initialized yet/, "control DB alone is not a captured store");
  await commands.get("memory")!.handler("doctor", ctx as never);
  assert.ok(notifyLog.some((m) => m.includes("state.sqlite not initialized")));
});

test("existing valid config plus legacy lock is diagnosed by status and doctor", async (t) => {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-memory-agent-"));
  t.after(() => rmSync(agentDir, { recursive: true, force: true }));
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => delete process.env.PI_CODING_AGENT_DIR);
  const { pi, handlers, commands } = mockPi();
  const notifyLog: string[] = [];
  extension(pi as never);
  const ctx = mockCtx(notifyLog);
  await handlers.get("session_start")!({}, ctx); // creates valid config first
  mkdirSync(join(agentDir, "memory", "config.json.lock"));
  await commands.get("memory")!.handler("status", ctx as never);
  await commands.get("memory")!.handler("doctor", ctx as never);
  assert.ok(notifyLog.some((m) => m.includes("upgrade BLOCKED") && m.includes("manually remove")));
  assert.ok(notifyLog.some((m) => m.includes("control-lock") && m.includes("pre-upgrade Pi processes")));
});

test("a foreground run without structured sections marks them unavailable; next session resets", async (t) => {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-memory-agent-"));
  t.after(() => rmSync(agentDir, { recursive: true, force: true }));
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => delete process.env.PI_CODING_AGENT_DIR);

  const { pi, handlers, commands } = mockPi();
  const notifyLog: string[] = [];
  extension(pi as never);
  const ctx = mockCtx(notifyLog);

  await handlers.get("session_start")!({}, ctx);
  // run without sections -> unavailable, visible to doctor
  await handlers.get("before_agent_start")!({}, ctx);
  await commands.get("memory")!.handler("doctor", ctx as never);
  assert.ok(notifyLog.some((m) => m.includes("did not expose structured system-prompt sections")));

  // new session in the same runtime: probe resets to unobserved
  await handlers.get("session_start")!({}, ctx);
  notifyLog.length = 0;
  await commands.get("memory")!.handler("doctor", ctx as never);
  assert.ok(notifyLog.some((m) => m.includes("not yet observed")));
  assert.ok(!notifyLog.some((m) => m.includes("did not expose structured system-prompt sections")));
});
