# Linux runner deployment

The recommended runner is a dedicated Linux machine on the same test network as
OSCAR, the RPM emulator, and the camera emulator. The current validated runner is
`tyrone@192.168.0.60`; the OSCAR URL remains the remote deployment URL, not
`localhost` and not `oscar.local` unless that name resolves on the runner.

## Install

Clone the repository into a non-shared directory and install locked dependencies:

```bash
git clone git@github.com:tyronechrisharris/oscar-regression-suite.git
cd oscar-regression-suite
npm ci
```

Use either an installed Chrome:

```text
BROWSER_EXECUTABLE_PATH=/usr/bin/google-chrome
```

or install Playwright Chromium:

```bash
npm run install:browser
```

Copy `.env.example` to `.env`, populate it outside Git, and set mode `0600`.
On an NVM-based noninteractive SSH session, put the desired Node binary on
`PATH`; `scripts/run-regression.sh` also locates the newest installed NVM Node.

Provision every canonical 50-lane regression build with
`fixtures/oscar-50-lane-config.csv`. Keep `OSCAR_LANE_CONFIG_PATH` pointed to the
same tracked file so the UI assertions are derived from the deployed source of
truth rather than duplicated expectations.

## Strict SSH for performance data

Performance sampling is optional. Before setting `OSCAR_SSH_TARGET`:

1. obtain the OSCAR host's SSH fingerprint through a trusted channel
2. scan the host key and compare the fingerprint exactly
3. add only the verified key to the runner's `known_hosts`
4. use a dedicated key whose account can read Docker stats but cannot administer
   unrelated hosts
5. verify noninteractive access with `BatchMode=yes` and
   `StrictHostKeyChecking=yes`

If SSH sampling is not configured, functional tests and runner metrics still run;
container/host fields are simply absent.

## Run

```bash
./scripts/run-regression.sh smoke
./scripts/run-regression.sh full
./scripts/run-regression.sh full --scenario rpm-faults,adjudication
# Release gate for a build that claims the occupancy UUID workflow:
EVENT_UUID_WORKFLOW=required ./scripts/run-regression.sh full --scenario event-uuid
# With operational views enabled, this also gates assigned-view URL persistence
# and non-member-view fail-closed lookup for the reserved lane.
# Release gate for deterministic Alarm Transfer camera scanning:
ALARM_TRANSFER_CAMERA_WORKFLOW=required \
  ./scripts/run-regression.sh smoke --scenario alarm-transfer-camera
# Release gate for the canonical seven operational views:
OPERATIONAL_VIEW_WORKFLOW=required OSCAR_LANE_CONFIG_PATH=fixtures/oscar-50-lane-config.csv \
  ./scripts/run-regression.sh smoke --scenario operational-views
```

Review `summary.md`, `functional-results.csv`, `errors.csv`, and cleanup rows
before accepting a build. Preserve the whole run directory when filing a defect.

## Updating a deployed checkout

```bash
git fetch --prune origin
git pull --ff-only
npm ci
npm run check
npm test
```

Do not place `.env`, SSH private keys, or generated `results/` in Git. Do not run
`full` concurrently from two runners against the same reserved RPM.

## Exit codes

- `0`: all evaluated functional checks correct
- `1`: one or more functional checks incorrect
- `2`: configuration/initialization failure
- `130`: interrupted run after cleanup was requested
