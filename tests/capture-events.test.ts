import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import memoryExtension from "../src/extension.ts";
import { makeMockPi } from "./mock-pi.ts";

const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
afterEach(() => {
  if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
});

function fakeSessionManager(cwd: string, entries: unknown[], headerId = "sess-1") {
  return {
    getCwd: () => cwd,
    getSessionId: () => headerId,
    getSessionFile: () => join(cwd, "session.jsonl"),
    getLeafId: () => (entries.length > 0 ? (entries[entries.length - 1] as { id: string }).id : null),
    getHeader: () => ({ type: "session", id: headerId, timestamp: new Date(0).toISOString(), cwd }),
    getBranch: () => entries,
  };
}

function userEntry(id: string, text: string) {
  return { type: "message", id, parentId: null, timestamp: new Date(0).toISOString(), message: { role: "user", content: [{ type: "text", text }], timestamp: 0 } };
}

function makeSandbox(t: test.TestContext): { agentDir: string; cwd: string; memoryRoot: string } {
  const base = mkdtempSync(join(tmpdir(), "pi-memory-cap3-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const agentDir = join(base, "agent");
  const cwd = join(base, "repo");
  mkdirSync(cwd, { recursive: true });
  process.env.PI_CODING_AGENT_DIR = agentDir;
  execFileSync("git", ["init", "-q"], { cwd });
  return { agentDir, cwd, memoryRoot: join(agentDir, "memory") };
}

function snapshotFiles(root: string): string[] {
  const dir = join(root, "sources");
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const lineage of readdirSync(dir)) {
    for (const f of readdirSync(join(dir, lineage))) out.push(join(dir, lineage, f));
  }
  return out;
}

test("agent_settled writes an immutable snapshot and DB rows (R01); status reports captured", async (t) => {
  const { cwd, memoryRoot } = makeSandbox(t);
  const mock = makeMockPi();
  memoryExtension(mock.pi);
  const sm = fakeSessionManager(cwd, [userEntry("u1", "decided: TypeScript over Rust")]);
  const ctx = {
    cwd,
    hasUI: false,
    mode: "tui",
    sessionManager: sm,
    modelRegistry: { find: () => ({}), streamSimple: () => ({}) },
    ui: { notify: () => {} },
  };

  await mock.fire("session_start", { type: "session_start" }, ctx);
  await mock.fire("agent_settled", { type: "agent_settled" }, ctx);

  const files = snapshotFiles(memoryRoot);
  assert.equal(files.length, 1, "one snapshot file");
  const snapshot = JSON.parse(readFileSync(files[0]!, "utf8"));
  assert.equal(snapshot.schemaVersion, 1);
  assert.ok(snapshot.lineageKey);
  assert.equal(snapshot.items[0].text, "decided: TypeScript over Rust");
  assert.ok(existsSync(join(memoryRoot, "state.sqlite")), "state store created");

  // second settlement with a longer branch -> a second revision on the same branch
  const sm2 = fakeSessionManager(cwd, [userEntry("u1", "decided: TypeScript over Rust"), userEntry("u2", "because types")]);
  const ctx2 = { ...ctx, sessionManager: sm2 };
  await mock.fire("agent_settled", { type: "agent_settled" }, ctx2);
  assert.equal(snapshotFiles(memoryRoot).length, 2, "new revision, same lineage");
});

test("session_tree retires the abandoned head (T08)", async (t) => {
  const { cwd, memoryRoot } = makeSandbox(t);
  const mock = makeMockPi();
  memoryExtension(mock.pi);
  const ctx = {
    cwd,
    hasUI: false,
    mode: "tui",
    sessionManager: fakeSessionManager(cwd, [userEntry("u1", "original decision")]),
    modelRegistry: { find: () => ({}), streamSimple: () => ({}) },
    ui: { notify: () => {} },
  };
  await mock.fire("session_start", { type: "session_start" }, ctx);
  await mock.fire("agent_settled", { type: "agent_settled" }, ctx);
  await mock.fire("session_tree", { type: "session_tree", newLeafId: "uX", oldLeafId: "u1" }, ctx);

  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(join(memoryRoot, "state.sqlite"), { open: true });
  const heads = db.prepare("SELECT state FROM branch_heads").all() as { state: string }[];
  db.close();
  assert.ok(heads.every((h) => h.state === "retired"), "old head retired after /tree switch");
});

test("context edit removes sensitive evidence, supersedes old revision, and never touches source session (T10/R07)", async (t) => {
  const { cwd, memoryRoot } = makeSandbox(t);
  const sourceFile = join(cwd, "session.jsonl");
  writeFileSync(sourceFile, "authoritative session bytes\n");
  const mock = makeMockPi();
  memoryExtension(mock.pi);
  const original = userEntry("u1", "sk-ABCDEFGHIJKLMNOPQRSTUVWX a private decision");
  const entries: unknown[] = [original];
  const sm = fakeSessionManager(cwd, entries);
  const ctx = { cwd, hasUI: false, mode: "tui", sessionManager: sm,
    modelRegistry: { find: () => ({}), streamSimple: () => ({}) }, ui: { notify: () => {} } };
  await mock.fire("session_start", { type: "session_start" }, ctx);
  await mock.fire("agent_settled", { type: "agent_settled" }, ctx);
  entries.push({ type: "context_edit", id: "e1", parentId: "u1", targetId: "u1", replacement: null, timestamp: new Date().toISOString() });
  await mock.fire("agent_settled", { type: "agent_settled" }, ctx);
  const files = snapshotFiles(memoryRoot);
  assert.equal(files.length, 2);
  const contents = files.map((f) => JSON.parse(readFileSync(f, "utf8")));
  assert.ok(contents.some((s) => s.items.length === 0));
  assert.equal(readFileSync(sourceFile, "utf8"), "authoritative session bytes\n");
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(join(memoryRoot, "state.sqlite"));
  const statuses = db.prepare("SELECT status FROM source_revisions ORDER BY captured_at").all() as { status: string }[];
  assert.deepEqual(statuses.map((r) => r.status).sort(), ["captured", "superseded"]);
  db.close();
});

test("pre-compaction ancestry is captured but the derived summary is not counted twice (T07)", async (t) => {
  const { cwd, memoryRoot } = makeSandbox(t);
  const mock = makeMockPi(); memoryExtension(mock.pi);
  const entries = [userEntry("u1", "choose TypeScript because of type safety"),
    { type: "compaction", id: "c1", parentId: "u1", timestamp: new Date().toISOString(), summary: "choose TypeScript", firstKeptEntryId: "u1", tokensBefore: 100 }];
  const ctx = { cwd, hasUI: false, mode: "tui", sessionManager: fakeSessionManager(cwd, entries),
    modelRegistry: { find: () => ({}), streamSimple: () => ({}) }, ui: { notify: () => {} } };
  await mock.fire("session_start", { type: "session_start" }, ctx);
  await mock.fire("agent_settled", { type: "agent_settled" }, ctx);
  const snapshot = JSON.parse(readFileSync(snapshotFiles(memoryRoot)[0]!, "utf8"));
  assert.deepEqual(snapshot.items.map((item: { sourceId: string }) => item.sourceId), ["u1"]);
});

test("forked session receives a distinct session identity (T09)", async (t) => {
  const { cwd, memoryRoot } = makeSandbox(t);
  const mock = makeMockPi(); memoryExtension(mock.pi);
  const entries = [userEntry("u1", "shared ancestor")];
  const sm = fakeSessionManager(cwd, entries);
  const ctx = { cwd, hasUI: false, mode: "tui", sessionManager: sm,
    modelRegistry: { find: () => ({}), streamSimple: () => ({}) }, ui: { notify: () => {} } };
  await mock.fire("session_start", { type: "session_start" }, ctx);
  await mock.fire("agent_settled", { type: "agent_settled" }, ctx);
  const fork = { ...sm, getSessionFile: () => join(cwd, "fork.jsonl"),
    getHeader: () => ({ type: "session", id: "sess-fork", parentSession: sm.getSessionFile(), timestamp: new Date(0).toISOString(), cwd }) };
  await mock.fire("session_start", { type: "session_start" }, { ...ctx, sessionManager: fork });
  await mock.fire("agent_settled", { type: "agent_settled" }, { ...ctx, sessionManager: fork });
  const files = snapshotFiles(memoryRoot);
  const snapshots = files.map((f) => JSON.parse(readFileSync(f, "utf8")));
  assert.equal(new Set(snapshots.map((s) => s.sessionKey)).size, 2);
  assert.equal(snapshots.find((s) => s.parentSession)?.parentSession, sm.getSessionFile());
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(join(memoryRoot, "state.sqlite"));
  const parent = db.prepare("SELECT session_key FROM sessions WHERE path = ?").get(sm.getSessionFile()) as { session_key: string };
  const child = db.prepare("SELECT parent_key FROM sessions WHERE path = ?").get(fork.getSessionFile()) as { parent_key: string };
  assert.equal(child.parent_key, parent.session_key);
  db.close();
});

test("capture skipped in non-enrolled modes (§6.3: TUI-only by default)", async (t) => {
  const { cwd, memoryRoot } = makeSandbox(t);
  const mock = makeMockPi();
  memoryExtension(mock.pi);
  const ctx = {
    cwd,
    hasUI: false,
    mode: "rpc",
    sessionManager: fakeSessionManager(cwd, [userEntry("u1", "rpc text")]),
    modelRegistry: { find: () => ({}), streamSimple: () => ({}) },
    ui: { notify: () => {} },
  };
  await mock.fire("session_start", { type: "session_start" }, ctx);
  await mock.fire("agent_settled", { type: "agent_settled" }, ctx);
  assert.deepEqual(snapshotFiles(memoryRoot), [], "rpc mode is not captured by default");
});

test("enabled=false captures nothing", async (t) => {
  const { cwd, memoryRoot } = makeSandbox(t);
  mkdirSync(memoryRoot, { recursive: true });
  const { defaultConfig } = await import("../src/config.ts");
  writeFileSync(join(memoryRoot, "config.json"), JSON.stringify({ ...defaultConfig("UTC"), enabled: false }));

  const mock = makeMockPi();
  memoryExtension(mock.pi);
  const ctx = {
    cwd,
    hasUI: false,
    mode: "tui",
    sessionManager: fakeSessionManager(cwd, [userEntry("u1", "text")]),
    modelRegistry: { find: () => ({}), streamSimple: () => ({}) },
    ui: { notify: () => {} },
  };
  await mock.fire("session_start", { type: "session_start" }, ctx);
  await mock.fire("agent_settled", { type: "agent_settled" }, ctx);
  assert.deepEqual(snapshotFiles(memoryRoot), []);
  assert.ok(!existsSync(join(memoryRoot, "state.sqlite")), "no state store when disabled");
});
