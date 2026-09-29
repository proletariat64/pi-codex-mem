import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fsyncSync, mkdirSync, openSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { safeWorkspacePath } from "../pipeline/workspace-tools.ts";
import { cleanupGenerations } from "../pipeline/publish.ts";

export interface NoteProvenance {
  consumerSession: string | null; runId: string | null; userMessageId: string | null; origin: "command" | "tool";
}
export interface NoteResult { noteId: string; textPath: string; textHash: string; scope: string; controlEpoch: number }
export const NOTE_FORGET_EXPLANATION = "Removing this note may make older independently supported source evidence applicable again. Use a replacement correction or forget the supporting sources if that is not intended.";

function syncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function invalidate(db: DatabaseSync, reason: string, now: number): void {
  db.exec("UPDATE store_state SET control_epoch = control_epoch + 1 WHERE singleton = 1");
  db.prepare("UPDATE pipeline_state SET read_blocked = 1, block_reason = ?, active_generation_id = NULL").run(reason);
  db.exec("UPDATE generations SET status = 'revoked' WHERE status = 'published'");
  // Fence obsolete writers before cleaning their private workspace. Late results cannot publish.
  db.prepare(`UPDATE jobs SET status = 'superseded', owner = NULL, lease_expires_at = NULL,
    fence = fence + 1, updated_at = ? WHERE kind = 'consolidate' AND status IN ('queued', 'leased', 'retry_wait')`).run(now);
}
const epoch = (db: DatabaseSync) => (db.prepare("SELECT control_epoch AS epoch FROM store_state WHERE singleton = 1").get() as { epoch: number }).epoch;

/** Persist user evidence before indexing; SQLite commits the note and correction revocation together. */
export function addNote(input: {
  root: string; db: DatabaseSync; action: "remember" | "correct"; text: string; scope: string;
  provenance: NoteProvenance; now?: number;
}): NoteResult {
  const { root, db, action, provenance } = input; const now = input.now ?? Date.now();
  if (!["remember", "correct"].includes(action) || typeof input.text !== "string" || !input.text.trim() ||
      Buffer.byteLength(input.text) > 16_384 || typeof input.scope !== "string" || !input.scope.trim() ||
      Buffer.byteLength(input.scope) > 1024 || !["command", "tool"].includes(provenance.origin)) throw new Error("invalid_note");
  const noteId = randomUUID(); const textHash = createHash("sha256").update(input.text).digest("hex");
  const noteDirectory = safeWorkspacePath(root, "notes", true);
  mkdirSync(noteDirectory, { recursive: true, mode: 0o700 });
  const textPath = safeWorkspacePath(root, `notes/${noteId}.md`, true);
  db.exec("BEGIN IMMEDIATE");
  let created = false;
  try {
    const previous = (db.prepare("SELECT MAX(created_at) AS time FROM notes").get() as { time: number | null }).time;
    // Preserve committed user correction order even when the wall clock repeats or moves backward.
    const createdAt = Math.max(now, (previous ?? -1) + 1);
    const fd = openSync(textPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    created = true;
    try { writeFileSync(fd, input.text); fsyncSync(fd); } finally { closeSync(fd); }
    syncDirectory(noteDirectory); syncDirectory(resolve(root));
    db.prepare(`INSERT INTO notes (note_id, action, text_path, text_hash, scope, created_at,
      consumer_session, run_id, user_message_id, origin) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(noteId, action, textPath, textHash, input.scope, createdAt, provenance.consumerSession,
        provenance.runId, provenance.userMessageId, provenance.origin);
    if (action === "correct") invalidate(db, "user_correction", now);
    const controlEpoch = epoch(db); db.exec("COMMIT");
    return { noteId, textPath, textHash, scope: input.scope, controlEpoch };
  } catch (error) {
    db.exec("ROLLBACK");
    if (created) { unlinkSync(textPath); syncDirectory(noteDirectory); }
    throw error;
  }
}

/** Deterministic command only: never exposed by the model-callable note tool. */
export function forgetNote(input: { root: string; db: DatabaseSync; noteId: string; now?: number }) {
  const { root, db, noteId } = input; const now = input.now ?? Date.now();
  if (typeof noteId !== "string" || !/^[A-Za-z0-9_-]{1,160}$/.test(noteId)) throw new Error("invalid_note_id");
  db.exec("BEGIN IMMEDIATE");
  let textPath: string | null = null;
  try {
    const note = db.prepare("SELECT text_path FROM notes WHERE note_id = ? AND status = 'active'").get(noteId) as { text_path: string } | undefined;
    if (note) {
      const path = relative(resolve(root), resolve(note.text_path)).split("\\").join("/");
      if (!/^notes\/[A-Za-z0-9_-]+\.md$/.test(path)) throw new Error("unsafe_note_path");
      textPath = safeWorkspacePath(root, path, true);
      db.prepare("UPDATE notes SET status = 'superseded' WHERE note_id = ?").run(noteId);
      invalidate(db, "note_forgotten", now);
    }
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  if (textPath) {
    try { unlinkSync(textPath); syncDirectory(dirname(textPath)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        return { noteId, removed: true, controlEpoch: epoch(db), explanation: NOTE_FORGET_EXPLANATION, cleanupPending: true };
      }
    }
  }
  return { noteId, removed: textPath !== null, controlEpoch: epoch(db), explanation: NOTE_FORGET_EXPLANATION };
}

/** Cleanup follows committed revocation; failure never re-enables the old views. */
export function cleanupRevokedNotes(input: { root: string; db: DatabaseSync; now?: number }): void {
  cleanupGenerations({ root: input.root, db: input.db, now: input.now ?? Date.now() });
}
