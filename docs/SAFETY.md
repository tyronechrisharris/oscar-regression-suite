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

The OSCAR 3.9.2 `storage-lifecycle` path has a separate interlock:

```text
OSCAR_RELEASE_DIR=/absolute/disposable/release
OSCAR_STORAGE_TARGET_ACK=test-host:/absolute/disposable/release:DISPOSABLE-STORAGE
```

It copies two existing test observations into uniquely registered fixture rows.
Cold deletion is refused unless the dry-run plan contains exactly the one
registered fixture generation. Backup creation/verification may prune older
verified backups according to the target's configured count; restore is never
attempted. Do not enable this path on production or a target containing data
that must be preserved.

The same disposable target must explicitly use `timeToRetention=0`,
`videoQueryPeriod=1`, `enableFrameRetention=true`, `frameRetentionCount=5`, and
`jpegQuality=85` for the generated-alarm media check. The suite verifies those
live values before it polls or creates the archive fixture; it never edits the
configuration. OSCAR's packaged and production age default remains seven days.
Never copy the zero-day test setting into production.

The only restore coverage is the separately selected `restore-drill` profile.
It is rejected unless `STORAGE_WORKFLOW=required`, the ordinary target and
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
Restrict and remove that directory under the disposable site's approved policy.
Never place those acknowledgements in a normal runner `.env`.
Never run the profile against a target whose loss would matter.

The lane CSV is read-only during a suite run. Apply it only while provisioning
the authorized disposable regression system. OSCAR's spreadsheet import is
additive: rows whose `UniqueID` already exists are skipped, not updated. On a
persistent site, a successful upload therefore does not prove that operational
views were migrated. Verify live memberships and use supported Admin edits plus
a global save, or explicitly reprovision a disposable site. Never delete volumes
or reinitialize a site merely to force the fixture to apply. The browser workflow
uses the file solely as its exact membership oracle.

Only one full run may use a given `TEST_RPM_ID`. The runner uses a local lock,
but that cannot detect a run launched from a different machine. Coordinate
runner ownership externally and never overlap Mac/Linux/manual fault injection.

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
