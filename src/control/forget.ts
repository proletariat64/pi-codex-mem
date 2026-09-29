import type { DatabaseSync } from "node:sqlite";
import { openStateDb, prunePrivacyRevoked } from "../store/db.ts";
import { closeSync, constants, existsSync, fsyncSync, openSync, rmSync } from "node:fs";
import { join } from "node:path";
import { beginClear } from "../config.ts";
import { safeWorkspacePath } from "../pipeline/workspace-tools.ts";
import { cleanupGenerations } from "../pipeline/publish.ts";
import { invalidateGeneratedViews } from "./invalidation.ts";

export const DELETION_LIMITS = "This removes extension-owned memory only. Original pi transcripts, external backups, provider-side retention and in-flight model context are not deleted. Semantic requests require concrete source/session IDs or a correction; keyword erasure is not guaranteed.";

/** Commit durable suppression and both-version revocation before any file or derived text is deleted. */
export function forgetEvidence(input: { root: string; db: DatabaseSync; kind: "source" | "session"; id: string; now?: number }) {
  const { db, root, kind, id } = input; const now = input.now ?? Date.now();
  if (!["source", "session"].includes(kind) || !/^[A-Za-z0-9_-]{1,160}$/.test(id)) throw new Error("invalid_forget_target");
  db.exec("BEGIN IMMEDIATE");
  let affectedRevisions = 0; let forgotten = false;
  try {
    const source = kind === "source" ? db.prepare("SELECT lineage_key AS identity FROM source_revisions WHERE source_id = ?").get(id)
      : db.prepare("SELECT session_key AS identity FROM sessions WHERE session_key = ?").get(id);
    if (source) {
      const identity = source.identity; const column = kind === "source" ? "lineage_key" : "session_key";
      db.prepare("INSERT OR IGNORE INTO suppression_tombstones (kind, identity, created_at) VALUES (?, ?, ?)")
        .run(kind === "source" ? "lineage" : "session", identity!, now);
      affectedRevisions = Number(db.prepare(`UPDATE source_revisions SET status = 'privacy_revoked' WHERE ${column} = ?`).run(identity!).changes);
      db.prepare(`UPDATE branch_heads SET state = 'suppressed' WHERE (session_key, branch_id) IN
        (SELECT session_key, branch_id FROM source_revisions WHERE ${column} = ?)`).run(identity!);
      db.prepare(`UPDATE jobs SET status = 'superseded', fence = fence + 1, owner = NULL, lease_expires_at = NULL,
        updated_at = ? WHERE kind = 'extract' AND source_id IN (SELECT source_id FROM source_revisions WHERE ${column} = ?)`)
        .run(now, identity!);
      invalidateGeneratedViews(db, "source_forgotten", now); forgotten = true;
    }
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  let cleanupPending = false;
  if (forgotten) {
    try { prunePrivacyRevoked(db, root); cleanupGenerations({ root, db, now }); }
    catch { cleanupPending = true; }
  }
  return { forgotten, affectedRevisions, cleanupPending, explanation: DELETION_LIMITS };
}

function syncDirectory(root: string): void {
  const fd = openSync(root, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

/** Leave the disabled config and a restart marker until secure deletion and owned cleanup complete. */
export function clearMemoryStore(input: { root: string; db: DatabaseSync; confirmed: boolean }) {
  if (!input.confirmed) throw new Error("clear_confirmation_required");
  const { root, db } = input;
  const disabled = beginClear(root);
  if (!disabled.ok) throw new Error(disabled.reason);
  const marker = safeWorkspacePath(root, "clear.pending", true);
  let cleanupPending = true;
  try {
    db.exec("BEGIN IMMEDIATE");
    try {
      invalidateGeneratedViews(db, "store_cleared", Date.now());
      for (const table of ["note_applications", "generation_sources", "generations", "memory_usage", "source_stats",
        "extractions", "jobs", "source_revisions", "branch_heads", "sessions", "workspaces", "notes",
        "suppression_tombstones", "privacy_edit_targets", "process_activity", "budget_reservations", "budget_usage"]) {
        db.exec(`DELETE FROM ${table}`);
      }
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
    // Old SQLite snapshots can retain deleted payloads; do not unlink the DB while they prevent truncation.
    const checkpoint = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
    if (!checkpoint || checkpoint.busy !== 0) return { cleanupPending, explanation: DELETION_LIMITS };
    db.close();
    for (const path of ["sources", "versions", "notes", "state.sqlite-wal", "state.sqlite-shm", "state.sqlite"]) {
      const owned = safeWorkspacePath(root, path, true);
      rmSync(owned, { recursive: true, force: true });
    }
    syncDirectory(root); rmSync(marker); syncDirectory(root); cleanupPending = false;
  } finally { if (db.isOpen) db.close(); }
  return { cleanupPending, explanation: DELETION_LIMITS };
}

export function resumeClear(root: string) {
  if (!existsSync(join(root, "clear.pending"))) return { cleanupPending: false, explanation: DELETION_LIMITS };
  return clearMemoryStore({ root, db: openStateDb(root), confirmed: true });
}
