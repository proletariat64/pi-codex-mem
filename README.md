# pi-memory

Persistent cross-session memory for [pi](https://github.com/earendil-works/pi-coding-agent), adapted from Codex CLI's memory pipeline. Both memory versions are built in:

- **v1** — task-group handbooks (`MEMORY.md`) plus a compact summary injected into later sessions.
- **v2** — summary-first layout with project/date routes directly to staged rollout evidence; no handbook layer.

Spoken decisions, rationale, and failures from past sessions become a small, validated, evidence-linked memory that is re-injected on later runs with the same answering model — no retraining, no external service.

## Installation

Requires Node >= 22.19.0 and a recent Pi host with the required lifecycle, request-projection and cancellation capabilities. Pi versions are not pinned or checked against an exact allowlist; unsupported capabilities are diagnosed without falling back to system-section injection. Install from a local checkout:

```sh
pi install /path/to/pi-codex-mem
```

The store lives under the pi agent directory in `memory/` (`config.json`, `state.sqlite`, `versions/`). Credentials are never copied into the store; all model traffic goes through pi's model registry under your normal authentication. Removing the package never touches memory data:

```sh
pi remove /path/to/pi-codex-mem   # data stays in <agent-dir>/memory
```

## Model configuration

Memory generation uses two model roles — `extract` and `consolidate` — resolved through pi's registry. On first run, memory generates a complete `memory/config.json` with defaults. Edit its `models` field to pin both roles (the JSON below is that field, not a complete config file — replacing the whole file with it fails validation and disables memory):

```json
"models": {
  "extract":     { "provider": "openai-codex", "modelId": "gpt-6-luna" },
  "consolidate": { "provider": "openai-codex", "modelId": "gpt-6-luna" }
}
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
| `/memory status` | Selected memory readability, separate extraction/consolidation state, publication, notes, local budget waits |
| `/memory doctor` | Environment health separately from persistent memory availability and recovery blockers |
| `/memory import <file> --dry-run` or `--run` `[--leaf ID]` | Import a historical session JSONL read-only (branching files need an explicit leaf) |
| `/memory run [--version v1]`, `v2`, or `both`, plus `[--now]` | Queue extraction/consolidation; `--now` skips idle waiting, not budget admission |
| `/memory remember <text>` | Save a workspace-scoped note for the next consolidation |
| `/memory correct <text>` | Same, marked as a correction; revokes the current run's read pin until republished |
| `/memory forget note|source|session <id>` | Revoke one item immediately; readers stop seeing it |
| `/memory version v1` or `v2` | Persist the selected version |
| `/memory dual-write on|off` | Persist dual-write |
| `/memory clear --confirm` | Erase all memory data; capture and generation stay disabled until you re-enable them |

During a foreground run, published memory is projected as one request-local `pi_memory` custom carrier immediately after the leading system message. Full system-prompt overrides remain unchanged; the carrier is not appended to canonical history or supplied directly to capture/compaction. Its summary uses a 2,500-token policy and the complete carrier must also fit the remaining request capacity after non-memory input and output reservation. When no matching tokenizer is available, UTF-8 bytes are conservative estimated upper units, not exact provider token counts.

The `pi_memory_search` / `pi_memory_read` / `pi_memory_list` tools expose detail evidence from the same run pin. Budget-only carrier omission does not revoke retrieval; privacy, read-disable, epoch and integrity failures revoke both pin and cached content. Tools never expose shell or arbitrary file access; publication and reading retain the revision 3 artifact contract.

## Deletion and privacy semantics

- Forgetting a note/source/session revokes it for readers immediately, even before on-disk cleanup; corrupted or partially cleaned stores stay unavailable rather than serving revoked data.
- `clear --confirm` erases and disables; nothing is recoverable afterward.
- Source transcripts stay in your pi sessions; the memory store additionally mirrors only normalized evidence under `memory/`. Secrets are scanned before publication (best-effort, not a guarantee).
- Removing the package or disabling generation leaves all data and your other pi settings untouched.

## Limitations

- Quality is bounded by the configured models; the release gate evaluated gpt-6-luna (see `docs/operations/release-gate.md`).
- Full system-prompt overrides do not disable memory. Insufficient request capacity clips, minimizes or omits the request-local carrier; `/memory status` and `/memory doctor` report the representation and local reason counts without warning spam.
- Provider cancellation is best-effort: on the exercised Pi host, a reused Codex WebSocket can still send after `ctx.abort()` at the pre-provider hook. This is an accepted host limitation, not a release blocker or a reason to disable Codex foreground reading. Validity checks and safe stale-carrier removal remain active; no instantaneous zero-send guarantee is claimed.
- Already admitted/sent memory and assistant quotations cannot be erased by client-side revocation. Direct carrier persistence is prevented; zero indirect recirculation is not guaranteed.
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