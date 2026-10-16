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
- Ensure no other runner or operator is using the selected TEST_RPM_ID. The
  harness lock is local to one runner and cannot coordinate other machines.
- Never reveal passwords, secret-file contents, private keys, or .env.
- Use strict SSH host-key verification. Verify fingerprints through an already
  trusted path before adding keys. Never bypass host-key checks.
- Do not run destructive SensorHub Admin actions, broad bulk adjudication, or
  physical-device tests.
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

1. Record OSCAR_BUILD_LABEL, EMULATOR_BUILD_LABEL, the reserved RPM/lane, and
   expected lane/camera counts.
2. Validate suite static checks, unit tests, and dependency audit.
3. Run ./scripts/run-regression.sh smoke.
4. Inspect summary.md, errors.csv, failed functional rows, and screenshots. Do not
   proceed to mutation if login, target identity, emulator inventory, mapping, or
   connectivity is uncertain.
5. Run ./scripts/run-regression.sh full.
6. Preserve the entire latest result directory. Confirm reserved-lane-cleanup is
   correct before accepting the run.
7. If a selector/oracle is wrong, repair the suite, validate it, repeat the
   affected scenario, then repeat full.
8. If OSCAR is wrong and the user requested fixes, repair the correct product
   repository, rebuild/redeploy, and repeat from smoke. Never weaken an assertion
   merely to obtain a pass.

For diagnosis, pass a scenario filter such as:
./scripts/run-regression.sh full --scenario rpm-faults,adjudication

Full-profile filters still perform mandatory setup and cleanup.

For a Viewer release that claims occupancy UUID lookup and export support, set
`EVENT_UUID_WORKFLOW=required` and include `event-uuid` (or run the unfiltered
full profile). Leave the default `auto` only when older deployments must remain
testable; it records the absent capability as skipped.

## Interruption and recovery

Normal errors and handled signals enter cleanup. A hard kill, power loss, network
loss, or another runner can still strand emulator state.

If cleanup is not proven correct:

1. Stop further full runs.
2. Keep the lock and result directory until the reserved RPM is inspected.
3. Read evidence/reserved-rpm-original-config.json and
   evidence/reserved-rpm-original-state.json.
4. Clear injected faults, stop the RPM, PUT the exact saved configuration,
   restore original fault/running state, and verify the expected client count.
5. Compare the restored configuration structurally and verify Status of Health.
6. Remove a stale local lock only after recovery is verified.

## Interpret and deliver results

Read references/REPORT_INTERPRETATION.md when summarizing a run.

Always report the repository commit and build labels; runner/targets/RPM/lane;
profile and timestamps; correct/incorrect/skipped totals; failed actions;
per-action fault/alarm/adjudication counts; peak and average runner/OSCAR
CPU/memory; missing samples, OOMs, or restarts; errors and evidence; cleanup
status; and PASS, FAIL-product, FAIL-environment, or FAIL-harness classification.

Do not call the suite exhaustive beyond the checkout's `docs/COVERAGE.md`.
Native OS dialogs,
destructive Admin changes, broad bulk adjudication, external WebID, physical QR,
HA/failover, soak/load, permissions matrices, and cross-browser/accessibility are
explicit exclusions.
