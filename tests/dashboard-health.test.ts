import assert from "node:assert/strict";
import test from "node:test";
import {
  connectionDataStreamIds,
  forceConnectionObservationsOffline,
  forceSingleConnectionObservationOffline,
  parseHealthObservationBatch,
} from "../src/dashboard-health.js";

test("health polling parser recognizes only batched latest-observation queries", () => {
  assert.deepEqual(
    parseHealthObservationBatch(
      "https://oscar.test/sensorhub/api/observations?resultTime=latest&dataStream=one,two,three&offset=0&limit=3",
    ),
    {streamIds: ["one", "two", "three"], limit: 3},
  );
  assert.deepEqual(
    parseHealthObservationBatch(
      "https://oscar.test/sensorhub/api/observations/?dataStream=one%2Ctwo&resultTime=LATEST&limit=2",
    ),
    {streamIds: ["one", "two"], limit: 2},
  );
  assert.equal(parseHealthObservationBatch("not a URL"), null);
  assert.equal(parseHealthObservationBatch(
    "https://oscar.test/sensorhub/api/observations?resultTime=latest&limit=50",
  ), null);
  assert.equal(parseHealthObservationBatch(
    "https://oscar.test/sensorhub/api/observations?resultTime=now&dataStream=one&limit=1",
  ), null);
  assert.equal(parseHealthObservationBatch(
    "https://oscar.test/sensorhub/api/datastreams?resultTime=latest&dataStream=one&limit=1",
  ), null);
});

test("offline fixture rewrites top-level and parsed connection results only", () => {
  const payload = {
    items: [
      {id: "rpm", result: {isConnected: true}},
      {id: "camera-online", properties: {result: {connection: true}}},
      {id: "camera-offline", result: {isConnected: false}},
      {id: "gamma", result: {countRate: 10, alarmState: "Background"}},
    ],
  };

  assert.equal(forceConnectionObservationsOffline(payload), 3);
  assert.equal(payload.items[0]?.result?.isConnected, false);
  assert.equal(payload.items[1]?.properties?.result?.connection, false);
  assert.equal(payload.items[2]?.result?.isConnected, false);
  assert.deepEqual(payload.items[3]?.result, {countRate: 10, alarmState: "Background"});
  assert.equal(forceConnectionObservationsOffline([]), 0);
  assert.equal(forceConnectionObservationsOffline({items: "not-an-array"}), 0);
});

test("mixed fixture makes only the selected connection datastream offline", () => {
  const payload = {
    items: [
      {"datastream@id": "rpm-connection", result: {isConnected: false}},
      {"datastream@id": "camera-east-connection", result: {isConnected: true}},
      {
        properties: {
          "datastream@id": "camera-west-connection",
          result: {connection: false},
        },
      },
      {"datastream@id": "gamma", result: {alarmState: "Background"}},
    ],
  };

  assert.deepEqual(
    forceSingleConnectionObservationOffline(payload, "camera-east-connection"),
    {matched: 3, offlineMatched: 1},
  );
  assert.equal(payload.items[0]?.result?.isConnected, true);
  assert.equal(payload.items[1]?.result?.isConnected, false);
  assert.equal(payload.items[2]?.properties?.result?.connection, true);
  assert.deepEqual(payload.items[3]?.result, {alarmState: "Background"});
  assert.deepEqual(
    forceSingleConnectionObservationOffline({items: []}, "missing"),
    {matched: 0, offlineMatched: 0},
  );
});

test("mixed fixture is order-independent and keeps both connection fields consistent", () => {
  const payload = {
    items: [
      {"datastream@id": "tamper", result: {tamperStatus: true}},
      {"datastream@id": "camera-other", result: {isConnected: false, connection: false}},
      {
        properties: {
          "datastream@id": "camera-target",
          result: {isConnected: true, connection: true},
        },
      },
    ],
  };

  assert.deepEqual(
    forceSingleConnectionObservationOffline(payload, "camera-target"),
    {matched: 2, offlineMatched: 1},
  );
  assert.deepEqual(payload.items[0]?.result, {tamperStatus: true});
  assert.deepEqual(payload.items[1]?.result, {isConnected: true, connection: true});
  assert.deepEqual(payload.items[2]?.properties?.result, {isConnected: false, connection: false});

  assert.deepEqual(
    forceSingleConnectionObservationOffline(payload, "missing-target"),
    {matched: 2, offlineMatched: 0},
  );
  assert.deepEqual(payload.items[1]?.result, {isConnected: true, connection: true});
  assert.deepEqual(payload.items[2]?.properties?.result, {isConnected: true, connection: true});
});

test("connection datastream discovery accepts raw and parser-wrapped metadata", () => {
  const radConnection = "http://www.opengis.net/def/ConnectionStatus";
  const ogcConnection = "http://www.opengis.net/def/property/OGC/0/ConnectionStatus";
  assert.deepEqual(connectionDataStreamIds({
    items: [
      {
        id: "camera-east",
        observedProperties: [{definition: radConnection}],
        properties: {manufacturer: "example"},
      },
      {properties: {id: "camera-west", observedProperties: [{definition: ogcConnection}]}},
      {id: "duplicate", observedProperties: [{definition: radConnection}]},
      {id: "duplicate", observedProperties: [{definition: radConnection}]},
      {id: "gamma", observedProperties: [{definition: "http://www.opengis.net/def/Alarm"}]},
      {id: "missing-definitions"},
    ],
  }), ["camera-east", "camera-west", "duplicate"]);
  assert.deepEqual(connectionDataStreamIds({items: "not-an-array"}), []);
});
