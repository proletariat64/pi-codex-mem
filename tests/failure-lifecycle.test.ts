import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import extension from "../src/extension.ts";
import { defaultConfig, type MemoryVersion } from "../src/config.ts";
import { openStateDb } from "../src/store/db.ts";
import { ConsolidationScheduler } from "../src/pipeline/scheduler.ts";
import { addNote } from "../src/control/notes.ts";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { makeMockPi } from "./mock-pi.ts";

function fixture(t: test.TestContext, version: MemoryVersion, options: { ephemeral?: boolean; flag?: string; configured?: boolean } = {}) {
  const base = fs.mkdtempSync(join(tmpdir(), "pi-failure-lifecycle-")); const cwd = join(base, "repo"); fs.mkdirSync(cwd);
  execFileSync("git", ["init", "-q"], { cwd });
  const agentDir = join(base, "agent"); const root = join(agentDir, "memory");
  const previous = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = agentDir;
  const config = { ...defaultConfig("UTC"), version };
  if (options.configured !== false) { fs.mkdirSync(root, { recursive: true }); fs.writeFileSync(join(root, "config.json"), JSON.stringify(config)); }
  const header = { type: "session", version: 3, id: "failure-source", cwd, timestamp: new Date().toISOString() };
  const entry = { type: "message", id: "u1", parentId: null as string | null, timestamp: new Date().toISOString(),
    message: { role: "user", content: [{ type: "text", text: "Use TypeScript for typed interfaces" }], timestamp: Date.now() } };
  const branch = [entry]; const file = join(base, "session.jsonl");
  const writeSession = () => fs.writeFileSync(file, [header, ...branch].map(value => JSON.stringify(value)).join("\n") + "\n"); writeSession();
  const model = { provider: "mock", id: "memory", contextWindow: 200_000, maxTokens: 8_000 };
  let requests = 0; const notices: string[] = []; const mock = makeMockPi();
  mock.pi.getFlag = () => options.flag; extension(mock.pi);
  const ctx = { cwd, mode: "tui", hasUI: true, isIdle: () => true, model,
    modelRegistry: { find: () => model, streamSimple: () => { requests++; throw new Error("unexpected provider request"); } },
    sessionManager: { getBranch: () => branch, getHeader: () => options.ephemeral ? null : header,
      getSessionFile: () => options.ephemeral ? undefined : file, getLeafId: () => options.ephemeral ? null : branch.at(-1)!.id },
    ui: { notify: (text: string) => notices.push(text) } };
  t.after(async () => {
    try { await mock.fire("session_shutdown", {}, ctx); }
    finally { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
      fs.rmSync(base, { recursive: true, force: true }); }
  });
  return { root, file, config, branch, writeSession, ctx, mock, notices, requests: () => requests,
    command: (args: string) => mock.commands.get("memory")!.handler(args, ctx) };
}

for (const version of ["v1", "v2"] as const) {
  for (const order of ["before", "after"]) test(`${order === "before" ? `T21 ${version}: ` : ""}${version}: full system prompt override ${order} memory injection is diagnosed without overriding it`, async t => {
    const f = fixture(t, version); f.config.generate = false;
    fs.writeFileSync(join(f.root, "config.json"), JSON.stringify(f.config));
    const db = openStateDb(f.root);
    const writer = new ConsolidationScheduler({ root: f.root, db, config: () => f.config, modelPort: () => null,
      now: Date.now, isForegroundIdle: () => true });
    await writer.runPass(); await writer.stop(); db.close();
    await f.mock.fire("session_start", {}, f.ctx);
    const options = { sections: { other_extension: "keep" } as Record<string, string>, forceSystemPrompt: order === "before" ? "opaque replacement" : undefined };
    await f.mock.fire("before_agent_start", { systemPromptOptions: options }, f.ctx);
    options.forceSystemPrompt = "opaque replacement";
    await f.mock.fire("agent_start", {}, f.ctx);
    await f.command("doctor");
    assert.match(f.notices.at(-1) ?? "", /section_injection_conflict/);
    assert.equal(options.forceSystemPrompt, "opaque replacement"); assert.equal(options.sections.other_extension, "keep");
    assert.equal(options.sections.pi_memory, undefined);
    const result = await f.mock.tools.get("pi_memory_list")!.execute("list", {}, undefined, undefined, f.ctx as never);
    assert.match(JSON.stringify(result), /memory_unavailable/); assert.equal(f.requests(), 0);
  });

  for (const configured of [false, true]) test(`${configured ? `T22 ${version}: ` : ""}${version}: an ephemeral lifecycle with configured=${configured} makes no memory artifacts or model requests`, async t => {
    const f = fixture(t, version, { ephemeral: true, configured });
    if (configured) {
      f.config.models.extract = { provider: "mock", modelId: "memory" };
      fs.writeFileSync(join(f.root, "config.json"), JSON.stringify(f.config));
    }
    await f.mock.fire("session_start", {}, f.ctx);
    await f.mock.fire("before_agent_start", { systemPromptOptions: { sections: {} } }, f.ctx);
    await f.mock.fire("agent_settled", {}, f.ctx); await f.command("status");
    assert.match(f.notices.at(-1) ?? "", /capture: ephemeral/);
    await f.command("run --now --version both");
    await f.mock.fire("session_shutdown", {}, f.ctx);
    assert.equal(fs.existsSync(join(f.root, "state.sqlite")), false);
    assert.equal(fs.existsSync(f.root), configured); assert.equal(f.requests(), 0);
  });

  for (const flag of ["off", "read"]) test(`${version}: ${flag} mode never captures or generates`, async t => {
    const f = fixture(t, version, { flag }); const original = fs.readFileSync(f.file);
    await f.mock.fire("session_start", {}, f.ctx);
    await f.mock.fire("before_agent_start", { systemPromptOptions: { sections: {} } }, f.ctx);
    await f.mock.fire("agent_start", {}, f.ctx); await f.mock.fire("agent_end", {}, f.ctx);
    await f.mock.fire("agent_settled", {}, f.ctx); await f.command("run --now --version both");
    await f.mock.fire("session_shutdown", {}, f.ctx);
    assert.equal(fs.existsSync(join(f.root, "state.sqlite")), false); assert.equal(f.requests(), 0);
    assert.deepEqual(fs.readFileSync(f.file), original);
  });

  test(`T11 ${version}: provider retry after agent_end captures only the final settled branch`, async t => {
    const f = fixture(t, version);
    await f.mock.fire("session_start", {}, f.ctx);
    await f.mock.fire("before_agent_start", { systemPromptOptions: { sections: {} } }, f.ctx);
    await f.mock.fire("agent_start", {}, f.ctx); await f.mock.fire("agent_end", {}, f.ctx);
    assert.equal(fs.existsSync(join(f.root, "sources")), false);
    f.branch.push({ ...f.branch[0]!, id: "u2", parentId: "u1", message: { ...f.branch[0]!.message,
      content: [{ type: "text", text: "Final retry decision: keep TypeScript" }] } }); f.writeSession();
    await f.mock.fire("agent_start", {}, f.ctx); await f.mock.fire("agent_end", {}, f.ctx);
    assert.equal(fs.existsSync(join(f.root, "sources")), false); assert.equal(f.requests(), 0);
    await f.mock.fire("agent_settled", {}, f.ctx);
    const db = new DatabaseSync(join(f.root, "state.sqlite"), { readOnly: true });
    const rows = db.prepare("SELECT snapshot_path FROM source_revisions").all(); assert.equal(rows.length, 1);
    const snapshot = JSON.parse(fs.readFileSync(String(rows[0]!.snapshot_path), "utf8")); db.close();
    assert.deepEqual(snapshot.items.map((item: { entryId: string }) => item.entryId), ["u1", "u2"]);
  });

  test(`${version}: a corrupt memory database preserves bytes and never interrupts foreground events`, async t => {
    const f = fixture(t, version); const bytes = Buffer.from("corrupt memory database; preserve this evidence");
    fs.writeFileSync(join(f.root, "state.sqlite"), bytes);
    await assert.doesNotReject(f.mock.fire("session_start", {}, f.ctx));
    await assert.doesNotReject(f.mock.fire("before_agent_start", { systemPromptOptions: { sections: {} } }, f.ctx));
    await assert.doesNotReject(f.mock.fire("agent_settled", {}, f.ctx));
    await f.command("doctor"); assert.match(f.notices.at(-1) ?? "", /unavailable or corrupt; file preserved/);
    assert.deepEqual(fs.readFileSync(join(f.root, "state.sqlite")), bytes); assert.equal(f.requests(), 0);
  });

  test(`${version}: a writer lock beyond timeout skips capture with a diagnostic and remains recoverable`, async t => {
    const f = fixture(t, version);
    await f.mock.fire("session_start", {}, f.ctx); await f.mock.fire("agent_settled", {}, f.ctx);
    const blocker = new DatabaseSync(join(f.root, "state.sqlite")); blocker.exec("BEGIN IMMEDIATE");
    try { await assert.doesNotReject(f.mock.fire("session_before_compact", {}, f.ctx));
      assert.match(f.notices.at(-1) ?? "", /capture failed:.*locked/); }
    finally { blocker.exec("ROLLBACK"); blocker.close(); }
    await f.mock.fire("agent_settled", {}, f.ctx); assert.equal(f.requests(), 0);
    const shutdownBlocker = new DatabaseSync(join(f.root, "state.sqlite")); shutdownBlocker.exec("BEGIN IMMEDIATE");
    try { await assert.doesNotReject(f.mock.fire("session_shutdown", {}, f.ctx)); }
    finally { shutdownBlocker.exec("ROLLBACK"); shutdownBlocker.close(); }
    await f.mock.fire("session_start", {}, f.ctx);
    const reloadBlocker = new DatabaseSync(join(f.root, "state.sqlite")); reloadBlocker.exec("BEGIN IMMEDIATE");
    try { await assert.doesNotReject(f.mock.fire("session_start", {}, f.ctx));
      assert.ok(f.notices.some(message => /previous session cleanup skipped:.*locked/.test(message))); }
    finally { reloadBlocker.exec("ROLLBACK"); reloadBlocker.close(); }
  });

  for (const event of ["session_shutdown", "session_start"]) test(`${version}: ${event} aborts an active writer under a database lock without rejecting Pi`, { timeout: 15_000 }, async t => {
    const f = fixture(t, version);
    f.config.models.extract = { provider: "mock", modelId: "memory" };
    f.config.models.consolidate = f.config.models.extract;
    fs.writeFileSync(join(f.root, "config.json"), JSON.stringify(f.config));
    const db = openStateDb(f.root);
    addNote({ root: f.root, db, action: "remember", text: "Use TypeScript", scope: "global",
      provenance: { consumerSession: null, runId: null, userMessageId: null, origin: "command" } }); db.close();
    let started!: () => void;
    const pending = new Promise<void>(resolve => { started = resolve; });
    f.ctx.modelRegistry.streamSimple = () => { started(); return createAssistantMessageEventStream() as never; };
    await f.mock.fire("session_start", {}, f.ctx);
    const keepAlive = setTimeout(() => {}, 10_000);
    try { await pending; } finally { clearTimeout(keepAlive); }
    const blocker = new DatabaseSync(join(f.root, "state.sqlite")); blocker.exec("BEGIN IMMEDIATE");
    try {
      await assert.doesNotReject(f.mock.fire(event, {}, f.ctx));
      assert.ok(f.notices.some(message => /cleanup skipped:.*locked/.test(message)));
    } finally { blocker.exec("ROLLBACK"); blocker.close(); }
    await assert.doesNotReject(f.mock.fire("session_shutdown", {}, f.ctx));
    const reopened = openStateDb(f.root);
    try { reopened.exec("BEGIN IMMEDIATE; ROLLBACK"); } finally { reopened.close(); }
  });

  test(`${version}: disk-full configuration writes preserve published reading and do not reject Pi or commands`, async t => {
    const f = fixture(t, version); const db = openStateDb(f.root);
    const writer = new ConsolidationScheduler({ root: f.root, db, config: () => f.config, modelPort: () => null,
      now: Date.now, isForegroundIdle: () => true });
    await writer.runPass(); await writer.stop(); db.close();
    await f.mock.fire("session_start", {}, f.ctx); const original = fs.readFileSync(join(f.root, "config.json"));
    const write = fs.writeFileSync;
    fs.writeFileSync = ((path: fs.PathOrFileDescriptor, ...args: unknown[]) => {
      if (String(path).includes("config.json.tmp-")) throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
      return Reflect.apply(write, fs, [path, ...args]);
    }) as typeof fs.writeFileSync; syncBuiltinESMExports();
    const options = { sections: {} as Record<string, string> };
    try {
      await assert.doesNotReject(f.mock.fire("before_agent_start", { systemPromptOptions: options }, f.ctx));
      await assert.doesNotReject(Promise.resolve(f.command(`version ${version === "v1" ? "v2" : "v1"}`)));
      assert.ok(options.sections.pi_memory); assert.deepEqual(fs.readFileSync(join(f.root, "config.json")), original);
      assert.ok(f.notices.some(message => message.includes("ENOSPC"))); assert.equal(f.requests(), 0);
    } finally { fs.writeFileSync = write; syncBuiltinESMExports(); }
  });

  for (const phase of ["mkdir", "write", "fsync"]) test(`${version}: disk full during initial configuration ${phase} is diagnosed without rejecting startup`, async t => {
    const f = fixture(t, version, { configured: false });
    const mkdir = fs.mkdirSync; const write = fs.writeFileSync; const sync = fs.fsyncSync;
    const full = () => { throw Object.assign(new Error("disk full"), { code: "ENOSPC" }); };
    fs.mkdirSync = ((path: fs.PathLike, ...args: unknown[]) => {
      if (phase === "mkdir" && String(path) === f.root) full();
      return Reflect.apply(mkdir, fs, [path, ...args]);
    }) as typeof fs.mkdirSync;
    fs.writeFileSync = ((path: fs.PathOrFileDescriptor, ...args: unknown[]) => {
      if (phase === "write" && String(path).includes("config.json.tmp-")) full();
      return Reflect.apply(write, fs, [path, ...args]);
    }) as typeof fs.writeFileSync;
    fs.fsyncSync = ((fd: number) => { if (phase === "fsync") full(); return sync(fd); }) as typeof fs.fsyncSync;
    syncBuiltinESMExports();
    try {
      await assert.doesNotReject(f.mock.fire("session_start", {}, f.ctx));
      assert.ok(f.notices.some(message => /ENOSPC/.test(message)));
      assert.equal(f.requests(), 0); assert.equal(fs.existsSync(join(f.root, "sources")), false);
      assert.equal(fs.existsSync(join(f.root, "config.json")), false);
    } finally { fs.mkdirSync = mkdir; fs.writeFileSync = write; fs.fsyncSync = sync; syncBuiltinESMExports(); }
  });
}
