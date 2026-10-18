import assert from "node:assert/strict";
import {mkdtempSync, readFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";
import {RunReporter} from "../src/reporter.js";
import type {MetricSample, OscarComposeService, RunMetadata} from "../src/types.js";

const metadata: RunMetadata = {
  suiteVersion: "test", suiteGitCommit: "test", profile: "smoke", scenarioFilter: [],
  nodeVersion: process.version, platform: process.platform, architecture: process.arch,
  browser: "test", oscarBaseUrl: "https://oscar.test", oscarBuildLabel: "test",
  rpmEmulatorUrl: "http://emulator.test", emulatorBuildLabel: "test",
  testRpmId: "rpm-50", testLaneLabel: "Lane50", expectedLaneCount: 50,
  expectedCameraCount: 50, operationalViewWorkflow: "auto",
  oscarLaneConfigPath: "fixtures/oscar-50-lane-config.csv",
  oscarLaneConfigSha256: "test-sha256",
  operationalViewLaneCounts: {"east-gate": 10, entrance: 25},
  eventUuidWorkflow: "auto", alarmTransferCameraWorkflow: "required",
  storageWorkflow: "auto", storageExpectedRelease: "3.9.2", storageBackupWorkflow: "auto",
  remoteMetricsExpected: false,
};

type MetricInput = Omit<MetricSample, "runId" | "timestamp">;

function containerMetric(
  phase: string,
  service: OscarComposeService,
  overrides: Partial<MetricInput> = {},
): MetricInput {
  return {
    phase,
    source: "oscar-container",
    target: `oscar-${service}-1`,
    composeService: service,
    containerId: service.repeat(16).slice(0, 64).padEnd(64, service[0]),
    containerState: "running",
    containerHealth: "healthy",
    containerStatsAvailable: true,
    cpuPercent: 20,
    memoryUsedBytes: 100,
    memoryLimitBytes: 1_000,
    memoryPercent: 10,
    pids: 10,
    restartCount: 0,
    oomKilled: false,
    load1m: 1,
    hostMemoryAvailableBytes: 1_000,
    note: "",
    ...overrides,
  };
}

test("reporter aggregates correct and incorrect behavior and redacts secrets", () => {
  const root = mkdtempSync(join(tmpdir(), "oscar-regression-"));
  const reporter = new RunReporter("run-1", root, ["private-value"], {...metadata});
  reporter.outcome("tamper", "fault-detection", "assert", "Lane 1", "Fault", "Fault", "correct", 10);
  reporter.outcome("tamper", "fault-resolution", "clear", "Lane 1", "Clear", "private-value failed", "incorrect", 20);
  reporter.error("tamper", "browser", "authorization: Basic abcdef== private-value");
  reporter.metric({
    phase: "tamper", source: "oscar-container", target: "oscar-1", cpuPercent: 20,
    composeService: "oscar", containerId: "a".repeat(64), containerState: "running",
    containerHealth: "healthy", containerStatsAvailable: true,
    memoryUsedBytes: 100, memoryLimitBytes: 1_000, memoryPercent: 10, pids: 10,
    restartCount: 0, oomKilled: false, load1m: 1, hostMemoryAvailableBytes: 1_000, note: "",
  });
  reporter.storageMetric({phase: "after-batch", databaseSizeBytes: 100, observationTableBytes: 50,
    observationIndexBytes: 25, walBytes: 10, tempBytes: 0, tuplesInserted: 10, tuplesUpdated: 0,
    tuplesDeleted: 0, transactionCommits: 2, transactionRollbacks: 0, observationInsertCalls: 1,
    observationInsertRows: 10, observationRowsPerCall: 10, activeArchiveGenerations: 1,
    sealedArchiveGenerations: 0, archiveRows: 5, archiveBytes: 20, failedArchiveJobs: 0,
    failedParityReceipts: 0, activeHolds: 0, verifiedBackups: 1, journalBytes: 10,
    dailyFileBytes: 10, retainedMediaBytes: 10, retainedMediaManifestFiles: 1,
    retainedMediaJpegFiles: 5, processedObservationIndexFiles: 1,
    processedObservationIndexBytes: 52, deletionIndexFiles: 0, deletionIndexBytes: 0,
    legacyProcessedMarkerFiles: 0, legacyDeletionTombstones: 0,
    mediaMetadataCheckpointBytes: 100, backupBytes: 10, note: ""});
  const result = reporter.finalize(new Date(Date.now() - 1_000));
  assert.equal(result.exitCode, 1);
  const functional = readFileSync(join(result.outputDir, "functional-results.csv"), "utf8");
  const errors = readFileSync(join(result.outputDir, "errors.csv"), "utf8");
  const summary = readFileSync(join(result.outputDir, "summary.md"), "utf8");
  const run = JSON.parse(readFileSync(join(result.outputDir, "run.json"), "utf8")) as {
    environment: RunMetadata;
  };
  assert.match(functional, /\[REDACTED\] failed/);
  assert.doesNotMatch(functional, /private-value/);
  assert.match(errors, /Basic \[REDACTED\]/);
  assert.match(summary, /1 correct, 1 incorrect/);
  assert.equal(run.environment.operationalViewWorkflow, "auto");
  assert.equal(run.environment.alarmTransferCameraWorkflow, "required");
  assert.equal(run.environment.oscarLaneConfigSha256, "test-sha256");
  assert.deepEqual(run.environment.operationalViewLaneCounts, {"east-gate": 10, entrance: 25});
  const storage = readFileSync(join(result.outputDir, "storage-performance.csv"), "utf8");
  assert.match(storage, /after-batch/);
  assert.match(storage, /processedObservationIndexBytes/);
  assert.match(storage, /legacyDeletionTombstones/);
});

test("reporter fails an empty run and a run with a standalone runtime error", () => {
  const emptyRoot = mkdtempSync(join(tmpdir(), "oscar-regression-empty-"));
  const empty = new RunReporter("empty", emptyRoot, [], {...metadata});
  assert.equal(empty.finalize(new Date()).exitCode, 1);

  const errorRoot = mkdtempSync(join(tmpdir(), "oscar-regression-error-"));
  const errored = new RunReporter("errored", errorRoot, [], {...metadata});
  errored.outcome("navigation", "viewer", "open", "/", "loads", "loaded", "correct", 1);
  errored.error("navigation", "viewer-page", "uncaught UI exception");
  assert.equal(errored.finalize(new Date()).exitCode, 1);
});

test("remote health checks cannot turn an otherwise empty run into a pass", () => {
  const root = mkdtempSync(join(tmpdir(), "oscar-regression-metrics-only-"));
  const reporter = new RunReporter("metrics-only", root, [], {...metadata, remoteMetricsExpected: true});
  reporter.requireRemoteMetricPhase("initialization");
  for (const service of ["gateway", "oscar", "postgres"] as const) {
    reporter.metric(containerMetric("initialization", service));
  }
  const result = reporter.finalize(new Date());
  assert.equal(result.exitCode, 1);
  assert.match(readFileSync(join(result.outputDir, "summary.md"), "utf8"),
    /No non-performance functional checks were evaluated/);
});

test("reporter emits per-action correctness aggregates", () => {
  const root = mkdtempSync(join(tmpdir(), "oscar-regression-action-"));
  const reporter = new RunReporter("actions", root, [], {...metadata});
  reporter.outcome("rpm-faults", "fault-resolution", "resolve Tamper", "Lane50", "Clear", "Clear", "correct", 1);
  const result = reporter.finalize(new Date());
  const summary = readFileSync(join(result.outputDir, "summary.csv"), "utf8");
  assert.match(summary, /action:rpm-faults\/resolve Tamper/);
});

test("performance aggregates use arithmetic means of non-null samples", () => {
  const root = mkdtempSync(join(tmpdir(), "oscar-regression-aggregate-"));
  const reporter = new RunReporter("aggregates", root, [], {...metadata});
  for (const [cpuPercent, memoryUsedBytes] of [[10, 100], [20, 300], [null, null]] as const) {
    reporter.metric({
      phase: "load",
      source: "test-runner",
      target: "regression-process",
      composeService: null,
      containerId: null,
      containerState: null,
      containerHealth: null,
      containerStatsAvailable: null,
      cpuPercent,
      memoryUsedBytes,
      memoryLimitBytes: 1_000,
      memoryPercent: null,
      pids: 1,
      restartCount: 0,
      oomKilled: false,
      load1m: null,
      hostMemoryAvailableBytes: null,
      note: "",
    });
  }
  const row = reporter.aggregate().find((item) =>
    item.section === "performance" && item.group === "test-runner:regression-process");
  assert.equal(row?.total, 3);
  assert.equal(row?.peakCpuPercent, 20);
  assert.equal(row?.averageCpuPercent, 15);
  assert.equal(row?.peakMemoryBytes, 300);
  assert.equal(row?.averageMemoryBytes, 200);
});

test("remote metrics pass only with exact healthy service coverage in every required phase", () => {
  const root = mkdtempSync(join(tmpdir(), "oscar-regression-remote-pass-"));
  const reporter = new RunReporter("remote-pass", root, [], {...metadata, remoteMetricsExpected: true});
  for (const phase of ["initialization", "load"]) {
    reporter.requireRemoteMetricPhase(phase);
    for (const service of ["gateway", "oscar", "postgres"] as const) {
      reporter.metric(containerMetric(phase, service));
    }
  }
  reporter.metric({
    phase: "load", source: "oscar-host", target: "operator@metrics.test",
    composeService: null, containerId: null, containerState: null, containerHealth: null,
    containerStatsAvailable: null, cpuPercent: 5, memoryUsedBytes: 100,
    memoryLimitBytes: 1_000, memoryPercent: 10, pids: null, restartCount: null,
    oomKilled: null, load1m: 1, hostMemoryAvailableBytes: 900, note: "host aggregate",
  });
  reporter.outcome("load", "performance-fixture", "exercise workload", "fixture",
    "completes", "completed", "correct", 1);

  const result = reporter.finalize(new Date());
  assert.equal(result.exitCode, 0);
  const functional = readFileSync(join(result.outputDir, "functional-results.csv"), "utf8");
  const performance = readFileSync(join(result.outputDir, "performance.csv"), "utf8");
  assert.match(functional, /capture exact OSCAR Compose service metrics,operator@metrics\.test/);
  assert.doesNotMatch(functional, /,incorrect,/);
  assert.match(performance, /composeService,containerId,containerState,containerHealth,containerStatsAvailable/);
  const containerGroups = reporter.aggregate().filter((item) =>
    item.section === "performance" && item.group.startsWith("oscar-container:"));
  assert.equal(containerGroups.length, 3);
});

test("remote metrics fail closed for unrelated, missing, stopped, OOM, restarted, and recreated containers", () => {
  const root = mkdtempSync(join(tmpdir(), "oscar-regression-remote-fail-"));
  const reporter = new RunReporter("remote-fail", root, [], {...metadata, remoteMetricsExpected: true});
  reporter.requireRemoteMetricPhase("phase-a");
  reporter.requireRemoteMetricPhase("phase-b");

  for (const service of ["gateway", "oscar", "postgres"] as const) {
    reporter.metric(containerMetric("phase-a", service));
  }
  reporter.metric(containerMetric("phase-b", "gateway", {containerId: "f".repeat(64)}));
  reporter.metric(containerMetric("phase-b", "oscar", {
    target: "oscar",
    containerId: null,
    containerState: null,
    containerHealth: null,
    containerStatsAvailable: false,
    cpuPercent: null,
    memoryUsedBytes: null,
    memoryLimitBytes: null,
    memoryPercent: null,
    pids: null,
    restartCount: null,
    oomKilled: null,
  }));
  reporter.metric(containerMetric("phase-b", "postgres", {
    containerState: "exited",
    containerHealth: "unhealthy",
    containerStatsAvailable: false,
    cpuPercent: null,
    memoryUsedBytes: null,
    memoryLimitBytes: null,
    memoryPercent: null,
    pids: null,
    restartCount: 1,
    oomKilled: true,
  }));
  reporter.metric({
    ...containerMetric("phase-b", "gateway"),
    target: "unrelated-running-container",
    composeService: null,
    containerId: "9".repeat(64),
  });

  const result = reporter.finalize(new Date());
  assert.equal(result.exitCode, 1);
  const functional = readFileSync(join(result.outputDir, "functional-results.csv"), "utf8");
  assert.match(functional, /missing phase\/service coverage: phase-b\/oscar/);
  assert.match(functional, /detect stopped OSCAR containers/);
  assert.match(functional, /detect unhealthy OSCAR containers/);
  assert.match(functional, /OOM-killed: phase-b\/postgres/);
  assert.match(functional, /restart count changed: postgres/);
  assert.match(functional, /gateway used multiple container IDs/);
  assert.match(functional, /oscar absent in phase-b/);
});
