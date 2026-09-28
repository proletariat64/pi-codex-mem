import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import memoryExtension from "../src/extension.ts";
import { makeMockPi } from "./mock-pi.ts";

test("first settled capture in a fresh store arms automatic extraction without manual run or restart", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-memory-fresh-auto-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, "repo"); mkdirSync(cwd);
  execFileSync("git", ["init", "-q"], { cwd });
  const agentDir = join(root, "agent");
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous; });
  const file = join(root, "session.jsonl");
  const header = { type: "session", version: 3, id: "new-session", cwd, timestamp: new Date().toISOString() };
  const entry = { type: "message", id: "u1", parentId: null, timestamp: new Date().toISOString(),
    message: { role: "user", content: [{ type: "text", text: "Use TypeScript" }], timestamp: Date.now() } };
  writeFileSync(file, JSON.stringify(header) + "\n" + JSON.stringify(entry) + "\n");
  const model = { provider: "mock", id: "extract", contextWindow: 200_000, maxTokens: 8_000 };
  let notified: (() => void) | undefined;
  const started = new Promise<void>((resolve) => { notified = resolve; });
  let calls = 0;
  const registry = {
    find: (provider: string, id: string) => provider === "mock" && id === "extract" ? model : undefined,
    streamSimple: () => { calls++;
      notified?.();
      return { result: async () => ({ stopReason: "stop", content: [{ type: "text",
        text: '{"raw_memory":"Use TypeScript","rollout_summary":"TypeScript chosen","rollout_slug":"typescript"}' }],
        usage: { input: 100, output: 20 } }) };
    },
  };
  const mock = makeMockPi(); memoryExtension(mock.pi);
  const ctx = { cwd, mode: "tui", hasUI: false, isIdle: () => true, model, modelRegistry: registry,
    sessionManager: { getBranch: () => [entry], getHeader: () => header,
      getSessionFile: () => file, getLeafId: () => "u1" } };
  await mock.fire("session_start", { type: "session_start" }, ctx);
  const dbFile = join(agentDir, "memory", "state.sqlite");
  if (existsSync(dbFile)) {
    const initial = new DatabaseSync(dbFile, { readOnly: true });
    const sourcesTable = initial.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'source_revisions'").get();
    if (sourcesTable) {
      assert.equal((initial.prepare("SELECT COUNT(*) AS n FROM source_revisions").get() as { n: number }).n, 0);
    }
    initial.close();
  }
  await mock.fire("before_agent_start", { type: "before_agent_start", systemPromptOptions: { sections: {} } }, ctx);
  const configPath = join(agentDir, "memory", "config.json");
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  writeFileSync(configPath, JSON.stringify({ ...config, schedule: { ...config.schedule, minIdleMinutes: 0 } }));
  await mock.fire("agent_settled", { type: "agent_settled" }, ctx);
  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([started, new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new Error("automatic extraction never started")), 2_000);
    })]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  const db = new DatabaseSync(dbFile, { readOnly: true });
  assert.equal((db.prepare("SELECT outcome FROM extractions").get() as { outcome: string }).outcome, "succeeded");
  db.close();
  await mock.fire("session_shutdown", { type: "session_shutdown" }, ctx);
});
