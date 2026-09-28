import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import type { SessionEntry, SessionHeader } from "@earendil-works/pi-coding-agent";
import {
  computeLineageKey,
  computeRevisionHash,
  computeSessionKey,
  computeWorkspaceIdentity,
} from "./identity.ts";
import { applyContextEdits, normalizeEvidence, NORMALIZATION_POLICY_VERSION, type NormalizeLimits } from "./snapshot.ts";
import { prunePrivacyRevoked, recordSnapshot } from "./store/db.ts";
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
  // Serialize the policy read, cross-branch revocation scan, file creation,
  // and DB publication. No concurrent writer can race an edit between scan
  // and commit, and startup cleanup takes this same write lock.
  input.db.exec("BEGIN IMMEDIATE");
  let locked: { result: CaptureResult; revokedSourceIds: string[] };
  try {
    locked = captureBranch(input, file, header, leaf, branch);
    input.db.exec("COMMIT");
  } catch (err) {
    input.db.exec("ROLLBACK");
    throw err;
  }
  if (locked.revokedSourceIds.length) prunePrivacyRevoked(input.db, input.root);
  return locked.result;
}

function captureBranch(
  input: CaptureInput, file: string, header: SessionHeader, leaf: string, branch: SessionEntry[],
): { result: CaptureResult; revokedSourceIds: string[] } {
  const edits = branch.filter((e) => e.type === "context_edit");
  const edited = applyContextEdits(branch);
  const normalized = normalizeEvidence(edited, { limits: input.limits });
  const targetIds = new Set(edits.map((e) => (e as { targetId: string }).targetId));
  const restrictions = new Map<string, string[]>();
  for (const row of input.db.prepare("SELECT entry_id, allowed_hashes FROM privacy_edit_targets")
    .all() as { entry_id: string; allowed_hashes: string }[]) {
    try {
      const allowed: unknown = JSON.parse(row.allowed_hashes);
      restrictions.set(row.entry_id, Array.isArray(allowed) && allowed.every((value) => typeof value === "string") ? allowed : []);
    } catch {
      // A damaged policy must never silently permit previously removed text.
      restrictions.set(row.entry_id, []);
    }
  }
  const itemHash = (item: typeof normalized.items[number]) => hash(`${item.role}:${item.toolCallId ?? ""}:${item.text}`);
  normalized.items = normalized.items.filter((item) => {
    const allowed = restrictions.get(item.entryId);
    if (!allowed || targetIds.has(item.entryId) || allowed.includes(itemHash(item))) return true;
    normalized.omissions.push({ entryId: item.entryId, reason: "privacy-edit-target-excluded" });
    return false;
  });
  const privacyTargets = [...targetIds].map((entryId) => ({
    entryId,
    allowedHashes: JSON.stringify(normalized.items.filter((item) => item.entryId === entryId).map(itemHash)),
  }));
  const privacyPolicyChanged = privacyTargets.some((target) =>
    target.allowedHashes !== JSON.stringify(restrictions.get(target.entryId) ?? null));
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

  // A fork has new session identity, but copied ancestor entries must not be
  // independent corroboration. Inherit the parent's stable per-entry keys
  // when its captured snapshot is available (§5.3, T09).
  const parent = header.parentSession
    ? input.db.prepare("SELECT session_key FROM sessions WHERE path = ? ORDER BY last_activity_at DESC LIMIT 1")
      .get(header.parentSession) as { session_key: string } | undefined
    : undefined;
  const parentHead = parent && input.db.prepare(
    `SELECT r.snapshot_path FROM branch_heads h JOIN source_revisions r ON r.source_id = h.latest_revision
     WHERE h.session_key = ? AND h.state = 'active' AND r.status = 'captured' LIMIT 1`,
  ).get(parent.session_key) as { snapshot_path: string } | undefined;
  let ancestorKeys = new Map<string, string>();
  if (parentHead) {
    try {
      const prior = JSON.parse(readFileSync(parentHead.snapshot_path, "utf8")) as {
        sessionKey: string;
        items: { entryId: string; role: string; toolCallId?: string; evidenceKey?: string }[];
      };
      ancestorKeys = new Map(prior.items.map((item) => [
        `${item.entryId}:${item.role}:${item.toolCallId ?? ""}`,
        item.evidenceKey ?? hash(`${prior.sessionKey}:${item.entryId}:${item.role}:${item.toolCallId ?? ""}`),
      ]));
    } catch {
      // Parent absent/pruned: provenance is not asserted without evidence.
    }
  }
  for (const item of normalized.items) {
    const entry = `${item.entryId}:${item.role}:${item.toolCallId ?? ""}`;
    item.evidenceKey = ancestorKeys.get(entry) ?? hash(`${sessionKey}:${entry}`);
  }
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
  const current = input.db.prepare(
    `SELECT r.source_id, r.snapshot_path FROM branch_heads h
     JOIN source_revisions r ON r.source_id = h.latest_revision
     WHERE h.session_key = ? AND h.branch_id = ?`,
  ).get(sessionKey, branchId) as { source_id: string; snapshot_path: string } | undefined;
  type PriorRow = { source_id: string; snapshot_path: string; session_key: string };
  let priorRows: PriorRow[] = [];
  if (edits.length) {
    priorRows = input.db.prepare(
      "SELECT source_id, snapshot_path, session_key FROM source_revisions WHERE status != 'privacy_revoked' AND source_id != ?",
    ).all(sourceId) as PriorRow[];
  } else if (current && current.source_id !== sourceId) {
    priorRows = [{ ...current, session_key: sessionKey }];
  }
  const revokedSourceIds: string[] = [];
  let evidenceRemoved = false;
  for (const row of priorRows) {
    let previous: { items: typeof normalized.items };
    try {
      previous = JSON.parse(readFileSync(row.snapshot_path, "utf8")) as { items: typeof normalized.items };
    } catch {
      // If an earlier selected snapshot is unavailable, the read side must
      // not assume its generated conclusions remain valid.
      if (row.source_id === current?.source_id) evidenceRemoved = true;
      if (row.session_key === sessionKey && targetIds.size) revokedSourceIds.push(row.source_id);
      continue;
    }
    const now = (prior: typeof normalized.items[number]) => normalized.items.find((item) =>
      item.entryId === prior.entryId && item.role === prior.role && item.toolCallId === prior.toolCallId);
    if (row.source_id === current?.source_id && previous.items.some((item) => now(item)?.text !== item.text)) {
      evidenceRemoved = true;
    }
    // Context edits are branch-local for projection, but revocation of
    // copied target text must cover every older snapshot containing it.
    if (targetIds.size && previous.items.some((item) => targetIds.has(item.entryId) && now(item)?.text !== item.text)) {
      revokedSourceIds.push(row.source_id);
    }
  }
  const existing = input.db.prepare("SELECT status FROM source_revisions WHERE source_id = ?")
    .get(sourceId) as { status: string } | undefined;
  if (existing?.status === "privacy_revoked") {
    return { result: { status: "skipped", reason: "projection contains privacy-revoked evidence" }, revokedSourceIds: [] };
  }
  const parsedSourceTime = Date.parse(branch.at(-1)?.timestamp ?? header.timestamp);
  const sourceTime = Number.isFinite(parsedSourceTime) ? parsedSourceTime : 0;
  const snapshot = {
    schemaVersion: 1,
    sourceId,
    sessionKey,
    branchId,
    lineageKey,
    revisionHash,
    leafId: leaf,
    workspace,
    workspaceKey: workspace.workspaceKey,
    sessionHeader: header,
    sessionPath: file,
    parentSession: header.parentSession ?? null,
    contextEditHash,
    capturedAt: sourceTime,
    sourceUpdatedAt: sourceTime,
    ...normalized,
    omissionsManifest: {
      count: normalized.omissions.length,
      reasons: [...new Set(normalized.omissions.map((item) => item.reason))],
      entryIds: normalized.omissions.map((item) => item.entryId),
    },
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
      sourceTime,
    },
    capturedAt: Date.now(),
    revokedSourceIds,
    privacyTargets,
    privacyPolicyChanged,
    evidenceRemoved,
  }, input.root, true);
  return { result: { status: "captured", sessionKey, branchId, sourceId, snapshotPath: saved.path }, revokedSourceIds };
}
