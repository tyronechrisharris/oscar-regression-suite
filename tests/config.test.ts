import assert from "node:assert/strict";
import test from "node:test";
import {assertMutationAllowed, loadConfig} from "../src/config.js";

const baseEnvironment = {
  OSCAR_BASE_URL: "https://192.0.2.10",
  OSCAR_USERNAME: "admin",
  OSCAR_PASSWORD: "test-only",
  OSCAR_TEST_TARGET_ACK: "192.0.2.10",
  RPM_EMULATOR_URL: "http://192.0.2.20:8000",
  RPM_EMULATOR_TARGET_ACK: "192.0.2.20",
  TEST_RPM_ID: "rpm-50",
  TEST_LANE_LABEL: "Lane50",
  RPM_LANE_MAPPING_ACK: "rpm-50:Lane50",
};

function withEnvironment(values: Record<string, string>, operation: () => void): void {
  const names = Object.keys(values);
  const original = new Map(names.map((name) => [name, process.env[name]]));
  Object.assign(process.env, values);
  try { operation(); } finally {
    for (const [name, value] of original) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test("full profile requires exact OSCAR, emulator, and RPM/lane acknowledgements", () => {
  withEnvironment(baseEnvironment, () => {
    const valid = loadConfig(["--profile", "full", "--scenario", "rpm-faults"]);
    assert.doesNotThrow(() => assertMutationAllowed(valid));

    assert.throws(
      () => assertMutationAllowed({...valid, rpmEmulatorAcknowledgement: "wrong-host"}),
      /RPM_EMULATOR_TARGET_ACK/,
    );
    assert.throws(
      () => assertMutationAllowed({...valid, rpmLaneMappingAcknowledgement: "rpm-49:Lane49"}),
      /RPM_LANE_MAPPING_ACK/,
    );
  });
});

test("configuration rejects unknown scenarios and partial integer values", () => {
  withEnvironment(baseEnvironment, () => {
    assert.throws(() => loadConfig(["--scenario", "rpm-fualts"]), /Unknown --scenario/);
    process.env.EXPECTED_LANE_COUNT = "50junk";
    assert.throws(() => loadConfig([]), /whole-number integer/);
    delete process.env.EXPECTED_LANE_COUNT;
  });
});

test("configuration rejects missing and empty CLI flag values", () => {
  withEnvironment(baseEnvironment, () => {
    for (const args of [
      ["--profile"],
      ["--scenario"],
      ["--scenario", ""],
      ["--scenario", "   "],
      ["--scenario", ","],
      ["--profile", "--scenario", "rpm-faults"],
    ]) {
      assert.throws(() => loadConfig(args), /requires/);
    }
  });
});

test("configuration rejects duplicate CLI flags", () => {
  withEnvironment(baseEnvironment, () => {
    assert.throws(
      () => loadConfig(["--profile", "full", "--profile", "smoke"]),
      /Duplicate argument --profile/,
    );
    assert.throws(
      () => loadConfig(["--scenario", "rpm-faults", "--scenario", "adjudication"]),
      /Duplicate argument --scenario/,
    );
  });
});

test("configuration rejects unknown flags and positional arguments", () => {
  withEnvironment(baseEnvironment, () => {
    assert.throws(
      () => loadConfig(["--scenaro", "rpm-faults"]),
      /Unknown argument --scenaro/,
    );
    assert.throws(
      () => loadConfig(["rpm-faults"]),
      /Unexpected positional argument rpm-faults/,
    );
    assert.throws(
      () => loadConfig(["--scenario=rpm-faults"]),
      /Unknown argument --scenario=rpm-faults/,
    );
  });
});

test("configuration requires HTTPS for OSCAR", () => {
  withEnvironment({...baseEnvironment, OSCAR_BASE_URL: "http://192.0.2.10"}, () => {
    assert.throws(() => loadConfig([]), /OSCAR_BASE_URL must use https/);
  });
});

test("configuration rejects embedded OSCAR and emulator URL credentials", () => {
  withEnvironment({...baseEnvironment, OSCAR_BASE_URL: "https://admin:secret@192.0.2.10"}, () => {
    assert.throws(() => loadConfig([]), /OSCAR_BASE_URL must not include embedded credentials/);
  });
  withEnvironment({...baseEnvironment, RPM_EMULATOR_URL: "http://operator:secret@192.0.2.20:8000"}, () => {
    assert.throws(() => loadConfig([]), /RPM_EMULATOR_URL must not include embedded credentials/);
  });
});
