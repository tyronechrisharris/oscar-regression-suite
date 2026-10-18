import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {mkdtempSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";
import {
  buildOscarMetricsCommand,
  MetricsSampler,
  parseBytes,
  parseDockerStats,
  parseOscarDockerSnapshot,
  parsePercent,
} from "../src/metrics.js";
import {RunReporter} from "../src/reporter.js";
import type {RunMetadata, SuiteConfig} from "../src/types.js";

const HEALTHY_IDS = {
  gateway: "1".repeat(64),
  oscar: "2".repeat(64),
  postgres: "3".repeat(64),
} as const;

function healthyRemoteOutput(): string {
  const inspections = Object.entries(HEALTHY_IDS).map(([service, id]) => JSON.stringify({
    Id: id,
    Name: `/oscar-${service}-1`,
    RestartCount: 0,
    Config: {Labels: {
      "com.docker.compose.project": "oscar",
      "com.docker.compose.service": service,
    }},
    State: {Status: "running", Running: true, OOMKilled: false, Health: {Status: "healthy"}},
  }));
  const stats = Object.entries(HEALTHY_IDS).map(([service, id]) => JSON.stringify({
    ID: id.slice(0, 12),
    Name: `oscar-${service}-1`,
    CPUPerc: "1%",
    MemUsage: "10MiB / 1GiB",
    MemPerc: "1%",
    PIDs: "5",
  }));
  return [
    "__CONTAINERS__",
    ...inspections,
    "__STATS__",
    ...stats,
    "__HOST__",
    "0.5",
    "1000",
    "2000",
    "100 50",
  ].join("\n");
}

test("parseBytes handles Docker binary units", () => {
  assert.equal(parseBytes("1GiB"), 1_073_741_824);
  assert.equal(parseBytes("512 MiB"), 536_870_912);
  assert.equal(parseBytes("1.5kB"), 1_500);
  assert.equal(parseBytes("invalid"), null);
});

test("parsePercent handles Docker percentages", () => {
  assert.equal(parsePercent("12.50%"), 12.5);
  assert.equal(parsePercent("12.5% trailing"), null);
  assert.equal(parsePercent(undefined), null);
});

test("parseDockerStats ignores non-JSON noise", () => {
  const rows = parseDockerStats('{"Name":"oscar-1","CPUPerc":"5.0%"}\nnoise\n');
  assert.deepEqual(rows, [{Name: "oscar-1", CPUPerc: "5.0%"}]);
});

test("remote command scopes all-state discovery to the exact OSCAR Compose services", () => {
  const command = buildOscarMetricsCommand();
  assert.match(command, /docker ps --all --quiet --no-trunc/);
  assert.match(command, /label=com\.docker\.compose\.project=oscar/);
  assert.match(command, /label=com\.docker\.compose\.service=\$service/);
  assert.match(command, /for service in gateway oscar postgres/);
  assert.doesNotMatch(command, /docker stats --no-stream --format '\{\{json \.\}\}'\s*(?:\n|$)/);
  const syntax = spawnSync("sh", ["-n"], {input: command, encoding: "utf8"});
  assert.equal(syntax.status, 0, syntax.stderr);
});

test("OSCAR snapshot parsing includes stopped and missing services while ignoring unrelated containers", () => {
  const gatewayId = "a".repeat(64);
  const oscarId = "b".repeat(64);
  const unrelatedId = "c".repeat(64);
  const inspection = (
    id: string,
    name: string,
    project: string,
    service: string,
    state: string,
    health: string,
    oomKilled: boolean,
    restartCount: number,
  ) => JSON.stringify({
    Id: id,
    Name: `/${name}`,
    RestartCount: restartCount,
    Config: {Labels: {
      "com.docker.compose.project": project,
      "com.docker.compose.service": service,
    }},
    State: {Status: state, Running: state === "running", OOMKilled: oomKilled, Health: {Status: health}},
  });
  const output = [
    "__CONTAINERS__",
    inspection(gatewayId, "oscar-gateway-1", "oscar", "gateway", "running", "healthy", false, 0),
    inspection(oscarId, "oscar-oscar-1", "oscar", "oscar", "exited", "unhealthy", true, 2),
    inspection(unrelatedId, "other-gateway-1", "other", "gateway", "running", "healthy", false, 0),
    "__MISSING__\tpostgres",
    "__STATS__",
    JSON.stringify({
      ID: gatewayId.slice(0, 12), Name: "oscar-gateway-1", CPUPerc: "12.5%",
      MemUsage: "256MiB / 1GiB", MemPerc: "25%", PIDs: "8",
    }),
    JSON.stringify({
      ID: unrelatedId.slice(0, 12), Name: "other-gateway-1", CPUPerc: "99%",
      MemUsage: "1GiB / 1GiB", MemPerc: "100%", PIDs: "99",
    }),
    "__HOST__",
    "0.5",
    "1000",
    "2000",
    "100 50",
  ].join("\n");

  const snapshots = parseOscarDockerSnapshot(output);
  assert.equal(snapshots.length, 3);
  assert.deepEqual(snapshots.find((item) => item.composeService === "gateway"), {
    composeService: "gateway",
    containerId: gatewayId,
    containerName: "oscar-gateway-1",
    containerState: "running",
    containerHealth: "healthy",
    containerStatsAvailable: true,
    cpuPercent: 12.5,
    memoryUsedBytes: 268_435_456,
    memoryLimitBytes: 1_073_741_824,
    memoryPercent: 25,
    pids: 8,
    restartCount: 0,
    oomKilled: false,
  });
  assert.deepEqual(snapshots.find((item) => item.composeService === "oscar"), {
    composeService: "oscar",
    containerId: oscarId,
    containerName: "oscar-oscar-1",
    containerState: "exited",
    containerHealth: "unhealthy",
    containerStatsAvailable: false,
    cpuPercent: null,
    memoryUsedBytes: null,
    memoryLimitBytes: null,
    memoryPercent: null,
    pids: null,
    restartCount: 2,
    oomKilled: true,
  });
  assert.deepEqual(snapshots.find((item) => item.composeService === "postgres"), {
    composeService: "postgres",
    containerId: null,
    containerName: null,
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
  });
  assert.equal(snapshots.some((item) => item.containerId === unrelatedId), false);
});

test("OSCAR snapshot parsing flags a running container whose stats disappear", () => {
  const containerId = "d".repeat(64);
  const output = [
    "__CONTAINERS__",
    JSON.stringify({
      Id: containerId,
      Name: "/oscar-postgres-1",
      RestartCount: 0,
      Config: {Labels: {
        "com.docker.compose.project": "oscar",
        "com.docker.compose.service": "postgres",
      }},
      State: {Status: "running", Running: true, OOMKilled: false, Health: {Status: "healthy"}},
    }),
    "__STATS__",
    `__STAT_MISSING__\t${containerId}`,
    "__HOST__",
  ].join("\n");
  const snapshots = parseOscarDockerSnapshot(output);
  const snapshot = snapshots.find((item) => item.composeService === "postgres");
  assert.equal(snapshots.length, 3);
  assert.equal(snapshot?.containerStatsAvailable, false);
  assert.equal(snapshot?.containerState, "running");
  assert.equal(snapshot?.containerId, containerId);
  assert.ok(snapshots
    .filter((item) => item.composeService !== "postgres")
    .every((item) => item.containerId === null));
});

test("sampler captures every registered phase and labels the SSH target instead of the Viewer host", async () => {
  const output = healthyRemoteOutput();
  const commands: string[] = [];
  const config = {
    targetHost: "viewer.test.invalid",
    oscarSshTarget: "operator@metrics.test.invalid",
    metricsIntervalMs: 60_000,
  } as SuiteConfig;
  const metadata = {remoteMetricsExpected: true} as RunMetadata;
  const root = mkdtempSync(join(tmpdir(), "oscar-metrics-sampler-"));
  const reporter = new RunReporter("sampler", root, [], metadata);
  const sampler = new MetricsSampler(config, reporter, async (command) => {
    commands.push(command);
    return output;
  });

  await sampler.start();
  sampler.setPhase("storage-load");
  await sampler.stop();
  reporter.outcome("storage-load", "storage", "exercise load", "fixture", "completes", "completed", "correct", 1);
  const result = reporter.finalize(new Date());

  assert.equal(result.exitCode, 0);
  assert.ok(commands.length >= 3);
  assert.ok(commands.every((command) => command.includes("com.docker.compose.project=oscar")));
  for (const phase of ["initialization", "storage-load"]) {
    for (const service of ["gateway", "oscar", "postgres"]) {
      assert.ok(reporter.metrics.some((sample) =>
        sample.phase === phase && sample.composeService === service && sample.containerId === HEALTHY_IDS[service]));
    }
  }
  const remoteHosts = reporter.metrics.filter((sample) => sample.source === "oscar-host");
  assert.ok(remoteHosts.length >= 2);
  assert.ok(remoteHosts.every((sample) => sample.target === "operator@metrics.test.invalid"));
  assert.equal(remoteHosts.some((sample) => sample.target === "viewer.test.invalid"), false);
  assert.ok(reporter.functional
    .filter((item) => item.scenario === "performance")
    .every((item) => item.target === "operator@metrics.test.invalid"));
});

test("sampler records missing service identities when a later SSH snapshot fails", async () => {
  const config = {
    targetHost: "viewer.test.invalid",
    oscarSshTarget: "operator@metrics.test.invalid",
    metricsIntervalMs: 60_000,
  } as SuiteConfig;
  const root = mkdtempSync(join(tmpdir(), "oscar-metrics-failure-"));
  const reporter = new RunReporter("sampler-failure", root, [], {remoteMetricsExpected: true} as RunMetadata);
  let call = 0;
  const sampler = new MetricsSampler(config, reporter, async () => {
    call += 1;
    if (call === 3) throw new Error("SSH snapshot failed");
    return healthyRemoteOutput();
  });

  await sampler.start();
  sampler.setPhase("storage-load");
  await sampler.stop();
  reporter.outcome("storage-load", "storage", "exercise load", "fixture", "completes", "completed", "correct", 1);
  const result = reporter.finalize(new Date());

  assert.equal(result.exitCode, 1);
  for (const service of ["gateway", "oscar", "postgres"] as const) {
    assert.ok(reporter.metrics.some((sample) =>
      sample.phase === "storage-load" && sample.composeService === service && sample.containerId === null));
  }
  assert.ok(reporter.functional.some((item) =>
    item.action === "capture exact OSCAR Compose service metrics" && item.status === "incorrect"));
  assert.ok(reporter.functional.some((item) =>
    item.action === "detect service disappearance or recreation" && item.status === "incorrect"));
});
