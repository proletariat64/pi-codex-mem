# Pending v0.2.0 semantic comparison procedure

**Not executed; not authorized.** This procedure and the historical v0.1.0 release
record do not grant permission to spend or transmit data. Obtain explicit approval
for exact provider/model IDs, a total USD ceiling, fixture hashes, repetitions and
output location first. The generator below is offline and uses synthetic text only.
No new paid runner or credential discovery is enabled by this ticket.

## Freeze the inputs (offline)

```sh
node eval/context-fixture.mjs --out /tmp/pi-context-256-fixture.json
sha256sum /tmp/pi-context-256-fixture.json
```

The output path must not exist. The generator records `evaluationTime` (the current
time by default) and dates every source one day earlier, within the 30-day
eligibility window. To reproduce a fixture, pass the same timestamp with
`--evaluation-time ISO_TIMESTAMP`. The file contains 256 deterministic extraction
payloads, notes, exact-route/conflict/correction/scope/abstention questions and
answer criteria, both versions and explicit test budgets. It follows CT09's small
summary corpus; selection must keep `source-255`, even when ranked last. The
offline fixture test checks reproducibility and overwrite protection. Preserve
this one file for both branches; do not regenerate/swap cases after seeing answers.

Use **baseline e75a740** (the pre-context-management writer) and an exact candidate
commit, with the same installed Pi/AI/core versions. Record their actual commit
IDs and prompt hashes. e6dbad4 is an integration checkpoint, not the old-writer
semantic baseline. Install/bootstrap worktrees locally without running models.
Keep evaluation stores/results outside the repository and out of real memory roots.

## Seed identical pristine stores

Use the public APIs demonstrated by `tests/consolidation-acceptance.test.ts`:
`recordSnapshot`, `enqueueExtraction`, `claimDueExtractions`, `commitExtraction`,
`addNote`, `selectConsolidation`. This is a **Phase 2-only** comparison; never
re-extract with a model separately for each branch.

1. Seed each fixture payload with its fixed source/session/lineage IDs, canonical
   `/synthetic/context-fixture` scope, recorded source time and exact rollout text.
   V1 receives the same text as raw memory; v2 receives `rawMemory=null` and the
   existing explicit truncation metadata. Use the unchanged version-specific
   extraction prompt hash and `textHash` for the exact extraction text.
2. Save the fixture note through `addNote` with synthetic user provenance. Snapshot
   this golden store *after* the note exists, before any writer job or budget charge.
   For the ranking exercise, give the first 255 lineages usage count 1 and
   `source-255` count 0; retain all 256 in `selectConsolidation`. Apply that same
   ranking to both branch runs. Hash the extraction/note payloads and selection.
3. Run branches sequentially at the **same evaluation root path**, restoring the
   pristine golden files/SQLite backup between runs (close all connections first).
   This preserves randomly allocated extraction/note IDs and absolute paths too.
   Never copy a live WAL or reset a production store. Separate roots/golden backups
   per version and repetition; no baseline-generation carryover between branches.
4. Write the identical valid config before each run: selected version, dualWrite
   false, source ceiling 256, same approved consolidation model, UTC, daily
   input/output/request budgets **1,000,000 / 50,000 / 12**. Leave 12 requests,
   40 tools and 300 seconds per lease unchanged. Record all remaining config
   fields. Budget tuning requires a new paired experiment, never only a candidate
   increase. Extraction seeding is offline and does not consume model calls.

## Execute only after approval

Bind the approved owning Pi registry through `createConsolidationModelPort`, as
production does. Use `ConsolidationScheduler.runPass` with the real captured
registry, actual resolved window/output cap and idle readiness. For each branch,
anchor the injected clock at the fixture's `evaluationTime` and advance it with
real elapsed time (for example, `Date.parse(fixture.evaluationTime) +
Math.floor(performance.now() - startedAt)`, capturing `startedAt` at each run's start).
Use that same clock for seeding and selection so both branches see the same source
age; retain real elapsed time for lease and timeout enforcement.
Do not replace requests, inject fabricated provider usage, shorten source
selection, hard-code a summary, disable validation or dispatch hidden retries.
The operator's runner must enforce the approved USD ceiling **before each
transport** in addition to the plugin's transactional daily budget. Unknown
usage/spend stops the run. The existing `eval/run.mjs` approval/resume/review
patterns are guidance; its stock 30-case/evaluation quotas are **not** this
256-source Phase 2 comparison and must not be reported as CT09.

Capture for every assigned baseline/candidate attempt, including failures:

- commit, actual Pi/AI/core versions, resolved provider/model/API, window/maxTokens;
- fixture/config/selection/prompt hashes, counting mode/policy/multiplier and usage;
- selected source/note counts, request/tool/compaction counts, compaction before/
  after/results, daily denial/terminal reason, wall-clock elapsed and spent cost;
- actual eligible publication and foreground availability, generated output hashes;
- answers to the **same** fixture questions using the **same** answering model,
  instructions, detail-tool permissions and input/output/request budgets.

Use run observations for the candidate, durable reservations and a body-free
transport/tool observer for the baseline. Runtime logs must not contain evidence
or summary bodies. Private evaluation artifacts may contain synthetic generated
text for review; keep them separate from ordinary logs. No completion/substitution
of a failed baseline is allowed merely to obtain answers. No publication means a
failed/no-answer attempt, not an omitted sample.

Real model behavior may not compact this small corpus in a large resolved window.
Record **zero**, not a fabricated compaction. If a paired stress variant is needed
to examine semantic retention after real compaction, predefine larger synthetic
payloads/complete settled pages and freeze a *new identical* baseline/candidate
fixture before either run; report the actual request/tool/time limit reached.
Passing the small corpus without compaction is not real-compaction semantic proof.

## Independent review and stop condition

Review each assigned attempt against the fixture's required/prohibited facts and
source/note IDs, without using the producing model as the sole judge. Check the
low-ranked route, exact strings, project scope, conflicts and note correction,
and abstention about nonexistent approval. Inspect the complete answers, not
substring matches. A manifest with 256 entries is not a correctness score.
Record misses, wrong scope, fabricated provenance, invented approvals and forgotten
content explicitly. Compare baseline/candidate paired results and confidence/
repetitions chosen **before** execution; do not select the best sample. Preserve
failed attempts and charges. The v0.2.0 release gate remains **pending** until this
comparison and operator acceptance are recorded alongside implementation gates.
