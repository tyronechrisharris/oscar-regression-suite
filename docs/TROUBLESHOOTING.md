# Troubleshooting

## Browser executable missing

Run `npm run install:browser`, or set `BROWSER_EXECUTABLE_PATH` to a working
Chrome/Chromium binary. On NVM installations, use `scripts/run-regression.sh` so
noninteractive SSH can find Node.

## OSCAR login fails

Verify both the HTTP authentication layer and OSCAR session credentials. The
suite signs in through the Viewer form when required and then validates `/session`.
Do not paste passwords into logs or command output.

## `oscar.local` does not resolve

Use the OSCAR machine's IP address in `OSCAR_BASE_URL`, or intentionally configure
DNS/hosts on the runner. A name resolving on a workstation does not imply it
resolves on the Linux runner.

## Performance fields are empty

Functional coverage does not require SSH. For host/container sampling, verify the
runner has the exact host key in `known_hosts`, the dedicated key works in batch
mode, and the remote account can run read-only Docker commands.

## Camera stays `Waiting`

This is a failing Status of Health result even if an HLS stream plays elsewhere.
Preserve `health-unresolved-connections.png`, confirm camera observations are
being published for the lane, and compare the camera system/datastream identity
with the Viewer health query. Do not weaken the assertion to hide `Waiting`.

## Dashboard health scenario fails

Use the failing row and screenshot to distinguish inventory/state failures from
the request-bound check. Inventory failures usually mean the Viewer lane map or
camera-system identity no longer matches the configured site. Live connection
failures mean at least one latest connection observation did not resolve
Online; compare that component with Status of Health before retrying.

The performance row requires latest-observation batches of no more than 10
streams and no more than two requests in flight. A failure here indicates a
Dashboard query regression, not a host CPU threshold. Offline and Unknown UI
checks use browser-only response fixtures; they do not disconnect cameras or
modify SensorHub data. Preserve the evidence screenshot and do not weaken the
batch or accessibility assertions to accommodate a failing build.

If the failure reports `Tamper: Unknown`, compare both baseline rows. The
emulator-source row must show every RPM running, OSCAR-connected, and explicitly
`tamper_fault=false`; the Dashboard row must then show all lanes clear with no
Unknown indicator. A source-row failure is an emulator inventory/state problem.
A passing source row plus a failing Dashboard row means OSCAR's Rapiscan driver
did not publish or retain its required initial Tamper-clear observation when the
RPM connection was established. Inspect or upgrade OSCAR's driver and reconnect
the authorized test RPMs so that initialization path runs before later `TT`/`TC`
messages are processed. Do not infer clear from an Online icon and do not bulk
toggle Tamper just to seed observations.

## Lane Details shows only Threshold or empty measurement charts

The `lane-video` scenario navigates from Dashboard to Lane Details and requires
actual red Gamma and blue Neutron plot pixels, excluding title/legend regions.
If this row fails while the canvases and video pass, preserve
`lane-detail-live-telemetry.png` and inspect the Gamma/Neutron real-time
datasource subscription lifecycle during the route transition. A visible chart
container or a purple Threshold series is not evidence that measurement data is
flowing.

## Viewer navigation reports `net::ERR_TOO_MANY_RETRIES`

The suite treats this exact Chromium connection-pool error as a bounded
transport transient. It records the first failure as a warning, requires both
the gateway `/healthz` endpoint and the authenticated `/session` endpoint to
pass, waits one second, and retries the same idempotent navigation once. A
failed probe, any other network error, or a second failure remains a failed
functional check. Inspect the warning together with gateway status codes and
the OSCAR host/container samples; do not add broad or repeated retries.

## Reserved RPM did not restore

Stop further full runs and follow the manual recovery procedure in
[SAFETY.md](SAFETY.md). The recovery JSON is in the failed run's `evidence/`
directory.

## Extended occupancy stays Clear or shows less than the configured duration

Do not infer a product fault from the emulator's wall-clock occupancy alone.
Replacing the reserved RPM configuration restarts its TCP server; the emulator
may enter `OCCUPIED` before OSCAR's old connection reaches its heartbeat timeout
and reconnects. The Viewer intentionally uses the canonical start time OSCAR
actually observed and activates the default fault only when elapsed time is
strictly greater than 60 seconds. Consequently, a former 70-second fixture
could leave fewer than 60 observable seconds and legitimately remain Clear.

Use the tracked default/minimum `EXTENDED_OCCUPANCY_SECONDS=150`. It budgets the
complete 60-second reconnect allowance plus a 30-second post-threshold window
for both UI assertions. If a 150-second run still fails, compare the emulator
client/reconnect timestamps, the displayed occupancy duration, and the two UI
rows. Do not weaken the strict threshold assertion or reinterpret a second
automatic occupancy as proof of the first.

## Report generation times out

Inspect the Viewer message and OSCAR service logs, then retry the individual
`reporting` or `adjudication-report` scenario. Lane/adjudication reports are
intentionally scoped to the reserved lane to avoid an unnecessarily expensive
all-lane query.

## Retained fixture ID is missing

`STORAGE_RETAINED_EVENT_ID` remains required for a required smoke/non-lifecycle
retained-media proof. A normal unfiltered full run intentionally reports the
early check as deferred, then uses an exact public observation ID produced by `rpm-alarms`,
`event-uuid`, or `adjudication` and runs the API/decode and Viewer gallery proof
after `storage-lifecycle` retains it. If a scenario filter selects
`storage-health` but omits `storage-lifecycle` or all three alarm-producing
scenarios, configure an already-retained event ID or expand the filter. A
`self-seed retained-media proof` failure means the run promised this generated
fixture but no exact alarm association reached retention; inspect the earlier
alarm-media outcomes rather than substituting an unrelated historical event.
The field is the opaque durable OSH ID displayed by Viewer as “Event UUID”; short
encoded values such as `0i4d0ko` are valid. Do not translate one into a synthetic
RFC 4122 UUID. The suite requires the configured string to match the observation,
retained-media response, manifest, asset paths, and Viewer result exactly.

For a fresh disposable full run, leave `STORAGE_RETAINED_EVENT_ID` and
`STORAGE_LEGACY_EVENT_ID` empty so the suite self-seeds current evidence. An ID
left over from a previous database is not reusable: if its observation API
lookup returns 404, clear it or replace it with an event that exists in the
current deployment. Never weaken the retained-media oracle to accept a stale
identifier.

## Daily-file publication is empty on a fresh same-day install

Read the `daily-file` result's `zoneId`, `currentDate`, and
`eligiblePriorDayDirectories`. Zero CSVs is correct only when no completed day
exists in that configured zone and the probe reports
`publication not yet eligible` after validating durable current-day `DJNL` v1
segments. If any prior lane/day directory is eligible, the suite requires valid
12-key v1 CSV/manifest pairs and fails an empty publication directory. Never
rename current segments or create synthetic daily files to satisfy this gate.

## Generated alarm media association fails

Start with the `alarm-media` rows in `functional-results.csv`. A camera-catalog
failure means the reserved lane's camera `data-component-id` did not resolve to
one unique UID in the authenticated OSH systems catalog; do not substitute the
emulator's opaque `camera_ids`. A path failure means the exact occupancy has a
missing, duplicate, foreign-camera, blank, or non-generation-qualified
`result.videoPaths` value. The only accepted source form is
`videos/clips/<camera-token>/<timestamp>-g<positive-generation>.mp4`.

If source status fails, inspect only the reported paths and preserve OSCAR logs.
If a source is nonzero but Chromium metadata fails, inspect the browser/network
response and codec logs; file existence alone is not a valid substitute.

If `keep camera command queues healthy across short occupancies` fails, preserve
the complete result bundle and the OSCAR service logs for the reported run
window. A nonzero timeout/quarantine or queue-rejection count means a camera
operation inherited time spent behind another generation or remained genuinely
hung; do not rerun until it happens to pass. A stale-generation count means the
saved path was not owned by the occupancy that requested it. The probe reports
counts only so routine regression artifacts do not copy unrelated service-log
content.

## Generated alarm retention times out

The full target must be disposable and its persisted OSCAR service config must
have `timeToRetention=0`, `videoQueryPeriod=1`,
`maximumCatchUpHours=6`, `lateArrivalOverlapHours=24`,
`lateArrivalScanPeriodMinutes=360`, `lateArrivalCatchUpHours=2`,
`reconciliationCatchUpHours=24`, `reconciliationPeriodHours=24`, and
`occupancyStreamRefreshMinutes=15`,
`enableFrameRetention=true`, `frameRetentionCount=5`, `jpegQuality=85`, and
`sourceRollbackGraceHours=24`, with `maintenanceWorkLimit=200` and
`metadataReclamationWorkLimit=200`.
Lifecycle preflight reports the observed `videoRetention` object and refuses the
test before polling if any value differs. One day is the production eligibility
default, but cannot retain a freshly generated alarm during this run.

Also inspect the `verify accelerated retained-media worker is active` row. A
correct saved form with a stale scan cursor means OSCAR started before that form
was applied: perform a supported restart. A cursor many hours or days behind is
bounded catch-up from an earlier seven-day runtime profile. On an otherwise empty,
fresh disposable target, recreate the disposable database and application state,
save the accelerated profile before provisioning lanes, restart, and verify the
cursor before allowing emulator traffic. Do not delete or fast-forward retention
scan/reconciliation checkpoints; doing so can force a safety-first scan from an
old datastore range instead of proving that the intended runtime profile is active.

For a manifest/ledger failure, use the exact event and camera UIDs in the result.
Confirm `manifest.source.objectKey` equals the earlier observation path and
inspect only that deterministic `.job.json`. `FAILED`, a nonblank failure, or
`attempts` other than one is a new-run failure; do not erase historical ledgers.

## Alarm-media orphan or partial check fails

The diff first subtracts the pre-trigger run baseline, then considers only
camera-directory tokens bound to this run's exact generated events. Pre-existing
files and failures do not count. Keep the reserved RPM quiet until
`storage-lifecycle` ends and stop manual triggers for the same lane. A new extra
MP4 usually means a camera close was not bound to a generated UUID; a new partial
means a write was interrupted or incomplete.

Normal and error cleanup remove the root-owned mode-0600
`/tmp/oscar-alarm-media-<run-key>.baseline` through a validated privileged probe
action. After a host/runner hard kill, preserve it with the run results until the
cause is understood; remove only that exact run-key marker on the disposable
target, never a broad `/tmp` pattern.
