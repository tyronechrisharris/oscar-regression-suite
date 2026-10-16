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

## Reserved RPM did not restore

Stop further full runs and follow the manual recovery procedure in
[SAFETY.md](SAFETY.md). The recovery JSON is in the failed run's `evidence/`
directory.

## Report generation times out

Inspect the Viewer message and OSCAR service logs, then retry the individual
`reporting` or `adjudication-report` scenario. Lane/adjudication reports are
intentionally scoped to the reserved lane to avoid an unnecessarily expensive
all-lane query.
