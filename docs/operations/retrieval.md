# Memory retrieval

`pi_memory_search`, `pi_memory_read` and `pi_memory_list` use the same version and immutable generation as the summary injected at the start of a foreground run. Normal publication does not switch an existing run to a newer generation. Epoch changes, blocked pipelines, expired or retired support, invalid hashes and unsafe paths make the old view unavailable at the next tool boundary. A tool cannot select a version or generation.

v1 exposes `MEMORY.md`, `rollout_summaries/*.md` and `skills/<slug>/SKILL.md`. v2 exposes rollout summaries only. Explicit disallowed paths return `path_not_available_for_version`; there is no fallback. The injected compact summary, manifest, notes, raw memories, diffs, source snapshots and database are not reader targets.

Search accepts one to eight literal Unicode queries and `match: any|all`. Matching is case sensitive unless `caseSensitive: false` is supplied. Results sort by relative path and line number. Search and list cursors bind the operation, query/filter, version and generation; a mismatched cursor returns `invalid_cursor` without content.

Results include relative paths, line numbers, known source IDs and readable evidence in `details`. Complete responses, including duplicated text/details, stay within 16 KiB. Search/list return a continuation cursor; reads return `nextStartLine`. Oversized individual lines are UTF-8-safe excerpts marked `truncated`; a line excerpt does not promise the complete original line.

Only successful detail reads increment usage, once per version, consumer session, foreground run and source. Summary injection, search hits and listing do not refresh retention. Errors omit file content and internal filesystem paths. Retrieval makes no model request.
