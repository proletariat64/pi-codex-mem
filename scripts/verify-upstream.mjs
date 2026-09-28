#!/usr/bin/env node
// Verifies that every file recorded in UPSTREAM.md's manifest exists locally
// and matches its pinned SHA-256. Exit 0 when clean, 1 on any drift.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// The manifest is the JSON fence that declares itself via "manifestVersion",
// so earlier example JSON blocks in the doc can never shadow it.
const JSON_FENCE_RE = /```json\s*\n([\s\S]*?)```/g;

function extractManifest(manifestText) {
  for (const match of manifestText.matchAll(JSON_FENCE_RE)) {
    try {
      const parsed = JSON.parse(match[1]);
      if (parsed && typeof parsed === "object" && "manifestVersion" in parsed) {
        return parsed;
      }
    } catch {
      return { __parseError: true };
    }
  }
  return undefined;
}

/**
 * @param {string} root directory containing UPSTREAM.md
 * @returns {{ok: boolean, checked: number, problems: string[]}}
 */
export function verifyUpstream(root) {
  const problems = [];
  let manifestText;
  try {
    manifestText = readFileSync(join(root, "UPSTREAM.md"), "utf8");
  } catch {
    return { ok: false, checked: 0, problems: ["UPSTREAM.md is missing"] };
  }
  const manifest = extractManifest(manifestText);
  if (!manifest) {
    return { ok: false, checked: 0, problems: ["UPSTREAM.md contains no ```json manifest block"] };
  }
  if (manifest.__parseError) {
    return { ok: false, checked: 0, problems: ["manifest JSON is invalid"] };
  }
  const sources = manifest.sources;
  if (!Array.isArray(sources) || sources.length === 0) {
    return { ok: false, checked: 0, problems: ["manifest has no sources"] };
  }
  for (const source of sources) {
    const { localPath, sha256 } = source;
    if (!localPath || !sha256) {
      problems.push(`manifest entry is missing localPath or sha256: ${JSON.stringify(source)}`);
      continue;
    }
    let content;
    try {
      content = readFileSync(join(root, localPath));
    } catch {
      problems.push(`${localPath}: missing`);
      continue;
    }
    const actual = createHash("sha256").update(content).digest("hex");
    if (actual !== sha256) {
      problems.push(`${localPath}: hash mismatch (expected ${sha256.slice(0, 12)}…, got ${actual.slice(0, 12)}…)`);
    }
  }
  return { ok: problems.length === 0, checked: sources.length, problems };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const root = process.argv[2] ?? process.cwd();
  const result = verifyUpstream(root);
  if (result.ok) {
    console.log(`upstream manifest OK: ${result.checked} files verified`);
  } else {
    console.error(`upstream manifest drift (${result.problems.length} problem(s)):`);
    for (const p of result.problems) console.error(`  - ${p}`);
    process.exit(1);
  }
}
