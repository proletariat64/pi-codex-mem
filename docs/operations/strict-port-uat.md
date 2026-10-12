# Strict-port UAT — 2026-10-12

This acceptance covers the implementation committed as
`27cb0f05d82532d5ef6e8e742c29c4f5c09c53a8` in PR #59, developed from Pi worktree
base `26a3dee624eb88ad03e97dbbfdb446d1fcaf564f`. The separate upstream memory-policy
baseline is `openai/codex@1cc7e2361237ce7244430ee1d581c77f95c57ac8`.
Automated tests from the implementation ledger are separate from this UAT.

## Current result — 2026-10-13

The read-path interface failure is fixed. Actual Pi CLI/TUI + real
`openai-codex/gpt-6-luna` reruns passed for v1 and v2, from captured conversation
through extraction, consolidation, publication, READABLE and detail retrieval.
The earlier failures below remain as historical evidence. See the final section
for the fix, request comparisons and acceptance limits.

## Primary acceptance gate — clarified by the operator

The primary gate is parity with the pinned Codex memory workflow: the same phase
order and the same upstream prompts. Recall accuracy is secondary and is not the
primary pass/fail gate for this integration. A broad four-mode, 360-answer quality
benchmark is outside the requested scope.

Check v1 and v2 through actual Pi CLI/TUI with the real `gpt-6-luna` model:
source capture → phase-one extraction → staged selected evidence → phase-two
consolidation via Pi AgentSession → artifact publication → READABLE → foreground
read guidance and memory tools. Preserve upstream templates without additional
memory policies or repair prompts. Compare rendered requests and stage evidence,
not just stored template hashes. Pi authentication, execution and compaction are
host adapters. Full source serialization, tool namespace and instruction-role
identity with Codex are not currently established; see the work ledger's explicit
host boundaries.

The earlier six CLI cases used a deterministic provider. The four real-model
pilot answers used SDK AgentSession, not the CLI/TUI. These are separate evidence
sets. The initial two actual CLI/TUI + real-model cases (v1/v2, one each)
reached READABLE but failed at the foreground read-tool path contract. The
post-fix v1/v2 reruns passed that contract, as recorded below. The v2 invented UUID remains a secondary quality
observation; it does not independently prove a workflow or prompt difference.

## Arranged scope

| Stage | Cases | Environment | State |
| --- | --- | --- | --- |
| Dataset preflight | 30 cases / 360 planned answer slots | Offline evaluator; zero model requests | PASS |
| Actual CLI workflow | v1/v2 × normal / forced system prompt / native Writer compaction = 6 | Pi 0.99.2 CLI under PTY, isolated stores and network namespace; deterministic provider | PASS: 6/6 |
| Real-model pilot | D01 × none / curated / v1 / v2 × 1 = 4 answers | Existing `openai-codex/gpt-6-luna` for extraction, consolidation and answering; isolated stores | Completed: 4/4 executions; semantic citation defect in v2 |
| Full semantic gate | 30 × 4 × 3 = 360 attempts | Real provider plus independent groundedness review | Cancelled by operator as excessive; 2/360 completed before interruption |

The CLI cases exercise real captured sessions, extraction, native background
`AgentSession`, confined tool writes, immutable publication, `/memory status`
READABLE, foreground injection and an actual `pi_memory_read` tool continuation.
The compaction cases intentionally report threshold-crossing fixture usage to
exercise Pi's installed native compaction lifecycle. They do not prove real-provider
token accuracy, overflow classification or memory quality. The override cases use
an ordinary extension returning a complete system prompt.

CLI harness and complete evidence are stored outside the repository in
`/tmp/pi-memory-uat-20261012/`: `offline-fixture.ts`, `seed.mjs`, `drive.py`, and
per-attempt `command.json`, `terminal.raw`, `terminal.txt`, `trace.jsonl` and
`result.json`. Failed setup attempts are retained and excluded from passed cases.
No live memory store or user settings are changed; no auth file is copied into a
test store. The first setup attempt used an unsupported `--no-mcp` option; it
exited before loading extensions and was corrected for the tested CLI version.

## Real-model pilot command

Executed after operator approval of a US$20 cumulative budget:

```sh
rtk proxy node eval/run.mjs --execute --case D01 --reps 1 \
  --out /tmp/pi-memory-real-uat-pilot-20261012 \
  --extract openai-codex/gpt-6-luna \
  --consolidate openai-codex/gpt-6-luna \
  --answer openai-codex/gpt-6-luna --approved-max-usd 20
```

The SDK needs its normal authentication-file read lock outside the workspace;
use the authorized host execution boundary without copying credentials. Local
readiness was confirmed through the SDK: the model exists and the provider has
configured OAuth. The pilot subsequently completed actual provider requests.

The pilot records actual extraction/writer transport traces, generation and
injection checks, answers, usage and estimated cost. Judge adopted decision and
rationale against D01's source messages; publication alone is not a semantic pass.
The full 360-attempt gate remains distinct from a successful four-answer pilot.

## Observed results and disposition

All six final CLI cases passed: normal, complete system-prompt override and native
Writer threshold compaction for both v1 and v2. Each published a generation,
showed READABLE in `/memory status`, injected memory and completed an actual
`pi_memory_read` continuation. The two compaction cases each recorded one native
compaction. `acceptance-summary.json` selects the final evidence directories and
records SHA-256 hashes of the harness; earlier setup/debug attempts are excluded.

D01 completed all four real-model modes. The no-memory baseline correctly refused
to invent an unavailable decision. Curated, v1 and v2 correctly recalled TypeScript
for the local CLI prototype because parser reuse mattered more than Rust speed;
none reversed the choice or claimed a repository-wide decision. Both generated
modes completed extraction, publication and injection. v1 used memory search;
v2 used search, list and detail read. This is an agent evidence review, not the
independent human review required by the full semantic gate.

The v2 answer cited rollout UUID `019c6e27-e55b-73d1-87d8-4e01f1f75043`,
which is absent from the selected source and generated evidence. The same literal
appears in the byte-identical upstream read-guidance example
(`prompts/upstream/v2/read_path_v2.md:32`). This supports a possible example-copying
explanation; one pilot does not prove its frequency or general cause. The cited
file and decision-bearing line exist, but the invented UUID is a provenance
defect. Decision/rationale recall passed this case; the complete pilot is **not a
semantic PASS**. No upstream prompt or product code was changed during this UAT.

Actual pilot evidence: `/tmp/pi-memory-real-uat-pilot-20261012/results.jsonl`,
`plan.json`, generated stores and provider traces. Estimated cumulative cost was
**US$0.018370625**, leaving **US$19.981629375** of the authorized total US$20.
These are catalog-based estimates, not provider billing. After a further instruction to continue, a full-run process was launched with a
US$19.981629375 ceiling. It exited after recording 2 additional baseline
answers; the operator then rejected the 360-attempt scope as excessive. Process
absence was confirmed and no resume was attempted. The full plan is cancelled.
Total recorded estimated spend is US$0.018432625; an interrupted request may
have unrecorded provider usage, so this is not an exact billing total.

The acceptance scope is the six CLI cases and four-mode D01 pilot already run.
The v2 citation defect remains open; broader human-reviewed semantic claims and
real-provider overflow/retry proof are not established. No production memory
store was modified. Launch/cancellation receipt:
`/tmp/pi-memory-real-uat-full-20261012-launch.json`.


## Historical failure: actual Pi CLI/TUI + real Luna 6

The two full-path cases used the real Pi 0.99.2 TUI and existing
`openai-codex/gpt-6-luna` authentication. Neither used the deterministic provider.
A transparent ModelRegistry observer captured background request context for v2;
it delegates to the original methods without replacing prompts or provider output.

| Case | Extraction | Consolidation/publication | READABLE | Foreground detail read |
| --- | --- | --- | --- | --- |
| v1 real Luna 6 | Completed | Completed | Yes | FAIL |
| v2 real Luna 6 | Completed | Completed | Yes | FAIL |

Both models first attempted `pi_memory_list` with an empty path, then with the
absolute generation workspace path supplied by read guidance. The latter returned
`path_not_available_for_version`. Neither completed `pi_memory_read`. This is a
primary workflow/tool-contract difference, independently of recall accuracy.
The model's attempted path and returned error are retained in the TUI trace.
No product fix or upstream prompt change has been applied during this validation.

For v2, captured phase-one system text matches the vendored upstream file exactly.
Every observed phase-two user prompt matches the original consolidation template
after only the four documented host substitutions. That is prompt evidence;
it does not make the failed reading workflow equivalent to Codex. v1 background
request text was not instrumented in its full-path run, so complete rendered-request
identity is not established there. The 9-file manifest and 11 static policy checks
were rerun and passed; they do not override this live failure.

Two earlier real CLI attempts used an insufficient shared output quota: phase-one
was deferred with `output_budget`, while a model-created manual note allowed
publication. Those attempts are excluded from full-path acceptance. The final
isolated tests used an ample output quota, require extraction completion, and
ask the initial agent to acknowledge without saving a note. The first v1 harness
also waited for a missing detail read until timeout; v2 reports its missing read
immediately after the completed answer. All attempts are retained.

Evidence: `/tmp/pi-memory-uat-20261012/real-cli-acceptance-summary.json` and
`real-cli-prompt-comparison.json`, plus the selected per-case trace, terminal,
configuration, session and database files. The primary parity gate remains FAIL.
The earlier secondary UUID-quality observation is not the reason for this gate.

Recorded combined cost estimate, including all four real CLI attempts and prior
pilot/cancelled-run records: US$0.043132. Provider billing is not exact.

## Read-path fix and real-agent rerun — 2026-10-13

The reader now maps absolute paths under the validated pinned generation to
relative paths before applying its existing version allowlist. Empty list/search
paths mean the pinned root. Results retain relative citation paths. Paths in other
generations or versions, private artifacts and traversal remain rejected; epoch
revocation, hash checks and symlink confinement still apply. No upstream memory
prompt was edited.

The pre-fix regression failed for both versions, reproducing the UAT path mismatch.
After the fix, retrieval/forgetting passed 27/27; explicit other-version rejection
was added and both regression cases passed again. Typecheck, 9 manifest hashes,
11 static policy checks and diff checks passed.

Both reruns used the actual Pi 0.99.2 CLI/TUI, real `gpt-6-luna`, isolated stores
and the same two-turn engineering-decision conversation. Neither used a fake
provider or manually saved note. Both completed phase-one extraction, phase-two
consolidation, publication, READABLE, foreground guidance injection,
`pi_memory_list` and `pi_memory_read`, then exited normally.

| Version | Extraction → consolidation → publication | READABLE | List + detail read | Actual request comparison |
| --- | --- | --- | --- | --- |
| v1 | PASS | PASS | PASS | PASS |
| v2 | PASS | PASS | PASS | PASS |

For both versions, the captured extraction system text is byte-identical to the
upstream system template; the input matches every literal part of the upstream
input template, with source placeholders substituted. Every observed writer user
prompt is byte-identical to the upstream consolidation template after its four
previously documented host substitutions. Provider/auth and tool implementations
remain Pi host adapters; this does not assert identical Codex runtime, source
serialization or developer-policy priority. No recall-accuracy benchmark was used
as a substitute for these checks.

One earlier post-fix one-turn sample produced native `no_output`; it is retained
and not used to claim successful detail-read UAT. The final fixture supplies
concrete parser reuse, language scope, error reporting and streaming constraints
for the native extractor to assess; it does not alter any memory prompt.

Selected evidence: `/tmp/pi-memory-uat-20261012/path-fix-acceptance-summary.json`,
per-case `prompt-comparison.json`, `trace.jsonl`, `terminal.txt`, `result.json`,
source sessions and state databases. This resolves the demonstrated technical
path-interface failure. The broad Codex host differences remain documented in
the work ledger; the earlier UUID quality observation is secondary and unchanged.
