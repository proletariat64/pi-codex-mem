import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";

/**
 * Workspace/session/branch/revision identities (spec §5.2, §5.3).
 * All hashes are sha256 over canonical, length-safe encodings.
 */

export interface WorkspaceIdentity {
  workspaceKey: string;
  repoKey: string | null;
  checkoutKey: string | null;
  cwdReal: string;
  gitCommonDir: string | null;
  gitTopLevel: string | null;
  gitBranch: string | null;
  gitHead: string | null;
}

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

/** Argv-based git with a short timeout; null on any failure (§5.2). */
function git(cwd: string, args: string[]): string | null {
  try {
    const result = spawnSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
    });
    if (result.status !== 0) return null;
    const out = (result.stdout as string).trim();
    return out === "" ? null : out;
  } catch {
    return null;
  }
}

/**
 * §5.2: Git workspaces get repoKey (common dir) and checkoutKey (top level);
 * worktrees share repoKey but keep distinct checkoutKey; non-Git falls back
 * to workspaceKey = sha256(realpath(cwd)).
 */
export function computeWorkspaceIdentity(cwd: string): WorkspaceIdentity {
  let cwdReal: string;
  try {
    cwdReal = realpathSync(cwd);
  } catch {
    cwdReal = cwd;
  }
  const commonDirRaw = git(cwd, ["rev-parse", "--git-common-dir"]);
  const topLevelRaw = git(cwd, ["rev-parse", "--show-toplevel"]);
  if (commonDirRaw === null || topLevelRaw === null) {
    return {
      workspaceKey: sha256(cwdReal),
      repoKey: null,
      checkoutKey: null,
      cwdReal,
      gitCommonDir: null,
      gitTopLevel: null,
      gitBranch: null,
      gitHead: null,
    };
  }
  // git may print relative paths; resolve them against cwd.
  const resolveReal = (p: string): string => {
    try {
      return realpathSync(p.startsWith("/") ? p : `${cwdReal}/${p}`);
    } catch {
      return p;
    }
  };
  const gitCommonDir = resolveReal(commonDirRaw);
  const gitTopLevel = resolveReal(topLevelRaw);
  const repoKey = sha256(gitCommonDir);
  const checkoutKey = sha256(gitTopLevel);
  return {
    workspaceKey: checkoutKey,
    repoKey,
    checkoutKey,
    cwdReal,
    gitCommonDir,
    gitTopLevel,
    gitBranch: git(cwd, ["branch", "--show-current"]),
    gitHead: git(cwd, ["rev-parse", "HEAD"]),
  };
}

/** §5.3: sessionKey = sha256(agentDir + canonicalSessionPath + header.id). */
export function computeSessionKey(agentDir: string, sessionPath: string, headerId: string): string {
  let canonical = sessionPath;
  try {
    canonical = realpathSync(sessionPath);
  } catch {
    // session file may not exist yet (ephemeral sessions); use as given
  }
  return sha256(agentDir + canonical + headerId);
}

/** §5.3: lineageKey = sha256(sessionKey + ":" + branchId). */
export function computeLineageKey(sessionKey: string, branchId: string): string {
  return sha256(`${sessionKey}:${branchId}`);
}

export interface RevisionHashParts {
  evidenceHash: string;
  leafId: string;
  policyVersion: string;
  scopeHash: string;
  contextEditHash: string;
}

/**
 * §5.3: revisionHash covers normalized evidence, selected leaf, shared
 * normalization-policy version, scope metadata, and applied context-edit
 * state. Length-prefixed encoding so no field boundary is ambiguous.
 */
export function computeRevisionHash(parts: RevisionHashParts): string {
  const fields = [
    parts.evidenceHash,
    parts.leafId,
    parts.policyVersion,
    parts.scopeHash,
    parts.contextEditHash,
  ];
  return sha256(fields.map((f) => `${f.length}:${f}`).join("|"));
}
