# Coverage matrix

The suite combines browser-visible assertions with independent API/emulator
oracles. A rendered control alone is not considered proof of a working workflow.

| Area | Assertion | Profile | Mutation |
| --- | --- | --- | --- |
| Authentication | login/session identity and protected Viewer access | smoke | session only |
| Gateway caching | authenticated hashed Viewer bundles return private one-year immutable caching while `/sw.js` requires revalidation; a clean unauthenticated request for the same protected bundle returns 401/403 without public, immutable, or positive-age cache directives | smoke | none |
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
| Event identity | capture the persisted occupancy UUID; verify details, UUID search, canonical direct link, clipboard actions, fresh-page resolution, explicit not-found state, assigned-view query preservation, non-member-view fail-closed behavior, print-to-PDF text, and QR v1 round-trip | full | one permanent alarm event; local clipboard/artifacts |
| Alarm transfer | selected alarm JSON round-trip and SHA-256 integrity; each imported non-empty series redraws with its chart-specific dataset color; the received package downloads with the same canonical payload, integrity, transport, and UUID while export-only QR metadata may be omitted; the actual exported QR PNG uploads and imports successfully | full | local artifacts only |
| Adjudication | Code 9 submission, confirmation, success, audit display | full | permanent audit record |
| Extended occupancy | duration over configured threshold faults, then clears on Status of Health and the Dashboard | full | reserved RPM only |
| Adjudication report | one-lane PDF is generated and validated | full | report bucket write |
| Performance | runner plus optional host/container time series and aggregates | both | read-only SSH |
| Storage platform | exact 3.9.2 app/PostGIS tags and OCI labels, pinned gateway tag, running/local immutable image IDs and available digests, exact checksum marker plus three deployment/kind-bound storage-root v1 markers and modes, stable private deployment lock with concurrent-command rejection, packaged/running app, WAL-publisher, restore-preparation, and append-only WAL-merge helper hash parity, compiled atomic publisher source-stamp parity and first-publish/collision-preservation behavior, no full-backup-root mount in either long-running service plus isolated one-shot base-backup wiring, exact PostgreSQL `archive_command`, no archive/WAL partial artifacts, data checksums, pg_stat_statements, schema v4, batch rewrite, archive checksum/catalog/parity health, and storage counters | smoke | read-only SSH |
| Retained media | exact five quality-85 canonical, hash-valid bounded baseline JPEGs per camera; every frame independently decodes in Chromium at its declared dimensions; strict streaming catalog/frame and event resource budgets; lazy selected-frame Viewer loading with a measured three-request concurrency ceiling and decoded content replacement; legacy-video fallback on retained API 404 | smoke | none |
| Daily files | publication/manifest completeness with no partials; restart recovery in full | both | OSCAR restart in full |
| Tiered archive | deterministic cold fixture; controlled post-export source-row race with stale activation rollback and exact one-row retry ownership; parity; packaged CLI export/purge helper wiring plus deployed helper verify/copy/rejection checks; portable export; cold-by-ID and mixed hot/cold query; grace/seal/hot deletion | full | registered disposable rows only |
| WAL publication | packaged flushed-temp atomic no-replace hard-link contract; deployed helper first publish, byte-identical retry, different-byte hard rejection, partial cleanup, and exact synthetic-file removal | full | collision-checked disposable history fixture only |
| Retention safety | generation and archived-observation hold create/list/release; dry run; wrong-token immutability; exact-plan purge, tombstone, ledger, replay rejection | full | one guarded fixture generation only |
| Backup | coordinated creation; regular authenticated HMAC/checksum/epoch/VERIFIED core markers; bounded canonical backup-time archive-generation UUID inventory with exact VERIFIED catalog-array equality; separately HMAC-authenticated post-verification `JOURNAL_CONFIRMED` v2 sidecar outside the immutable core inventory; exact 3.9.2 epoch; supported re-verification; atomic daily-journal confirmation-set membership with every receipt bound to the authenticated app-state checksum; count retention; no restore | full | backup creation/pruning only |
| Restore drill | exact-release preflight; pre-backup and post-mutation canaries across database, application state, archive, `.env`, secrets, and TLS plus real pre-/post-backup WAL fingerprints; supported destructive restore; promotion to a fresh PostgreSQL timeline; append-only preservation of backup-era and divergent post-backup WAL; new history/WAL archival without an archiver failure; exact VERIFIED epoch reconstruction; recovery-setting cleanup; service/archive/image postchecks | restore-drill only | overwrites the isolated deployment from a new backup while preserving WAL history |

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
- destructive backup restore in smoke/full (the separately path-bound,
  four-acknowledgement `restore-drill` profile covers only an isolated
  disposable target), production retention changes, broad archive purge, and
  physical/production data

These require a disposable deployment and a separate, explicit test plan.

## Scenario names

`preflight`, `viewer-navigation`, `map-national-servers`, `sensorhub-admin`,
`status-of-health`, `dashboard-health`, `lane-video`, `event-filtering`, `operational-views`,
`reporting`, `alarm-transfer`, `alarm-transfer-camera`, `rpm-connection`,
`rpm-faults`, `rpm-alarms`, `event-uuid`, `adjudication`, `extended-occupancy`,
`adjudication-report`, `storage-health`, `storage-lifecycle`, and the isolated
`storage-restore-drill` scenario selected only by `--profile restore-drill`.

`dashboard-health` is a read-only browser scenario. It verifies the complete
lane/RPM/camera inventory and live Online state, then intercepts only the
Dashboard's batched latest-observation responses to prove accessible Offline
and Unknown rendering without changing SensorHub or emulator state. The full
profile separately stops/restarts the reserved RPM and injects each supported
fault to verify real Dashboard transitions and recovery.

`event-uuid` is capability-gated with `EVENT_UUID_WORKFLOW`. Its default `auto`
mode skips cleanly on older Viewer builds; use `required` for builds that claim
the feature. With operational views enabled, the fixture selects one assigned
view and one populated non-member view for the reserved lane. Search must retain
exactly one assigned `view` parameter through canonical Event Details
navigation, while the same UUID must display the not-found state in the
non-member scope without leaking event data. The general not-found check uses a
newly generated identity and never deletes an event.

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
