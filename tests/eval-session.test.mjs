import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planHistoricalImport, enrollHistoricalImport } from "../src/historical-import.ts";
import { openStateDb } from "../src/store/db.ts";
import { forgetEvidence } from "../src/control/forget.ts";
import { buildSessionJsonl, selectedLeafId } from "../eval/session.mjs";

const NOW = Date.UTC(2026, 8, 29);
test("evaluation source JSONL imports the selected branch without the abandoned alternative", (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-eval-source-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const session = { id: "s1", selectedLeaf: "u2", messages: [
    { id: "u1", role: "user", text: "Which database?" },
    { id: "a1", role: "assistant", text: "Discarded proposal A" },
    { id: "u2", parentId: "u1", role: "user", text: "Choose B instead" },
  ] };
  const path = join(cwd, "source.jsonl");
  writeFileSync(path, buildSessionJsonl("C05", session, cwd, NOW));
  const report = planHistoricalImport(path, { leaf: selectedLeafId(session) });
  assert.deepEqual(report.unsupported, []);
  assert.deepEqual(report.ambiguous, []);
  assert.deepEqual(report.candidates[0]?.branch.map(entry => entry.id), ["s1-u1", "s1-u2"]);
  assert.equal(report.candidates[0]?.header.cwd, cwd);
  const agentDir = join(cwd, "agent");
  const root = join(agentDir, "memory");
  const db = openStateDb(root);
  try {
    const enrolled = enrollHistoricalImport(report, { db, root, agentDir,
      limits: { itemBytes: 65_536, toolResultBytes: 8_192, totalBytes: 262_144 } });
    assert.deepEqual(enrolled, { imported: 1, skipped: [] });
    const revision = db.prepare("SELECT snapshot_path FROM source_revisions").get();
    const snapshot = readFileSync(revision.snapshot_path, "utf8");
    assert.match(snapshot, /Choose B instead/);
    assert.doesNotMatch(snapshot, /Discarded proposal A/);
  } finally { db.close(); }
});

test("all 30 evaluation fixtures render unambiguous import plans with supported evidence", (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-eval-all-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const cases = JSON.parse(readFileSync(new URL("../eval/cases.json", import.meta.url), "utf8"));
  let sources = 0;
  for (const item of cases) for (const [index, session] of item.sourceSessions.entries()) {
    const path = join(cwd, `${item.id}-${session.id}.jsonl`);
    writeFileSync(path, buildSessionJsonl(item.id, session, cwd, NOW, index));
    const plan = planHistoricalImport(path, { leaf: selectedLeafId(session) });
    assert.deepEqual(plan.unsupported, [], `${item.id}/${session.id} unsupported`);
    assert.deepEqual(plan.ambiguous, [], `${item.id}/${session.id} ambiguous`);
    assert.equal(plan.candidates.length, 1, `${item.id}/${session.id} eligible`);
    sources++;
  }
  assert.ok(sources >= 30);
});

test("forgotten fixture revokes only the selected source session before answering", (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-eval-forget-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const item = JSON.parse(readFileSync(new URL("../eval/cases.json", import.meta.url), "utf8"))
    .find(value => value.id === "N05");
  assert.deepEqual(item.forgetBeforeAnswer, ["s1"]);
  assert.ok(!item.curatedSummary.includes("amber-orchid-47"));
  const agentDir = join(cwd, "agent"); const root = join(agentDir, "memory");
  const db = openStateDb(root);
  try {
    for (const [index, session] of item.sourceSessions.entries()) {
      const path = join(cwd, `${session.id}.jsonl`);
      writeFileSync(path, buildSessionJsonl(item.id, session, cwd, NOW, index));
      const report = planHistoricalImport(path);
      const result = enrollHistoricalImport(report, { db, root, agentDir,
        limits: { itemBytes: 65_536, toolResultBytes: 8_192, totalBytes: 262_144 } });
      assert.equal(result.imported, 1);
    }
    const forgottenKey = db.prepare("SELECT session_key FROM sessions WHERE path = ?").get(join(cwd, "s1.jsonl"));
    assert.equal(forgetEvidence({ db, root, kind: "session", id: forgottenKey.session_key, now: NOW }).forgotten, true);
    const rows = db.prepare("SELECT s.path, r.status FROM source_revisions r JOIN sessions s ON s.session_key = r.session_key").all();
    assert.equal(rows.find(row => row.path.endsWith("s1.jsonl"))?.status, "privacy_revoked");
    assert.equal(rows.find(row => row.path.endsWith("s2.jsonl"))?.status, "captured");
  } finally { db.close(); }
});

test("evaluation tool evidence keeps tool-result role for production normalization", (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-eval-tool-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const path = join(cwd, "source.jsonl");
  writeFileSync(path, buildSessionJsonl("N01", { id: "s1", messages: [
    { id: "u1", role: "user", text: "Do we have approval?" },
    { id: "t1", role: "tool", text: "Build ran but approval not recorded." },
  ] }, cwd, NOW));
  const report = planHistoricalImport(path);
  assert.deepEqual(report.unsupported, []);
  const branch = report.candidates[0]?.branch;
  assert.deepEqual(branch?.map(entry => entry.type), ["message", "message", "message"]);
  assert.equal(branch?.[1]?.message.role, "assistant");
  assert.equal(branch?.[1]?.message.content[0].id, branch?.[2]?.message.toolCallId);
  assert.equal(branch?.[2]?.message.role, "toolResult");
  const agentDir = join(cwd, "agent"); const root = join(agentDir, "memory");
  const db = openStateDb(root);
  try {
    const result = enrollHistoricalImport(report, { db, root, agentDir,
      limits: { itemBytes: 65_536, toolResultBytes: 8_192, totalBytes: 262_144 } });
    assert.equal(result.imported, 1);
    const revision = db.prepare("SELECT snapshot_path FROM source_revisions").get();
    assert.match(readFileSync(revision.snapshot_path, "utf8"), /Build ran but approval not recorded/);
  } finally { db.close(); }
});
