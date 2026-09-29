import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openStateDb } from "../src/store/db.ts";
import { defaultConfig, loadConfig, updateConfig } from "../src/config.ts";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { addNote } from "../src/control/notes.ts";
import { clearMemoryStore, resumeClear } from "../src/control/forget.ts";

function fixture(t: test.TestContext) {
  const base = mkdtempSync(join(tmpdir(), "pi-clear-")); const root = join(base, "memory"); const db = openStateDb(root);
  t.after(() => { if (db.isOpen) db.close(); rmSync(base, { recursive: true, force: true }); });
  writeFileSync(join(root, "config.json"), JSON.stringify(defaultConfig("UTC")));
  const original = join(base, "session.jsonl"); writeFileSync(original, '{"original":"preserve"}\n');
  const note = addNote({ root, db, action: "remember", text: "private preference", scope: "global",
    provenance: { consumerSession: null, runId: null, userMessageId: null, origin: "command" } });
  for (const version of ["v1", "v2"]) {
    const directory = join(root, "versions", version, "generations", "old"); mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "memory_summary.md"), "private old guidance");
  }
  return { root, db, original, note };
}
test("clear requires confirmation and removes shared data while durably disabling capture and generation", (t) => {
  const f = fixture(t);
  assert.throws(() => clearMemoryStore({ root: f.root, db: f.db, confirmed: false }), /confirmation/);
  assert.equal(existsSync(f.note.textPath), true);
  const result = clearMemoryStore({ root: f.root, db: f.db, confirmed: true });
  assert.equal(result.cleanupPending, false); assert.equal(f.db.isOpen, false);
  assert.equal(existsSync(join(f.root, "state.sqlite")), false); assert.equal(existsSync(f.note.textPath), false);
  assert.equal(existsSync(join(f.root, "versions")), false);
  assert.equal(readFileSync(f.original, "utf8"), '{"original":"preserve"}\n');
  const loaded = loadConfig(f.root, { create: false }); assert.equal(loaded.status, "ok");
  assert.equal(loaded.config.enabled, false); assert.equal(loaded.config.generate, false); assert.equal(loaded.config.read, false);
});
test("a reader delaying secure deletion leaves clear pending and disabled; restart completes after reader exits", (t) => {
  const f = fixture(t); const reader = new DatabaseSync(join(f.root, "state.sqlite")); t.after(() => { if (reader.isOpen) reader.close(); });
  reader.exec("BEGIN"); reader.prepare("SELECT * FROM notes").all();
  const result = clearMemoryStore({ root: f.root, db: f.db, confirmed: true });
  assert.equal(result.cleanupPending, true); assert.equal(existsSync(join(f.root, "clear.pending")), true);
  reader.exec("ROLLBACK"); reader.close();
  assert.equal(resumeClear(f.root).cleanupPending, false);
  assert.equal(existsSync(join(f.root, "state.sqlite")), false);
  assert.equal(existsSync(join(f.root, "clear.pending")), false);
});

test("clear fences a concurrent enable command between disabling configuration and creating its marker", (t) => {
  const f = fixture(t); const originalOpen = fs.openSync;
  let attempted = false;
  fs.openSync = (...args: Parameters<typeof fs.openSync>) => {
    if (!attempted && args[0] === join(f.root, "clear.pending")) {
      attempted = true;
      updateConfig(f.root, config => ({ ...config, enabled: true, read: true, generate: true }), { maxAttempts: 1 });
    }
    return originalOpen(...args);
  };
  syncBuiltinESMExports();
  try {
    assert.equal(clearMemoryStore({ root: f.root, db: f.db, confirmed: true }).cleanupPending, false);
    assert.equal(attempted, true);
    const actual = JSON.parse(readFileSync(join(f.root, "config.json"), "utf8"));
    assert.equal(actual.enabled, false); assert.equal(actual.read, false); assert.equal(actual.generate, false);
  } finally { fs.openSync = originalOpen; syncBuiltinESMExports(); }
});
