# Target checklist

## Authorization and isolation

- user authorized the OSCAR and emulator test systems
- OSCAR is not production and does not control physical RPM hardware
- reserved RPM/lane is free of another automated or manual test
- operators understand permanent event/adjudication records will be created

## Identity

- OSCAR_BASE_URL and RPM_EMULATOR_URL resolve from the runner
- OSCAR_TEST_TARGET_ACK exactly equals the OSCAR hostname
- RPM_EMULATOR_TARGET_ACK exactly equals the emulator hostname
- RPM_LANE_MAPPING_ACK exactly equals TEST_RPM_ID:TEST_LANE_LABEL
- expected lane/camera counts match the deployment
- OSCAR_LANE_CONFIG_PATH resolves to the reviewed canonical fixture
- OPERATIONAL_VIEW_WORKFLOW is `required` for canonical 50-lane release regression
- ALARM_TRANSFER_CAMERA_WORKFLOW is `required` when camera scanning is part of
  the Viewer release contract
- build labels identify both OSCAR and emulator revisions
- OSCAR 3.9.2 storage release gates identify the absolute release directory,
  use a disposable database and dedicated storage paths, and set the exact
  `<host>:<release-dir>:DISPOSABLE-STORAGE` acknowledgement
- OSCAR 3.9.2 release identity resolves exactly `oscar:3.9.2`,
  `oscar-postgis:3.9.2`, and the pinned gateway; running IDs match local image
  IDs; application/PostGIS OCI labels, checksum marker, and the archive,
  WAL-archive, and backup root v1 identities match the lowercase deployment ID
- stable deployment lock and packaged/running WAL/archive helper checks pass;
  PostgreSQL uses the exact helper-backed `archive_command` and the WAL helper's
  flushed-temp atomic no-replace hard-link contract; archive and WAL roots
  contain no partial artifacts

## Runner

- Node.js >=20.16, npm, and Chrome/Chromium are available
- .env is mode 0600 and ignored by Git
- result directory is private
- TypeScript, unit tests, and dependency audit pass

## Optional remote metrics

- OSCAR SSH fingerprint was verified through a trusted channel
- exact key is present in known_hosts
- a dedicated key works with BatchMode and StrictHostKeyChecking
- the account can read Docker stats/inspect and /proc metrics
- no private key was copied without explicit authorization

## Pre-mutation gate

- smoke result was reviewed
- authenticated session is the intended account
- fixture validation proves the exact current 20-column header, names `Lane01`
  through `Lane50`, IDs `lane-01` through `lane-50`, and exactly two distinct
  operational-view keys per lane in primary-then-direction order
- live memberships match the fixture: 10 lanes for each of `east-gate`,
  `west-gate`, `north-gate`, `south-gate`, and `pedestrian`; 25 each for
  `entrance` and `exit`; five in every primary/direction intersection
- every one of the seven configured views is exercised with exact membership by
  following the real scoped Dashboard-to-Status-of-Health navigation link
- the `view` query persists, and malformed, well-formed-but-unassigned, and
  duplicate `view` parameters each fail closed with zero health rows
- no required operational-view result is skipped
- Dashboard smoke coverage proves the expected card/RPM/per-camera inventory,
  every emulator RPM's explicit known-clear Tamper source state, no Dashboard
  Tamper Unknown, live Online states, accessible Offline/Unknown fixtures,
  keyboard lane navigation, and health-request batch/concurrency bounds
- the deployed Rapiscan driver publishes an initial Tamper-clear observation on
  each new RPM connection before applying subsequent `TT`/`TC` messages
- Lane Details reached through the real Dashboard link paints live Gamma and
  Neutron datasets rather than only empty canvases or Threshold data
- reserved RPM exists, is running, and has an OSCAR client
- Viewer health row maps the acknowledged lane to RPM/camera telemetry
- no second runner/operator is controlling that RPM
- storage lifecycle uses one-minute archive cadence/one-day grace only on the
  disposable target; an overnight rotation produced daily CSV/manifest pairs;
  retained and legacy media event IDs were reviewed; backup capacity is adequate
- the disposable lifecycle's controlled stale-activation race, exact-row retry,
  packaged CLI export/purge archive-helper wiring and invocation, and synthetic WAL helper
  idempotency/mismatch checks all completed and cleaned their temporary state
- retained fixtures expose five quality-85 baseline JPEGs per camera and every
  frame passes both the bounded parser and Chromium decode at declared dimensions
- backup acceptance includes regular `VERIFIED`, `SHA256SUMS`,
  `SHA256SUMS.hmac`, `epoch.json`, and `image-inventory.txt`; supported `backup-verify`; the VERIFIED
  catalog epoch; and at least one receipt for the new backup's authenticated
  daily-journal snapshot

## Separate restore drill only

- no smoke/full command contains the restore scenario
- the deployment is isolated, disposable, and contains no production data
- target/release/archive/WAL/backup paths were manually reviewed
- exact `OSCAR_STORAGE_TARGET_ACK`, `OSCAR_RESTORE_TARGET_ACK`,
  `OSCAR_RESTORE_DISPOSABLE_ACK`, `OSCAR_RESTORE_DATA_LOSS_ACK`, and
  `OSCAR_RESTORE_PATHS_ACK` values are set
- canonical archive, WAL, and backup directories resolve exactly to the three
  acknowledged, dedicated, non-overlapping storage planes
- capacity exists for a new backup and OSCAR's `pre-restore-ID` safety directory
- operator accepts replacement of PostgreSQL, OSCAR state, archive, WAL,
  `.env`, secrets, and TLS and knows how to recover if services remain stopped
- after the drill, every canary, service health, archive verification, and image
  identity check passed; the preserved backup/safety directory was recorded
