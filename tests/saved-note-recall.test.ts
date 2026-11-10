import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import extension from "../src/extension.ts";
import { defaultConfig } from "../src/config.ts";
import { openStateDb } from "../src/store/db.ts";
import { addNote, forgetNote } from "../src/control/notes.ts";
import { makeMockPi } from "./mock-pi.ts";
import { savedNotesReader } from "../src/read/notes.ts";

function fixture(t: test.TestContext) {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-saved-note-recall-"));
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
    rmSync(agentDir, { recursive: true, force: true });
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
