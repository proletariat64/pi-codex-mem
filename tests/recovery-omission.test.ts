import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStateDb } from "../src/store/db.ts";
import { captureSettledSession } from "../src/capture.ts";
import { readSnapshotText } from "../src/store/snapshot-files.ts";

/**
 * Pi appends a null-replacement context_edit when it abandons an empty or
 * failed assistant attempt. Capture must treat that as recovery bookkeeping,
 * not as a privacy revocation that fences the read views (§7.1, §10).
 */
function fixture(t: test.TestContext) {
  const base = mkdtempSync(join(tmpdir(), "pi-recovery-omission-"));
  const cwd = join(base, "repo"); mkdirSync(cwd);
  execFileSync("git", ["init", "-q"], { cwd });
  const agentDir = join(base, "agent"); const root = join(agentDir, "memory"); const db = openStateDb(root);
  t.after(() => { if (db.isOpen) db.close(); rmSync(base, { recursive: true, force: true }); });
  const file = join(base, "session.jsonl");
  const header = { type: "session", version: 3, id: "session", cwd, timestamp: new Date().toISOString() };
  const entries: Record<string, unknown>[] = [{
    type: "message", id: "u1", parentId: null, timestamp: new Date().toISOString(),
    message: { role: "user", content: [{ type: "text", text: "Durable decision text" }], timestamp: Date.now() },
  }];
  const save = () => writeFileSync(file, [header, ...entries].map(value => JSON.stringify(value)).join("\n") + "\n");
  save();
  const reader = { getBranch: () => entries as never, getHeader: () => header as never,
    getSessionFile: () => file, getLeafId: () => String(entries.at(-1)!.id) };
  const capture = () => captureSettledSession({ root, agentDir, cwd, db, mode: "tui", reader });
  return { root, db, entries, save, capture, cwd, agentDir, reader };
}

function emptyAssistant(id: string, parentId: string) {
  return {
    type: "message", id, parentId, timestamp: new Date().toISOString(),
    message: {
      role: "assistant", content: [],
      api: "openai-completions", provider: "fixture", model: "m",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "aborted", timestamp: Date.now(),
    },
  };
}

const omission = (id: string, parentId: string, targetId: string) =>
  ({ type: "context_edit", id, parentId, timestamp: new Date().toISOString(), targetId, replacement: null });

const readBlocked = (db: ReturnType<typeof openStateDb>) =>
  db.prepare("SELECT read_blocked, block_reason FROM pipeline_state WHERE memory_version = 'v1'")
    .get() as { read_blocked: number; block_reason: string | null };

test("recovery omission of an empty assistant attempt does not fence or revoke (hotfix)", (t) => {
  const f = fixture(t);
  assert.equal(f.capture().status, "captured");
  f.entries.push(emptyAssistant("a1", "u1"), omission("e1", "a1", "a1"));
  f.save();
  assert.equal(f.capture().status, "captured");
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM privacy_edit_targets").get()!.n, 0,
    "no privacy target recorded for a text-free omission");
  assert.equal(readBlocked(f.db).read_blocked, 0, "read views stay available");
  assert.equal(readBlocked(f.db).block_reason, null, "no context_edit block reason");
});

test("omission of an entry that exported text still fences and revokes", (t) => {
  const f = fixture(t);
  assert.equal(f.capture().status, "captured");
  f.entries.push({
    type: "message", id: "u2", parentId: "u1", timestamp: new Date().toISOString(),
    message: { role: "user", content: [{ type: "text", text: "Forget this line" }], timestamp: Date.now() },
  });
  f.save();
  const second = f.capture(); assert.equal(second.status, "captured");
  f.entries.push(omission("e2", "u2", "u2"));
  f.save();
  assert.equal(f.capture().status, "captured");
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM privacy_edit_targets").get()!.n, 1);
  assert.equal(readBlocked(f.db).read_blocked, 1, "text removal still blocks both views");
  assert.equal(readBlocked(f.db).block_reason, "context_edit");
  const revoked = f.db.prepare("SELECT COUNT(*) AS n FROM source_revisions WHERE status = 'privacy_revoked'").get()!.n;
  assert.ok(Number(revoked) >= 1, "the snapshot containing the removed text is revoked");
});

test("replacement edit on a text entry is still recorded as privacy policy", (t) => {
  const f = fixture(t);
  assert.equal(f.capture().status, "captured");
  f.entries.push({
    type: "context_edit", id: "e3", parentId: "u1", timestamp: new Date().toISOString(),
    targetId: "u1", replacement: { content: [{ type: "text", text: "[redacted]" }] },
  });
  f.save();
  assert.equal(f.capture().status, "captured");
  const row = f.db.prepare("SELECT allowed_hashes FROM privacy_edit_targets WHERE entry_id = 'u1'")
    .get() as { allowed_hashes: string } | undefined;
  assert.ok(row, "replacement keeps its allowed-hash policy");
  assert.ok(row!.allowed_hashes.length > 2);
});

test("input-budget rotation of older items is not removed evidence", (t) => {
  const f = fixture(t);
  const limits = { itemBytes: 64 * 1024, toolResultBytes: 8 * 1024, totalBytes: 4096 };
  const capture = () => captureSettledSession({ root: f.root, agentDir: f.agentDir, cwd: f.cwd, db: f.db,
    mode: "tui", reader: f.reader, limits });
  assert.equal(capture().status, "captured");
  // Grow the branch past the total budget so the oldest items rotate out.
  for (let index = 0; index < 12; index++) {
    f.entries.push({ type: "message", id: `u${index + 2}`, parentId: `u${index + 1}`,
      timestamp: new Date().toISOString(),
      message: { role: "user", content: [{ type: "text", text: `budget filler ${index} `.repeat(30) }], timestamp: Date.now() } });
  }
  f.save();
  assert.equal(capture().status, "captured");
  const omissions = f.db.prepare("SELECT COUNT(*) AS n FROM source_revisions").get()!.n;
  assert.ok(Number(omissions) >= 2);
  assert.equal(readBlocked(f.db).read_blocked, 0, "budget rotation must not fence the read views");
  const newest = f.db.prepare("SELECT snapshot_path FROM source_revisions ORDER BY captured_at DESC LIMIT 1")
    .get() as { snapshot_path: string };
  const decoded = JSON.parse(readSnapshotText(newest.snapshot_path)) as { omissions: { reason: string }[] };
  assert.ok(decoded.omissions.some((omission) => omission.reason === "budget-exceeded"),
    "the fixture really dropped items for budget reasons");
});
