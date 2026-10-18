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

The performance row requires latest-observation batches of no more than 50
streams and no more than two requests in flight. A failure here indicates a
Dashboard query regression, not a host CPU threshold. Offline and Unknown UI
checks use browser-only response fixtures; they do not disconnect cameras or
modify SensorHub data. Preserve the evidence screenshot and do not weaken the
batch or accessibility assertions to accommodate a failing build.

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

## Report generation times out

Inspect the Viewer message and OSCAR service logs, then retry the individual
`reporting` or `adjudication-report` scenario. Lane/adjudication reports are
intentionally scoped to the reserved lane to avoid an unnecessarily expensive
all-lane query.

## Retained fixture ID is missing

`STORAGE_RETAINED_EVENT_ID` remains required for a required smoke/non-lifecycle
retained-media proof. A normal unfiltered full run intentionally reports the
early check as deferred, then uses an exact UUID produced by `rpm-alarms`,
`event-uuid`, or `adjudication` and runs the API/decode and Viewer gallery proof
after `storage-lifecycle` retains it. If a scenario filter selects
`storage-health` but omits `storage-lifecycle` or all three alarm-producing
scenarios, configure an already-retained event ID or expand the filter. A
`self-seed retained-media proof` failure means the run promised this generated
fixture but no exact alarm association reached retention; inspect the earlier
alarm-media outcomes rather than substituting an unrelated historical event.

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

## Generated alarm retention times out

The full target must be disposable and its persisted OSCAR service config must
have `timeToRetention=0`, `videoQueryPeriod=1`,
`enableFrameRetention=true`, `frameRetentionCount=5`, `jpegQuality=85`, and
`sourceRollbackGraceHours=24`, with `metadataReclamationWorkLimit=200`.
Lifecycle preflight reports the observed `videoRetention` object and refuses the
test before polling if any value differs. Seven days is the correct production
default, but cannot retain a freshly generated alarm during this run.

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
