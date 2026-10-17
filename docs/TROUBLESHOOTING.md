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
