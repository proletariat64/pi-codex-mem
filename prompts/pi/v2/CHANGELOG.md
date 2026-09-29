# v2 Prompt Adaptations — Change Log

Adapted prompts derived from `prompts/upstream/v2/` live in this directory. Every adapted file must be recorded here and in `UPSTREAM.md` (adaptation log): source file, adapted destination, and a description of every change.

| Source | Adaptation | Changes |
|---|---|---|
| `prompts/upstream/v2/consolidation_v2.md` | Runtime renderer in `src/pipeline/consolidate.ts` and `consolidation-boundaries.md` | Private workspace/diff placeholders, selected source and shared-note manifest, Pi `session_key`/`source_id` in place of thread identifiers, four tools with summary-only writes, exact project/date rollout routes, forbidden v1 layers, literal `v1` format marker, strict UTF-8 byte cap, and one bounded host-validation repair. |
| `prompts/upstream/v2/read_path_v2.md` | `read_path.md` | Selected version/generation/workspace metadata, historical-evidence labeling, direct summary-first retrieval from exact staged rollout paths, ordinary Markdown citations, no handbook lookup or original-session browsing. |

Vendored upstream files remain byte-identical. Prompt hashes cover the runtime renderer revision and version-specific boundaries.

## Revision 3 — signed-off validation parity

The consolidation boundary now separates writer guidance from hard validation.
Codex file/marker checks apply to v1; v2 additionally requires four headings by
presence and a summary below 10,000 UTF-8 bytes. `summaryBytes` is a writer target.
Both versions retain minimal project/calendar-date grouping; nested topic children
inherit grouping without per-bullet citations. Prose pointers, handbook fields and
heading order are not extra gates. One repair is retained for format/grouping errors,
not host integrity failures. Upstream prompts remain unchanged.
