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
- reserved RPM exists, is running, and has an OSCAR client
- Viewer health row maps the acknowledged lane to RPM/camera telemetry
- no second runner/operator is controlling that RPM
