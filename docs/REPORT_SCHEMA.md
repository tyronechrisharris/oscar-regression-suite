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
`target` is the exact public event UUID where applicable; `observed` records
normalized source paths, OSH camera UIDs, metadata, manifest/frame counts,
exact-ledger results, or run-scoped orphan/partial totals. Reviewers can
therefore correlate the UUID-bound MP4 with its exact-five representation
without depending on PostgreSQL table details.
For an unfiltered full run without `STORAGE_RETAINED_EVENT_ID`, the early
storage-health row is `skipped` with an explicit self-seeding reason; the later
storage-lifecycle rows for that generated UUID are the authoritative API,
decode, manifest, ledger, and Viewer-gallery proof. A missing generated event is
reported as `incorrect`, so deferral cannot hide absent coverage.

## `performance.csv`

| Column | Meaning |
| --- | --- |
| `phase` | scenario active when sampled |
| `source` | `test-runner`, `oscar-container`, or `oscar-host` |
| `target` | process, container name, or host |
| `cpuPercent` | sampled process/container CPU percentage |
| `memoryUsedBytes`, `memoryLimitBytes`, `memoryPercent` | memory values |
| `pids`, `restartCount`, `oomKilled` | container/process health |
| `load1m`, `hostMemoryAvailableBytes` | host pressure indicators |
| `note` | sampling context |

Docker CPU can exceed 100% because 100% represents one fully utilized logical
CPU. Compare like-for-like runs on the same CPU allocation and inspect the time
series by phase rather than treating a single spike as a regression.

## `summary.csv`

`section=correctness` rows contain `total`, `correct`, `incorrect`, `skipped`,
and `accuracyPercent` for `all`, each `category:...`, `scenario:...`, and
`action:<scenario>/<action>` group. The action rows directly answer questions
such as correct versus incorrect tamper resolution. `section=performance` rows
contain sample count and peak/average CPU and memory for each source/target.

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
budgets. Missing requested remote metrics, container OOM kills, and restart-count
increases are gating correctness checks.

## `storage-performance.csv`

Each row is a point-in-time storage snapshot keyed by `runId`, `timestamp`, and
`phase`. Database/table/index/WAL/temp sizes are bytes. Tuple and transaction
counters come from PostgreSQL statistics. `observationInsertCalls`,
`observationInsertRows`, and `observationRowsPerCall` expose whether batched
ingest remains effective. Archive generation/row/byte, failure, parity, hold,
verified-backup, journal, daily-file, retained-media, and backup-size fields
support like-for-like release comparisons; an empty cell means unavailable.

`run.json` schema version 2 records `storageWorkflow`,
`storageBackupWorkflow`, release-directory identity, and retained/legacy media
fixture identities. It never records the storage acknowledgement or secrets.
