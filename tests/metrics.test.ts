import assert from "node:assert/strict";
import test from "node:test";
import {parseBytes, parseDockerStats, parsePercent} from "../src/metrics.js";

test("parseBytes handles Docker binary units", () => {
  assert.equal(parseBytes("1GiB"), 1_073_741_824);
  assert.equal(parseBytes("512 MiB"), 536_870_912);
  assert.equal(parseBytes("1.5kB"), 1_500);
  assert.equal(parseBytes("invalid"), null);
});

test("parsePercent handles Docker percentages", () => {
  assert.equal(parsePercent("12.50%"), 12.5);
  assert.equal(parsePercent(undefined), null);
});

test("parseDockerStats ignores non-JSON noise", () => {
  const rows = parseDockerStats('{"Name":"oscar-1","CPUPerc":"5.0%"}\nnoise\n');
  assert.deepEqual(rows, [{Name: "oscar-1", CPUPerc: "5.0%"}]);
});
