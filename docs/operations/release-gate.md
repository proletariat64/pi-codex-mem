# Release gate record — v0.1.0 (spec §19.3)

> Historical record for the earlier implementation. These measurements and sign-off do not certify revision 4 request-local projection, its recent-host capability checks, or the pre-send cancellation gate. See the current failure matrix and request-local verification record for new results and limitations. The subsequent [request-local override UAT](request-local-uat.md) separately records stable old-warning reproduction and the new implementation's fix in 24 actual TUI sessions.

Recorded for the §18/§19.3 ready-to-release checklist. Environment note: measurements ran on the development host (4 vCPU, 7.6 GiB RAM, SSD, Node 24.15.0, pi 0.87.1), not the 2-vCPU/4-GB reference host; numbers are single-host samples, not cross-device claims.

## Checklist

| § | Item | Status | Evidence |
|---|---|---|---|
| 19.3 | T01–T38 behavioral matrix | pass | `npm run test:behavioral` — 60/60, 0 missing |
| 19.3 | Real pi TUI, both versions | pass | 2026-09-30 smoke: `pi install` → `/memory import --run` → `/memory run --now --version both` → "published, published"; v1 and v2 answers grounded in injected memory (TypeScript decision, scope, revisit condition) |
| 19.3 | Version switching + dual-write | pass | `/memory version v2` mid-session; status showed both versions published; v2 answer routed to rollout summary |
| 19.3 | Read-only noninteractive path, both versions | pass | `pi -p --no-session` answered from injected memory; 3/3 stable; v1 (before switch) and v2 (after) both verified |
| 19.3 | Install preserves unrelated settings | pass | Agent-dir settings snapshot: install added only `packages: [repo]`; remove emptied exactly that list; `lastChangelogVersion`, `theme`, `tuiMode`, `subagents`, `compaction`, `httpProxy` byte-identical |
| 19.3 | Uninstall leaves data intact | pass | After `pi remove`: `state.sqlite`, 5 generations, 5 summaries, `config.json` all present; no `clear` used |
| 19.3 | No credentials in generated/log fixtures | pass | `rg` scan for `sk-` keys, `Bearer` tokens, and api-key/password patterns over the smoke store and evaluation stores: zero hits; evaluation output directories contain no copied `auth.json`/key files (auth always flowed through pi's registry) |
| 19.3 | Provenance and licenses | pass | `npm run verify-upstream` — 9 vendored files byte-identical; MIT + NOTICE + UPSTREAM.md adaptation log |
| 19.2 | Semantic targets | pass (1 rep) | 30 cases × 4 modes × 1 rep, user-adjudicated: v1 30/30 grounded, 10/10 decision+rationale, 5/5 abstention, 0 critical fabrication; v2 29/29 grounded, 9/9, 5/5, 0; one transport failure auto-missed per the no-replacement rule; total ≈ $0.46 |
| 18 | Performance gates | pass | Table below |

## §18 measurements (against the smoke store, both versions)

| Gate | v1 p95 | v2 p95 | Budget | Result |
|---|---:|---:|---:|---|
| Cached prompt-section prep | 0.0 ms | 0.0 ms | 20 ms | pass |
| State/view refresh | 0.5 ms | 0.4 ms | 100 ms | pass |
| Search + read (first page + detail) | 3.1 ms | 1.8 ms | 250 ms | pass |
| Checkpoint hook (capture, 12-message synthetic session) | 12.2 ms | — | 100 ms target | pass |
| Shutdown cleanup (WAL checkpoint + close) | 4.2 ms | — | 500 ms | pass |
| Steady-state memory (peak RSS with vs without extension) | +77.7 MiB | | <100 MiB | pass |

Method notes and exceptions:

- Measurements use the real published smoke generation (single source session). The spec's 256-source reference scale was **not** constructed; the read path is a single-generation view with bounded SQLite queries, so latency depends on summary size (≤ 10 KB) rather than source count, but the 256-source figure remains an unexecuted scenario. Recorded as an exception, not a claim.
- RSS measured as `/usr/bin/time -v` max resident size of `pi -p` with the package installed and enabled vs `--no-extensions`, same prompt/model; single-sample method.
- Checkpoint measured on a synthetic 12-message session through `captureSettledSession` (50 iterations); large sessions yield asynchronously per spec.
- One transient read-path injection loss was observed in `pi -p` while the TUI held the store; it was silent by design (fail open). It is now surfaced as a `readDiagnostic` via `/memory doctor` instead of remaining invisible. 3/3 subsequent runs were stable.

## Credential and privacy scan

`rg` scans over the smoke store and all evaluation output directories found no credential material (`sk-` keys, bearer tokens, api-key/password strings) in any store file, summary, or trace; evaluation directories contain zero copied `auth.json`/key files. The N05 fixture's private phrase appears in that case's pre-forget evidence mirrors as designed — the post-publication forget revoked the reader view and both generated versions answered with zero injection and no disclosure (verified in the semantic run).

## Sign-off

Behavioral matrix real-model TUI + read-only paths, switching/dual-write, performance gates, privacy semantics, provenance, and the semantic evaluation meet the operator-accepted target (30 × 4 × 1, single adjudicated repetition). Ready to ship as v0.1.0.