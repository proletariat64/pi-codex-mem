# Snapshot storage after compression: incremental deferred

Status: measurement note, decided 2026-11-10.

## What changed already

Snapshots are gzip-compressed (`src/store/snapshot-files.ts`), with the recorded
`snapshot_hash` covering the decoded JSON text. Existing plaintext files were
rewritten in place: 207 MB to 55 MB, 845 files, hashes verified before every
replace.

A revision still carries the whole branch, so total snapshot space is quadratic
in session length. Compression only lowers the constant.

## Measured cost after compression

Live store at 2026-11-10, 863 snapshot files, 57.0 MB total:

| status | files | MB | median size |
|---|---|---|---|
| captured | 146 | 4.7 | 4.7 KB |
| superseded | 717 | 52.4 | 86.8 KB |

At roughly 20 new revisions per day the store grows about 1.7 MB/day, so the
512 MiB `limits.maxStoreBytes` cap is roughly 300 days away, and the store is
small enough that pruning and retention policies are not needed.

## Decision

Defer incremental or content-addressed snapshots. The remaining win is bounded
(~57 MB to an estimated ~10 MB of unique item text), while a delta or item-pool
format requires rewriting every envelope read: capture's revocation scan, the
extraction runner's integrity check, historical import, generation selection and
privacy cleanup. Revisit only if the measured growth once again approaches the
cap, or a session routinely exceeds a few hundred revisions.

## Superseded-snapshot alternatives (not taken)

- Age-based pruning of superseded snapshots: cheapest space, but narrows the
  revocation scan's coverage. Missing snapshots stay fail-closed, so text never
  leaks, yet the store loses the ability to prove which revisions held removed
  text.
- Item pool keyed by content hash: largest win, largest change.
