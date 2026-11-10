import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import extension from "../src/extension.ts";
import { defaultConfig } from "../src/config.ts";
import { openStateDb } from "../src/store/db.ts";
import { addNote, forgetNote } from "../src/control/notes.ts";
import { makeMockPi } from "./mock-pi.ts";
import { savedNotesReader } from "../src/read/notes.ts";
import { createMemoryTools } from "../src/read/tools.ts";

function fixture(t: test.TestContext, symlinkedParent = false) {
  const directory = mkdtempSync(join(tmpdir(), "pi-saved-note-recall-"));
  const agentDir = symlinkedParent ? join(directory, "agent-link") : directory;
  if (symlinkedParent) {
    const target = join(directory, "agent"); mkdirSync(target);
    symlinkSync(target, agentDir, "dir");
  }
  const root = join(agentDir, "memory"); mkdirSync(root);
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const config = { ...defaultConfig("UTC"), generate: false };
  const saveConfig = () => writeFileSync(join(root, "config.json"), JSON.stringify(config));
  saveConfig();
  const db = openStateDb(root);
  const mock = makeMockPi(); extension(mock.pi);
  const ctx = { cwd: agentDir, hasUI: false };
  t.after(() => {
    db.close();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(directory, { recursive: true, force: true });
  });
  const note = (text: string, action: "remember" | "correct" = "remember", scope = "global") => addNote({
    root, db, action, text, scope,
    provenance: { consumerSession: null, runId: null, userMessageId: null, origin: "command" },
  });
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const output = await mock.tools.get(`pi_memory_${name}`)!.execute("recall", args, undefined, undefined, ctx as never);
    return output.details as import("../src/read/tools.ts").MemoryToolDetails;
  };
  return { root, agentDir, db, config, saveConfig, note, call, mock };
}

test("saved notes list/search/read work without a foreground run or generated publication", async t => {
  const f = fixture(t);
  const note = f.note("Use code.alipay.com for antcode", "correct", "user tooling / antcode");
  const before = JSON.stringify(f.db.prepare("SELECT * FROM jobs").all());
  const list = await f.call("list");
  assert.equal(list.error, undefined);
  assert.equal(list.source, "saved_notes");
  assert.equal(list.items.length, 1);
  assert.equal(list.items[0]!.path, `notes/${note.noteId}.md`);
  assert.equal(list.items[0]!.action, "correct");
  assert.equal(list.items[0]!.scope, "user tooling / antcode");
  const found = await f.call("search", { queries: ["antcode"], match: "any" });
  assert.match(found.items[0]!.content!, /code\.alipay\.com/);
  const read = await f.call("read", { path: list.items[0]!.path });
  assert.equal(read.items[0]!.content, "Use code.alipay.com for antcode");
  assert.equal(JSON.stringify(f.db.prepare("SELECT * FROM jobs").all()), before);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM generations").get()!.n, 0);
});

test("saved notes list/search/read work beneath a symlinked agent directory", async t => {
  const f = fixture(t, true);
  const note = f.note("Recall through a symlinked ancestor");
  const path = `notes/${note.noteId}.md`;
  for (const [name, args] of [
    ["list", { path: "notes" }],
    ["search", { path: "notes", queries: ["symlinked ancestor"], match: "any" }],
    ["read", { path }],
  ] as const) {
    const result = await f.call(name, args);
    assert.equal(result.error, undefined, name);
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0]!.path, path);
    if (name !== "list") assert.equal(result.items[0]!.content, "Recall through a symlinked ancestor");
  }
});

for (const component of ["file", "directory"]) test(`saved notes reject a symlinked note ${component} beneath a symlinked agent directory`, async t => {
  const f = fixture(t, true); const note = f.note("Do not follow this note symlink");
  const source = component === "file" ? note.textPath : join(f.root, "notes");
  const target = `${source}-original`;
  renameSync(source, target);
  symlinkSync(target, source, component === "file" ? "file" : "dir");
  for (const [name, args] of [
    ["list", { path: "notes" }],
    ["search", { path: "notes", queries: ["symlink"], match: "any" }],
    ["read", { path: `notes/${note.noteId}.md` }],
  ] as const) {
    const result = await f.call(name, args);
    assert.ok(result.error, name);
    assert.deepEqual(result.items, []);
  }
});

test("confirmed unsupported hosts cannot read saved notes or open their store", async t => {
  const f = fixture(t); const note = f.note("Private saved preference");
  const notifications: string[] = [];
  await f.mock.fire("session_start", {}, { cwd: f.agentDir, mode: "tui", abort: undefined, hasUI: true,
    ui: { notify: (message: string) => notifications.push(message) }, isIdle: () => true,
    sessionManager: { getBranch: () => [], getHeader: () => null, getSessionFile: () => null },
    modelRegistry: { find: () => undefined, streamSimple: () => undefined } });
  assert.ok(notifications.some(message => message.startsWith("pi-memory disabled") && message.includes("ctx.abort")));
  const prepare = DatabaseSync.prototype.prepare;
  let storeQueries = 0;
  t.mock.method(DatabaseSync.prototype, "prepare", function(this: DatabaseSync, sql: string) {
    storeQueries++;
    return prepare.call(this, sql);
  });
  for (const [name, args] of [
    ["list", { path: "notes" }],
    ["search", { path: "notes", queries: ["Private"], match: "any" }],
    ["read", { path: `notes/${note.noteId}.md` }],
    ["list", {}],
    ["search", { queries: ["Private"], match: "any" }],
  ] as const) {
    const result = await f.call(name, args);
    assert.equal(result.error, "memory_unavailable");
    assert.equal(result.reason, "read_disabled");
    assert.deepEqual(result.items, []);
  }
  assert.equal(storeQueries, 0, "reject incompatible hosts before opening the notes database");
});

test("saved note recall keeps correction provenance and excludes forgotten notes immediately", async t => {
  const f = fixture(t);
  const old = f.note("Old preference");
  const correction = f.note("Replacement preference", "correct");
  const listed = await f.call("list", { path: "notes" });
  assert.equal(listed.items.length, 2);
  assert.equal(listed.items.find(item => item.noteId === correction.noteId)!.action, "correct");
  assert.ok(listed.items.find(item => item.noteId === correction.noteId)!.createdAt! >
    listed.items.find(item => item.noteId === old.noteId)!.createdAt!);
  forgetNote({ root: f.root, db: f.db, noteId: old.noteId });
  assert.equal((await f.call("list", { path: "notes" })).items.length, 1);
  assert.equal((await f.call("read", { path: `notes/${old.noteId}.md` })).items.length, 0);
  assert.match((await f.call("read", { path: `notes/${correction.noteId}.md` })).items[0]!.content!, /Replacement/);
});

test("saved notes preserve read-disable, workspace exclusions and path boundaries", async t => {
  const f = fixture(t); const note = f.note("Private preference");
  for (const path of ["../notes", `${f.root}/notes/${note.noteId}.md`, "notes/../../config.json"]) {
    assert.equal((await f.call("read", { path })).items.length, 0);
  }
  f.config.read = false; f.saveConfig();
  assert.equal((await f.call("list", { path: "notes" })).reason, "read_disabled");
  f.config.read = true; f.config.excludedWorkspaces = [f.agentDir]; f.saveConfig();
  assert.equal((await f.call("list", { path: "notes" })).reason, "read_disabled");
  f.config.excludedWorkspaces = []; f.saveConfig();
  f.mock.pi.getFlag = () => "off";
  assert.equal((await f.call("list")).reason, "read_disabled");
});

test("note pagination rejects a changed dataset and note integrity checks remain enforced", async t => {
  const f = fixture(t); const first = f.note("first"); f.note("second");
  const page = await f.call("list", { path: "notes", limit: 1 });
  assert.ok(page.cursor);
  f.note("third");
  assert.equal((await f.call("list", { path: "notes", cursor: page.cursor })).error, "invalid_cursor");
  writeFileSync(first.textPath, "tampered");
  assert.equal((await f.call("read", { path: `notes/${first.noteId}.md` })).error, "saved_note_integrity");
});

for (const count of [4, 8]) test(`saved-note reads validate the dataset twice per operation with ${count} notes`, async t => {
  const f = fixture(t);
  for (let index = 0; index < count; index++) f.note(`Preference ${index}`);
  const reader = savedNotesReader({ root: f.root, db: f.db, memoryVersion: "v1" });
  const prepare = f.db.prepare.bind(f.db);
  let datasetReads = 0;
  t.mock.method(f.db, "prepare", (sql: string) => {
    if (sql.includes("FROM notes")) datasetReads++;
    return prepare(sql);
  });
  const tools = createMemoryTools({ root: f.root, db: () => f.db, pin: () => reader, consumer: () => null });
  const path = `notes/${f.db.prepare("SELECT note_id FROM notes LIMIT 1").get()!.note_id}.md`;
  for (const [name, args] of [
    ["pi_memory_list", { path: "notes", limit: 1 }],
    ["pi_memory_search", { path: "notes", queries: ["Preference"], match: "any", maxResults: 1 }],
    ["pi_memory_read", { path }],
  ] as const) {
    datasetReads = 0;
    const result = await tools.find(tool => tool.name === name)!.execute("recall", args);
    assert.equal(result.details.error, undefined);
    assert.equal(result.details.items.length, 1);
    assert.equal(datasetReads, 2, `${name} must not rescan the dataset for every file`);
  }
});

test("saved-note operations reject additions before or during the operation without completing stale results", t => {
  const f = fixture(t); f.note("first");
  const stale = savedNotesReader({ root: f.root, db: f.db, memoryVersion: "v1" });
  f.note("second");
  assert.throws(() => stale.withEvidence({ root: f.root, db: () => f.db }, () => {
    assert.fail("a changed dataset must be rejected before the operation");
  }), /saved_notes_changed/);
  const reader = savedNotesReader({ root: f.root, db: f.db, memoryVersion: "v1" });
  assert.throws(() => reader.withEvidence({ root: f.root, db: () => f.db }, access => {
    const text = access.read(access.paths("notes")[0]!);
    f.note("third");
    return { complete: () => { assert.fail("a changed dataset must not complete"); return text; } };
  }), /saved_notes_changed/);
});

test("changing the environment cannot redirect an initialized extension to another memory root", async t => {
  const f = fixture(t); f.note("Keep the original memory root");
  process.env.PI_CODING_AGENT_DIR = join(f.agentDir, "unrelated-agent");
  try {
    const result = await f.call("list");
    assert.equal(result.error, undefined);
    assert.equal(result.items.length, 1);
  } finally { process.env.PI_CODING_AGENT_DIR = f.agentDir; }
});

test("revocation during a saved-note evidence operation cannot return the old text", t => {
  const f = fixture(t); const note = f.note("must not escape after forget");
  const reader = savedNotesReader({ root: f.root, db: f.db, memoryVersion: "v1" });
  assert.throws(() => reader.withEvidence({ root: f.root, db: () => f.db }, access => {
    const text = access.read(`notes/${note.noteId}.md`);
    forgetNote({ root: f.root, db: f.db, noteId: note.noteId });
    return { complete: () => text };
  }), /saved_notes_changed/);
});
