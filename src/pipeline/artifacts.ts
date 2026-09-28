import type { SelectedExtraction } from "../store/consolidation.ts";

const summaryHeadings = ["## User Profile", "## User preferences", "## General Tips", "## What's in Memory"];

/** Shared publication/read contract. UTF-8 decoding and file integrity stay with the caller. */
export function validateSummaryFormat(summary: string, maximum = 9_999): void {
  if (!Number.isInteger(maximum) || maximum < 1 || maximum > 9_999) throw new Error("invalid summary byte cap");
  if (summary.split(/\r?\n/)[0] !== "v1") throw new Error("summary first-line marker must be literal v1");
  if (Buffer.byteLength(summary) > maximum) throw new Error("summary exceeds UTF-8 byte cap");
  const headings = summary.split(/\r?\n/).filter((line) => line.startsWith("## "));
  if (headings.join("\n") !== summaryHeadings.join("\n")) throw new Error("summary requires four headings in order");
}

export function renderSelectedEvidence(source: SelectedExtraction): string {
  return `source_id: ${source.sourceId}\nsession_key: ${source.sessionKey}\ncwd: ${source.cwd}\nworkspace_key: ${source.workspaceKey}\nupdated_at: ${new Date(source.sourceUpdatedAt).toISOString()}\n\n${source.rolloutSummary}\n`;
}
