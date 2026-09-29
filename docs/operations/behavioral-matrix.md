# Behavioral matrix gate (issue #14)

Run `npm run test:behavioral` from the repository root. The command runs every repository `*.test.ts` / `*.test.mjs` file serially, then prints one result for each required spec §19.1 case: T01–T22 × v1/v2 and T23–T38 × their specified v2/cross-version scope (60 results). A missing, duplicate, failed, skipped, or unexpected matrix label fails the gate; an unrelated test failure also fails it. Tests run one file at a time with a 120-second timeout to bound hung child processes. Test titles begin with `Tnn v1:`, `Tnn v2:`, or `Tnn cross:`. Do not assign a label to a test that does not exercise the scenario: a missing result is more useful than a false green.

The deterministic model ports are **scripted fixtures**. They test capture, scheduling, schema validation, bounded generation, publication, version isolation, and retrieval against real JSONL/SQLite and mock Pi boundaries. For T01–T06, the fixture deliberately supplies the correct extracted facts; these tests cannot prove that a real model would infer them. T05 additionally exceeds the capture evidence budget with routine tool logs and asserts that the user decision survives while some logs are omitted. Real-model recall, abstention, and hallucination targets belong to §19.2 / issue #15. A passing matrix is not a semantic-quality or real-TUI release claim.

## Coverage map

| Case | Primary labeled test | Additional assertions run by the same command |
| --- | --- | --- |
| T01–T06 (both) | `tests/behavioral/decisions.test.ts` | Normalized source text reaches fake model; published output is injected and retrievable next session. T05 includes actual routine tool results. |
| T07–T10 (both) | `tests/capture-events.test.ts` | `tests/normalize.test.ts`, `tests/context-edits.test.ts`, `tests/snapshot-store.test.ts` cover filtering, ancestry, and invalidation. |
| T11 (both) | `tests/failure-lifecycle.test.ts` | Settled branch, not `agent_end`, is the capture boundary. |
| T12 (both) | `tests/extraction-scheduler.test.ts` | No-output watermarks block repeat calls. |
| T13 (both) | `tests/process-concurrency.test.ts` | Two real child processes race extraction and consolidation leases. |
| T14 (both) | `tests/publication.test.ts` | Real child-process exit at each fsync/rename/CAS boundary. |
| T15 (both) | `tests/behavioral/decisions.test.ts` | `tests/normalize.test.ts` additionally checks `pi_memory` calls and tool results. |
| T16 (both) | `tests/notes.test.ts` | `tests/forgetting.test.ts` checks source/session tombstones and late writes. |
| T17 (both) | `tests/extraction-runner.test.ts` | `tests/model-port.test.ts` verifies Pi registry resolution and no copied credentials. |
| T18 (both) | `tests/consolidation-agent.test.ts` | Fake model attempts shell and original JSONL reads through confined writer. |
| T19 (both) | `tests/extraction-runner.test.ts` | Shared budget defers requests without making provider calls. |
| T20 (both) | `tests/historical-import.test.ts` | Ambiguous and malformed JSONL remains unchanged; explicit leaf tests run in same file. |
| T21–T22 (both) | `tests/failure-lifecycle.test.ts` | T22 includes separate `off`/`read` assertions in same file. |
| T23 | `tests/extraction-runner.test.ts` | `tests/extraction-v2.test.ts`, `tests/jobs.test.ts` cover strict schema and DB constraints. |
| T24 | `tests/extraction-v2.test.ts` | UTF-8, complete retained pointer, omission marker, 9,000-byte limit. |
| T25 | `tests/artifact-validation.test.ts` | Exact 9,999/10,000-byte boundary and literal `v1` marker. |
| T26 | `tests/consolidation-agent.test.ts` | `tests/publication.test.ts` and `tests/artifact-validation.test.ts` reject forbidden candidates before publication. |
| T27 | `tests/consolidation-lifecycle.test.ts` | `tests/retrieval.test.ts` denies v1 paths and serves direct v2 evidence. |
| T28 | `tests/notes-lifecycle.test.ts` | Version switch preserves foreground pin and unbuilt warm-up. |
| T29 | `tests/extension-run.test.ts` | Delayed result stays in original version; pin behavior also in `tests/notes-lifecycle.test.ts`. |
| T30 | `tests/extraction-scheduler.test.ts` | Independent retry/watermarks, shared request budget. |
| T31 | `tests/jobs.test.ts` | A v1 no-output result does not consume v2's work. |
| T32 | `tests/notes.test.ts` | Both versions revoked during a correction, including inactive v2; `tests/notes-lifecycle.test.ts` switches away and back after forgetting to ensure no guidance revives. |
| T33 | `tests/retrieval.test.ts` | `tests/publication.test.ts`, `tests/staging-v2.test.ts`, and `tests/jobs.test.ts` also reject mismatched manifests, paths, source refs, and DB pointers. |
| T34 | `tests/version-recovery.test.ts` | Pruned original JSONL rebuilt read-only or reported unavailable; `tests/staging-v2.test.ts` rejects other-version generated output. |
| T35 | `tests/notes.test.ts` | Each version records its own application of the same note revision. |
| T36 | `tests/artifact-validation.test.ts` | No handbook, pointers, or invented claims in minimal summary. |
| T37 | `tests/consolidation-store.test.ts` | Per-version changes/no-op/expiry; shared correction revokes both. |
| T38 | `tests/notes-lifecycle.test.ts` | `tests/version-controls.test.ts` additionally checks field-scoped updates and cancelled grants. |
