import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  computeLineageKey,
  computeRevisionHash,
  computeSessionKey,
  computeWorkspaceIdentity,
} from "../src/identity.ts";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

function makeTmp(t: test.TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-memory-id-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
}

// Spec §5.2: non-Git workspace identity is sha256(realpath(cwd)).

test("non-Git directory: workspaceKey = sha256(realpath(cwd)), no git fields", (t) => {
  const dir = makeTmp(t);
  const id = computeWorkspaceIdentity(dir);
  assert.equal(id.workspaceKey, sha(realpathSync(dir)));
  assert.equal(id.repoKey, null);
  assert.equal(id.checkoutKey, null);
  assert.equal(id.gitCommonDir, null);
  assert.equal(id.gitTopLevel, null);
  assert.equal(id.gitBranch, null);
  assert.equal(id.gitHead, null);
});

test("Git repo: repoKey from common dir, checkoutKey from top-level, HEAD recorded (§5.2)", (t) => {
  const repo = makeTmp(t);
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "t@example.com"]);
  git(repo, ["config", "user.name", "t"]);
  git(repo, ["commit", "-q", "--allow-empty", "-m", "init"]);
  const head = git(repo, ["rev-parse", "HEAD"]);
  const gitOut = (args: string[]) => git(repo, args);
  const resolveInRepo = (p: string) => realpathSync(p.startsWith("/") ? p : join(repo, p));
  const commonDir = resolveInRepo(gitOut(["rev-parse", "--git-common-dir"]));
  const topLevel = resolveInRepo(gitOut(["rev-parse", "--show-toplevel"]));

  const id = computeWorkspaceIdentity(repo);
  assert.equal(id.repoKey, sha(commonDir));
  assert.equal(id.checkoutKey, sha(topLevel));
  assert.equal(id.gitCommonDir, commonDir);
  assert.equal(id.gitTopLevel, topLevel);
  assert.equal(id.gitHead, head);
  assert.equal(id.gitBranch, git(repo, ["symbolic-ref", "--short", "HEAD"]));
});

test("worktrees share repoKey but keep distinct checkoutKey (§5.2)", (t) => {
  const repo = makeTmp(t);
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "t@example.com"]);
  git(repo, ["config", "user.name", "t"]);
  git(repo, ["commit", "-q", "--allow-empty", "-m", "init"]);
  const wt = join(makeTmp(t), "wt");
  git(repo, ["worktree", "add", "-q", wt]);

  const main = computeWorkspaceIdentity(repo);
  const worktree = computeWorkspaceIdentity(wt);
  assert.ok(main.repoKey);
  assert.equal(main.repoKey, worktree.repoKey, "worktrees share repoKey");
  assert.notEqual(main.checkoutKey, worktree.checkoutKey, "distinct checkoutKey");
});

test("moving a repository changes its identity (§5.2)", (t) => {
  const a = makeTmp(t);
  const b = makeTmp(t);
  assert.notEqual(computeWorkspaceIdentity(a).workspaceKey, computeWorkspaceIdentity(b).workspaceKey);
});

// Spec §5.3: sessionKey = sha256(agentDir + canonicalSessionPath + header.id)

test("sessionKey follows §5.3 hashing; same session -> same key", () => {
  const a = computeSessionKey("/agent", "/agent/sessions/2026/x.jsonl", "sess-1");
  assert.equal(a, sha("/agent" + "/agent/sessions/2026/x.jsonl" + "sess-1"));
  assert.equal(a, computeSessionKey("/agent", "/agent/sessions/2026/x.jsonl", "sess-1"));
  assert.notEqual(a, computeSessionKey("/agent", "/agent/sessions/2026/x.jsonl", "sess-2"));
});

test("lineageKey = sha256(sessionKey + ':' + branchId)", () => {
  const sk = computeSessionKey("/agent", "/s.jsonl", "sess-1");
  assert.equal(computeLineageKey(sk, "br-1"), sha(`${sk}:br-1`));
});

test("revisionHash covers evidence, leaf, policy, scope, and context-edit state (§5.3)", () => {
  const base = {
    evidenceHash: "a".repeat(64),
    leafId: "leaf-1",
    policyVersion: "norm-1",
    scopeHash: "b".repeat(64),
    contextEditHash: "c".repeat(64),
  };
  const h = computeRevisionHash(base);
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.equal(h, computeRevisionHash(base), "deterministic");
  assert.notEqual(h, computeRevisionHash({ ...base, leafId: "leaf-2" }), "leaf is covered");
  assert.notEqual(h, computeRevisionHash({ ...base, evidenceHash: "d".repeat(64) }), "evidence is covered");
  assert.notEqual(h, computeRevisionHash({ ...base, policyVersion: "norm-2" }), "policy is covered");
  assert.notEqual(h, computeRevisionHash({ ...base, contextEditHash: "e".repeat(64) }), "edits are covered");
});
