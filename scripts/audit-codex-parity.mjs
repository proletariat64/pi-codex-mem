#!/usr/bin/env node
/**
 * Regression guard for known legacy Codex Memory port deviations.
 *
 * A clean result is expected. Known patterns are scanned across production src
 * files so moving legacy code does not bypass the guard. Renamed/reformulated
 * policies can evade this blocklist; a pass is not proof of runtime parity.
 * Run: node scripts/audit-codex-parity.mjs
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(resolve(root, path), "utf8");
const sources = readdirSync(resolve(root, "src"), { recursive: true })
  .filter(path => /\.(?:ts|js|mjs)$/.test(path))
  .map(path => ({ path: `src/${path}`, text: read(`src/${path}`) }));

const checks = [
  {
    id: "P001",
    path: "src/pipeline/consolidate.ts",
    pattern: /\+\s*["']\\n\\n["']\s*\+\s*adaptation\(version\)/,
    fallback: /adaptation\(version\)/,
    message: "Writer appends Pi-specific consolidation prompt instructions; use byte-identical upstream instructions and isolate unavoidable host substitutions.",
  },
  {
    id: "P002",
    path: "src/pipeline/consolidate.ts",
    pattern: /const MAX_CALLS = 12;/,
    message: "Custom fixed writer request cap; verify the pinned Codex native completion/resource policy.",
  },
  {
    id: "P003",
    path: "src/pipeline/consolidate.ts",
    pattern: /const MAX_TOOLS = 40;/,
    message: "Custom writer tool cap; verify the pinned Codex native execution policy.",
  },
  {
    id: "P004",
    path: "src/pipeline/consolidate.ts",
    pattern: /const TOTAL_TIMEOUT_MS = 300_000;/,
    message: "Custom 300-second writer timeout; verify the pinned Codex native policy.",
  },
  {
    id: "P005",
    path: "src/pipeline/consolidate.ts",
    pattern: /const OUTPUT_TOKENS = 4_000;/,
    message: "Custom per-request output cap; verify Codex's model configuration.",
  },
  {
    id: "P006",
    path: "src/pipeline/consolidate.ts",
    pattern: /\.replaceAll\("thread_id=", "session_key="\)/,
    message: "Writer prompt is rewritten to Pi terminology rather than rendered from the verbatim Codex template.",
  },
  {
    id: "P007",
    path: "src/pipeline/consolidate.ts",
    pattern: /Summary length target: \$\{config\.limits\.summaryBytes\}/,
    message: "An additional, Pi-specific summary-length instruction is appended to the upstream prompt.",
  },
  {
    id: "P008",
    path: "src/read/inject.ts",
    pattern: /prompts\/pi\//,
    message: "Reader loads an adapted prompt rather than the pinned upstream template.",
  },
  {
    id: "P009",
    path: "src/pipeline/consolidate.ts",
    pattern: /new Agent\(/,
    message: "Writer bypasses Pi AgentSession's native compaction/retry lifecycle.",
  },
  {
    id: "P010",
    path: "src/extraction/runner.ts",
    pattern: /repairPrompt|repairContext|repairAttempt|for \(let attempt = 0; attempt < 2/,
    message: "Extraction has a custom model-feedback repair loop.",
  },
  {
    id: "P011",
    path: "src/pipeline/artifacts.ts",
    pattern: /validateProjectDateGrouping/,
    message: "Artifact publication adds a project/date grouping gate absent from the pinned validator.",
  },

];

const findings = [];
for (const check of checks) {
  for (const source of sources) {
    if (check.pattern.test(source.text) || (check.fallback && check.fallback.test(source.text))) {
      findings.push({ ...check, path: source.path });
    }
  }
}
for (const item of findings) {
  console.error(`${item.id} ${item.path}: ${item.message}`);
}
console.log(`Codex port audit: ${findings.length} known policy deviations found (${checks.length} static checks). Host adaptations are documented in docs/strict-codex-port.md; this audit does not prove complete runtime equivalence.`);
if (findings.length) process.exitCode = 1;
