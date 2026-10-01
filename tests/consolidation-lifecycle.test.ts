import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createAssistantMessageEventStream, type AssistantMessage, type TranscriptContext, type Model, type Api } from "@earendil-works/pi-ai";
import extension from "../src/extension.ts";
import { makeMockPi, projectRequest } from "./mock-pi.ts";
import { defaultConfig } from "../src/config.ts";

for (const memoryVersion of ["v1", "v2"] as const) {
test(`${memoryVersion === "v2" ? "T27 v2: " : ""}${memoryVersion} extraction publishes through the confined Agent and the next session injects its summary without a request`, async (t) => {
  const temporary = mkdtempSync(join(tmpdir(), "pi-memory-consolidation-lifecycle-"));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const cwd = join(temporary, "repo"); mkdirSync(cwd);
  execFileSync("git", ["init", "-q"], { cwd });
  const agentDir = join(temporary, "agent");
  mkdirSync(join(agentDir, "memory"), { recursive: true });
  writeFileSync(join(agentDir, "memory", "config.json"), JSON.stringify({ ...defaultConfig("UTC"), version: memoryVersion }));
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
        content = [{ type: "text", text: JSON.stringify({ ...(memoryVersion === "v1" ? { raw_memory: "User chose TypeScript for typed interfaces." } : {}),
          rollout_summary: "User chose TypeScript for typed interfaces.", rollout_slug: "typescript-choice" }) }];
      } else {
        writerCalls++;
        assert.deepEqual(writerTools.map((tool) => tool.name).sort(), memoryVersion === "v1" ?
          ["workspace_delete", "workspace_list", "workspace_read", "workspace_search", "workspace_write"] :
          ["workspace_list", "workspace_read", "workspace_search", "workspace_write"]);
        if (writerCalls === 1) {
          content = [{ type: "toolCall", id: "list", name: "workspace_list", arguments: {} }];
          stopReason = "toolUse";
        } else if (writerCalls === 2) {
          const evidence = JSON.stringify(context.messages.filter((message) => message.role === "toolResult")).match(/rollout_summaries\/[A-Za-z0-9._-]+\.md/)?.[0];
          assert.ok(evidence, "writer receives staged evidence paths from workspace_list");
          const handbook = `# Task Group: TypeScript choice\nscope: ${cwd}\napplies_to: ${cwd}\n\n## Task 1: Use TypeScript\n\n### rollout_summary_files\n- ${evidence}\n\n### keywords\n- TypeScript\n\n### learnings\n- User chose TypeScript for typed interfaces.\n`;
          const summary = memoryVersion === "v1" ?
            `v1\n\n## User Profile\n\n## User preferences\n- Use TypeScript for typed interfaces in this project.\n\n## General Tips\n\n## What's in Memory\n### ${cwd}\n#### ${new Date(now).toISOString().slice(0, 10)}\n- TypeScript choice: MEMORY.md; ${evidence}\n` :
            `v1\n\n## User Profile\n\n## User preferences\n\n## General Tips\n\n## What's in Memory\n\n### ${cwd}\n\n#### ${new Date(now).toISOString().slice(0, 10)}\n\n- ${evidence} — User chose TypeScript for typed interfaces; read for the decision's scope and exact wording.\n`;
          content = [...(memoryVersion === "v1" ? [{ type: "toolCall" as const, id: "handbook", name: "workspace_write", arguments: { path: "MEMORY.md", content: handbook } }] : []),
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
  const published = db.prepare("SELECT g.directory FROM generations g JOIN pipeline_state p ON p.active_generation_id = g.generation_id WHERE p.memory_version = ?")
    .get(memoryVersion) as { directory: string };
  assert.ok(published, JSON.stringify(db.prepare("SELECT kind, status, error_code FROM jobs").all()));
  db.close();
  if (memoryVersion === "v1") assert.match(readFileSync(join(published.directory, "MEMORY.md"), "utf8"), /typed interfaces/);
  else {
    assert.equal(existsSync(join(published.directory, "MEMORY.md")), false);
    assert.equal(existsSync(join(published.directory, "raw_memories.md")), false);
    assert.equal(existsSync(join(published.directory, "skills")), false);
  }
  await mock.fire("session_shutdown", {}, ctx);
  await mock.fire("session_start", {}, ctx);
  const event = { systemPromptOptions: { sections: { pi_memory: "stale section" } as Record<string, string> } };
  const before = extractionCalls + writerCalls;
  await mock.fire("before_agent_start", event, ctx);
  assert.equal(event.systemPromptOptions.sections.pi_memory, undefined, "legacy section removed; preparation only pins memory");
  const project = async () => {
    assert.equal(event.systemPromptOptions.sections.pi_memory, undefined, "canonical options contain no memory section");
    return (await projectRequest(mock, ctx)).memory;
  };
  const memory = await project();
  assert.match(memory ?? "", /TypeScript/);
  assert.match(memory ?? "", new RegExp(`Memory version: ${memoryVersion}`));
  if (memoryVersion === "v2") assert.doesNotMatch(memory ?? "", /MEMORY\.md/);
  assert.match(memory ?? "", /generation/i);
  assert.match(memory ?? "", /evidence/i);
  assert.equal(extractionCalls + writerCalls, before, "prompt path makes no model request");
  assert.deepEqual([...mock.tools.keys()].sort(), ["pi_memory_list", "pi_memory_note", "pi_memory_read", "pi_memory_search"]);
  const search = await mock.tools.get("pi_memory_search")!.execute("search", { queries: ["TypeScript"], match: "any" }, undefined, undefined, ctx as never);
  const evidencePath = (search.details as { items: { path: string }[] }).items.find(item => item.path.startsWith("rollout_summaries/"))!.path;
  const read = () => mock.tools.get("pi_memory_read")!.execute("read", { path: evidencePath }, undefined, undefined, ctx as never);
  assert.match(JSON.stringify(await read()), /TypeScript/);
  assert.match(JSON.stringify(await read()), /TypeScript/);
  const usage = new DatabaseSync(join(agentDir, "memory", "state.sqlite"));
  assert.equal(usage.prepare("SELECT COUNT(*) AS n FROM memory_usage").get()!.n, 1, "detail use is deduplicated within one foreground run");
  // Remaining capacity uses actual non-memory input and model output reserve,
  // not previous request usage. Budget-only omission retains the same tool pin.
  const limited = { ...ctx, model: { ...model, contextWindow: 32_768 },
    getContextUsage: () => ({ tokens: 0, contextWindow: 32_768, percent: 0 }) };
  const fullContext = await projectRequest(mock, limited, [
    { role: "system", content: "Foreground policy", timestamp: 0 },
    { role: "user", content: "x".repeat(25_000), timestamp: 1 },
  ]);
  assert.equal(fullContext.memory, undefined, "non-memory history plus output reserve exhausts capacity");
  assert.equal((await projectRequest(mock, { ...ctx, model: { ...model, maxTokens: model.contextWindow } })).memory,
    undefined, "output reservation alone can exhaust capacity");
  assert.equal((await projectRequest(mock, { ...ctx, model: { contextWindow: model.contextWindow } })).memory,
    undefined, "missing reliable output reserve never authorizes a carrier");
  assert.match(JSON.stringify(await read()), /TypeScript/, "budget omission does not invalidate the generation or detail tools");
  assert.match((await project()) ?? "", /TypeScript/, "same-run injection recovers when capacity is available");
  // Hold the retention clock while preparing/reading so slow CI cannot expire
  // the source between those operations. The original deadline is then passed.
  let retentionNow = Date.now();
  const retentionClock = t.mock.method(Date, "now", () => retentionNow);
  usage.exec("UPDATE source_stats SET last_used_at = NULL");
  usage.prepare("UPDATE source_revisions SET source_time = ?").run(retentionNow - 30 * 86_400_000 + 150);
  await mock.fire("before_agent_start", event, ctx);
  assert.match(JSON.stringify(await read()), /TypeScript/, "detail use extends retention");
  retentionNow += 200;
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.match(JSON.stringify(await read()), /TypeScript/, "old retention timer must respect successful detail use");
  retentionClock.mock.restore();
  usage.close();
  const configurationPath = join(agentDir, "memory", "config.json");
  const configuration = JSON.parse(readFileSync(configurationPath, "utf8"));
  writeFileSync(configurationPath, JSON.stringify({ ...configuration, generate: false }));
  await mock.fire("before_agent_start", event, ctx);
  assert.match((await project()) ?? "", /TypeScript/, "read-only mode serves published memory");
  const unbuiltVersion = memoryVersion === "v1" ? "v2" : "v1";
  writeFileSync(configurationPath, JSON.stringify({ ...configuration, generate: false, version: unbuiltVersion }));
  await mock.fire("before_agent_start", event, ctx);
  assert.equal(await project(), undefined, "unbuilt selected version never falls back to the other");
  assert.match(JSON.stringify(await read()), /memory_unavailable/);
  writeFileSync(configurationPath, JSON.stringify({ ...configuration, generate: false }));
  const summaryPath = join(published.directory, "memory_summary.md");
  const originalSummary = readFileSync(summaryPath);
  writeFileSync(summaryPath, "tampered summary");
  await mock.fire("before_agent_start", event, ctx);
  assert.equal(await project(), undefined, "file integrity is checked on every turn");
  writeFileSync(summaryPath, originalSummary);
  await mock.fire("before_agent_start", event, ctx);
  assert.match(JSON.stringify(await read()), /TypeScript/);
  const correction = await mock.tools.get("pi_memory_note")!.execute("correct",
    { action: "correct", text: "Answer in Chinese", scope: "global" }, undefined, undefined, ctx as never);
  assert.doesNotMatch(JSON.stringify(correction), /memory_write_unavailable/);
  assert.match(JSON.stringify(await read()), /memory_unavailable/, "note correction revokes the current run's detail pin");
  const control = new DatabaseSync(join(agentDir, "memory", "state.sqlite"));
  assert.deepEqual(control.prepare("SELECT read_blocked FROM pipeline_state ORDER BY memory_version").all().map(row => row.read_blocked), [1, 1]);
  control.exec("UPDATE store_state SET control_epoch = control_epoch + 1");
  control.close();
  assert.match(JSON.stringify(await read()), /memory_unavailable/, "correction by another process revokes the existing run pin");
  await mock.fire("before_agent_start", event, ctx);
  assert.equal(await project(), undefined, "changed control epoch revokes a cached view");
  assert.equal(extractionCalls + writerCalls, before);
});
}
