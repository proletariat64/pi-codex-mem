# Strict Codex Memory Port — Work Ledger

**Branch:** `refactor/strict-codex-memory-port` (forked from `main`; PR #58 is not included)
**Status:** IN PROGRESS. This document is not a claim of runtime parity.

## P0 regression: selected memory UNAVAILABLE

The immediate user-visible failure motivating PR #58 was `/memory doctor` showing `selected memory UNAVAILABLE` after the consolidation writer failed to publish a readable generation. This must be a **primary acceptance case**, not an incidental diagnostic.

Documented failure from `docs/spec/consolidation-context-spec-v0.2.0.md` §1.1: the original writer used `Buffer.byteLength(JSON.stringify(context))` (bytes) against a token-valued limit; for a 272k-token model with 4k output and 1,024 overhead it blocked at 186,883 bytes. An illustrative 404 KB English-heavy request is roughly 101k tokens under upstream Codex's bytes/4 estimation and must not be rejected simply because bytes were mistaken for tokens. The old writer also lacked Codex-like cumulative-history compaction. This is a proven code-level issue; it does **not** prove every instance of UNAVAILABLE has that single cause.

The `UNAVAILABLE` label in `src/doctor.ts` is derived from `MemoryDiagnostics.selectedReadable`. `src/diagnostics.ts` sets that based on `getPublishedGeneration()`; the latter also checks blocked reading, published state, current control epoch, source validity/retention and extraction identity. Preserve all such distinctions so doctor explains *why* selected memory is unavailable and whether generation is pending, blocked, failed or invalidated.

**Required parity/operational acceptance:**
- [ ] With 256 selected synthetic sources, a fitting normalized context is not falsely rejected by byte-versus-token unit confusion. The memory writer uses the chosen pinned Codex's counting/context mechanism, not a new hand-written alternative.
- [ ] Demonstrate a real completed consolidation publication and a subsequent `selected memory READABLE` status and working retrieval; retaining only extracted sources is insufficient.
- [ ] With intentional writer failure, `/memory status` and `/memory doctor` remain available, read-only and clearly report the actual terminal reason; no false claim of readable memory.
- [ ] The port retains enough operational Pi diagnostics to distinguish no publication, failed writer, stale source, blocked generation, incompatible host and missing model; diagnostic interfaces must not modify Codex memory behavior.
- [ ] Run actual Pi TUI and noninteractive tests, not only mocked protocol tests.

## Implementation checkpoint — P0 context accounting (2026-10-10)

**Code landed on this branch; parity is NOT complete.**

- `src/pipeline/codex-context.ts`: ported Codex's `ceil(UTF8_bytes / 4)` model-visible history heuristic with the strictly necessary Pi-to-Codex mapping (text, JSON tool-call arguments, tool response bodies, projected tool declarations). Transport metadata and duplicated tool-result `details` are excluded.
- `src/pipeline/consolidate.ts`: replaced the byte-versus-token `JSON.stringify(context)` context check with provider-reported total tokens plus items appended after the last assistant response; before provider usage is known, use the initial model-visible estimate. Removed the arbitrary 70% capacity cap; the remaining interim hard-window gate is not Codex auto-compaction.
- `tests/codex-context.test.ts`: added ~404 KB/272k-window regression, Unicode/escaping, Pi projected tools, provider usage delta and non-text handling.
- `tests/consolidation-agent.test.ts`: replaced historical false-byte-overflow assertions with token-based continuation and real reported hard-overflow tests.
- `/memory status`, `/memory doctor`, `src/diagnostics.ts` and their read-only diagnostics are unchanged.

**Validation performed:** independent Node test of the UTF-8/4 arithmetic (404 KB -> 103,429 approximate tokens) in an isolated local prototype. **Not yet performed:** package typecheck, full repository tests, actual Pi foreground/Writer transport, new-generation publication, doctor READABLE acceptance. Do not present this as a working end-to-end memory port.

**Known remaining upstream deviations (must be addressed next):** Codex mid-turn/pre-turn compaction, model-specific effective window/token accounting, Codex tool-output truncation, original consolidation tool workflow, byte-identical rendered prompts, custom 12-call/40-tool/300s/4k-output limits, custom publication policies. Keep necessary data-integrity/permission isolation and read-only diagnostics without introducing new memory policy.

## Source policy

The canonical behavior is the implementation of `openai/codex` at a **single pinned commit**. Do not port from a moving `main` or from README descriptions alone. The current legacy vendored templates in `UPSTREAM.md` reference `1cc7e2361237ce7244430ee1d581c77f95c57ac8`. The upstream commit observed while starting this branch was `806d9732c974bc8a51b8317c1bd8985544fe627c`; it is **not yet an approved full-file implementation baseline**. Select and audit one baseline before replacing behavior.

Source directories: `codex-rs/memories/write/`, `codex-rs/memories/read/`, and the corresponding `codex-rs/core/` runtime orchestration. Record each upstream file/path/function and its Pi counterpart.

## Allowed deviation rule

1. Preserve upstream prompt templates byte-for-byte; no added policy sections, advice, or user-task assumptions.
2. Permit changes only at host boundaries: Pi session representation, SDK/model transport, lifecycle, tool-dispatch interfaces, filesystem paths, and necessary safety/permission integration.
3. Native Codex limits, retries, scheduling, compaction, extraction, consolidation, validation and read semantics belong to the port; never retain different local choices without an upstream reference.
4. If a native Codex operation cannot be provided by Pi, document the exact API mismatch and narrowly scoped adapter before implementing it.
5. Do not merge PR #58 or carry over its custom context controller as a shortcut.
6. Validate generated prompt bytes, requests, files, reader/tool flow and termination, not only mock results. Never equate one real-model success with parity.

## Initial verified deviations on `main`

The executable `npm run audit:codex-parity` deliberately fails while known deviations exist.

| Finding | File | Observed deviation |
| --- | --- | --- |
| P001/P007 | `src/pipeline/consolidate.ts` | Appends Pi consolidation boundaries and custom summary instructions to upstream Writer template |
| P002-P005 | `src/pipeline/consolidate.ts` | Local fixed writer budgets of 12 requests, 40 tools, 300 seconds and 4K output tokens |
| P006 | `src/pipeline/consolidate.ts` | Rewrites upstream prompt identifier text |
| P008 | `prompts/pi/` and `UPSTREAM.md` | Additional adapted prompt family |

**These are candidates for removal, not proof that every item lacks a Codex equivalent.** Establish the exact upstream implementation before modifying a policy.

## Next code checkpoints

- [ ] Freeze and record current Codex upstream SHA; compare source and existing vendored prompt hashes.
- [ ] Produce function-by-function upstream ↔ Pi mapping and classify each difference as exact/host-adapter/deviation/missing.
- [ ] Replace extraction and consolidation with upstream-equivalent execution and verbatim prompts.
- [ ] Replace memory read/injection with upstream-equivalent semantics via a minimal Pi host adapter.
- [ ] Remove custom runtime limits, validation, and heuristics that are absent upstream, retaining necessary safety and data integrity.
- [ ] Add parity fixtures and evaluate v1 and v2 separately with identical inputs.
- [ ] Run `npm run typecheck`, `npm test`, behavioral tests, and the parity audit; document unsupported equivalence explicitly.

No production memory behavior has been changed by the initial audit commits.
