import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enrollHistoricalImport, planHistoricalImport } from "../src/historical-import.ts";
import { openStateDb } from "../src/store/db.ts";
import memoryExtension from "../src/extension.ts";
import { makeMockPi } from "./mock-pi.ts";

function sandbox(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "pi-memory-import-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, "repo");
  mkdirSync(cwd);
  execFileSync("git", ["init", "-q"], { cwd });
  return { root, cwd };
}

function jsonl(cwd: string, entries: object[]): string {
  return [
    { type: "session", version: 3, id: "historical-1", timestamp: "2024-01-01T00:00:00.000Z", cwd },
    ...entries,
  ].map((entry) => JSON.stringify(entry)).join("\n") + "\n";
}

function user(id: string, parentId: string | null, text: string) {
  return { type: "message", id, parentId, timestamp: "2024-01-01T00:00:01.000Z",
    message: { role: "user", content: [{ type: "text", text }], timestamp: 1704067201000 } };
}

test("unreadable source is reported without hiding other directory candidates", (t) => {
  const { root, cwd } = sandbox(t);
  const dir = join(root, "history"); mkdirSync(dir);
  writeFileSync(join(dir, "good.jsonl"), jsonl(cwd, [user("u1", null, "good")]));
  const unreadable = join(dir, "private.jsonl");
  writeFileSync(unreadable, jsonl(cwd, [user("u2", null, "private")]));
  chmodSync(unreadable, 0o000);

  const report = planHistoricalImport(dir);

  assert.equal(report.candidates.length, 1);
  assert.match(report.unsupported[0]?.reason ?? "", /unreadable|EACCES/i);
});

test("run skips a source changed after planning rather than enrolling stale evidence", (t) => {
  const { root, cwd } = sandbox(t);
  const agentDir = join(root, "agent");
  const memoryRoot = join(agentDir, "memory");
  const file = join(root, "changing.jsonl");
  writeFileSync(file, jsonl(cwd, [user("u1", null, "old decision")]));
  const planned = planHistoricalImport(file);
  const changed = jsonl(cwd, [user("u1", null, "new decision")]);
  writeFileSync(file, changed);
  const db = openStateDb(memoryRoot);
  t.after(() => db.close());

  const outcome = enrollHistoricalImport(planned, { root: memoryRoot, agentDir, db,
    limits: { itemBytes: 64 * 1024, toolResultBytes: 8 * 1024, totalBytes: 256 * 1024 } });

  assert.equal(outcome.imported, 0);
  assert.match(outcome.skipped[0]?.reason ?? "", /changed.*plan/i);
  assert.equal(existsSync(join(memoryRoot, "sources")), false);
  assert.equal(readFileSync(file, "utf8"), changed);
});

test("planning a directory lists eligible and unsupported files with total bytes", (t) => {
  const { root, cwd } = sandbox(t);
  const dir = join(root, "history"); mkdirSync(dir);
  const good = jsonl(cwd, [user("u1", null, "decision")]);
  const future = good.replace('"version":3', '"version":9');
  writeFileSync(join(dir, "good.jsonl"), good);
  writeFileSync(join(dir, "future.jsonl"), future);
  writeFileSync(join(dir, "notes.txt"), "not a session");

  const report = planHistoricalImport(dir);

  assert.equal(report.candidates.length, 1);
  assert.equal(report.totalBytes, Buffer.byteLength(good) + Buffer.byteLength(future) + Buffer.byteLength("not a session"));
  assert.equal(report.unsupported.length, 2);
  assert.ok(report.unsupported.some((item: { path: string }) => item.path.endsWith("notes.txt")));
  assert.ok(report.unsupported.some((item: { reason: string }) => item.reason.includes("version 9")));
});

test("explicit import respects excluded workspace configuration", async (t) => {
  const { root, cwd } = sandbox(t);
  const agentDir = join(root, "agent");
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => { if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir; });
  const file = join(root, "old-session.jsonl");
  writeFileSync(file, jsonl(cwd, [user("u1", null, "excluded decision")]));
  const mock = makeMockPi(); memoryExtension(mock.pi);
  const notifications: string[] = [];
  const ctx = { cwd, hasUI: true, mode: "tui", sessionManager: { getBranch: () => [] },
    modelRegistry: { find: () => ({}), streamSimple: () => ({}) }, ui: { notify: (text: string) => notifications.push(text) } };
  await mock.fire("session_start", { type: "session_start" }, ctx);
  const configPath = join(agentDir, "memory", "config.json");
  const cfg = JSON.parse(readFileSync(configPath, "utf8"));
  writeFileSync(configPath, JSON.stringify({ ...cfg, excludedWorkspaces: [cwd] }));

  await mock.commands.get("memory")!.handler(`import ${file} --run`, ctx);

  assert.match(notifications.at(-1) ?? "", /excluded workspace/i);
  assert.equal(existsSync(join(agentDir, "memory", "sources")), false);
});

test("/memory import --run enrolls sanitized evidence without modifying the source", async (t) => {
  const { root, cwd } = sandbox(t);
  const agentDir = join(root, "agent");
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => { if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir; });
  const file = join(root, "old-session.jsonl");
  const original = jsonl(cwd, [user("u1", null, "historic decision sk-ABCDEFGHIJKLMNOPQRSTUVWX")]);
  writeFileSync(file, original);
  const fixtureHash = createHash("sha256").update(readFileSync(file)).digest("hex");
  const mock = makeMockPi(); memoryExtension(mock.pi);
  const notifications: string[] = [];
  const ctx = { cwd, hasUI: true, mode: "tui", sessionManager: { getBranch: () => [] },
    modelRegistry: { find: () => ({}), streamSimple: () => ({}) }, ui: { notify: (text: string) => notifications.push(text) } };
  await mock.fire("session_start", { type: "session_start" }, ctx);

  await mock.commands.get("memory")!.handler(`import ${file} --run`, ctx);

  assert.match(notifications.at(-1) ?? "", /imported:\s*1/i);
  const sourceDir = join(agentDir, "memory", "sources");
  const snapshots = readdirSync(sourceDir).flatMap((dir) => readdirSync(join(sourceDir, dir)).map((name) => join(sourceDir, dir, name)));
  assert.equal(snapshots.length, 1);
  const saved = JSON.parse(readFileSync(snapshots[0]!, "utf8"));
  assert.equal(saved.items[0].text, "historic decision [REDACTED]");
  assert.equal(saved.items[0].origin, "unknown");
  assert.equal(readFileSync(file, "utf8"), original);
  await mock.commands.get("memory")!.handler(`import ${file} --run`, ctx);
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(join(agentDir, "memory", "state.sqlite"), { readOnly: true });
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM source_revisions").get() as { n: number }).n, 1,
    "reimporting unchanged evidence never multiplies revisions");
  db.close();
  assert.equal(readdirSync(sourceDir).flatMap((dir) => readdirSync(join(sourceDir, dir))).length, 1);
  rmSync(snapshots[0]!); // selected enrolled source was pruned between versions (T34 importer half)
  await mock.commands.get("memory")!.handler(`import ${file} --run`, ctx);
  assert.equal(existsSync(snapshots[0]!), true, "explicit reimport reconstructs a pruned sanitized snapshot");
  assert.equal(readFileSync(file, "utf8"), original);
  assert.equal(createHash("sha256").update(readFileSync(file)).digest("hex"), fixtureHash,
    "import and reconstruction leave the original fixture byte-identical");
});

test("historical import applies the live input budget and reports omitted entry IDs", async (t) => {
  const { root, cwd } = sandbox(t);
  const agentDir = join(root, "agent");
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => { if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir; });
  const file = join(root, "budget.jsonl");
  writeFileSync(file, jsonl(cwd, [user("u1", null, "a".repeat(700)), user("u2", "u1", "b".repeat(700))]));
  const mock = makeMockPi(); memoryExtension(mock.pi);
  const notifications: string[] = [];
  const ctx = { cwd, hasUI: true, mode: "tui", sessionManager: { getBranch: () => [] },
    modelRegistry: { find: () => ({}), streamSimple: () => ({}) }, ui: { notify: (text: string) => notifications.push(text) } };
  await mock.fire("session_start", { type: "session_start" }, ctx);
  const configPath = join(agentDir, "memory", "config.json");
  const cfg = JSON.parse(readFileSync(configPath, "utf8"));
  writeFileSync(configPath, JSON.stringify({ ...cfg, limits: { ...cfg.limits, inputBytes: 1024 } }));

  await mock.commands.get("memory")!.handler(`import ${file} --run`, ctx);

  const sourceDir = join(agentDir, "memory", "sources");
  const [lineage] = readdirSync(sourceDir);
  const [name] = readdirSync(join(sourceDir, lineage!));
  const snapshot = JSON.parse(readFileSync(join(sourceDir, lineage!, name!), "utf8"));
  assert.deepEqual(snapshot.items.map((item: { entryId: string }) => item.entryId), ["u2"]);
  assert.deepEqual(snapshot.omissionsManifest.entryIds, ["u1"]);
  assert.match(notifications.at(-1) ?? "", /imported:\s*1/);
});

test("/memory import reuses a captured active leaf instead of guessing the last branch", async (t) => {
  const { root, cwd } = sandbox(t);
  const agentDir = join(root, "agent");
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => { if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir; });
  const file = join(root, "branches.jsonl");
  writeFileSync(file, jsonl(cwd, [user("u1", null, "selected decision")]));
  const mock = makeMockPi(); memoryExtension(mock.pi);
  const notifications: string[] = [];
  const ctx = { cwd, hasUI: true, mode: "tui", sessionManager: { getBranch: () => [] },
    modelRegistry: { find: () => ({}), streamSimple: () => ({}) }, ui: { notify: (text: string) => notifications.push(text) } };
  await mock.fire("session_start", { type: "session_start" }, ctx);
  await mock.commands.get("memory")!.handler(`import ${file} --run`, ctx);
  appendFileSync(file, JSON.stringify(user("a1", "u1", "first")) + "\n" + JSON.stringify(user("a2", "u1", "physical last")) + "\n");

  await mock.commands.get("memory")!.handler(`import ${file} --dry-run`, ctx);

  assert.match(notifications.at(-1) ?? "", /candidates:\s*1/);
  assert.match(notifications.at(-1) ?? "", /leaf u1/);
  assert.ok(!(notifications.at(-1) ?? "").includes("ambiguous"));
  await mock.commands.get("memory")!.handler(`import ${file} --run --leaf a1`, ctx);
  const sourceDir = join(agentDir, "memory", "sources");
  const snapshots = readdirSync(sourceDir).flatMap((dir) => readdirSync(join(sourceDir, dir))
    .map((name) => JSON.parse(readFileSync(join(sourceDir, dir, name), "utf8"))));
  assert.ok(snapshots.some((snapshot) => snapshot.leafId === "a1" &&
    snapshot.items.some((item: { text: string }) => item.text === "first")));
  assert.ok(snapshots.every((snapshot) => snapshot.items.every((item: { text: string }) => item.text !== "physical last")));
});

test("/memory import accepts a quoted path containing spaces", async (t) => {
  const { root, cwd } = sandbox(t);
  const agentDir = join(root, "agent");
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => { if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir; });
  const file = join(root, "old conversation.jsonl");
  writeFileSync(file, jsonl(cwd, [user("u1", null, "quoted path")]));
  const mock = makeMockPi(); memoryExtension(mock.pi);
  const notifications: string[] = [];
  const ctx = { cwd, hasUI: true, mode: "tui", sessionManager: { getBranch: () => [] },
    modelRegistry: { find: () => ({}), streamSimple: () => ({}) }, ui: { notify: (text: string) => notifications.push(text) } };
  await mock.fire("session_start", { type: "session_start" }, ctx);

  await mock.commands.get("memory")!.handler(`import "${file}" --dry-run`, ctx);

  assert.match(notifications.at(-1) ?? "", /candidates:\s*1/);
});

test("/memory import --dry-run reports one candidate without enrolling or editing it", async (t) => {
  const { root, cwd } = sandbox(t);
  const agentDir = join(root, "agent");
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => { if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir; });
  const file = join(root, "old-session.jsonl");
  const original = jsonl(cwd, [user("u1", null, "historic decision")]);
  writeFileSync(file, original);
  const mock = makeMockPi(); memoryExtension(mock.pi);
  const notifications: string[] = [];
  const ctx = { cwd, hasUI: true, mode: "tui", sessionManager: { getBranch: () => [] },
    modelRegistry: { find: () => ({}), streamSimple: () => ({}) }, ui: { notify: (text: string) => notifications.push(text) } };
  await mock.fire("session_start", { type: "session_start" }, ctx);

  await mock.commands.get("memory")!.handler(`import ${file} --dry-run`, ctx);

  assert.match(notifications.at(-1) ?? "", /candidates:\s*1/i);
  assert.match(notifications.at(-1) ?? "", /scope:.*repo/i);
  assert.match(notifications.at(-1) ?? "", /bytes:/i);
  assert.equal(readFileSync(file, "utf8"), original);
  assert.equal(existsSync(join(agentDir, "memory", "sources")), false);
  await mock.commands.get("memory")!.handler(`import ${file} --run --leaf`, ctx);
  assert.match(notifications.at(-1) ?? "", /--leaf requires an entry ID/i);
  assert.equal(existsSync(join(agentDir, "memory", "sources")), false);
});

test("strict v3 reader rejects invalid UTF-8 without normalizing source bytes", (t) => {
  const { root, cwd } = sandbox(t);
  const file = join(root, "bad-utf8.jsonl");
  const header = jsonl(cwd, []);
  const original = Buffer.concat([Buffer.from(header), Buffer.from([0xff, 0xfe, 0x0a])]);
  writeFileSync(file, original);

  const report = planHistoricalImport(file);

  assert.deepEqual(report.candidates, []);
  assert.match(report.unsupported[0]?.reason ?? "", /UTF-8/i);
  assert.deepEqual(readFileSync(file), original);
});

test("strict v3 reader rejects invalid content blocks before import", (t) => {
  const { root, cwd } = sandbox(t);
  const file = join(root, "bad-block.jsonl");
  writeFileSync(file, jsonl(cwd, [{ type: "message", id: "u1", parentId: null,
    timestamp: "2024-01-01T00:00:01.000Z", message: { role: "user", content: [null], timestamp: 0 } }]));

  const report = planHistoricalImport(file);

  assert.deepEqual(report.candidates, []);
  assert.match(report.unsupported[0]?.reason ?? "", /line 2.*content/i);
});

test("strict v3 reader rejects structurally malformed messages during dry-run", (t) => {
  const { root, cwd } = sandbox(t);
  const file = join(root, "invalid-message.jsonl");
  writeFileSync(file, jsonl(cwd, [{ type: "message", id: "u1", parentId: null,
    timestamp: "2024-01-01T00:00:01.000Z", message: null }]));

  const report = planHistoricalImport(file);

  assert.deepEqual(report.candidates, []);
  assert.match(report.unsupported[0]?.reason ?? "", /line 2.*message/i);
});

test("strict v3 reader skips duplicate IDs rather than inventing an ancestry", (t) => {
  const { root, cwd } = sandbox(t);
  const file = join(root, "duplicate.jsonl");
  const original = jsonl(cwd, [user("u1", null, "first"), user("u1", "u1", "duplicate")]);
  writeFileSync(file, original);

  const report = planHistoricalImport(file);

  assert.deepEqual(report.candidates, []);
  assert.match(report.unsupported[0]?.reason ?? "", /duplicate.*u1/i);
  assert.equal(readFileSync(file, "utf8"), original);
});

test("a branching JSONL file is ambiguous instead of choosing its last physical line", (t) => {
  const { root, cwd } = sandbox(t);
  const file = join(root, "branches.jsonl");
  writeFileSync(file, jsonl(cwd, [user("u1", null, "root"), user("a1", "u1", "first branch"), user("a2", "u1", "last physical line")]));

  const report = planHistoricalImport(file);

  assert.deepEqual(report.candidates, []);
  assert.deepEqual(report.ambiguous[0]?.leaves, ["a1", "a2"]);
  const selected = planHistoricalImport(file, { leaf: "a1" });
  assert.equal(selected.candidates[0]?.leafId, "a1");
  assert.deepEqual(selected.candidates[0]?.branch.map((entry: { id: string }) => entry.id), ["u1", "a1"],
    "the explicitly selected ancestry excludes the other branch");
  const previouslyCaptured = planHistoricalImport(file, { resolveSelectedLeaf: () => "a1" });
  assert.equal(previouslyCaptured.candidates[0]?.leafId, "a1", "a captured active leaf resolves ambiguity");
});

test("unknown session version is skipped without migrating it in place", (t) => {
  const { root, cwd } = sandbox(t);
  const file = join(root, "future.jsonl");
  const original = jsonl(cwd, [user("u1", null, "future")]).replace('"version":3', '"version":4');
  writeFileSync(file, original);

  const report = planHistoricalImport(file);

  assert.deepEqual(report.candidates, []);
  assert.match(report.unsupported[0]?.reason ?? "", /version 4.*unsupported/i);
  assert.equal(readFileSync(file, "utf8"), original);
});

test("an unterminated but complete final record becomes eligible once the file is stable", (t) => {
  const { root, cwd } = sandbox(t);
  const file = join(root, "stable.jsonl");
  const original = jsonl(cwd, [user("u1", null, "stable decision")]).trimEnd();
  writeFileSync(file, original);
  utimesSync(file, new Date(0), new Date(0));

  const report = planHistoricalImport(file);

  assert.equal(report.candidates[0]?.leafId, "u1");
  assert.deepEqual(report.deferred, []);
  assert.equal(readFileSync(file, "utf8"), original, "a valid old file is not repaired with a newline");
});

test("an incomplete trailing record is deferred without repairing the JSONL source", (t) => {
  const { root, cwd } = sandbox(t);
  const file = join(root, "in-progress.jsonl");
  const original = jsonl(cwd, [user("u1", null, "one")]) + "{\"type\":\"message\"";
  writeFileSync(file, original);

  const report = planHistoricalImport(file);

  assert.deepEqual(report.candidates, []);
  assert.deepEqual(report.unsupported, []);
  assert.match(report.deferred[0]?.reason ?? "", /trailing.*incomplete/i);
  assert.equal(readFileSync(file, "utf8"), original);
});

test("a malformed interior JSONL line skips the file with its physical line number", (t) => {
  const { root, cwd } = sandbox(t);
  const file = join(root, "malformed.jsonl");
  const original = jsonl(cwd, [user("u1", null, "one")]) + "{broken\n" + JSON.stringify(user("u2", "u1", "two")) + "\n";
  writeFileSync(file, original);

  const report = planHistoricalImport(file);

  assert.deepEqual(report.candidates, []);
  assert.match(report.unsupported[0]?.reason ?? "", /line 3.*malformed/i);
  assert.equal(readFileSync(file, "utf8"), original);
});

test("read-only import plan identifies one v3 branch, its Git scope and exact source bytes", (t) => {
  const { root, cwd } = sandbox(t);
  const file = join(root, "old-session.jsonl");
  const original = jsonl(cwd, [user("u1", null, "historic decision")]);
  writeFileSync(file, original);

  const report = planHistoricalImport(file);

  assert.equal(report.totalBytes, Buffer.byteLength(original));
  assert.equal(report.candidates.length, 1);
  assert.equal(report.candidates[0]?.leafId, "u1");
  assert.equal(report.candidates[0]?.workspace.cwdReal, cwd);
  assert.ok(report.candidates[0]?.workspace.repoKey, "Git scope is reported");
  assert.deepEqual(report.unsupported, []);
  assert.deepEqual(report.ambiguous, []);
  assert.equal(readFileSync(file, "utf8"), original, "planning never repairs or mutates the source");
});
