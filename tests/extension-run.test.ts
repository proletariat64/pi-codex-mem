import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import memoryExtension from "../src/extension.ts";
import { makeMockPi } from "./mock-pi.ts";

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
    sessionManager: { getBranch: () => [entry], getHeader: () => header, getSessionFile: () => file, getLeafId: () => "u1" },
    ui: { notify: (message: string) => notifications.push(message) },
  };
  await mock.fire("session_start", { type: "session_start" }, ctx);
  await mock.fire("before_agent_start", { type: "before_agent_start", systemPromptOptions: { sections: {} } }, ctx);
  await mock.fire("agent_settled", { type: "agent_settled" }, ctx);

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
  await mock.fire("session_shutdown", { type: "session_shutdown" }, ctx);
});
