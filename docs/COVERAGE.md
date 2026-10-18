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
| Dashboard health | expected lane/RPM/per-camera indicator inventory; every exact expected connection-chip identity resolves to an accessible live Online state within 45 seconds; one selected camera Offline while every other component stays Online; deterministic all-Offline and completed Unknown reconciliation; all five exact Unknown fault labels; live recovery; keyboard lane navigation; health batches of at most 10 streams with at most two requests in flight | smoke | browser response fixtures only |
| Lane detail | charts and event table render | smoke | HLS start/stop commands |
| Video | decoded dimensions, ready state, and advancing playback time | smoke | HLS start/stop commands |
| Events | rows load and Advanced Filter returns only the requested lane | smoke | none |
| Operational views | fixture-derived exact Dashboard card/RPM/camera membership and Status of Health lane sets for east/west/north/south/pedestrian/entrance/exit; Dashboard-to-Health query persistence; invalid, unassigned, and duplicate parameters fail closed | smoke | none |
| Reports | site, one-lane lane, alarm, alarm/occupancy, and health PDFs | smoke | report bucket writes |
| Alarm import | malformed payload is rejected visibly | smoke | none |
| Alarm camera import | deterministic Chromium 640x480 stream starts; preview and contained scan overlay are visible and non-zero; visible status says `Scanning`; active camera reports the deterministic identity and 640 × 480; dense QR v23/1,170-character transport decodes with valid integrity and UUID; all tracks stop; denied permission is reported and retry succeeds | both | local generated media only |
| RPM connection | stop/restart appears Offline/Online on Status of Health and the Dashboard while camera state remains independently Online | full | reserved RPM only |
| Faults | gamma high/low, neutron high, and tamper assert and clear on Status of Health and the Dashboard; Dashboard tamper clear stays in place, posts the real SensorHub control command, and clears the observed state | full | reserved RPM only |
| Alarms | deterministic gamma and neutron alarms reach Event Log; each row resolves its exact public occupancy observation ID; authenticated `result.videoPaths` contains one nonblank unique `videos/clips/<camera-token>/<timestamp>-g<generation>.mp4` per OSH-configured lane camera; directory ownership, nonzero source objects, and Chromium MP4 metadata are verified | full | permanent event data and source clips |
| Event identity | capture the persisted public occupancy observation ID shown as “Event UUID”; accept its opaque normalized 1–128-character product form without imposing RFC 4122 punctuation; verify details, UUID search, canonical direct link, clipboard actions, fresh-page resolution, explicit not-found state, assigned-view query preservation, non-member-view fail-closed behavior, print-to-PDF text, and QR v1 round-trip with exact identity equality | full | one permanent alarm event; local clipboard/artifacts |
| Alarm transfer | selected alarm JSON round-trip and SHA-256 integrity; each imported non-empty series redraws with its chart-specific dataset color; the received package downloads with the same canonical payload, integrity, transport, and UUID while export-only QR metadata may be omitted; the actual exported QR PNG uploads and imports successfully | full | local artifacts only |
| Adjudication | Code 9 submission, confirmation, success, audit display | full | permanent audit record |
| Extended occupancy | duration over configured threshold faults, then clears on Status of Health and the Dashboard | full | reserved RPM only |
| Adjudication report | one-lane PDF is generated and validated | full | report bucket write |
| Performance | runner plus optional host/container time series and aggregates | both | read-only SSH |
| Storage platform | exact 3.9.2 app/PostGIS tags and OCI labels, pinned gateway tag, running/local immutable image IDs and available digests, exact checksum marker plus three deployment/kind-bound storage-root v1 markers and modes, structural single-module persisted JSON extraction with duplicate/decoy/type rejection, effective multi-values observation batching proven from `pg_stat_statements`, stable private deployment lock with concurrent-command rejection, packaged/running app, WAL-publisher, restore-preparation, and append-only WAL-merge helper hash parity, compiled atomic publisher source-stamp parity and first-publish/collision-preservation behavior, no full-backup-root mount in either long-running service plus isolated one-shot base-backup wiring, exact PostgreSQL `archive_command`, no archive/WAL partial artifacts, data checksums, exact schema v5/checksum before lifecycle and before/after restore, exact DuckDB 256 MiB/2-thread/4 GiB-spill/2-session/30-second-admission config, private archive-disjoint empty scratch, exact direct-daily-file config, archive checksum/catalog/parity health, and storage counters | smoke | SSH plus private temporary atomic-publisher behavior test under the suite lease |
| Retained media | exact five quality-85 canonical, hash-valid bounded baseline JPEGs per camera; every frame independently decodes in Chromium at its declared dimensions; strict streaming catalog/frame and event resource budgets; schema-2 reclamation checkpoint; exact `{epoch-hour}-{00..11}.idx` processed and sharded deletion-index headers/36-byte records; no legacy marker/tombstone inode growth; lazy selected-frame Viewer loading with a measured three-request concurrency ceiling and decoded content replacement; legacy-video fallback on retained API 404; in full, every generated exact public observation ID has one source-bound manifest per camera, five valid JPEGs, a final one-attempt/no-failure ledger, and no run-new orphan MP4 or partial in its authoritative camera directories | both | smoke/non-lifecycle requires a configured retained event; an unfiltered full run self-seeds exact event IDs and creates retained sets on a disposable zero-day profile |
| Daily files | exact persisted journal/lifecycle config; exact schema-1 configured-zone metadata; bounded link-safe publication tree; when a prior configured-zone day exists, exact 12-key v1 CSV manifests with current hash/byte/record agreement; before the first boundary, an explicit correct not-yet-eligible result backed by nonempty current-day `.open`/`.seg` files with safe layout and exact `DJNL` v1 headers; emulator-triggered direct append to the canonical lane-UID journal; bounded per-segment hash/size inventory; after restart every sealed segment is byte-identical and every open segment remains or has one sealed successor with its entire pre-restart prefix intact; no partials | both | reserved RPM transition and OSCAR restart in full |
| Tiered archive | deterministic cold fixture; controlled post-export source-row race with stale activation rollback and exact one-row retry ownership; parity; packaged CLI export/purge helper wiring plus deployed helper verify/copy/rejection checks; portable export; cold-by-ID and mixed hot/cold query; grace/seal/hot deletion; every DuckDB operation leaves the private scratch root empty | full | registered disposable rows only |
| WAL publication | packaged flushed-temp atomic no-replace hard-link contract; deployed helper first publish, byte-identical retry, different-byte hard rejection, partial cleanup, and exact synthetic-file removal | full | collision-checked disposable history fixture only |
| Retention safety | exact `GENERATION_EXACT`, `COLD_RANGE_CONSERVATIVE`, and `HOT_EXACT` create/list/release; generation/cold dry-run exclusion; authenticated hot DELETE rejection while held and success after release; wrong-token immutability; exact-plan purge, tombstone, ledger, replay rejection; migration-only `LEGACY_UNKNOWN` is never emitted by the CLI | full | one guarded fixture generation and its disposable hot row only |
| Backup | coordinated creation; independent backup-key HMAC recomputation, every checksum, and exact no-link payload inventory in addition to supported re-verification; bounded canonical backup-time archive-generation UUID inventory equal to the captured catalog and exact VERIFIED count/SHA-256/byte receipt; separately HMAC-authenticated post-verification `JOURNAL_CONFIRMED` v2 sidecar; exact 3.9.2 epoch; authenticated-tar confirmation receipts reconciled to exact regular segment members and hashes; DuckDB scratch exclusion; exact once-only regular checkpoint, every processed/deletion index, and each proved event/lane/camera manifest plus `frame-01.jpg` through `frame-05.jpg`, verified by path/type/size/SHA-256 rather than aggregate counts; count retention; no restore | full | backup creation/pruning only |
| Restore drill | exact-release preflight; independently reauthenticated backup; pre-backup and post-mutation canaries across database, application state, an empty canonical app-owned archive partition/profile hierarchy, `.env`, secrets, and TLS plus real pre-/post-backup WAL fingerprints; supported destructive restore; exact mutated name/content/owner/group/mode inventory in the private no-link pre-restore safety copy; promotion to a fresh PostgreSQL timeline; append-only preservation of backup-era and divergent post-backup WAL; new history/WAL archival without an archiver failure; exact VERIFIED epoch reconstruction; recovery-setting cleanup; service/archive/image postchecks | restore-drill only | overwrites the isolated deployment from a new backup while preserving WAL history |
| 3.9.2 certification | unfiltered full suite with operational views, UUID lookup/export, Alarm Transfer camera, storage, and backup gates all required; matching unfiltered restore-drill PASS evidence and complete restore attestation | 3.9.2-release only | same mutations as full; restore is prior evidence, not rerun inline |

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
- native Windows Docker Desktop/PowerShell storage and restore acceptance; it
  remains deferred and must not be inferred from the Linux SSH/Docker run or
  static PowerShell inspection
- a live archive-disabled configuration restart solely to repeat HOT_EXACT
  deletion enforcement; the disposable lifecycle proves it with archiving
  enabled, while the disabled-profile variant remains a product-integration or
  separately provisioned E2E check
- forced 30-second saturation of the two-session DuckDB admission gate; the
  suite asserts the exact persisted limit/timeout and post-operation scratch
  cleanup, while contention timing remains a product integration test

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
the feature. The Viewer label does not imply an RFC 4122 wire format: the suite
accepts the same normalized 1–128-character opaque public observation identity
as Viewer and requires exact equality at every boundary. With operational views
enabled, the fixture selects one assigned
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
