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
Generation counts/rows and object bytes are aggregated in separate catalog CTEs
so a generation with multiple objects cannot multiply its row/count totals;
incomplete-object failures are counted once per affected active/sealed generation.

For 3.9.2, `STORAGE_WORKFLOW` defaults to `required`. The exact release-identity
gate resolves Compose images and requires `oscar:3.9.2`,
`oscar-postgis:3.9.2`, and
`nginxinc/nginx-unprivileged:1.28.1-alpine`; compares each running container's
immutable image ID with the selected local image ID; records repository digests
when present; requires application/PostGIS OCI version labels and the PostGIS
storage-profile label; and verifies both `.env` and `.env.example` say `3.9.2`.
It also requires the checksum marker to be a regular file containing exactly the
four v1 fields (`format`, `version`, `data_checksums`, and `initialized_at`) with
the 3.9.2 values. The probe binds the lowercase `OSCAR_DEPLOYMENT_ID` to all
three administrator-owned `.oscar-storage-root` v1 markers, requires exactly
the eight identity/adoption fields and the correct `archive`, `wal-archive`, or
`backup` kind, and checks the settled root/marker owners and modes.

The same preflight requires the OS-default stable lock
(`/run/lock/oscar-storage/<deployment-id>.lock` on Linux), private root ownership,
and a nonblocking concurrency rejection while the probe holds that lock. It
hash-compares the packaged and running `/usr/local/bin/oscar-archive-wal`,
`/usr/local/bin/oscar-archive-object`, `/usr/local/bin/oscar-prepare-restore`,
and `/usr/local/bin/oscar-merge-wal-restore` regular executables, requires
`archive_mode=on`, and compares PostgreSQL's setting to the exact command
`/usr/local/bin/oscar-archive-wal "%p" "%f" /var/lib/postgresql/wal-archive`.
The compiled `/usr/local/bin/oscar-atomic-publish` has a different binary hash
from its C source, so the image carries a root-owned regular source-provenance
stamp instead. The gate compares that stamp with the packaged
`docker/oscar/atomic-publish.c`, then behavior-tests a successful directory
publication and a destination collision. The collision must preserve both the
challenger source and the previously published destination byte-for-byte.
The platform gate also inspects both running containers and refuses a full backup-root mount at
either `/var/lib/oscar/backups` or `/var/lib/postgresql/backups`. It requires the packaged backup
flow to use the running database's network namespace while mounting only the fresh `postgres/`
staging directory and exact bootstrap-password file into the one-shot base-backup client.
The packaged WAL helper must byte-compare an existing name and publish a
flushed temporary inode through an atomic, no-replace hard link, followed by
file and directory durability barriers.
It also requires the packaged storage CLI to route portable-export copies and
purge deletions through the archive-object helper; the acknowledged lifecycle
then exercises both CLI paths against its registered generation.

The platform gate also fail-closes on the live JVM temporary-directory split.
It first requires the packaged entrypoint to be the exact executable deployed in
the container and verifies that its managed properties follow `JAVA_OPTS`.
`/tmp` must remain a read/write `tmpfs` with `noexec,nosuid,nodev`, while the
only native-library exception is a separate read/write `tmpfs` mounted at
`/run/oscar-native` without `noexec`, owned by UID/GID 10001 with mode `0700`,
and capped at exactly 256 MiB. The probe executes a private copied binary from
that mount to prove the kernel permits native loading, then removes it. It
inspects the running Java process rather than trusting environment text: the
last/effective `-Djava.io.tmpdir` must be `/run/oscar-native`, JavaCPP's
last/effective cache must be `/run/oscar-native/javacpp`, and the last/effective
`-Doscar.data.tmpdir` must be `/tmp`. This keeps DuckDB/JNI and JavaCPP/FFmpeg
extraction functional without leaving an executable cache in persistent state
or moving untrusted multipart or Cambio staging onto the executable mount. A
missing mount, wrong ownership/mode/cap, changed
mount option, extra Java process, or overridden effective property rejects the
release identity before the lifecycle creates any fixture.

A locally built/offline-loaded image may legitimately have no repository digest;
its immutable image ID and required OCI labels remain the gate. Set `auto` only
for an explicit legacy run with no storage target configured; it is not the
3.9.2 release gate.

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

The disposable configuration must also set these fields in the
existing OSCAR service `videoRetentionConfig` before OSCAR starts:

```json
{
  "timeToRetention": 0,
  "videoQueryPeriod": 1,
  "enableFrameRetention": true,
  "frameRetentionCount": 5,
  "jpegQuality": 85,
  "sourceRollbackGraceHours": 24
}
```

This is regression-only acceleration: zero days makes alarms from the current
run eligible on the next one-minute query, while 24 hours keeps each exact source
MP4 available for the end-of-run ownership/decodability oracle. Preserve all
other `videoRetentionConfig` fields. Full-profile preflight reads the persisted live
config and requires all six values before retained-media polling or cold-fixture
creation, so a normal seven-day deployment fails early instead of timing out.
Do not change the packaged default; use `timeToRetention=7` in production.
The platform preflight also requires the archive purge helper to read from
`/dev/null`; this proves that a helper invoked inside the work-list loop cannot
consume subsequent rows and leave a multi-object purge plan partially applied.

The probe registers exactly two observations copied from an existing
`gammaCounts` row: one beyond hot retention and one current. A temporary,
run-scoped PostgreSQL statement trigger inspects the writer's temporary
activation ledger, and an advisory-lock barrier pauses only the statement that
exported the fixture cold row; the probe changes that row's result
time, releases the barrier, and requires the stale activation to fail with no
archive marker. The trigger/function are always removed. It then requires the
real retry to mark exactly that one current source row (matching generation
count/min/max), leave the hot control unmarked, and obtain a parity receipt.

Because `obs.id` has no database sequence, these direct-SQL fixtures use a
singleton allocator row to serialize a collision-checked test-only `BIGINT`
lease more than 2^40 IDs beyond the durable hot/archive high-water and fail
atomically if either candidate is no longer free. The archived fixture keeps
the larger leased ID so a restart can
advance the store's durable high-water even after ordinary fixture-row cleanup.
This deliberate side effect is another reason `storage-lifecycle` is restricted
to a fresh, disposable database and must never run against a production store.

It verifies a self-contained export,
accelerates only that registered generation's grace timestamp, proves the cold
row remains API-queryable alongside the hot row, and then tests hold
create/list/release plus dry-run/token purge. Before purge it queries the frozen
plan and aborts/deletes that plan unless exactly one item exists and it is the
registered fixture generation. A wrong token must leave the plan unchanged;
the valid one must leave object deletion states, ledger entries, and a
tombstone. Cleanup deletes only registered hot rows and retains catalog audit
evidence.

While the generation is active, the lifecycle invokes the deployed application
archive-object helper against a cataloged object: verified copy must preserve
the catalog hash, while a wrong hash and traversal path must fail. It also uses
a run-derived, collision-checked synthetic PostgreSQL history filename to prove
the deployed WAL helper's first publication, byte-identical retry, and
different-byte rejection. The exact synthetic final/temporary files are removed
in the action's trap. These mutations run only inside the separately acknowledged
disposable lifecycle; `storage-health` never publishes synthetic WAL or changes
archive rows.

## Daily files and retained media

Daily publication is a rotation boundary behavior. Keep the canonical 50-lane
fixture running across a local-midnight boundary before a 3.9.2 release gate.
The smoke check requires published CSV/manifest pairs and no partial artifacts;
archive health also rejects `*.partial`, `*.partial.*`, `*.tmp`, and `*.tmp.*`
artifacts anywhere below the external archive or WAL roots. The full run restarts
OSCAR and rejects recovery errors or partial publications, then repeats the
archive/WAL partial scan after helper, export, and purge coverage.
Do not fabricate or rename production daily files for this test.

For smoke/read-only validation, provide `STORAGE_RETAINED_EVENT_ID` for an alarm
already reduced to the new format. An unfiltered full run does not need a
pre-existing retained event: its early storage-health pass explicitly defers
this one proof, generates exact alarm UUIDs, and runs the same gallery proof
after their accelerated retention. A scenario-filtered full run that omits
either `storage-lifecycle` or every alarm-producing scenario must still provide
`STORAGE_RETAINED_EVENT_ID` when `storage-health` is selected. Every camera set
must expose exactly FIRST, QUARTER, MIDDLE,
THREE_QUARTERS, and LAST at quality 85 as independently decodable,
size/hash-valid JPEGs, and
the response must remain within the Viewer's per-frame and event-wide byte/pixel
budgets. The oracle performs a bounded linear marker/segment parse and rejects
progressive, lossless, arithmetic, multi-scan, malformed-length, truncated, and
trailing-data payloads. It then fetches and decodes every frame independently in
Chromium and requires decoded dimensions to match the authenticated manifest;
component coverage also proves catalog and frame bodies stop at their streaming
byte limits. The Viewer must render five choices per camera, initially request only
one selected frame per camera through its shared concurrency limiter, and fetch
another frame only after the operator selects it. The browser probe delays frame
responses to measure at most three requests in flight, then requires the newly
selected frame to load, decode, and replace the initial image. Optionally provide
`STORAGE_LEGACY_EVENT_ID` to prove a retained-media 404 still renders the legacy
video. `STORAGE_EVENT_NODE_ID` is included in Event Details links when needed.

The full profile additionally tests every gamma/neutron alarm it generates; it
does not rely on `STORAGE_RETAINED_EVENT_ID` for this path. The exact generated
UUID remains in run state through retention, and one of those UUIDs must also
pass the Event Details five-choice lazy-gallery and three-request concurrency
proof after its source-bound manifests and JPEGs validate. Failure to generate
an event after the early proof was deferred is an explicit incorrect result,
not a silent skip. Before the first
trigger, the target probe writes a private no-replace baseline of finalized MP4
and partial/temp clip names across the videos bucket. Camera relationships come
from the reserved lane's Viewer components and authenticated OSH systems
catalog—emulator `camera_ids` are opaque stream IDs and are never used as OSCAR
camera identities.

For each selected Event Log row, the suite resolves the exact Event Details UUID
and fetches that exact observation. `result.videoPaths` must contain exactly one
nonblank unique path per configured lane camera, in normalized form
`videos/clips/<camera-UID-with-colons-replaced>/<yyyy-MM-dd_HH-mm-ss_SSS>-g<positive-generation>.mp4`.
Each camera token must own its path. The target requires every source to be a
regular, non-symlink, nonzero object, and Chromium must load positive MP4
duration and dimensions.

After the accelerated cycle, each exact event UUID must return one retained
manifest per source camera. Its `source.objectKey` must equal the already
validated observation path, and its five quality-85 JPEGs must still pass size,
hash, baseline-structure, dimension, and Chromium decode checks. The exact
event/lane/camera `.job.json` ledger must be `PUBLISHED` or `SOURCE_DELETED`,
have `attempts=1`, and have no failure. Finally, the probe derives only the
authoritative camera tokens from this run's paths and compares those directories
with the pre-trigger baseline: all expected sources are accounted for, with no
additional finalized MP4 or new partial/temp artifact. Historical failures and
partials present before the run therefore do not falsely fail the gate. The
marker is removed after comparison and through the validated privileged failure
cleanup path.

## Backup and performance

The backup check creates a coordinated backup and then invokes the supported
`backup-verify` command again. It requires regular, non-symlink `VERIFIED`,
`JOURNAL_CONFIRMED`, `SHA256SUMS`, `SHA256SUMS.hmac`, `epoch.json`,
`image-inventory.txt`, and `archive-generation-ids.txt` files. The immutable backup core is authenticated by
`SHA256SUMS.hmac`; `JOURNAL_CONFIRMED` is deliberately excluded from that core
inventory because it is published only after verification. Instead, its exact
five-line v2 payload has a separate HMAC that binds the backup ID and exact
authenticated OSCAR-state checksum. The check requires both HMACs to verify;
an exact backup ID, UUID, `oscar-backup-epoch` v1/`CREATED` identity and 3.9.2
release; a bounded, canonically sorted, duplicate-free backup-time archive-generation
UUID inventory covered exactly once by the authenticated manifest; the matching
live VERIFIED catalog epoch with exact array equality to that inventory; and count retention. It also
requires at least one daily-journal confirmation receipt bound to the new backup
ID and authenticated `oscar-state.tar.gz` SHA-256, with a non-empty sealed-segment
inventory. Receipts authorize deletion only when their relative path and SHA-256
are members of the backup's atomically published confirmation-set marker; partial
receipt writes without that marker fail closed. This means an overnight
publication/rotation fixture is a prerequisite for the complete gate. The
lifecycle check explicitly does not restore. Set
`STORAGE_BACKUP_WORKFLOW=disabled` only when backup duration/capacity is outside
the current run; do not call that a complete 3.9.2 storage release gate.

## Isolated destructive restore drill

Restore coverage is never part of `smoke`, `full`, `storage-health`, or
`storage-lifecycle`. Use a separate disposable deployment with no production
data, review its absolute release/archive/WAL/backup paths, and set all existing
target/storage acknowledgements plus these exact restore-specific values. The
three paths must be the canonical paths resolved from the target `.env`; they
must be distinct and must not contain one another:

```text
OSCAR_RESTORE_TARGET_ACK=<viewer-host>|<user@ssh-host>|<release-dir>|ISOLATED-RESTORE
OSCAR_RESTORE_DISPOSABLE_ACK=<host>:DISPOSABLE-NO-PRODUCTION-DATA
OSCAR_RESTORE_DATA_LOSS_ACK=I-ACCEPT-DESTRUCTIVE-RESTORE
OSCAR_RESTORE_ARCHIVE_DIR=<canonical-archive-directory>
OSCAR_RESTORE_WAL_ARCHIVE_DIR=<canonical-wal-archive-directory>
OSCAR_RESTORE_BACKUP_DIR=<canonical-backup-directory>
OSCAR_RESTORE_PATHS_ACK=<archive>|<wal-archive>|<backup>|DEDICATED-RESTORE-PATHS
```

Then, and only then, run `npm run test:restore-drill`. The profile accepts no
ordinary scenario and uses a separate local target/release lock. Before mutation
it requires the exact 3.9.2 image/marker gate. The target-side helper creates
unique pre-backup canaries in PostgreSQL, OSCAR application state, the external
cold archive, `.env`, secrets, and TLS, plus real switched WAL fingerprints before
and after the backup; creates and re-verifies a
coordinated backup; mutates every canary; and calls only the supported
`oscar.sh restore --backup ID --confirm ID` interface. Acceptance requires all
pre-backup values, promotion onto a timeline newer than the base backup, an archived
timeline-history file and new-timeline WAL segment, byte-identical preservation of
the fingerprinted backup-era and divergent post-backup source-timeline WAL, no
post-start archiver failure, cleanup of the
one-time recovery settings/signals, exact reconstruction of the authenticated
`VERIFIED` epoch receipt, healthy app/PostGIS/gateway containers, archive verification,
and unchanged immutable running image IDs after restore. Scoped canaries are
removed after verification. The verified drill backup and OSCAR's mode-0700
`pre-restore-ID` safety directory remain intentionally. The latter contains
plaintext pre-restore `.env`, secrets, and TLS material; record and restrict it,
then remove it under the disposable site's approved retention policy.

If restore fails after services stop, do not improvise deletion. Preserve the
probe logs in `/tmp`, the backup, and any `pre-restore-ID` directory; use the
documented OSCAR recovery procedure on that isolated target.

## Clean-directory upgrade qualification

This suite does not claim a clean-directory upgrade without both the exact
previous-release artifact and a separately provisioned upgrade target. For the
3.9.2 release gate, perform a distinct upgrade qualification starting from a
supported prior version: create and verify that release's supported backup or
export (the coordinated `oscar-storage` backup CLI begins with 3.9.2), extract
3.9.2 into a new empty directory, and copy only `.env`, `secrets/`, and `tls/`.
Before leaving the prior release, record a unique application/database canary
and the immutable `CreatedAt` value for both `oscar_oscar_state` and
`oscar_postgres_data`.

The first upgrade attempt must omit legacy-volume adoption and fail closed on
the unlabelled pre-3.9.2 volumes without starting or recreating services. After
confirming that both volumes belong to this deployment, rerun with
`sudo bash oscar.sh upgrade --adopt-legacy-volumes` on POSIX or
`oscar.bat upgrade -AdoptLegacyVolumes` on Windows. The migration may add
`OSCAR_BACKUP_KEY_FILE=./secrets/backup-key.txt` only when that key is completely
absent from a pre-3.9.2 `.env`; a custom value, duplicate key, or missing key in
a current-release environment must still fail strict validation. Require the
canonical binding exactly once after success, then verify that the normalized
external archive/WAL/backup paths are absolute and resolve outside the versioned
release directory.

Acceptance also requires a mode-restricted `.oscar-volume-adoption` receipt
bound to both recorded volume creation identities. Copy that receipt along with
`.env`, `secrets/`, and `tls/` on every later clean-directory upgrade. Verify
that both Docker volume `CreatedAt` values and the application/database canary
remain unchanged, then run required smoke/full/storage coverage. Record old/new
artifact hashes, image IDs, and the complete failed-plus-successful upgrade
transcript. Do not overlay new managed files on the old release directory.
Automating this remaining check requires those prior and new artifact paths to
be supplied explicitly; the ordinary regression target does not contain enough
evidence to synthesize them safely.

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
