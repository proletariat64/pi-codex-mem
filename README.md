# pi-memory

Persistent cross-session memory for [pi](https://github.com/earendil-works/pi-coding-agent), adapted from Codex CLI's memory pipeline. Both memory versions are built in:

- **v1** — task-group handbooks (`MEMORY.md`) plus a compact summary injected into later sessions.
- **v2** — summary-first layout with project/date routes directly to staged rollout evidence; no handbook layer.

Spoken decisions, rationale, and failures from past sessions become a small, validated, evidence-linked memory that is re-injected on later runs with the same answering model — no retraining, no external service.

## Installation

Requires Node >= 22.19.0 and pi >= 0.87.1. Install from a local checkout:

```sh
pi install /path/to/pi-codex-mem
```

The store lives under the pi agent directory in `memory/` (`config.json`, `state.sqlite`, `versions/`). Credentials are never copied into the store; all model traffic goes through pi's model registry under your normal authentication. Removing the package never touches memory data:

```sh
pi remove /path/to/pi-codex-mem   # data stays in <agent-dir>/memory
```

## Model configuration

Memory generation uses two model roles — `extract` and `consolidate` — resolved through pi's registry. Configure them once in `memory/config.json`:

```json
{ "models": {
    "extract":      { "provider": "openai-codex", "modelId": "gpt-6-luna" },
    "consolidate":  { "provider": "openai-codex", "modelId": "gpt-6-luna" } } }
```

Host API credentials, model catalogs, and quotas are pi's; nothing is hardcoded. A missing role is filled with the foreground model at the next capture, but explicit roles make generation reproducible.

## Modes

- **Runtime mode** (`--pi-memory-mode off`, `read`, or `read-write`; or `enabled`/`read`/`generate` in config): `off` disables everything, `read` serves published memory without generating, `read-write` is the default.
- **Version selection**: `version: v1 | v2` in config. Switching versions never inherits the other version's context; each version publishes its own generations, and reading follows the selected version only.
- **Dual writing** (`dualWrite: true`): keeps both versions published from the same evidence with separate jobs, budgets, and validity. Reading still uses the selected version.

Generation runs when pi is idle; schedules, byte budgets, and daily token/request caps are in config (sane defaults, all changeable).

## `/memory` commands

| Command | Effect |
|---|---|
| `/memory status` | Selected version, per-version pipeline state, model roles, capture state |
| `/memory doctor` | Host compatibility, store integrity, injection diagnostics |
| `/memory import <file> --dry-run` or `--run` `[--leaf ID]` | Import a historical session JSONL read-only (branching files need an explicit leaf) |
| `/memory run [--version v1]`, `v2`, or `both`, plus `[--now]` | Trigger extraction/consolidation outside the idle window |
| `/memory remember <text>` | Save a workspace-scoped note for the next consolidation |
| `/memory correct <text>` | Same, marked as a correction; revokes the current run's read pin until republished |
| `/memory forget note|source|session <id>` | Revoke one item immediately; readers stop seeing it |
| `/memory version v1` or `v2` | Persist the selected version |
| `/memory dual-write on|off` | Persist dual-write |
| `/memory clear --confirm` | Erase all memory data; capture and generation stay disabled until you re-enable them |

During a run, published memory is injected as a `pi_memory` system-prompt section, and the `pi_memory_search` / `pi_memory_read` / `pi_memory_list` tools expose detail evidence. Tools never expose shell or arbitrary file access; every artifact is validated before publication (revision 3 contract).

## Deletion and privacy semantics

- Forgetting a note/source/session revokes it for readers immediately, even before on-disk cleanup; corrupted or partially cleaned stores stay unavailable rather than serving revoked data.
- `clear --confirm` erases and disables; nothing is recoverable afterward.
- Source transcripts stay in your pi sessions; the memory store additionally mirrors only normalized evidence under `memory/`. Secrets are scanned before publication (best-effort, not a guarantee).
- Removing the package or disabling generation leaves all data and your other pi settings untouched.

## Limitations

- Quality is bounded by the configured models; the release gate evaluated gpt-6-luna (see `docs/operations/release-gate.md`).
- PROMPT-section injection is skipped (diagnosed via `/memory doctor`) when the context is nearly exhausted or another extension forces a full system prompt.
- No sync, no Bun-binary pi, no additional backends in v0.1.0.
- English and Chinese are exercised; no claim about other languages.

## Development

```sh
npm run typecheck        # tsc --noEmit
npm run test             # unit + lifecycle tests (serial)
npm run test:behavioral  # T01-T38 state-machine matrix
npm run verify-upstream  # vendored Codex prompt provenance
```

See `docs/spec/pi-memory-spec-v0.1.0.md` for the full contract, `eval/` for the semantic gate, and `docs/operations/` for runbooks.