# Strict Codex Memory Port — Work Ledger

**Branch:** `refactor/strict-codex-memory-port` (forked from `main`; PR #58 is not included)
**Status:** IN PROGRESS. This document is not a claim of runtime parity.

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
