# Upstream Sources

This project adapts material from upstream repositories, pinned to exact commits per `docs/spec/pi-memory-spec-v0.1.0.md` §2. Every vendored file is recorded below with its upstream repository, commit, path, SHA-256 content hash, local destination, and adaptation status.

The fenced JSON block at the bottom is the machine-readable manifest verified by `scripts/verify-upstream.mjs` (run: `node scripts/verify-upstream.mjs`). Keep the table and the JSON in sync — edit both, then run the verifier.

## Vendored files

All files below come from `openai/codex` at commit `1cc7e2361237ce7244430ee1d581c77f95c57ac8` and are stored **verbatim** (no edits). Adaptations never touch `prompts/upstream/`; adapted copies live under `prompts/pi/<version>/` with a reviewed change log entry here.

| Local destination | Upstream path | Purpose |
|---|---|---|
| `prompts/upstream/v1/stage_one_system.md` | `codex-rs/memories/write/templates/memories/stage_one_system.md` | v1 phase-1 extraction system prompt |
| `prompts/upstream/v1/stage_one_input.md` | `codex-rs/memories/write/templates/memories/stage_one_input.md` | v1 phase-1 extraction input renderer |
| `prompts/upstream/v1/consolidation.md` | `codex-rs/memories/write/templates/memories/consolidation.md` | v1 phase-2 consolidation prompt |
| `prompts/upstream/v1/read_path.md` | `codex-rs/ext/memories/templates/memories/read_path.md` | v1 read-path guidance |
| `prompts/upstream/v2/stage_one_system_v2.md` | `codex-rs/memories/write/templates/memories/stage_one_system_v2.md` | v2 phase-1 extraction system prompt |
| `prompts/upstream/v2/stage_one_input_v2.md` | `codex-rs/memories/write/templates/memories/stage_one_input_v2.md` | v2 phase-1 extraction input renderer |
| `prompts/upstream/v2/consolidation_v2.md` | `codex-rs/memories/write/templates/memories/consolidation_v2.md` | v2 phase-2 consolidation prompt |
| `prompts/upstream/v2/read_path_v2.md` | `codex-rs/ext/memories/templates/memories/read_path_v2.md` | v2 read-path guidance |
| `prompts/upstream/LICENSE.codex` | `LICENSE` | Apache-2.0 license covering the vendored Codex material |

## Adaptation log

All vendored files remain byte-identical to upstream (verify with the script).

| Source | Adaptation | Changes |
|---|---|---|
| `prompts/upstream/v1/consolidation.md` | Runtime renderer in `src/pipeline/consolidate.ts` plus `prompts/pi/v1/consolidation-boundaries.md` | Private workspace/diff placeholders; read-only shared notes; five custom workspace tools in place of shell/original-rollout access; Pi source/session identifiers; task applicability; literal summary marker; headings and length as guidance; minimal project/date grouping; ordinary citations; prose-only procedures; one bounded host-validation repair. |
| `prompts/upstream/v1/read_path.md` | `prompts/pi/v1/read_path.md` | Concise Pi guidance with version/generation/workspace/applicability and bounded summary; historical evidence label; handbook-first progressive reading; no original JSONL browsing, proprietary citation wrapper, or automatic note writing. |
| `prompts/upstream/v2/consolidation_v2.md` | Runtime renderer in `src/pipeline/consolidate.ts` plus `prompts/pi/v2/consolidation-boundaries.md` | Private workspace/diff placeholders; read-only selected evidence and scoped shared notes; four tools and summary-only writes; Pi session/source identifiers replace thread IDs; minimal project/date grouping (child topics inherit scope); exact source routes as guidance; no v1 raw memories, handbook or procedures; strict summary byte cap and one bounded validation repair. |
| `prompts/upstream/v2/read_path_v2.md` | `prompts/pi/v2/read_path.md` | Version/generation/workspace applicability and bounded summary; historical-evidence labeling; direct rollout-summary routes; ordinary citations; no handbook lookup or original transcript browsing. |

Revision 3 removes prose-reference/ID/anchor, per-bullet citation, handbook-field and heading-order hard gates. The one repair is reserved for repairable format/grouping failures; host integrity remains fail-closed. Strict Codex JSON Schema is supplied via Pi for extraction without changing upstream templates.

Detailed adaptation notes live in `prompts/pi/v1/CHANGELOG.md` and `prompts/pi/v2/CHANGELOG.md`. The shared renderer substitutes Pi session identifiers in both runtime templates; its revision participates in the content-based writer hash.

## License

The vendored Codex material is Apache-2.0 (see `prompts/upstream/LICENSE.codex`). Attribution is preserved in `NOTICE`. This project is not an official OpenAI or pi product.

## Manifest

```json
{
  "manifestVersion": 1,
  "sources": [
    {
      "repository": "openai/codex",
      "commit": "1cc7e2361237ce7244430ee1d581c77f95c57ac8",
      "upstreamPath": "codex-rs/memories/write/templates/memories/stage_one_system.md",
      "sha256": "cf795e8a2f5f52d333af2613bf1ff79178112f5fd2161cc181a8ddf52e59da33",
      "localPath": "prompts/upstream/v1/stage_one_system.md",
      "description": "v1 phase-1 extraction system prompt (verbatim)"
    },
    {
      "repository": "openai/codex",
      "commit": "1cc7e2361237ce7244430ee1d581c77f95c57ac8",
      "upstreamPath": "codex-rs/memories/write/templates/memories/stage_one_input.md",
      "sha256": "2e54c74909238022305c269c862910bb29509fda8b58ce671ef011f8d6453047",
      "localPath": "prompts/upstream/v1/stage_one_input.md",
      "description": "v1 phase-1 extraction input renderer (verbatim)"
    },
    {
      "repository": "openai/codex",
      "commit": "1cc7e2361237ce7244430ee1d581c77f95c57ac8",
      "upstreamPath": "codex-rs/memories/write/templates/memories/consolidation.md",
      "sha256": "1450e24f84c03375aa5114c6c0857f515395129dcc00f65263221d03866852a0",
      "localPath": "prompts/upstream/v1/consolidation.md",
      "description": "v1 phase-2 consolidation prompt (verbatim)"
    },
    {
      "repository": "openai/codex",
      "commit": "1cc7e2361237ce7244430ee1d581c77f95c57ac8",
      "upstreamPath": "codex-rs/ext/memories/templates/memories/read_path.md",
      "sha256": "2bc7736029884b714860a6f0d6b2fd26598bba58f2213b787f01fe2a491f4326",
      "localPath": "prompts/upstream/v1/read_path.md",
      "description": "v1 read-path guidance (verbatim)"
    },
    {
      "repository": "openai/codex",
      "commit": "1cc7e2361237ce7244430ee1d581c77f95c57ac8",
      "upstreamPath": "codex-rs/memories/write/templates/memories/stage_one_system_v2.md",
      "sha256": "334c0d51a2c63bd317dac074155fb3ecf0a56af8b00657736bab9c74222372b4",
      "localPath": "prompts/upstream/v2/stage_one_system_v2.md",
      "description": "v2 phase-1 extraction system prompt (verbatim)"
    },
    {
      "repository": "openai/codex",
      "commit": "1cc7e2361237ce7244430ee1d581c77f95c57ac8",
      "upstreamPath": "codex-rs/memories/write/templates/memories/stage_one_input_v2.md",
      "sha256": "8fd4bb25fe6bd746b2d46ad841ac3a195d220c3da0cb9230615e2347c6ef853e",
      "localPath": "prompts/upstream/v2/stage_one_input_v2.md",
      "description": "v2 phase-1 extraction input renderer (verbatim)"
    },
    {
      "repository": "openai/codex",
      "commit": "1cc7e2361237ce7244430ee1d581c77f95c57ac8",
      "upstreamPath": "codex-rs/memories/write/templates/memories/consolidation_v2.md",
      "sha256": "7334fdb4aa5d958bcff54568a375d0b0145c19a611a1a22faa6bf251a46a5f0e",
      "localPath": "prompts/upstream/v2/consolidation_v2.md",
      "description": "v2 phase-2 consolidation prompt (verbatim)"
    },
    {
      "repository": "openai/codex",
      "commit": "1cc7e2361237ce7244430ee1d581c77f95c57ac8",
      "upstreamPath": "codex-rs/ext/memories/templates/memories/read_path_v2.md",
      "sha256": "2f81fa2e89f341a1b7b3cf11ee7b855087c4ab84ddad920980475465ef28ff27",
      "localPath": "prompts/upstream/v2/read_path_v2.md",
      "description": "v2 read-path guidance (verbatim)"
    },
    {
      "repository": "openai/codex",
      "commit": "1cc7e2361237ce7244430ee1d581c77f95c57ac8",
      "upstreamPath": "LICENSE",
      "sha256": "d17f227e4df5da1600391338865ce0f3055211760a36688f816941d58232d8dc",
      "localPath": "prompts/upstream/LICENSE.codex",
      "description": "Apache-2.0 license covering vendored Codex material (verbatim)"
    }
  ]
}
```
