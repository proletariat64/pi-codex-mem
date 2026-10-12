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

The in-memory Pi `AgentSession` exposes four workspace tools. Only `memory_summary.md` is writable, and deletion is not registered. The pinned upstream prompt is rendered with workspace/diff/notes parameters, without rewriting its instructions or identifiers. Pi owns compaction, overflow recovery and transient retries; daily budgets, cancellation and fenced publication remain host controls. There are no custom Writer request/tool/time/output caps or repair prompts.

The summary uses literal `v1` as its format marker while the manifest/database use `v2` as the pipeline version. It has the four required headings (presence, not order or uniqueness) and stays strictly below 10,000 UTF-8 bytes. Project/date grouping and exact source pointers remain upstream guidance and semantic-quality criteria, without extra host format gates.
No remaining evidence or notes still produces the deterministic minimal summary.

V2 keeps host checks for allowed files/directories, evidence/note integrity and secrets.
These are distinct from generated-text validation. Failed validation ends the Writer without another repair request. Publication repeats validation before fsync/rename,
so caller-bypassed validation cannot publish a forbidden handbook, raw-memory file
or skill. The existing SQLite CAS checks the same-version selection/base, lease
fence and shared epoch. Readers serve only the selected immutable generation.

The next session receives only its selected version's summary and read guidance.
V2 guidance reads rollout summaries directly and requires no handbook. Prompt
handling makes no memory model request. The foreground detail tools are a separate
issue; this change tests ordinary injected guidance and the writer boundary.

Verification uses temporary Git repositories, real JSONL, SQLite and a real Pi AgentSession
with a simulated model transport. Those checks do not establish real-provider memory
quality.
