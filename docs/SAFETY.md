# Safety and recovery

> **Test environments only.** Full runs create permanent OSCAR event and audit
> records and temporarily control the reserved emulator RPM. Never target
> production. The acknowledgement values are interlocks, not authorization.

## Approved target only

Use `full` only on an emulator-backed test deployment. The acknowledgement must
exactly match the OSCAR hostname:

```text
OSCAR_BASE_URL=https://test-host
OSCAR_TEST_TARGET_ACK=test-host
RPM_EMULATOR_TARGET_ACK=emulator-host
RPM_LANE_MAPPING_ACK=rpm-50:Lane50
OPERATIONAL_VIEW_WORKFLOW=required
ALARM_TRANSFER_CAMERA_WORKFLOW=required
OSCAR_LANE_CONFIG_PATH=fixtures/oscar-50-lane-config.csv
```

Loopback targets are refused. This guard reduces accidental execution but is not
a substitute for verifying the host yourself.

Every OSCAR 3.9.2 storage probe, including smoke/non-lifecycle `storage-health`, has
a separate target-bound interlock:

```text
OSCAR_SSH_TARGET=tester@test-host
OSCAR_RELEASE_DIR=/absolute/disposable/release
OSCAR_STORAGE_TARGET_ACK=test-host|tester@test-host|/absolute/disposable/release|DISPOSABLE-STORAGE
```

Before any remote write, upload, or probe action, the runner resolves the
release directory on that exact SSH target. It must already exist, be a
non-root directory, contain a regular non-symlink `oscar.sh`, contain no symlink
component, and resolve byte-for-byte to the configured and acknowledged path.
The binding is revalidated before every action. The probe itself runs from a
fresh mode-0700 private workspace and removes it on completion. These checks are
interlocks, not authorization.

It copies two existing test observations into uniquely registered fixture rows.
Cold deletion is refused unless the dry-run plan contains exactly the one
registered fixture generation. Backup creation/verification may prune older
verified backups according to the target's configured count; restore is never
attempted. Do not enable this path on production or a target containing data
that must be preserved.

The same disposable target must explicitly use `timeToRetention=0`,
`videoQueryPeriod=1`, `enableFrameRetention=true`, `frameRetentionCount=5`, and
`jpegQuality=85`, `sourceRollbackGraceHours=24`, and
`metadataReclamationWorkLimit=200` for the generated-alarm
media check. The suite verifies those
live values before it polls or creates the archive fixture; it never edits the
configuration. The 24-hour source grace keeps the exact generated MP4s available
for the final forensic comparison. OSCAR's packaged and production age default remains seven days.
Never copy the zero-day test setting into production.

A required lifecycle cannot certify a target without retained-media evidence.
An unfiltered full run must generate and validate at least one exact retained
set; a lifecycle-only run must configure `STORAGE_RETAINED_EVENT_ID` and pass
the same API, five-JPEG hash/type/structure, Chromium decode, and gallery proof
before lifecycle mutation begins.

The only restore coverage is the separately selected `restore-drill` profile.
It is rejected unless `STORAGE_WORKFLOW=required` and
`STORAGE_BACKUP_WORKFLOW=required`, the ordinary target and
disposable-storage acknowledgements pass, all three storage-plane directories
are canonical, dedicated, and non-overlapping, and all additional values match:

```text
OSCAR_RESTORE_TARGET_ACK=test-host|tester@test-host|/absolute/disposable/release|ISOLATED-RESTORE
OSCAR_RESTORE_DISPOSABLE_ACK=test-host:DISPOSABLE-NO-PRODUCTION-DATA
OSCAR_RESTORE_DATA_LOSS_ACK=I-ACCEPT-DESTRUCTIVE-RESTORE
OSCAR_RESTORE_ARCHIVE_DIR=/srv/oscar-restore/archive
OSCAR_RESTORE_WAL_ARCHIVE_DIR=/srv/oscar-restore/wal-archive
OSCAR_RESTORE_BACKUP_DIR=/srv/oscar-restore/backups
OSCAR_RESTORE_PATHS_ACK=/srv/oscar-restore/archive|/srv/oscar-restore/wal-archive|/srv/oscar-restore/backups|DEDICATED-RESTORE-PATHS
```

These are interlocks, not permission to use real data. The drill deliberately
overwrites the current PostgreSQL cluster, OSCAR state, cold archive, WAL
archive, `.env`, secrets, and TLS with a newly created backup. It uses scoped
canaries to prove each plane returned, cleans those canaries after success, and
leaves the verified backup plus a mode-0700 `pre-restore-ID` safety directory
containing plaintext pre-restore deployment credentials for manual review.
The cold-archive canary is an empty canonical observations partition/profile
hierarchy whose components must all be owned by the OSCAR runtime UID/GID and
owner-writable/searchable; the drill refuses a root-owned intermediate directory
that the non-root restore helper could not replace.
Restrict and remove that directory under the disposable site's approved policy.
If cleanup atomically replaces either approved live credential file, it
force-recreates the affected Compose services to guarantee file-backed secret
rebinding and reset the gateway's in-memory TLS state, then proves all three
services healthy.
Never place those acknowledgements in a normal runner `.env`.
Never run the profile against a target whose loss would matter.

Both `restore-drill` and the matching `3.9.2-release` require the same
available, committed, clean canonical 40-hex suite HEAD. Any tracked or
untracked file fails closed; ignored `.env` and `results/` are permitted. The
supported restore's exact disruption phase retains raw metrics but is excluded
from steady-state service checks only for this profile. Host coverage, healthy
pre/post samples, restart/OOM checks, and immutable image identity remain
mandatory.

The ordinary full storage lifecycle also invokes supported portable-export,
confirmed-purge, and whole-deployment restart commands. Each may briefly stop
OSCAR. Preserve every raw metric, and exempt service availability only inside
the exact `storage-lifecycle-export-disruption`,
`storage-lifecycle-purge-disruption`, and
`storage-lifecycle-restart-disruption` phases. Require healthy samples around
each boundary, unchanged image identity, and zero OOM kills. Do not treat
Compose one-off command containers as long-running OSCAR services.

Atomic journal rotation may expose a `.partial` only during publication. Poll a
short bounded window for a clean boundary; a persistent partial remains a
failure. After the supported restart, cross one complete configured media query
interval before freezing backup inventory so startup reclamation cannot race
the first repopulation scan.

The lane CSV is read-only during a suite run. Apply it only while provisioning
the authorized disposable regression system. OSCAR's spreadsheet import is
additive: rows whose `UniqueID` already exists are skipped, not updated. On a
persistent site, a successful upload therefore does not prove that operational
views were migrated. Verify live memberships and use supported Admin edits plus
a global save, or explicitly reprovision a disposable site. Never delete volumes
or reinitialize a site merely to force the fixture to apply. The browser workflow
uses the file solely as its exact membership oracle.

Only one mutating suite run may use an OSCAR test host at a time. Before browser,
emulator, storage, or restore mutation, the harness acquires the host-wide
`/run/lock/oscar-regression-suite/suite.lock` over strict SSH and holds the live
file descriptor until `finally` cleanup. The root-owned mode-0700 directory and
mode-0600 regular lock file fail closed on links, wrong ownership/modes, or
contention, and the lease is shared across runners, release directories, full
runs, restore drills, and the storage-health atomic-publisher check. Full and
restore local locks are defense in depth only. The lease does not coordinate a
manual operator, so never overlap manual fault injection.

## What a full run changes

The reserved RPM is stopped and started while its configuration is replaced with
a deterministic quiet configuration. The suite then toggles connection and fault
states, creates gamma/neutron occupancies, submits a Code 9 adjudication with a
`REG-...` vehicle identifier and run-ID note, and creates report files.

The reserved RPM stays quiet through `storage-lifecycle`, so each new clip in
its authoritative camera directories can be bound to an exact generated UUID.
The lifecycle may publish five retained JPEGs and durable media ledger/catalog
records for each generated alarm.

Event and adjudication history is intentionally not deleted. It is audit data and
is the expected permanent footprint of a full run.

The smoke Dashboard baseline does not toggle faults. It reads the modeled
`tamper_fault` boolean from every emulator RPM and fails closed if any RPM is
stopped, disconnected, active, or lacks an explicit value. The separate Viewer
assertion then proves OSCAR's Rapiscan driver published its required initial
Tamper-clear observation for the established connections. That driver baseline
is emitted before later `TT`/`TC` messages are processed. Never replace the two
independent checks with a harness assumption based only on an Online icon.

## Automatic restoration

Before mutation, the complete original RPM configuration is saved as
`evidence/reserved-rpm-original-config.json`. Cleanup clears all fault toggles,
restores that exact configuration plus the original running/fault states, and
records whether the restored state matches.

Normal exceptions are contained and cleanup runs in `finally`. `SIGINT` and
`SIGTERM` request emergency cleanup. A hard kill, runner power loss, or emulator
loss can prevent it.

Alarm-media forensics uses one root-owned mode-0600 marker named
`/tmp/oscar-alarm-media-<run-key>.baseline`. Normal completion and failure
cleanup use a privileged probe action derived only from the validated run key;
the copied probe is then removed without privilege. Pre-existing clip or ledger
failures are not changed or attributed to the new run.

## Manual recovery after a hard interruption

1. Stop the reserved RPM in the emulator.
2. Locate the latest `reserved-rpm-original-config.json` evidence file.
3. PUT the complete JSON document to `/api/rpms/<reserved-id>`.
4. Start the RPM.
5. Clear `gh`, `gl`, `nh`, and `tamper` with the emulator fault endpoint.
6. Restore the original running and fault state recorded for the run.
7. Confirm the expected OSCAR client state and Status of Health return to
   the expected state.

Do not hand-edit the recovery snapshot. It can contain deployment-specific
coordinates, identifiers, and camera mappings.

## Credentials and SSH

- `.env`, private keys, and result bundles are ignored by Git.
- keep `.env` mode `0600` on a shared runner
- use a dedicated least-privilege SSH key for performance sampling
- storage probing additionally requires narrowly authorized passwordless sudo
  for the disposable OSCAR release; do not grant it on a production host
- pin host keys and keep `StrictHostKeyChecking=yes`; never bypass it
- metrics SSH performs only `docker stats`, `docker inspect`, and reads
  `/proc/loadavg` and `/proc/meminfo`
- the reporter redacts the configured password and Basic authorization tokens,
  but results must still be treated as internal operational data
- screenshots, PDFs, alarm exports, and configuration snapshots can contain
  sensitive operational data; files are created under a `0077` process umask
