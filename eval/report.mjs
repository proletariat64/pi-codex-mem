#!/usr/bin/env node
// A score needs an independent human review for every answer. No regex judge is allowed to certify semantics.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";

function readJsonl(path) {
  try {
    const text = readFileSync(path, "utf8").trim();
    return text ? text.split("\n").map((line, index) => {
      try { return JSON.parse(line); }
      catch (error) { throw new Error(`${path}:${index + 1}: ${error}`); }
    }) : [];
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}
const key = row => `${row.caseId}:${row.mode}:${row.rep}`;
const percent = (value, total) => total ? `${(100 * value / total).toFixed(1)}%` : "n/a";
const mean = values => values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : "n/a";

function report(out) {
  let plan;
  try { plan = JSON.parse(readFileSync(join(out, "plan.json"), "utf8")); }
  catch (error) { throw new Error(`Cannot load eval plan: ${error}`, { cause: error }); }
  let fixtureCases;
  try { fixtureCases = JSON.parse(readFileSync(new URL("./cases.json", import.meta.url), "utf8")); }
  catch (error) { throw new Error(`Cannot load evaluation fixtures: ${error}`, { cause: error }); }
  const discussionDecisions = new Set(fixtureCases.filter(item => item.category === "decision" &&
    item.sourceSessions.every(session => session.messages.every(message => message.role !== "tool")))
    .map(item => item.id));
  const forgottenFixtures = new Map(fixtureCases.filter(item => item.forgetBeforeAnswer?.length)
    .map(item => [item.id, item.forgetBeforeAnswer]));
  const results = readJsonl(join(out, "results.jsonl"));
  const failures = readJsonl(join(out, "failures.jsonl"));
  const reviews = readJsonl(join(out, "reviews.jsonl"));
  const expected = new Set(plan.selected.flatMap(id => plan.modes.flatMap(mode =>
    Array.from({ length: plan.reps }, (_, index) => `${id}:${mode}:${index + 1}`))));
  const resultByKey = new Map();
  for (const row of results) {
    if (!expected.has(key(row)) || resultByKey.has(key(row))) throw new Error(`Unexpected/duplicate result ${key(row)}`);
    if (row.mode === "none" && row.injectedBytes !== 0) throw new Error(`${key(row)}: no-memory baseline has injected bytes`);
    resultByKey.set(key(row), row);
  }
  const reviewByKey = new Map();
  for (const row of results.filter(item => item.failed === true)) {
    reviewByKey.set(key(row), { grounded: false,
      decisionAndRationale: row.category === "decision" ? false : null,
      correctAbstention: row.category === "abstention" ? false : null,
      criticalFabrication: false, reviewer: "runner", notes: `No answer: ${row.failureKind}` });
  }
  for (const row of reviews) {
    const id = key(row);
    if (!resultByKey.has(id) || reviewByKey.has(id)) throw new Error(`Unexpected/duplicate review ${id}`);
    for (const name of ["grounded", "decisionAndRationale", "correctAbstention", "criticalFabrication"])
      if (row[name] !== null && typeof row[name] !== "boolean") throw new Error(`${id}: review ${name} must be boolean/null`);
    for (const name of ["grounded", "criticalFabrication",
      ...(resultByKey.get(id).category === "decision" ? ["decisionAndRationale"] : []),
      ...(resultByKey.get(id).category === "abstention" ? ["correctAbstention"] : [])])
      if (typeof row[name] !== "boolean") throw new Error(`${id}: review ${name} must be adjudicated`);
    if (typeof row.reviewer !== "string" || !row.reviewer.trim() || typeof row.notes !== "string")
      throw new Error(`${id}: reviewer and notes are required`);
    reviewByKey.set(id, row);
  }
  const missingResults = [...expected].filter(id => !resultByKey.has(id));
  const missingReviews = [...expected].filter(id => !reviewByKey.has(id));
  const fullCoverage = plan.selected.length === 30 && plan.reps === 3 && failures.length === 0 &&
    missingResults.length === 0 && missingReviews.length === 0;
  const lines = ["# Semantic memory evaluation", "",
    `- Dataset: ${plan.selected.length}/30 cases, ${plan.reps}/3 repetitions, ${plan.modes.join(" / ")}`,
    `- Attempts: ${results.length}/${expected.size}; human reviews: ${reviews.length}; automatic no-answer misses: ${results.filter(row => row.failed).length}; failed attempts: ${failures.length}`,
    `- Cumulative estimated spend (including failed attempts): $${Math.max(failures.at(-1)?.cumulativeEstimatedUSD ?? 0, results.at(-1)?.cumulativeEstimatedUSD ?? 0).toFixed(4)}${failures.some(item => item.unknownSpend) ? " + unknown provider usage" : ""}`,
    `- Models: extraction ${plan.models.extract.provider}/${plan.models.extract.modelId}; writer ${plan.models.consolidate.provider}/${plan.models.consolidate.modelId}; answer ${plan.models.answer.provider}/${plan.models.answer.modelId}`,
    `- Prompt hashes: answer ${plan.promptHashes?.answer ?? "not recorded"}; v1 ${JSON.stringify(plan.promptHashes?.v1 ?? "not recorded")}; v2 ${JSON.stringify(plan.promptHashes?.v2 ?? "not recorded")}`,
    `- Completeness: ${fullCoverage ? "full" : "partial — NO GO"}`,
    "", "| Mode | Grounded | Decision + rationale | Correct abstention | Critical fabrication | Injected bytes avg | Detail reads | Answer latency avg | Total latency avg | Extract USD | Writer USD | Answer USD | Failed USD | Total USD |", "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|"];
  const curatedGrounded = results.filter(row => row.mode === "curated")
    .filter(row => reviewByKey.get(key(row))?.grounded === true).length;
  const verdicts = [];
  for (const mode of plan.modes) {
    const rows = results.filter(row => row.mode === mode);
    const judged = rows.map(row => ({ row, review: reviewByKey.get(key(row)) })).filter(pair => pair.review);
    const decisions = judged.filter(pair => pair.row.category === "decision");
    const abstentions = judged.filter(pair => pair.row.category === "abstention");
    const count = (array, field) => array.filter(pair => pair.review[field] === true).length;
    const rate = (array, expectedCount, field) => array.length === expectedCount
      ? percent(count(array, field), expectedCount) : `pending ${array.length}/${expectedCount}`;
    const grounded = rate(judged, rows.length, "grounded");
    const decision = rate(decisions, rows.filter(row => row.category === "decision").length, "decisionAndRationale");
    const abstention = rate(abstentions, rows.filter(row => row.category === "abstention").length, "correctAbstention");
    const critical = rate(judged, rows.length, "criticalFabrication");
    const extractUSD = rows.reduce((sum, row) => sum + (row.generation?.extractionUsage?.dollars ?? 0), 0);
    const writerUSD = rows.reduce((sum, row) => sum + (row.generation?.consolidationUsage?.dollars ?? 0), 0);
    const answerUSD = rows.reduce((sum, row) => sum + (row.estimatedUSD ?? 0), 0);
    const failedUSD = rows.reduce((sum, row) => sum + (row.generationFailureUSD ?? 0), 0);
    const detailReads = rows.reduce((sum, row) => sum + (row.memoryTools ?? [])
      .filter(name => name === "pi_memory_read").length, 0);
    lines.push(`| ${mode} | ${grounded} (${judged.length}) | ${decision} (${decisions.length}) | ${abstention} (${abstentions.length}) | ${critical} (${judged.length}) | ${mean(rows.map(row => row.injectedBytes ?? 0))} | ${detailReads} (${rows.length ? (detailReads / rows.length).toFixed(2) : "n/a"}/answer) | ${mean(rows.map(row => row.latencyMs))} ms | ${mean(rows.map(row => row.totalLatencyMs ?? row.latencyMs))} ms | $${extractUSD.toFixed(4)} | $${writerUSD.toFixed(4)} | $${answerUSD.toFixed(4)} | $${failedUSD.toFixed(4)} | $${(extractUSD + writerUSD + answerUSD + failedUSD).toFixed(4)} |`);
    if (mode === "v1" || mode === "v2") verdicts.push({ mode,
      pass: fullCoverage && decisions.length === 30 && abstentions.length === 15 && judged.length === 90 &&
        count(decisions, "decisionAndRationale") >= 27 && count(judged, "criticalFabrication") === 0 &&
        count(abstentions, "correctAbstention") >= 14 && count(judged, "grounded") >= curatedGrounded - 4 });
  }
  const hashes = plan.promptHashes;
  const hasProvenance = [hashes?.answer, hashes?.v1?.extraction, hashes?.v1?.consolidation,
    hashes?.v2?.extraction, hashes?.v2?.consolidation].every(value => /^[a-f0-9]{64}$/.test(value ?? ""));
  const discussionProof = Object.fromEntries(["v1", "v2"].map(mode => [mode, results.filter(row =>
    row.mode === mode && discussionDecisions.has(row.caseId) && row.injectedBytes > 0 &&
    row.generation?.import?.length && row.generation.consolidation?.some(pass => pass.status === "published") &&
    reviewByKey.get(key(row))?.grounded === true && reviewByKey.get(key(row))?.decisionAndRationale === true)
    .map(row => `${row.caseId}:rep${row.rep}`)]));
  const forgetProof = Object.fromEntries(["v1", "v2"].map(mode => [mode, results.filter(row =>
    row.mode === mode && forgottenFixtures.has(row.caseId) && row.injectedBytes === 0 &&
    forgottenFixtures.get(row.caseId).every(id => row.generation?.forgotten?.includes(id)) &&
    reviewByKey.get(key(row))?.criticalFabrication === false &&
    reviewByKey.get(key(row))?.correctAbstention === true).length]));
  const expectedForgetCount = plan.selected.filter(id => forgottenFixtures.has(id)).length * plan.reps;
  lines.push("", `- Discussion-only generated-memory proof: v1 ${discussionProof.v1.join(", ") || "missing"}; v2 ${discussionProof.v2.join(", ") || "missing"}`,
    `- Post-publication forget proof: v1 ${forgetProof.v1}/${expectedForgetCount}, v2 ${forgetProof.v2}/${expectedForgetCount}`,
    `- Provenance hashes: ${hasProvenance ? "complete" : "missing — NO GO"}`,
    "", `## Release gate: ${fullCoverage && hasProvenance && verdicts.every(value => value.pass) &&
      discussionProof.v1.length > 0 && discussionProof.v2.length > 0 && expectedForgetCount > 0 &&
      forgetProof.v1 === expectedForgetCount && forgetProof.v2 === expectedForgetCount ? "GO" : "NO GO"}`,
    "", "Threshold per generated version: ≥90% decision + rationale (≥27/30); ZERO critical fabrication (0/90); ≥90% correct abstention (≥14/15); grounded success ≤5 percentage points below curated (≥curated minus 4 of 90).",
    "Failed generated-memory attempts without an answer count as misses automatically; a complete release gate still requires zero failed attempts. Other answers require manual evidence review.",
    "Costs use the selected Pi catalog's published token rates and are estimates, not provider invoices.", "");
  if (missingResults.length) lines.push(`Missing results (${missingResults.length}): ${missingResults.join(", ")}`, "");
  if (missingReviews.length) lines.push(`Missing reviews (${missingReviews.length}): ${missingReviews.join(", ")}`, "");
  return lines.join("\n");
}

try {
  const out = resolve(process.argv[2] ?? "");
  if (!process.argv[2]) throw new Error("Usage: node eval/report.mjs <run-directory> [--write]");
  const text = report(out);
  if (process.argv[3] === "--write") writeFileSync(join(out, "report.md"), `${text}\n`, { mode: 0o600 });
  console.log(text);
} catch (error) { console.error(error); process.exitCode = 1; }
