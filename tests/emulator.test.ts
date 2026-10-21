import assert from "node:assert/strict";
import test from "node:test";
import {assessKnownClearTamperBaseline, RpmEmulatorClient} from "../src/emulator.js";
import type {RpmConfig} from "../src/types.js";

const original: RpmConfig = {
  name: "Lane50",
  port: 10050,
  occupancy_frequency: 0.75,
  occupancy_schedule_enabled: true,
  occupancy_duration_range: [6, 10],
  gamma_alarm_probability: 0.4,
  neutron_alarm_probability: 0.2,
  unique_alarm_probability: 0.1,
  camera_ids: ["camera-50"],
};

test("short alarm config creates an isolated deterministic one-second occupancy", () => {
  const client = new RpmEmulatorClient("http://127.0.0.1:8000");
  const configured = client.shortAlarmConfig(original);

  assert.deepEqual(configured.occupancy_duration_range, [1, 1]);
  assert.equal(configured.occupancy_frequency, 0);
  assert.equal(configured.occupancy_schedule_enabled, false);
  assert.equal(configured.gamma_alarm_probability, 0);
  assert.equal(configured.neutron_alarm_probability, 0);
  assert.equal(configured.unique_alarm_probability, 0);
  assert.deepEqual(configured.camera_ids, ["camera-50"]);
  assert.deepEqual(original.occupancy_duration_range, [6, 10]);
  assert.equal(original.occupancy_frequency, 0.75);
});

test("short alarm config rejects non-positive and fractional durations", () => {
  const client = new RpmEmulatorClient("http://127.0.0.1:8000");
  for (const duration of [0, -1, 1.5, Number.NaN]) {
    assert.throws(() => client.shortAlarmConfig(original, duration), /positive whole number/);
  }
});

test("known-clear Tamper baseline requires an explicit false state from every connected RPM", () => {
  const assessment = assessKnownClearTamperBaseline([
    {rpmId: "rpm-01", running: true, connectedClients: 1, tamperFault: false},
    {rpmId: "rpm-02", running: true, connectedClients: 2, tamperFault: false},
  ], 2);

  assert.deepEqual(assessment, {
    passed: true,
    expectedCount: 2,
    rpmCount: 2,
    clearCount: 2,
    duplicateIds: [],
    stoppedIds: [],
    disconnectedIds: [],
    activeIds: [],
    unknownIds: [],
  });
});

test("known-clear Tamper baseline never infers clear from connectivity", () => {
  const assessment = assessKnownClearTamperBaseline([
    {rpmId: "rpm-01", running: true, connectedClients: 1, tamperFault: null},
    {rpmId: "rpm-02", running: true, connectedClients: 1, tamperFault: true},
    {rpmId: "rpm-03", running: false, connectedClients: null, tamperFault: null},
  ], 3);

  assert.equal(assessment.passed, false);
  assert.equal(assessment.clearCount, 0);
  assert.deepEqual(assessment.unknownIds, ["rpm-01", "rpm-03"]);
  assert.deepEqual(assessment.activeIds, ["rpm-02"]);
  assert.deepEqual(assessment.stoppedIds, ["rpm-03"]);
  assert.deepEqual(assessment.disconnectedIds, ["rpm-03"]);
});

test("known-clear Tamper baseline rejects duplicate and incomplete inventories", () => {
  const assessment = assessKnownClearTamperBaseline([
    {rpmId: "rpm-01", running: true, connectedClients: 1, tamperFault: false},
    {rpmId: "rpm-01", running: true, connectedClients: 1, tamperFault: false},
  ], 2);

  assert.equal(assessment.passed, false);
  assert.deepEqual(assessment.duplicateIds, ["rpm-01"]);
});
