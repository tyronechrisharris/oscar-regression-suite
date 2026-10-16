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
- reserved RPM exists, is running, and has an OSCAR client
- Viewer health row maps the acknowledged lane to RPM/camera telemetry
- no second runner/operator is controlling that RPM
