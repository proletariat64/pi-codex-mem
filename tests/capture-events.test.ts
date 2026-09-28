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
  await mock.fire("agent_settled", { type: "agent_settled" }, ctx);
  assert.equal(snapshotFiles(memoryRoot).length, 1, "repeat settlement is idempotent");

  // second settlement with a longer branch -> a second revision on the same branch
  const sm2 = fakeSessionManager(cwd, [userEntry("u1", "decided: TypeScript over Rust"), userEntry("u2", "because types")]);
  const ctx2 = { ...ctx, sessionManager: sm2 };
  await mock.fire("agent_settled", { type: "agent_settled" }, ctx2);
  assert.equal(snapshotFiles(memoryRoot).length, 2, "new revision, same lineage");
});

test("compaction and shutdown checkpoint branch state without waiting for a model (§6.1)", async (t) => {
  const { cwd, memoryRoot } = makeSandbox(t);
  const mock = makeMockPi(); memoryExtension(mock.pi);
  const entries: unknown[] = [userEntry("u1", "pre-compaction decision")];
  const ctx = { cwd, hasUI: false, mode: "tui", sessionManager: fakeSessionManager(cwd, entries),
    modelRegistry: { find: () => ({}), streamSimple: () => ({}) }, ui: { notify: () => {} } };
  await mock.fire("session_start", { type: "session_start" }, ctx);
  await mock.fire("session_before_compact", { type: "session_before_compact" }, ctx);
  assert.equal(snapshotFiles(memoryRoot).length, 1);
  entries.push({ ...userEntry("u2", "last unscheduled decision"), parentId: "u1" });
  await mock.fire("session_shutdown", { type: "session_shutdown", reason: "exit" }, ctx);
  const files = snapshotFiles(memoryRoot);
  assert.equal(files.length, 2);
  assert.ok(files.some((f) => readFileSync(f, "utf8").includes("last unscheduled decision")));
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
  const epoch = db.prepare("SELECT control_epoch FROM store_state").get() as { control_epoch: number };
  const blocked = db.prepare("SELECT read_blocked FROM pipeline_state").all() as { read_blocked: number }[];
  db.close();
  assert.ok(heads.every((h) => h.state === "retired"), "old head retired after /tree switch");
  assert.equal(epoch.control_epoch, 1);
  assert.deepEqual(blocked.map((r) => r.read_blocked), [1, 1]);
});

test("resume blocks old captured evidence when a new context edit is present before settlement", async (t) => {
  const { cwd, memoryRoot } = makeSandbox(t);
  const mock = makeMockPi(); memoryExtension(mock.pi);
  const entries: unknown[] = [userEntry("u1", "stale private decision")];
  const ctx = { cwd, hasUI: false, mode: "tui", sessionManager: fakeSessionManager(cwd, entries),
    modelRegistry: { find: () => ({}), streamSimple: () => ({}) }, ui: { notify: () => {} } };
  await mock.fire("session_start", { type: "session_start" }, ctx);
  await mock.fire("agent_settled", { type: "agent_settled" }, ctx);
  entries.push({ type: "context_edit", id: "e1", parentId: "u1", targetId: "u1", replacement: null,
    timestamp: "2024-01-02T00:00:00.000Z" });
  await mock.fire("session_start", { type: "session_start" }, ctx); // restart, no settlement yet
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(join(memoryRoot, "state.sqlite"));
  assert.equal((db.prepare("SELECT control_epoch FROM store_state").get() as { control_epoch: number }).control_epoch, 1);
  assert.deepEqual((db.prepare("SELECT read_blocked FROM pipeline_state").all() as { read_blocked: number }[]).map((r) => r.read_blocked), [1, 1]);
  assert.equal((db.prepare("SELECT status FROM source_revisions").get() as { status: string }).status, "superseded");
  db.close();
  await mock.fire("agent_settled", { type: "agent_settled" }, ctx);
  assert.equal(snapshotFiles(memoryRoot).length, 1, "the old at-rest snapshot is removed on settlement");
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
  assert.equal(files.length, 1, "privacy edit deletes the prior at-rest snapshot");
  const contents = files.map((f) => JSON.parse(readFileSync(f, "utf8")));
  assert.ok(contents.some((s) => s.items.length === 0));
  assert.equal(readFileSync(sourceFile, "utf8"), "authoritative session bytes\n");
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(join(memoryRoot, "state.sqlite"));
  const statuses = db.prepare("SELECT status FROM source_revisions ORDER BY captured_at").all() as { status: string }[];
  assert.deepEqual(statuses.map((r) => r.status).sort(), ["captured", "privacy_revoked"]);
  const epoch = db.prepare("SELECT control_epoch FROM store_state").get() as { control_epoch: number };
  assert.equal(epoch.control_epoch, 1);
  const blocks = db.prepare("SELECT read_blocked FROM pipeline_state").all() as { read_blocked: number }[];
  assert.deepEqual(blocks.map((r) => r.read_blocked), [1, 1]);
  db.close();
});

test("a fork cannot recapture an ancestor entry after a privacy removal", async (t) => {
  const { cwd, memoryRoot } = makeSandbox(t);
  const mock = makeMockPi(); memoryExtension(mock.pi);
  const parentEntries: unknown[] = [userEntry("u1", "removed across copies")];
  const parent = fakeSessionManager(cwd, parentEntries);
  const ctx = { cwd, hasUI: false, mode: "tui", sessionManager: parent,
    modelRegistry: { find: () => ({}), streamSimple: () => ({}) }, ui: { notify: () => {} } };
  await mock.fire("session_start", { type: "session_start" }, ctx);
  await mock.fire("agent_settled", { type: "agent_settled" }, ctx);
  const olderSiblingEdit = { type: "context_edit", id: "b-old-edit", parentId: "u1", targetId: "u1",
    replacement: { content: [{ type: "text", text: "removed across copies" }] }, timestamp: "2024-01-01T00:00:00.000Z" };
  const fork = { ...fakeSessionManager(cwd, [userEntry("u1", "removed across copies"), olderSiblingEdit], "fork"),
    getSessionFile: () => join(cwd, "fork.jsonl"),
    getHeader: () => ({ type: "session", id: "fork", parentSession: parent.getSessionFile(), timestamp: new Date(0).toISOString(), cwd }) };
  await mock.fire("session_start", { type: "session_start" }, { ...ctx, sessionManager: fork });
  await mock.fire("agent_settled", { type: "agent_settled" }, { ...ctx, sessionManager: fork });
  parentEntries.push({ type: "context_edit", id: "e1", parentId: "u1", targetId: "u1", replacement: null, timestamp: "2024-01-02T00:00:00.000Z" });
  await mock.fire("session_start", { type: "session_start" }, ctx);
  await mock.fire("agent_settled", { type: "agent_settled" }, ctx);
  await mock.fire("session_start", { type: "session_start" }, { ...ctx, sessionManager: fork });
  await mock.fire("agent_settled", { type: "agent_settled" }, { ...ctx, sessionManager: fork });
  for (const file of snapshotFiles(memoryRoot)) {
    assert.ok(!readFileSync(file, "utf8").includes("removed across copies"), "revoked ancestor cannot be recaptured");
  }
  parentEntries.push({ type: "context_edit", id: "e2", parentId: "e1", targetId: "u1",
    replacement: { content: [{ type: "text", text: "user-approved replacement" }] }, timestamp: "2024-01-01T00:00:00.000Z" });
  await mock.fire("session_start", { type: "session_start" }, ctx);
  await mock.fire("agent_settled", { type: "agent_settled" }, ctx);
  assert.ok(snapshotFiles(memoryRoot).some((file) => readFileSync(file, "utf8").includes("user-approved replacement")),
    "an explicit replacement can restore approved content without restoring old raw text");
  await mock.fire("session_start", { type: "session_start" }, { ...ctx, sessionManager: fork });
  await mock.fire("agent_settled", { type: "agent_settled" }, { ...ctx, sessionManager: fork });
  assert.ok(snapshotFiles(memoryRoot).some((file) => readFileSync(file, "utf8").includes("user-approved replacement")),
    "replaying an older sibling edit cannot revoke a newer approved replacement");
  assert.ok(snapshotFiles(memoryRoot).every((file) => !readFileSync(file, "utf8").includes("removed across copies")));
});

test("later same-branch privacy removal wins even when its timestamp goes backward", async (t) => {
  const { cwd, memoryRoot } = makeSandbox(t);
  const mock = makeMockPi(); memoryExtension(mock.pi);
  const entries: unknown[] = [userEntry("u1", "must be erased")];
  const ctx = { cwd, hasUI: false, mode: "tui", sessionManager: fakeSessionManager(cwd, entries),
    modelRegistry: { find: () => ({}), streamSimple: () => ({}) }, ui: { notify: () => {} } };
  await mock.fire("session_start", { type: "session_start" }, ctx);
  await mock.fire("agent_settled", { type: "agent_settled" }, ctx);
  entries.push({ type: "context_edit", id: "e1", parentId: "u1", targetId: "u1",
    replacement: { content: [{ type: "text", text: "first approved text" }] }, timestamp: "2025-01-02T00:00:00.000Z" });
  await mock.fire("agent_settled", { type: "agent_settled" }, ctx);
  entries.push({ type: "context_edit", id: "e2", parentId: "e1", targetId: "u1", replacement: null,
    timestamp: "2024-01-01T00:00:00.000Z" });
  await mock.fire("agent_settled", { type: "agent_settled" }, ctx);
  assert.ok(snapshotFiles(memoryRoot).every((file) => !readFileSync(file, "utf8").includes("first approved text")));
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(join(memoryRoot, "state.sqlite"));
  assert.equal((db.prepare("SELECT allowed_hashes FROM privacy_edit_targets WHERE entry_id = 'u1'").get() as { allowed_hashes: string }).allowed_hashes, "[]");
  db.close();
});

test("budget-driven removal of previously captured evidence blocks derived views", async (t) => {
  const { cwd, memoryRoot } = makeSandbox(t);
  const mock = makeMockPi(); memoryExtension(mock.pi);
  const entries: unknown[] = [userEntry("u1", "a".repeat(700))];
  const ctx = { cwd, hasUI: false, mode: "tui", sessionManager: fakeSessionManager(cwd, entries),
    modelRegistry: { find: () => ({}), streamSimple: () => ({}) }, ui: { notify: () => {} } };
  await mock.fire("session_start", { type: "session_start" }, ctx);
  const path = join(memoryRoot, "config.json");
  const config = JSON.parse(readFileSync(path, "utf8"));
  writeFileSync(path, JSON.stringify({ ...config, limits: { ...config.limits, inputBytes: 1024 } }));
  await mock.fire("agent_settled", { type: "agent_settled" }, ctx);
  entries.push({ ...userEntry("u2", "b".repeat(700)), parentId: "u1" });
  await mock.fire("agent_settled", { type: "agent_settled" }, ctx);
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(join(memoryRoot, "state.sqlite"));
  assert.equal((db.prepare("SELECT control_epoch FROM store_state").get() as { control_epoch: number }).control_epoch, 1);
  assert.deepEqual((db.prepare("SELECT read_blocked FROM pipeline_state").all() as { read_blocked: number }[]).map((r) => r.read_blocked), [1, 1]);
  db.close();
});

test("privacy edit revokes copied ancestor evidence on previously selected branches", async (t) => {
  const { cwd, memoryRoot } = makeSandbox(t);
  const mock = makeMockPi(); memoryExtension(mock.pi);
  const entries: unknown[] = [userEntry("u1", "a private preference")];
  const ctx = { cwd, hasUI: false, mode: "tui", sessionManager: fakeSessionManager(cwd, entries),
    modelRegistry: { find: () => ({}), streamSimple: () => ({}) }, ui: { notify: () => {} } };
  await mock.fire("session_start", { type: "session_start" }, ctx);
  await mock.fire("agent_settled", { type: "agent_settled" }, ctx);
  await mock.fire("session_tree", { type: "session_tree", newLeafId: "u1", oldLeafId: "u1" }, ctx);
  entries.push({ ...userEntry("u2", "new branch evidence"), parentId: "u1" });
  await mock.fire("agent_settled", { type: "agent_settled" }, ctx);
  assert.equal(snapshotFiles(memoryRoot).length, 2);
  entries.push({ type: "context_edit", id: "e1", parentId: "u2", targetId: "u1", replacement: null, timestamp: new Date().toISOString() });
  await mock.fire("agent_settled", { type: "agent_settled" }, ctx);
  const files = snapshotFiles(memoryRoot);
  assert.equal(files.length, 1, "both prior branches are erased from the extension store");
  assert.ok(!readFileSync(files[0]!, "utf8").includes("a private preference"));
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(join(memoryRoot, "state.sqlite"));
  const statuses = db.prepare("SELECT status FROM source_revisions").all() as { status: string }[];
  assert.deepEqual(statuses.map((r) => r.status).sort(), ["captured", "privacy_revoked", "privacy_revoked"]);
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
  assert.equal(snapshot.omissionsManifest.count, 1);
  assert.deepEqual(snapshot.omissionsManifest.entryIds, ["c1"]);
});

test("fork copies the ancestor evidence key from an older retained parent revision", async (t) => {
  const { cwd, memoryRoot } = makeSandbox(t);
  const mock = makeMockPi(); memoryExtension(mock.pi);
  const entries: unknown[] = [userEntry("u1", "A".repeat(700))];
  const parent = fakeSessionManager(cwd, entries);
  const ctx = { cwd, hasUI: false, mode: "tui", sessionManager: parent,
    modelRegistry: { find: () => ({}), streamSimple: () => ({}) }, ui: { notify: () => {} } };
  await mock.fire("session_start", { type: "session_start" }, ctx);
  const configPath = join(memoryRoot, "config.json");
  const cfg = JSON.parse(readFileSync(configPath, "utf8"));
  writeFileSync(configPath, JSON.stringify({ ...cfg, limits: { ...cfg.limits, inputBytes: 1024 } }));
  await mock.fire("agent_settled", { type: "agent_settled" }, ctx);
  entries.push({ ...userEntry("u2", "B".repeat(700)), parentId: "u1" });
  await mock.fire("agent_settled", { type: "agent_settled" }, ctx);
  const fork = { ...fakeSessionManager(cwd, [userEntry("u1", "A".repeat(700))], "fork"),
    getSessionFile: () => join(cwd, "fork.jsonl"),
    getHeader: () => ({ type: "session", id: "fork", parentSession: parent.getSessionFile(), timestamp: new Date(0).toISOString(), cwd }) };
  await mock.fire("session_start", { type: "session_start" }, { ...ctx, sessionManager: fork });
  await mock.fire("agent_settled", { type: "agent_settled" }, { ...ctx, sessionManager: fork });
  const snapshots = snapshotFiles(memoryRoot).map((file) => JSON.parse(readFileSync(file, "utf8")));
  const first = snapshots.find((s) => s.sessionPath === parent.getSessionFile() && s.leafId === "u1");
  const copied = snapshots.find((s) => s.sessionPath === fork.getSessionFile());
  assert.ok(first && copied);
  assert.equal(copied.items[0].evidenceKey, first.items[0].evidenceKey);
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
  assert.equal(new Set(snapshots.map((s) => s.sourceId)).size, 2);
  const source = snapshots.find((s) => !s.parentSession);
  const copied = snapshots.find((s) => s.parentSession);
  assert.equal(copied?.parentSession, sm.getSessionFile());
  assert.equal(copied.items[0].evidenceKey, source.items[0].evidenceKey, "copied ancestor is not independent corroboration");
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(join(memoryRoot, "state.sqlite"));
  const parent = db.prepare("SELECT session_key FROM sessions WHERE path = ?").get(sm.getSessionFile()) as { session_key: string };
  const child = db.prepare("SELECT parent_key FROM sessions WHERE path = ?").get(fork.getSessionFile()) as { parent_key: string };
  assert.equal(child.parent_key, parent.session_key);
  db.close();
});

test("fork retains the evidence key of a copied ancestor from a retired parent branch", async (t) => {
  const { cwd, memoryRoot } = makeSandbox(t);
  const mock = makeMockPi(); memoryExtension(mock.pi);
  const original = fakeSessionManager(cwd, [userEntry("u1", "shared retired decision")]);
  const ctx = { cwd, hasUI: false, mode: "tui", sessionManager: original,
    modelRegistry: { find: () => ({}), streamSimple: () => ({}) }, ui: { notify: () => {} } };
  await mock.fire("session_start", { type: "session_start" }, ctx);
  await mock.fire("agent_settled", { type: "agent_settled" }, ctx);
  const alternate = fakeSessionManager(cwd, [userEntry("u2", "alternate branch")]);
  await mock.fire("session_tree", { type: "session_tree", oldLeafId: "u1", newLeafId: "u2" }, { ...ctx, sessionManager: alternate });
  await mock.fire("agent_settled", { type: "agent_settled" }, { ...ctx, sessionManager: alternate });
  const fork = { ...fakeSessionManager(cwd, [userEntry("u1", "shared retired decision")], "fork"),
    getSessionFile: () => join(cwd, "fork.jsonl"),
    getHeader: () => ({ type: "session", id: "fork", parentSession: original.getSessionFile(), timestamp: new Date(0).toISOString(), cwd }) };
  await mock.fire("session_start", { type: "session_start" }, { ...ctx, sessionManager: fork });
  await mock.fire("agent_settled", { type: "agent_settled" }, { ...ctx, sessionManager: fork });
  const snapshots = snapshotFiles(memoryRoot).map((file) => JSON.parse(readFileSync(file, "utf8")));
  const source = snapshots.find((s) => s.sessionPath === original.getSessionFile() && s.leafId === "u1");
  const copied = snapshots.find((s) => s.sessionPath === fork.getSessionFile());
  assert.ok(source && copied);
  assert.equal(copied.items[0].evidenceKey, source.items[0].evidenceKey);
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

test("excluded parent workspace suppresses capture in a descendant but not a sibling (§14)", async (t) => {
  const { cwd, memoryRoot } = makeSandbox(t);
  mkdirSync(memoryRoot, { recursive: true });
  const parent = join(cwd, "excluded");
  const descendant = join(parent, "child");
  const sibling = join(cwd, "excluded-other");
  mkdirSync(descendant, { recursive: true }); mkdirSync(sibling);
  const { defaultConfig } = await import("../src/config.ts");
  writeFileSync(join(memoryRoot, "config.json"), JSON.stringify({ ...defaultConfig("UTC"), excludedWorkspaces: [parent] }));
  const mock = makeMockPi(); memoryExtension(mock.pi);
  const ctx = { cwd: descendant, hasUI: false, mode: "tui", sessionManager: fakeSessionManager(descendant, [userEntry("u1", "private")]),
    modelRegistry: { find: () => ({}), streamSimple: () => ({}) }, ui: { notify: () => {} } };
  await mock.fire("session_start", { type: "session_start" }, ctx);
  await mock.fire("agent_settled", { type: "agent_settled" }, ctx);
  assert.deepEqual(snapshotFiles(memoryRoot), []);
  const siblingContext = { ...ctx, cwd: sibling, sessionManager: fakeSessionManager(sibling, [userEntry("u2", "allowed")]) };
  await mock.fire("session_start", { type: "session_start" }, siblingContext);
  await mock.fire("agent_settled", { type: "agent_settled" }, siblingContext);
  assert.equal(snapshotFiles(memoryRoot).length, 1);
});

test("legacy lock blocks capture even when config.json already exists", async (t) => {
  const { cwd, memoryRoot } = makeSandbox(t);
  const mock = makeMockPi(); memoryExtension(mock.pi);
  const ctx = { cwd, hasUI: false, mode: "tui", sessionManager: fakeSessionManager(cwd, [userEntry("u1", "must not capture")]),
    modelRegistry: { find: () => ({}), streamSimple: () => ({}) }, ui: { notify: () => {} } };
  await mock.fire("session_start", { type: "session_start" }, ctx);
  mkdirSync(join(memoryRoot, "config.json.lock"));
  await mock.fire("agent_settled", { type: "agent_settled" }, ctx);
  assert.deepEqual(snapshotFiles(memoryRoot), []);
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
