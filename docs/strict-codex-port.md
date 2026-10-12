# Strict Codex Memory Port — Work Ledger

**Branch:** `refactor/strict-codex-memory-port` (PR #58 is not included)
**Checkpoint:** 2026-10-12, implementation and local repository gates completed. Isolated TUI UAT passed 6/6; real-provider D01 pilot completed with a v2 provenance defect. Primary acceptance is Codex workflow and prompt parity; recall quality is secondary. The read-path failure is fixed; actual CLI/TUI + real Luna 6 v1/v2 reruns passed extraction, consolidation, publication, READABLE and memory detail read, with captured prompt checks.

## Baseline and scope

The memory behavior baseline is **`openai/codex@1cc7e2361237ce7244430ee1d581c77f95c57ac8`**. It matches all nine vendored files in `UPSTREAM.md`. The previously observed moving-main SHA `806d9732c974bc8a51b8317c1bd8985544fe627c` is not a second implementation baseline.

Memory prompts and selected write/read policies are ported from that baseline. Pi owns agent execution, compaction and overflow recovery. Filesystem isolation, immutable generations, revocation, SQLite leases/budgets and diagnostics remain Pi host adapters. This is not a claim of identical Codex runtime, source serialization or provider behavior.

## Implemented changes

- Consolidation now runs through `createAgentSession()`, `SessionManager.inMemory()` and an isolated `DefaultResourceLoader`. Resource discovery, extensions, skills, context files, themes and prompt templates are disabled. Only confined custom workspace tools are enabled. No second compactor or context controller is maintained.
- The rendered upstream consolidation template is the user prompt. Identifier rewriting, appended consolidation boundaries and summary-length instructions are removed. Medium reasoning matches pinned phase 2. Workspace/diff paths and extension-input placeholders are host substitutions; the latter describe staged read-only notes.
- Writer limits of 12 model calls, 40 tools, 300 seconds and 4000 output tokens are removed. Pi's native threshold compaction, overflow recovery and retry use the same gated accounting transport as ordinary writer turns. There is no local artifact-repair prompt or extra repair turn.
- Extraction parses one sampled response. v1 accepts an absent/null slug and classifies either empty required field as no output. v2 preserves the native 9000-byte middle-truncation algorithm, including its character-count marker outside the retained-byte budget. JSON fences and custom output-size/slug/whitespace policies are removed.
- Extraction estimates request tokens with `ceil(UTF8 bytes / 4)` and uses the resolved model output maximum clamped to remaining estimated context at the Pi transport boundary. v1 applies native head/tail truncation at 70% of the resolved Pi window; v2 retains normalized Pi role/dependency tiers with corrected token units. Raw path/cwd/branch placeholders match upstream rendering.
- Consolidated v1 validation requires a regular `MEMORY.md`, UTF-8 summary and literal `v1` marker. v2 additionally requires the native four headings and `<10000` summary bytes. Custom project/date grouping checks are removed. Filesystem, redaction and publication-integrity checks remain.
- Read guidance now uses the vendored upstream templates and native approximate 2500-token summary truncation. Retrieval supports native immediate-child listing, normalized/same-line/window search modes and token/line read limits. The revocable quoted carrier and response envelopes remain host adaptations.
- Schema 14 allows native v2 truncation metadata where the marker makes accepted output exceed 9000 bytes or even the original size. Existing rows and schema-upgrade privacy handling are retained.

## Function mapping

All upstream paths below are relative to `codex-rs/` at the pinned SHA. **Exact policy** means the named policy is ported, not that its surrounding runtime is identical.

| Upstream path / function | Pi implementation | Classification |
| --- | --- | --- |
| `memories/write/src/prompts.rs::build_consolidation_prompt_for_version` | `pipeline/consolidate.ts::renderConsolidationPrompt` | Original template; host workspace/diff/notes substitutions |
| `memories/write/src/phase2.rs::agent::get_prompt` | `runConsolidation` / `session.prompt` | Rendered template as user prompt |
| `phase2.rs::agent::get_config` | isolated SDK settings/resource loader, `SessionManager.inMemory`, workspace tools | Host adapter; medium reasoning preserved |
| `phase2.rs::agent::loop_agent`, `handle` | SDK session lifecycle plus lease/readiness gates, scheduler/publication | Pi native execution; SQLite/CAS publication adapter |
| Codex core context/compaction lifecycle | Pi `AgentSession` native compaction/overflow/retry | Host runtime substitution, not a copied Codex compactor |
| `memories/write/src/phase1.rs::job::sample` | `extraction/runner.ts::runExtraction` | One sample/parse; provider and scheduling adapters |
| `memories/write/src/phase1_output.rs::StageOneOutput::parse`, `output_schema` | `extraction/v1.ts`, `v2.ts`, `format.ts` | Exact output policies; missing v1 slug mapped to empty storage string |
| `memories/write/src/prompts.rs::rollout_token_limit`, `build_stage_one_input_message` | extraction `fitContext`, v1 `rolloutContents` seam | Native 70% and head/tail policy; Pi window lacks effective-percent metadata; output headroom is a host admission adapter |
| `memories/write/src/rollout_input.rs` / phase1 rollout serialization | captured normalized Pi snapshot, v2 role/dependency tiers | Host representation adapter; source-serialization equivalence unsupported |
| `memories/write/src/workspace.rs::validate_consolidation_artifacts_for_version`, `is_valid_v2_summary` | `pipeline/artifacts.ts` and publication validation | Exact required artifacts/marker/v2 headings and size; extra integrity checks |
| `memories/write/src/storage.rs` input synchronization | `pipeline/staging.ts` | Host paths, selected evidence, notes and diff adapter |
| `ext/memories/src/prompts.rs::build_memory_tool_developer_instructions` | `read/inject.ts::renderMemorySection`, `renderMemoryCarrier` | Original template/native summary truncation; carrier envelope differs |
| `ext/memories/src/extension.rs::contribute_thread_context` | `read/projection.ts` and foreground hooks | Revocable quoted user-role carrier; native `developer_policy` priority unsupported |
| `ext/memories/src/local/list.rs::list` | `read/tools.ts` list | Immediate children/default 2000; pin cursor and response-byte adapter |
| `ext/memories/src/local/search.rs::search` | `read/tools.ts` search | Matching/window/context/default 200; pin attribution/pagination adapter |
| `ext/memories/src/local/read.rs::read` | `read/tools.ts` read | 1-based offset/line limits/default 20000 tokens; response-byte adapter |
| `utils/string/src/truncate.rs` | `codex-truncation.ts`, extraction truncation helper | Native UTF-8 middle truncation and marker semantics |

## Host boundaries and unsupported equivalence

`ExtensionContext` exposes the owning `ModelRegistry`, not its private concrete `ModelRuntime`. `pipeline/model-port.ts::createWriterRuntime` supplies the fixed physical-model public facade required by the SDK and delegates requests to the existing registry closure. Authentication remains at request time; no credentials are copied or persisted. This facade is tested against the real SDK but does not implement virtual model routing. Virtual models fail explicitly with `unsupported_virtual_model`.

Workspace tools replace Codex shell/original-rollout access and keep sequential execution, confined writes and bounded responses. Staging/diff generation uses immutable host selections rather than the native mutable git-baseline memory root. Shared notes replace native memory-extension resources at the template-placeholder boundary. SQLite generations, CAS, control epochs, source retention, leases, daily admission and diagnostics remain host operations. Their scheduling and publication rules are not asserted to equal upstream state storage.

Foreground memory is a quoted, bounded and removable custom message projected as user content. Native Codex contributes developer-policy instructions. Pin identity, revocation, capacity omission and the 16KiB retrieval-response ceiling can change the content visible to the model. Retrieval uses host names/aliases, source attribution and generation-bound cursors rather than upstream tool namespaces and decimal cursors. These differences are explicit adapters, not evidence of complete read parity.

## P0 acceptance and evidence

The historical writer compared serialized UTF-8 **bytes** with token-valued capacity and had no background automatic compaction. A fitting ~404KB request on a 272k-token model could be falsely rejected. That failure is corrected; it does not explain every `selected memory UNAVAILABLE` result.

Focused synthetic checks now exercise:

- Native Pi session tool continuation, threshold compaction, overflow recovery/retry, shared transport accounting, cancellation and isolation.
- Publication from a 256-source selected workspace, subsequent `selected memory READABLE` diagnostics and successful retrieval; failure retains an unavailable status and read-only diagnostics.
- Native extraction outcomes, malformed-output single sampling, UTF-8 truncation, 404KB/272k-window accounting and fencing.
- Schema 14 upgrade preservation and rollback behavior, plus legacy privacy cleanup.

The integrated full suite passed **545/545**, followed by **23/23** retrieval checks after the final search efficiency change. Extraction/jobs checks passed **58/58** after output-headroom correction. Typecheck, all **9/9** upstream hashes, **11** static policy checks and `git diff --check` passed. The behavioral matrix passed **60/60**, with zero missing or failed/skipped rows and no unrelated failures. The audit checks declared policy facts and adapters, not full cross-runtime semantic equivalence.

Standards/spec review found and resolved missing extraction output headroom, read truncation attribution/suffix loss and quadratic search pruning. The final multi-line search uses a sliding-count host efficiency adaptation while preserving native minimal-window results. Omitted middle evidence does not gain detail-use credit.

The installed Pi **0.99.2** foreground host probe passed with every provider transport intercepted. It verifies HTTP abort fencing and documents the pre-existing unsupported cached Codex WebSocket abort fence; it does not make network calls or establish provider UAT.

## Remaining acceptance

- [x] Final local repository gates passed on the integrated worktree.
- [x] Run isolated actual Pi TUI workflow: 6/6 passed publication, READABLE, injection and detail retrieval, including synthetic-threshold native compaction.
- [x] Close actual CLI/TUI + real Luna 6 path-contract failure: both versions completed extraction, consolidation, publication, READABLE, list and detail read after the fix. Captured extraction system/input and rendered consolidation prompts were checked for both. See [UAT evidence](operations/strict-port-uat.md).
- [ ] Resolve or explicitly accept the documented host differences before claiming exact Codex parity. Template hashes and static policy checks alone do not prove full execution equivalence.
- Secondary observation: D01 v2 emitted an unsupported rollout UUID. Recall-quality benchmarking is not the primary integration gate.

UAT used isolated temporary profiles and stores; no production memory store was modified.
