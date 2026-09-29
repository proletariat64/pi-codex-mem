import type { MemoryVersion } from "../config.ts";
import type { SelectedExtraction } from "../store/consolidation.ts";

const summaryHeadings = ["## User Profile", "## User preferences", "## General Tips", "## What's in Memory"];

/** A writer can repair its own format, never host integrity or revoked evidence. */
export class ArtifactFormatError extends Error {}

/** Codex format contract plus the signed-off project/date grouping adaptation. */
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
  let inIndex = false;
  let project = "";
  let date = "";
  let older = false;
  let fence: string | null = null;
  for (const raw of lines) {
    const line = raw.trim();
    const codeFence = /^(`{3,}|~{3,})/.exec(line)?.[1];
    if (codeFence) {
      if (!fence) fence = codeFence;
      else if (codeFence[0] === fence[0] && codeFence.length >= fence.length) fence = null;
      continue;
    }
    if (fence) continue;
    if (/^##(?:\s|$)/.test(line)) {
      inIndex = line === "## What's in Memory";
      project = ""; date = ""; older = false;
      continue;
    }
    if (!inIndex) continue;
    const group = /^###(?:\s+(.*))?$/.exec(line);
    if (group) {
      older = group[1] === "Older Memory Topics";
      project = older ? "" : (group[1]?.trim() ?? "");
      date = "";
      continue;
    }
    const subgroup = /^####(?:\s+(.*))?$/.exec(line);
    if (subgroup) {
      const value = subgroup[1]?.trim() ?? "";
      if (older) { project = value; continue; }
      const parsed = Date.parse(`${value}T00:00:00Z`);
      if (!project || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(parsed) ||
          new Date(parsed).toISOString().slice(0, 10) !== value) {
        throw new ArtifactFormatError("recent topic requires a project and valid date group");
      }
      date = value;
      continue;
    }
    // All nested children share their top-level topic's grouping; no citation checks.
    if (!/^\s*(?:[-+*]|\d+[.)])\s+\S/.test(raw)) continue;
    if (!project || (!older && !date)) {
      throw new ArtifactFormatError(older ? "older topic requires project scope" : "recent topic requires project/date grouping");
    }
  }
}

export function renderSelectedEvidence(source: SelectedExtraction): string {
  return `source_id: ${source.sourceId}\nsession_key: ${source.sessionKey}\ncwd: ${source.cwd}\nworkspace_key: ${source.workspaceKey}\nupdated_at: ${new Date(source.sourceUpdatedAt).toISOString()}\n\n${source.rolloutSummary}\n`;
}
