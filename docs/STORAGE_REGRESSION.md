# OSCAR 3.9.2 storage regression

This suite validates the durable-storage redesign introduced for OSCAR 3.9.2.
It is not a production maintenance utility. Run mutation coverage only against
an emulator-backed deployment with a fresh/disposable PostgreSQL database and
external archive/WAL/backup paths dedicated to that deployment.

## Profiles and interlocks

`storage-health` is the read-only smoke scenario. It checks data checksums,
`pg_stat_statements`, storage schema v4, the initialization marker, JDBC batch
rewrite, journal configuration, archive catalog health and object hashes,
daily-file publication state, retained JPEGs, Viewer gallery/fallback behavior,
and a point-in-time storage/resource snapshot.

`storage-lifecycle` is a full-profile scenario. In addition to the ordinary
OSCAR/emulator acknowledgements, it requires:

```text
OSCAR_RELEASE_DIR=/absolute/path/to/disposable/release
OSCAR_STORAGE_TARGET_ACK=<OSCAR_BASE_URL host>:<OSCAR_RELEASE_DIR>:DISPOSABLE-STORAGE
```

The target must use the regression-only accelerated archive profile:
`intervalMinutes=1`, `rollbackGraceDays=1`, `deleteHotAfterArchive=true`, while
the configured hot-retention value must match `STORAGE_HOT_RETENTION_DAYS`.
Never use those acceleration settings as the production retention policy.

The probe registers exactly two observations copied from an existing
`gammaCounts` row: one beyond hot retention and one current. It waits for the
real archive writer and parity receipt, verifies a self-contained export,
accelerates only that registered generation's grace timestamp, proves the cold
row remains API-queryable alongside the hot row, and then tests hold
create/list/release plus dry-run/token purge. Before purge it queries the frozen
plan and aborts/deletes that plan unless exactly one item exists and it is the
registered fixture generation. A wrong token must leave the plan unchanged;
the valid one must leave object deletion states, ledger entries, and a
tombstone. Cleanup deletes only registered hot rows and retains catalog audit
evidence.

## Daily files and retained media

Daily publication is a rotation boundary behavior. Keep the canonical 50-lane
fixture running across a local-midnight boundary before a 3.9.2 release gate.
The smoke check requires published CSV/manifest pairs and no partial artifacts;
the full run restarts OSCAR and rejects recovery errors or partial publications.
Do not fabricate or rename production daily files for this test.

Provide `STORAGE_RETAINED_EVENT_ID` for an alarm already reduced to the new
format. Every camera set must expose exactly FIRST, QUARTER, MIDDLE,
THREE_QUARTERS, and LAST as independently decodable, size/hash-valid JPEGs, and
the Viewer must render five thumbnails per camera. Optionally provide
`STORAGE_LEGACY_EVENT_ID` to prove a retained-media 404 still renders the legacy
video. `STORAGE_EVENT_NODE_ID` is included in Event Details links when needed.

## Backup and performance

The backup check creates a coordinated backup, relies on automatic SHA-256 and
`pg_verifybackup` verification, checks the VERIFIED catalog epoch and configured
count retention, and explicitly does not restore. Coordinate destructive restore
drills separately on another isolated deployment. Set
`STORAGE_BACKUP_WORKFLOW=disabled` only when backup duration/capacity is outside
the current run; do not call that a complete 3.9.2 storage release gate.

Compare `storage-performance.csv` between equivalent lane counts, traffic,
retention windows, and run durations. Review table/index/WAL/temp growth,
rows-per-insert-call, archive and backup bytes, failed jobs/parity receipts,
holds, journal/media size, container CPU/memory/OOM/restarts, and free disk.
Thresholds belong in site release policy; this suite reports the raw evidence.

## Recovery

The copied probe lives under `/tmp` and is removed in `finally`. If a run is
interrupted, stop further mutation, query `oscar_regression_fixture` by run ID,
review its exact IDs and generation, release only holds whose reason starts
`regression-`, and use the supported OSCAR archive commands. Never remove a
cataloged archive object directly. Preserve the run bundle and classify the
failure before retrying.
