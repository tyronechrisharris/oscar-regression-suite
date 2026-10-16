import assert from "node:assert/strict";
import {mkdtempSync, readFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";
import {RunReporter} from "../src/reporter.js";
import type {RunMetadata} from "../src/types.js";

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
  eventUuidWorkflow: "auto", remoteMetricsExpected: false,
};

test("reporter aggregates correct and incorrect behavior and redacts secrets", () => {
  const root = mkdtempSync(join(tmpdir(), "oscar-regression-"));
  const reporter = new RunReporter("run-1", root, ["private-value"], {...metadata});
  reporter.outcome("tamper", "fault-detection", "assert", "Lane 1", "Fault", "Fault", "correct", 10);
  reporter.outcome("tamper", "fault-resolution", "clear", "Lane 1", "Clear", "private-value failed", "incorrect", 20);
  reporter.error("tamper", "browser", "authorization: Basic abcdef== private-value");
  reporter.metric({
    phase: "tamper", source: "oscar-container", target: "oscar-1", cpuPercent: 20,
    memoryUsedBytes: 100, memoryLimitBytes: 1_000, memoryPercent: 10, pids: 10,
    restartCount: 0, oomKilled: false, load1m: 1, hostMemoryAvailableBytes: 1_000, note: "",
  });
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
  assert.equal(run.environment.oscarLaneConfigSha256, "test-sha256");
  assert.deepEqual(run.environment.operationalViewLaneCounts, {"east-gate": 10, entrance: 25});
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

test("reporter emits per-action correctness aggregates", () => {
  const root = mkdtempSync(join(tmpdir(), "oscar-regression-action-"));
  const reporter = new RunReporter("actions", root, [], {...metadata});
  reporter.outcome("rpm-faults", "fault-resolution", "resolve Tamper", "Lane50", "Clear", "Clear", "correct", 1);
  const result = reporter.finalize(new Date());
  const summary = readFileSync(join(result.outputDir, "summary.csv"), "utf8");
  assert.match(summary, /action:rpm-faults\/resolve Tamper/);
});
