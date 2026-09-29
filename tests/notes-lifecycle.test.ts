import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import extension from "../src/extension.ts";
import { defaultConfig } from "../src/config.ts";
import { makeMockPi } from "./mock-pi.ts";

async function fixture(t: test.TestContext, mode: "tui" | "rpc" = "tui") {
  const root = mkdtempSync(join(tmpdir(), "pi-notes-lifecycle-")); const cwd = join(root, "repo"); mkdirSync(cwd);
  execFileSync("git", ["init", "-q"], { cwd });
  const agentDir = join(root, "agent"); const memoryRoot = join(agentDir, "memory"); mkdirSync(memoryRoot, { recursive: true });
  const previous = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(root, { recursive: true, force: true }); });
  writeFileSync(join(memoryRoot, "config.json"), JSON.stringify(defaultConfig("UTC")));
  const header = { type: "session", version: 3, id: "notes-session", cwd, timestamp: new Date().toISOString() };
  const entry = { type: "message", id: "u1", parentId: null, timestamp: new Date().toISOString(),
    message: { role: "user", content: [{ type: "text", text: "Remember: answer in Chinese" }], timestamp: Date.now() } };
  const file = join(root, "session.jsonl"); writeFileSync(file, `${JSON.stringify(header)}\n${JSON.stringify(entry)}\n`);
  const mock = makeMockPi(); let modeFlag: string | undefined;
  mock.pi.getFlag = () => modeFlag;
  extension(mock.pi); const notifications: string[] = [];
  const ctx = { cwd, mode, hasUI: true, isIdle: () => true, ui: { notify: (text: string) => notifications.push(text) },
    modelRegistry: { find: () => undefined, streamSimple: () => { throw new Error("no model configured"); } },
    sessionManager: { getBranch: () => [entry], getHeader: () => header, getSessionFile: () => file, getLeafId: () => entry.id } };
  await mock.fire("session_start", {}, ctx);
  t.after(async () => { await mock.fire("session_shutdown", {}, ctx); });
  const command = (text: string, hasUI = true) => mock.commands.get("memory")!.handler(text, { ...ctx, hasUI });
  const note = (args: Record<string, unknown>) => mock.tools.get("pi_memory_note")!.execute("note", args, undefined, undefined, ctx as never);
  return { root: memoryRoot, mock, ctx, command, note, notifications, setFlag: (value: string | undefined) => { modeFlag = value; } };
}
test("commands and the natural-language note tool persist notes with host run/message provenance and no delete capability", async (t) => {
  const { root, mock, ctx, command, note, notifications } = await fixture(t);
  await command("remember 中文偏好：简洁回答", false);
  await mock.fire("before_agent_start", { prompt: "Remember: answer in Chinese", systemPromptOptions: { sections: {} } }, ctx);
  const result = await note({ action: "correct", text: "Answer in Chinese", scope: "global" });
  assert.doesNotMatch(JSON.stringify(result), /invalid_note|memory_write_unavailable/);
  assert.equal(JSON.stringify(result).includes(root), false, "model results never expose internal note paths");
  const db = new DatabaseSync(join(root, "state.sqlite")); t.after(() => db.close());
  const notes = db.prepare("SELECT * FROM notes ORDER BY created_at, note_id").all(); assert.equal(notes.length, 2);
  const toolNote = notes.find(note => note.origin === "tool")!;
  assert.ok(toolNote.run_id); assert.ok(toolNote.consumer_session); assert.equal(toolNote.user_message_id, "u1");
  assert.equal(notes.find(note => note.origin === "command")!.scope, `workspace:${ctx.cwd}`);
  for (const row of db.prepare("SELECT read_blocked FROM pipeline_state").all()) assert.equal(row.read_blocked, 1);
  const rejected = await note({ action: "delete", text: "delete memory", scope: "global" });
  assert.match(JSON.stringify(rejected), /invalid_note/); assert.equal(db.prepare("SELECT COUNT(*) AS n FROM notes").get()!.n, 2);
  await command(`forget note ${toolNote.note_id}`);
  assert.ok(notifications.some(text => /older independently supported/.test(text)));
  assert.equal(readFileSync(join(root, "config.json"), "utf8").includes('"version":"v1"'), true);
});

test("explicit RPC notes schedule both consolidators without capturing or extracting the RPC transcript", async (t) => {
  const { root, command, mock, ctx, notifications } = await fixture(t, "rpc");
  const configPath = join(root, "config.json");
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  assert.deepEqual(config.captureModes, ["tui"]);
  writeFileSync(configPath, JSON.stringify({ ...config, dualWrite: true }));
  await command("correct Answer in Chinese", false);
  await mock.fire("agent_settled", {}, ctx);
  const db = new DatabaseSync(join(root, "state.sqlite")); t.after(() => db.close());
  await t.waitFor(() => assert.equal(db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE kind = 'consolidate' AND status = 'blocked'").get()!.n, 2),
    { timeout: 5000 });
  assert.deepEqual(db.prepare("SELECT memory_version, error_code FROM jobs WHERE kind = 'consolidate' ORDER BY memory_version").all()
    .map(row => ({ ...row })), [{ memory_version: "v1", error_code: "model_not_configured" },
      { memory_version: "v2", error_code: "model_not_configured" }]);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE kind = 'extract'").get()!.n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM source_revisions").get()!.n, 0);
  for (const row of db.prepare("SELECT read_blocked FROM pipeline_state").all()) assert.equal(row.read_blocked, 1);
  const noteId = db.prepare("SELECT note_id FROM notes WHERE status = 'active'").get()!.note_id;
  assert.ok(typeof noteId === "string");
  await command(`forget note ${noteId}`);
  assert.equal(db.prepare("SELECT status FROM notes WHERE note_id = ?").get(noteId)!.status, "superseded", notifications.join("\n"));
  await t.waitFor(() => assert.equal(db.prepare("SELECT COUNT(*) AS n FROM pipeline_state WHERE read_blocked = 1").get()!.n, 0,
    JSON.stringify(db.prepare("SELECT memory_version, status, error_code FROM jobs").all())),
    { timeout: 5000 });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM generations WHERE status = 'published'").get()!.n, 2);
});

test("explicit notes obey disabled, excluded and read-only policies and cannot forge host provenance", async (t) => {
  const { root, mock, ctx, note, command, setFlag } = await fixture(t);
  await mock.fire("before_agent_start", { prompt: "Remember: answer in Chinese", systemPromptOptions: { sections: {} } }, ctx);
  setFlag("read"); assert.match(JSON.stringify(await note({ action: "remember", text: "blocked", scope: "global" })), /memory_write_unavailable/);
  setFlag(undefined);
  const configPath = join(root, "config.json"); const config = JSON.parse(readFileSync(configPath, "utf8"));
  writeFileSync(configPath, JSON.stringify({ ...config, excludedWorkspaces: [ctx.cwd] }));
  await command("remember blocked");
  assert.match(JSON.stringify(await note({ action: "remember", text: "blocked", scope: "global" })), /memory_write_unavailable/);
  writeFileSync(configPath, JSON.stringify({ ...config, enabled: false }));
  assert.match(JSON.stringify(await note({ action: "remember", text: "blocked", scope: "global" })), /memory_write_unavailable/);
  writeFileSync(configPath, JSON.stringify(config));
  const accepted = await note({ action: "remember", text: "User preference", scope: "global", runId: "forged", userMessageId: "forged" });
  assert.doesNotMatch(JSON.stringify(accepted), /memory_write_unavailable/);
  const db = new DatabaseSync(join(root, "state.sqlite")); t.after(() => db.close());
  const rows = db.prepare("SELECT run_id, user_message_id FROM notes").all(); assert.equal(rows.length, 1);
  assert.notEqual(rows[0]!.run_id, "forged"); assert.equal(rows[0]!.user_message_id, "u1");
});
