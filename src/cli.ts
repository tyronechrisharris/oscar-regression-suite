#!/usr/bin/env node
import {execFileSync} from "node:child_process";
import {createHash} from "node:crypto";
import {mkdirSync, rmSync, writeFileSync} from "node:fs";
import {arch, hostname, platform, tmpdir} from "node:os";
import {join} from "node:path";
import {BrowserHarness} from "./browser.js";
import {assertMutationAllowed, loadConfig} from "./config.js";
import {RpmEmulatorClient} from "./emulator.js";
import {MetricsSampler} from "./metrics.js";
import {RunReporter} from "./reporter.js";
import {RegressionScenarios} from "./scenarios.js";
import {describeError} from "./util.js";

function gitCommit(): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {encoding: "utf8", stdio: ["ignore", "pipe", "ignore"]}).trim();
  } catch {
    return "uncommitted-or-unavailable";
  }
}

function acquireFullRunLock(emulatorUrl: string, rpmId: string): {path: string; release: () => void} {
  const identity = createHash("sha256").update(`${emulatorUrl}\n${rpmId}`).digest("hex").slice(0, 16);
  const path = join(tmpdir(), `oscar-regression-${identity}.lock`);
  try {
    mkdirSync(path);
    writeFileSync(join(path, "owner.json"), `${JSON.stringify({pid: process.pid, startedAt: new Date().toISOString()}, null, 2)}\n`);
  } catch {
    throw new Error(
      `Another full regression may own ${rpmId}; verify emulator state, then remove stale lock ${path}`,
    );
  }
  return {path, release: () => rmSync(path, {recursive: true, force: true})};
}

function runIdentifier(): string {
  const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
  const host = hostname().toLowerCase().replaceAll(/[^a-z0-9-]+/g, "-").slice(0, 32);
  return `${stamp}-${host}`;
}

async function main(): Promise<number> {
  process.umask(0o077);
  const startedAt = new Date();
  const config = loadConfig();
  assertMutationAllowed(config);
  const reporter = new RunReporter(runIdentifier(), config.resultsRoot, [config.oscarPassword], {
    suiteVersion: "1.0.0",
    suiteGitCommit: gitCommit(),
    profile: config.profile,
    scenarioFilter: [...config.scenarioFilter].sort(),
    nodeVersion: process.version,
    platform: platform(),
    architecture: arch(),
    browser: config.browserExecutablePath ?? "playwright-managed-chromium",
    oscarBaseUrl: config.oscarBaseUrl,
    oscarBuildLabel: config.oscarBuildLabel ?? "unspecified",
    rpmEmulatorUrl: config.rpmEmulatorUrl,
    emulatorBuildLabel: config.emulatorBuildLabel ?? "unspecified",
    testRpmId: config.testRpmId,
    testLaneLabel: config.testLaneLabel,
    expectedLaneCount: config.expectedLaneCount,
    expectedCameraCount: config.expectedCameraCount,
    eventUuidWorkflow: config.eventUuidWorkflow,
    remoteMetricsExpected: Boolean(config.oscarSshTarget),
  });
  const emulator = new RpmEmulatorClient(config.rpmEmulatorUrl);
  const browser = new BrowserHarness(config, reporter);
  const metrics = new MetricsSampler(config, reporter);
  const scenarios = new RegressionScenarios(config, reporter, browser, emulator, metrics);
  let interrupted = false;
  const fullRunLock = config.profile === "full"
    ? acquireFullRunLock(config.rpmEmulatorUrl, config.testRpmId)
    : undefined;

  const handleSignal = (signal: NodeJS.Signals) => {
    interrupted = true;
    reporter.error("harness", "signal", `${signal} received; cleanup requested`, "", "warning");
    void browser.stop();
  };
  process.on("SIGINT", handleSignal);
  process.on("SIGTERM", handleSignal);
  scenarios.setStopRequested(() => interrupted);

  try {
    await browser.start();
    await metrics.start();
    await scenarios.runReadOnly();
    if (config.profile === "full" && !interrupted) await scenarios.runFull();
  } catch (error) {
    reporter.error("harness", "runner", error);
    reporter.outcome(
      "harness", "harness", "complete regression run", config.targetHost,
      "all selected scenarios execute", "runner terminated early", "incorrect", 0, "", describeError(error),
    );
  } finally {
    if (interrupted) await scenarios.emergencyCleanup().catch((error) => reporter.error("harness", "signal-cleanup", error));
    await metrics.stop().catch((error) => reporter.error("harness", "metrics-stop", error, "", "warning"));
    await browser.stop().catch((error) => reporter.error("harness", "browser-stop", error, "", "warning"));
    fullRunLock?.release();
    process.off("SIGINT", handleSignal);
    process.off("SIGTERM", handleSignal);
  }

  const result = reporter.finalize(startedAt);
  process.stdout.write(`OSCAR regression results: ${result.outputDir}\n`);
  return interrupted ? 130 : result.exitCode;
}

main()
  .then((exitCode) => { process.exitCode = exitCode; })
  .catch((error) => {
    process.stderr.write(`OSCAR regression failed to initialize: ${describeError(error)}\n`);
    process.exitCode = 2;
  });
