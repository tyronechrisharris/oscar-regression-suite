import assert from "node:assert/strict";
import test from "node:test";
import {
  alarmCameraToken,
  alarmMediaForensicsPassed,
  assertAlarmVideoAssociationUnique,
  assessAlarmMediaForensics,
  assessAlarmVideoObservation,
  cameraUidsForSystemComponents,
  laneUidForSystemName,
} from "../src/alarm-media-oracles.js";

const eventId = "00000000-0000-4000-8000-000000000001";
const cameras = ["urn:osh:sensor:camera:50:a", "urn:osh:sensor:camera:50:b"];

function observation(videoPaths: unknown = [
  "videos/clips/urn-osh-sensor-camera-50-a/2026-10-18_07-31-52_004-g7.mp4",
  "videos\\clips\\urn-osh-sensor-camera-50-b\\2026-10-18_07-31-52_004-g7.mp4",
]) {
  return {id: eventId, "datastream@id": "stream-1", result: {videoPaths}};
}

test("camera identities come from the OSH systems catalog, not emulator stream IDs", () => {
  const catalog = {items: [
    {id: "camera-resource-b", properties: {uid: cameras[1], name: "Camera B"}},
    {id: "rpm-resource", properties: {uid: "urn:osh:sensor:rpm:50"}},
    {id: "camera-resource-a", properties: {properties: {uid: cameras[0]}}},
  ]};
  assert.deepEqual(
    cameraUidsForSystemComponents(catalog, ["camera-resource-a", "camera-resource-b"]),
    cameras,
  );
  assert.deepEqual(
    cameraUidsForSystemComponents({features: catalog.items}, ["camera-resource-b"]),
    [cameras[1]],
  );
});

test("lane identity comes from exactly one authoritative OSH lane system", () => {
  const catalog = {items: [
    {id: "lane-resource", properties: {properties: {uid: "urn:osh:system:lane:50", name: "Lane50"}}},
    {id: "camera-resource", properties: {properties: {uid: cameras[0], name: "Lane50"}}},
  ]};
  assert.equal(laneUidForSystemName(catalog, "Lane50"), "urn:osh:system:lane:50");
  assert.throws(() => laneUidForSystemName({items: []}, "Lane50"), /resolved 0/);
  assert.throws(() => laneUidForSystemName({items: [
    {properties: {properties: {uid: "urn:osh:system:lane:a", name: "Lane50"}}},
    {properties: {properties: {uid: "urn:osh:system:lane:b", name: "Lane50"}}},
  ]}, "Lane50"), /resolved 2/);
});

test("camera catalog oracle rejects missing, duplicate, unsafe, and ambiguous identities", () => {
  assert.throws(() => cameraUidsForSystemComponents({items: []}, ["camera-resource-a"]), /missing/);
  assert.throws(() => cameraUidsForSystemComponents({items: []}, []), /no camera components/);
  assert.throws(() => cameraUidsForSystemComponents({items: []}, ["a", "a"]), /duplicates/);
  assert.throws(() => cameraUidsForSystemComponents({items: [
    {id: "a", properties: {uid: "unsafe/camera"}},
  ]}, ["a"]), /unsupported path characters/);
  assert.throws(() => cameraUidsForSystemComponents({items: [
    {id: "a", properties: {uid: "camera:a"}},
    {id: "b", properties: {uid: "camera-a"}},
  ]}, ["a", "b"]), /same clip token/);
});

test("alarm video oracle binds one strict generation-qualified clip to each configured camera", () => {
  assert.equal(alarmCameraToken(cameras[0]!), "urn-osh-sensor-camera-50-a");
  const result = assessAlarmVideoObservation(observation(), eventId, cameras);
  assert.equal(result.eventId, eventId);
  assert.deepEqual(result.paths.map(({cameraUid}) => cameraUid), cameras);
  assert.deepEqual(result.paths.map(({generation}) => generation), [7, 7]);
  assert.deepEqual(result.paths.map(({timestamp}) => timestamp), [
    "2026-10-18_07-31-52_004",
    "2026-10-18_07-31-52_004",
  ]);
  assert.ok(result.paths.every(({path}) => !path.includes("\\")));

  const shortId = "0i4d0ko";
  const shortResult = assessAlarmVideoObservation({...observation(), id: shortId}, shortId, cameras);
  assert.equal(shortResult.eventId, shortId);
});

test("alarm video oracle rejects missing, duplicate, foreign, blank, and stale clip paths", () => {
  assert.throws(() => assessAlarmVideoObservation(observation([]), eventId, cameras), /expected 2/);
  const onePath = (observation().result.videoPaths as string[])[0]!;
  assert.throws(() => assessAlarmVideoObservation(observation([onePath, onePath]), eventId, cameras),
    /duplicate paths|exactly one path/);
  assert.throws(() => assessAlarmVideoObservation(observation([
    onePath,
    "videos/clips/not-configured/2026-10-18_07-31-52_004-g7.mp4",
  ]), eventId, cameras), /not configured/);
  assert.throws(() => assessAlarmVideoObservation(observation([onePath, "  "]), eventId, cameras), /nonblank/);
  assert.throws(() => assessAlarmVideoObservation(observation([
    onePath,
    "videos/clips/urn-osh-sensor-camera-50-b/2026-10-18_07-31-52_004.mp4",
  ]), eventId, cameras), /generation-qualified/);
  assert.throws(() => assessAlarmVideoObservation(observation([
    onePath,
    "videos/clips/urn-osh-sensor-camera-50-b/../../stale-g7.mp4",
  ]), eventId, cameras), /videos\/clips|generation-qualified/);
});

test("alarm video oracle requires the exact selected event and collision-free camera tokens", () => {
  assert.throws(() => assessAlarmVideoObservation({
    ...observation(),
    id: "00000000-0000-4000-8000-000000000099",
  }, eventId, cameras),
    /does not match/);
  assert.throws(() => assessAlarmVideoObservation({...observation(), id: " "}, eventId, cameras),
    /public observation ID/);
  assert.throws(() => assessAlarmVideoObservation(observation(), eventId, ["camera:a", "camera-a"]),
    /same clip token/);
  assert.throws(() => assessAlarmVideoObservation(observation(), eventId, ["camera/unsafe"]),
    /unsupported path characters/);
});

test("alarm video run oracle rejects duplicate event UUIDs and cross-event clip reuse", () => {
  const first = assessAlarmVideoObservation(observation(), eventId, cameras);
  const second = assessAlarmVideoObservation({
    ...observation([
      "videos/clips/urn-osh-sensor-camera-50-a/2026-10-18_07-32-52_004-g8.mp4",
      "videos/clips/urn-osh-sensor-camera-50-b/2026-10-18_07-32-52_004-g8.mp4",
    ]),
    id: "00000000-0000-4000-8000-000000000002",
  }, "00000000-0000-4000-8000-000000000002", cameras);
  assert.doesNotThrow(() => assertAlarmVideoAssociationUnique(second, [first]));
  assert.throws(() => assertAlarmVideoAssociationUnique(first, [first]), /generated more than once/);
  assert.throws(() => assertAlarmVideoAssociationUnique({...second, paths: first.paths}, [first]),
    /reuses video path/);
});

test("alarm-media forensic oracle gates only new generated files and new partials", () => {
  const valid = assessAlarmMediaForensics({
    baselineFound: true,
    expectedPaths: 2,
    currentExpectedPaths: 2,
    newFinalizedPaths: 2,
    newFinalizedOrphans: 0,
    newPartialArtifacts: 0,
    expectedAlreadyPresentAtBaseline: 0,
  }, 2);
  assert.equal(alarmMediaForensicsPassed(valid), true);
  assert.equal(alarmMediaForensicsPassed({...valid, newFinalizedOrphans: 1}), false);
  assert.equal(alarmMediaForensicsPassed({...valid, newPartialArtifacts: 1}), false);
  assert.throws(() => assessAlarmMediaForensics({...valid, expectedPaths: 1}, 2), /exact generated path set/);
  assert.throws(() => assessAlarmMediaForensics({...valid, newPartialArtifacts: -1}, 2), /nonnegative integer/);
});
