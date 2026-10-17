import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import test from "node:test";
import {
  assessDailyFilePublication,
  assessJpeg,
  assessRetainedMediaResponse,
  assessStoragePlatform,
  encodeOshBigId,
  storageMetricFromProbe,
} from "../src/storage-oracles.js";

const digest = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");

function retainedResponse() {
  const eventId = "event-1";
  const positions = ["FIRST", "QUARTER", "MIDDLE", "THREE_QUARTERS", "LAST"];
  const assets = positions.map((position, index) => ({
    position, sourceFrameOrdinal: index + 1, contentType: "image/jpeg", state: "PUBLISHED",
    bytes: 4, width: 1, height: 1, sha256: "a".repeat(64),
  }));
  return {eventId, response: {schemaVersion: 1, eventId, mediaSets: [{
    manifest: {schemaVersion: 1, eventId, mediaSetId: "123e4567-e89b-42d3-a456-426614174000",
      cameraUid: "camera-01", jpegQuality: 85,
      source: {sha256: "b".repeat(64), bytes: 100, rollbackDeleteAfter: "2026-10-18T00:00:00Z"}, assets},
    assets: assets.map((asset, index) => ({asset, path: `media/${eventId}/camera-01/frame-0${index + 1}.jpg`})),
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
});

test("JPEG and daily-file oracles verify signatures, sizes, counts, and hashes", () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0x01, 0xff, 0xd9]);
  assert.equal(assessJpeg(jpeg, jpeg.length, digest(jpeg)), true);
  assert.equal(assessJpeg(Buffer.from("not-jpeg"), 8, digest("not-jpeg")), false);
  const csv = Buffer.from("a,b\nc,d\n");
  const manifest = {schemaVersion: 1, laneId: "Lane01", windowStartInclusive: "2026-10-16T04:00:00Z",
    windowEndExclusive: "2026-10-17T04:00:00Z", dataFile: "Lane01_2026-10-16.csv",
    recordCount: 2, byteCount: csv.length, sha256: digest(csv)};
  assert.equal(assessDailyFilePublication(manifest, csv, "Lane01").recordCount, 2);
  assert.throws(() => assessDailyFilePublication({...manifest, recordCount: 3}, csv), /record count/);
});

test("platform/metric contracts preserve PostgreSQL, archive, and batch counters", () => {
  const platform = assessStoragePlatform({dataChecksums: "on", pgStatStatementsInstalled: true,
    pgStatStatementsPreloaded: true, schemaVersion: 4, archiveMarkerPresent: true,
    batchRewriteConfigured: true, dailyJournalConfigured: true, archiveIntervalMinutes: 1,
    deleteHotAfterArchive: true, rollbackGraceDays: 1});
  assert.equal(platform.schemaVersion, 4);
  const metric = storageMetricFromProbe("batch", {databaseSizeBytes: "100", observationInsertCalls: 2,
    observationInsertRows: 20, observationRowsPerCall: 10});
  assert.equal(metric.databaseSizeBytes, 100);
  assert.equal(metric.observationRowsPerCall, 10);
});

test("OSH BigId encoding is deterministic and rejects unsafe IDs", () => {
  assert.equal(encodeOshBigId(4, 1n), "0g0g");
  assert.equal(encodeOshBigId(4, 300n), "0im04");
  assert.throws(() => encodeOshBigId(-1, 1n), /scope/);
  assert.throws(() => encodeOshBigId(4, 0n), /positive/);
});
