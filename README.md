# OSCAR Regression Suite

End-to-end regression testing for an OSCAR test deployment. The suite drives the
real OSCAR Viewer, SensorHub Admin UI, and RPM emulator; injects controlled
faults and alarms; validates adjudication and reporting; and emits machine-readable
correctness and performance results.

The harness was first validated against OSCAR 3.9.1 and the 50-lane emulator
site. General target and workflow selection is configuration-driven. Each new
storage release contract remains deliberately version-pinned and requires a
source review before the suite can certify that version.

> **Test environments only.** The `full` profile stops and restarts the reserved
> RPM, temporarily replaces its configuration, forces connection and fault
> transitions, creates alarm occupancies (including one over a minute), and
> submits a Code 9 adjudication. OSCAR event and audit history created by a run is
> permanent. Cleanup restores emulator state but does not delete OSCAR history.
> Never run `full` against production. Acknowledgement variables are safety
> interlocks, not authorization.

## What it validates

- authenticated Viewer access, navigation, map, national statistics, and servers
- browser-cache policy for private immutable hashed Viewer bundles, revalidated
  service-worker code, and non-cacheable anonymous authentication errors
- SensorHub Admin visibility
- every configured lane and camera on Status of Health
- compact Dashboard health indicators for every lane, with independent RPM and
  per-camera connectivity; gamma-high/low, neutron-high, tamper, and extended-
  occupancy states; operational-view membership; keyboard navigation; and
  bounded shared health requests
- RPM disconnect/reconnect, gamma-high, gamma-low, neutron-high, tamper, and
  extended-occupancy detection and recovery
- live HLS camera playback, decoded dimensions, and advancing playback time
- alarm ingestion and full-database event filtering; exact generated public
  observation-ID-to-video association with one unique generation-qualified MP4 per
  authoritative OSH lane-camera UID, nonzero source objects, and browser-loaded
  MP4 metadata
- occupancy “Event UUID” display, search, fresh direct links, not-found handling,
  operational-view-preserving member lookup and non-member fail-closed behavior,
  and exact public observation ID preservation in printable PDFs and truncated QR exports
- offline alarm JSON export/import and SHA-256 validation, including visible
  series-color chart redraw and canonical payload/integrity/transport validation
  when the received package is downloaded again
- deterministic Alarm Transfer camera scanning, lifecycle cleanup, permission
  failure/retry, and exported QR PNG image import
- full adjudication, confirmation, and audit-history display
- site, lane, event, state-of-health, and adjudication PDF reports
- exact membership for all five location and both direction operational views,
  Health-navigation query persistence, and malformed/unassigned inputs failing closed
- runner and OSCAR container CPU, memory, PID, restart, OOM, load, and available
  host-memory samples
- OSCAR 3.9.2 exact-five retained JPEG API/gallery, including generated-alarm
  self-seeding by exact public observation ID in a full run, manifest/source binding,
  one-attempt successful retention ledgers, and
  run-baselined orphan/partial rejection; bounded catalog/frame
  transfers and event resource budgets, baseline-JPEG structure plus Chromium
  decode/dimension checks for every frame, lazy selected-frame requests, and
  legacy-video fallback;
  schema-2 metadata checkpoint and compact five-minute processed/deletion index
  health; exact direct daily-file config, live lane-UID append, hardened
  publication manifests, and restart durability; archive catalog, exact schema
  v5 checksum, bounded DuckDB resources and scratch cleanup, parity, portable
  export, hot/cold query, all three exact hold modes with deletion enforcement,
  tokenized purge, and authenticated coordinated-backup controls, retained-media
  inclusion, scratch exclusion, and daily-journal receipts;
  exact application/PostGIS/gateway tags, immutable running image IDs,
  available repository digests, OCI labels, checksum and all three deployment-bound
  storage-root markers, stable lock rejection, exact WAL command, atomic no-replace
  hard-link publication, packaged helper hashes/behavior, and compiled archive/backup
  publisher source provenance plus first-publish/collision-preservation behavior, no archive/WAL
  partial artifacts, no full-backup-root mount in either long-running service,
  isolated one-shot base-backup wiring, exact-row activation under a
  controlled source-change race, PostgreSQL checksums, `pg_stat_statements`, and
  observation batch/resource counters

See [docs/COVERAGE.md](docs/COVERAGE.md) for the detailed matrix and intentional
exclusions.

The smoke profile requires live Online observations for every configured RPM
and camera. Its deterministic camera Offline and Unknown checks intercept only
browser responses and do not disconnect live cameras. The full profile performs
the real reserved-RPM disconnect/reconnect and supported fault transitions.

## Safety model

`smoke` is non-fault-injecting, but it authenticates, posts a national-statistics
command, creates report bucket files, and behavior-tests the storage atomic publisher
when `storage-health` is selected. `full` also changes emulator state and creates permanent,
clearly marked adjudication audit records. Full runs are refused unless
`OSCAR_TEST_TARGET_ACK` exactly matches the host in `OSCAR_BASE_URL`.
It also requires exact emulator-host and RPM-to-lane acknowledgements. Every
mutating invocation holds one host-wide, root-owned remote lease for its complete
run, including cleanup; this coordinates different runners, full runs, restore
drills, and storage-health publisher checks. Full/restore local locks remain an
additional same-runner guard.

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
- strict-key-checked SSH access to the OSCAR Docker host when the default
  `STORAGE_WORKFLOW=required` release gate is used; it is optional only for an
  explicit legacy/non-storage run with `STORAGE_WORKFLOW=auto` or `disabled`

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

Then run the configured full profile on an acknowledged test target:

```bash
npm run test:full
```

The destructive restore drill is deliberately not part of either command. It
has its own profile, target lock, storage acknowledgement, three explicit
canonical storage-plane paths, and four additional exact acknowledgements. Run
it only after reviewing
[docs/STORAGE_REGRESSION.md](docs/STORAGE_REGRESSION.md):

```bash
STORAGE_WORKFLOW=required STORAGE_BACKUP_WORKFLOW=required npm run test:restore-drill
```

For final 3.9.2 certification, first preserve the complete PASS directory from
an unfiltered `restore-drill`. Then set every workflow to `required`, set an exact
`OSCAR_BUILD_LABEL`, point `OSCAR_3_9_2_RESTORE_EVIDENCE_DIR` at that matching
directory, and run the unfiltered release profile:

```bash
npm run test:3.9.2-release
```

This mode rejects scenario filters, missing/skipped gates, mismatched build or
target identity, and restore evidence without the complete authenticated-backup,
canary, immutable-image, and pre-restore-safety-copy attestation. Both commands
also require the same available, committed, clean 40-hex suite HEAD. Tracked and
untracked changes are refused; Git-ignored `.env` and `results/` remain allowed.

Run one or more named scenarios with a comma-separated filter:

```bash
npm run test:full -- --scenario rpm-faults,adjudication
npm run test:smoke -- --scenario dashboard-health
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
| `ALARM_TRANSFER_CAMERA_WORKFLOW` | `auto` for backward-compatible camera-control detection, `required` for a release gate, or `disabled` |
| `STORAGE_WORKFLOW` | `required` (default), explicit legacy `auto`, or `disabled` for the OSCAR 3.9.2 storage profile |
| `OSCAR_RELEASE_DIR` | absolute release path on the disposable OSCAR SSH target |
| `OSCAR_STORAGE_TARGET_ACK` | exact `<viewer-host>|<ssh-target>|<canonical-release-dir>|DISPOSABLE-STORAGE` interlock for every storage probe, including smoke |
| `OSCAR_BUILD_LABEL` | exact artifact/component identity; mandatory for `3.9.2-release` |
| `OSCAR_3_9_2_RESTORE_EVIDENCE_DIR` | complete PASS directory from the matching unfiltered restore drill; mandatory for `3.9.2-release` |

Before any storage command or probe upload, the runner resolves
`OSCAR_RELEASE_DIR` on the SSH target and requires it to be an existing,
non-root directory whose remotely canonical path exactly matches both the
configuration and acknowledgement. Symlinked/non-canonical release paths and a
missing, linked, or non-regular `oscar.sh` are refused. The acknowledgement is
rechecked before every subsequent probe action.

Set `EVENT_UUID_WORKFLOW=required` when validating a Viewer build that claims
the occupancy UUID workflow. “Event UUID” is the operator-facing label for
OSCAR's durable public OSH observation ID. It is an opaque, normalized 1–128
character identity and is not required to have RFC 4122 punctuation. The suite
preserves and compares it exactly across Event Details, direct API lookup,
links, PDF/QR export, alarm video metadata, and retained-media manifests. The
default `auto` mode records one skipped check
instead of failing when the controls are absent from an older deployment. When
operational views are enabled, the same scenario searches the known identity from
one fixture-assigned view, requires the canonical Event Details URL to retain
that view, and proves a populated non-member view cannot resolve the occupancy.

Set `ALARM_TRANSFER_CAMERA_WORKFLOW=required` when the Alarm Transfer camera
scanner is part of the release contract. The scenario feeds Chromium a
deterministic 640x480 media stream containing a module-aligned, dense QR version
23 symbol for a 1,170-character valid OSCAR alarm transport. It gates camera
startup, a visible non-zero preview, a non-zero scan overlay contained by that
preview, a visible `Scanning` status, the deterministic active-camera identity
at 640 × 480, integrity and UUID import, complete media-track cleanup, and
visible denied-permission feedback followed by a successful retry. `auto` skips only
when the camera controls are absent; `disabled` always skips this workflow. This
is browser-level scanner coverage, not a physical camera or native
operating-system permission-dialog test.

The canonical future-build fixture is
[`fixtures/oscar-50-lane-config.csv`](fixtures/oscar-50-lane-config.csv). It uses
the current 20-column schema and assigns ten lanes apiece to `east-gate`,
`west-gate`, `north-gate`, `south-gate`, and `pedestrian`. The first five lanes
in each block also belong to `entrance`; the last five belong to `exit`. Apply
this file when provisioning the 50-lane regression site and keep
`OSCAR_LANE_CONFIG_PATH` pointed at that same file. Set
`OPERATIONAL_VIEW_WORKFLOW=required` for 3.9.1-and-newer release gates. Required
mode treats any mismatch in all seven exact lane sets—or failure to preserve the
view query through the real Status of Health navigation link—as a release failure.
The explicit `auto` mode remains compatible with older Viewers by recording a
skip only when the workflow itself is absent.

`OSCAR_SSH_TARGET` enables Docker/host performance sampling and the host-wide
suite lease. It is required by every mutating invocation, including the default
smoke run, reports/national-statistics filters, and both OSCAR 3.9.2 storage gates.
`OSCAR_SSH_IDENTITY_FILE` may point to a dedicated least-privilege key.
`BROWSER_EXECUTABLE_PATH` can select a preinstalled Chrome binary on a runner.

Storage-health is non-destructive but not strictly read-only: its publisher
contract creates and removes private temporary probe data, so the suite-wide
remote lease is held. The full `storage-lifecycle` scenario uses a separately acknowledged disposable
3.9.2 database, registers two synthetic copied observations, and refuses any
cold purge whose plan includes data outside its unique fixture generation. It
also requires the documented zero-day, one-minute-query alarm-media profile on
that disposable test deployment; the packaged and production age default stays
seven days. It does not restore a backup. Daily-file publication verification requires an
overnight/rotation-soak fixture; backup verification can be disabled separately
with `STORAGE_BACKUP_WORKFLOW=disabled`. See
[docs/STORAGE_REGRESSION.md](docs/STORAGE_REGRESSION.md).

The automated storage probe is a Linux SSH/Docker gate. Native Windows Docker
Desktop/PowerShell acceptance is currently deferred and must be recorded as a
separate run; Linux execution and static PowerShell review do not constitute a
Windows pass.

`restore-drill` is a separate destructive profile and cannot be selected by a
smoke/full scenario filter. In addition to the ordinary target and storage
acknowledgements, it requires exact `OSCAR_RESTORE_TARGET_ACK`,
`OSCAR_RESTORE_DISPOSABLE_ACK`, `OSCAR_RESTORE_DATA_LOSS_ACK`, and
`OSCAR_RESTORE_PATHS_ACK` values. The last binds three supplied canonical,
non-overlapping archive, WAL, and backup directories to the authorization. It
creates an authenticated 3.9.2 backup, mutates isolated canaries across the
database, application state, archive, `.env`, secrets, and TLS, fingerprints real
WAL segments before and after that backup, invokes the
supported restore command, and requires every canary plus a fresh promoted PostgreSQL
timeline, preserved backup-era and divergent post-backup WAL, archived timeline history/new WAL without an archiver
failure, a reconstructed exact VERIFIED epoch receipt, cleared one-time recovery state,
all service health, archive verification, and immutable image identities to return. The test backup
and `pre-restore-<backup-id>` safety directory are preserved for operator review.
All raw pre/restore/post resource samples remain in the report. Only the exact
`storage-restore-drill-disruption` phase is exempt from steady-state
running/health/identity checks, and only for `restore-drill`; a real host sample,
pre/post healthy coverage, stable restart counts, and zero OOM kills remain required.

## Results

Each run creates `results/<UTC timestamp>-<runner>/` containing:

- `functional-results.csv` — one row per expected behavior, including correct,
  incorrect, and skipped counts
- `performance.csv` — time-series resource samples by phase and target
- `storage-performance.csv` — PostgreSQL/WAL/batch, archive, journal, retained
  media and compact-metadata/index, and backup point-in-time counters
- `summary.csv` — correctness and resource aggregates
- `errors.csv` — browser, network, API, cleanup, and sampling errors
- `summary.md` — concise narrative PASS/FAIL report
- `run.json` — stable run metadata
- `evidence/` — screenshots and the reserved-RPM recovery snapshot
- `downloads/` — generated PDFs and exported offline alarm JSON/QR image files

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
