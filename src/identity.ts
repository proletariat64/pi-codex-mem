import { createHash } from "node:crypto";

/**
 * Session identity (spec §5.3): sha256 of cwd | projectHint | sessionStart.
 * Same directory + same session start -> same identity; a moved directory
 * or a new session start yields a different one.
 */
export function computeIdentity(cwd: string, projectHint: string, sessionStartIso: string): string {
  return createHash("sha256").update(`${cwd}|${projectHint}|${sessionStartIso}`).digest("hex");
}
