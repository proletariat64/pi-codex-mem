# Forgetting and clearing

`/memory forget source <source-id>` resolves the ID to its branch lineage and suppresses every revision, including later captures. `/memory forget session <session-key>` suppresses all current and future branches of that session. Schema 11 stores durable lineage/session tombstones. Live capture and explicit historical import check them before writing snapshots and again under the SQLite writer lock.

The transaction commits suppression, a new shared control epoch, revocation of both generated views and fences for obsolete extraction/consolidation jobs before cleanup. Extension-owned affected snapshots and extraction text are removed with secure deletion and WAL truncation. Revoked generations and staging are cleaned; failed cleanup is reported and retried, while revoked views remain unservable. Enabled versions independently rebuild from remaining evidence without old generated inputs. Provider failure never restores deleted guidance.

`/memory forget note <note-id>` retains its note-specific consequence explanation. Semantic requests require concrete source/session IDs or a correction; keyword erasure is not guaranteed. Commands explain that original pi transcripts, external backups, provider-side retention and in-flight model context are outside extension deletion.

`/memory clear --confirm` first persists disabled capture, reading and generation, cancels local jobs, and creates a fsynced restart marker. It then clears shared state and removes both version namespaces, sources, notes and SQLite files. The disabled configuration remains. If a SQLite reader prevents secure WAL cleanup, deletion stays pending and memory stays disabled; startup retries after contention clears. Re-enabling memory is a separate explicit action and is refused while cleanup is pending. A corrupt/unavailable store is preserved for recovery.

A missing original transcript is not a forget request. Already extracted memory remains eligible and readable under ordinary retention; retrieval items carry `sourceUnavailable: true` for unavailable original evidence. No tombstone is inferred from a missing file. Vendored upstream prompts are unchanged.
