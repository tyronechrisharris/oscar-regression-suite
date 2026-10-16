# Coverage matrix

The suite combines browser-visible assertions with independent API/emulator
oracles. A rendered control alone is not considered proof of a working workflow.

| Area | Assertion | Profile | Mutation |
| --- | --- | --- | --- |
| Authentication | login/session identity and protected Viewer access | smoke | session only |
| Navigation | dashboard, events, health, reports, transfer, map, national, servers | smoke | none |
| Map | interactive map has a non-zero rendered area | smoke | none |
| National | statistics command returns HTTP success and local-node row renders | smoke | statistics command/bucket data |
| Servers | local node list and add-server form render | smoke | none |
| Admin | SensorHub Admin loads and exposes configured sensor/module content | smoke | none |
| Health inventory | expected lane and camera counts; all fault fields present | smoke | none |
| Connections | reserved RPM and every configured camera resolve Online | smoke | none |
| Lane detail | charts and event table render | smoke | HLS start/stop commands |
| Video | decoded dimensions, ready state, and advancing playback time | smoke | HLS start/stop commands |
| Events | rows load and Advanced Filter returns only the requested lane | smoke | none |
| Operational views | invalid key fails closed; optional configured key stays scoped | smoke | none |
| Reports | site, one-lane lane, alarm, alarm/occupancy, and health PDFs | smoke | report bucket writes |
| Alarm import | malformed payload is rejected visibly | smoke | none |
| RPM connection | stop/restart appears Offline/Online | full | reserved RPM only |
| Faults | gamma high/low, neutron high, and tamper assert and clear | full | reserved RPM only |
| Alarms | deterministic gamma and neutron alarms reach Event Log | full | permanent event data |
| Event identity | capture the persisted occupancy UUID; verify details, UUID search, canonical direct link, clipboard actions, fresh-page resolution, explicit not-found state, print-to-PDF text, and QR v1 round-trip | full | one permanent alarm event; local clipboard/artifacts |
| Alarm transfer | selected alarm JSON round-trip and SHA-256 integrity | full | local artifact only |
| Adjudication | Code 9 submission, confirmation, success, audit display | full | permanent audit record |
| Extended occupancy | duration over configured threshold faults, then clears | full | reserved RPM only |
| Adjudication report | one-lane PDF is generated and validated | full | report bucket write |
| Performance | runner plus optional host/container time series and aggregates | both | read-only SSH |

## Deliberate exclusions

The following are not automatic gating checks because they are destructive,
external, or depend on nondeterministic operating-system UI:

- applying/saving SensorHub Admin configuration, restarting arbitrary modules,
  or removing lanes
- “select all filtered” bulk adjudication outside an isolated synthetic fixture;
  it can permanently adjudicate unseen historical pages
- external WebID services
- a physical camera scanning a QR code; JSON/image import is the deterministic
  equivalent
- native Share and print dialogs; the suite validates copied link text and uses
  Chromium print-to-PDF against the same print media rather than automating an
  operating-system dialog
- creating or changing operational-view metadata; a preconfigured view can be
  checked by setting `OPERATIONAL_VIEW_KEY`

These require a disposable deployment and a separate, explicit test plan.

## Scenario names

`preflight`, `viewer-navigation`, `map-national-servers`, `sensorhub-admin`,
`status-of-health`, `lane-video`, `event-filtering`, `operational-views`,
`reporting`, `alarm-transfer`, `rpm-connection`, `rpm-faults`, `rpm-alarms`,
`event-uuid`, `adjudication`, `extended-occupancy`, and `adjudication-report`.

`event-uuid` is capability-gated with `EVENT_UUID_WORKFLOW`. Its default `auto`
mode skips cleanly on older Viewer builds; use `required` for builds that claim
the feature. The not-found check uses a newly generated identity and never
deletes an event.

`reserved-lane-setup` and `reserved-lane-cleanup` are mandatory harness phases
for every full-profile run and cannot be suppressed by a scenario filter.
