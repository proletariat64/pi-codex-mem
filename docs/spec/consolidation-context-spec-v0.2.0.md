# Pi Memory — Consolidation Context Management

**Version:** 0.2.0 proposal  
**Status:** Draft design; documentation only. Implementation and release approval remain separate.  
**Scope:** Phase 2, both v1 and v2; no foreground-reader or Phase 1 behavior change.

## 1. Purpose and authority

Keep `schedule.maxConsolidationSources = 256` as a source-selection ceiling without requiring all selected evidence to remain in one model request. Improve request measurement, cumulative-context handling and incremental diffs. A temporary user setting of 8 is a coverage-reducing workaround, not the product default or an automatic batching strategy.

This proposal extends [the existing implementation contract](pi-memory-spec-v0.1.0.md), chiefly §§9.2–9.3, 11.3 and 18–19. Once approved, its Phase 2 counting/compaction/diff rules supersede conflicting rules there. Until then, the approved baseline remains authoritative. Existing artifact checks (§§9.4–9.6), privacy, selection, leases, publication CAS, foreground fencing and shared daily limits remain unchanged except where explicitly identified below.

Source evidence: [Codex consolidation context research](../research/codex-consolidation-context.md), fixed to `openai/codex@1cc7e2361237ce7244430ee1d581c77f95c57ac8`. Native Codex uses ordinary agent context management, provider usage and approximate text counts, tool-output truncation and automatic compaction. It does not guarantee that arbitrary 256 sources fit one window, nor does it always use an exact tokenizer.

### 1.1 Observed failure

The current writer compares `Buffer.byteLength(JSON.stringify(context))` directly against a token-valued expression. For a 272,000-token model, 4,000 output tokens and 1,024 overhead units, it rejects at 186,883 **bytes**. An English-heavy 404 KB diff is approximately 101k tokens under Codex's bytes/4 heuristic, not 404k tokens. This is illustrative, not an exact count or capacity guarantee.

The writer already pages workspace reads. Its missing capability is management of their **accumulated** history. Full-file deletion/addition hunks also amplify incremental changes. No published baseline in the observed failure means the initial diff contains newly added evidence; incremental hunk improvements alone cannot solve that case.

### 1.2 Non-goals

- No source-count auto-reduction, semantic source reranker, map/reduce consolidation or new daemon.
- No `createAgentSession()`, Pi-core patch, project resource discovery, extensions, shell or recursive agent delegation inside the writer.
- No foreground token-budget changes, extraction-policy migration, exact Codex runtime parity or unconditional 256-source success promise.
- No new generated-prose citation, source-coverage or content-quality publication gate.
- No durable storage of writer transcripts or compaction summaries; a restart still rebuilds under a fresh valid lease.

## 2. Invariants

1. **Selection is independent of request capacity.** Rank and select sources under the existing policy; retain the complete selected manifest and all active notes. A context event never changes the selected set or marks sources omitted as processed.
2. **Context is a working representation, not evidence.** A compaction summary is derived assistant state. Immutable extraction outputs and user notes remain the sources of truth; a summary creates no new source, note, usage credit or publication eligibility.
3. **One ownership chain.** Writer, compactor, tools, budgets and staged outputs share the same version, selection, control epoch, lease owner/fence, cancellation and total-run counters.
4. **Privacy invalidation wins.** Changed support, epoch, selection, model/config eligibility or lost ownership stops stale work. A new window cannot revive invalid evidence.
5. **Publication stays atomic.** Only final validated artifacts passing the existing CAS become readable. A checkpoint, compaction or partial write is never a publication.
6. **Bounded progress.** Paging and compaction cannot reset call/tool/time/daily limits. Lack of progress ends with a diagnostic, not a retry loop.

## 3. Request measurement

Implement one Phase 2 context controller used by both writer admission and compaction admission. Keep representation/counting details behind this module rather than reproducing arithmetic in scheduler, writer and diagnostics.

### 3.1 Count what the provider sees

Count the normalized, model-visible request: system instructions, host task framing, tool names/descriptions/JSON schemas, messages, tool-call names/arguments and tool-result text. Count each effective declaration exactly once. Assistant reasoning that the transport does not replay, host-only metadata, IDs and JSON escaping from an unrelated serialization are not text-token input.

If transport semantics do replay additional content, the provider adapter must account for it. Do not infer that an item is free because it is an assistant message, a cache hit or a tool result. Unsupported binary/image content is rejected in this text-only writer rather than assigned zero tokens.

A matching tokenizer, when available, takes priority. Tokenizer identity and framing policy must match the resolved model/transport; a tokenizer for a vaguely related model is an estimate, not exact. The implementation need not require new Pi APIs: an optional matching counter may be adapted behind the existing model-port seam.

### 3.2 Fallback estimate and provider calibration

When no matching counter is available:

- Estimate text as `ceil(utf8Bytes / 4)` and add explicit message/tool/protocol framing estimates.
- Label the result `utf8_div4_estimate`; it is a heuristic, **not a conservative upper bound**, including for Chinese, emoji, code and JSON.
- Start with a safety multiplier of `1.25`. `baseEstimate` includes all model-visible text, tools and estimated framing exactly once. Admission uses `ceil(baseEstimate * multiplier)`; §3.3's `H` is the separate unknown-framing reserve, not another counted copy of those items.
- After a completed request with trustworthy usage, normalize input as uncached input + cache-read input + cache-write input, using the existing disjoint-count contract. Output is not request-input usage. Billable cost and cached input are not interchangeable with active context.
- Raise the multiplier to at least `observedInput / requestBaseEstimate` when observations exceed the current estimate; never lower it within a lease. Associate the observation with the exact sent request, model and transport. Do not reuse old-window usage after compaction or sum historical inputs to obtain current context occupancy.
- A process-local calibration may be reused only for the same model/transport/counting-policy identity. Missing, zero or invalid usage leaves the estimate and its safety-adjusted reservation intact; the reservation is not a guaranteed upper bound.

Full fresh-request counting remains the fallback for every admission. Provider usage calibrates it; it does not authorize subtracting arbitrary removed history or claiming exact token occupancy. Required tests cover cache accounting, Unicode, JSON schemas and model changes.

### 3.3 Capacity and thresholds

Let:

```text
W = resolved model input-plus-output context window
O = min(4000, model.maxTokens) for an ordinary writer request
H = 1024 tokens of additional transport/unknown framing headroom
I = W - O - H
softLimit = floor(I * 0.70)
hardLimit = floor(I * 0.90)
compactTarget = floor(I * 0.50)
```

`H` is reserved headroom, not a second copy of counted instructions/tools. All quantities above are **tokens or explicitly labeled estimated token units**, never bytes. Reject missing, non-finite, non-integral or non-positive capacity; small contexts must still fit irreducible instructions/tools and a valid continuation.

For compaction requests, compute their own `O`, framing and capacity from the actual tool-free compaction request. Default output cap is also 4,000 tokens. The 16 KiB summary representation limit in §5 is a separate byte limit.

Admission checks the complete request **after** newly added task framing, tool results, repair diagnostics or compaction output, and immediately before transport. A previous successful request does not prove the next one fits.

- At or below `softLimit`: admit ordinary writer work after existing readiness, lease and budget gates.
- Above `softLimit`: compact at the next safe seam before further ordinary transport.
- Above `hardLimit`: no ordinary request is sent. A compaction request is permitted only if its own complete input fits its hard limit; otherwise use the bounded segment strategy in §5.2.
- After compaction: rebuild and recount; the new writer request must be at or below `compactTarget`.

Matching tokenization still requires protocol headroom. Estimated admission is best-effort, not a proof that the provider will accept the request. Provider context-overflow recovery is separately bounded in §7.

## 4. Paging and context lifecycle

The initial request contains instructions, tools, task identity and staged paths, not all evidence bodies. Keep workspace read/search/list paging and the existing per-response 16 KiB ceiling. Each response must expose continuation/omission information and preserve UTF-8 and complete references. Do not truncate a result silently or erase staged originals.

Compaction runs only after an assistant/tool-call batch has completely settled, with no unresolved tool call, active file write or in-flight provider request. It may also run before the first request if the irreducible host framing permits it. Replacing history must retain valid protocol ordering; call/result pairs cannot be split.

State transitions:

```text
prepare → count → admit writer → settle model/tools → count
                    ↑                            │
                    └── replace working history ← compact
                               │
                       validate final outputs → publication CAS
```

Before each writer/compactor request and each tool execution, repeat the existing configuration, foreground-idle and ownership checks. If foreground work begins, pause new requests under the existing scheduler policy; do not compact opportunistically in the foreground.

## 5. Compaction contract

Use a tool-free request through the same captured Pi model port and configured consolidation model. Do not rely on a provider-specific compact endpoint in this revision. This is one shared writer runtime with an internal summarization operation, not a new recursive agent or persisted Pi session.

### 5.1 Host state versus derived summary

The host retains unchanged:

- Original pinned writer instructions, version-specific tool declarations and task framing.
- Selection/control/model/config/lease identity and manifest location.
- Call/tool/time counters, reservations, compaction count and the single artifact-repair allowance.
- Existing pending repair diagnostic, when present, plus the original output-validation contract.
- Successful read ranges, completed workspace writes/deletes and their resulting hashes, where tracked. This ledger describes operations; it does not certify semantic source coverage.

The compactor summarizes only settled working history. Its prompt asks it to preserve decisions and scope, exact safe source/note/file references, corrections and conflicts, work already written, unresolved questions and next reads. Evidence remains untrusted data. No summary text becomes system instructions, tool declarations, host decisions, permissions, or authoritative user statements.

Accept only a completed, non-empty text result within the 4,000-token output cap and 16 KiB UTF-8 representation limit. Redact sensitive values as for writer output. Length/error/aborted/malformed results do not replace the last valid working history; compaction has no separate model-output repair loop.

Replacement history contains the original trusted framing, the labeled derived summary as ordinary assistant context, and a host continuation instruction pointing back to the immutable staged inputs and current output files. It excludes superseded tool payloads. Active notes and corrections remain staged and available for rereading; the summary cannot substitute for their backing evidence or confer publication provenance.

Construct and validate the replacement off to the side, recount it, then swap atomically. If it exceeds `compactTarget`, fail the compaction without installing a partial or silently cut summary. Check selection/epoch/lease/config again before installing or continuing.

### 5.2 Oversized compaction input

If the full settled history does not fit the compactor's hard limit, construct one compound off-to-the-side candidate transformation. Reduce its input without asking an already-overflowing request to summarize itself:

1. Keep original host framing and any last accepted derived summary; select an oldest contiguous range of complete settled conversational units that fits the compactor's request budget.
2. Summarize that range, then replace only that range with the labeled result, retaining the untouched newer units.
3. Recount and repeat only within the remaining compaction/call/time budgets. Each successful segment call consumes one compaction slot. Intermediate replacements remain private candidate history; install only the final candidate when the complete writer request meets `compactTarget`. Failure leaves the previous live history unchanged and ends the attempt rather than dispatching the intermediate candidate.

A conversational unit includes an assistant's complete tool-call batch and all matching results. No source body is deleted from staging. If even one unit cannot fit, or no eligible range can reduce working history sufficiently, stop with a context-specific diagnostic. Do not silently drop oldest evidence or install a summary claiming coverage of excluded units.

Each successful segment must strictly reduce the candidate's measured input; a completed compound transformation must reduce the live working input and reach `compactTarget`. Same-state repetition, no measurable reduction, exhausted slots or an oversized irreducible core discards the entire candidate and ends the job; it does not recursively compact its own instructions.

### 5.3 Privacy and storage

Compaction does not relax ordinary source-eligibility or epoch validation. Revocation during summarization discards its result and cancels or supersedes the candidate according to existing fencing semantics. Replacement summaries and staged derived outputs cannot cross into a new selection/epoch/version job.

Keep summaries/transcripts only in run-owned memory. Do not add them to notes, extractions, generated manifest evidence, normal Pi sessions or routine logs. A crash/reload drops them. Previously admitted network bytes cannot be recalled; preserve the existing cancellation/send-race limitation.

## 6. Deterministic incremental diffs

Replace whole-file delete/add hunks for modified files with deterministic line-level unified hunks against the last eligible same-version published baseline. Keep path ordering stable, three context lines, explicit addition/deletion status and correct no-final-newline markers. Use a bounded deterministic diff algorithm or narrowly scoped library; a Git repository or shell is not required.

The complete changed-path index is always present and authoritative. The plaintext diff is optional detail:

- Preserve the existing 4 MiB output ceiling. If the full diff or algorithm work budget exceeds its bound, use the complete changed-path index, recording `size` or `computation_limit`; require per-file/range reads rather than emitting a misleading partial diff.
- If prior support, notes, control epoch, retention or integrity is invalid, preserve the existing path-only fallback. No revoked/deleted prior plaintext may enter a diff or compaction request, even if doing so would improve deletion processing.
- Added files may contain their full text in the diff. At first initialization, paging and context management—not incremental-diff shrinkage—handle large evidence.
- The manifest records diff policy version/fallback reason. A fallback does not remove a source, turn a deletion into a modification, or grant missing prior content access.

Empty content, CRLF/LF, Unicode, repeated lines and absent final newline must be deterministic across runs. No-op content must continue to skip the writer under existing dirty checks.

## 7. Usage, bounds and recovery

### 7.1 Resource limits

Preserve the existing defaults: 12 total model requests, 40 total workspace-tool calls and a 300-second total writer timeout. Add a ceiling of **2 successful compaction operations per lease**; attempted compactor transport calls still consume ordinary request/timeout/daily limits. Segmented compaction uses the same ceiling, not two additional calls per segment. Compaction does not reset the single artifact-repair allowance.

These defaults deliberately do not promise full processing of every arbitrary 256-source workload. Release fixtures must exercise 256 selected sources within adequate shared budgets; report whichever real limit is reached. Increasing total cost/time limits is a separate measured tuning decision, not an implicit consequence of fixing token units.

Reserve each request's input/output/request capacity transactionally before dispatch, including compaction and repeated context. In estimated mode, use the calibrated safety-adjusted estimate for reservation. Missing usage retains that charge, labeled estimated rather than a guaranteed upper bound. Reconcile trustworthy usage; an underestimate must be charged honestly and cannot grant further requests beyond the remaining daily allowance. Already spent usage is never refunded because compaction later removes context.

`--now` continues to skip idle waiting only. It never bypasses context admission, daily admission or fencing. Daily denial follows existing next-day scheduling and staging cleanup; this proposal adds no durable partial-work checkpoint.

### 7.2 Provider context overflow

Recognize provider context overflow separately from authentication, daily quota, ordinary transient errors and output-length exhaustion. After an estimated request is rejected for context overflow, allow at most one in-lease recovery:

- Account for the failed transport under existing usage rules.
- Increase fallback safety multiplier to at least twice its previous value; exact-count mode instead reports a transport/counting mismatch and keeps normal protocol reserves.
- Compact/recount through the same gates before any writer resend. If the replacement cannot be admitted, stop without resending.
- A second overflow ends with `provider_context_overflow`, with no hidden generic three-attempt loop on the unchanged payload. Network outages remain governed by existing retry policy.

Do not infer a recoverable context overflow merely from a generic `400`, timeout or malformed response. Unknown failures keep their existing classification.

### 7.3 Diagnostic outcomes

Use distinct reason codes (status follows existing blocked/retry/cancel/deferred semantics):

| Reason | Meaning |
|---|---|
| `context_capacity_unavailable` | Model capacity/counting capability is unusable |
| `context_irreducible` | Mandatory framing or one complete unit cannot fit |
| `compaction_limit` | Compaction allowance exhausted before a safe writer request |
| `compaction_no_progress` | Replacement did not reduce context |
| `compaction_output_invalid` | Empty/oversized/length-limited or invalid compaction result |
| `provider_context_overflow` | Explicit provider overflow exhausted bounded recovery |
| `model_call_budget`, `tool_budget`, `total_timeout` | Existing total resource gates |
| `input_budget`, `output_budget`, `request_budget` | Existing shared daily admission gates |

Provider errors/cancellation during compaction preserve existing transient/auth/cancel distinctions. No code above changes privacy invalidation or publication failure into a compaction-repair opportunity. A recoverable threshold crossing is progress, not terminal `context_budget`.

## 8. Diagnostics and observability

Record and show, without model/source/summary bodies:

- Counting method/policy version, safety multiplier and latest calibrated observation.
- Resolved window, output reserve, overhead reserve, current input count, soft/hard/target limits; explicit `tokens` versus `estimated_tokens` units.
- Selected source/note counts, request count, tool count, compaction count; no claim that selection proves complete reading or semantic coverage.
- Last compaction before/after counts and result, diff mode/fallback, budget denial and next retry reason.

`/memory doctor` remains read-only. Distinguish persistent memory availability from writer progress and host-event health. A healthy environment, successful compaction or saved notes alone does not imply a readable publication.

Request/diff/compaction policy identities participate in the consolidation dirty check, configuration epoch and diagnostics. Bodies and sensitive filesystem/user evidence stay out of ordinary logs.

## 9. Compatibility and rollout

- Keep the current config schema and `maxConsolidationSources` semantics/default. This revision adds no required user budget field. Existing explicit settings such as 8 remain 8; never silently reset them to 256.
- Scope the changed estimator to Phase 2. Keep Phase 1 and foreground accounting unchanged; a later shared estimator requires a separate specification.
- Bump the consolidation policy/prompt hash for counting, compaction framing and diff behavior. Old blocked `context_budget` work becomes new eligible policy work through existing claim/supersession semantics. Do not clear unrelated auth gates, privacy state or budgets.
- Never resume an in-flight old-policy writer using new-policy context state. Let old work settle/cancel under its existing fence; publication eligibility must reject mixed-policy work. Follow normal reload/update lifecycle, not live mutation of an Agent.
- Reuse existing SQLite schemas where possible. Run-only compaction state needs no durable table. Any necessary generation-manifest extension must be explicitly versioned, read-compatible and tested; keep published baseline manifests readable, with new diagnostic fields optional for old generations.
- Rollback selects the prior writer policy with its own hash and unchanged storage/privacy contracts. It does not recreate forgotten content or erase charged usage. Old readers may ignore added diagnostic fields but must still verify the actual stored manifest hash.

## 10. Acceptance

Use synthetic fixtures, not production user content. Mock deterministic transport for protocol and failure tests; use explicitly authorized real-model runs only for semantic gates. Configure sufficient daily budgets for successful context tests and record them separately from shipped defaults.

| ID | Required proof |
|---|---|
| CT01 | A 272k model accepts a fitting English-heavy ~404 KB input under estimated token admission, with complete framing/reserves; the 186,883-byte regression no longer blocks it merely by bytes. Also verify exact-count mode. |
| CT02 | Token counts include tools, calls/arguments, results, instructions and pending additions once; host metadata/serialization escaping does not inflate text counts. |
| CT03 | English, Chinese, emoji and code/JSON exercise fallback labels, multiplier increases and a bounded provider-overflow recovery. Wrong tokenizer/model identity is not labeled exact. |
| CT04 | Cache read/write normalization, missing/invalid usage, underestimation and model-policy replacement preserve honest daily charges and prevent further overspend admission. |
| CT05 | Accumulated pages cross the soft limit; compaction settles at a safe tool seam, fits its own request and produces a recounted replacement at/below target. Calls/tools retain valid ordering. |
| CT06 | Segmented compaction, one oversized unit, unchanged-size summaries, invalid summary output, max slots, timeout and call exhaustion terminate with distinct reasons; no counter reset or hot loop. A first segment above target and second below target produce exactly one atomic installation. Failure, budget denial or ownership loss on the second segment installs neither intermediate result. |
| CT07 | Foreground activation, privacy edit/forget, selection change, configuration change or lease loss during compaction admits no subsequent stale request/write/publication. Include late results and cancellation-ignoring transports. |
| CT08 | Compaction preserves host identity, original instructions/tools, outstanding repair state, existing staged output hashes and version isolation. Derived summaries grant no note/source/provenance rights. |
| CT09 | Successful fixtures with 256 selected sources across both versions retain all selected manifest evidence without auto-reducing the selection; useful low-ranked evidence, notes, exact routes, conflicts and corrections survive semantic evaluation. Selection/operation telemetry is not a semantic completeness certificate. |
| CT10 | One-line edits to large baseline files produce local hunks, not whole-file replacement. Added/deleted/empty/CRLF/Unicode/no-newline/repeated-line cases are deterministic. Huge/pathological diffs produce complete path-index fallback. |
| CT11 | Revoked baseline plaintext never enters a diff, compact request, working summary or published artifact; no first-build claim assumes an available valid incremental baseline. |
| CT12 | Existing artifact validation, one repair, publication CAS/crash tests, source/note integrity, dirty-check/no-op, dual-write fairness and shared quotas remain green. No new prose-reference gate. |
| CT13 | Upgrade/rollback preserve existing config values, v1/v2 read compatibility, saved notes, source enrollment, invalidation and charged usage. Old blocked context jobs retry only under a new valid policy identity or explicit authorized retry. |
| CT14 | A denied daily compactor budget or failed compaction keeps the prior eligible publication (if any), does not publish staging, and reports actual availability; no generated body appears in logs. |

For CT01, construct a settled tool transcript with the target byte size; admission is checked on the actual normalized request, not the size of a file the writer has not read. For CT09, use small source summaries and an initial bounded working history that requires compaction within the existing total call/tool/time ceilings. Larger stress cases must report resource limits honestly, not be sampled while reported as fully covered.

Completion requires implementation-level focused tests plus existing repository verification gates and a semantic comparison against the old writer using identical authorized fixtures/model/budgets. Record actual Pi/model versions, counting mode, selected counts, calls, compactions, elapsed time and final availability. Passing mocks does not establish language quality or exact provider-token accuracy.

## 11. Implementation work map (not authorization)

1. Add the shared Phase 2 counter/controller behind the model-port seam; distinguish input estimate, provider usage, output reserve and byte caps. Extend request diagnostics without changing foreground behavior.
2. Integrate admission and bounded compaction at settled writer seams; share run counters, readiness/lease fences and accounting with existing transport. Preserve the confined workspace tool surface.
3. Replace full-file modified hunks with bounded deterministic incremental hunks and preserve privacy/path-index fallbacks.
4. Reconcile policy hashes, dirty checks, diagnostics, docs and acceptance fixtures. Verify both versions and rollback compatibility before release.

Implementation should concentrate these changes in `src/pipeline/consolidate.ts`, a small Phase 2 context module, the existing model-port seam, `src/pipeline/staging.ts` and their focused tests. Reuse `normalizeModelUsage`, reservation/reconciliation and publication ownership rather than creating competing state machines. No product code is changed by this proposal.
