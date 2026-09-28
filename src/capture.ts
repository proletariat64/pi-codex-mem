import { createHash, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { SessionEntry, SessionHeader } from "@earendil-works/pi-coding-agent";
import {
  computeLineageKey,
  computeRevisionHash,
  computeSessionKey,
  computeWorkspaceIdentity,
} from "./identity.ts";
import { applyContextEdits, normalizeEvidence, NORMALIZATION_POLICY_VERSION, type NormalizeLimits } from "./snapshot.ts";
import { recordSnapshot } from "./store/db.ts";
import { writeSnapshotFile } from "./store/snapshot-files.ts";

/** Capture plain branch values immediately; never retain a pi context for queued work (§6.1). */
export interface BranchReader {
  getBranch(): SessionEntry[];
  getHeader(): SessionHeader | null;
  getSessionFile(): string | undefined;
  getLeafId(): string | null;
}

export interface CaptureInput {
  root: string;
  agentDir: string;
  cwd: string;
  mode: string;
  reader: BranchReader;
  db: DatabaseSync;
  limits?: NormalizeLimits;
}

export type CaptureResult =
  | { status: "captured"; sessionKey: string; branchId: string; sourceId: string; snapshotPath: string }
  | { status: "ephemeral" | "skipped"; reason: string };

const hash = (value: string): string => createHash("sha256").update(value).digest("hex");

/**
 * On final settlement, snapshot the authoritative branch, apply privacy
 * edits, normalize under shared byte budgets, and record a new immutable
 * revision in both the source tree and SQLite (R01, T07–T10, T15).
 */
export function captureSettledSession(input: CaptureInput): CaptureResult {
  const file = input.reader.getSessionFile();
  const header = input.reader.getHeader();
  const leaf = input.reader.getLeafId();
  if (!file || !header || !leaf) {
    return { status: "ephemeral", reason: "persistent session header/path/leaf unavailable" };
  }
  // getBranch() is authoritative. Copy immediately, before any I/O can
  // interleave another extension event with the current branch snapshot.
  const branch = structuredClone(input.reader.getBranch());
  const edits = branch.filter((e) => e.type === "context_edit");
  const edited = applyContextEdits(branch);
  const normalized = normalizeEvidence(edited, { limits: input.limits });
  const workspace = computeWorkspaceIdentity(input.cwd);
  const sessionKey = computeSessionKey(input.agentDir, file, header.id);

  // Reuse an active branch when its selected leaf remains on this ancestry.
  // After /tree retires heads, choose an existing exact leaf or allocate a
  // new branch identity; never infer identity from the textual topic (§5.3).
  const active = input.db.prepare(
    "SELECT branch_id, selected_leaf, state FROM branch_heads WHERE session_key = ? ORDER BY CASE state WHEN 'active' THEN 0 ELSE 1 END",
  ).all(sessionKey) as { branch_id: string; selected_leaf: string; state: string }[];
  const ancestorIds = new Set(branch.map((e) => e.id));
  const chosen = active.find((h) => h.state === "active" && ancestorIds.has(h.selected_leaf))
    ?? active.find((h) => h.selected_leaf === leaf);
  const branchId = chosen?.branch_id ?? `br_${randomBytes(12).toString("hex")}`;
  const lineageKey = computeLineageKey(sessionKey, branchId);

  const evidenceHash = hash(JSON.stringify(normalized));
  const scopeHash = hash(JSON.stringify(workspace));
  const contextEditHash = hash(JSON.stringify(edits));
  const revisionHash = computeRevisionHash({
    evidenceHash,
    leafId: leaf,
    policyVersion: NORMALIZATION_POLICY_VERSION,
    scopeHash,
    contextEditHash,
  });
  const sourceId = `src_${hash(`${lineageKey}:${revisionHash}`).slice(0, 32)}`;
  // pi's parentSession is a *path* to the source JSONL, not the header ID.
  // Resolve it only when that parent was previously enrolled in this store.
  const parent = header.parentSession
    ? input.db.prepare("SELECT session_key FROM sessions WHERE path = ? ORDER BY last_activity_at DESC LIMIT 1")
      .get(header.parentSession) as { session_key: string } | undefined
    : undefined;
  const snapshot = {
    schemaVersion: 1,
    sourceId,
    sessionKey,
    branchId,
    lineageKey,
    revisionHash,
    leafId: leaf,
    workspace,
    parentSession: header.parentSession ?? null,
    ...normalized,
  };
  const saved = writeSnapshotFile(input.root, lineageKey, revisionHash, snapshot);
  recordSnapshot(input.db, {
    workspace,
    session: {
      sessionKey,
      path: file,
      headerId: header.id,
      parentKey: parent?.session_key ?? null,
      branchId,
      mode: input.mode,
    },
    revision: {
      sourceId,
      lineageKey,
      revisionHash,
      leafId: leaf,
      snapshotPath: saved.path,
      snapshotHash: saved.hash,
      sourceTime: Date.parse(branch.at(-1)?.timestamp ?? header.timestamp) || Date.now(),
    },
    capturedAt: Date.now(),
  });
  return { status: "captured", sessionKey, branchId, sourceId, snapshotPath: saved.path };
}
