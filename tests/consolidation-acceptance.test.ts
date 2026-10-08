import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream, type Api, type AssistantMessage, type JsonObject, type Model, type TranscriptContext } from "@earendil-works/pi-ai";
import { defaultConfig, type MemoryVersion } from "../src/config.ts";
import { openStateDb, recordSnapshot, recordCapturePrivacy } from "../src/store/db.ts";
import { claimDueExtractions, enqueueExtraction, commitExtraction } from "../src/store/jobs.ts";
import { claimConsolidation, finishConsolidation, getPublishedGeneration, selectConsolidation } from "../src/store/consolidation.ts";
import { v1PromptHash } from "../src/extraction/v1.ts";
import { v2PromptHash } from "../src/extraction/v2.ts";
import { addNote, forgetNote } from "../src/control/notes.ts";
import { forgetEvidence } from "../src/control/forget.ts";
import { ConsolidationScheduler } from "../src/pipeline/scheduler.ts";
import { consolidationPromptHash } from "../src/pipeline/consolidate.ts";
import { prepareGenerationCandidate } from "../src/pipeline/candidate.ts";
import type { ConsolidationModelPort } from "../src/pipeline/model-port.ts";
import { textHash } from "../src/pipeline/staging.ts";
import { persistentDiagnostics } from "../src/diagnostics.ts";
import { acquireEvidencePin } from "../src/read/evidence.ts";
import { MINIMAL_V1_SUMMARY } from "../src/pipeline/validate.ts";

const NOW = Date.UTC(2026, 8, 29);
const model: Model<Api> = { id: "acceptance", name: "Deterministic mock", api: "openai-completions", provider: "mock",
  baseUrl: "https://unused.invalid", reasoning: false, input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 60_000, maxTokens: 8_000 };
const provenance = { consumerSession: "test", runId: "test", userMessageId: "u1", origin: "command" as const };
const tool = (id: string, name: string, args: JsonObject) => ({ type: "toolCall" as const, id, name, arguments: args });
const reply = (content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage => ({
  role: "assistant", content, stopReason, api: model.api, model: model.id, provider: model.provider, timestamp: NOW,
  // Synthetic usage is deliberately not a token-accuracy measurement.
  usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
});
function fixture(t: test.TestContext, version: MemoryVersion) {
  const root = mkdtempSync(join(tmpdir(), "pi-context-acceptance-"));
  const db = openStateDb(root);
  const config = defaultConfig("UTC");
  config.version = version; config.models.consolidate = { provider: model.provider, modelId: model.id };
  // Fixture budgets, not shipped defaults. All calls share these budgets and the shipped 12/40/300s ceilings.
  config.limits.dailyInputTokens = 1_000_000;
  config.limits.dailyOutputTokens = 50_000;
  config.limits.dailyRequests = 12;
  const calls: TranscriptContext[] = [];
  const errors: string[] = [];
  let steps: ((context: TranscriptContext) => AssistantMessage | Promise<AssistantMessage>)[] = [];
  let baseCall = 0;
  const port: ConsolidationModelPort = { resolve: () => model, stream: (_model, context) => {
    calls.push(structuredClone(context));
    const step = steps[calls.length - baseCall - 1];
    assert.ok(step, `unexpected request ${calls.length - baseCall}`);
    const stream = createAssistantMessageEventStream();
    void (async () => {
      try {
        const message = await step(context);
        if (message.stopReason === "error" || message.stopReason === "aborted") stream.push({ type: "error", reason: message.stopReason, error: message });
        else stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse" | "length", message });
      } catch (error) { errors.push(String(error)); stream.push({ type: "error", reason: "error", error: { ...reply([]), stopReason: "error", errorMessage: String(error) } }); }
    })();
    return stream;
  } };
  const scheduler = new ConsolidationScheduler({ db, root, config: () => structuredClone(config), modelPort: () => port,
    now: () => NOW, isForegroundIdle: () => true,
    timer: { schedule: () => ({ cancel() {} }) } });
  t.after(async () => { await scheduler.stop(); db.close(); rmSync(root, { recursive: true, force: true }); });
  function source(id: string, padding = 0) {
    recordSnapshot(db, {
      workspace: { workspaceKey: "synthetic", repoKey: null, checkoutKey: null, cwdReal: root,
        gitCommonDir: null, gitTopLevel: null, gitBranch: null, gitHead: null },
      session: { sessionKey: `session-${id}`, path: join(root, `${id}.jsonl`), headerId: id, parentKey: null, branchId: "branch", mode: "tui" },
      revision: { sourceId: id, lineageKey: `lineage-${id}`, revisionHash: id, leafId: id, snapshotPath: join(root, `${id}.json`), snapshotHash: id, sourceTime: NOW - 1_000 },
      capturedAt: NOW - 1_000,
    });
    const promptHash = version === "v1" ? v1PromptHash() : v2PromptHash();
    enqueueExtraction(db, { sourceId: id, memoryVersion: version, promptHash, now: NOW });
    const [job] = claimDueExtractions(db, { owner: "fixture", now: NOW, limit: 1 }); assert.ok(job);
    const summary = `Synthetic ${id}: exact route /api/${id}; conflict: use old route only before correction. ` + "bounded fixture detail ".repeat(padding);
    assert.equal(commitExtraction(db, job, { memoryVersion: version, promptHash,
      model: { provider: "mock", modelId: "extract" }, rawMemory: version === "v1" ? summary : null,
      rolloutSummary: summary, rolloutSlug: id, outputHash: textHash(summary), usage: { input: 1, output: 1 }, outcome: "succeeded",
      truncation: version === "v2" ? { truncated: false, originalBytes: Buffer.byteLength(summary), acceptedBytes: Buffer.byteLength(summary) } : undefined }, NOW), true);
  }
  const note = () => addNote({ root, db, action: "remember", text: "Correction fixture: route /api/source-255 supersedes /api/old; keep scope exact.", scope: "global", provenance, now: NOW });
  const script = (next: typeof steps) => { steps = next; baseCall = calls.length; };
  const largeTurn = () => reply([{ type: "text", text: "界".repeat(40_000) }, tool("list", "workspace_list", {})], "toolUse");
  return { root, db, config, calls, errors, scheduler, source, note, script, largeTurn };
}

for (const version of ["v1", "v2"] as const) {
  test(`CT09 ${version}: 256 selected sources retain manifest evidence through actual paged-history compaction`, async (t) => {
    const f = fixture(t, version);
    for (let i = 0; i < 256; i++) f.source(`source-${String(i).padStart(3, "0")}`, 24);
    const note = f.note();
    f.script([
      () => reply(Array.from({ length: 8 }, (_, i) => tool(`read-${i}`, "workspace_read", {
        path: "phase2_workspace_diff.md", startLine: 1 + i * 30, maxLines: 300,
      })), "toolUse"),
      context => {
        assert.ok(context.messages[0]?.role === "system" && !context.messages[0].toolsAdded?.length, "real compactor transport is tool-free");
        assert.equal(context.messages.filter(m => m.role === "toolResult").length, 8);
        return reply([{ type: "text", text: "Derived summary: staged sources and corrections remain authoritative. Next write outputs; reread originals for exact routes." }]);
      },
      context => {
        assert.match(JSON.stringify(context.messages), /Derived working-context summary/);
        return reply([
          ...(version === "v1" ? [tool("handbook", "workspace_write", { path: "MEMORY.md", content: "# Memory\n\nSynthetic protocol fixture; source semantics are not evaluated by this mock.\n" })] : []),
          tool("summary", "workspace_write", { path: "memory_summary.md", content: MINIMAL_V1_SUMMARY }),
        ], "toolUse");
      },
      () => reply([{ type: "text", text: "Done" }]),
    ]);
    const start = performance.now();
    const result = await f.scheduler.runPass();
    assert.deepEqual(result, [{ status: "published" }], JSON.stringify({ errors: f.errors, messages: f.calls.map(c => c.messages.map(m => m.role)), diagnostics: persistentDiagnostics(f.db, f.config, NOW).lines }));
    const elapsedMs = performance.now() - start;
    const generation = getPublishedGeneration(f.db, version, NOW); assert.ok(generation);
    const text = readFileSync(join(generation.directory, "manifest.json"), "utf8");
    assert.equal(textHash(text), generation.manifestHash);
    const manifest = JSON.parse(text);
    assert.equal(manifest.sources.length, 256);
    assert.equal(new Set(manifest.sources.map((s: { sourceId: string }) => s.sourceId)).size, 256);
    assert.equal(manifest.notes[0].noteId, note.noteId);
    for (const evidence of [...manifest.sources, ...manifest.notes]) assert.ok(existsSync(join(generation.directory, evidence.path)));
    const diagnostics = persistentDiagnostics(f.db, f.config, NOW);
    const lines = diagnostics.lines.join("\n");
    assert.equal(diagnostics.selectedReadable, true);
    assert.match(lines, /selected sources=256; selected notes=1/);
    assert.match(lines, /requests=4; tools=(?:9|10); compactions=1/);
    assert.equal(f.calls.length, 4);
    assert.ok(elapsedMs < 300_000);
    assert.equal(existsSync(join(generation.directory, "MEMORY.md")), version === "v1");
    t.diagnostic(JSON.stringify({ fixture: "CT09", version, model: "mock/acceptance", counting: "utf8_div4_estimate", selected: 256, notes: 1,
      requests: 4, tools: version === "v1" ? 10 : 9, compactions: 1, elapsedMs, available: diagnostics.selectedReadable,
      dailyInput: 1_000_000, dailyOutput: 50_000, dailyRequests: 12, semanticCoverage: "not measured" }));
  });

  test(`CT11 ${version}: revoked baseline plaintext never reaches rebuilt diffs, compactor requests or publication`, async (t) => {
    const f = fixture(t, version); f.source("source-000"); f.note();
    const sentinel = "REVOKED_BASELINE_PRIVATE_SENTINEL";
    f.script([
      () => reply([
        ...(version === "v1" ? [tool("handbook", "workspace_write", { path: "MEMORY.md", content: `# Memory\\n\\n${sentinel}\\n` })] : []),
        tool("summary", "workspace_write", { path: "memory_summary.md", content: MINIMAL_V1_SUMMARY.replace("## User Profile\n", `## User Profile\n- ${sentinel}\n`) }),
      ], "toolUse"), () => reply([{ type: "text", text: "Done" }]),
    ]);
    assert.deepEqual(await f.scheduler.runPass(), [{ status: "published" }]);
    assert.equal(forgetEvidence({ root: f.root, db: f.db, kind: "source", id: "source-000", now: NOW }).forgotten, true);
    f.source("source-001");
    const rebuiltStart = f.calls.length;
    f.script([
      f.largeTurn,
      context => { assert.doesNotMatch(JSON.stringify(context), new RegExp(sentinel)); return reply([{ type: "text", text: "Derived new eligible evidence only." }]); },
      context => {
        assert.doesNotMatch(JSON.stringify(context), new RegExp(sentinel));
        return reply([
          ...(version === "v1" ? [tool("handbook", "workspace_write", { path: "MEMORY.md", content: "# Memory\\n\\nNew eligible evidence.\\n" })] : []),
          tool("summary", "workspace_write", { path: "memory_summary.md", content: MINIMAL_V1_SUMMARY }),
        ], "toolUse");
      }, () => reply([{ type: "text", text: "Done" }]),
    ]);
    assert.deepEqual(await f.scheduler.runPass(), [{ status: "published" }]);
    assert.equal(f.calls.length - rebuiltStart, 4);
    for (const request of f.calls.slice(rebuiltStart)) assert.doesNotMatch(JSON.stringify(request), new RegExp(sentinel));
    const published = getPublishedGeneration(f.db, version, NOW); assert.ok(published);
    const manifest = JSON.parse(readFileSync(join(published.directory, "manifest.json"), "utf8"));
    assert.deepEqual(manifest.sources.map((source: { sourceId: string }) => source.sourceId), ["source-001"]);
    assert.doesNotMatch(readFileSync(join(published.directory, "phase2_workspace_diff.md"), "utf8"), new RegExp(sentinel));
    for (const path of Object.keys(manifest.fileHashes)) assert.doesNotMatch(readFileSync(join(published.directory, path), "utf8"), new RegExp(sentinel));
  });

  test(`CT13 ${version}: upgrade and rollback preserve notes, enrollment, charged usage and legacy hash-verified manifests`, async (t) => {
    const f = fixture(t, version); f.config.schedule.maxConsolidationSources = 8;
    f.source("source-000"); const note = f.note();
    f.script([
      () => reply([
        ...(version === "v1" ? [tool("handbook", "workspace_write", { path: "MEMORY.md", content: "# Memory\\n\\nSynthetic evidence.\\n" })] : []),
        tool("summary", "workspace_write", { path: "memory_summary.md", content: MINIMAL_V1_SUMMARY }),
      ], "toolUse"),
      () => reply([{ type: "text", text: "Done" }]),
    ]);
    assert.deepEqual(await f.scheduler.runPass(), [{ status: "published" }]);
    const saved = readFileSync(note.textPath, "utf8");
    const enrolled = f.db.prepare("SELECT * FROM source_revisions ORDER BY source_id").all();
    const usage = f.db.prepare("SELECT * FROM budget_usage ORDER BY local_day, provider, model").all();
    const legacyHash = version === "v1" ? "8d116ea8078aa2831a609b3188051d0bb7ce86de7cc54747c772150da20283ee" : "4ffeae99c14b461fecf471efef544ad1d4a3c1e746d6a586d1574f60c37c3436";
    // Simulate a legacy producer, upgrade, then rollback under captured distinct hashes.
    // This is storage compatibility proof, not executing an old Pi binary or semantic comparison.
    for (const policy of [legacyHash, consolidationPromptHash(f.config, version), legacyHash]) {
      const snapshot = selectConsolidation(f.db, { memoryVersion: version, now: NOW, maxSources: 8 });
      const lease = claimConsolidation(f.db, { memoryVersion: version, owner: "compat", promptHash: policy, now: NOW }); assert.ok(lease);
      const candidate = prepareGenerationCandidate({ db: f.db, root: f.root, lease, snapshot, config: f.config, signal: new AbortController().signal, clock: () => NOW });
      candidate.writeMinimal(); assert.equal(candidate.publish(), true); candidate.dispose();
      const generation = getPublishedGeneration(f.db, version, NOW); assert.ok(generation);
      assert.equal(generation.promptHash, policy);
      const path = join(generation.directory, "manifest.json");
      const manifest = JSON.parse(readFileSync(path, "utf8"));
      // Legacy optional-field shape with its actual stored hash, never a reserialized assumed hash.
      delete manifest.diffPolicyVersion; delete manifest.diffFallbackReason;
      const legacyText = JSON.stringify(manifest) + "\n";
      writeFileSync(path, legacyText);
      f.db.prepare("UPDATE generations SET manifest_hash = ? WHERE generation_id = ?").run(textHash(legacyText), generation.generationId);
      assert.ok(acquireEvidencePin({ db: f.db, root: f.root, memoryVersion: version, now: NOW }));
      writeFileSync(path, legacyText + " ");
      assert.equal(acquireEvidencePin({ db: f.db, root: f.root, memoryVersion: version, now: NOW }), null, "old-shaped manifests still require the actual stored hash");
      writeFileSync(path, legacyText);
      assert.equal(readFileSync(note.textPath, "utf8"), saved);
      assert.deepEqual(f.db.prepare("SELECT * FROM source_revisions ORDER BY source_id").all(), enrolled);
      assert.deepEqual(f.db.prepare("SELECT * FROM budget_usage ORDER BY local_day, provider, model").all(), usage);
      assert.equal(f.config.schedule.maxConsolidationSources, 8);
    }
    const snapshot = selectConsolidation(f.db, { memoryVersion: version, now: NOW });
    const lease = claimConsolidation(f.db, { memoryVersion: version, owner: "old", promptHash: legacyHash, now: NOW }); assert.ok(lease);
    const candidate = prepareGenerationCandidate({ db: f.db, root: f.root, lease, snapshot, config: f.config, signal: new AbortController().signal, clock: () => NOW });
    candidate.writeMinimal();
    addNote({ root: f.root, db: f.db, action: "correct", text: "Invalidate before rollback publication", scope: "global", provenance, now: NOW });
    assert.equal(candidate.publish(), false, "rollback cannot revive invalidated content"); candidate.dispose();
    assert.equal(getPublishedGeneration(f.db, version, NOW), null);
    assert.deepEqual(f.db.prepare("SELECT * FROM budget_usage ORDER BY local_day, provider, model").all(), usage);
    finishConsolidation(f.db, lease, "superseded", "publication_cas", NOW);
  });

  for (const mutation of ["correction", "forget_note", "forget_source", "privacy_edit", "selection", "configuration"] as const) {
    test(`CT07 ${version}: ${mutation} during cancellation-ignoring compaction prevents stale continuation and publication`, async (t) => {
      const f = fixture(t, version); f.source("source-000"); const note = f.note();
      f.script([
        f.largeTurn,
        async context => {
          assert.ok(context.messages[0]?.role === "system" && !context.messages[0].toolsAdded?.length);
          if (mutation === "correction") addNote({ root: f.root, db: f.db, action: "correct", text: "Revoke old route", scope: "global", provenance, now: NOW });
          else if (mutation === "forget_note") forgetNote({ root: f.root, db: f.db, noteId: note.noteId, now: NOW });
          else if (mutation === "forget_source") forgetEvidence({ root: f.root, db: f.db, kind: "source", id: "source-000", now: NOW });
          else if (mutation === "privacy_edit") recordCapturePrivacy(f.db, { capturedAt: NOW, revokedSourceIds: ["source-000"] });
          else if (mutation === "configuration") f.config.limits.summaryBytes++;
          else f.source("source-001");
          // Transport deliberately returns late rather than honoring the signal.
          await new Promise(resolve => setImmediate(resolve));
          return reply([{ type: "text", text: "STALE SUMMARY BODY MUST NOT BE INSTALLED" }]);
        },
      ]);
      const result = await f.scheduler.runPass();
      assert.ok(result.every(item => item.status !== "published"), JSON.stringify(result));
      assert.equal(f.calls.length, 2);
      assert.equal(getPublishedGeneration(f.db, version, NOW), null);
      assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM generations").get()!.n, 0);
      assert.doesNotMatch(persistentDiagnostics(f.db, f.config, NOW).lines.join("\n"), /STALE SUMMARY BODY/);
      assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM budget_reservations WHERE status = 'charged'").get()!.n, 2);
    });
  }

  for (const failure of ["invalid_summary", "daily_denial"] as const) {
    test(`CT14 ${version}: ${failure} retains and accurately reports the prior eligible publication`, async (t) => {
      const f = fixture(t, version);
      assert.deepEqual(await f.scheduler.runPass(), [{ status: "published" }]);
      const prior = getPublishedGeneration(f.db, version, NOW); assert.ok(prior);
      f.source("source-000"); f.note();
      if (failure === "daily_denial") f.config.limits.dailyRequests = 1;
      f.script([f.largeTurn, () => reply([])]);
      const result = await f.scheduler.runPass();
      assert.deepEqual(result, [{ status: failure === "daily_denial" ? "budget_deferred" : "blocked",
        reason: failure === "daily_denial" ? "request_budget" : "compaction_output_invalid" }]);
      assert.equal(getPublishedGeneration(f.db, version, NOW)?.generationId, prior.generationId);
      assert.ok(acquireEvidencePin({ db: f.db, root: f.root, memoryVersion: version, now: NOW }));
      const diagnostics = persistentDiagnostics(f.db, f.config, NOW);
      assert.equal(diagnostics.selectedReadable, true);
      assert.match(diagnostics.lines.join("\n"), /selected memory.*READABLE/);
      assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM generations").get()!.n, 1);
      assert.equal(f.calls.length, failure === "daily_denial" ? 1 : 2);
    });
  }
}
