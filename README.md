# OSCAR Regression Suite

End-to-end regression testing for an OSCAR test deployment. The suite drives the
real OSCAR Viewer, SensorHub Admin UI, and RPM emulator; injects controlled
faults and alarms; validates adjudication and reporting; and emits machine-readable
correctness and performance results.

The harness was developed against OSCAR 4.0.0 and the 50-lane emulator site. It
is configuration-driven so later builds can be tested without changing source.

> **Test environments only.** The `full` profile stops and restarts the reserved
> RPM, temporarily replaces its configuration, forces connection and fault
> transitions, creates alarm occupancies (including one over a minute), and
> submits a Code 9 adjudication. OSCAR event and audit history created by a run is
> permanent. Cleanup restores emulator state but does not delete OSCAR history.
> Never run `full` against production. Acknowledgement variables are safety
> interlocks, not authorization.

## What it validates

- authenticated Viewer access, navigation, map, national statistics, and servers
- SensorHub Admin visibility
- every configured lane and camera on Status of Health
- RPM disconnect/reconnect, gamma-high, gamma-low, neutron-high, tamper, and
  extended-occupancy detection and recovery
- live HLS camera playback, decoded dimensions, and advancing playback time
- alarm ingestion and full-database event filtering
- occupancy UUID display, search, fresh direct links, not-found handling, and
  exact UUID preservation in printable PDFs and truncated QR exports
- offline alarm JSON export/import and SHA-256 validation
- full adjudication, confirmation, and audit-history display
- site, lane, event, state-of-health, and adjudication PDF reports
- exact membership for all five location and both direction operational views,
  Health-navigation query persistence, and malformed/unassigned inputs failing closed
- runner and OSCAR container CPU, memory, PID, restart, OOM, load, and available
  host-memory samples

See [docs/COVERAGE.md](docs/COVERAGE.md) for the detailed matrix and intentional
exclusions.

## Safety model

`smoke` is non-fault-injecting, but it authenticates, posts a national-statistics
command, and creates report bucket files. `full` also changes emulator state and creates permanent,
clearly marked adjudication audit records. Full runs are refused unless
`OSCAR_TEST_TARGET_ACK` exactly matches the host in `OSCAR_BASE_URL`.
It also requires exact emulator-host and RPM-to-lane acknowledgements. The local
lock prevents overlapping full runs on one runner; operators must ensure another
runner is not using the same RPM.

The suite reserves one RPM (default `rpm-50` / `Lane50`), snapshots its complete
configuration, disables random occupancies, runs deterministic tests, clears all
injected faults, and restores the exact snapshot in a `finally` block. Do not run
the full profile against an operational or production lane.

Read [docs/SAFETY.md](docs/SAFETY.md) before the first full run.

## Requirements

- Node.js 20.16 or newer and npm
- Chrome/Chromium, or a Playwright-managed Chromium installation
- network access to OSCAR and the RPM emulator
- an OSCAR test account
- optional: strict-key-checked SSH access to the OSCAR Docker host for container
  performance sampling

## Quick start

```bash
npm ci
npm run install:browser
cp .env.example .env
chmod 600 .env
```

Edit `.env` for the test deployment. Never commit it.

Run the low-mutation smoke profile first (it does not inject RPM faults, but it
does post the national-statistics command and create report bucket files):

```bash
npm run test:smoke
```

Then run the complete fault-injection profile on an acknowledged test target:

```bash
npm run test:full
```

Run one or more named scenarios with a comma-separated filter:

```bash
npm run test:full -- --scenario rpm-faults,adjudication
```

The reserved lane is still isolated and restored when a full-profile scenario
filter is used.

## Configuration

Start from [.env.example](.env.example). Required values are:

| Variable | Meaning |
| --- | --- |
| `OSCAR_BASE_URL` | HTTPS origin for the test Viewer |
| `OSCAR_USERNAME` / `OSCAR_PASSWORD` | test account; never commit these |
| `OSCAR_TEST_TARGET_ACK` | exact hostname from `OSCAR_BASE_URL` |
| `RPM_EMULATOR_URL` | emulator HTTP origin |
| `TEST_RPM_ID` / `TEST_LANE_LABEL` | reserved emulator RPM and Viewer lane |
| `OPERATIONAL_VIEW_WORKFLOW` | `required` (default) for the seven-view release gate, `auto` for explicit legacy detection, or `disabled` |
| `OSCAR_LANE_CONFIG_PATH` | current-schema lane CSV used both to provision the test site and as the membership oracle |
| `EVENT_UUID_WORKFLOW` | `auto` for backward-compatible detection, `required` for a release gate, or `disabled` |

Set `EVENT_UUID_WORKFLOW=required` when validating a Viewer build that claims
the occupancy UUID workflow. The default `auto` mode records one skipped check
instead of failing when the controls are absent from an older deployment.

The canonical future-build fixture is
[`fixtures/oscar-50-lane-config.csv`](fixtures/oscar-50-lane-config.csv). It uses
the current 20-column schema and assigns ten lanes apiece to `east-gate`,
`west-gate`, `north-gate`, `south-gate`, and `pedestrian`. The first five lanes
in each block also belong to `entrance`; the last five belong to `exit`. Apply
this file when provisioning the 50-lane regression site and keep
`OSCAR_LANE_CONFIG_PATH` pointed at that same file. Set
`OPERATIONAL_VIEW_WORKFLOW=required` for 4.0.0-and-newer release gates. Required
mode treats any mismatch in all seven exact lane sets—or failure to preserve the
view query through the real Status of Health navigation link—as a release failure.
The explicit `auto` mode remains compatible with older Viewers by recording a
skip only when the workflow itself is absent.

`OSCAR_SSH_TARGET` enables read-only Docker/host performance sampling.
`OSCAR_SSH_IDENTITY_FILE` may point to a dedicated least-privilege key.
`BROWSER_EXECUTABLE_PATH` can select a preinstalled Chrome binary on a runner.

## Results

Each run creates `results/<UTC timestamp>-<runner>/` containing:

- `functional-results.csv` — one row per expected behavior, including correct,
  incorrect, and skipped counts
- `performance.csv` — time-series resource samples by phase and target
- `summary.csv` — correctness and resource aggregates
- `errors.csv` — browser, network, API, cleanup, and sampling errors
- `summary.md` — concise narrative PASS/FAIL report
- `run.json` — stable run metadata
- `evidence/` — screenshots and the reserved-RPM recovery snapshot
- `downloads/` — generated PDFs and exported offline alarm files

The process exits `0` only when every evaluated check is correct. See
[docs/REPORT_SCHEMA.md](docs/REPORT_SCHEMA.md) for column definitions and CPU
interpretation.

## Runner deployment

Deployment to a dedicated Linux runner, strict SSH host-key setup, secret-file
handling, and repeatable commands are documented in
[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## Reusable Codex skill

The installable skill is versioned at
[`skill/oscar-full-regression`](skill/oscar-full-regression). It guides future
agents through target authorization, runner deployment, smoke/full sequencing,
recovery, regression looping, and report interpretation. The same skill may be
installed in a user's Codex skills directory under the name
`oscar-full-regression`.

## Development

```bash
npm run check
npm test
npm run build
```

CI performs TypeScript validation and unit tests. Live OSCAR regression is kept
off shared GitHub-hosted runners because it requires private test infrastructure
and authorized state changes.

## License

ISC; see [LICENSE](LICENSE).
