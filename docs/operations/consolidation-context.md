# Phase 2 context management

Applies to both writers only. Phase 1 and foreground accounting are unchanged.
See [acceptance evidence](consolidation-context-acceptance.md) and the
[pending semantic comparison procedure](consolidation-context-semantic.md).

## Selection and admission

`maxConsolidationSources` remains a selection ceiling: shipped default 256;
explicit 8 stays 8. Capacity events never sample or silently reduce selection.
All active notes and all selected extraction entries remain in the manifest.
Selection and operation counts are **not** proof that a model read or understood
all evidence.

Phase 2 counts the normalized model-visible request, including instructions,
tools, messages, calls and results. A matching model/transport tokenizer takes
priority. Otherwise `utf8_div4_estimate` uses explicit framing estimates and an
initial 1.25 safety multiplier. This heuristic is **not** a conservative upper
bound, especially for Unicode/code. Trustworthy provider input usage (uncached +
cache read + cache write) can raise, never lower, the multiplier within a lease.
Calibration is process-local and model/transport/counting-policy confined.

For resolved context window W, ordinary output reserve O=min(4000,maxTokens),
and separate unknown-framing reserve H=1024 tokens, usable input is I=W-O-H.
Soft/hard/target are floor(I × 0.70/0.90/0.50). These are token capacities;
admission estimates explicitly use `estimated_tokens` when not exact. The
16 KiB tool-response and summary byte ceilings are different quantities.
Every outgoing request is freshly counted and transactionally reserved.
Missing usage retains its safety-adjusted charge, not a guaranteed upper bound.
Deleting working history never refunds spent tokens or requests.

## Compaction and bounded failure

At a fully settled tool seam, soft-limit crossing triggers a tool-free request
through the captured consolidation model port. The ordinary over-limit request
is not sent. Compaction fits its own hard limit. Complete conversational units
may be summarized oldest-first when full history cannot fit; intermediate
candidates stay private. Only a reducing replacement at/below target installs
atomically. Original framing/tools, staged files, host identity, repair state and
shared counters survive. Summaries are labeled derived assistant context, not
permissions, sources, notes or publication provenance.

Bounds remain **12 total model requests, 40 tool calls, 300 seconds**, with at
most **2 successful compaction operations**, including segments. There is one
artifact-format repair, not a compaction-output repair. Explicit provider
context overflow permits one estimated-mode recovery (multiplier at least
doubled, compact/recount before resend); a second overflow terminates. Exact
mode treats overflow as a counting/transport mismatch. Generic HTTP 400/timeouts
are not inferred to be context overflow.

Readiness, selection/control/config identity and lease checks apply before each
request/tool and before installation/publication. Late/cancellation-ignoring
results cannot authorize stale work. Already sent network bytes cannot be
recalled. Failure discards staging and retains an eligible previous publication;
privacy revocation can instead make that publication unavailable. Daily denial
uses existing next-day scheduling. `--now` skips idle waiting only.

Reason codes distinguish capacity/irreducible input, compaction allowance,
no-progress/invalid summary, provider overflow, request/tool/timeout limits and
shared daily input/output/request admission. Large arbitrary 256-source workloads
can still hit these limits; no automatic batching promise is made.

## Diffs, status and doctor

Modified same-version eligible files use bounded deterministic line hunks with
three context lines. Added/deleted files retain explicit status and no-final-newline
markers. The complete changed-path index remains authoritative. Oversized or
pathological diffs use path-index fallback (`size`, `computation_limit`); invalid
prior support uses `privacy_or_retention`. Revoked prior plaintext is never
reintroduced just to improve a deletion diff.

Status and doctor distinguish **persistent READABLE/UNAVAILABLE** from writer
progress and host health. Body-free writer observations include counting
method/policy/multiplier, latest normalized observation, window/reserves/limits,
last measured request base input and calibrated admission estimate, selected
source/note counts, requests/tools/compactions, last compaction before/after/result,
diff mode/fallback and failure/retry reason. Counts describe measured requests,
not exact current provider occupancy or semantic coverage. Scheduling is shown
separately; a due retry is not an admission guarantee.

These observations are **process-local**, shared with the same process's separate
read-only doctor connection and matched to the latest job. Another process or a
restart reports them unavailable; it does not invent zeros. Durable job/budget/
availability information remains available. No transcripts, summaries or new
SQLite tables are stored. Doctor remains read-only and does not start work.

## Upgrade and rollback

The writer identity coherently includes counting policy, compaction framing/bounds
and diff policy; renderer revision is 3. Existing dirty checks and configuration
epochs already depend on this hash. Old blocked `context_budget` jobs acquire a
new work key under the new valid policy. No Agent is mutated live; reload/settle
under normal fences. Mixed job-policy identities cannot publish.

Config schema remains 1; no setting or budget field is added. Generation manifests
retain schema 1 and the optional `diffPolicyVersion` (1) / `diffFallbackReason`
extension from the diff change. Legacy manifests without those fields remain
readable; readers verify actual stored bytes against the stored hash. No new
manifest extension is needed for process-local observations. Rollback uses the
previous writer hash without clearing notes, enrollment, invalidation or charged
usage. It cannot resurrect forgotten content.

**Release limitation:** deterministic mocks prove protocol/storage behavior, not
language quality, real-provider token accuracy, complete reading or semantic
coverage. The v0.2.0 semantic baseline-versus-candidate gate is still pending;
historical v0.1.0 sign-off does not authorize or certify this revision.
