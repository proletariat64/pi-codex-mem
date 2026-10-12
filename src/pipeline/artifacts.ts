import type { MemoryVersion } from "../config.ts";
import type { SelectedExtraction } from "../store/consolidation.ts";

const summaryHeadings = ["## User Profile", "## User preferences", "## General Tips", "## What's in Memory"];

/** Invalid upstream artifact format, distinct from host integrity failures. */
export class ArtifactFormatError extends Error {}

/** Pinned Codex artifact contract; no additional prose/grouping policy. */
export function validateSummaryFormat(summary: string, version: MemoryVersion): void {
  const lines = summary.split(/\r?\n/);
  if (lines[0] !== "v1") throw new ArtifactFormatError("summary first-line marker must be literal v1");
  if (version === "v2") {
    if (Buffer.byteLength(summary, "utf8") >= 10_000) throw new ArtifactFormatError("summary exceeds UTF-8 byte cap");
    const headings = new Set(lines.map(line => line.trim()));
    for (const heading of summaryHeadings) if (!headings.has(heading)) {
      throw new ArtifactFormatError(`summary missing required heading: ${heading}`);
    }
  }

}

export function renderSelectedEvidence(source: SelectedExtraction): string {
  return `source_id: ${source.sourceId}\nsession_key: ${source.sessionKey}\ncwd: ${source.cwd}\nworkspace_key: ${source.workspaceKey}\nupdated_at: ${new Date(source.sourceUpdatedAt).toISOString()}\n\n${source.rolloutSummary}\n`;
}
