# v0.2.0 real-model semantic comparison: results

**Status: EXECUTED — FAILED/INCOMPLETE. Real semantic acceptance is not met.** The
frozen baseline/candidate comparison ran, but some assigned slots did not publish,
semantic coverage is incomplete, and no real compaction occurred. This is not
release sign-off. It establishes no model-quality, provider-accuracy, or candidate
superiority claim. The implementation/mock gates are mechanism evidence only.

See the [implementation acceptance record](consolidation-context-acceptance.md)
and [semantic procedure](consolidation-context-semantic.md). The procedure records
the frozen setup and controls; it does not authorize another run. No limit,
fixture, retry, or semantic gate was changed to obtain these results.

## Frozen comparison and controls

- **Baseline:** `e75a74088f07b7ae04fa022143103b537c407e8a`.
- **Candidate:** `f087c670df4c609439de627990661d30792d28c1`, clean when evaluated.
  Evaluation did not modify candidate source code.
- **Fixtures:** standard SHA-256
  `1542b0bac36dac721b4c4308a2d22b918b21236382fcda74e24630fa32e53a03`; stress
  SHA-256 `ccaed6c7d5dc70cc3d786aac6fe428f397d2481309cb84060c9e12d6a994cca1`.
  Each fixture selected exactly 256 sources plus one note. Both were frozen and
  paired; no post-answer fixture substitution occurred.
- **Model/API:** `openai-codex/gpt-6-luna` via
  `openai-codex-responses`; resolved catalog context window 272,000 tokens.
  Runtime: Pi coding-agent/AI/agent-core 0.99.2, Node 24.15.0, SDK 0.99.2.
- **Unchanged generation limits:** 12 requests, 40 tools, 300 seconds, daily
  1,000,000 input / 50,000 output tokens and 12 requests, 4,000 output tokens
  per request, and at most two successful compactions. Each answer session was
  limited to four requests, 32,768 input and 2,048 output tokens. The estimated
  global spend guard remained USD 20. No budget or threshold tuning was made.
- The four standard/stress baseline-candidate pairs had equal selection,
  configuration and answer-system hashes. This establishes paired input identity,
  not equal output or semantic completeness.

## Run history

### Run 002: earlier standard-only overview

The earlier standard-only pilot used the same 256-source/one-note fixture and
reported zero real compactions. Both baseline versions stopped with
`context_budget` and no publication. Candidate v1 published and ran 10 generation
plus 10 answer requests; its middle-route answer incorrectly said the published
memory did not establish the fact, although source-128 was retained in the
publication. Candidate v2 reached `model_call_budget` after 12 generation requests
and did not publish. The pilot ledger's settled conservative estimate was
**USD 0.12509175**, with no pending reservation at that point. This pilot is
historical context, not a substitute for the later standard/stress comparison.

### Run 003: preserved standard-baseline-v1 failure

The first slot of the frozen standard/stress batch dispatched eight generation
requests and seven tools completed, then stopped on `unknown_usage`. It did not
publish and did not start any answer session. Its slot time was 94.845 s total
(94.149 s generation); real compactions: 0. The settled conservative estimate
was USD 0.03061125. The unknown eighth request retained its **USD 0.04409125**
reservation. The failure was preserved; the saved `retry_wait` job state was not a
retry. The upstream cause is not established by the retained artifacts.

### Run 004: seven remaining slots

The authorized continuation attempted all seven previously unattempted slots
once. Three published; four did not. No new unknown usage occurred. The
standard-baseline-v1 failure above remained unchanged and is included in the
slot table for completeness, not counted as a new run-004 dispatch.

| Fixture | Producer/version | Publication / terminal result | Requests (generation + answers = total) | Generation tools requested / host-confirmed | Answer tools executed | Elapsed total / generation (s) | Real compactions | Settled conservative USD | Pending exposure USD |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|
| Standard | Baseline v1 (preserved run 003) | No; `unknown_usage` | 8 + 0 = 8 | 7 / 7 | 0 | 94.845 / 94.149 | 0 | 0.03061125 (already settled) | 0.04409125 (preserved) |
| Standard | Candidate v1 | Yes; succeeded | 9 + 10 = 19 | 15 / 15 | 6 | 201.306 / 169.321 | 0 | 0.05593075 | 0 |
| Standard | Baseline v2 | No; `context_budget` | 8 + 0 = 8 | 8 / unavailable | 0 | 39.379 / 38.745 | 0 | 0.02223275 | 0 |
| Standard | Candidate v2 | Yes; succeeded | 10 + 9 = 19 | 9 / 9 | 5 | 121.038 / 72.643 | 0 | 0.03159200 | 0 |
| Stress | Baseline v1 | Yes; succeeded | 8 + 13 = 21 | 12 / unavailable | 9 | 216.098 / 140.822 | 0 | 0.04897500 | 0 |
| Stress | Candidate v1 | No; `model_call_budget` | 12 + 0 = 12 | 15 / 15 | 0 | 239.353 / 238.895 | 0 | 0.06719575 | 0 |
| Stress | Baseline v2 | No; `model_call_budget` | 12 + 0 = 12 | 12 / unavailable | 0 | 51.438 / 50.940 | 0 | 0.04439525 | 0 |
| Stress | Candidate v2 | No; `model_call_budget` | 12 + 0 = 12 | 14 / 14 | 0 | 72.169 / 71.734 | 0 | 0.03746550 | 0 |

Run 004's seven new slots totalled 103 provider requests (71 generation and 32
answer), with 85 generation tool calls requested and 20 answer memory tools
executed. Baseline host tool counts for the new run-004 slots were unavailable;
transcript-visible results are only lower bounds and are not presented as exact
execution counts. The preserved run-003 baseline-v1 trace confirms seven of seven
generation tools completed. In the stress-baseline-v1 answer session, a requested
final read was not executed because the answer-request ceiling had been reached.
Each of the four newly attempted nonpublished slots has four `no-answer` records;
the preserved run-003 failure also has four blocked `no-answer` records. Those
are unavailable outputs, not successful semantic abstentions.

### Run 005: corrected answer-tool validation

A separately authorized standard-fixture repetition used runner
`f78dd7e13ad8419327da218fe568dd534844f149`, including the SDK argument-validation
fix at `9948a2d`. It kept the original fixture, producer commits, model, questions
and limits. It did not overwrite earlier failures or introduce controlled history.
The candidate was evaluated in a separate detached checkout at `f087c670`;
documentation commits on the integration branch were not substituted for the
frozen producer.

| Producer/version | Publication | Writer + answer requests | Elapsed writer / total (s) | Semantic limitation | Real compactions |
|---|---|---:|---:|---|---:|
| Baseline v1 | No; `context_budget` | 4 + 0 | 26.863 / 30.354 | No answers available | 0 |
| Candidate v1 | Yes | 11 + 12 | 68.646 / 105.086 | Source-128 answer reached its four-request limit without final text | 0 |
| Baseline v2 | Yes | 12 + 12 | 41.212 / 75.952 | Exact project path omitted from scope answer | 0 |
| Candidate v2 | Yes | 11 + 12 | 37.880 / 75.057 | Exact project path omitted from scope answer | 0 |

All four assigned attempts finished once: 74 provider requests, no new unknown
usage, and no infrastructure or identity fault. Candidate v1 delivered the other
three required answers, but searched the handbook then listed two directory pages
before requesting another list on its fourth answer turn. It did not deliver the
middle-route fact. Both v2 producers delivered the route/conflict facts and
approval/date abstention, but omitted the required exact project path even after
reading it. SDK error handling is corrected; model delivery is still incomplete.

This repetition added USD 0.15246450 to the settled conservative estimate. Global
accounting at its end was **USD 0.61595450 settled + USD 0.04409125 preserved
unknown reservation = USD 0.66004575 accounted**. These remain estimates, not an
invoice. No new reservation remained unresolved. Full private review:
`semantic-run-005/result-review.md`.

A subsequent bounded reader-guidance follow-up is separate from the Phase 2
writer implementation. Offline guidance tests cannot convert these recorded
failures into semantic passes or establish real compaction.

### Run 006: new publications with paired old/new reader guidance

Runner `40e73978d41e10256bc23c47b61204597e99321f` executed one new
standard-fixture experiment. Both real writers and the new readers used
`38ce511b003e96566d71eaa7817c2159ffee2f9e`; the old reader used `f087c670`.
Extraction/consolidation policies, fixture, questions, model and limits were
unchanged. Reader guidance was an explicitly separate foreground follow-up,
not a claimed Phase 2 evidence-loss fix.

An offline attempt to relocate run-005 publications failed the production
`artifact_integrity` check: publication directories are bound to their canonical
root. No identity was rewritten or validation bypassed. Instead, run 006 made
new genuine publications and restored each snapshot to its **same canonical
root** before the paired reader arms. All 1,220 run-005 files remained unchanged.

| Slot | Publication / result | Provider requests | Executed tools | Elapsed (s) | Real compactions |
|---|---|---:|---:|---:|---:|
| Writer v1 | No; `model_call_budget` | 12 | 15 | 51.535 generation | 0 |
| Writer v2 | Yes | 11 | 10 | 25.457 generation | 0 |
| Old/new v1 readers | Unavailable; no publication | 0 | 0 | Not run | Not applicable |
| Old v2 reader | Complete; exact scope path omitted | 10 | 6 | 26.941 wall | No writer executed |
| New v2 reader | All four original fact criteria pass | 13 | 9 | 28.056 wall | No writer executed |

The v2 readers used the same generation and manifest, configuration, questions,
constant answer instructions and tool schemas. Only reader guidance differed.
The new reader delivered both routes and conflict rules, the exact workspace
path with no unsupported cross-project reuse, and deployment approver/date
abstention. All four responses were final answers within the original four-call
limit. The old reader still omitted the exact workspace path after reading it.
Supersession was supported by the combined pinned writer summary and rollout;
the cited rollout alone does not name the superseded route. The new abstention
session used two distinct searches despite the single-query fallback guidance;
factual success does not establish complete guidance compliance.

This is one legacy `renderSection` consumer comparison, not a native foreground
carrier-admission or full-host equivalence proof, nor evidence of general reader
superiority. Both v1 reader arms have unavailable outputs, not abstentions.
**Writer-and-answer acceptance remains unresolved:** both versions must publish
and deliver the required facts. Both writer observations and all actual writer
transcripts show zero compactions; compaction acceptance is still pending.

The 46 provider requests settled with no new unknown usage or infrastructure
fault. Run 006 added USD 0.10679425 to the estimate. Global accounting is now
**USD 0.72274875 settled + USD 0.04409125 preserved unknown reservation =
USD 0.76684000 accounted** against the USD 20 estimated cap. These are not
invoices; the historical unknown actual charge remains unresolved. Paid calls
stopped after the assigned attempts, with no retries. The full private review is
`semantic-run-006/result-review.md`.

Offline comparison with run-005 candidate v1 explains the completion boundary:
run 006 used ten reading/navigation requests, then requested the required writes
at requests 11 and 12. Its last response was still `toolUse`; request 13 was
correctly rejected before genuine final confirmation, output validation or
publication. Run 005 used eight reading/navigation requests, wrote at 9 and 10,
and finished with a genuine stop at 11. Both used 15 tools and identical writer
system/task/tool declarations. This was not context overflow. The final run-006
write acknowledgement was not archived, so its successful completion cannot be
asserted from retained artifacts.

Neither trajectory disclosed the actual request cap or remaining host counters
to the writer, despite requiring final confirmation. That visibility gap is a
credible contributor, not proof that guidance guarantees completion. A generic
host-budget-framing follow-up must preserve the limits, genuine stop and
validation/publication gates, and needs separate real-model verification. It
must not salvage the failed run or replace its evidence. Private diagnosis:
`semantic-run-006/v1-completion-diagnosis.md`.

### Run 007: genuine confirmation with live writer-budget framing

Runner `ed8af45000b4bae9a89f2b3439523b33bac115f7` executed one new
candidate-only confirmation at `32ed334557acd703d09f27bc419e65c79481b57d`.
This candidate adds host-owned per-request budget framing and a new writer policy
identity. It preserves the actual Agent/tool history, source set, questions,
model, limits, genuine completion and validation/publication requirements.
The framing is counted and sent as the same normalized request object; it is not
controlled writer history or a replacement for the failed prior attempts.

| Version | Real writer | Final answers | Real compactions |
|---|---|---|---:|
| v1 | No publication; `model_call_budget`, 12 requests, 15 tool starts | All four unavailable | 0 |
| v2 | Published; 8 requests, 9 tool starts | All four original fact criteria pass; 13 answer requests | 0 |

The v1 writer used every response for tools and requested no writes. The
normalized request traces contain one fresh budget frame per request, including
request 12 with zero future slots. This proves framing observability at the
owning port, not guaranteed model compliance. The v2 writer wrote the summary at
request 7, received its acknowledgement, and returned a genuine tool-free stop
at request 8 before production validation and publication. Its reader delivered
both routes/conflicts, exact backed workspace scope and approver/date abstention.
The superseded route spelling again has combined pinned-summary and rollout
support, rather than support from the cited rollout alone.

There were 33 provider requests, all newly settled, with no new infrastructure,
identity or unknown-usage fault. All 1,414 prior run-006 files remained unchanged.
New settled estimate: USD 0.09246200. Global accounting is **USD 0.81521075
settled + USD 0.04409125 preserved unknown reservation = USD 0.85930200
accounted** against the USD 20 estimated cap, not an invoice guarantee.

**Writer-and-answer acceptance remains unresolved.** v2 does not substitute for
v1. Paid calls stopped after the assigned slots; no automatic retry followed.
All actual writer requests retain workspace tool declarations in their native
system frame: the new first budget frame's lack of tools does not identify a
compactor. Both native observations and inspection across all system frames
confirm zero actual compactions. Compaction acceptance remains pending, and no
controlled-history permission is implied. Private review:
`semantic-run-007/result-review.md`.

### Run 008: explicitly authorized unchanged v1-only reproduction

The user authorized one fresh v1-only trial, not a new fix or automatic retry.
Runner `55b9a19a130cba0b1cbba2a36502f8f4f9414d2a` used detached candidate
`32ed334557acd703d09f27bc419e65c79481b57d`, with the same policy, reader guidance,
model, 256-source/one-note fixture, questions and limits as run 007. The new
canonical root changed run-owned path provenance, not evidence bytes. All 602
prior run-007 files remained unchanged; older frozen run-005/006 hashes also
matched.

This v1 writer genuinely published: 11 requests, 16 tool starts, 55.709 seconds,
two successful required writes and a tool-free final stop through production
validation/publication. Two recoverable missing-file reads remain in its history.
This demonstrates one bounded completion, not a causal improvement or general
reliability guarantee.

| Answer | Result | Provider requests | Executed memory tools |
|---|---|---:|---:|
| Source-255 correction | Complete and supported | 2 | 1 |
| Source-128 conflict | Complete and supported | 3 | 2 |
| Exact scope | Four-call limit; no final text | 4 | 3 |
| Deployment approver/date | Four-call limit; no final text | 4 | 3 |

Both failed answer sessions requested a search on their fourth response; those
searches were not executed and no fifth request was sent. Neither is a successful
abstention. **Writer-and-answer acceptance remains unresolved.** Run 007's v2
pass remains separate, and its v1 failure is not replaced. No actual compaction
occurred.

The 24 provider requests newly settled USD 0.07984875 in conservative estimates.
Global accounting is **USD 0.89505950 settled + USD 0.04409125 preserved unknown
reservation = USD 0.93915075 accounted** against the USD 20 estimated cap,
not an invoice guarantee. Paid calls stopped after the single assigned trial;
no additional experiment followed. Private review:
`semantic-run-008/result-review.md`.

## Semantic findings and compaction (runs 003/004)

The frozen questions required `/api/source-255` to supersede `/api/old` for
that endpoint only; `/api/source-128` with the old route applicable only before
correction; exact applicability to `/synthetic/context-fixture` without
unsupported cross-project use; and abstention where deployment approver/date
evidence was absent. No generated answer bodies are reproduced here.

- **Standard candidate v1:** the publication retained the source-128 rollout,
  but the answer searched only the handbook (`MEMORY.md`); its empty-path list
  attempt was invalid and errored. It neither searched the rollout directory nor
  read source-128. It passed the other three question requirements; its middle
  route abstention is a retrieval/coverage failure, not proof that the source was
  absent or that the requested fact was correctly answered.
- **Standard candidate v2:** it correctly gave `/api/source-128` and the
  old-route-only-before-correction conflict. Its scope answer rejected
  unrelated-project reuse but omitted the exact fixture path and
  said the project name was not established. The complete low-ranked answer was
  supported by the available context, but its rollout citation alone did not
  support the old-route supersession clause; that qualification came from the
  pinned correction note. It also abstained correctly on the unsupported
  deployment approver/date.
- **Stress candidate v1 and v2:** both exhausted the 12-generation-request limit
  before publication; neither produced semantic answers. Stress baseline v2 also
  exhausted that limit. These failures do not establish semantic passes or
  failures for unanswered questions.
- **Stress baseline v1:** it correctly answered the low-ranked route, scope and
  abstention questions. Its middle-route session retrieved supporting evidence but reached
  its answer-call limit without a final answer. Retrieval is not answer coverage.

There were **zero real successful compactions in all eight slots**. The candidate
soft threshold was 186,883 estimated token units. Candidate end observations were
32,649 (standard v1), 11,834 (standard v2), 30,682 (stress v1), and 15,637
(stress v2). Traces contain no tool-free compactor request, installed derived
working-context summary, generation prompt change, or history shrink. The 256-source
fixture size did not make the live working inputs reach the threshold. There is
no real post-compaction semantic-retention evidence.

## Spend and interpretation

The run-004 final ledger reports **USD 0.46349000 settled conservative estimate** plus
**USD 0.04409125 pending unknown exposure**, or **USD 0.50758125 accounted**.
The pending amount is the original run-003 unknown request; run 004 added no
unknown reservation. These guard estimates are not an invoice, do not resolve the
unknown actual charge, and do not authorize further spending.

The implementation record reports 624/624 mock/repository tests and 60/60
labeled behavioral-matrix rows passing. Those establish tested mechanisms and
regression behavior only. Real-model acceptance remains **not met**: publication
and manifest coverage are not semantic coverage, four slots lacked publication,
answer coverage is incomplete, and the comparison produced no real compaction.
No retries, fixture substitutions, limit relaxations, issue closures, or
PR-ready declaration follow from this result.

## Evidence provenance

Private evidence is retained outside this repository under
`/home/ubuntu/dev/spec-notes/consolidation-context-v0.2.0/`, including the
run-002 through run-008 plans, ledgers, slot results and traces. The
run-004 factual review is `semantic-run-004/result-review.md` and the run-005
review is `semantic-run-005/result-review.md`. Run 006 is reviewed in
`semantic-run-006/result-review.md` and run 007 in
`semantic-run-007/result-review.md`; run 008 is reviewed in
`semantic-run-008/result-review.md`. Private synthetic
source and generated bodies are not reproduced in this public report.

The run-004 continuation used the isolated support checkout
`test/context-semantic-runner` at `787107f9641ab4ab7b84a65d79c8f4d077313774`;
run 003 used runner `37d57b7c7b8e03b9d5ba58d3e5c55b6be19149cb`. These runner
commits preserve guarded plans/traces, are not product candidates, and their
scripts reference local frozen checkout paths. The original comparison evaluated
`f087c670df4c609439de627990661d30792d28c1`. The separately identified run-006
follow-up evaluated `38ce511b003e96566d71eaa7817c2159ffee2f9e` with new reader
guidance. Run 007 evaluated `32ed334557acd703d09f27bc419e65c79481b57d` with live
writer-budget framing. The explicitly authorized run-008 v1 reproduction used
that same detached candidate and policy. These follow-ups do not replace the
original comparison or its failed slots.
