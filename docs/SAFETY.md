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
```

Loopback targets are refused. This guard reduces accidental execution but is not
a substitute for verifying the host yourself.

Only one full run may use a given `TEST_RPM_ID`. The runner uses a local lock,
but that cannot detect a run launched from a different machine. Coordinate
runner ownership externally and never overlap Mac/Linux/manual fault injection.

## What a full run changes

The reserved RPM is stopped and started while its configuration is replaced with
a deterministic quiet configuration. The suite then toggles connection and fault
states, creates gamma/neutron occupancies, submits a Code 9 adjudication with a
`REG-...` vehicle identifier and run-ID note, and creates report files.

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
- pin host keys and keep `StrictHostKeyChecking=yes`; never bypass it
- metrics SSH performs only `docker stats`, `docker inspect`, and reads
  `/proc/loadavg` and `/proc/meminfo`
- the reporter redacts the configured password and Basic authorization tokens,
  but results must still be treated as internal operational data
- screenshots, PDFs, alarm exports, and configuration snapshots can contain
  sensitive operational data; files are created under a `0077` process umask
