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
| Dashboard health | expected lane/RPM/per-camera indicator inventory; accessible live Online states; one selected camera Offline while every other component stays Online; deterministic all-Offline and completed Unknown reconciliation; all five exact Unknown fault labels; live recovery; keyboard lane navigation; health batches of at most 50 streams with at most two requests in flight | smoke | browser response fixtures only |
| Lane detail | charts and event table render | smoke | HLS start/stop commands |
| Video | decoded dimensions, ready state, and advancing playback time | smoke | HLS start/stop commands |
| Events | rows load and Advanced Filter returns only the requested lane | smoke | none |
| Operational views | fixture-derived exact Dashboard card/RPM/camera membership and Status of Health lane sets for east/west/north/south/pedestrian/entrance/exit; Dashboard-to-Health query persistence; invalid, unassigned, and duplicate parameters fail closed | smoke | none |
| Reports | site, one-lane lane, alarm, alarm/occupancy, and health PDFs | smoke | report bucket writes |
| Alarm import | malformed payload is rejected visibly | smoke | none |
| Alarm camera import | deterministic Chromium 640x480 stream starts; preview and contained scan overlay are visible and non-zero; visible status says `Scanning`; active camera reports the deterministic identity and 640 × 480; dense QR v23/1,170-character transport decodes with valid integrity and UUID; all tracks stop; denied permission is reported and retry succeeds | both | local generated media only |
| RPM connection | stop/restart appears Offline/Online on Status of Health and the Dashboard while camera state remains independently Online | full | reserved RPM only |
| Faults | gamma high/low, neutron high, and tamper assert and clear on Status of Health and the Dashboard; Dashboard tamper clear stays in place, posts the real SensorHub control command, and clears the observed state | full | reserved RPM only |
| Alarms | deterministic gamma and neutron alarms reach Event Log | full | permanent event data |
| Event identity | capture the persisted occupancy UUID; verify details, UUID search, canonical direct link, clipboard actions, fresh-page resolution, explicit not-found state, print-to-PDF text, and QR v1 round-trip | full | one permanent alarm event; local clipboard/artifacts |
| Alarm transfer | selected alarm JSON round-trip and SHA-256 integrity; actual exported QR PNG uploads and imports successfully | full | local artifacts only |
| Adjudication | Code 9 submission, confirmation, success, audit display | full | permanent audit record |
| Extended occupancy | duration over configured threshold faults, then clears on Status of Health and the Dashboard | full | reserved RPM only |
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
- physical camera hardware, lighting/focus behavior, and the native
  operating-system camera permission prompt; the suite instead gates the web
  scanner with a deterministic generated Chromium media stream and exercises
  denied-permission feedback inside the browser fixture
- live camera disconnect/reconnect fault injection; all configured cameras must
  be Online against live data, while browser-only fixtures deterministically
  exercise every camera's Offline and Unknown Dashboard presentation
- native Share and print dialogs; the suite validates copied link text and uses
  Chromium print-to-PDF against the same print media rather than automating an
  operating-system dialog
- applying operational-view metadata inside a run; the tracked 50-lane CSV must
  be applied while provisioning the disposable site, then the suite reads that
  same file as its membership oracle

These require a disposable deployment and a separate, explicit test plan.

## Scenario names

`preflight`, `viewer-navigation`, `map-national-servers`, `sensorhub-admin`,
`status-of-health`, `dashboard-health`, `lane-video`, `event-filtering`, `operational-views`,
`reporting`, `alarm-transfer`, `alarm-transfer-camera`, `rpm-connection`,
`rpm-faults`, `rpm-alarms`, `event-uuid`, `adjudication`, `extended-occupancy`,
and `adjudication-report`.

`dashboard-health` is a read-only browser scenario. It verifies the complete
lane/RPM/camera inventory and live Online state, then intercepts only the
Dashboard's batched latest-observation responses to prove accessible Offline
and Unknown rendering without changing SensorHub or emulator state. The full
profile separately stops/restarts the reserved RPM and injects each supported
fault to verify real Dashboard transitions and recovery.

`event-uuid` is capability-gated with `EVENT_UUID_WORKFLOW`. Its default `auto`
mode skips cleanly on older Viewer builds; use `required` for builds that claim
the feature. The not-found check uses a newly generated identity and never
deletes an event.

`alarm-transfer-camera` is capability-gated with
`ALARM_TRANSFER_CAMERA_WORKFLOW`. Its default `auto` mode skips cleanly on older
Viewers without camera controls; use `required` for builds that claim the
scanner. The fixture is a 640x480 Chromium media stream containing a
module-aligned QR version 23 symbol (109 modules plus a four-module quiet zone,
rendered at three pixels per module) for a 1,170-character OSCAR alarm transport.
The density intentionally detects scanners that crop to the former centered
320-pixel region and requires the repaired scanner's roughly 420-pixel native
square. The scenario verifies a visible non-zero preview, a non-zero scanner
overlay fully contained within that preview, a visible `Scanning` status, the
deterministic active-camera identity at 640 × 480, successful integrity and
UUID import, stopped tracks, and denied-permission feedback with a successful retry.
The full-profile alarm transfer also uploads the actual QR PNG exported by the
Viewer rather than reconstructing an equivalent image.

`operational-views` is capability-gated with `OPERATIONAL_VIEW_WORKFLOW`. In
`required` mode, all seven keys from `OSCAR_LANE_CONFIG_PATH` are mandatory and
must expose exactly the fixture lanes. `auto` skips cleanly only on legacy
Viewers without the operational-view workflow; once detected, membership and
fail-closed checks remain gating.

`reserved-lane-setup` and `reserved-lane-cleanup` are mandatory harness phases
for every full-profile run and cannot be suppressed by a scenario filter.
