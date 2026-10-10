// Offline fixture preparation only: no Pi credentials, SDK, database or transport.
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** Build deterministic synthetic evidence and evaluation questions without making model requests. */
export function contextSemanticFixture() {
  const sources = Array.from({ length: 256 }, (_, i) => {
    const sourceId = `source-${String(i).padStart(3, "0")}`;
    const rolloutSummary = `Synthetic ${sourceId}: exact route /api/${sourceId}; conflict: use old route only before correction. ` + "bounded fixture detail ".repeat(24);
    return { sourceId, sessionKey: `session-${sourceId}`, lineageKey: `lineage-${sourceId}`,
      cwd: "/synthetic/context-fixture", rolloutSlug: sourceId, rolloutSummary,
      rawMemory: rolloutSummary, sourceTime: "2026-09-28T23:59:59.000Z" };
  });
  return {
    fixtureVersion: 1,
    authorization: "offline only; model execution requires separate approval",
    versions: ["v1", "v2"],
    budgets: { dailyInputTokens: 1_000_000, dailyOutputTokens: 50_000, dailyRequests: 12,
      requestsPerLease: 12, toolsPerLease: 40, timeoutMs: 300_000, successfulCompactions: 2 },
    sources,
    notes: [{ noteId: "route-correction", action: "remember", scope: "global",
      text: "Correction fixture: route /api/source-255 supersedes /api/old; keep scope exact." }],
    // A deliberately low-ranked source must remain useful, not merely selected.
    ranking: { lowRankedSourceId: "source-255", highRankUsageCount: 1, lowRankUsageCount: 0 },
    questions: [
      { id: "low-ranked-route", question: "What exact route applies to source-255, and what old route does the note supersede?",
        sourceIds: ["source-255"], noteIds: ["route-correction"],
        required: ["/api/source-255", "/api/old is superseded"], prohibited: ["/api/old is the current route"] },
      { id: "middle-route", question: "What is the exact source-128 route and its conflict rule?",
        sourceIds: ["source-128"], noteIds: [], required: ["/api/source-128", "old route only before correction"], prohibited: ["an invented replacement route"] },
      { id: "scope", question: "Which project do these routes apply to? May I apply them to an unrelated project?",
        sourceIds: ["source-000", "source-255"], noteIds: [], required: ["/synthetic/context-fixture", "no unsupported cross-project application"], prohibited: ["all projects"] },
      { id: "abstention", question: "Who approved production deployment and on what date?",
        sourceIds: [], noteIds: [], required: ["approval and date are not provided"], prohibited: ["invented deployment approval"] },
    ],
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 4 || process.argv[2] !== "--out") throw new Error("usage: node eval/context-fixture.mjs --out NEW_FILE.json (offline only)");
  writeFileSync(process.argv[3], JSON.stringify(contextSemanticFixture(), null, 2) + "\n", { flag: "wx", mode: 0o600 });
  console.log("Offline synthetic fixture prepared; no model request made.");
}
