#!/usr/bin/env node
// §18 performance gates measured against a real published store (see
// docs/operations/release-gate.md for environment and recorded exceptions).
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { acquireReadView } from "../src/read/view.ts";
import { renderMemorySection } from "../src/read/inject.ts";
import { createMemoryTools } from "../src/read/tools.ts";
import { v1PromptHash } from "../src/extraction/v1.ts";
import { v2PromptHash } from "../src/extraction/v2.ts";

const sourceRoot = process.argv[2];
if (!sourceRoot) { console.error("usage: node scripts/bench-performance.mjs <smoke-store-memory-root>"); process.exit(1); }

function percentile(samples, p) {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}
function stats(samples) {
  return { p50: percentile(samples, 50), p95: percentile(samples, 95), max: Math.max(...samples), n: samples.length };
}

// The store records absolute generation paths, so a copied tree fails
// integrity checks by design; measure the store in place. Read tools only
// append bounded usage rows, matching real foreground behavior.
const root = sourceRoot;
let db;
const results = [];
try {
  db = new DatabaseSync(join(root, "state.sqlite"));

  for (const version of ["v1", "v2"]) {
    const promptHash = version === "v1" ? v1PromptHash() : v2PromptHash();
    // Gate: bounded state/view refresh (p95 < 100 ms).
    const refresh = [];
    for (let i = 0; i < 200; i++) {
      const t0 = performance.now();
      const view = acquireReadView({ db, root, memoryVersion: version, extractionPromptHash: promptHash });
      const t1 = performance.now();
      if (view) refresh.push(t1 - t0);
    }
    if (refresh.length) results.push({ gate: "state/view refresh", version, ...stats(refresh), budget: 100 });

    // Gate: cached prompt-section preparation (p95 < 20 ms, no network by construction).
    const view = acquireReadView({ db, root, memoryVersion: version, extractionPromptHash: promptHash });
    if (view) {
      const prep = [];
      for (let i = 0; i < 200; i++) {
        const t0 = performance.now();
        renderMemorySection(view, "/tmp/workspace");
        prep.push(performance.now() - t0);
      }
      results.push({ gate: "prompt-section prep", version, ...stats(prep), budget: 20 });

      // Gate: memory-tool search/read (p95 < 250 ms within the output budget).
      const tools = createMemoryTools({ root, db: () => db, view: () => view,
        consumer: () => ({ consumerSession: `bench-${version}`, runId: "bench" }), now: () => Date.now() });
      const search = tools.find(tool => tool.name === "pi_memory_search");
      const read = tools.find(tool => tool.name === "pi_memory_read");
      const queries = [["TypeScript"], ["解析器"], ["CLI"], ["语言"], ["profiling"]];
      const latencies = [];
      for (let i = 0; i < 100; i++) {
        const query = queries[i % queries.length];
        const t0 = performance.now();
        const result = await search.execute("search", { queries: query, match: "any" });
        const cursor = result.details.cursor;
        await search.execute("search", { queries: query, match: "any", cursor });
        const item = result.details.items.find(entry => entry.path.startsWith("rollout_summaries/")) ?? result.details.items[0];
        if (item) await read.execute("read", { path: item.path });
        latencies.push(performance.now() - t0);
      }
      results.push({ gate: "search+read", version, ...stats(latencies), budget: 250 });
    }
  }

  // Gate: shutdown-owned local cleanup (< 500 ms). Measures the durable
  // checkpoint work this process owns: generation cleanup scan + DB close.
  const t0 = performance.now();
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();
  const shutdownMs = performance.now() - t0;
  results.push({ gate: "shutdown cleanup (checkpoint+close)", version: "both", p50: shutdownMs, p95: shutdownMs, max: shutdownMs, n: 1, budget: 500 });
} finally {
  try { db?.close(); } catch { /* already closed */ }
}

const pass = (row) => row.p95 <= row.budget;
console.log("| Gate | Version | p50 (ms) | p95 (ms) | max (ms) | n | Budget | Result |");
console.log("|---|---|---:|---:|---:|---:|---:|---|");
for (const row of results) {
  console.log(`| ${row.gate} | ${row.version} | ${row.p50.toFixed(1)} | ${row.p95.toFixed(1)} | ${row.max.toFixed(1)} | ${row.n} | ${row.budget} ms | ${pass(row) ? "pass" : "EXCEPTION"} |`);
}
if (results.some(row => !pass(row))) process.exit(1);
