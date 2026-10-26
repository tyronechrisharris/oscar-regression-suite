import assert from "node:assert/strict";
import test from "node:test";
import {alarmRowMatchesTrigger, type AlarmTriggerIdentity} from "../src/alarm-trigger.js";

const trigger: AlarmTriggerIdentity = {
  occupancyCount: 1,
  initiatedAtEpochMs: Date.parse("2026-10-23T14:00:00.734Z"),
};

test("alarm rows are scoped to the trigger even when an emulator reuses an occupancy count", () => {
  assert.equal(alarmRowMatchesTrigger({
    occupancyCount: "1",
    startTime: "2026-10-23T13:00:00.000Z",
    text: "Lane50 Gamma 1",
  }, /Gamma/i, trigger), false, "a pre-trigger row with the reused counter must be rejected");
  assert.equal(alarmRowMatchesTrigger({
    occupancyCount: "1",
    startTime: "2026-10-23T14:00:00.000Z",
    text: "Lane50 Gamma 1",
  }, /Gamma/i, trigger), true, "Viewer second precision must still match the creating trigger");
});

test("alarm row matching rejects the wrong counter, alarm type, and malformed time", () => {
  assert.equal(alarmRowMatchesTrigger({
    occupancyCount: "2", startTime: "2026-10-23T14:00:01Z", text: "Lane50 Gamma",
  }, /Gamma/i, trigger), false);
  assert.equal(alarmRowMatchesTrigger({
    occupancyCount: "1", startTime: "2026-10-23T14:00:01Z", text: "Lane50 Neutron",
  }, /Gamma/i, trigger), false);
  assert.equal(alarmRowMatchesTrigger({
    occupancyCount: "1", startTime: "not-a-time", text: "Lane50 Gamma",
  }, /Gamma/i, trigger), false);
});
