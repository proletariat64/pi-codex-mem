# v0.2.0 implementation acceptance evidence

**Implementation/mock proof, not release sign-off.** The authorized real-model
old-writer-versus-candidate semantic comparison remains **PENDING**. No paid or
external model run was performed for #57. Historical v0.1.0 evaluation does not
certify this change. See the [semantic procedure](consolidation-context-semantic.md).

## Reproduction and environment

```sh
make check
npm run test:behavioral
node --test tests/consolidation-acceptance.test.ts tests/consolidation-compaction.test.ts tests/generation-candidate.test.ts
node eval/context-fixture.mjs --out /tmp/pi-context-256-fixture.json
```

Measured local environment: Node **24.15.0**, Pi coding-agent **0.99.2**, Pi AI
**0.99.2**, Pi agent-core **0.99.2**. Installed peer packages came from the ignored
local `node_modules` symlink, not a newly installed or vendored dependency.
All transport tests use deterministic `mock` model ports and real Agent, SQLite,
staging, validation and publication code. Real provider model/version/tokenizer
measurements: **unavailable**. No runtime accuracy claim follows from mock usage.

The final gate results are recorded below after the final branch synchronization.
Logs are captured outside the repository at `/tmp/impl-57-make-check.log` and
`/tmp/impl-57-behavioral.log`; these paths are local evidence, not durable artifacts.
The behavioral runner checks all discovered tests and requires the existing
**60** labeled T01–T38 version/cross-version matrix rows; the matrix row count is
not the total suite count.

## CT09 actual measured fixture sample

`consolidation-acceptance.test.ts` emits body-free JSON via `t.diagnostic` for
both `CT09 {version}: 256 selected sources retain manifest evidence through actual
paged-history compaction` cases. This is **real compaction code with mock
transport**, not a real-model compaction/semantic measurement. Four complete
workspace-read results cross the soft limit; a tool-free compactor request is
observed, replacement installs, writes settle, and CAS publishes. Every selected
source/note path remains present and the actual manifest hash matches storage.
The script deliberately does not read every source or produce meaningful memory:
it tests protocol and selected evidence retention only.

The final measured `make check` run yielded:

| Version | Model | Counting | Sources/notes | Requests | Tools | Compactions | Writer pass wall time | Available |
|---|---|---|---|---:|---:|---:|---:|---|
| v1 | mock/acceptance | utf8_div4_estimate | 256 / 1 | 4 | 6 | 1 | 4506.062125 ms | yes |
| v2 | mock/acceptance | utf8_div4_estimate | 256 / 1 | 4 | 5 | 1 | 1388.926399 ms | yes |

Times measure `scheduler.runPass`, excluding fixture construction, and are single
local samples under concurrent suite load, not latency targets or provider timing.
Run-owned elapsed telemetry uses the injected fixed test clock; it can show zero
and must not replace these wall-clock measurements. Each case has a fresh store.
Fixture daily budgets are **1,000,000 input / 50,000 output tokens / 12 requests**;
shared lease ceilings remain **12 requests / 40 tools / 300 seconds / 2 successful
compactions**. Source ceiling is 256. The mock's resolved window is 60,000 tokens,
max output 8,000; O=4,000, H=1,024, soft=38,483, hard=49,478, target=27,488.
Mock usage input=10/output=5 per request is synthetic, not tokenizer evidence.
These budgets are **not shipped defaults**. CT14 `daily_denial` uses 1 daily request;
other failure fixtures state their overrides in the named tests. No sources are
sampled to obtain a pass. Real reading/semantic coverage is **not measured**.

## Named acceptance map

Names below are exact test names; `{version}` expands independently to v1/v2.
Multiple assertions exercise one public boundary, not a substitute language gate.

| ID | Named evidence and boundary | Result/limitation |
|---|---|---|
| CT01 | `consolidation-admission.test.ts`: `CT01: a fitting ~404 KB English-heavy transcript is admitted under estimated token admission, not bytes`; `CT01: exact matching-tokenizer admission reserves exact tokens without a safety multiplier`. Controller also tests the 272k window. | Pass request/reservation seam; matching counter is a fixture, not a measured provider tokenizer. |
| CT02 | `context-controller.test.ts`: `countModelVisibleRequest counts instructions, tools, calls, arguments and results exactly once (CT02)`; `countModelVisibleRequest ignores host-only metadata, IDs and serialization escaping (CT02)`; `countModelVisibleRequest counts each effective tool declaration exactly once (CT02)`. | Pass normalized counting boundary. |
| CT03 | `context-controller.test.ts`: `countModelVisibleRequest applies utf8_div4 to English, Chinese, emoji and code/JSON text (CT03)`; `context-calibration.test.ts`: `multiplier increases but is never lowered within a lease (CT03/CT04)`; `consolidation-compaction.test.ts`: `§7.2: a first writer overflow compacts and recounts through the same gates before the resend` and `§7.2: a second overflow after recovery ends provider_context_overflow without resending`. | Pass labels/calibration/bounded recovery; heuristic accuracy remains unproved. |
| CT04 | `context-calibration.test.ts`: `provider calibration normalizes uncached, cache-read and cache-write input into one charge (CT04)`; `missing, zero and invalid usage leave the estimate and reservation intact (CT04)`; `calibration store is reused only for the same model/transport/policy identity (CT04)`; admission test `CT04: underestimation is calibrated into the next estimate and cannot grant requests beyond the daily allowance`. | Pass honest accounting and next admission. |
| CT05 | `consolidation-compaction.test.ts`: `CT05: accumulated pages crossing the soft limit compact at the settled seam and install a recounted replacement`. | Pass settled protocol ordering, hard/target counts, daily reservations; also verifies body-free doctor via a separate read-only connection. |
| CT06 | Same file: `CT06: first segment above target and second below install exactly once atomically`; `CT06: readiness lost on the second segment installs nothing`; `CT06/CT14: denied daily compactor budget on the second segment installs nothing and defers honestly`; `CT06: one oversized unit cannot fit the compactor and ends context_irreducible`; `CT06: exhausted 2-per-lease slots end compaction_limit with nothing installed`; `CT06: an unchanged-size segment summary discards the candidate with compaction_no_progress`; `CT06: full-mode invalid summary output ends compaction_output_invalid (empty, length-capped, oversized)`; `CT06: call exhaustion during a compact trigger ends model_call_budget without a reset`; `CT06: the total writer timeout ends the compact seam as total_timeout`. | Pass bounded compound transformation/failure classifications. |
| CT07 | `consolidation-acceptance.test.ts`: `CT07 {version}: {mutation} during cancellation-ignoring compaction prevents stale continuation and publication`, mutations `correction`, `forget_note`, `forget_source`, `privacy_edit`, `selection`, `configuration`. Compaction tests also name `CT07: foreground activation during compaction discards the candidate without installing`, `CT07: lease loss during compaction ends lease_lost and installs nothing`, and `CT07: a mid-compaction abort discards the late result, charges the estimate and installs nothing`. | Pass production scheduler privacy/selection checks and late-result fences; already-sent bytes remain irrevocable. |
| CT08 | Compaction tests: `CT08 {version}: compaction retains staged output hashes, pinned framing, tools and host lease identity`; `CT08: compaction preserves the outstanding repair diagnostic verbatim next to the labeled summary`. | Pass original framing/tool equality, staged digest stability, lease identity, v2 write isolation and absence of new note/generation rights. |
| CT09 | Acceptance tests: `CT09 {version}: 256 selected sources retain manifest evidence through actual paged-history compaction`. | Pass complete selection/manifest/operation mock fixture; **real-model low-ranked evidence, routes, conflicts and corrections semantic proof pending**. |
| CT10 | `staging-diff.test.ts`: `a one-line edit to a large baseline file produces a local hunk, not whole-file replacement`; `empty, CRLF, Unicode, repeated-line and no-final-newline diffs are byte-deterministic across runs`; `pathological edits fall back to the complete path index with computation_limit, never a partial diff`; `a diff crossing the 4 MiB ceiling mid-manifest yields the complete index with the size reason`. | Pass deterministic parser/apply oracle, no partial path index. |
| CT11 | `staging-incremental.test.ts`: `revoked prior plaintext never enters a diff even with oversized content`; acceptance test `CT11 {version}: revoked baseline plaintext never reaches rebuilt diffs, compactor requests or publication`. | Pass revoked baseline exclusion through actual forget/rebuild/compaction/publication path; no valid first-build baseline assumed. |
| CT12 | Entire `make check` suite and T01–T38 behavioral matrix; `memory-diagnostics.test.ts`: `diagnostics and doctor are SELECT-only: no jobs, budgets, grants, pins or usage change` and `mock-pi status and doctor expose shared recovery blockers read-only with no model calls`. | Pass repository regression gates, existing artifacts/repair/CAS/crash/quotas/fairness/no-op contracts; no new prose-citation gate. |
| CT13 | Policy tests: `CT13 {version}: new context policy retries blocked byte-budget work without mutating configuration or resuming old writers`; acceptance test `CT13 {version}: upgrade and rollback preserve notes, enrollment, charged usage and legacy hash-verified manifests`; candidate test `CT13 {version}: publication rejects an old-policy lease after a policy identity change`. | Pass explicit 8/default 256, distinct work keys, old-policy send rejection, mixed-policy CAS rejection, optional old manifest fields with actual stored-hash verification, storage/privacy/budget preservation. Rollback is a public API storage fixture, not a second installed Pi binary. |
| CT14 | Acceptance tests: `CT14 {version}: {failure} retains and accurately reports the prior eligible publication`, failures `invalid_summary`, `daily_denial`; compaction test `§5.3/CT14: a successful compaction leaves no summary body in any durable table or log row`. | Pass prior eligible generation/read pin retention, real availability reporting, next-day denial and body-free storage/logs. |

## Policy/storage notes and gates

Counting/compaction/diff identities participate in the one coherent writer hash
bump (renderer revision 3). Existing scheduler dirty keys/configuration epochs
already compose this hash; no parallel policy state machine was added. SQLite and
config schemas are unchanged. Detailed runtime observations are process-local,
not durable fields or transcripts. Existing manifest diff fields remain optional
and policy-versioned. `COMPACTION_SUMMARY_LABEL` is now private: repository-wide
caller inspection found no external caller/test import; protocol label assertions
remain covered.

Code-review-graph was absent initially, then rebuilt locally without embeddings
or cloud access (`build --skip-postprocess`); depth-2 impact inspection identified
scheduler/candidate/extension and diagnostics consumers before edits. The graph
has unresolved call sites; focused source/test inspection supplemented it. Active
LSP diagnostics reported no findings, with one confirmed clean file and three
inconclusive push-only checks; TypeScript's repository gate is the confirmed check.

Final gate record after synchronization with integration tip **e6dbad4** (merge
reported already up to date): `make check` **619/619 passed**, 0 failed/skipped,
**47,230.731045 ms** suite time, TypeScript passed, **9** upstream files verified.
`npm run test:behavioral`: **60/60** labeled matrix rows passed, 0 missing,
0 failed/skipped, no unrelated failures. `git diff --check` passed.
The semantic gate stays pending regardless of these implementation results;
do not mark the whole spec complete or ready to release based solely on this report.
