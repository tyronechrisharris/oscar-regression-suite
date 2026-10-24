# Report schema

All CSV files use RFC 4180-style quoting, UTF-8, a header row, and one record per
line. Empty cells represent unavailable or inapplicable values, not zero.

## `functional-results.csv`

| Column | Meaning |
| --- | --- |
| `runId`, `timestamp` | stable run ID and UTC observation time |
| `scenario`, `category`, `action` | test grouping and behavior |
| `target` | lane, route, service, or control under test |
| `expected`, `observed` | oracle and actual outcome |
| `status` | `correct`, `incorrect`, or `skipped` |
| `durationMs` | elapsed check time |
| `evidence` | path relative to the run directory |
| `error` | concise exception/error text, with known secrets redacted |

Correct-versus-incorrect ratios such as resolved tamper checks are obtained by
filtering `category`/`action` and counting `status`. `summary.csv` also provides
ready-to-chart totals by category.

Generated media checks use `category=alarm-media` or `retained-media`. Their
`target` is the exact public observation ID where applicable. Viewer calls this
field “Event UUID”, but the value is an opaque normalized 1–128-character OSH
identity and need not be RFC 4122-shaped. `observed` records
normalized source paths, OSH camera UIDs, metadata, manifest/frame counts,
exact-ledger results, or run-scoped orphan/partial totals. Reviewers can
therefore correlate the identity-bound MP4 with its exact-five representation
without depending on PostgreSQL table details.
For an unfiltered full run without `STORAGE_RETAINED_EVENT_ID`, the early
storage-health row is `skipped` with an explicit self-seeding reason; the later
storage-lifecycle rows for that generated public observation ID are the authoritative API,
decode, manifest, ledger, and Viewer-gallery proof. A missing generated event is
reported as `incorrect`, so deferral cannot hide absent coverage.
For `category=daily-file`, `observed` also records the configured zone, current
date, eligible-prior-day count, current-day segment counts/bytes, and integrity
failures. `publication not yet eligible` is a correct result only when there is
no completed configured-zone day and the current-day durable segment oracle
passes; otherwise exact published CSV/manifest pairs are mandatory.

## `performance.csv`

| Column | Meaning |
| --- | --- |
| `phase` | scenario active when sampled |
| `source` | `test-runner`, `test-runner-host`, `oscar-container`, or `oscar-host` |
| `target` | process, container name, or the exact configured `OSCAR_SSH_TARGET` for `oscar-host` rows |
| `composeService` | exact `gateway`, `oscar`, or `postgres` service for OSCAR container rows |
| `containerId` | full Docker container identity; a change identifies recreation |
| `containerState`, `containerHealth` | Docker state and health at the sample time |
| `containerStatsAvailable` | whether a running container produced a Docker resource sample |
| `cpuPercent` | sampled process/container CPU percentage |
| `memoryUsedBytes`, `memoryLimitBytes`, `memoryPercent` | memory values |
| `pids`, `restartCount`, `oomKilled` | container/process health |
| `load1m`, `hostMemoryAvailableBytes` | host pressure indicators |
| `note` | sampling context |

Docker CPU can exceed 100% because 100% represents one fully utilized logical
CPU. Compare like-for-like runs on the same CPU allocation and inspect the time
series by phase rather than treating a single spike as a regression.

Remote discovery is restricted to Compose project `oscar` and the exact
`gateway`, `oscar`, and `postgres` service labels. It uses all-state Docker
discovery, so stopped containers are recorded instead of disappearing from the
report. A missing service is represented by a service row with empty identity
and state fields and `containerStatsAvailable=false`. The sampler requests an
immediate remote snapshot when each scenario phase is registered and records
the same missing rows if the SSH snapshot itself fails.

## `summary.csv`

`section=correctness` rows contain `total`, `correct`, `incorrect`, `skipped`,
and `accuracyPercent` for `all`, each `category:...`, `scenario:...`, and
`action:<scenario>/<action>` group. The action rows directly answer questions
such as correct versus incorrect tamper resolution. `section=performance` rows
contain sample count and peak/average CPU and memory for each source/target.
Container aggregates are separated by Compose service and full container ID so
recreated containers are not blended. `averageCpuPercent` and
`averageMemoryBytes` are unweighted arithmetic means of the available non-null
point-in-time samples; they are not time-weighted. `total` remains the number of
rows in the group, including rows whose particular CPU or memory value is
unavailable.

## `errors.csv`

Contains runtime observations that may or may not correspond to a failed
functional assertion: `scenario`, `source`, `severity`, `message`, and evidence.
Warnings do not change the exit code by themselves; incorrect functional checks
do. An `error`-severity runtime record fails the run even when a DOM assertion
otherwise passed.

## Narrative and metadata

`summary.md` is the operator-facing concise report. `run.json` contains schema
version, status, timestamps, duration, counts, and canonical file names for
downstream automation. Its run metadata records `eventUuidWorkflow` and
`alarmTransferCameraWorkflow` so reviewers can distinguish auto-detected legacy
skips from required UUID and deterministic camera-scanning release gates. It
also records `operationalViewWorkflow` and the resolved
`oscarLaneConfigPath`. When that workflow is enabled, it records
`oscarLaneConfigSha256` and `operationalViewLaneCounts`, identifying and
fingerprinting the exact membership oracle used by scoped view checks.

CPU and memory peaks are observational unless an external release policy applies
budgets. When remote metrics are requested, every registered run phase must
contain exact `gateway`, `oscar`, and `postgres` service coverage. Missing or
incomplete samples, stopped or unhealthy containers, OOM kills, restart-count
changes, disappearance, multiple identities, and recreation are gating
correctness checks. Unrelated Docker containers cannot satisfy this coverage.

## `storage-performance.csv`

Each row is a point-in-time storage snapshot keyed by `runId`, `timestamp`, and
`phase`. Database/table/index/WAL/temp sizes are bytes. Tuple and transaction
counters come from PostgreSQL statistics. `observationInsertCalls`,
`observationInsertRows`, and `observationRowsPerCall` expose whether batched
ingest remains effective. `observationDeleteCalls`, `observationDeleteRows`,
`observationRowsPerDeleteCall`, `legacySingletonObservationDeleteCalls`,
`batchedObservationDeleteCalls`, `batchedObservationDeleteRows`, and
`batchedObservationRowsPerDeleteCall` distinguish the retired one-row delete
path from the guarded set-based purge. `statementTempBlocksWritten` exposes
database-scoped temporary query I/O. Archive generation/row/byte, failure, parity, hold,
verified-backup, journal, daily-file, retained-media, and backup-size fields
support like-for-like release comparisons. Retained-media metadata reclamation
is reported separately as `retainedMediaManifestFiles`,
`retainedMediaJpegFiles`, `processedObservationIndexFiles`,
`processedObservationIndexBytes`, `deletionIndexFiles`, `deletionIndexBytes`,
`legacyProcessedMarkerFiles`, `legacyDeletionTombstones`, and
`mediaMetadataCheckpointBytes`. These expose compact-index growth and make a
reappearance of per-event legacy metadata visible; an empty cell means
unavailable.

`run.json` schema version 2 records `storageWorkflow`,
`storageBackupWorkflow`, the exact expected `storageBackupMode`, release-directory
identity, and retained/legacy media fixture identities. A single-mode
`3.9.2-release` run also records the validated restore evidence directory,
restore run ID, and backup ID; disabled mode has no restore evidence. A successful restore drill
records its structured backup/canary/image/safety-copy certification, which the
release profile must match to the current suite commit, build label, Viewer URL,
and release directory. It never records the storage acknowledgement or secrets.
