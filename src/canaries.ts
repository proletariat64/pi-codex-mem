import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Canary pack (spec §7, §15.1): cwd prefix/suffix in user text, the
 * session's latest git commit, and a plaintext artifact canary stored
 * OUTSIDE the memory root whose path + sha256 ride on every raw event.
 */

export interface ArtifactCanary {
  path: string;
  sha256: string;
}

export interface CwdCanaries {
  prefix: boolean;
  suffix: boolean;
}

// Directly under the pi agent dir — deliberately OUTSIDE the memory root
// (<agentDir>/memory), per spec §7.
const ARTIFACT_CANARY_REL = "memory-artifact-canary.txt";

/** Latest git commit of the session's cwd, or "unknown" outside a repo. */
export function captureGitCommit(cwd: string): string {
  try {
    const result = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
    });
    if (result.status !== 0) return "unknown";
    const head = (result.stdout as string).trim();
    return /^[0-9a-f]{40}$/.test(head) ? head : "unknown";
  } catch {
    return "unknown"; // git not installed, timed out, etc.
  }
}

/**
 * Ensure the plaintext artifact canary exists under the pi agent dir
 * (never inside the memory root, spec §7) and return path + content hash.
 * Stable across calls: existing content is reused verbatim.
 */
export function ensureArtifactCanary(agentDir: string): ArtifactCanary {
  const path = join(agentDir, ARTIFACT_CANARY_REL);
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch {
    mkdirSync(agentDir, { recursive: true });
    content = `pi-memory artifact canary\n${randomBytes(32).toString("hex")}\n`;
    writeFileSync(path, content, { mode: 0o600 });
  }
  return { path, sha256: createHash("sha256").update(content).digest("hex") };
}

/** Whether the user's text carries the cwd at its prefix and/or suffix. */
export function checkCwdCanaries(userText: string, cwd: string): CwdCanaries {
  const trimmed = userText.trim();
  return { prefix: trimmed.startsWith(cwd), suffix: trimmed.endsWith(cwd) };
}
