# v2 consolidation and publication

Issue #8 adds the v2 writer to the existing consolidation pipeline. V1 and v2 keep
independent source selection, prompt hashes, input revisions, base generations and
publication pointers. Dual writing starts with the selected version, then rotates
dirty opportunities between sequential passes under the existing store-wide lease
and shared budgets. Live-lease contention preserves a wake at lease expiry for crash
recovery.

V2 staging contains selected v2 rollout summaries, scoped shared notes, a manifest
and deterministic diff, plus a valid prior v2 summary when support remains. It never
imports v1 outputs, raw memories, a handbook or skills, including through prior-file
diffs. Cross-version or revoked prior support cannot supply plaintext to the writer.

The in-memory Agent exposes four workspace tools. Only `memory_summary.md` is
writable, and deletion is not registered. The pinned upstream v2 prompt is adapted
to Pi session/source identifiers and exact staged paths without modifying upstream
files. Existing time, request, context, tool, daily-budget and repair limits apply.

The summary uses literal `v1` as its format marker while the manifest/database use
`v2` as the pipeline version. It has the four required headings and remains at most
9,999 UTF-8 bytes regardless of an oversized configuration. Recent retrieval routes
use project/date groups and exact selected rollout paths; older topics retain scope.
No remaining evidence or notes produces only the deterministic minimal summary.

V2 validation checks allowed files and directories, evidence/note integrity, pointers,
identifiers, grouping and secrets. Publication repeats validation before fsync/rename,
so caller-bypassed validation cannot publish a forbidden handbook, raw-memory file
or skill. The existing SQLite CAS checks the same-version selection/base, lease
fence and shared epoch. Readers serve only the selected immutable generation.

The next session receives only its selected version's summary and read guidance.
V2 guidance reads rollout summaries directly and requires no handbook. Prompt
handling makes no memory model request. The foreground detail tools are a separate
issue; this change tests ordinary injected guidance and the writer boundary.

Verification uses temporary Git repositories, real JSONL, SQLite and a real Agent
with a simulated model transport. Those checks do not establish real-provider memory
quality.
