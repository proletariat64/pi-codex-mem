# Pi Memory — Native Consolidation Session

**Version:** 0.2.0, revised 2026-10-12
**Status:** Current implementation contract; final integrated verification is reported separately. No production/TUI UAT or release approval is implied.
**Scope:** Background consolidation v1/v2 and its host context/accounting boundary.

## 1. Authority and corrected design

The memory-policy baseline is `openai/codex@1cc7e2361237ce7244430ee1d581c77f95c57ac8`, matching `UPSTREAM.md`. Pi provides the agent runtime. This revision supersedes the earlier proposal for a custom Phase 2 context controller, compactor, calibrated thresholds, segmented summarization, recovery counters and fixed writer caps. Those mechanisms are not the implemented contract.

Pi `AgentSession` already installs native compaction, overflow recovery and retry. Bare `new Agent()` does not install that lifecycle. Background consolidation therefore uses `createAgentSession()` rather than maintaining a second compactor. Pi core and permission extensions are not patched.

### 1.1 Historical regression

The old writer compared `Buffer.byteLength(JSON.stringify(context))` with a token-valued limit. For a 272k-token model, its 4000-output/1024-overhead/70% expression rejected at 186883 **bytes**. Approximately 404KB of English-heavy text is about 101k estimated tokens under UTF-8/4, so the comparison could falsely block fitting input. The old bare-agent writer also accumulated tool history without automatic session compaction.

`selected memory UNAVAILABLE` has additional causes: no publication, failed or pending writer, revoked/stale sources, incompatible host and missing model. Fixing context handling does not authorize treating every unavailable generation as readable.

## 2. Runtime and isolation

`src/pipeline/consolidate.ts::runConsolidation` creates:

- `SessionManager.inMemory(directory)` for ephemeral background history.
- `SettingsManager.inMemory` with cache warming disabled.
- `DefaultResourceLoader` with extensions, skills, context files, prompt templates and themes disabled, empty system prompt and no appended system text.
- Only the version-specific confined workspace `customTools`, selected as the active tools.
- Medium reasoning, matching pinned Codex phase 2.

The rendered original consolidation template is supplied as the user prompt. The renderer substitutes only memory-root/diff paths and memory-extension input blocks. The latter identify staged read-only user notes; they are an explicit source-representation adapter. No identifier rewriting, appended Pi boundaries, summary-length instruction or extra validation-repair turn is added.

The SDK requires a `ModelRuntime`; the extension publicly exposes its owning `ModelRegistry`. `createWriterRuntime` adapts the public methods needed by the fixed physical-model SDK path and delegates streaming to the captured registry closure. Authentication occurs at request time through that registry. Credentials are not copied, refreshed or persisted by this adapter. Virtual routing is not implemented and fails with `unsupported_virtual_model`.

## 3. Context and transport ownership

Pi's session lifecycle owns projected-context thresholds, compaction requests, compaction installation, overflow classification, retries and continuation. Use its standard settings and implementation. The memory package does not implement custom admission thresholds, a summary-quality controller, segmented compaction or a second retry policy inside the session.

`src/pipeline/codex-context.ts` estimates model-visible text with `ceil(UTF8 bytes / 4)` for the host daily ledger. Host metadata and duplicate tool-result details are excluded. This estimate is not an exact tokenizer or a conservative upper bound and does not veto native Pi context recovery.

Every SDK transport call, including summarization and retries, passes through the same writer stream/accounting seam. Before dispatch it checks cancellation, the current lease, configuration/foreground readiness and shared daily admission. It reserves estimated input/output/request usage transactionally and reconciles completed provider usage. Missing usage retains the reservation; already spent usage is not refunded when history is compressed.

The writer no longer has fixed 12-request, 40-tool, 300-second or 4000-output limits. The native SDK supplies runtime output/retry/context settings. Host daily budgets, lease fencing and explicit cancellation remain. A budget denial or ownership loss cannot publish staging.

## 4. Tools, evidence and publication

Tool execution is sequential. Each tool checks current ownership and cancellation before touching the staged workspace. The tool surface replaces Codex shell/original-rollout access with confined local list/read/search/write/delete operations. Responses are bounded and staged originals remain intact; this can change what the model sees and is documented as a host adaptation.

Selected evidence, shared notes and their manifest remain immutable host inputs. Session compaction summaries are derived working state, not new evidence, notes or publication provenance. Compaction never changes the selected source set or credits semantic completeness.

The host retains version, selection, control epoch, source/retention validity, lease owner/fence and generation identity. Completed session output remains unpublished until required artifact checks and the existing publication CAS pass. Publication is atomic; partial files or successful compaction are not a readable generation.

Pinned required artifact validation is:

| Version | Required checks |
| --- | --- |
| v1 | Regular `MEMORY.md`; readable UTF-8 `memory_summary.md`; first line literal `v1` |
| v2 | Readable UTF-8 summary; literal `v1`; UTF-8 length `<10000`; four native summary headings |

Symlink rejection, secret handling, source support, revocation and filesystem integrity remain host safety boundaries. Custom project/date grouping and generated-prose citation gates are removed. Invalid final artifacts fail the run without prompting a repair.

Staging/diff generation and immutable-generation CAS replace upstream mutable memory-root/git-baseline operations. Notes replace upstream extension resources. SQLite scheduling, leases, daily quotas and source retention are preserved host policies; exact native storage/scheduling equivalence is unsupported.

## 5. Foreground boundary

Consolidation isolation does not load foreground memory or permission extensions. Foreground memory uses the original read templates with native approximate 2500-token summary truncation, but its active carrier is quoted, bounded and revocable user-role custom content. Native Codex contributes developer-policy fragments. Role priority, generation identity, capacity clipping/omission, bounded retrieval envelopes and pin cursors are explicit host differences.

Read-only `/memory status` and `/memory doctor` distinguish eligible publication from writer progress and terminal failure. Healthy host state or a successful model response alone does not imply readable memory.

## 6. Verification and limits of proof

Focused SDK/synthetic tests cover:

1. A ~404KB fitting request on a 272k-window model without byte/token false rejection.
2. Tool continuations crossing the native compaction threshold, summarization and writer continuation.
3. Native overflow recovery and transient retries through the same daily accounting seam.
4. Cancellation-ignoring providers, late writes, foreground activation and lease loss without stale publication.
5. Runs exceeding the old call/tool/time limits, without restoring those limits.
6. 256-source staged publication followed by `selected memory READABLE` and successful retrieval; deliberate writer failure keeps read-only failure diagnostics.
7. Required v1/v2 artifacts and no custom repair turn or project/date gate.
8. Schema 14 preservation for native v2 truncation metadata, including marker growth beyond original input length, with rollback on failed migration.

Final acceptance requires integrated typecheck, repository tests, behavioral matrix, upstream-manifest verification and parity audit. Report actual results rather than assuming focused passes establish every gate. Actual Pi TUI/noninteractive/provider UAT remains separate and unrun at this checkpoint. Synthetic selected-source counts do not prove semantic coverage, real-provider language quality or exact token accuracy.

## 7. Compatibility

Retain configured source-selection ceilings and explicit user values; no automatic source-count reduction is introduced. Prompt/renderer/runtime/validation policy hashes queue work under the new policy without clearing unrelated state. v1/v2 generations, privacy invalidation, notes and historical charged usage remain separate and fenced.

Extraction shares the pinned UTF-8/4 and native output policies, with its Pi snapshot representation documented in the strict-port ledger. Its 120-second provider cancellation boundary is a host transport rule, not a consolidation compactor timer. Do not reintroduce a custom compaction controller to align that separate boundary.

For the pinned function map, adapter classifications and current checkpoint results, see [Strict Codex Memory Port](../strict-codex-port.md).
