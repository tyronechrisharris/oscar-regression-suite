import assert from "node:assert/strict";
import {mkdtempSync, readFileSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";
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
  OPERATIONAL_VIEW_WORKFLOW: "auto",
  OSCAR_LANE_CONFIG_PATH: resolve("fixtures/oscar-50-lane-config.csv"),
  EVENT_UUID_WORKFLOW: "auto",
  ALARM_TRANSFER_CAMERA_WORKFLOW: "auto",
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

test("configuration accepts UUID workflow modes and the event-uuid scenario", () => {
  withEnvironment({...baseEnvironment, EVENT_UUID_WORKFLOW: "required"}, () => {
    const config = loadConfig(["--profile", "full", "--scenario", "event-uuid"]);
    assert.equal(config.eventUuidWorkflow, "required");
    assert.deepEqual([...config.scenarioFilter], ["event-uuid"]);
  });

  withEnvironment({...baseEnvironment, EVENT_UUID_WORKFLOW: "sometimes"}, () => {
    assert.throws(() => loadConfig([]), /EVENT_UUID_WORKFLOW must be auto, required, or disabled/);
  });
});

test("configuration accepts camera workflow modes and the alarm-transfer-camera scenario", () => {
  for (const mode of ["auto", "required", "disabled"] as const) {
    withEnvironment({...baseEnvironment, ALARM_TRANSFER_CAMERA_WORKFLOW: mode}, () => {
      const config = loadConfig(["--scenario", "alarm-transfer-camera"]);
      assert.equal(config.alarmTransferCameraWorkflow, mode);
      assert.deepEqual([...config.scenarioFilter], ["alarm-transfer-camera"]);
    });
  }

  withEnvironment({...baseEnvironment, ALARM_TRANSFER_CAMERA_WORKFLOW: "sometimes"}, () => {
    assert.throws(
      () => loadConfig([]),
      /ALARM_TRANSFER_CAMERA_WORKFLOW must be auto, required, or disabled/,
    );
  });
});

test("configuration accepts the dashboard-health scenario", () => {
  withEnvironment(baseEnvironment, () => {
    const config = loadConfig(["--scenario", "dashboard-health"]);
    assert.deepEqual([...config.scenarioFilter], ["dashboard-health"]);
  });
});

test("full storage lifecycle requires an exact disposable-storage acknowledgement", () => {
  withEnvironment({...baseEnvironment, STORAGE_WORKFLOW: "required", OSCAR_SSH_TARGET: "tester@192.0.2.10",
    OSCAR_RELEASE_DIR: "/opt/oscar-test", OSCAR_STORAGE_TARGET_ACK: "192.0.2.10:/opt/oscar-test:DISPOSABLE-STORAGE"}, () => {
    const config = loadConfig(["--profile", "full", "--scenario", "storage-lifecycle"]);
    assert.doesNotThrow(() => assertMutationAllowed(config));
    assert.throws(() => assertMutationAllowed({...config, storageTargetAcknowledgement: "wrong"}),
      /OSCAR_STORAGE_TARGET_ACK/);
  });
});

test("storage paths, modes, and numeric bounds fail closed", () => {
  withEnvironment({...baseEnvironment, OSCAR_RELEASE_DIR: "relative/release"}, () => {
    assert.throws(() => loadConfig(["--scenario", "storage-health"]), /absolute remote POSIX path/);
  });
  withEnvironment({...baseEnvironment, STORAGE_WORKFLOW: "maybe"}, () => {
    assert.throws(() => loadConfig([]), /STORAGE_WORKFLOW must be auto, required, or disabled/);
  });
  withEnvironment({...baseEnvironment, STORAGE_HOT_RETENTION_DAYS: "0"}, () => {
    assert.throws(() => loadConfig([]), /STORAGE_HOT_RETENTION_DAYS must be an integer >= 1/);
  });
});

test("configuration loads the lane membership oracle and operational-view workflow mode", () => {
  withEnvironment({...baseEnvironment, OPERATIONAL_VIEW_WORKFLOW: "required"}, () => {
    const config = loadConfig(["--scenario", "operational-views"]);
    assert.equal(config.operationalViewWorkflow, "required");
    assert.equal(config.oscarLaneConfigPath, resolve("fixtures/oscar-50-lane-config.csv"));
    assert.ok(config.laneConfigOracle);
    assert.equal(config.laneConfigOracle.lanes.length, 50);
    assert.deepEqual(config.laneConfigOracle.lanesByView.get("east-gate"),
      Array.from({length: 10}, (_, index) => `Lane${String(index + 1).padStart(2, "0")}`));
  });

  withEnvironment({...baseEnvironment, OPERATIONAL_VIEW_WORKFLOW: "sometimes"}, () => {
    assert.throws(() => loadConfig([]), /OPERATIONAL_VIEW_WORKFLOW must be auto, required, or disabled/);
  });
});

test("operational-view modes default to a required gate and preserve explicit legacy behavior", () => {
  withEnvironment({...baseEnvironment, OPERATIONAL_VIEW_WORKFLOW: " "}, () => {
    assert.equal(loadConfig([]).operationalViewWorkflow, "required");
  });

  withEnvironment({
    ...baseEnvironment,
    OPERATIONAL_VIEW_WORKFLOW: "disabled",
    OSCAR_LANE_CONFIG_PATH: resolve("fixtures/does-not-exist.csv"),
    EXPECTED_LANE_COUNT: "10",
  }, () => {
    const config = loadConfig([]);
    assert.equal(config.operationalViewWorkflow, "disabled");
    assert.equal(config.laneConfigOracle, undefined);
  });

  const root = mkdtempSync(join(tmpdir(), "oscar-noncanonical-config-"));
  const legacyFixture = join(root, "ten-lanes.csv");
  const canonicalLines = readFileSync(resolve("fixtures/oscar-50-lane-config.csv"), "utf8")
    .trimEnd().split(/\r?\n/);
  writeFileSync(legacyFixture, `${canonicalLines.slice(0, 11).join("\n")}\n`);
  withEnvironment({
    ...baseEnvironment,
    OPERATIONAL_VIEW_WORKFLOW: "auto",
    OSCAR_LANE_CONFIG_PATH: legacyFixture,
    EXPECTED_LANE_COUNT: "10",
  }, () => {
    const config = loadConfig([]);
    assert.equal(config.operationalViewWorkflow, "auto");
    assert.equal(config.laneConfigOracle?.lanes.length, 10);
    assert.deepEqual([...config.laneConfigOracle?.lanesByView.keys() ?? []].sort(),
      ["east-gate", "entrance", "exit"]);
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
