import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStateDb, recordSnapshot } from "../src/store/db.ts";
import { DatabaseSync } from "node:sqlite";
import { enqueueExtraction, claimDueExtractions, commitExtraction } from "../src/store/jobs.ts";
import { claimConsolidation, commitGeneration, finishConsolidation, getPublishedGeneration,
  recordSourceUsage, renewConsolidationLease, selectConsolidation } from "../src/store/consolidation.ts";

const NOW = Date.UTC(2026, 8, 1);
function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "pi-consolidation-store-"));
  const db = openStateDb(root);
  t.after(() => { if (db.isOpen) db.close(); rmSync(root, { recursive: true, force: true }); });
  function source(id: string, ageDays = 1, version: "v1" | "v2" = "v1") {
    recordSnapshot(db, {
      workspace: { workspaceKey: "workspace", repoKey: null, checkoutKey: null, cwdReal: root,
        gitCommonDir: null, gitTopLevel: null, gitBranch: null, gitHead: null },
      session: { sessionKey: `session-${id}`, path: join(root, `${id}.jsonl`), headerId: id,
        parentKey: null, branchId: "branch", mode: "tui" },
      revision: { sourceId: id, lineageKey: `lineage-${id}`, revisionHash: id, leafId: id,
        snapshotPath: join(root, `${id}.json`), snapshotHash: id, sourceTime: NOW - ageDays * 86_400_000 },
      capturedAt: NOW - ageDays * 86_400_000,
    });
    enqueueExtraction(db, { sourceId: id, memoryVersion: version, promptHash: `prompt-${version}`, now: NOW });
    const [job] = claimDueExtractions(db, { owner: "extractor", now: NOW, limit: 1 });
    assert.ok(job);
    assert.equal(commitExtraction(db, job, { memoryVersion: version, promptHash: job.promptHash,
      model: { provider: "fixture", modelId: "extract" }, rawMemory: version === "v1" ? `raw ${id}` : null,
      rolloutSummary: `summary ${id}`, rolloutSlug: id, outputHash: `hash-${id}-${version}`,
      usage: { input: 1, output: 1 }, outcome: "succeeded",
      truncation: version === "v2" ? { truncated: false, originalBytes: Buffer.byteLength(`summary ${id}`),
        acceptedBytes: Buffer.byteLength(`summary ${id}`) } : undefined }, NOW + 1), true);
  }
  return { root, db, source };
}

test("selection uses only active same-version evidence and ranks real usage within retention", (t) => {
  const { db, source } = fixture(t);
  source("recent", 1); source("old", 31); source("used", 29); source("other-version", 1, "v2");
  db.prepare("INSERT INTO source_stats (memory_version, lineage_key, usage_count, last_used_at) VALUES ('v1', 'lineage-used', 2, ?)").run(NOW);
  const selected = selectConsolidation(db, { memoryVersion: "v1", now: NOW, maxSources: 1 });
  assert.deepEqual(selected.sources.map(s => s.sourceId), ["used"]);
  assert.equal(selected.sources[0]?.rawMemory, "raw used");
  assert.equal(selected.retentionDeadline, NOW + 30 * 86_400_000 + 1);
  db.prepare("UPDATE branch_heads SET state = 'suppressed' WHERE session_key = 'session-used'").run();
  assert.deepEqual(selectConsolidation(db, { memoryVersion: "v1", now: NOW }).sources.map(s => s.sourceId), ["recent"]);
});

test("publication compares selection, version, epoch and lease in one transaction", (t) => {
  const { db, root, source } = fixture(t);
  source("first");
  const lease = claimConsolidation(db, { memoryVersion: "v1", owner: "writer", promptHash: "prompt", now: NOW + 2 });
  assert.ok(lease);
  const snapshot = selectConsolidation(db, { memoryVersion: "v1", now: NOW + 2 });
  const generation = { generationId: "generation-1", directory: join(root, "generation-1"),
    inputHash: "input", manifestHash: "manifest", memoryVersion: "v1" as const };
  assert.equal(commitGeneration(db, { lease, snapshot, generation: { ...generation, memoryVersion: "v2" }, now: NOW + 3 }), false);
  db.prepare("UPDATE store_state SET control_epoch = control_epoch + 1").run();
  assert.equal(commitGeneration(db, { lease, snapshot, generation, now: NOW + 3 }), false);
  const refreshed = selectConsolidation(db, { memoryVersion: "v1", now: NOW + 3 });
  source("new");
  assert.equal(commitGeneration(db, { lease, snapshot: refreshed, generation, now: NOW + 4 }), false);
  const final = selectConsolidation(db, { memoryVersion: "v1", now: NOW + 4 });
  assert.equal(commitGeneration(db, { lease, snapshot: final, generation, now: NOW + 5 }), true);
  assert.equal(getPublishedGeneration(db, "v1", NOW + 5)?.generationId, "generation-1");
  assert.equal(getPublishedGeneration(db, "v2", NOW + 5), null);
  assert.throws(() => db.prepare("UPDATE pipeline_state SET active_generation_id = 'generation-1' WHERE memory_version = 'v2'").run(), /version mismatch/);
  assert.equal(commitGeneration(db, { lease, snapshot: final, generation: { ...generation, generationId: "late" }, now: NOW + 6 }), false);
  assert.equal(getPublishedGeneration(db, "v1", NOW + 31 * 86_400_000), null);
});

test("source usage deduplicates per version/session/run/source and preserves version retention", (t) => {
  const { db, source } = fixture(t);
  source("used", 29);
  assert.equal(recordSourceUsage(db, { memoryVersion: "v1", sourceId: "used", consumerSession: "reader", runId: "run", now: NOW }), true);
  assert.equal(recordSourceUsage(db, { memoryVersion: "v1", sourceId: "used", consumerSession: "reader", runId: "run", now: NOW + 1 }), false);
  assert.equal(recordSourceUsage(db, { memoryVersion: "v2", sourceId: "used", consumerSession: "reader", runId: "run", now: NOW }), false);
  assert.deepEqual(selectConsolidation(db, { memoryVersion: "v1", now: NOW + 10 * 86_400_000 }).sources.map(s => s.sourceId), ["used"]);
});

test("one store-wide consolidation lease fences expired writers and blocked jobs do not hot retry", (t) => {
  const { db } = fixture(t);
  const first = claimConsolidation(db, { memoryVersion: "v1", owner: "one", promptHash: "prompt", now: NOW });
  assert.ok(first);
  assert.equal(claimConsolidation(db, { memoryVersion: "v2", owner: "two", promptHash: "prompt", now: NOW + 1 }), null);
  const replacement = claimConsolidation(db, { memoryVersion: "v1", owner: "two", promptHash: "prompt", now: NOW + 180_000 });
  assert.ok(replacement);
  assert.ok(replacement.fence > first.fence);
  assert.equal(renewConsolidationLease(db, first, NOW + 180_001), false);
  assert.equal(finishConsolidation(db, first, "succeeded", null, NOW + 180_001), false);
  assert.equal(finishConsolidation(db, replacement, "blocked", "auth_unavailable", NOW + 180_001), true);
  assert.equal(claimConsolidation(db, { memoryVersion: "v1", owner: "three", promptHash: "prompt", now: NOW + 180_002 }), null);
  assert.ok(claimConsolidation(db, { memoryVersion: "v1", owner: "three", promptHash: "prompt", configEpoch: "changed", now: NOW + 180_003 }));
});

test("schema 8 upgrades preserve existing extraction data and privacy revocation can delete linked payloads", (t) => {
  const { db, root, source } = fixture(t);
  source("private");
  db.exec(`DROP TRIGGER generation_source_version; DROP TRIGGER generation_source_version_update;
    DROP TRIGGER pipeline_generation_version; DROP TABLE note_applications; DROP TABLE generation_sources;
    DROP TABLE generations; DROP TABLE memory_usage; DROP TABLE source_stats; DROP TABLE notes;
    ALTER TABLE pipeline_state DROP COLUMN active_generation_id; DELETE FROM schema_migrations WHERE version >= 9;`);
  db.close();
  const upgraded = openStateDb(root);
  t.after(() => upgraded.close());
  assert.deepEqual(selectConsolidation(upgraded, { memoryVersion: "v1", now: NOW }).sources.map(s => s.sourceId), ["private"]);
  const lease = claimConsolidation(upgraded, { memoryVersion: "v1", owner: "writer", promptHash: "prompt", now: NOW + 2 });
  assert.ok(lease);
  const snapshot = selectConsolidation(upgraded, { memoryVersion: "v1", now: NOW + 2 });
  assert.equal(commitGeneration(upgraded, { lease, snapshot, generation: { generationId: "private-generation",
    memoryVersion: "v1", directory: join(root, "private-generation"), inputHash: "input", manifestHash: "manifest" }, now: NOW + 3 }), true);
  upgraded.prepare("UPDATE source_revisions SET status = 'privacy_revoked' WHERE source_id = 'private'").run();
  assert.doesNotThrow(() => upgraded.prepare("DELETE FROM extractions WHERE source_id = 'private'").run());
  assert.equal(getPublishedGeneration(upgraded, "v1", NOW + 4), null);
});

test("two SQLite connections cannot lease independent v1 and v2 consolidators", (t) => {
  const { db, root } = fixture(t);
  const other = new DatabaseSync(join(root, "state.sqlite"));
  t.after(() => other.close());
  assert.ok(claimConsolidation(db, { memoryVersion: "v1", owner: "one", promptHash: "prompt", now: NOW }));
  assert.equal(claimConsolidation(other, { memoryVersion: "v2", owner: "two", promptHash: "prompt", now: NOW + 1 }), null);
});

test("a newer no-output extraction removes older generated signal from selection", (t) => {
  const { db, source } = fixture(t);
  source("revisited");
  enqueueExtraction(db, { sourceId: "revisited", memoryVersion: "v1", promptHash: "new-prompt", now: NOW + 2 });
  const [job] = claimDueExtractions(db, { owner: "extractor", now: NOW + 2, limit: 1 });
  assert.ok(job);
  assert.equal(commitExtraction(db, job, { memoryVersion: "v1", promptHash: job.promptHash,
    model: { provider: "fixture", modelId: "extract" }, rawMemory: "", rolloutSummary: "", rolloutSlug: "",
    outputHash: "empty", usage: { input: 1, output: 1 }, outcome: "no_output" }, NOW + 3), true);
  assert.deepEqual(selectConsolidation(db, { memoryVersion: "v1", now: NOW + 4 }).sources, []);
});

test("pausing before provider use refunds attempts and the third transport failure blocks", (t) => {
  const { db } = fixture(t);
  for (let n = 0; n < 5; n++) {
    const lease = claimConsolidation(db, { memoryVersion: "v1", owner: "writer", promptHash: "prompt", now: NOW + n });
    assert.ok(lease);
    assert.equal(finishConsolidation(db, lease, "retry_wait", "foreground_active", NOW + n, NOW + n + 1, { refundAttempt: true }), true);
  }
  for (let n = 0; n < 3; n++) {
    const lease = claimConsolidation(db, { memoryVersion: "v1", owner: "writer", promptHash: "prompt", now: NOW + 10 + n });
    assert.ok(lease);
    assert.equal(finishConsolidation(db, lease, "retry_wait", "provider_error", NOW + 10 + n, NOW + 11 + n), true);
  }
  assert.equal(claimConsolidation(db, { memoryVersion: "v1", owner: "writer", promptHash: "prompt", now: NOW + 20 }), null);
  const terminal = db.prepare("SELECT status, error_code FROM jobs WHERE kind = 'consolidate'").get();
  assert.deepEqual({ ...terminal }, { status: "blocked", error_code: "max_attempts" });
});

test("changing the consolidation prompt supersedes stale pending jobs for its own version", (t) => {
  const { db } = fixture(t);
  const prior = claimConsolidation(db, { memoryVersion: "v1", owner: "writer", promptHash: "old-prompt", now: NOW });
  assert.ok(prior);
  assert.equal(finishConsolidation(db, prior, "retry_wait", "provider_error", NOW + 1, NOW + 60_000), true);
  assert.ok(claimConsolidation(db, { memoryVersion: "v1", owner: "writer", promptHash: "new-prompt", now: NOW + 2 }));
  assert.equal((db.prepare("SELECT status FROM jobs WHERE job_id = ?").get(prior.jobId) as { status: string }).status, "superseded");
});

test("current retention configuration immediately restricts an older published generation", (t) => {
  const { db, root, source } = fixture(t);
  source("older", 10);
  const lease = claimConsolidation(db, { memoryVersion: "v1", owner: "writer", promptHash: "prompt", now: NOW });
  assert.ok(lease);
  const snapshot = selectConsolidation(db, { memoryVersion: "v1", now: NOW });
  assert.equal(commitGeneration(db, { lease, snapshot, generation: { generationId: "generation",
    memoryVersion: "v1", directory: join(root, "generation"), inputHash: "input", manifestHash: "manifest" }, now: NOW + 1 }), true);
  assert.equal(getPublishedGeneration(db, "v1", NOW + 2)?.generationId, "generation");
  assert.equal(getPublishedGeneration(db, "v1", NOW + 2, { maxUnusedDays: 7 }), null);
  const sameEvidenceLongerPolicy = selectConsolidation(db, { memoryVersion: "v1", now: NOW, maxUnusedDays: 60 });
  assert.notEqual(snapshot.selectionHash, sameEvidenceLongerPolicy.selectionHash);
});

test("each selected input revision receives three attempts without resetting unchanged inputs", (t) => {
  const { db, root } = fixture(t);
  const selectionA = selectConsolidation(db, { memoryVersion: "v1", now: NOW }).selectionHash;
  const options = { memoryVersion: "v1" as const, owner: "writer", promptHash: "prompt", configEpoch: "configuration" };
  for (let attempt = 0; attempt < 3; attempt++) {
    const lease = claimConsolidation(db, { ...options, inputRevisionHash: selectionA, now: NOW + attempt });
    assert.ok(lease);
    assert.equal(finishConsolidation(db, lease, "retry_wait", "provider_error", NOW + attempt, NOW + attempt + 1), true);
  }
  assert.equal(claimConsolidation(db, { ...options, inputRevisionHash: selectionA, now: NOW + 4 }), null);
  const notePath = join(root, "new-note.md");
  writeFileSync(notePath, "new user correction");
  db.prepare("INSERT INTO notes (note_id, text_path, text_hash, scope, created_at) VALUES ('new-note', ?, 'note-hash', 'global', ?)")
    .run(notePath, NOW + 5);
  const selectionB = selectConsolidation(db, { memoryVersion: "v1", now: NOW + 5 }).selectionHash;
  const newInput = claimConsolidation(db, { ...options, inputRevisionHash: selectionB, now: NOW + 5 });
  assert.ok(newInput);
  assert.equal((db.prepare("SELECT attempt_count FROM jobs WHERE job_id = ?").get(newInput.jobId) as { attempt_count: number }).attempt_count, 1);
  assert.equal(finishConsolidation(db, newInput, "succeeded", null, NOW + 6), true);
  const resumed = claimConsolidation(db, { ...options, inputRevisionHash: selectionB, now: NOW + 7 });
  assert.ok(resumed);
  assert.equal((db.prepare("SELECT attempt_count FROM jobs WHERE job_id = ?").get(resumed.jobId) as { attempt_count: number }).attempt_count, 2);
});

test("auth/model blocks persist across selections until configuration changes or explicit retry", (t) => {
  for (const errorCode of ["auth_or_model", "model_not_found", "model_not_configured"]) {
    const { db } = fixture(t);
    const options = { memoryVersion: "v1" as const, owner: "writer", promptHash: "prompt", configEpoch: "configuration" };
    const first = claimConsolidation(db, { ...options, inputRevisionHash: "selection-A", now: NOW });
    assert.ok(first);
    assert.equal(finishConsolidation(db, first, "blocked", errorCode, NOW + 1), true);
    assert.equal(claimConsolidation(db, { ...options, inputRevisionHash: "selection-B", now: NOW + 2 }), null, errorCode);
    const otherVersion = claimConsolidation(db, { ...options, memoryVersion: "v2", inputRevisionHash: "selection-B", now: NOW + 3 });
    assert.ok(otherVersion);
    assert.equal(finishConsolidation(db, otherVersion, "succeeded", null, NOW + 4), true);
    const changed = claimConsolidation(db, { ...options, configEpoch: "new-configuration", inputRevisionHash: "selection-B", now: NOW + 5 });
    assert.ok(changed);
    assert.equal(finishConsolidation(db, changed, "blocked", errorCode, NOW + 6), true);
    const explicit = claimConsolidation(db, { ...options, configEpoch: "new-configuration", inputRevisionHash: "selection-B", retryBlocked: true, now: NOW + 7 });
    assert.ok(explicit);
    assert.equal(explicit.jobId, changed.jobId);
    assert.equal((db.prepare("SELECT attempt_count FROM jobs WHERE job_id = ?").get(explicit.jobId) as { attempt_count: number }).attempt_count, 1);
    assert.equal(finishConsolidation(db, explicit, "succeeded", null, NOW + 8), true);
    assert.ok(claimConsolidation(db, { ...options, configEpoch: "new-configuration", inputRevisionHash: "selection-D", now: NOW + 9 }));
  }
});

test("new inputs supersede obsolete retries while leaving the live lease and its attempt count intact", (t) => {
  const { db } = fixture(t);
  const options = { memoryVersion: "v1" as const, owner: "writer", promptHash: "prompt", configEpoch: "configuration" };
  const first = claimConsolidation(db, { ...options, inputRevisionHash: "input-A", now: NOW });
  assert.ok(first);
  assert.equal(claimConsolidation(db, { ...options, inputRevisionHash: "input-B", now: NOW + 1 }), null);
  assert.equal(renewConsolidationLease(db, first, NOW + 2), true);
  assert.equal(finishConsolidation(db, first, "retry_wait", "provider_error", NOW + 3, NOW + 60_000), true);
  const replacement = claimConsolidation(db, { ...options, inputRevisionHash: "input-B", now: NOW + 4 });
  assert.ok(replacement);
  assert.equal((db.prepare("SELECT status FROM jobs WHERE job_id = ?").get(first.jobId) as { status: string }).status, "superseded");
  assert.equal(finishConsolidation(db, replacement, "succeeded", null, NOW + 5), true);
  const returnToPrior = claimConsolidation(db, { ...options, inputRevisionHash: "input-A", now: NOW + 6 });
  assert.ok(returnToPrior);
  assert.equal(returnToPrior.jobId, first.jobId);
  assert.equal((db.prepare("SELECT attempt_count FROM jobs WHERE job_id = ?").get(first.jobId) as { attempt_count: number }).attempt_count, 2);
});

test("a deterministic empty rebuild can publish while preserving the provider gate for future evidence", (t) => {
  const { db } = fixture(t);
  const options = { memoryVersion: "v1" as const, owner: "writer", promptHash: "prompt", configEpoch: "configuration" };
  const first = claimConsolidation(db, { ...options, inputRevisionHash: "with-note", now: NOW });
  assert.ok(first);
  assert.equal(finishConsolidation(db, first, "blocked", "model_not_configured", NOW + 1), true);
  const empty = claimConsolidation(db, { ...options, inputRevisionHash: "empty", modelRequired: false, now: NOW + 2 });
  assert.ok(empty);
  assert.equal(finishConsolidation(db, empty, "succeeded", null, NOW + 3), true);
  assert.equal(claimConsolidation(db, { ...options, inputRevisionHash: "new-evidence", now: NOW + 4 }), null);
});
