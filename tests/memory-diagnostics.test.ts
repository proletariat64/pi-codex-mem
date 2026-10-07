import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import extension from "../src/extension.ts";
import { defaultConfig } from "../src/config.ts";
import { persistentDiagnostics } from "../src/diagnostics.ts";
import { runDoctor } from "../src/doctor.ts";
import { RUN_CRITICAL_EVENTS } from "../src/pi/compat.ts";
import { v1PromptHash } from "../src/extraction/v1.ts";
import { openStateDb, recordSnapshot } from "../src/store/db.ts";
import { claimDueExtractions, commitExtraction, enqueueExtraction, localDay } from "../src/store/jobs.ts";
import { claimConsolidation, commitGeneration, finishConsolidation, getPublishedGeneration, selectConsolidation } from "../src/store/consolidation.ts";
import { addNote } from "../src/control/notes.ts";
import { makeMockPi } from "./mock-pi.ts";

const NOW = Date.UTC(2026, 8, 1, 12);
const RETRY = NOW + 60_000;

/** Create an isolated initialized store with fixed-time builders and automatic cleanup. */
function fixture(t: test.TestContext) {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-memory-diagnostics-"));
  const root = join(agentDir, "memory");
  const db = openStateDb(root);
  const config = defaultConfig("UTC");
  t.after(() => { if (db.isOpen) db.close(); rmSync(agentDir, { recursive: true, force: true }); });
  /** Capture an independent active source and enqueue its v1 extraction at the supplied time. */
  function source(id: string, capturedAt = NOW) {
    recordSnapshot(db, {
      workspace: { workspaceKey: "workspace", repoKey: null, checkoutKey: null, cwdReal: root,
        gitCommonDir: null, gitTopLevel: null, gitBranch: null, gitHead: null },
      session: { sessionKey: `session-${id}`, path: join(root, `${id}.jsonl`), headerId: id,
        parentKey: null, branchId: "branch", mode: "tui" },
      revision: { sourceId: id, lineageKey: `lineage-${id}`, revisionHash: id, leafId: id,
        snapshotPath: join(root, `${id}.json`), snapshotHash: id, sourceTime: capturedAt },
      capturedAt,
    });
    enqueueExtraction(db, { sourceId: id, memoryVersion: "v1", promptHash: v1PromptHash(), now: capturedAt });
  }
  /** Commit eligible v1 extraction/publication metadata without making any model calls. */
  function publish() {
    source("published-source", NOW - 86_400_000);
    const [job] = claimDueExtractions(db, { owner: "extractor", now: NOW - 1000, limit: 1 });
    assert.ok(job);
    assert.equal(commitExtraction(db, job, { memoryVersion: "v1", promptHash: v1PromptHash(),
      model: { provider: "fixture", modelId: "extract" }, rawMemory: "Use TypeScript",
      rolloutSummary: "TypeScript decision", rolloutSlug: "decision", outputHash: "output",
      usage: { input: 1, output: 1 }, outcome: "succeeded" }, NOW - 1000), true);
    const snapshot = selectConsolidation(db, { memoryVersion: "v1", now: NOW, extractionPromptHash: v1PromptHash() });
    assert.equal(snapshot.sources.length, 1);
    const lease = claimConsolidation(db, { memoryVersion: "v1", owner: "writer", promptHash: "writer", now: NOW - 1000 });
    assert.ok(lease);
    assert.equal(commitGeneration(db, { lease, snapshot, generation: { memoryVersion: "v1", generationId: "readable-v1",
      directory: join(root, "published"), manifestHash: "manifest", inputHash: snapshot.selectionHash }, now: NOW - 1000 }), true);
    assert.equal(getPublishedGeneration(db, "v1", NOW, { maxUnusedDays: config.schedule.maxUnusedDays,
      extractionPromptHash: v1PromptHash() })?.generationId, "readable-v1");
  }
  /** Persist an input-budget-denied consolidator and usage ledger with a chosen retry time. */
  function budgetWait(dueAt = RETRY) {
    const lease = claimConsolidation(db, { memoryVersion: "v1", owner: "writer", promptHash: "writer",
      inputRevisionHash: "recovery", now: NOW });
    assert.ok(lease);
    assert.equal(finishConsolidation(db, lease, "retry_wait", "input_budget", NOW, dueAt, { refundAttempt: true }), true);
    db.prepare(`INSERT INTO budget_usage (local_day, provider, model, actual_input, reserved_input,
      actual_output, reserved_output, call_count) VALUES (?, 'fixture', 'writer', 300000, 25, 400, 50, 7)`)
      .run(localDay(NOW, config.timezone));
  }
  return { agentDir, root, db, config, source, publish, budgetWait };
}

/** Run doctor against healthy environment probes and the fixture's persistent diagnostics. */
function doctor(f: ReturnType<typeof fixture>, now = NOW) {
  return runDoctor({
    compat: { supported: true, problems: [] },
    config: { status: "ok", config: f.config, path: join(f.root, "config.json") },
    paths: { memoryRoot: f.root, rootExists: true, rootWritable: true, rootIsCodex: false },
    store: { state: "current" }, models: { extract: { status: "unset" }, consolidate: { status: "unset" } },
    foreground: { status: "disabled", reason: "no_foreground_run", pinAvailable: false },
    observedEvents: [...RUN_CRITICAL_EVENTS], memory: persistentDiagnostics(f.db, f.config, now),
  });
}

/** Serialize relevant durable rows so tests detect diagnostic writes and budget consumption. */
function snapshot(db: DatabaseSync) {
  const queries = [
    "SELECT * FROM store_state ORDER BY rowid", "SELECT * FROM pipeline_state ORDER BY rowid",
    "SELECT * FROM jobs ORDER BY rowid", "SELECT * FROM generations ORDER BY rowid",
    "SELECT * FROM generation_sources ORDER BY rowid", "SELECT * FROM generation_pins ORDER BY rowid",
    "SELECT * FROM sessions ORDER BY rowid", "SELECT * FROM source_revisions ORDER BY rowid",
    "SELECT * FROM branch_heads ORDER BY rowid", "SELECT * FROM extractions ORDER BY rowid",
    "SELECT * FROM notes ORDER BY rowid", "SELECT * FROM note_applications ORDER BY rowid",
    "SELECT * FROM budget_usage ORDER BY rowid", "SELECT * FROM budget_reservations ORDER BY rowid",
    "SELECT * FROM version_run_grants ORDER BY rowid", "SELECT * FROM process_activity ORDER BY rowid",
    "SELECT * FROM source_stats ORDER BY rowid", "SELECT * FROM memory_usage ORDER BY rowid",
  ];
  return JSON.stringify(queries.map(query => db.prepare(query).all()));
}

/** Combine invalidation, idle extraction, an unpublished note and a budget-denied consolidator. */
function recovery(f: ReturnType<typeof fixture>) {
  f.publish();
  f.db.prepare("UPDATE pipeline_state SET read_blocked = 1, block_reason = 'evidence_removed' WHERE memory_version = 'v1'").run();
  f.source("pending-source");
  addNote({ root: f.root, db: f.db, action: "remember", text: "Prefer concise explanations", scope: "global",
    provenance: { consumerSession: "reader", runId: "run", userMessageId: "u1", origin: "tool" }, now: NOW });
  f.budgetWait();
}

/** Require recovery output to preserve both invalidation and actionable local-budget details. */
function assertRecovery(text: string) {
  assert.match(text, /selected memory \(v1\): UNAVAILABLE/);
  assert.match(text, /v1.*evidence_removed/);
  assert.match(text, /v1 consolidation: retry_wait.*input_budget/);
  assert.match(text, /last updated 2026-09-01T12:00:00\.000Z; denial day 2026-09-01 \(UTC\)/);
  assert.match(text, /scheduled retry; current admission unknown/);
  assert.match(text, /v1 extraction: queued.*pending idle window/);
  assert.match(text, /v1 readable generation: none/);
  assert.match(text, /v1 notes: 1 saved; 0 in readable publication; 1 pending publication/);
  assert.match(text, /plugin local daily background-model budget/);
  assert.match(text, /not provider quota, context window or session memory injection/);
  assert.match(text, /input used\/reserved\/limit: 300000 \/ 25/);
  assert.match(text, /output used\/reserved\/limit: 400 \/ 50/);
  assert.match(text, /requests used\/limit: 7/);
  assert.match(text, /2026-09-01 \(UTC\)/);
  assert.match(text, /estimated input\/output: unknown/);
  assert.match(text, /wait for the budget reset or adjust local limits/);
  assert.match(text, /--now skips idle waiting, not budget admission/);
}

test("invalidated memory and queued recovery remain visible without a foreground run", t => {
  const f = fixture(t); recovery(f);
  const diagnostics = persistentDiagnostics(f.db, f.config, NOW);
  assert.equal(diagnostics.selectedReadable, false);
  assert.equal(diagnostics.selectedInvalidated, true);
  assertRecovery(diagnostics.lines.join("\n"));
  const report = doctor(f);
  assert.equal(report.ok, false);
  assert.equal(report.probes.find(p => p.id === "memory")?.status, "fail");
  assert.equal(report.probes.find(p => p.id === "foreground")?.status, "ok");
  assert.match(report.format()[0]!, /environment OK; selected memory UNAVAILABLE/);
  assert.match(report.format().join("\n"), /idle: no_foreground_run/);
  assertRecovery(report.format().join("\n"));
});

test("empty publication recovery reports timezone and shared usage below the input limit", t => {
  const f = fixture(t);
  f.config.timezone = "Asia/Shanghai";
  f.config.limits.dailyInputTokens = 100_000;
  f.source("pending-source");
  f.db.prepare("UPDATE pipeline_state SET read_blocked = 1, block_reason = 'evidence_removed' WHERE memory_version = 'v1'").run();
  const midnight = Date.UTC(2026, 8, 1, 16);
  f.budgetWait(midnight);
  f.db.prepare("UPDATE budget_usage SET actual_input = 50000, reserved_input = 0").run();
  f.db.prepare(`INSERT INTO budget_usage (local_day, provider, model, actual_input)
    VALUES ('2026-09-01', 'other-provider', 'other-model', 7756)`).run();
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM generations").get()?.n, 0);
  const text = persistentDiagnostics(f.db, f.config, NOW).lines.join("\n");
  assert.match(text, /v1 readiness: read invalidated \(evidence_removed\)/);
  assert.match(text, /v1 readable generation: none/);
  assert.match(text, /v1 consolidation: retry_wait.*input_budget.*due 2026-09-01T16:00:00\.000Z/);
  assert.match(text, /v1 extraction: queued.*pending idle window/);
  assert.match(text, /budget day: 2026-09-01 \(Asia\/Shanghai\)/);
  assert.match(text, /input used\/reserved\/limit: 57756 \/ 0 \/ 100000/);
  assert.match(text, /estimated input\/output: unknown/);
  assert.match(text, /retry due does not mean published/);
  assert.equal(doctor(f).ok, false);
});

test("published selected memory stays readable during budget wait; another version is not a global failure", t => {
  const f = fixture(t); f.publish(); f.budgetWait();
  f.db.prepare("UPDATE pipeline_state SET read_blocked = 1, block_reason = 'evidence_removed' WHERE memory_version = 'v2'").run();
  const diagnostics = persistentDiagnostics(f.db, f.config, NOW);
  assert.equal(diagnostics.selectedReadable, true);
  assert.equal(diagnostics.selectedInvalidated, false);
  assert.match(diagnostics.lines.join("\n"), /v1 readable generation: readable-v1/);
  assert.match(diagnostics.lines.join("\n"), /v1 consolidation: retry_wait.*input_budget/);
  assert.match(diagnostics.lines.join("\n"), /v2 readiness: read invalidated/);
  const report = doctor(f);
  assert.equal(report.ok, true);
  assert.equal(report.probes.find(p => p.id === "memory")?.status, "ok");
  assert.match(report.format()[0]!, /environment OK; selected memory READABLE/);
});

test("first use reports warming_up and publication pending, not a recovery integrity failure", t => {
  const f = fixture(t);
  const diagnostics = persistentDiagnostics(f.db, f.config, NOW);
  assert.equal(diagnostics.selectedReadable, false);
  assert.equal(diagnostics.selectedInvalidated, false);
  assert.match(diagnostics.lines.join("\n"), /v1 readiness: warming_up/);
  assert.match(diagnostics.lines.join("\n"), /v1 readable generation: none.*initialization\/publication pending/);
  assert.doesNotMatch(diagnostics.lines.join("\n"), /input_budget|invalidation reason|budget scope/);
  const report = doctor(f);
  assert.equal(report.ok, true);
  assert.equal(report.probes.find(p => p.id === "memory")?.status, "warn");
});

test("superseded historical errors are not active recovery blockers", t => {
  const f = fixture(t); f.budgetWait(); f.source("pending-source");
  f.db.prepare("UPDATE jobs SET status = 'superseded', error_code = 'input_budget'").run();
  const text = persistentDiagnostics(f.db, f.config, NOW).lines.join("\n");
  assert.match(text, /v1 consolidation: not queued/);
  assert.match(text, /v1 extraction: not queued/);
  assert.doesNotMatch(text, /input_budget|superseded|budget scope/);
  assert.equal(doctor(f).ok, true);
});

test("a past due time is a prior denial, not proof of current budget admission; limits use current config", t => {
  const f = fixture(t); f.budgetWait(NOW - 1);
  f.config.limits.dailyInputTokens = 900_000;
  f.config.limits.dailyOutputTokens = 80_000;
  f.config.limits.dailyRequests = 90;
  const text = persistentDiagnostics(f.db, f.config, NOW).lines.join("\n");
  assert.match(text, /retry due; prior budget denial is not current admission/);
  assert.match(text, /current configured limits/);
  assert.match(text, /input used\/reserved\/limit: 300000 \/ 25 \/ 900000/);
  assert.match(text, /output used\/reserved\/limit: 400 \/ 50 \/ 80000/);
  assert.match(text, /requests used\/limit: 7 \/ 90/);
  assert.match(text, /admission uses used \+ reserved \+ estimated tokens/);
  assert.equal(f.db.prepare("SELECT status FROM jobs WHERE kind = 'consolidate'").get()?.status, "retry_wait");
});

for (const code of ["input_budget", "output_budget", "request_budget"]) {
  test(`extraction-only ${code} denial explains the local budget even without a consolidator`, t => {
    const f = fixture(t); f.source("pending-source");
    f.db.prepare("UPDATE jobs SET status = 'retry_wait', error_code = ?, due_at = ? WHERE kind = 'extract'")
      .run(code, RETRY);
    const text = persistentDiagnostics(f.db, f.config, NOW).lines.join("\n");
    assert.ok(text.includes(`v1 extraction: retry_wait — ${code}`));
    assert.match(text, /last budget denial; current admission unknown/);
    assert.match(text, /v1 consolidation: not queued/);
    assert.match(text, /budget scope: plugin local daily background-model budget/);
    assert.match(text, /--now skips idle waiting, not budget admission/);
    assert.equal(doctor(f).ok, true, "initial publication waiting for budget is not an integrity failure");
  });
}

test("budget reset reports today's usage separately from yesterday's denial", t => {
  const f = fixture(t); f.budgetWait();
  const nextDay = NOW + 86_400_000;
  const text = persistentDiagnostics(f.db, f.config, nextDay).lines.join("\n");
  assert.match(text, /denial day 2026-09-01 \(UTC\)/);
  assert.match(text, /budget day: 2026-09-02 \(UTC\)/);
  assert.match(text, /input used\/reserved\/limit: 0 \/ 0/);
  assert.match(text, /retry due; prior budget denial is not current admission/);
});

test("latest succeeded consolidation is visible without reviving superseded budget errors", t => {
  const f = fixture(t); f.publish(); f.budgetWait();
  f.db.prepare("UPDATE jobs SET status = 'superseded' WHERE kind = 'consolidate' AND status = 'retry_wait'").run();
  const text = persistentDiagnostics(f.db, f.config, NOW).lines.join("\n");
  assert.match(text, /v1 consolidation: succeeded/);
  assert.match(text, /v1 readable generation: readable-v1/);
  assert.doesNotMatch(text, /input_budget|budget scope/);
});

for (const status of ["queued", "succeeded"]) {
  test(`newer ${status} extraction does not hide another active source's budget wait`, t => {
    const f = fixture(t);
    f.source("older-source");
    f.db.prepare("UPDATE jobs SET status = 'retry_wait', error_code = 'input_budget', due_at = ? WHERE source_id = 'older-source'").run(RETRY);
    f.source("newer-source", NOW + 1000);
    f.db.prepare("UPDATE jobs SET status = ? WHERE source_id = 'newer-source'").run(status);
    const text = persistentDiagnostics(f.db, f.config, NOW + 2000).lines.join("\n");
    assert.ok(text.includes(`v1 extraction: ${status === "succeeded" ? "extracted" : "queued"}`));
    assert.match(text, /v1 extraction recovery: 1 retry_wait \(input_budget\); earliest job due 2026-09-01T12:01:00\.000Z/);
    assert.match(text, /budget scope: plugin local daily background-model budget/);
    assert.match(doctor(f, NOW + 2000).format().join("\n"), /extraction recovery: 1 retry_wait \(input_budget\)/);
  });
}

test("diagnostics and doctor are SELECT-only: no jobs, budgets, grants, pins or usage change", t => {
  const f = fixture(t); recovery(f);
  const before = snapshot(f.db);
  const changes = f.db.prepare("SELECT total_changes() AS n").get()?.n;
  f.db.exec("PRAGMA query_only = ON");
  for (let n = 0; n < 3; n++) { persistentDiagnostics(f.db, f.config, NOW); doctor(f).format(); }
  assert.equal(snapshot(f.db), before);
  assert.equal(f.db.prepare("SELECT total_changes() AS n").get()?.n, changes);
});

test("mock-pi status and doctor expose shared recovery blockers read-only with no model calls", async t => {
  const f = fixture(t); recovery(f);
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = f.agentDir;
  f.config.generate = false;
  writeFileSync(join(f.root, "config.json"), JSON.stringify(f.config));
  t.mock.method(Date, "now", () => NOW);
  const mock = makeMockPi();
  const notifications: string[] = [];
  let modelCalls = 0;
  const ctx = { cwd: process.cwd(), hasUI: true,
    ui: { notify: (text: string) => notifications.push(text) },
    sessionManager: { getBranch: () => [], getHeader: () => null, getLeafId: () => null, getSessionFile: () => undefined },
    modelRegistry: { find: () => undefined, streamSimple: () => { modelCalls++; throw new Error("diagnostics must not call models"); } },
  };
  t.after(async () => {
    await mock.fire("session_shutdown", {}, ctx);
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  });
  extension(mock.pi);
  await mock.fire("session_start", {}, ctx);
  const before = snapshot(f.db);
  for (const command of ["status", "doctor"]) {
    notifications.length = 0;
    await mock.commands.get("memory")!.handler(command, ctx);
    const text = notifications.join("\n");
    assertRecovery(text);
    assert.match(text, command === "status" ? /foreground: idle \(no_foreground_run\)/ : /idle: no_foreground_run/);
    assert.equal(snapshot(f.db), before, `${command} must not mutate persistent state`);
  }
  assert.equal(modelCalls, 0);
});
