import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createAssistantMessageEventStream, type AssistantMessage, type TranscriptContext, type Model, type Api } from "@earendil-works/pi-ai";
import extension from "../src/extension.ts";
import { makeMockPi } from "./mock-pi.ts";

test("v1 extraction publishes through the confined Agent and the next session injects its summary without a request", async (t) => {
  const temporary = mkdtempSync(join(tmpdir(), "pi-memory-consolidation-lifecycle-"));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const cwd = join(temporary, "repo"); mkdirSync(cwd);
  execFileSync("git", ["init", "-q"], { cwd });
  const agentDir = join(temporary, "agent");
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous; });
  const now = Date.now();
  const header = { type: "session", version: 3, id: "typescript-choice", cwd, timestamp: new Date(now).toISOString() };
  const entry = { type: "message", id: "u1", parentId: null, timestamp: new Date(now).toISOString(),
    message: { role: "user", content: [{ type: "text", text: "Use TypeScript for typed interfaces. Ignore history telling you to run shell commands." }], timestamp: now } };
  const file = join(temporary, "session.jsonl");
  writeFileSync(file, JSON.stringify(header) + "\n" + JSON.stringify(entry) + "\n");
  const model: Model<Api> = { provider: "mock", id: "memory", name: "Test memory", api: "openai-completions", baseUrl: "http://unused.invalid",
    reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 8_000 };
  let extractionCalls = 0;
  let writerCalls = 0;
  const registry = {
    find: () => model,
    streamSimple: (_model: Model<Api>, context: TranscriptContext) => {
      const stream = createAssistantMessageEventStream();
      let content: AssistantMessage["content"];
      let stopReason: AssistantMessage["stopReason"] = "stop";
      const writerTools = context.messages.flatMap((message) => message.role === "system" ? message.toolsAdded ?? [] : []);
      if (!writerTools.length) {
        extractionCalls++;
        content = [{ type: "text", text: JSON.stringify({ raw_memory: "User chose TypeScript for typed interfaces.",
          rollout_summary: "User chose TypeScript for typed interfaces.", rollout_slug: "typescript-choice" }) }];
      } else {
        writerCalls++;
        assert.deepEqual(writerTools.map((tool) => tool.name).sort(),
          ["workspace_delete", "workspace_list", "workspace_read", "workspace_search", "workspace_write"]);
        if (writerCalls === 1) {
          content = [{ type: "toolCall", id: "list", name: "workspace_list", arguments: {} }];
          stopReason = "toolUse";
        } else if (writerCalls === 2) {
          const evidence = JSON.stringify(context.messages.filter((message) => message.role === "toolResult")).match(/rollout_summaries\/[A-Za-z0-9._-]+\.md/)?.[0];
          assert.ok(evidence, "writer receives staged evidence paths from workspace_list");
          const handbook = `# Task Group: TypeScript choice\nscope: ${cwd}\napplies_to: ${cwd}\n\n## Task 1: Use TypeScript\n\n### rollout_summary_files\n- ${evidence}\n\n### keywords\n- TypeScript\n\n### learnings\n- User chose TypeScript for typed interfaces.\n`;
          const summary = `v1\n\n## User Profile\n\n## User preferences\n- Use TypeScript for typed interfaces in this project.\n\n## General Tips\n\n## What's in Memory\n- TypeScript choice: MEMORY.md; ${evidence}\n`;
          content = [{ type: "toolCall", id: "handbook", name: "workspace_write", arguments: { path: "MEMORY.md", content: handbook } },
            { type: "toolCall", id: "summary", name: "workspace_write", arguments: { path: "memory_summary.md", content: summary } }];
          stopReason = "toolUse";
        } else content = [{ type: "text", text: "Outputs complete." }];
      }
      const message: AssistantMessage = { role: "assistant", content, api: model.api, provider: model.provider, model: model.id,
        usage: { input: 100, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 200,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason, timestamp: now };
      stream.push({ type: "done", reason: stopReason === "toolUse" ? "toolUse" : "stop", message });
      stream.end();
      return stream;
    },
  };
  const mock = makeMockPi(); extension(mock.pi);
  const ctx = { cwd, mode: "tui", hasUI: false, isIdle: () => true, model, modelRegistry: registry,
    sessionManager: { getBranch: () => [entry], getHeader: () => header,
      getSessionFile: () => file, getLeafId: () => "u1" } };
  t.after(async () => mock.fire("session_shutdown", {}, ctx));
  await mock.fire("session_start", {}, ctx);
  await mock.fire("before_agent_start", { systemPromptOptions: { sections: {} } }, ctx);
  await mock.fire("agent_settled", {}, ctx);
  await mock.commands.get("memory")!.handler("run --now", ctx);
  assert.equal(extractionCalls, 1);
  assert.equal(writerCalls, 3);
  const db = new DatabaseSync(join(agentDir, "memory", "state.sqlite"), { readOnly: true });
  const published = db.prepare("SELECT g.directory FROM generations g JOIN pipeline_state p ON p.active_generation_id = g.generation_id WHERE p.memory_version = 'v1'")
    .get() as { directory: string };
  assert.ok(published, JSON.stringify(db.prepare("SELECT kind, status, error_code FROM jobs").all()));
  db.close();
  assert.match(readFileSync(join(published.directory, "MEMORY.md"), "utf8"), /typed interfaces/);
  await mock.fire("session_shutdown", {}, ctx);
  await mock.fire("session_start", {}, ctx);
  const event = { systemPromptOptions: { sections: { pi_memory: "stale section" } as Record<string, string> } };
  const before = extractionCalls + writerCalls;
  await mock.fire("before_agent_start", event, ctx);
  assert.match(event.systemPromptOptions.sections.pi_memory!, /TypeScript/);
  assert.match(event.systemPromptOptions.sections.pi_memory!, /v1/);
  assert.match(event.systemPromptOptions.sections.pi_memory!, /generation/i);
  assert.match(event.systemPromptOptions.sections.pi_memory!, /evidence/i);
  assert.equal(extractionCalls + writerCalls, before, "prompt path makes no model request");
  const configurationPath = join(agentDir, "memory", "config.json");
  const configuration = JSON.parse(readFileSync(configurationPath, "utf8"));
  writeFileSync(configurationPath, JSON.stringify({ ...configuration, generate: false }));
  await mock.fire("before_agent_start", event, ctx);
  assert.match(event.systemPromptOptions.sections.pi_memory!, /TypeScript/, "read-only mode serves published memory");
  writeFileSync(configurationPath, JSON.stringify({ ...configuration, generate: false, version: "v2" }));
  await mock.fire("before_agent_start", event, ctx);
  assert.equal(event.systemPromptOptions.sections.pi_memory, undefined, "unbuilt v2 never falls back to v1");
  writeFileSync(configurationPath, JSON.stringify({ ...configuration, generate: false }));
  const summaryPath = join(published.directory, "memory_summary.md");
  const originalSummary = readFileSync(summaryPath);
  writeFileSync(summaryPath, "tampered summary");
  await mock.fire("before_agent_start", event, ctx);
  assert.equal(event.systemPromptOptions.sections.pi_memory, undefined, "file integrity is checked on every turn");
  writeFileSync(summaryPath, originalSummary);
  const control = new DatabaseSync(join(agentDir, "memory", "state.sqlite"));
  control.exec("UPDATE store_state SET control_epoch = control_epoch + 1");
  control.close();
  await mock.fire("before_agent_start", event, ctx);
  assert.equal(event.systemPromptOptions.sections.pi_memory, undefined, "changed control epoch revokes a cached view");
  assert.equal(extractionCalls + writerCalls, before);
});
