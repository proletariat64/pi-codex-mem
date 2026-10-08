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

## Semantic findings and compaction

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

The final ledger reports **USD 0.46349000 settled conservative estimate** plus
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
run-002, run-003, and run-004 plans, ledgers, slot results and traces. The
run-004 factual review is `semantic-run-004/result-review.md`; private synthetic
source and generated bodies are not reproduced in this public report.

The run-004 continuation used the isolated support checkout
`test/context-semantic-runner` at `787107f9641ab4ab7b84a65d79c8f4d077313774`;
run 003 used runner `37d57b7c7b8e03b9d5ba58d3e5c55b6be19149cb`. These runner
commits preserve guarded plans/traces, are not product candidates, and their
scripts reference local frozen checkout paths. The evaluated product candidate
remains `f087c670df4c609439de627990661d30792d28c1`.
