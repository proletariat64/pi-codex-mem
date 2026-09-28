import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureGitCommit, checkCwdCanaries, ensureArtifactCanary } from "../src/canaries.ts";

function makeTmp(t: test.TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-memory-canaries-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Spec §15.1: the canary pack includes the session's latest git commit.

test("captureGitCommit returns HEAD in a git repository (no mocks — real git)", (t) => {
  const repo = makeTmp(t);
  const git = (args: string[]) =>
    execFileSync("git", args, { cwd: repo, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  git(["init", "-q"]);
  git(["config", "user.email", "t@example.com"]);
  git(["config", "user.name", "t"]);
  git(["commit", "-q", "--allow-empty", "-m", "init"]);
  const head = git(["rev-parse", "HEAD"]);
  assert.equal(captureGitCommit(repo), head);
});

test("captureGitCommit outside a repository returns 'unknown'", (t) => {
  const dir = makeTmp(t);
  assert.equal(captureGitCommit(dir), "unknown");
});

// Spec §7/§15.1: the plaintext artifact canary lives OUTSIDE the memory root,
// and raw events carry its path + sha256.

test("ensureArtifactCanary creates a stable plaintext file outside the memory root", (t) => {
  const agentDir = makeTmp(t);
  const memoryRoot = join(agentDir, "memory"); // the real root layout
  const first = ensureArtifactCanary(agentDir);
  assert.ok(existsSync(first.path));
  assert.ok(!first.path.startsWith(memoryRoot + "/"), "canary must not live inside the memory root");
  assert.equal(first.path, join(agentDir, "memory-artifact-canary.txt"));
  const content = readFileSync(first.path, "utf8");
  assert.ok(content.length >= 32, "canary content should be high-entropy");
  assert.equal(first.sha256, createHash("sha256").update(content).digest("hex"));
  const second = ensureArtifactCanary(agentDir);
  assert.deepEqual(second, first, "canary is stable across calls");
});

test("checkCwdCanaries detects cwd at the prefix and suffix of user text", () => {
  const cwd = "/home/u/project";
  assert.deepEqual(checkCwdCanaries(`${cwd} please fix the bug`, cwd), { prefix: true, suffix: false });
  assert.deepEqual(checkCwdCanaries(`work in ${cwd}`, cwd), { prefix: false, suffix: true });
  assert.deepEqual(checkCwdCanaries(`${cwd} middle ${cwd}`, cwd), { prefix: true, suffix: true });
  assert.deepEqual(checkCwdCanaries("no mention here", cwd), { prefix: false, suffix: false });
});
