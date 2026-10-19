# OSCAR 3.9.2 storage regression

This suite validates the durable-storage redesign introduced for OSCAR 3.9.2.
It is not a production maintenance utility. Run mutation coverage only against
an emulator-backed deployment with a fresh/disposable PostgreSQL database and
external archive/WAL/backup paths dedicated to that deployment.

## Profiles and interlocks

`storage-health` is non-destructive but not strictly read-only: its atomic-
publisher proof creates and removes private temporary data, so the host-wide
remote suite lease covers the whole invocation. It checks data checksums,
`pg_stat_statements`, storage schema v5 with checksum
`sha256:b37753a17c972d57418545c05a2544068affc7804b8622db3a0f0c4b422c63b5`,
the initialization marker, JDBC batch rewrite, exact journal and bounded DuckDB
configuration, archive catalog health and object hashes, daily-file publication
state, retained JPEG/metadata health, Viewer gallery/fallback behavior, and a
point-in-time storage/resource snapshot. The same exact v5/checksum gate runs
before and after the isolated restore drill.
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

The persisted live config must be the regular, non-symlink
`/var/lib/oscar/config.json` and no larger than 16 MiB. Structural JSON extraction
requires exactly one expected daily-file, OSCAR, and system-database module and
rejects decoys, duplicate modules, duplicate selected/nested keys, and JSON type
mismatches. No line-oriented text match may supply a value. `useBatch=true` is
necessary but not sufficient: `pg_stat_statements` must show a multi-values
`obs` INSERT with affected rows greater than calls, proving effective runtime
batch rewriting. The gate requires the
archive resource policy exactly: 256 MiB DuckDB memory, two threads, 4,096 MiB
maximum spill, at most two process-wide concurrent sessions with a 30-second
admission timeout, and `/var/lib/oscar/duckdb-tmp`. That scratch root may be absent
before first use; once used it must be a real archive-disjoint directory owned
by UID/GID 10001, mode `0700`, with no remaining per-operation entries. The
full lifecycle checks it after export, parity, cold query/count, and hot-delete
work. A backup must exclude `duckdb-tmp` entirely.

The suite gates the persisted two-session/30-second admission controls but does
not intentionally hold native queries open for 30 seconds to saturate them.
Fair-wait, timeout, and permit-recovery timing remain product integration tests;
the release E2E gate proves exact configuration and that completed operations
leave no scratch directories behind.

The exact daily-file production profile is `rootDirectory=files`,
`journalDirectory=.dailyfile-journal`, `publicationDirectory=dailyfiles`, UTC,
`dailyFileObservationMode=LATEST`, `fsyncIntervalMillis=1000`,
`maxUnforcedRecords=128`, `maxUnforcedBytes=1048576`,
`maxSegmentBytes=67108864`, `maxSegmentAgeSeconds=900`,
`maxRecordBytes=4194304`, and `sealedJournalRetentionDays=30`. The OSCAR service
must also set `delegateObservationLifecycleToDatabase=true` and
`dailyFilePurgeWorkLimit=50`.

A locally built/offline-loaded image may legitimately have no repository digest;
its immutable image ID and required OCI labels remain the gate. Set `auto` only
for an explicit legacy run with no storage target configured; it is not the
3.9.2 release gate.

`storage-lifecycle` is a full-profile scenario. In addition to the ordinary
OSCAR/emulator acknowledgements, it requires:

```text
OSCAR_SSH_TARGET=<user@ssh-host>
OSCAR_RELEASE_DIR=/absolute/path/to/disposable/release
OSCAR_STORAGE_TARGET_ACK=<viewer-host>|<user@ssh-host>|<remotely-canonical-release-dir>|DISPOSABLE-STORAGE
```

This exact binding applies to every storage probe, including smoke/non-lifecycle
`storage-health`, not only the mutating lifecycle. Before any remote mutation or
probe upload, the runner resolves the release directory on the named SSH target
and refuses a missing, root, symlinked, or non-canonical path, or a missing,
linked, or non-regular `oscar.sh`. The exact Viewer host, SSH target, and
canonical release path are rechecked before every probe action. Probe files and
command captures use a fresh mode-0700 private workspace with mode-0600 files.

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
  "sourceRollbackGraceHours": 24,
  "metadataReclamationWorkLimit": 200
}
```

This is regression-only acceleration: zero days makes alarms from the current
run eligible on the next one-minute query, while 24 hours keeps each exact source
MP4 available for the end-of-run ownership/decodability oracle. Preserve all
other `videoRetentionConfig` fields. Full-profile preflight reads the persisted live
config and requires all seven values before retained-media polling or cold-fixture
creation, so a normal seven-day deployment fails early instead of timing out.
Do not change the packaged default; use `timeToRetention=7` in production.
Saving the form does not reconfigure an already running retained-media worker.
Use the supported OSCAR restart, then require `retention-runtime-health` to
observe a valid schema-1 durable scan checkpoint within 180 seconds of the
zero-day eligible cutoff. If a disposable, newly initialized target was
accidentally started under the seven-day default, stop OSCAR and reset only the
fresh retention scan/reconciliation checkpoints before any recordings or
retained-media jobs exist, then restart. Production checkpoints are durable
history and must never be deleted or fast-forwarded.
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
row remains API-queryable alongside the hot row, and tests all live hold
resolutions. A generation hold must resolve to `GENERATION_EXACT`; an archived
observation hold must resolve to `COLD_RANGE_CONSERVATIVE`; and the still-hot
control row must resolve to `HOT_EXACT`. The generation and cold-observation
holds must each be visible in the operator list and cause a deletion dry run to
report one held generation with zero plan items. While `HOT_EXACT` is active,
an authenticated observation DELETE must fail and a GET must still succeed;
after release the same DELETE must succeed and GET must return 404. The CLI is
never allowed to create `LEGACY_UNKNOWN`. Schema v5 retains that fourth value
only for observation holds migrated from pre-v5 catalogs; migrated generation
holds must be normalized to `GENERATION_EXACT`.

Portable export uses the supported coordinated storage command and therefore
briefly stops and restarts OSCAR to freeze a consistent copy. The confirmed
tokenized purge follows the same consistency boundary. The suite records every
raw resource sample but labels only these exact windows
`storage-lifecycle-export-disruption` and
`storage-lifecycle-purge-disruption`; they are excluded from steady-state
service-availability assertions only in `full` and `3.9.2-release`. Healthy
post-export/post-purge samples, immutable image identity, and zero OOM kills
remain mandatory. Compose one-off command containers are not OSCAR services and
are excluded from service inventory and resource aggregates.

This live lifecycle runs the required accelerated archive-enabled profile. It
does not rewrite/restart the target into an archive-disabled profile merely to
repeat `HOT_EXACT` deletion enforcement; that separate configuration is covered
by product integration tests and remains an environment-specific E2E acceptance
item if a release policy requires it.

It then tests hold release plus dry-run/token purge. Before purge it queries the frozen
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

Daily publication is a configured-zone rotation-boundary behavior; it is not
eligible while only the current calendar day exists. The probe validates the
exact two-key schema-1 journal metadata, derives “today” in its persisted zone,
and counts completed lane/day directories. When at least one prior day is
eligible (or any publication artifact exists), the gate still requires one or
more exact validated CSV/manifest pairs. When no prior day is eligible and no
publication artifact exists, that is reported explicitly as
`publication not yet eligible` and passes only if current-day lane directories
contain nonempty regular six-digit `.open`/`.seg` files with the exact 16-byte
minimum and `DJNL` v1 magic/version header. Unsafe layout, future-day entries,
links, partials, or a missing current-day segment still fail. A release gate
therefore does not require waiting through midnight merely to fabricate data.

Keep the canonical 50-lane fixture running across a configured-zone midnight
when published-file coverage is specifically desired. Once that boundary is
present, the not-yet-eligible branch is unavailable. The smoke check bounds the
publication/journal inventory to 100,000 entries, rejects links and every
`.partial*`/`.tmp*` spelling, and requires every regular flat
`{lane-suffix}-{12-hex-full-UID-hash}_{configured-zone-date}.csv` to have an
exact 12-key v1 `OSCAR_LEGACY_DAILY_CSV` manifest no larger than 1 MiB.
Lane/window/zone/filename/timestamp fields and current SHA-256, byte, and record
counts must agree. The lifecycle also toggles the reserved emulator RPM,
derives the journal directory from the full canonical lane UID, and requires
that lane's direct
`{lane-directory}/{configured-zone-date}/{six-digit}.open|seg` bytes to
advance. Those bytes and safe layout
must survive the supported whole-deployment launcher restart. That restart also
closes the current metrics sample before entering the restart-exempt phase, so
an in-flight pre-restart CPU interval cannot be mislabeled as steady-state
load. It requires the retention worker to cancel and drain its scoped PostGIS
query before OSCAR reports a successful bounded stop, and requires PostgreSQL
to remain available through that shutdown: the
post-start log window must contain no `BasicEventHandler`, transaction-handler,
database-purger, module-timeout, PostgreSQL administrator-termination, camera
command timeout/quarantine, recording-result timeout, queue rejection, or
stale-generation failure. The full profile also records an exact log boundary
before its back-to-back one-second gamma/neutron occupancies and applies the
same camera-recording gate after both generation-qualified MP4s have loaded.
This is evidence of direct live journal capture,
not a renamed or fabricated publication.

A `.partial` journal path may exist momentarily while an atomic rotation is in
progress. `storage-health` polls for a clean atomic boundary for up to 30
seconds; a partial that persists beyond that window, or any unsafe entry, still
fails the release gate. The restart proof inventories all captured segments
before shutdown and requires every one—not merely the first stdin row—to retain
its exact prefix afterward.

The smoke check requires either eligible published CSV/manifest pairs or the
strict durable-current-day state described above, and no partial artifacts;
archive health also rejects `*.partial`, `*.partial.*`, `*.tmp`, and `*.tmp.*`
artifacts anywhere below the external archive or WAL roots. The full run uses the
supported launcher to restart gateway, OSCAR, and PostgreSQL in dependency order
and rejects shutdown/recovery errors or partial publications, then repeats the
archive/WAL partial scan after helper, export, and purge coverage.
Do not fabricate or rename production daily files for this test.

For smoke/non-lifecycle validation, provide `STORAGE_RETAINED_EVENT_ID` for an alarm
already reduced to the new format. An unfiltered full run does not need a
pre-existing retained event: its early storage-health pass explicitly defers
this one proof, generates exact public observation IDs, and runs the same
gallery proof after their accelerated retention. A scenario-filtered full run that omits
either `storage-lifecycle` or every alarm-producing scenario must still provide
`STORAGE_RETAINED_EVENT_ID` when `storage-health` is selected. Every camera set
must expose exactly FIRST, QUARTER, MIDDLE,
THREE_QUARTERS, and LAST at quality 85 as independently decodable,
size/hash-valid JPEGs, and
the response must remain within the Viewer's per-frame and event-wide byte/pixel
budgets. The oracle performs a bounded linear marker/segment parse and rejects
progressive, lossless, arithmetic, multi-scan, malformed-length, truncated, and
trailing-data payloads. It then fetches and decodes every frame independently in
Chromium and requires decoded dimensions to match the authenticated manifest.
The network reader aborts before buffering beyond the 4 MiB catalog cap or the
manifest-declared per-frame cap. The Viewer must render five choices per camera, initially request only
one selected frame per camera through its shared concurrency limiter, and fetch
another frame only after the operator selects it. The browser probe delays frame
responses to measure at most three requests in flight, then requires the newly
selected frame to load, decode, and replace the initial image. Optionally provide
`STORAGE_LEGACY_EVENT_ID` to prove a retained-media 404 still renders the legacy
video. `STORAGE_EVENT_NODE_ID` is included in Event Details links when needed.
Both event variables carry OSCAR's durable public OSH observation ID. The Viewer
labels it “Event UUID”, but the encoded ID is opaque, normalized to 1–128
characters, and is not required to use RFC 4122 punctuation. The suite compares
the exact string across the observation API, Event Details, retained endpoint,
manifest paths, PDF/QR exports, and Viewer gallery; it never fabricates an RFC
UUID alias.

The full profile additionally tests every gamma/neutron alarm it generates; it
does not rely on `STORAGE_RETAINED_EVENT_ID` for this path. The exact generated
public observation ID remains in run state through retention, and one of those IDs must also
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
hash, baseline-structure, dimension, and Chromium decode checks. The manifest's
`laneUid` must be the authoritative parent system UID in
`urn:osh:system:lane:*` form; an RPM child UID or an unresolved placeholder is
never accepted as a lane identity. The exact
event/lane/camera `.job.json` ledger must be `PUBLISHED` or `SOURCE_DELETED`,
have `attempts=1`, and have no failure. Finally, the probe derives only the
authoritative camera tokens from this run's paths and compares those directories
with the pre-trigger baseline: all expected sources are accounted for, with no
additional finalized MP4 or new partial/temp artifact. Historical failures and
partials present before the run therefore do not falsely fail the gate. The
marker is removed after comparison and through the validated privileged failure
cleanup path.

The metadata health probe separately validates
`retained-media/v1/.metadata-reclamation-checkpoint.json` as schema 2, bounded
regular JSON. Processed-observation indexes use exactly
`retention-processed-index/{19-digit-UTC-epoch-hour}-{00..11}.idx`; the twelve
deterministic five-minute shards keep reclamation work hour-based while bounding
each cache snapshot. Deletion indexes use
`deletion-index/{first-two-hex}/{first-four-hex}.idx`. Both formats require their
16-byte OSCAR header and 36-byte fixed records. The gate rejects malformed
names/headers/sizes, links, partials, legacy per-event processed JSON, and legacy
`.deleted.json` tombstones. A required lifecycle never treats an empty media
state as certification: it must have either generated retained media or an
explicit `STORAGE_RETAINED_EVENT_ID` that completed the exact API/JPEG/gallery
proof before mutation. That proof makes checkpoint, processed-index, manifest,
and five-JPEG population mandatory. These counts and bytes are written to
`storage-performance.csv`.

## Backup and performance

After the supported deployment restart, the suite first crosses one complete
configured media-retention query interval plus 15 seconds, then waits for a
nonempty processed-index inventory and three consecutive stable file-count
snapshots. This prevents a backup from racing startup reclamation and the first
durable-index reconstruction scan.
The backup check then creates a coordinated backup and invokes the supported
`backup-verify` command again. Independently, it recomputes `SHA256SUMS.hmac`
with the configured backup key, verifies every listed checksum, and rejects
unlisted, duplicate, linked, or special payloads. It requires regular, non-symlink `VERIFIED`,
`JOURNAL_CONFIRMED`, `SHA256SUMS`, `SHA256SUMS.hmac`, `epoch.json`,
`image-inventory.txt`, and `archive-generation-ids.txt` files. The immutable backup core is authenticated by
`SHA256SUMS.hmac`; `JOURNAL_CONFIRMED` is deliberately excluded from that core
inventory because it is published only after verification. Instead, its exact
five-line v2 payload has a separate HMAC that binds the backup ID and exact
authenticated OSCAR-state checksum. The check requires both HMACs to verify;
an exact backup ID, UUID, `oscar-backup-epoch` v1/`CREATED` identity and 3.9.2
release; a bounded, canonically sorted, duplicate-free backup-time archive-generation
UUID inventory covered exactly once by the authenticated manifest; the matching
live VERIFIED catalog epoch with exact generation count, lowercase SHA-256, and
byte-count receipt for that inventory (without loading or embedding its UUIDs in
SQL), plus exact equality with the captured active/sealed catalog inventory; and
count retention. It extracts the confirmation set and referenced receipts from
the authenticated state tar, not the mutable live tree, and
requires at least one daily-journal confirmation receipt bound to the new backup
ID and authenticated `oscar-state.tar.gz` SHA-256, with a non-empty sealed-segment
inventory. Each recorded segment must be exactly one regular tar member at the
derived lane/day path with identical size and SHA-256, with no extra `.open` or
`.seg` member for that receipt. Receipts authorize deletion only when their relative path and SHA-256
are members of the backup's atomically published confirmation-set marker; partial
receipt writes without that marker fail closed. This means an overnight
publication/rotation fixture is a prerequisite for the complete gate. The
lifecycle also inventories the authenticated `oscar-state.tar.gz`: it rejects
absolute/traversal members, caps the listing, proves DuckDB scratch is excluded,
and requires the exact retained-media checkpoint, every live processed index,
every live deletion index, and each proved event/lane/camera manifest plus
`frame-01.jpg` through `frame-05.jpg` to appear exactly once as regular tar
members. It verifies every expected path, type, byte length, and SHA-256 against
the pre-backup snapshot. An equal aggregate count for another event cannot
pass; missing, duplicate, linked, wrong-type, wrong-size, or changed members are
rejected.
Those retained-media files are therefore included in the authenticated
application-state backup rather than treated as disposable cache. The lifecycle
check explicitly does not restore. Set
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
STORAGE_WORKFLOW=required
STORAGE_BACKUP_WORKFLOW=required
OSCAR_RESTORE_TARGET_ACK=<viewer-host>|<user@ssh-host>|<release-dir>|ISOLATED-RESTORE
OSCAR_RESTORE_DISPOSABLE_ACK=<host>:DISPOSABLE-NO-PRODUCTION-DATA
OSCAR_RESTORE_DATA_LOSS_ACK=I-ACCEPT-DESTRUCTIVE-RESTORE
OSCAR_RESTORE_ARCHIVE_DIR=<canonical-archive-directory>
OSCAR_RESTORE_WAL_ARCHIVE_DIR=<canonical-wal-archive-directory>
OSCAR_RESTORE_BACKUP_DIR=<canonical-backup-directory>
OSCAR_RESTORE_PATHS_ACK=<archive>|<wal-archive>|<backup>|DEDICATED-RESTORE-PATHS
STORAGE_RESTORE_PROBE_TIMEOUT_MS=7200000
```

Then, and only then, run `npm run test:restore-drill`. The profile accepts no
ordinary scenario and uses both a local target/release lock and the host-wide
remote suite lease. Before mutation
it requires both storage workflows to be `required`, the exact 3.9.2
image/marker gate, and an available committed clean suite checkout with a
canonical 40-hex HEAD. The later `3.9.2-release` run requires that same exact
suite commit; tracked and untracked changes are refused, while Git-ignored
`.env` and `results/` are allowed. The target-side helper creates
unique pre-backup canaries in PostgreSQL, OSCAR application state, the external
cold archive, `.env`, secrets, and TLS, plus real switched WAL fingerprints before
and after the backup; creates and re-verifies a
coordinated backup; mutates every canary; and calls only the supported
`oscar.sh restore --backup ID --confirm ID` interface. The cold-archive canary is an empty canonical
`datasets/observations/date=.../profile=...` hierarchy. Every hierarchy component
is created or validated with OSCAR's UID/GID 10001 and owner read/write/search
permission so the non-root restore helper can replace it; a root-owned
intermediate directory is rejected before backup.
Acceptance requires all
pre-backup values, promotion onto a timeline newer than the base backup, an archived
timeline-history file and new-timeline WAL segment, byte-identical preservation of
the fingerprinted backup-era and divergent post-backup source-timeline WAL, no
post-start archiver failure, cleanup of the
one-time recovery settings/signals, exact reconstruction of the authenticated
`VERIFIED` epoch receipt, healthy app/PostGIS/gateway containers, archive verification,
and unchanged immutable running image IDs after restore. Scoped canaries are
removed after verification. The verified drill backup and OSCAR's root-owned
mode-0700 `pre-restore-ID` safety directory remain intentionally. Its `.env`,
`secrets/`, and `tls/` tree must preserve every exact mutated relative name,
content/size/hash, owner, group, and mode with no link or special entry. It contains
plaintext pre-restore `.env`, secrets, and TLS material; record and restrict it,
then remove it under the disposable site's approved retention policy.
Cleanup does not add canary files beneath the production credential directories.
If recovery must atomically replace either approved credential leaf, it
force-recreates the Compose services so file-backed secret mounts and the
gateway's in-memory TLS state cannot retain the old inode, then requires all
three services healthy before deleting the database/application canaries.

The restore-only probe deadline defaults to two hours and is bounded between
600,000 and 28,800,000 milliseconds. It covers the fresh coordinated backup,
independent validation, WAL merge, restore, promotion, and post-restore proofs;
ordinary probes continue to use `STORAGE_PROBE_TIMEOUT_MS`. Reaching the local
deadline is a failed run, but it does not release the disruption phase: the
deadline bounds only the primary SSH wait, and fail-closed quiescence may extend
beyond it. An atomically pre-armed `ready` gate is claimed by exactly one of the
remote wrapper or cancellation poll, so a delayed SSH command cannot begin after
the poll declares cancellation. The runner then validates the root-owned
control files and polls the exact probe-session PID/start-time/PGID/SID until no
session member remains; even an atomic numeric status cannot outrank a surviving
member. Health and container-identity oracles therefore cannot race a restore
that outlived SSH. Treat unexpectedly long active work as a
product/performance defect rather than increasing this bound until it passes.
Malformed, linked, or incorrectly permissioned control state is nonterminal by
design: preserve the lease and investigate instead of inferring quiescence.

The report retains all raw pre/restore/post samples. Only the exact
`storage-restore-drill-disruption` phase of this profile is excluded from
steady-state running, health, completeness, and within-phase identity checks.
It still requires a successful target-host sample during that phase, complete
healthy pre/post samples, immutable image identity, stable restart counts per
container identity, and no OOM kill in any phase. A synthetic missing-service
snapshot cannot satisfy disruption coverage.

## Strict 3.9.2 release certification

Preserve the complete PASS directory from an unfiltered destructive drill. For
the same candidate, set all operational-view, event-UUID, Alarm Transfer camera,
storage, and backup workflows to `required`; set the exact `OSCAR_BUILD_LABEL`;
set `OSCAR_3_9_2_RESTORE_EVIDENCE_DIR` to that directory; and run
`npm run test:3.9.2-release` without `--scenario`.

This profile refuses filters and requires the full suite. The evidence must be a
schema-2 restore-drill PASS with zero incorrect/skipped checks, matching suite
commit, build label, Viewer URL, and release directory, and a complete
attestation for independent backup reverification, all canaries, unchanged
immutable images, and the exact pre-restore safety copy. Missing or mismatched
evidence fails before mutation.

The Linux SSH/Docker path described above is the automated 3.9.2 gate in this
suite. Native Windows Docker Desktop plus PowerShell (`oscar.bat`) storage and
restore acceptance is deliberately deferred: do not infer a Windows pass from
Linux execution, Bash syntax tests, or static inspection of PowerShell. Record a
separate Windows-native transcript when that acceptance environment is
available.

If restore fails after services stop, do not improvise deletion. Preserve the
root-owned mode-0700 `/var/tmp/oscar-regression-restore-failure-<run>` bounded
diagnostic bundle, the backup, and any `pre-restore-ID` directory; use the
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
