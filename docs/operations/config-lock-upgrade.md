# Upgrading the configuration control lock

The configuration writer now uses a short SQLite `BEGIN IMMEDIATE` transaction on `<pi-agent-dir>/memory/state.sqlite`. A killed process releases that transaction automatically. New versions do **not** create `config.json.lock`.

A prior version may have left a `config.json.lock` file or directory. The new writer **will not delete it automatically**: a concurrently running old Pi process could replace that path between an ownership check and deletion, causing lost config updates.

Before upgrading:

1. Stop **all** Pi sessions using this memory root (TUI, RPC, JSON, print, and background agents), including old-version processes. Verify they have exited. Do not run old and new versions against the same root simultaneously.
2. Locate the root using Pi's agent directory (`PI_CODING_AGENT_DIR` when set; otherwise Pi's default agent directory), then inspect `<agent-dir>/memory/config.json.lock`.
3. **Only after step 1**, manually remove that specific legacy lock file or directory. For a directory, remove its `owner` file first and then the empty directory. Do not delete `config.json`, `state.sqlite`, snapshots, or the memory root.
4. Restart Pi. If the path still exists, configuration creation/updates fail closed and `/memory status` explains the upgrade precondition. Existing configuration is preserved.

A corrupt or inaccessible `state.sqlite` likewise disables configuration writes with a diagnostic; the file is preserved for recovery, never automatically recreated. This procedure is a one-time legacy migration, not a recovery step for new SQLite-held locks.
