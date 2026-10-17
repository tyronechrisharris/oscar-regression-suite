import {mkdirSync, readFileSync} from "node:fs";
import {resolve} from "node:path";
import {assertCanonicalOperationalViewOracle, loadLaneConfigOracle} from "./lane-config.js";
import type {CapabilityMode, Profile, SuiteConfig} from "./types.js";

function loadDotEnv(path = resolve(".env")): void {
  try {
    for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const separator = line.indexOf("=");
      if (separator < 1) continue;
      const key = line.slice(0, separator).trim();
      let value = line.slice(separator + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = value;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

function serviceUrl(name: string, requireHttps = false): {value: string; parsed: URL} {
  const value = required(name).replace(/\/+$/, "");
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid URL`);
  }
  if (!parsed.hostname) throw new Error(`${name} must include a host`);
  if (parsed.username || parsed.password) {
    throw new Error(`${name} must not include embedded credentials`);
  }
  if (requireHttps && parsed.protocol !== "https:") {
    throw new Error(`${name} must use https`);
  }
  return {value, parsed};
}

function integer(name: string, fallback: number, minimum: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw.trim())) throw new Error(`${name} must be a whole-number integer`);
  const value = Number(raw);
  if (!Number.isFinite(value) || value < minimum) {
    throw new Error(`${name} must be an integer >= ${minimum}`);
  }
  return value;
}

function boolean(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  throw new Error(`${name} must be true or false`);
}

function capabilityMode(name: string, fallback: CapabilityMode): CapabilityMode {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (["auto", "required", "disabled"].includes(raw)) {
    return raw as CapabilityMode;
  }
  throw new Error(`${name} must be auto, required, or disabled`);
}

function remoteAbsolutePath(name: string): string | undefined {
  const value = process.env[name]?.trim();
  if (!value) return undefined;
  if (!value.startsWith("/") || value.includes("\0") || /[\r\n]/.test(value)) {
    throw new Error(`${name} must be an absolute remote POSIX path without control characters`);
  }
  if (value.split("/").includes("..")) {
    throw new Error(`${name} must not contain parent-directory segments`);
  }
  return value.replace(/\/+$/, "") || "/";
}

interface ParsedArguments {
  profile?: string;
  scenario?: string;
}

function parseArguments(args: string[]): ParsedArguments {
  const values = new Map<string, string>();
  const supported = new Set(["--profile", "--scenario"]);

  for (let index = 0; index < args.length; index++) {
    const flag = args[index] ?? "";
    if (!supported.has(flag)) {
      if (flag.startsWith("-")) throw new Error(`Unknown argument ${flag}`);
      throw new Error(`Unexpected positional argument ${flag}`);
    }
    if (values.has(flag)) throw new Error(`Duplicate argument ${flag}`);

    const rawValue = args[index + 1];
    if (rawValue === undefined || rawValue.startsWith("-") || !rawValue.trim()) {
      throw new Error(`${flag} requires a non-empty value`);
    }
    values.set(flag, rawValue.trim());
    index++;
  }

  const profile = values.get("--profile");
  const scenario = values.get("--scenario");
  return {
    ...(profile === undefined ? {} : {profile}),
    ...(scenario === undefined ? {} : {scenario}),
  };
}

export function loadConfig(args = process.argv.slice(2)): SuiteConfig {
  loadDotEnv();
  const parsedArguments = parseArguments(args);
  const profileRaw = parsedArguments.profile ?? "smoke";
  if (profileRaw !== "smoke" && profileRaw !== "full") {
    throw new Error("--profile must be smoke or full");
  }
  const profile: Profile = profileRaw;
  const {value: oscarBaseUrl, parsed} = serviceUrl("OSCAR_BASE_URL", true);
  const {value: rpmEmulatorUrl, parsed: rpmParsed} = serviceUrl("RPM_EMULATOR_URL");
  const resultsRoot = resolve(process.env.RESULTS_ROOT?.trim() || "results");
  mkdirSync(resultsRoot, {recursive: true});
  const expectedLaneCount = integer("EXPECTED_LANE_COUNT", 50, 1);
  const operationalViewWorkflow = capabilityMode("OPERATIONAL_VIEW_WORKFLOW", "required");
  const oscarLaneConfigPath = resolve(
    process.env.OSCAR_LANE_CONFIG_PATH?.trim() || "fixtures/oscar-50-lane-config.csv",
  );
  const laneConfigOracle = operationalViewWorkflow === "disabled"
    ? undefined
    : loadLaneConfigOracle(oscarLaneConfigPath);
  if (operationalViewWorkflow === "required" && laneConfigOracle) {
    assertCanonicalOperationalViewOracle(laneConfigOracle, expectedLaneCount);
  }

  const scenarioValues = parsedArguments.scenario === undefined
    ? []
    : parsedArguments.scenario.split(",").map((value) => value.trim());
  if (scenarioValues.some((value) => !value)) {
    throw new Error("--scenario requires non-empty comma-separated scenario names");
  }
  const knownScenarios = new Set([
    "preflight", "viewer-navigation", "map-national-servers", "sensorhub-admin",
    "status-of-health", "dashboard-health", "lane-video", "event-filtering", "operational-views",
    "reporting", "alarm-transfer", "alarm-transfer-camera", "rpm-connection", "rpm-faults", "rpm-alarms",
    "event-uuid", "adjudication", "extended-occupancy", "adjudication-report",
    "storage-health", "storage-lifecycle",
  ]);
  const unknownScenarios = scenarioValues.filter((value) => !knownScenarios.has(value));
  if (unknownScenarios.length) {
    throw new Error(`Unknown --scenario value(s): ${unknownScenarios.join(", ")}`);
  }
  const oscarReleaseDirectory = remoteAbsolutePath("OSCAR_RELEASE_DIR");

  return {
    profile,
    oscarBaseUrl,
    oscarUsername: required("OSCAR_USERNAME"),
    oscarPassword: required("OSCAR_PASSWORD"),
    targetHost: parsed.hostname,
    targetAcknowledgement: required("OSCAR_TEST_TARGET_ACK"),
    rpmEmulatorUrl,
    rpmEmulatorHost: rpmParsed.hostname,
    rpmEmulatorAcknowledgement: process.env.RPM_EMULATOR_TARGET_ACK?.trim() || "",
    rpmLaneMappingAcknowledgement: process.env.RPM_LANE_MAPPING_ACK?.trim() || "",
    testRpmId: process.env.TEST_RPM_ID?.trim() || "rpm-50",
    testLaneLabel: process.env.TEST_LANE_LABEL?.trim() || "Lane50",
    expectedLaneCount,
    expectedCameraCount: integer("EXPECTED_CAMERA_COUNT", 50, 0),
    operationalViewWorkflow,
    oscarLaneConfigPath,
    ...(laneConfigOracle ? {laneConfigOracle} : {}),
    ...(process.env.OSCAR_SSH_TARGET?.trim()
      ? {oscarSshTarget: process.env.OSCAR_SSH_TARGET.trim()} : {}),
    ...(process.env.OSCAR_SSH_IDENTITY_FILE?.trim()
      ? {sshIdentityFile: process.env.OSCAR_SSH_IDENTITY_FILE.trim()} : {}),
    ...(process.env.BROWSER_EXECUTABLE_PATH?.trim()
      ? {browserExecutablePath: process.env.BROWSER_EXECUTABLE_PATH.trim()} : {}),
    ...(process.env.OSCAR_BUILD_LABEL?.trim()
      ? {oscarBuildLabel: process.env.OSCAR_BUILD_LABEL.trim()} : {}),
    ...(process.env.EMULATOR_BUILD_LABEL?.trim()
      ? {emulatorBuildLabel: process.env.EMULATOR_BUILD_LABEL.trim()} : {}),
    headless: boolean("HEADLESS", true),
    metricsIntervalMs: integer("METRICS_INTERVAL_MS", 5_000, 1_000),
    uiTimeoutMs: integer("UI_TIMEOUT_MS", 30_000, 1_000),
    eventTimeoutMs: integer("EVENT_TIMEOUT_MS", 90_000, 10_000),
    extendedOccupancySeconds: integer("EXTENDED_OCCUPANCY_SECONDS", 70, 61),
    eventUuidWorkflow: capabilityMode("EVENT_UUID_WORKFLOW", "auto"),
    alarmTransferCameraWorkflow: capabilityMode("ALARM_TRANSFER_CAMERA_WORKFLOW", "auto"),
    storageWorkflow: capabilityMode("STORAGE_WORKFLOW", "auto"),
    storageExpectedRelease: "3.9.2",
    storageBackupWorkflow: capabilityMode("STORAGE_BACKUP_WORKFLOW", "auto"),
    storageTargetAcknowledgement: process.env.OSCAR_STORAGE_TARGET_ACK?.trim() || "",
    ...(oscarReleaseDirectory ? {oscarReleaseDirectory} : {}),
    ...(process.env.STORAGE_RETAINED_EVENT_ID?.trim()
      ? {storageRetainedEventId: process.env.STORAGE_RETAINED_EVENT_ID.trim()} : {}),
    ...(process.env.STORAGE_LEGACY_EVENT_ID?.trim()
      ? {storageLegacyEventId: process.env.STORAGE_LEGACY_EVENT_ID.trim()} : {}),
    ...(process.env.STORAGE_EVENT_NODE_ID?.trim()
      ? {storageEventNodeId: process.env.STORAGE_EVENT_NODE_ID.trim()} : {}),
    storageDatabaseScope: integer("STORAGE_DATABASE_SCOPE", 4, 0),
    storageHotRetentionDays: integer("STORAGE_HOT_RETENTION_DAYS", 30, 1),
    storageArchiveTimeoutMs: integer("STORAGE_ARCHIVE_TIMEOUT_MS", 300_000, 60_000),
    storageProbeTimeoutMs: integer("STORAGE_PROBE_TIMEOUT_MS", 1_800_000, 60_000),
    resultsRoot,
    scenarioFilter: new Set(scenarioValues),
  };
}

export function assertMutationAllowed(config: SuiteConfig): void {
  if (config.targetAcknowledgement !== config.targetHost) {
    throw new Error(`Regression refused: OSCAR_TEST_TARGET_ACK must exactly equal ${config.targetHost}`);
  }
  if (config.profile !== "full") return;
  if (["localhost", "127.0.0.1", "::1"].includes(config.targetHost)) {
    throw new Error("Full regression refused for a loopback target");
  }
  if (config.rpmEmulatorAcknowledgement !== config.rpmEmulatorHost) {
    throw new Error(
      `Full regression refused: RPM_EMULATOR_TARGET_ACK must exactly equal ${config.rpmEmulatorHost}`,
    );
  }
  const expectedMapping = `${config.testRpmId}:${config.testLaneLabel}`;
  if (config.rpmLaneMappingAcknowledgement !== expectedMapping) {
    throw new Error(
      `Full regression refused: RPM_LANE_MAPPING_ACK must exactly equal ${expectedMapping}`,
    );
  }

  const storageSelected = config.storageWorkflow !== "disabled" &&
    (config.scenarioFilter.size === 0 || config.scenarioFilter.has("storage-lifecycle"));
  if (storageSelected) {
    if (!config.oscarSshTarget || !config.oscarReleaseDirectory) {
      throw new Error(
        "Full storage regression refused: OSCAR_SSH_TARGET and OSCAR_RELEASE_DIR are required",
      );
    }
    const acknowledgement =
      `${config.targetHost}:${config.oscarReleaseDirectory}:DISPOSABLE-STORAGE`;
    if (config.storageTargetAcknowledgement !== acknowledgement) {
      throw new Error(
        `Full storage regression refused: OSCAR_STORAGE_TARGET_ACK must exactly equal ${acknowledgement}`,
      );
    }
  }
}
