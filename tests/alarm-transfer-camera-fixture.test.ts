import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import test from "node:test";
import {
  createAlarmTransferCameraFixture,
  decodeAlarmTransferCameraTransport,
} from "../src/alarm-transfer-camera-fixture.js";

test("camera fixture is a deterministic, representative version-23 OSCAR alarm QR", () => {
  const fixture = createAlarmTransferCameraFixture();
  const repeated = createAlarmTransferCameraFixture();

  assert.equal(fixture.transport, repeated.transport);
  assert.equal(
    createHash("sha256").update(fixture.transport, "utf8").digest("hex"),
    "cd8cfdffb49c35bd585f95493bd085bb8f1b7580b3892cd7ce3efdaf99abba14",
  );
  assert.equal(fixture.qrVersion, 23);
  assert.equal(fixture.qrSize, 109);
  assert.equal(fixture.transportCharacters, 1_170);
  assert.equal(fixture.transport.length, fixture.transportCharacters);
  assert.equal(fixture.digest, "5fb60f46505448b04d997cf3f111880a4cb4fbbbe405d3628d586721a3699840");
  assert.ok(fixture.transport.endsWith(`/${fixture.digest.toUpperCase()}`));
  assert.ok(fixture.transportCharacters <= 2_200);
  assert.equal(fixture.frameWidth, 640);
  assert.equal(fixture.frameHeight, 480);
  assert.equal(fixture.quietZoneModules, 4);
  assert.equal(fixture.pixelsPerModule, 3);
  assert.equal(fixture.symbolPixels, 351);
  assert.equal(
    (fixture.qrSize + fixture.quietZoneModules * 2) * fixture.pixelsPerModule,
    fixture.symbolPixels,
  );
  assert.equal(fixture.qrModules.length, fixture.qrSize * fixture.qrSize);
  assert.ok(fixture.qrModules.every((module) => module === 0 || module === 1));

  const decoded = decodeAlarmTransferCameraTransport(fixture.transport);
  assert.equal(decoded.schema, "org.oscar.alarm-transfer");
  assert.equal(decoded.version, 1);
  assert.equal(decoded.event.observationId, fixture.observationId);
  assert.equal(decoded.event.occupancyId, fixture.occupancyId);
  assert.equal(decoded.source.laneId, fixture.laneId);
  assert.equal(decoded.authenticity.notice, "integrity-only");
});

test("camera fixture decoder rejects an altered integrity digest", () => {
  const fixture = createAlarmTransferCameraFixture();
  const finalCharacter = fixture.transport.at(-1);
  const altered = `${fixture.transport.slice(0, -1)}${finalCharacter === "0" ? "1" : "0"}`;
  assert.throws(
    () => decodeAlarmTransferCameraTransport(altered),
    /integrity check failed/,
  );
});
