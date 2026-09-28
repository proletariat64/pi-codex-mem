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
  // Potentially slow normalization and Git probes happen before taking the
  // SQLite writer lock; the branch values are already copied and immutable.
  const edits = branch.filter((e) => e.type === "context_edit");
  const normalized = normalizeEvidence(applyContextEdits(branch), { limits: input.limits });
  const workspace = computeWorkspaceIdentity(input.cwd);
  for (let attempt = 0; attempt < 3; attempt++) {
    const outcome = captureBranch(input, file, header, leaf, branch, edits, normalized, workspace);
    if (!outcome) continue; // another connection committed during preparation
    if (outcome.revokedSourceIds.length) prunePrivacyRevoked(input.db, input.root);
    return outcome.result;
  }
  throw new Error("capture state changed concurrently; retry at the next settlement");
}

function captureBranch(
  input: CaptureInput, file: string, header: SessionHeader, leaf: string, branch: SessionEntry[],
  edits: SessionEntry[], baseNormalized: ReturnType<typeof normalizeEvidence>,
  workspace: ReturnType<typeof computeWorkspaceIdentity>,
): { result: CaptureResult; revokedSourceIds: string[] } | null {
  // PRAGMA data_version detects commits by other connections, including new
  // branches, revocations, and policy updates. Retry the whole DB read if it
  // changes before we acquire BEGIN IMMEDIATE; no slow scan holds that lock.
  const dataVersion = (input.db.prepare("PRAGMA data_version").get() as { data_version: number }).data_version;
  const normalized = structuredClone(baseNormalized);
  type EditIdentity = { id: string; time: number; position: number; removal: boolean };
  const latestEdits = new Map<string, EditIdentity>();
  const positions = new Map(branch.map((entry, index) => [entry.id, index]));
  for (const edit of edits) {
    const target = (edit as { targetId: string }).targetId;
    const parsed = Date.parse(edit.timestamp);
    latestEdits.set(target, {
      id: edit.id, time: Number.isFinite(parsed) ? parsed : 0,
      position: positions.get(edit.id)!, removal: (edit as { replacement: unknown }).replacement === null,
    });
  }
  type EditPolicy = { id: string; time: number; allowed: string[] };
  const restrictions = new Map<string, EditPolicy>();
  for (const row of input.db.prepare("SELECT entry_id, allowed_hashes, edit_id, edit_time FROM privacy_edit_targets")
    .all() as { entry_id: string; allowed_hashes: string; edit_id: string; edit_time: number }[]) {
    let allowed: string[] = [];
    try {
      const parsed: unknown = JSON.parse(row.allowed_hashes);
      if (Array.isArray(parsed) && parsed.every((value) => typeof value === "string")) allowed = parsed;
    } catch {
      // A damaged policy must never silently permit previously removed text.
    }
    restrictions.set(row.entry_id, { allowed, id: row.edit_id, time: row.edit_time });
  }
  const itemHash = (item: typeof normalized.items[number]) => hash(`${item.role}:${item.toolCallId ?? ""}:${item.text}`);
  const mayApplyEdit = (entryId: string): boolean => {
    const edit = latestEdits.get(entryId);
    if (!edit) return false;
    const prior = restrictions.get(entryId);
    if (!prior || edit.id === prior.id) return true;
    // A prior accepted edit on this selected ancestry is causally before the
    // latest branch-local edit, irrespective of wall-clock corrections. A
    // sibling replacement cannot override privacy just by replaying later.
    const priorPosition = positions.get(prior.id);
    return (priorPosition !== undefined && priorPosition < edit.position) || edit.removal;
  };
  normalized.items = normalized.items.filter((item) => {
    const prior = restrictions.get(item.entryId);
    if (!prior || prior.allowed.includes(itemHash(item)) || mayApplyEdit(item.entryId)) return true;
    normalized.omissions.push({ entryId: item.entryId, reason: "privacy-edit-target-excluded" });
    return false;
  });
  const privacyTargets: { entryId: string; editId: string; editTime: number; allowedHashes: string }[] = [];
  for (const [entryId, edit] of latestEdits) {
    if (!mayApplyEdit(entryId)) continue;
    privacyTargets.push({
      entryId, editId: edit.id, editTime: edit.time,
      allowedHashes: JSON.stringify(normalized.items.filter((item) => item.entryId === entryId).map(itemHash)),
    });
  }
  const revocableTargetIds = new Set(privacyTargets.map((target) => target.entryId));
  const privacyPolicyChanged = privacyTargets.some((target) =>
    target.allowedHashes !== JSON.stringify(restrictions.get(target.entryId)?.allowed ?? null));
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
  const parentRevisions = parent ? input.db.prepare(
    `SELECT r.snapshot_path FROM source_revisions r
     JOIN branch_heads h ON h.session_key = r.session_key AND h.branch_id = r.branch_id
     WHERE r.session_key = ? AND h.state IN ('active', 'retired')
       AND r.status IN ('captured', 'superseded')
     ORDER BY CASE h.state WHEN 'active' THEN 0 ELSE 1 END, r.captured_at DESC`,
  ).all(parent.session_key) as { snapshot_path: string }[] : [];
  const needed = new Set(normalized.items.map((item) => `${item.entryId}:${item.role}:${item.toolCallId ?? ""}`));
  const ancestorKeys = new Map<string, string>();
  for (const revision of parentRevisions) {
    try {
      const prior = JSON.parse(readFileSync(revision.snapshot_path, "utf8")) as {
        sessionKey: string;
        items: { entryId: string; role: string; toolCallId?: string; evidenceKey?: string }[];
      };
      for (const item of prior.items) {
        const entry = `${item.entryId}:${item.role}:${item.toolCallId ?? ""}`;
        if (needed.has(entry) && !ancestorKeys.has(entry)) {
          ancestorKeys.set(entry, item.evidenceKey ?? hash(`${prior.sessionKey}:${entry}`));
        }
      }
      if (ancestorKeys.size === needed.size) break;
    } catch {
      // Pruned parent revision: continue to older retained ancestry.
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
  if (revocableTargetIds.size) {
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
      if (row.session_key === sessionKey && revocableTargetIds.size) revokedSourceIds.push(row.source_id);
      continue;
    }
    const now = (prior: typeof normalized.items[number]) => normalized.items.find((item) =>
      item.entryId === prior.entryId && item.role === prior.role && item.toolCallId === prior.toolCallId);
    if (row.source_id === current?.source_id && previous.items.some((item) => now(item)?.text !== item.text)) {
      evidenceRemoved = true;
    }
    // Context edits are branch-local for projection, but revocation of
    // copied target text must cover every older snapshot containing it.
    if (revocableTargetIds.size && previous.items.some((item) => revocableTargetIds.has(item.entryId) && now(item)?.text !== item.text)) {
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
  input.db.exec("BEGIN IMMEDIATE");
  let saved: ReturnType<typeof writeSnapshotFile>;
  try {
    if ((input.db.prepare("PRAGMA data_version").get() as { data_version: number }).data_version !== dataVersion) {
      input.db.exec("ROLLBACK");
      return null;
    }
    saved = writeSnapshotFile(input.root, lineageKey, revisionHash, snapshot);
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
    input.db.exec("COMMIT");
  } catch (err) {
    input.db.exec("ROLLBACK");
    throw err;
  }
  return { result: { status: "captured", sessionKey, branchId, sourceId, snapshotPath: saved.path }, revokedSourceIds };
}
