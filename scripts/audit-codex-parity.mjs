#!/usr/bin/env node
/**
 * Strict Codex Memory port audit.
 *
 * A failing result is intentional until all deviations are resolved.
 * Every finding must be removed or documented as a necessary Pi host adapter.
 * Run: node scripts/audit-codex-parity.mjs
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(resolve(root, path), "utf8");

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
    path: "UPSTREAM.md",
    pattern: /Adaptations never touch `prompts\/upstream\/`; adapted copies live under `prompts\/pi\//,
    message: "Adapted prompt copies remain; review and retire all nonessential prompt modifications.",
  },
];

const findings = [];
for (const check of checks) {
  const source = read(check.path);
  if (check.pattern.test(source) || (check.fallback && check.fallback.test(source))) {
    findings.push(check);
  }
}
for (const item of findings) {
  console.error(`${item.id} ${item.path}: ${item.message}`);
}
console.log(`Codex port audit: ${findings.length} known deviations remain (${checks.length} checks).`);
if (findings.length) process.exitCode = 1;
