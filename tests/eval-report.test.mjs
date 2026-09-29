import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "pi-eval-report-"));
  t.after(() => rmSync(dir, { force: true, recursive: true }));
  writeFileSync(join(dir, "plan.json"), JSON.stringify({ selected: ["D01"], modes: ["none", "curated", "v1", "v2"], reps: 1,
    models: { extract: { provider: "fake", modelId: "test" }, consolidate: { provider: "fake", modelId: "test" },
      answer: { provider: "fake", modelId: "test" } } }));
  return dir;
}

test("a partial run is NO GO even when no model request failed", (t) => {
  const dir = fixture(t);
  const text = execFileSync(process.execPath, ["eval/report.mjs", dir], { encoding: "utf8" });
  assert.match(text, /Attempts: 0\/4; human reviews: 0; automatic no-answer misses: 0/);
  assert.match(text, /Release gate: NO GO/);
  assert.match(text, /Missing results \(4\)/);
});

test("a review cannot silently treat unadjudicated critical fabrication as false", (t) => {
  const dir = fixture(t);
  writeFileSync(join(dir, "results.jsonl"), JSON.stringify({ caseId: "D01", category: "decision", mode: "none",
    rep: 1, latencyMs: 100, injectedBytes: 0, estimatedUSD: 0 }) + "\n");
  writeFileSync(join(dir, "reviews.jsonl"), JSON.stringify({ caseId: "D01", mode: "none", rep: 1,
    grounded: true, decisionAndRationale: true, correctAbstention: null, criticalFabrication: null,
    reviewer: "human", notes: "reviewed" }) + "\n");
  const result = spawnSync(process.execPath, ["eval/report.mjs", dir], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /criticalFabrication must be adjudicated/);
});

test("a failed generated attempt is an automatic miss, never a missing human review", (t) => {
  const dir = fixture(t);
  writeFileSync(join(dir, "results.jsonl"), `${JSON.stringify({ caseId: "D01", category: "decision", mode: "v1",
    rep: 1, failed: true, failureKind: "extraction_invalid_schema", injectedBytes: 0,
    generationFailureUSD: 0.01, estimatedUSD: 0, latencyMs: 0 })}\n`);
  writeFileSync(join(dir, "failures.jsonl"), `${JSON.stringify({ caseId: "D01", mode: "v1", rep: 1,
    cumulativeEstimatedUSD: 0.01, unknownSpend: false })}\n`);
  const text = execFileSync(process.execPath, ["eval/report.mjs", dir], { encoding: "utf8" });
  assert.match(text, /automatic no-answer misses: 1/);
  assert.match(text, /failed attempts: 1/);
  assert.doesNotMatch(text, /Missing reviews \(4\)/);
  assert.match(text, /Release gate: NO GO/);
});

test("full gate requires zero critical fabrications, abstention and curated parity", (t) => {
  const dir = fixture(t);
  const labels = { D: "decision", P: "preference", F: "failure", C: "correction", N: "abstention" };
  const ids = Object.entries({ D: 10, P: 5, F: 5, C: 5, N: 5 })
    .flatMap(([prefix, count]) => Array.from({ length: count }, (_, index) => `${prefix}${String(index + 1).padStart(2, "0")}`));
  const models = Object.fromEntries(["extract", "consolidate", "answer"]
    .map(name => [name, { provider: "fake", modelId: "test" }]));
  const hashes = { answer: "a".repeat(64), v1: { extraction: "b".repeat(64), consolidation: "c".repeat(64) },
    v2: { extraction: "d".repeat(64), consolidation: "e".repeat(64) } };
  writeFileSync(join(dir, "plan.json"), JSON.stringify({ selected: ids,
    modes: ["none", "curated", "v1", "v2"], reps: 3, models, promptHashes: hashes }));
  const results = ids.flatMap(caseId => ["none", "curated", "v1", "v2"].flatMap(mode =>
    [1, 2, 3].map(rep => ({ caseId, category: labels[caseId[0]], mode, rep,
      latencyMs: 100, totalLatencyMs: 120,
      injectedBytes: mode === "none" || (caseId === "N05" && ["v1", "v2"].includes(mode)) ? 0 : 20,
      memoryTools: [], estimatedUSD: 0,
      generation: ["v1", "v2"].includes(mode) ? { import: ["s1"],
        consolidation: [{ status: "published" }], forgotten: caseId === "N05" ? ["s1"] : [] } : null }))));
  const reviews = results.map(row => ({ caseId: row.caseId, mode: row.mode, rep: row.rep,
    grounded: true, decisionAndRationale: row.category === "decision" ? true : null,
    correctAbstention: row.category === "abstention" ? true : null,
    criticalFabrication: false, reviewer: "human", notes: "checked" }));
  const run = () => {
    writeFileSync(join(dir, "results.jsonl"), results.map(row => JSON.stringify(row)).join("\n") + "\n");
    writeFileSync(join(dir, "reviews.jsonl"), reviews.map(row => JSON.stringify(row)).join("\n") + "\n");
    return execFileSync(process.execPath, ["eval/report.mjs", dir], { encoding: "utf8" });
  };
  const passing = run();
  assert.match(passing, /Release gate: GO/);
  assert.match(passing, /\| Extract USD \| Writer USD \| Answer USD \| Failed USD \| Total USD \|/);
  const forget = results.find(row => row.caseId === "N05" && row.mode === "v1");
  forget.generation.forgotten = [];
  assert.match(run(), /Release gate: NO GO/);
  forget.generation.forgotten = ["s1"];
  const v1 = reviews.find(row => row.mode === "v1");
  v1.criticalFabrication = true;
  assert.match(run(), /Release gate: NO GO/);
  v1.criticalFabrication = false;
  for (const row of reviews.filter(row => row.mode === "v1" && row.caseId === "N01").slice(0, 2))
    row.correctAbstention = false;
  assert.match(run(), /Release gate: NO GO/);
  for (const row of reviews.filter(row => row.mode === "v1" && row.caseId === "N01"))
    row.correctAbstention = true;
  for (const row of reviews.filter(row => row.mode === "v1").slice(0, 5)) row.grounded = false;
  assert.match(run(), /Release gate: NO GO/);
});
