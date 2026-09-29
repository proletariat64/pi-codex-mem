import type { DatabaseSync } from "node:sqlite";

/** Caller owns the transaction; shared revocation and obsolete-writer fencing commit together. */
export function invalidateGeneratedViews(db: DatabaseSync, reason: string, now: number): void {
  db.exec("UPDATE store_state SET control_epoch = control_epoch + 1 WHERE singleton = 1");
  db.prepare("UPDATE pipeline_state SET read_blocked = 1, block_reason = ?, active_generation_id = NULL").run(reason);
  db.exec("UPDATE generations SET status = 'revoked' WHERE status = 'published'");
  db.prepare(`UPDATE jobs SET status = 'superseded', owner = NULL, lease_expires_at = NULL,
    fence = fence + 1, updated_at = ? WHERE kind = 'consolidate' AND status IN ('queued', 'leased', 'retry_wait')`).run(now);
}
