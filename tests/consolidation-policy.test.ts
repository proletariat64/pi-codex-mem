import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../src/config.ts";
import { consolidationPromptHash, runConsolidation } from "../src/pipeline/consolidate.ts";
import { openStateDb } from "../src/store/db.ts";
import { claimConsolidation, finishConsolidation, renewConsolidationLease } from "../src/store/consolidation.ts";

// Captured from e6dbad4, before the coherent Phase 2 identity bump.
const legacy = { v1: "8d116ea8078aa2831a609b3188051d0bb7ce86de7cc54747c772150da20283ee",
  v2: "4ffeae99c14b461fecf471efef544ad1d4a3c1e746d6a586d1574f60c37c3436" };
for (const version of ["v1", "v2"] as const) {
  test(`CT13 ${version}: new context policy retries blocked byte-budget work without mutating configuration or resuming old writers`, async (t) => {
    const root = mkdtempSync(join(tmpdir(), "pi-policy-"));
    const db = openStateDb(root);
    t.after(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
    const config = defaultConfig("UTC");
    assert.equal(config.schedule.maxConsolidationSources, 256);
    config.schedule.maxConsolidationSources = 8;
    const before = structuredClone(config);
    const current = consolidationPromptHash(config, version);
    assert.notEqual(current, legacy[version], "counting, compaction and diff must invalidate the obsolete byte policy");
    const old = claimConsolidation(db, { memoryVersion: version, owner: "old", promptHash: legacy[version], now: 100 });
    assert.ok(old);
    assert.equal(finishConsolidation(db, old, "blocked", "context_budget", 101), true);
    assert.equal(claimConsolidation(db, { memoryVersion: version, owner: "same", promptHash: legacy[version], now: 102 }), null);
    const next = claimConsolidation(db, { memoryVersion: version, owner: "new", promptHash: current, now: 103 });
    assert.ok(next, "changed policy creates a new eligible work key");
    assert.notEqual(next.jobId, old.jobId);
    assert.equal(renewConsolidationLease(db, old, 104), false);
    const result = await runConsolidation({ db, config, directory: root, lease: old,
      modelRef: { provider: "mock", modelId: "unused" },
      port: { resolve: () => { throw new Error("old writer must not resolve or send"); }, stream: () => { throw new Error("no transport"); } },
      signal: new AbortController().signal });
    assert.deepEqual(result, { status: "blocked", reason: "prompt_changed" });
    assert.deepEqual(config, before, "explicit source ceiling 8 is never reset");
  });
}
