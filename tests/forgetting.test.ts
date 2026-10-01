import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStateDb } from "../src/store/db.ts";
import { captureSettledSession } from "../src/capture.ts";
import { forgetEvidence } from "../src/control/forget.ts";
import { defaultConfig } from "../src/config.ts";
import { ConsolidationScheduler } from "../src/pipeline/scheduler.ts";
import { acquireEvidencePin } from "../src/read/evidence.ts";
import { createMemoryTools } from "../src/read/tools.ts";
import { planHistoricalImport, enrollHistoricalImport } from "../src/historical-import.ts";
import { claimDueExtractions, commitExtraction, enqueueExtraction } from "../src/store/jobs.ts";

function fixture(t: test.TestContext) {
  const base = mkdtempSync(join(tmpdir(), "pi-forget-")); const cwd = join(base, "repo"); mkdirSync(cwd);
  execFileSync("git", ["init", "-q"], { cwd });
  const agentDir = join(base, "agent"); const root = join(agentDir, "memory"); const db = openStateDb(root);
  t.after(() => { if (db.isOpen) db.close(); rmSync(base, { recursive: true, force: true }); });
  const file = join(base, "session.jsonl");
  const header = { type: "session", version: 3, id: "session", cwd, timestamp: new Date().toISOString() };
  const entries = [{ type: "message", id: "u1", parentId: null as string | null, timestamp: new Date().toISOString(),
    message: { role: "user", content: [{ type: "text", text: "Forgettable decision" }], timestamp: Date.now() } }];
  const save = () => writeFileSync(file, [header, ...entries].map(value => JSON.stringify(value)).join("\n") + "\n"); save();
  const reader = { getBranch: () => entries as never, getHeader: () => header as never, getSessionFile: () => file,
    getLeafId: () => entries.at(-1)!.id };
  const capture = () => captureSettledSession({ root, agentDir, cwd, db, mode: "tui", reader });
  return { root, db, agentDir, file, entries, save, capture };
}

test("forget source suppresses every lineage revision durably before deleting snapshots and rejects live/import re-enrollment", (t) => {
  const f = fixture(t); const first = f.capture(); assert.equal(first.status, "captured");
  f.entries.push({ ...f.entries[0]!, id: "u2", parentId: "u1" }); f.save();
  const second = f.capture(); assert.equal(second.status, "captured");
  const now = Date.now();
  enqueueExtraction(f.db, { sourceId: second.sourceId, memoryVersion: "v1", promptHash: "extract-v1", now });
  const [v1] = claimDueExtractions(f.db, { owner: "writer", now, limit: 1 }); assert.ok(v1);
  assert.equal(commitExtraction(f.db, v1, { memoryVersion: "v1", promptHash: "extract-v1", model: { provider: "fixture", modelId: "extract" },
    rawMemory: "private extracted decision", rolloutSummary: "private extracted decision", rolloutSlug: "decision", outputHash: "hash",
    usage: { input: 1, output: 1 }, outcome: "succeeded" }, now), true);
  enqueueExtraction(f.db, { sourceId: second.sourceId, memoryVersion: "v2", promptHash: "extract-v2", now });
  const [late] = claimDueExtractions(f.db, { owner: "late-writer", now, limit: 1 }); assert.ok(late);
  const result = forgetEvidence({ root: f.root, db: f.db, kind: "source", id: first.sourceId });
  assert.equal(result.forgotten, true); assert.equal(result.affectedRevisions, 2);
  assert.equal(existsSync(first.snapshotPath), false); assert.equal(existsSync(second.snapshotPath), false);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM extractions").get()!.n, 0);
  assert.equal(commitExtraction(f.db, late, { memoryVersion: "v2", promptHash: "extract-v2", model: { provider: "fixture", modelId: "extract" },
    rawMemory: null, rolloutSummary: "private late decision", rolloutSlug: "decision", outputHash: "late-hash",
    usage: { input: 1, output: 1 }, outcome: "succeeded", truncation: { truncated: false, originalBytes: 21, acceptedBytes: 21 } }, now + 1), false);
  assert.match(result.explanation, /original pi transcripts/i);
  assert.match(result.explanation, /provider/); assert.match(result.explanation, /in-flight/);
  assert.equal(f.capture().status, "skipped");
  const plan = planHistoricalImport(f.file);
  assert.equal(enrollHistoricalImport(plan, { root: f.root, agentDir: f.agentDir, db: f.db,
    limits: { itemBytes: 65536, toolResultBytes: 8192, totalBytes: 262144 } }).imported, 0);
  assert.match(readFileSync(f.file, "utf8"), /Forgettable decision/);
  f.db.close(); const reopened = openStateDb(f.root); t.after(() => reopened.close());
  assert.equal(reopened.prepare("SELECT COUNT(*) AS n FROM suppression_tombstones").get()!.n, 1);
  assert.equal(reopened.prepare("SELECT COUNT(*) AS n FROM source_revisions WHERE status = 'captured'").get()!.n, 0);
  assert.equal(readFileSync(join(f.root, "state.sqlite")).includes(Buffer.from("private extracted decision")), false);
});

test("forget session blocks future branches and revokes both pinned views even without a provider", async (t) => {
  const f = fixture(t); const config = defaultConfig("UTC"); config.dualWrite = true;
  const scheduler = new ConsolidationScheduler({ root: f.root, db: f.db, config: () => config, modelPort: () => null,
    now: Date.now, isForegroundIdle: () => true });
  await scheduler.runPass(); await scheduler.stop();
  const view = acquireEvidencePin({ root: f.root, db: f.db, memoryVersion: "v1" }); assert.ok(view);
  const tools = createMemoryTools({ root: f.root, db: () => f.db, pin: () => view, consumer: () => null });
  const captured = f.capture(); assert.equal(captured.status, "captured");
  const result = forgetEvidence({ root: f.root, db: f.db, kind: "session", id: captured.sessionKey });
  assert.equal(result.forgotten, true);
  for (const memoryVersion of ["v1", "v2"] as const) assert.equal(acquireEvidencePin({ root: f.root, db: f.db, memoryVersion }), null);
  assert.equal((await tools.find(tool => tool.name === "pi_memory_list")!.execute("call", {}, undefined)).details.error, "memory_unavailable");
  f.entries.splice(0, f.entries.length, { ...f.entries[0]!, id: "another-root", parentId: null }); f.save();
  assert.equal(f.capture().status, "skipped", "session tombstone includes branches not yet captured");
  assert.equal(forgetEvidence({ root: f.root, db: f.db, kind: "source", id: "unknown" }).forgotten, false);
});
