import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import test from "node:test";
import {
  assessArchiveHealth,
  assessDailyFilePublication,
  assessJpeg,
  assessRetainedMediaResponse,
  assessStoragePlatform,
  encodeOshBigId,
  parseBaselineJpeg,
  storagePlatformHasExactReleaseIdentity,
  storageMetricFromProbe,
} from "../src/storage-oracles.js";

const digest = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");

function retainedResponse() {
  const eventId = "event-1";
  const cameraUid = "camera-01";
  const cameraToken = Buffer.from(cameraUid).toString("base64url");
  const positions = ["FIRST", "QUARTER", "MIDDLE", "THREE_QUARTERS", "LAST"];
  const assets = positions.map((position, index) => ({
    position, sourceFrameOrdinal: index + 1, contentType: "image/jpeg", state: "PUBLISHED",
    bytes: 4, width: 1, height: 1, sha256: "a".repeat(64),
  }));
  return {eventId, response: {schemaVersion: 1, eventId, mediaSets: [{
    manifest: {schemaVersion: 1, eventId, mediaSetId: "123e4567-e89b-42d3-a456-426614174000",
      cameraUid, jpegQuality: 85,
      source: {sha256: "b".repeat(64), bytes: 100, rollbackDeleteAfter: "2026-10-18T00:00:00Z"}, assets},
    manifestPath: `media/${eventId}/${cameraToken}/manifest.json`,
    assets: assets.map((asset, index) => ({asset, path: `media/${eventId}/${cameraToken}/frame-0${index + 1}.jpg`})),
  }]}};
}

test("retained-media oracle requires exactly five canonical JPEG assets", () => {
  const fixture = retainedResponse();
  const result = assessRetainedMediaResponse(fixture.response, fixture.eventId);
  assert.equal(result.frameCount, 5);
  assert.equal(result.assets.length, 5);
  fixture.response.mediaSets[0]!.manifest.assets.pop();
  assert.throws(() => assessRetainedMediaResponse(fixture.response, fixture.eventId), /exactly five/);
});

test("retained-media oracle rejects event path traversal and duplicate positions", () => {
  const fixture = retainedResponse();
  fixture.response.mediaSets[0]!.assets[0]!.path = "media/event-1/../frame-01.jpg";
  assert.throws(() => assessRetainedMediaResponse(fixture.response, fixture.eventId), /whitelist/);
  const duplicate = retainedResponse();
  duplicate.response.mediaSets[0]!.manifest.assets[1]!.position = "FIRST";
  assert.throws(() => assessRetainedMediaResponse(duplicate.response, duplicate.eventId), /five distinct/);

  const duplicateResponse = retainedResponse();
  const first = duplicateResponse.response.mediaSets[0]!.assets[0]!.asset;
  duplicateResponse.response.mediaSets[0]!.assets = Array.from({length: 5}, () => ({
    asset: first,
    path: `media/${duplicateResponse.eventId}/${Buffer.from("camera-01").toString("base64url")}/frame-01.jpg`,
  }));
  assert.throws(() => assessRetainedMediaResponse(duplicateResponse.response, duplicateResponse.eventId),
    /duplicate frame position/);

  const wrongCameraPath = retainedResponse();
  wrongCameraPath.response.mediaSets[0]!.assets[0]!.path = "media/event-1/another-camera/frame-01.jpg";
  assert.throws(() => assessRetainedMediaResponse(wrongCameraPath.response, wrongCameraPath.eventId),
    /event whitelist/);

  const wrongManifestPath = retainedResponse();
  wrongManifestPath.response.mediaSets[0]!.manifestPath = "media/event-1/another-camera/manifest.json";
  assert.throws(() => assessRetainedMediaResponse(wrongManifestPath.response, wrongManifestPath.eventId),
    /manifest path does not match/);

  const mismatchedResponseAsset = retainedResponse();
  mismatchedResponseAsset.response.mediaSets[0]!.assets[0]!.asset = {
    ...mismatchedResponseAsset.response.mediaSets[0]!.assets[0]!.asset,
    sourceFrameOrdinal: 5,
  };
  assert.throws(() => assessRetainedMediaResponse(mismatchedResponseAsset.response, mismatchedResponseAsset.eventId),
    /does not match its manifest/);
});

test("retained-media oracle enforces frame and event-wide resource budgets", () => {
  const oversizedFrame = retainedResponse();
  oversizedFrame.response.mediaSets[0]!.manifest.assets[0]!.width = 6000;
  oversizedFrame.response.mediaSets[0]!.manifest.assets[0]!.height = 6000;
  oversizedFrame.response.mediaSets[0]!.assets[0]!.asset.width = 6000;
  oversizedFrame.response.mediaSets[0]!.assets[0]!.asset.height = 6000;
  assert.throws(() => assessRetainedMediaResponse(oversizedFrame.response, oversizedFrame.eventId),
    /decoded-pixel budget/);

  const oversizedEvent = retainedResponse();
  const first = oversizedEvent.response.mediaSets[0]!;
  for (const asset of first.manifest.assets) asset.bytes = 10 * 1024 * 1024;
  for (const asset of first.assets) asset.asset.bytes = 10 * 1024 * 1024;
  const second = structuredClone(first);
  second.manifest.mediaSetId = "223e4567-e89b-42d3-a456-426614174000";
  second.manifest.cameraUid = "camera-02";
  const firstToken = Buffer.from("camera-01").toString("base64url");
  const secondToken = Buffer.from("camera-02").toString("base64url");
  second.manifestPath = second.manifestPath.replace(firstToken, secondToken);
  for (const asset of second.assets) asset.path = asset.path.replace(firstToken, secondToken);
  oversizedEvent.response.mediaSets.push(second);
  assert.throws(() => assessRetainedMediaResponse(oversizedEvent.response, oversizedEvent.eventId),
    /event-wide byte budget/);
});

const baselineJpeg = Buffer.from(
  "/9j/4AAQSkZJRgABAgAAAQABAAD//gAQTGF2YzYyLjI4LjEwMgD/2wBDAAgEBAQEBAUFBQUFBQYGBgYGBgYGBgYGBgYHBwcICAgHBwcGBgcHCAgICAkJCQgICAgJCQoKCgwMCwsODg4RERT/xABMAAEBAAAAAAAAAAAAAAAAAAAABgEBAQAAAAAAAAAAAAAAAAAABgcQAQAAAAAAAAAAAAAAAAAAAAARAQAAAAAAAAAAAAAAAAAAAAD/wAARCAACAAIDASIAAhEAAxEA/9oADAMBAAIRAxEAPwCLAE1/f//Z",
  "base64",
);

test("bounded JPEG oracle parses baseline structure, dimensions, sizes, and hashes", () => {
  assert.deepEqual(parseBaselineJpeg(baselineJpeg), {width: 2, height: 2, components: 3, scans: 1});
  assert.equal(assessJpeg(baselineJpeg, baselineJpeg.length, digest(baselineJpeg), 2, 2), true);
  assert.equal(assessJpeg(baselineJpeg, baselineJpeg.length, digest(baselineJpeg), 3, 2), false);
  assert.equal(assessJpeg(Buffer.from("not-jpeg"), 8, digest("not-jpeg")), false);
});

test("bounded JPEG oracle rejects progressive, truncated, corrupt-length, trailing, and fake fixtures", () => {
  const sof = baselineJpeg.indexOf(Buffer.from([0xff, 0xc0]));
  assert.ok(sof > 0);
  const progressive = Buffer.from(baselineJpeg);
  progressive[sof + 1] = 0xc2;
  assert.throws(() => parseBaselineJpeg(progressive), /not baseline/);

  const scan = baselineJpeg.indexOf(Buffer.from([0xff, 0xda]));
  assert.ok(scan > 0);
  const arithmetic = Buffer.concat([
    baselineJpeg.subarray(0, scan),
    Buffer.from([0xff, 0xcc, 0x00, 0x04, 0x00, 0x00]),
    baselineJpeg.subarray(scan),
  ]);
  assert.throws(() => parseBaselineJpeg(arithmetic), /arithmetic coding/);

  assert.throws(() => parseBaselineJpeg(baselineJpeg.subarray(0, -1)), /truncated|missing/);
  const quantization = baselineJpeg.indexOf(Buffer.from([0xff, 0xdb]));
  assert.ok(quantization > 0);
  const corruptLength = Buffer.from(baselineJpeg);
  corruptLength[quantization + 2] = 0xff;
  corruptLength[quantization + 3] = 0xff;
  assert.throws(() => parseBaselineJpeg(corruptLength), /exceeds/);
  assert.throws(() => parseBaselineJpeg(Buffer.concat([baselineJpeg, Buffer.from([0x00])])), /trailing/);
  assert.equal(assessJpeg(Buffer.from([0xff, 0xd8, 0x01, 0xff, 0xd9]), 5,
    digest(Buffer.from([0xff, 0xd8, 0x01, 0xff, 0xd9]))), false);
});

test("daily-file oracle verifies sizes, counts, and hashes", () => {
  const csv = Buffer.from("a,b\nc,d\n");
  const manifest = {schemaVersion: 1, laneId: "Lane01", windowStartInclusive: "2026-10-16T04:00:00Z",
    windowEndExclusive: "2026-10-17T04:00:00Z", dataFile: "Lane01_2026-10-16.csv",
    recordCount: 2, byteCount: csv.length, sha256: digest(csv)};
  assert.equal(assessDailyFilePublication(manifest, csv, "Lane01").recordCount, 2);
  assert.throws(() => assessDailyFilePublication({...manifest, recordCount: 3}, csv), /record count/);
});

test("platform/metric contracts preserve PostgreSQL, archive, and batch counters", () => {
  const deploymentId = "123e4567-e89b-42d3-a456-426614174000";
  const image = {reference: "oscar:3.9.2", imageId: `sha256:${"a".repeat(64)}`,
    containerImageId: `sha256:${"a".repeat(64)}`, repoDigests: [], versionLabel: "3.9.2",
    storageProfileLabel: ""};
  const helper = {helperPath: "/usr/local/bin/oscar-archive-object",
    packagedSha256: "b".repeat(64), deployedSha256: "b".repeat(64), regularExecutable: true,
    cliExportIntegrated: true, cliPurgeIntegrated: true};
  const root = (rootKind: string, rootGroup: number, rootMode: string) => ({
    format: "oscar-storage-root-identity", version: "1", deploymentId, rootKind,
    adoption: "new", claimedAt: "2026-10-17T12:00:00Z", adoptedAt: "none", adoptedBy: "none",
    markerOwner: 0, markerGroup: 0, markerMode: "600", rootOwner: 0, rootGroup, rootMode, exact: true,
  });
  const platform = assessStoragePlatform({expectedRelease: "3.9.2", configuredRelease: "3.9.2",
    templateRelease: "3.9.2", deploymentId,
    storageRoots: {archive: root("archive", 10001, "1770"), backup: root("backup", 0, "700"),
      walArchive: root("wal-archive", 999, "1770")},
    storageLock: {directory: "/run/lock/oscar-storage", file: `/run/lock/oscar-storage/${deploymentId}.lock`,
      stablePath: true, private: true, behaviorTested: true, concurrentRejected: true},
    walArchive: {...helper, helperPath: "/usr/local/bin/oscar-archive-wal", archiveMode: "on",
      archiveCommandExact: true, publicationContractExact: true}, archiveObjectHelper: helper, appImage: image,
    restoreHelpers: {
      prepare: {...helper, helperPath: "/usr/local/bin/oscar-prepare-restore"},
      mergeWal: {...helper, helperPath: "/usr/local/bin/oscar-merge-wal-restore"},
    },
    atomicPublisher: {helperPath: "/usr/local/bin/oscar-atomic-publish",
      sourceStampPath: "/usr/local/share/oscar-atomic-publish.source.sha256",
      packagedSourceSha256: "c".repeat(64), deployedSourceSha256: "c".repeat(64),
      deployedBinarySha256: "d".repeat(64), regularExecutable: true, sourceStampRegular: true,
      behaviorTested: true, firstPublishSucceeded: true, collisionRejected: true,
      sourcePreserved: true, destinationPreserved: true},
    backupIsolation: {appBackupRootAbsent: true, postgresBackupRootAbsent: true,
      isolatedBasebackupWired: true},
    postgisImage: {...image, reference: "oscar-postgis:3.9.2", storageProfileLabel: "3.9.2"},
    gatewayImage: {...image, reference: "nginxinc/nginx-unprivileged:1.28.1-alpine", versionLabel: ""},
    dataChecksums: "on", pgStatStatementsInstalled: true,
    pgStatStatementsPreloaded: true, schemaVersion: 4,
    archiveMarker: {present: true, exact: true, format: "oscar-storage-profile", version: "3.9.2",
      dataChecksums: "on", initializedAt: "2026-10-17T12:00:00Z"},
    batchRewriteConfigured: true, dailyJournalConfigured: true, archiveIntervalMinutes: 1,
    deleteHotAfterArchive: true, rollbackGraceDays: 1});
  assert.equal(platform.schemaVersion, 4);
  assert.equal(platform.appImage.imageId, platform.appImage.containerImageId);
  assert.equal(platform.archiveMarker.exact, true);
  assert.equal(platform.storageRoots.walArchive.rootKind, "wal-archive");
  assert.equal(storagePlatformHasExactReleaseIdentity(platform, "3.9.2"), true);
  assert.equal(storagePlatformHasExactReleaseIdentity(
    {...platform, configuredRelease: "4.0.0"},
    "3.9.2",
  ), false);
  assert.equal(storagePlatformHasExactReleaseIdentity(
    {...platform, archiveMarker: {...platform.archiveMarker, initializedAt: "not-an-instant"}},
    "3.9.2",
  ), false);
  assert.equal(storagePlatformHasExactReleaseIdentity(
    {...platform, storageRoots: {...platform.storageRoots,
      backup: {...platform.storageRoots.backup, rootKind: "archive"}}},
    "3.9.2",
  ), false);
  assert.equal(storagePlatformHasExactReleaseIdentity(
    {...platform, walArchive: {...platform.walArchive, archiveCommandExact: false}},
    "3.9.2",
  ), false);
  assert.equal(storagePlatformHasExactReleaseIdentity(
    {...platform, walArchive: {...platform.walArchive, publicationContractExact: false}},
    "3.9.2",
  ), false);
  assert.equal(storagePlatformHasExactReleaseIdentity(
    {...platform, storageLock: {...platform.storageLock, concurrentRejected: false}},
    "3.9.2",
  ), false);
  assert.equal(storagePlatformHasExactReleaseIdentity(
    {...platform, archiveObjectHelper: {...platform.archiveObjectHelper, cliPurgeIntegrated: false}},
    "3.9.2",
  ), false);
  assert.equal(storagePlatformHasExactReleaseIdentity(
    {...platform, restoreHelpers: {...platform.restoreHelpers,
      mergeWal: {...platform.restoreHelpers.mergeWal, deployedSha256: "f".repeat(64)}}},
    "3.9.2",
  ), false);
  assert.equal(storagePlatformHasExactReleaseIdentity(
    {...platform, atomicPublisher: {...platform.atomicPublisher, collisionRejected: false}},
    "3.9.2",
  ), false);
  assert.equal(storagePlatformHasExactReleaseIdentity(
    {...platform, atomicPublisher: {...platform.atomicPublisher,
      deployedSourceSha256: "e".repeat(64)}},
    "3.9.2",
  ), false);
  assert.equal(storagePlatformHasExactReleaseIdentity(
    {...platform, backupIsolation: {...platform.backupIsolation,
      postgresBackupRootAbsent: false}},
    "3.9.2",
  ), false);
  const metric = storageMetricFromProbe("batch", {databaseSizeBytes: "100", observationInsertCalls: 2,
    observationInsertRows: 20, observationRowsPerCall: 10});
  assert.equal(metric.databaseSizeBytes, 100);
  assert.equal(metric.observationRowsPerCall, 10);
});

test("archive health counts partial archive and WAL artifacts independently", () => {
  const health = assessArchiveHealth({activeGenerations: 1, sealedGenerations: 2, archiveRows: 3,
    archiveBytes: 4, failedJobs: 0, parityFailures: 0, activeHolds: 0,
    incompleteActiveObjects: 0, archivePartialArtifacts: 1, walPartialArtifacts: 2,
    checksumVerificationPassed: true});
  assert.equal(health.archivePartialArtifacts, 1);
  assert.equal(health.walPartialArtifacts, 2);
});

test("OSH BigId encoding is deterministic and rejects unsafe IDs", () => {
  assert.equal(encodeOshBigId(4, 1n), "0g0g");
  assert.equal(encodeOshBigId(4, 300n), "0im04");
  assert.throws(() => encodeOshBigId(-1, 1n), /scope/);
  assert.throws(() => encodeOshBigId(4, 0n), /positive/);
});
