# Failure and concurrency verification

Memory failures must leave Pi usable and preserve a complete published generation. The following checks use temporary Git repositories, real session JSONL files, and `node:sqlite`; model and Pi extension boundaries are simulated without paid provider requests.

| Failure | Required behavior | Regression evidence |
| --- | --- | --- |
| Publication process exits before/after file fsync, before/after rename, after parent-directory fsync, or before/after SQLite CAS | Read only the complete old or new generation; remove unreferenced staging and generations after the abandoned lease expires | `tests/publication.test.ts`: seven child-process exit boundaries for each version, followed by restart and orphan cleanup |
| Two processes compete over one store | One accepted extraction for the same revision/version/prompt and one consolidation publisher; the losing process cannot publish | `tests/process-concurrency.test.ts`: two live Node workers with IPC barriers, real extraction jobs, SQLite leases and publication CAS, for both versions |
| Writer holds SQLite beyond its busy timeout | Skip capture with a diagnostic; foreground events continue; capture can recover after unlocking; shutdown and reload stop every owned task and close handles even if cancellation cleanup fails | `tests/failure-lifecycle.test.ts`: real writer transactions around capture, shutdown and reload, including an in-flight consolidation provider request |
| Corrupt SQLite file | Disable store use, report the failure, preserve bytes and never recreate the file automatically | `tests/failure-lifecycle.test.ts`: corrupt-file startup and foreground lifecycle, for both versions |
| Provider retry follows `agent_end` | Do not capture the intermediate end; capture the final branch only at `agent_settled` | `tests/failure-lifecycle.test.ts`: two end events before final settlement |
| Another extension forces a full system prompt | Preserve the replacement and other sections; remove the memory section and its reader pin; diagnose `section_injection_conflict` | `tests/failure-lifecycle.test.ts`: overrides before and after memory's handler, for both versions |
| Ephemeral session | Report `ephemeral`; no capture, model request, state database or implicit configuration creation, including explicit generation commands | `tests/failure-lifecycle.test.ts`: fresh and already configured roots |
| `off` or `read` flag | No capture or generation; original JSONL remains unchanged | `tests/failure-lifecycle.test.ts`: full lifecycle and explicit run attempts |
| Disk full during publication fsync | Keep the old published pointer; clean abandoned artifacts; allow a later successful publication | `tests/publication.test.ts`: injected `ENOSPC` and recovery, for both versions |
| Disk full during configuration update | Preserve the prior configuration; return a diagnostic instead of rejecting a Pi event or command; continue reading a valid generation | `tests/failure-lifecycle.test.ts`: injected `ENOSPC` during model-default persistence and version switching |
| Disk full during initial configuration creation | Report the storage error, disable generation and keep startup usable without capture or model requests | `tests/failure-lifecycle.test.ts`: injected `ENOSPC` at mkdir, temporary-file write and fsync |
| Budget exhausted after a spent request | Retain spent attempts and conservative charges; defer without another paid request | `tests/extraction-runner.test.ts` and `tests/consolidation-agent.test.ts` |
| Hostile transcript, late provider completion or cancellation | Restricted tools cannot execute shell/read original transcripts; expired or cancelled work cannot write or publish | `tests/consolidation-agent.test.ts`, `tests/workspace-tools.test.ts`, `tests/extraction-runner.test.ts` and `tests/publication.test.ts` |

Run the full suite with `node --test --test-concurrency=1 'tests/**/*.test.mjs' 'tests/**/*.test.ts'`, followed by `npm run typecheck`, `npm run verify-upstream`, and the isolated Pi RPC smoke check. Serial execution avoids competing global environment changes and keeps child-process fixtures predictable.

Process-exit and injected-I/O checks verify the application protocol. They do not emulate a physical power loss or certify the durability guarantees of a particular filesystem. The concurrency workers exercise the real memory pipeline while simulating the Pi/model interfaces; the separate RPC smoke check verifies extension loading in the actual Pi CLI.
