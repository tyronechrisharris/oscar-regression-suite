---
name: oscar-full-regression
description: Deploy, run, diagnose, and report the OSCAR end-to-end regression suite on an authorized emulator-backed test system. Use for release validation, RPM fault/alarm injection, Viewer and SensorHub Admin GUI testing, adjudication and report workflow testing, resource measurement, regression loops, and standardized OSCAR CSV/narrative reports. Do not use against production or physical RPM lanes.
---

# OSCAR Full Regression

Run the repository-backed harness instead of improvising one-off browser or curl
checks. Preserve its evidence and restore the reserved RPM even when a test fails.

## Non-negotiable safety rules

- Treat the full profile as test-lab-only. It stops/restarts one RPM, replaces its
  configuration temporarily, injects faults/alarms, creates a >60-second
  occupancy, and writes permanent OSCAR event/adjudication history.
- Require the user to have authorized the named test systems. An acknowledgement
  variable is an interlock, not authorization.
- Require exact OSCAR_TEST_TARGET_ACK, RPM_EMULATOR_TARGET_ACK, and
  RPM_LANE_MAPPING_ACK values.
- Ensure no other manual operator is using the selected TEST_RPM_ID. Every
  mutating invocation must acquire and hold the host-wide remote suite lease
  through `finally`; it coordinates runners, full/restore runs, and the
  storage-health atomic-publisher probe. Local full/restore locks are additional
  same-runner guards, not the cross-runner authority.
- Never reveal passwords, secret-file contents, private keys, or .env.
- Use strict SSH host-key verification. Verify fingerprints through an already
  trusted path before adding keys. Never bypass host-key checks.
- Do not run destructive SensorHub Admin actions, broad bulk adjudication, or
  physical-device tests.
- Treat every storage probe, including smoke/non-lifecycle `storage-health`, as a
  separately bound remote target: require the exact
  `<viewer-host>|<ssh-target>|<remotely-canonical-release>|DISPOSABLE-STORAGE`
  acknowledgement. Before any remote write or probe action, require that exact
  SSH target to resolve the configured release as an existing, non-root,
  non-symlink directory containing a regular non-symlink `oscar.sh`; revalidate
  that binding for every action.
- Treat `storage-lifecycle` as a second mutation boundary: require a fresh 3.9.2
  test database and the
  probe's one-generation purge guard. Never run it on production/physical lanes
  and never add a restore step to the ordinary regression run.
- Treat `restore-drill` as a distinct destructive profile. It is never part of
  smoke/full and requires the exact target/storage acknowledgements plus the
  restore-specific path binding documented in `docs/STORAGE_REGRESSION.md`.
  Require both `STORAGE_WORKFLOW=required` and
  `STORAGE_BACKUP_WORKFLOW=required`. Run it and the matching
  `3.9.2-release` only from the same available, committed, clean canonical
  40-hex suite HEAD; ignored `.env` and `results/` remain permitted.
  Require the three canonical archive/WAL/backup paths and exact path
  acknowledgement, and run it only on an isolated disposable deployment whose
  PostgreSQL, OSCAR state, archive, WAL, and credentials may all be overwritten.
  Preserve its backup, permission-restricted plaintext safety directory, and
  root-owned bounded failure-diagnostics bundle. If recovery replaces an
  approved credential leaf, require Compose force recreation to guarantee
  file-backed secret rebinding and reset gateway in-memory TLS state, followed
  by 3/3 healthy services.
- Keep result bundles private; they may contain operational and vehicle data.

Read references/TARGET_CHECKLIST.md before deploying to a new runner or target.

## Locate or deploy the suite

Prefer an existing checkout. The canonical Linux runner checkout is
/home/tyrone/projects/oscar-regression-suite. The source repository is
git@github.com:tyronechrisharris/oscar-regression-suite.git.

On a new runner:

1. Verify OS, disk, memory, Node >=20.16, npm, Chrome/Chromium, Git, SSH, and
   network reachability.
2. Clone or fast-forward the checkout; never overwrite local .env or results.
3. Run npm ci, npm run check, npm test, and npm audit --audit-level=high.
4. Create .env from .env.example outside Git and set mode 0600.
5. Prefer preinstalled Chrome with BROWSER_EXECUTABLE_PATH; otherwise run
   npm run install:browser.
6. Configure a dedicated least-privilege SSH key only when remote Docker/host
   metrics are required.

When an OSCAR artifact itself must be built or installed, also use the
oscar-local-build-deploy skill and finish deployment health checks first.

## Required execution sequence

Start from the deployed checkout (for example,
`cd /home/tyrone/projects/oscar-regression-suite`). If invoking the installed
skill wrapper instead, set `OSCAR_REGRESSION_SUITE_DIR` and run
`scripts/run_suite.sh` from the skill directory.

1. Record OSCAR_BUILD_LABEL, EMULATOR_BUILD_LABEL, the reserved RPM/lane,
   expected lane/camera counts, the lane-fixture path, and the operational-view,
   event-UUID, and alarm-transfer-camera workflow modes.
2. Validate suite static checks, unit tests, dependency audit, and the selected
   lane fixture.
3. Run ./scripts/run-regression.sh smoke. This is non-fault-injecting but still
   mutates report/command state and holds the remote suite lease. Require the `dashboard-health`
   baseline: complete lane/RPM/per-camera inventory, every emulator RPM's
   explicit `tamper_fault=false` source state, no Dashboard Tamper Unknown,
   live Online resolution, accessible browser-fixture Offline/Unknown states,
   keyboard lane navigation, every exact expected connection chip to resolve
   Online with an accessible label within 45 seconds, and shared
   latest-observation batches bounded to 10 streams and two in flight. Also
   require `lane-video` to paint live Gamma
   and Neutron data after the real Dashboard-to-Lane Details transition.
4. Inspect summary.md, errors.csv, failed functional rows, and screenshots. Do not
   proceed to mutation if login, target identity, emulator inventory, mapping, or
   connectivity is uncertain.
5. Run ./scripts/run-regression.sh full.
   Require its two one-second alarm occupancies to be triggered back-to-back,
   retain distinct generation-qualified camera paths, and leave the exact OSCAR
   log window free of camera timeout, quarantine, rejection, result-timeout,
   stale-generation, and command-failure symptoms.
6. Preserve the entire latest result directory. Confirm reserved-lane-cleanup is
   correct before accepting the run.
7. If a selector/oracle is wrong, repair the suite, validate it, repeat the
   affected scenario, then repeat full.
8. If OSCAR is wrong and the user requested fixes, repair the correct product
   repository, rebuild/redeploy, and repeat from smoke. Never weaken an assertion
   merely to obtain a pass.

For an OSCAR 3.9.2 storage release gate, read `docs/STORAGE_REGRESSION.md`, set
`STORAGE_WORKFLOW=required`, run `storage-health` after an overnight daily-file
rotation and a configured retained-media fixture for smoke/non-lifecycle coverage,
then run the full `storage-lifecycle` only on its separately acknowledged
disposable database. A full run can self-seed its retained-media proof from the
exact alarm UUIDs it generates; a legacy-media fixture is optional compatibility
coverage, not a release prerequisite.
Do not accept required lifecycle certification with zero proved retained media.
An unfiltered full run must generate and validate at least one exact set; a
lifecycle-only selection must configure `STORAGE_RETAINED_EVENT_ID` and pass
the same API, five-JPEG identity/hash/type/structure, Chromium decode, and
gallery proof before any lifecycle mutation.
Before mutation, require the running OSCAR service's persisted
`videoRetentionConfig` to contain exactly the regression-only acceleration
values `timeToRetention=0`, `videoQueryPeriod=1`,
`enableFrameRetention=true`, `frameRetentionCount=5`, `jpegQuality=85`, and
`sourceRollbackGraceHours=24`, with `metadataReclamationWorkLimit=200`, while
preserving its other fields. Require the archive test profile documented by the
suite (`intervalMinutes=1`, `rollbackGraceDays=1`,
`deleteHotAfterArchive=true`). Do not edit the packaged defaults to satisfy this
gate: production media aging remains seven days and the production archive
policy remains conservative.
Require exact storage schema v5 checksum
`sha256:b37753a17c972d57418545c05a2544068affc7804b8622db3a0f0c4b422c63b5`
before lifecycle mutation and before/after restore. Require DuckDB's exact 256
MiB memory, two-thread, 4,096 MiB spill, two-session process-wide admission,
30-second admission-timeout policy and private archive-disjoint empty
`/var/lib/oscar/duckdb-tmp`; prove the scratch is excluded from backup. Require
the exact direct-daily-file config, a reserved-lane UID append caused by a real
emulator transition, exact bounded 12-key publication manifests, and byte
durability after the supported whole-deployment restart. The restart gate must
also report zero database/module shutdown errors so a concurrent PostgreSQL stop
cannot pass merely because services later become healthy, and zero camera
recording timeout/quarantine/stale-generation errors so a healthy final container
cannot hide a poisoned per-camera command queue.

Require exact-five hash-valid JPEGs, bounded catalog/frame transfers and
frame/event resource budgets, bounded baseline structure plus Chromium decode
and exact dimensions for every quality-85 frame, lazy gallery requests with bounded concurrency,
fallback behavior, schema-2 media metadata health, exact
`retention-processed-index/%019d-%02d.idx` suffixes `00..11`, exact binary
headers/36-byte records, no legacy marker/tombstone growth, journal restart
recovery, archive parity/export and mixed-tier queries, generation- and
archived-observation holds resolving exactly to `GENERATION_EXACT` and
`COLD_RANGE_CONSERVATIVE` with dry-run exclusion, and a `HOT_EXACT` hold that
rejects authenticated deletion until release, plus dry-run/token
safety, independent backup-key HMAC/checksum/exact-inventory verification plus
supported re-verification,
an exact separately HMAC-authenticated `JOURNAL_CONFIRMED` v2 sidecar deliberately
outside the immutable checksum inventory, a bounded canonical backup-time archive-generation
UUID inventory with exact VERIFIED catalog count/SHA-256/byte receipt, and atomic daily-journal
confirmation-set membership for every receipt, exact receipt-to-authenticated-
tar segment path/type/size/SHA-256 reconciliation, and exact once-only regular
retained-media checkpoint, every processed/deletion index, and each proved
event/lane/camera manifest plus `frame-01.jpg` through `frame-05.jpg` in the
authenticated app-state backup with pre-backup path/type/size/SHA-256 identity,
exact tags/running image IDs/OCI labels and
checksum plus all three deployment-bound storage-root markers, stable private
deployment lock rejection, exact WAL command and packaged/running helper hashes,
compiled atomic-publisher source provenance and no-replace collision behavior,
no full backup-root mount in either long-running service and isolated one-shot
base-backup wiring, atomic no-replace hard-link WAL publication, no archive/WAL partial artifacts,
controlled stale-activation rollback with
exact-row retry ownership, deployed archive/WAL helper behavior,
checksums/pg_stat, and storage/resource metrics.

`LEGACY_UNKNOWN` is migration-only for pre-v5 observation holds; never accept it
as CLI output. Pre-v5 generation holds must migrate to `GENERATION_EXACT`.

Only when the user has explicitly authorized a destructive isolated recovery
test and all documented acknowledgements are present, set both
`STORAGE_WORKFLOW=required` and `STORAGE_BACKUP_WORKFLOW=required`, then run
`npm run test:restore-drill` separately. Require pre-backup canaries to return
across the database, application state, archive, WAL, `.env`, secrets, and TLS;
require every component of the empty archive partition/profile canary hierarchy
to be runtime-owned and owner-writable/searchable before backup;
require promotion onto a timeline newer than the base backup, byte-identical
append-only preservation of fingerprinted backup-era and post-backup source-timeline
WAL, an archived timeline-history
file and new-timeline segment with no post-start archiver failure, exact reconstruction
of the authenticated `VERIFIED` epoch receipt, removal of one-time recovery settings
and signals, healthy services, archive verification, and unchanged immutable image
IDs. The acknowledged storage planes must resolve exactly and remain distinct and
non-overlapping. Require the private safety copy to preserve the exact mutated
`.env`/secrets/TLS names, contents, owners, groups, and modes with no links.
Keep every raw resource sample. Exempt only the exact
`storage-restore-drill-disruption` phase from steady-state service checks, and
only in this profile; require a real target-host sample during it, healthy
pre/post coverage, immutable image identity, stable restart counts per identity,
and no OOM in any phase.
Use the separate bounded `STORAGE_RESTORE_PROBE_TIMEOUT_MS` (default 7,200,000
ms, accepted range 600,000–28,800,000 ms) for the destructive workflow; do not
inflate the ordinary `STORAGE_PROBE_TIMEOUT_MS`. If that deadline is crossed,
require the runner to retain the disruption phase; the deadline bounds the
primary SSH wait, while fail-closed quiescence can take longer. Require an
atomically pre-armed launch gate so cancellation and a delayed SSH launch cannot
both win. The exact remote probe-session PID/start-time/PGID/SID must have no
remaining member before an atomic status is terminal and post-restore oracles
execute. A timeout is a failure and must not be hidden by extending the bound
around a stalled or algorithmically excessive product restore. Treat malformed,
linked, or incorrectly permissioned control state as nonterminal and retain the
remote lease for investigation.
Never reinterpret a smoke/full request as restore authorization.

For final 3.9.2 certification, first preserve a complete unfiltered
`restore-drill` PASS. Set all five operational-view/UUID/camera/storage/backup
workflows to `required`, set the exact `OSCAR_BUILD_LABEL`, point
`OSCAR_3_9_2_RESTORE_EVIDENCE_DIR` at that matching result directory, and run
`npm run test:3.9.2-release` with no scenario filter. Do not accept a release run
with mismatched identity, missing evidence, any skip/failure, or an incomplete
restore attestation.

The smoke Dashboard Offline/Unknown checks are browser-only response fixtures;
they do not disconnect cameras or mutate SensorHub. The full profile separately
requires real Dashboard transitions during reserved-RPM stop/restart, fault
injection/clear, in-place tamper clear, and extended occupancy. Do not describe
this as live camera disconnect/reconnect coverage.

The live smoke Tamper baseline is not a response fixture. It requires each
emulator RPM to explicitly model `tamper_fault=false` and the Dashboard to
resolve every lane without Tamper Unknown after OSCAR's Rapiscan driver publishes
its required initial clear observation for each newly established connection,
before processing later `TT`/`TC` messages. Never infer Tamper clear from an
Online icon or bulk toggle Tamper to seed observations.

For diagnosis, pass a scenario filter such as:
./scripts/run-regression.sh full --scenario rpm-faults,adjudication

Full-profile filters still perform mandatory setup and cleanup.

For a Viewer release that claims occupancy UUID lookup and export support, set
`EVENT_UUID_WORKFLOW=required` and include `event-uuid` (or run the unfiltered
full profile). Leave the default `auto` only when older deployments must remain
testable; it records the absent capability as skipped. With operational views
enabled, require the generated UUID to resolve from a view assigned to the
reserved lane, retain that view through canonical navigation, and fail closed
for the same UUID from a populated non-member view.

For alarm-transfer release validation, require a received JSON package to render
every non-empty gamma/neutron series with its chart-specific dataset color and
download with the same canonical payload, integrity, transport, and occupancy
UUID. Export-only QR sizing metadata may be omitted from the received download.
Uploading or decoding the package alone is not sufficient evidence that offline
review is usable.

For a Viewer release that claims Alarm Transfer camera scanning, set
`ALARM_TRANSFER_CAMERA_WORKFLOW=required` and include `alarm-transfer-camera`
(or run the unfiltered profile). The harness uses a deterministic Chromium
640x480 stream carrying its generated dense QR v23/1,170-character OSCAR alarm
fixture. Require camera startup, a visible non-zero preview, a non-zero scan
overlay contained within the preview, a visible `Scanning` status, the
deterministic active-camera identity at 640 × 480, integrity and UUID import,
complete track cleanup, and denied-permission feedback plus a successful retry. This does not
validate physical camera hardware or the native OS prompt.

For canonical 50-lane release regression, set both:

```text
OSCAR_LANE_CONFIG_PATH=fixtures/oscar-50-lane-config.csv
OPERATIONAL_VIEW_WORKFLOW=required
```

Resolve a relative fixture path from the regression-suite checkout. `required`
must make a missing, malformed, or mismatched fixture/site assignment fail; do
not accept an operational-view skip as a release pass. Retain `auto` only for an
explicit legacy or noncanonical deployment, and use `disabled` only when the
requested test scope explicitly excludes this capability.

## Canonical operational-view oracle

The selected fixture is the membership oracle, not merely seed data:

| Lanes | Primary key | First five in block | Last five in block |
| --- | --- | --- | --- |
| Lane01-Lane10 | `east-gate` | `entrance` | `exit` |
| Lane11-Lane20 | `west-gate` | `entrance` | `exit` |
| Lane21-Lane30 | `north-gate` | `entrance` | `exit` |
| Lane31-Lane40 | `south-gate` | `entrance` | `exit` |
| Lane41-Lane50 | `pedestrian` | `entrance` | `exit` |

Require 50 unique lanes; exactly two distinct keys per lane; 10 lanes in each
primary view; 25 in `entrance`; 25 in `exit`; and five in every
primary/direction intersection. Lane names must be `Lane01` through `Lane50`,
unique IDs must be `lane-01` through `lane-50`, and each fixture cell must order
the primary key before the direction key.

Exercise all seven exact sets rather than accepting a nonzero scoped row count.
For each key, enter on the scoped Dashboard, follow the actual Status of Health
navigation link, prove the `view` query survives, and compare the health rows to
the fixture-derived lane set. A malformed key, a well-formed but unassigned key,
and duplicate `view` parameters must each fail closed with zero health rows.

CSV upload does not migrate matching `UniqueID` values. If a persistent target
already has the 50 lanes, prove its live memberships match the fixture before
testing. A successful upload alone is insufficient; use supported Admin edits,
select global Save, confirm **Yes** in its separate dialog, and require the
**SensorHub Configuration Saved** notification. Then perform one supported
restart and prove all expected Lane, RPM, and camera modules return. Merely
opening the confirmation dialog is not a save. Explicitly reprovision a
disposable site when migration is needed. Do not delete volumes or reinitialize
a target as a shortcut.

## Interruption and recovery

Normal errors and handled signals enter cleanup. A hard kill, power loss, network
loss, or another runner can still strand emulator state.

If cleanup is not proven correct:

1. Stop further full runs.
2. Keep the local lock and result directory until the reserved RPM is inspected;
   do not delete the remote lock file (the kernel lease releases with its SSH process).
3. Read evidence/reserved-rpm-original-config.json and
   evidence/reserved-rpm-original-state.json.
4. Clear injected faults, stop the RPM, PUT the exact saved configuration,
   restore original fault/running state, and verify the expected client count.
5. Compare the restored configuration structurally and verify Status of Health.
6. Remove a stale local lock only after recovery is verified. Never remove the
   remote suite lock path to defeat live contention.

## Interpret and deliver results

Read references/REPORT_INTERPRETATION.md when summarizing a run.

Always report the repository commit and build labels; runner/targets/RPM/lane;
profile, fixture, workflow modes, and timestamps; correct/incorrect/skipped
totals; failed actions;
per-action fault/alarm/adjudication counts; peak and average runner/OSCAR
CPU/memory; missing samples, OOMs, or restarts; errors and evidence; cleanup
status; and PASS, FAIL-product, FAIL-environment, or FAIL-harness classification.

Do not call the suite exhaustive beyond the checkout's `docs/COVERAGE.md`.
Native OS dialogs,
destructive Admin changes, broad bulk adjudication, external WebID, physical QR
hardware, HA/failover, soak/load, permissions matrices, and
cross-browser/accessibility are explicit exclusions.

When one supported target platform is unavailable, run every safe source-level
and native-script check that remains available, but classify that platform's
real Docker acceptance as deferred or waived. Never infer a Windows deployment
pass from Linux execution or from parsing the PowerShell scripts.
