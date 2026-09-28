# v1 Prompt Adaptations — Change Log

Adapted prompts derived from `prompts/upstream/v1/` live in this directory. Every adapted file must be recorded here and in `UPSTREAM.md` (adaptation log): source file, adapted destination, and a description of every change.

## Issue #7 — consolidation and published-summary reading

- `prompts/upstream/v1/consolidation.md` is rendered by `src/pipeline/consolidate.ts`, with `consolidation-boundaries.md` appended. Template placeholders point to the private staged workspace and its deterministic diff. Shared notes are read-only staged inputs. The adaptation replaces shell and original-rollout operations with the five workspace tools, supplies Pi source/session identifiers, requires `applies_to`, ordinary Markdown citations, the literal summary marker and four headings, a UTF-8 byte cap, and prose-only optional procedures. Host validation permits one bounded repair within the same Agent run. The upstream file remains unchanged.
- `prompts/upstream/v1/read_path.md` is adapted as `read_path.md`. The shorter Pi guidance identifies the selected version, DB-selected generation directory, current workspace and applicability, embeds only the bounded published summary, labels history as evidence, and describes handbook-first detail reading. Original JSONL browsing, proprietary memory citations, and automatic note writing are omitted. Read-only detail tools and usage reporting are separate follow-up work.
