# Request-local memory: full-system override UAT

## Acceptance result

The original conflict was reproduced in the actual Pi interactive CLI/TUI before checking the implementation. On the same host and same fixtures, the old extension visibly warned and lost memory; the new extension did neither. This is not an `ExtensionRunner`-only simulation.

| Memory version | Extension order | Independent runs per implementation | Old: visible conflict warning | Old: requests containing memory | New: visible conflict warning | New: requests containing memory |
|---|---|---:|---:|---:|---:|---:|
| v1 | override → memory | 3 | 3/3 | 0/6 | 0/3 | 6/6 |
| v1 | memory → override | 3 | 3/3 | 0/6 | 0/3 | 6/6 |
| v2 | override → memory | 3 | 3/3 | 0/6 | 0/3 | 6/6 |
| v2 | memory → override | 3 | 3/3 | 0/6 | 0/3 | 6/6 |

Total: **24 successful real TUI sessions, 48 model requests**. Every process exited normally with code 0. Each new request contained exactly one owned memory carrier. Full effective tool declarations—not only tool names—were identical across all old/new requests. The forced system text remained exactly `UAT_EXACT_FORCED_POLICY`.

## Fixed inputs and method

- Old pi-memory: `00c2219e8453ef6f2568fd107f2474281b4c4591`, archived unchanged from Git.
- New pi-memory: `6cdf2d14234d586ef88c516e0f7965900d018c42`.
- Same installed Pi host: 0.99.2, Node 24.15.0. No host upgrade between the old/new runs; these versions are evidence, not deployment requirements.
- Actual `dist/cli.js` under a PTY, with `ctx.hasUI === true` and `ctx.mode === "tui"` recorded by the loaded fixture extension.
- One ordinary extension returns a complete forced system prompt. It does not emit or suppress the memory conflict warning. The old warning is produced by the unchanged old pi-memory code:

```text
pi-memory: section_injection_conflict — another extension forced a full system prompt; memory injection disabled for this run
```

- A valid isolated published generation contains `UAT_MEMORY_SENTINEL`. Artifact hashes match between old/new within each memory version. Readability is independently checked, so losing memory cannot be attributed to an absent or invalid store.
- A deterministic offline provider records the actual effective request context/payload received through Pi's provider path and returns valid assistant events. It does not fabricate memory content or warning output.
- Each session submits two real user prompts, runs `/memory status`, and exits through the TUI keyboard path.
- Network is isolated with `unshare -Urn`. Each run has its own `HOME` and `PI_CODING_AGENT_DIR`; only the empty fixture workspace is trusted, for that session only. Live user settings, auth, permission extensions and Pi core are not modified.

## Evidence and repeat commands

The temporary harness and complete raw evidence are retained locally under `tmp/request-local/uat/`, intentionally not shipped as extension code:

- `drive.py`: actual CLI/PTY driver and acceptance assertions.
- `offline-force.ts`: full-prompt override plus deterministic provider fixture.
- `seed.mjs`: isolated generation setup and readability preflight.
- `summarize.mjs` / `results.json`: selected valid run matrix and cross-run assertions.
- Each case directory contains `command.json`, `terminal.raw`, decoded `terminal.txt`, full `trace.jsonl`, and `result.json`.

The driver invocation used for a case was:

```bash
python3 tmp/request-local/uat/drive.py old v1 override-first 2
python3 tmp/request-local/uat/drive.py new v1 override-first 1
node tmp/request-local/uat/summarize.mjs
```

Use a fresh repetition number when rerunning, to preserve existing evidence and avoid reseeding an existing generation. The selected matrix uses old v1 override-first repetitions 2–4, old v1 memory-first 1–3, new v1 both orders 1–3, and v2 both implementations/orders 4–6.

Evidence digests:

- Shared full tool-declaration SHA-256: `c28a617c740bd5a9d00bccba9f6d8aff4c3f15e7434845cfbff6d892bc1478d8`.
- Override/provider fixture SHA-256: `2a7ad9bf1d52e2dede01f987812b4dd69bf9818b14fc68251ea4001f405ecba7`.

## Excluded attempts and limits

The first harness attempt stopped at Pi's project-trust dialog before any request. The driver was corrected to select session-only trust for the isolated fixture directory. An initial v2 seed lacked the required preferences heading; that seed was corrected and readability preflight added. Those attempts are preserved but excluded from the acceptance matrix. No product code or assertion was weakened to make the matrix pass.

This UAT verifies the original full-system-override conflict class using an ordinary override fixture. It is not a claim that every third-party permission plugin was tested, that an actual LLM semantically followed the memory, or that provider cancellation has a universal zero-send guarantee. The separately accepted provider cancellation/send race remains unchanged.
