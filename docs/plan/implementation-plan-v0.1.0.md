# Pi Memory — Implementation Plan v0.1.0

**Spec:** `docs/spec/pi-memory-spec-v0.1.0.md` (draft revision 2, commit `f42f825`)
**Plan date:** 2026-09-28
**Status:** Proposed; no implementation code exists yet

## 0. Verified host facts

Confirmed against the user's installed host before planning:

| Fact | Result |
|---|---|
| Installed pi version | `@earendil-works/pi-coding-agent` **0.87.1** — exactly the spec's inspected version |
| Node | v24.16.0 (>= 22.19.0 required); `node:sqlite` imports successfully |
| Peer packages | `pi-agent-core`, `pi-ai`, `pi-tui` present inside pi's node_modules |
| Required events | `session_start`, `session_before_compact`, `session_compact`, `session_shutdown`, `session_tree`, `before_agent_start`, `agent_start`, `agent_end`, `agent_before_settle`, `agent_settled` — all present in `dist/core/extensions/types.d.ts` |
| Prompt sections | `before_agent_start` exposes structured `systemPromptOptions`; section replacement is the documented preferred mechanism |
| Model access | `ctx.modelRegistry.streamSimple()` documented for provider-neutral nested calls |
| Agent dir | `PI_CODING_AGENT_DIR` override confirmed; default `~/.pi/agent` |

Consequence: no host upgrade or compat shim is needed for development; capability checks are still implemented per spec §2.3 so older hosts fail loudly.

## 1. Work item W0 — upstream source vendoring (prerequisite)

The spec (§2) requires vendoring Codex prompt templates at commit `1cc7e2361237ce7244430ee1d581c77f95c57ac8` with a source manifest (repo, commit, path, content hash, local destination, adaptation description) and license notices.

Tasks:

1. Fetch from `openai/codex` at the pinned commit (shallow fetch of that SHA; if network is unavailable, stop and ask the user for a source archive):
   - v1 family: `codex-rs/memories/write/templates/memories/` (stage-one system, consolidation) and `codex-rs/ext/memories/templates/memories/read_path.md`
   - v2 family: `stage_one_system_v2.md`, `consolidation_v2.md`, `read_path_v2.md` (same directories)
   - `LICENSE` (Apache-2.0)
2. Record for each file: upstream repo/commit/path, SHA-256 of content, local destination, in `UPSTREAM.md`.
3. Store immutable originals under `prompts/upstream/v1/` and `prompts/upstream/v2/`; create `NOTICE` with Apache-2.0 attribution; add `LICENSE` for this project.
4. Write `prompts/pi/v1/` and `prompts/pi/v2/` adaptation change-logs (initially empty; filled as adaptations are written in Phases 2–4).

**Exit:** `UPSTREAM.md` lists every vendored file with verified hashes; CI-style check script re-hashes and compares.

## 2. Package scaffolding (start of Phase 1)

Per spec §20:

- `package.json`: ESM, `pi.extensions: ["./src/extension.ts"]`, peer deps `@earendil-works/pi-coding-agent`, `@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`, `typebox` (all `*`), `engines.node >=22.19.0`.
- Dev tooling: TypeScript (typecheck only — pi's loader runs TS directly), `vitest` or `node:test` for unit/integration tests. **Decision needed:** test runner (proposal: `node:test` to keep runtime deps at zero; vitest if the user prefers).
- One maintained text-diff dependency for the phase-2 workspace diff (spec §9.2, §20). Candidate: `diff` (jsdiff). **Decision needed:** confirm dependency choice.
- Layout: `src/`, `prompts/`, `eval/`, `tests/`, docs/provenance files.

## 3. Phase 1 — Source and compatibility baseline (spec §21.1)

**Goal:** correct session-tree capture inputs; no model calls, no LLM cost.

| # | Module | Task | Requirements / tests |
|---|---|---|---|
| 1.1 | `src/pi/compat.ts` | Runtime capability check: required events, structured sections, `getBranch`, `modelRegistry.streamSimple`, `getAgentDir`/`PI_CODING_AGENT_DIR`, Node >= 22.19, `node:sqlite`. Single diagnostic + disable on failure (no silent old-semantics fallback) | §2.3, §17 |
| 1.2 | `src/state/identity.ts` | Workspace identity (`repoKey`/`checkoutKey`/`workspaceKey`) via argv-based `git` with timeout, no shell; session/branch/lineage keys and `revisionHash` per §5.2–5.3 | R06 |
| 1.3 | `src/capture/branch.ts` | Immutable snapshot of `ctx.sessionManager.getBranch()` + header/path/leaf/cwd; ancestry retained pre-compaction; branch-head selection on ancestor/sibling moves; fork provenance (parent lineage, shared-ancestor source IDs); `session_tree` deactivation logic | R06, T08, T09 |
| 1.4 | `src/capture/normalize.ts` | Evidence projection per §7.2 (user/assistant/tool inclusion, reasoning/media/system/other-extension exclusion, own-memory exclusion), provenance labels (`human_observed`/`programmatic`/`unknown`), context-edit application (null = exclude, replacement = substitute), per-item and total byte budgets, tiered selection with omission manifest, secret redaction pass | R01, R02, R07, R10, T10, T15 |
| 1.5 | `src/capture/import.ts` | Strict read-only JSONL v3 parser (no `loadEntriesFromFile` on sources — it can mutate); malformed interior line → skip file with diagnostic; trailing incomplete record deferred; branching file requires `--leaf`; single unambiguous terminal ancestry importable without leaf | §7.4, T20 |
| 1.6 | `tests/fixtures/` | Synthetic session-tree fixtures: linear, compaction, context-edit (incl. sensitive removal), `/tree` branch switch, fork with shared ancestors, malformed JSONL, Chinese/mixed content, zero-tool discussion | T07–T11, T20 (fixture half) |
| 1.7 | `src/config.ts` | `config.json` load/validate (schemaVersion, ranges incl. `summaryBytes` 1024–9999, `v2RolloutSummaryBytes` 1024–9000, `version`, `dualWrite`), precedence flag > config > defaults, invalid → preserve file + disable generation, atomic update with content-hash CAS for concurrent commands | §14, §5.4, T38 (config half) |

**Exit criteria (spec §21.1):** branch/compaction/context-edit fixtures are correct — snapshot normalization reproduces expected evidence sets for every fixture; importer never modifies source files.

## 4. Phase 2 — Durable capture and both Phase 1 contracts (spec §21.2)

| # | Module | Task | Requirements / tests |
|---|---|---|---|
| 2.1 | `src/state/db.ts`, `src/state/migrations/` | Full SQLite schema §12.2 (WAL, FK, busy timeout, transactional monotonic migrations): `schema_migrations`, `store_state`, `pipeline_state` (per version), `workspaces`, `sessions`, `branch_heads`, `source_revisions`, `jobs`, `extractions` (nullable raw_memory + CHECK), `memory_usage`, `source_stats`, `notes`, `note_applications`, `tombstones`, `generations`, `generation_sources`, `process_activity`, `budget_usage`. Legacy unversioned layout detection → `legacy_layout_detected` disable (§12.5) | R09, R15 |
| 2.2 | `src/state/leases.ts` | CAS lease claims, random owner IDs, monotonic fencing tokens, 180 s TTL / 30 s renew, ownership-loss abort | §11.3, T13 |
| 2.3 | `src/pi/model-port.ts` | `MemoryModelPort` over captured registry refs: `find` + `streamSimple(...).result()`, stop/error inspection (provider error → retry path, not JSON repair), usage extraction, first-run default model persistence, no credential copying | §8.3, §13, T17 |
| 2.4 | `src/pipeline/scheduler.ts` | Eligibility (enrolled, persistent, mode-permitted, branch-stable, not suppressed, per-version+prompt not processed, age/idle/budget), one-shot due-time timers (unref'd, no interval scans), 2 jobs/pass total across versions with selected-version-first alternation, process-activity heartbeats (30 s/180 s), foreground-idle gating | §11.1–11.2, R05, T11 |
| 2.5 | `src/pipeline/budget.ts` | Daily per-(day, provider, model) reservation/reconcile, conservative byte estimate fallback, 100k/20k/20-request shared caps across phases and versions, defer + report on exhaustion | §11.4, T19 |
| 2.6 | `src/versions/v1.ts`, `src/versions/v2.ts` | Version policy objects: pinned adapted extraction prompts (from W0), JSON schemas (v1: 3 fields, slug required; v2: 2 fields, `raw_memory` rejected), output validators, byte caps (48 KiB combined; v2 ≤9000 with paragraph/line-boundary truncation + omission marker + truncation metadata), slug sanitize/80-char cap | §8, T23, T24 |
| 2.7 | `src/pipeline/extract.ts` | Phase 1 execution: tool-free request, one Markdown-fence strip, strict JSON validate (unknown keys rejected), one bounded repair, secret re-scan, 120 s timeout / 6k output cap, fenced commit (`commitExtraction` rejects obsolete revision/lost lease/cross-version), all-empty = no-op processed per version, v2 slug-without-summary → repair/reject | §8, T12, T23, T24, T31 |
| 2.8 | `src/state/store.ts` | `MemoryStore` implementation of §12.4 interfaces with runtime version-mismatch rejection independent of TS types | §12.4, T33 (store half) |

**Exit criteria:** discussion-only extraction works end-to-end against a fake model port (T01 capture half, T12); v2 field/byte boundaries enforced (T23, T24); restart mid-job resumes safely (R09, T13 single-process half).

## 5. Phase 3 — Both consolidation and publication paths (spec §21.3)

| # | Module | Task | Requirements / tests |
|---|---|---|---|
| 3.1 | `src/pipeline/staging.ts` | Version-scoped staging: selected same-version summaries (v1 also merged `raw_memories.md` in stable source-ID order), prior same-version outputs, read-only shared notes snapshot, deterministic manifest + unified diff vs last same-version generation, 4 MiB diff fallback with changed-path index, content-based dirty check (skip LLM when unchanged) | §9.1–9.2, T37 |
| 3.2 | `src/pipeline/workspace-tools.ts` | `workspace_list/read/search/write/delete` with path-safety (no absolute/`..`/symlink/device), version-specific write allowlist (v2: `memory_summary.md` only; `workspace_delete` unregistered for v2), evidence/notes read-only, bounded paged results | §9.3, T18, T26 |
| 3.3 | `src/pipeline/consolidate.ts` | In-memory `Agent` from `pi-agent-core`: explicit model/system prompt/empty messages/`streamFn` via model port, sequential tools, no default session factory (no project resources/extensions/MCP/memory), 5 min / 12 calls / 40 tool calls / 4k output per call, pre-request context accounting with `context_budget` stop | §9.3, §11.4, T18 |
| 3.4 | `src/pipeline/validate.ts` | Artifact validation per version: required headings + literal `v1` first-line marker, UTF-8/size bounds (v2 summary strictly <10,000 regardless of config; test bytes), pointer existence (v1 → handbook sections/evidence; v2 → staged rollout summaries), source-reference existence in selected set, forbidden-artifact rejection (v2 `MEMORY.md`/skills/raw_memories), secret scan, deterministic minimal outputs when no sources/notes remain | §9.4, T25, T26, T36 |
| 3.5 | `src/pipeline/publish.ts` | Publication protocol §9.5: fsync files+dir, rename to `versions/<v>/generations/<id>/`, single SQLite CAS transaction (lease fence, per-version base generation, same-version selection state, shared control epoch), orphan cleanup, retention of ≤2 old generations per version + pins, invalidation override | §9.5, R08, T13, T14, T33 |

**Exit criteria:** v2 publishes without a handbook (T36); forbidden outputs and cross-version references fail validation/CAS (T26, T33); crash-at-each-boundary and parallel-process tests pass (T13, T14).

## 6. Phase 4 — Read paths, switching, and controls (spec §21.4)

| # | Module | Task | Requirements / tests |
|---|---|---|---|
| 4.1 | `src/read/view.ts` | `acquireReadView(version)`: DB-selected immutable generation only, control-epoch + retention recheck before serving (even when cached), `(memoryVersion, generationId)` pin per foreground run, fail-open ≤200 ms, retention-deadline one-shot scheduling | §6.2, §10, R04 |
| 4.2 | `src/read/inject.ts` | `pi_memory` section at `before_agent_start`: cached bounded summary + workspace applicability + version + generation ID + version-specific read guidance; exactly one version's content (never concatenated); evidence-not-instructions labeling; conflict diagnostic when another extension forces a full prompt; omit on invalid/unavailable/excluded workspace | §6.2, §10, T21, T28 |
| 4.3 | `src/read/tools.ts` | `pi_memory_search/read/list`: pinned version+generation only, per-version path allowlists (v2: rollout summaries only; disallowed → `path_not_available_for_version`), literal Unicode substring matching, cursor with version+generation+query hash, 16 KiB caps with `truncated`, usage counting only on successful detail read (dedup by version/session/run/source) | §10, T27, T33 |
| 4.4 | `src/control/notes.ts` | `/memory remember|correct` + `pi_memory_note` tool; notes shared across versions, applied independently (`note_applications`); corrections invalidate until reconciled; note-forget consequence explanation | §15–16, T35 |
| 4.5 | `src/control/forget.ts` | Forget source/session/note/clear: tombstones before deletion, both `pipeline_state` rows blocked at new shared epoch, per-version rebuild, revoked generations never served, snapshot/extraction removal for privacy, no inference from missing files | §16, T16, T32 |
| 4.6 | `src/control/switch.ts` | `/memory version`, `/memory dual-write`: atomic config CAS, warming_up on unbuilt target (no fallback), in-flight requests finish in original namespace, inactive-version job claiming stops, explicit one-run version grants with cancellation on later switch, snapshot-pruned reconstruction via read-only importer or `source_unavailable_for_version` | §5.4, T28, T29, T34 |
| 4.7 | `src/commands/memory.ts` | Full `/memory` subcommand surface §15 (status/doctor/test-models/inspect/run/version/dual-write/model/mode/import/remember/correct/forget/clear), `--json`, per-version status breakdown, no status text in JSON-protocol stdout, `ctx.hasUI`/`ctx.mode` gating | §6.3, §15, R11, T22 |
| 4.8 | `src/extension.ts` | Lifecycle wiring per §6.1 table: factory registers only; `session_start` init/restore/schedule; `agent_settled` snapshot+schedule; compaction hooks; `session_tree` reconcile; `session_shutdown` bounded cleanup ≤500 ms; mode resolution (`--pi-memory-mode`, `captureModes`, TUI default) | §6.1, §6.3, T11, T22 |

**Exit criteria:** no prompt-path network calls (R04); no mixed-version or revoked-memory readback (T16, T28, T29, T32, T38).

## 7. Phase 5 — Quality gate and packaging (spec §21.5)

| # | Module | Task |
|---|---|---|
| 5.1 | `tests/behavioral/` | T01–T22 × both versions; T23–T38 version/cross-version cases; deterministic fake model port; crash injection at publication boundaries; parallel-process harness |
| 5.2 | `eval/` | ≥30 multi-session cases (10 decisions, 5 scoped preferences, 5 failures/open work, 5 corrections/branch conflicts, 5 noise/abstention; ≥10 Chinese/mixed; ≥5 zero-tool), evidence-based answer keys, 4 modes (none/curated/v1/v2), 3 repetitions, isolated stores and fresh answering sessions, cost/bytes/latency reporting per version |
| 5.3 | `tests/perf/` | Performance gates §18: prompt-section p95 <20 ms, view refresh <100 ms, search/read <250 ms, checkpoint <100 ms, shutdown cleanup <500 ms, <100 MiB extra RSS |
| 5.4 | packaging | `pi install ./pi-memory` smoke test in real TUI + one read-only noninteractive path for both versions; install/uninstall preserves unrelated pi settings; docs (README, model configuration, measured footprint); provenance/license final check |

**Release gate (§19.3):** all T01–T38 in the version matrix; per-version semantic targets (≥90% decision recall, zero critical fabrication, ≥90% abstention, ≤5 pts below curated baseline).

## 8. Cross-cutting decisions and open questions

1. **Test runner:** propose `node:test` (zero runtime deps, matches "small dependencies" §20). Needs user confirmation if vitest is preferred.
2. **Diff library:** propose `diff` (jsdiff, maintained, MIT). Alternative: implement a minimal Myers diff in-house to reach zero non-peer runtime deps.
3. **Upstream fetch (W0):** requires network access to github.com. If blocked, need a user-supplied archive of `openai/codex` at the pinned commit.
4. **TypeBox vs manual JSON validation:** spec lists TypeBox as an allowed dependency for tool args; extraction output validation is strict JSON with unknown-key rejection — TypeBox works for both.
5. **Timezone for budgets:** default from host local timezone; config example uses `Asia/Shanghai` (user's TZ).
6. **Eval model access:** Phase 5 needs a real provider configured in pi; will surface cost before running.

## 9. Suggested commit sequence

1. `chore: scaffold pi-memory package` (§2)
2. `chore: vendor pinned codex memory prompts` (W0)
3. `feat: host compatibility checks and identity` (1.1–1.2)
4. `feat: branch capture and normalization` (1.3–1.4)
5. `feat: read-only historical importer` (1.5)
6. `feat: configuration load and validation` (1.7)
7. `feat: sqlite schema, leases, fencing` (2.1–2.2)
8. `feat: model port and budgets` (2.3, 2.5)
9. `feat: scheduler and eligibility` (2.4)
10. `feat: v1/v2 extraction policies and phase 1` (2.6–2.8)
11. `feat: staging workspace and confined tools` (3.1–3.2)
12. `feat: consolidation agent loop` (3.3)
13. `feat: validation and atomic publication` (3.4–3.5)
14. `feat: read views, injection, retrieval tools` (4.1–4.3)
15. `feat: notes, correction, forgetting` (4.4–4.5)
16. `feat: version switching and dual write` (4.6)
17. `feat: /memory commands and extension lifecycle` (4.7–4.8)
18. `test: behavioral matrix T01–T38` (5.1)
19. `test: semantic evaluation harness` (5.2)
20. `chore: packaging, docs, release gate` (5.3–5.4)

Each commit lands with its tests green; phases 1–4 are independently exitable per spec §21.
