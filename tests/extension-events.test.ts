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
import { createHash } from "node:crypto";
import { claimConsolidation, commitGeneration, selectConsolidation } from "../src/store/consolidation.ts";

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

test("doctor and status preserve the projected clipped representation", async (t) => {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-memory-clipped-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const mock = makeMockPi(), notifyLog: string[] = [], ctx = mockCtx(notifyLog);
  t.after(async () => {
    await mock.fire("session_shutdown", {}, ctx);
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(agentDir, { recursive: true, force: true });
  });
  extension(mock.pi);
  await mock.fire("session_start", {}, ctx);
  const root = join(agentDir, "memory"), db = openStateDb(root), now = Date.now();
  const hash = (text: string) => createHash("sha256").update(text).digest("hex");
  try {
    const snapshot = selectConsolidation(db, { memoryVersion: "v1", now });
    const lease = claimConsolidation(db, { memoryVersion: "v1", owner: "clipped-test", promptHash: "writer", now });
    assert.ok(lease);
    const directory = join(root, "versions", "v1", "generations", "clipped");
    mkdirSync(directory, { recursive: true });
    const summary = `v1\n## User Profile\n${["A", "B", "C", "D"].map(letter => `${letter} `.repeat(400)).join("\n\n")}\n## User preferences\n## General Tips\n## What's in Memory\n`;
    writeFileSync(join(directory, "memory_summary.md"), summary);
    writeFileSync(join(directory, "MEMORY.md"), "Scoped handbook");
    const manifest = JSON.stringify({ memoryVersion: "v1", controlEpoch: snapshot.controlEpoch, sources: [],
      fileHashes: { "memory_summary.md": hash(summary), "MEMORY.md": hash("Scoped handbook") } });
    writeFileSync(join(directory, "manifest.json"), manifest);
    assert.ok(commitGeneration(db, { lease, snapshot, generation: { memoryVersion: "v1", generationId: "clipped",
      directory, manifestHash: hash(manifest), inputHash: "clipped" }, now }));
  } finally { db.close(); }
  await mock.fire("before_agent_start", {}, ctx);
  assert.ok((await projectRequest(mock, ctx)).memory);
  notifyLog.length = 0;
  await mock.commands.get("memory")!.handler("status", ctx);
  assert.match(notifyLog.join("\n"), /foreground: active .*clipped/);
  notifyLog.length = 0;
  await mock.commands.get("memory")!.handler("doctor", ctx);
  assert.match(notifyLog.join("\n"), /clipped carrier projected/);
  assert.doesNotMatch(notifyLog.join("\n"), /full carrier projected/);
});

test("off mode omits owned memory normally but cannot authorize opaque legacy residue", async (t) => {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-memory-off-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const mock = makeMockPi(), notifications: string[] = [];
  let aborts = 0;
  const ctx = { ...mockCtx(notifications), abort: () => { aborts++; } };
  t.after(async () => {
    await mock.fire("session_shutdown", {}, ctx);
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(agentDir, { recursive: true, force: true });
  });
  const root = join(agentDir, "memory"); mkdirSync(root);
  writeFileSync(join(root, "config.json"), JSON.stringify({ ...defaultConfig("UTC"), enabled: false }));
  extension(mock.pi);
  await mock.fire("session_start", {}, ctx);
  await mock.fire("before_agent_start", {}, ctx);
  const policy = { role: "system", content: "Keep current policy", timestamp: 0 };
  const clean = await mock.fire("context_with_system", { messages: [policy,
    { role: "custom", customType: "pi_memory", content: "old owned carrier", display: false, timestamp: 0 }] }, ctx);
  assert.deepEqual(clean, { messages: [policy] });
  assert.equal(aborts, 0, "ordinary disabling must continue the task");
  await mock.fire("context_with_system", { messages: [{ ...policy,
    content: "## Pi Memory\nMemory version: v1\n<historical_memory_evidence>old private evidence</historical_memory_evidence>" }] }, ctx);
  assert.equal(aborts, 1, "off is not permission to dispatch opaque old memory");
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
