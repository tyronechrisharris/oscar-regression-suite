import {execFile} from "node:child_process";
import {cpus, freemem, hostname, loadavg, totalmem} from "node:os";
import {promisify} from "node:util";
import type {SuiteConfig} from "./types.js";
import {RunReporter} from "./reporter.js";

const execFileAsync = promisify(execFile);

export function parsePercent(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number.parseFloat(value.replace("%", "").trim());
  return Number.isFinite(parsed) ? parsed : null;
}

const UNIT_BYTES: Record<string, number> = {
  b: 1,
  kb: 1_000,
  kib: 1_024,
  mb: 1_000_000,
  mib: 1_048_576,
  gb: 1_000_000_000,
  gib: 1_073_741_824,
  tb: 1_000_000_000_000,
  tib: 1_099_511_627_776,
};

export function parseBytes(value: string | undefined): number | null {
  if (!value) return null;
  const match = value.trim().match(/^([0-9]+(?:\.[0-9]+)?)\s*([kmgt]?i?b)$/i);
  if (!match) return null;
  const amount = Number.parseFloat(match[1] ?? "");
  const multiplier = UNIT_BYTES[(match[2] ?? "").toLowerCase()];
  return Number.isFinite(amount) && multiplier ? Math.round(amount * multiplier) : null;
}

interface DockerStat {
  Name?: string;
  Container?: string;
  CPUPerc?: string;
  MemUsage?: string;
  MemPerc?: string;
  PIDs?: string;
}

interface InspectStat {
  name: string;
  restartCount: number;
  oomKilled: boolean;
}

export function parseDockerStats(text: string): DockerStat[] {
  return text.split(/\r?\n/).flatMap((line) => {
    const trimmed = line.trim();
    if (!trimmed) return [];
    try { return [JSON.parse(trimmed) as DockerStat]; } catch { return []; }
  });
}

function splitMemory(value: string | undefined): [number | null, number | null] {
  const [used, limit] = value?.split("/").map((part) => part.trim()) ?? [];
  return [parseBytes(used), parseBytes(limit)];
}

function localCpuTotals(): {total: number; idle: number} {
  let total = 0;
  let idle = 0;
  for (const cpu of cpus()) {
    idle += cpu.times.idle;
    total += Object.values(cpu.times).reduce((sum, value) => sum + value, 0);
  }
  return {total, idle};
}

export class MetricsSampler {
  private timer: NodeJS.Timeout | undefined;
  private activeSample: Promise<void> | undefined;
  private phase = "initialization";
  private previousCpu = process.cpuUsage();
  private previousTime = process.hrtime.bigint();
  private previousRemoteCpu: {total: number; idle: number} | undefined;
  private previousLocalCpu = localCpuTotals();

  constructor(private readonly config: SuiteConfig, private readonly reporter: RunReporter) {}

  setPhase(phase: string): void {
    this.phase = phase;
  }

  async start(): Promise<void> {
    await this.sample();
    this.timer = setInterval(() => void this.sample(), this.config.metricsIntervalMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.activeSample;
    await this.sample();
  }

  async sample(): Promise<void> {
    if (this.activeSample) return this.activeSample;
    const active = Promise.resolve().then(() => this.collectSample());
    this.activeSample = active;
    await active;
  }

  private async collectSample(): Promise<void> {
    try {
      this.sampleRunner();
      if (this.config.oscarSshTarget) await this.sampleOscarHost();
    } catch (error) {
      this.reporter.error(this.phase, "metrics", error, "", "warning");
    } finally {
      this.activeSample = undefined;
    }
  }

  private sampleRunner(): void {
    const now = process.hrtime.bigint();
    const cpu = process.cpuUsage(this.previousCpu);
    const elapsedMicros = Number(now - this.previousTime) / 1_000;
    const cpuPercent = elapsedMicros > 0 ? ((cpu.user + cpu.system) / elapsedMicros) * 100 : null;
    this.previousCpu = process.cpuUsage();
    this.previousTime = now;
    this.reporter.metric({
      phase: this.phase,
      source: "test-runner",
      target: "regression-process",
      cpuPercent,
      memoryUsedBytes: process.memoryUsage().rss,
      memoryLimitBytes: totalmem(),
      memoryPercent: totalmem() ? (process.memoryUsage().rss / totalmem()) * 100 : null,
      pids: 1,
      restartCount: 0,
      oomKilled: false,
      load1m: loadavg()[0] ?? null,
      hostMemoryAvailableBytes: freemem(),
      note: `${cpus().length} logical CPUs`,
    });
    const localCpu = localCpuTotals();
    const totalDelta = localCpu.total - this.previousLocalCpu.total;
    const idleDelta = localCpu.idle - this.previousLocalCpu.idle;
    this.previousLocalCpu = localCpu;
    const available = freemem();
    const total = totalmem();
    this.reporter.metric({
      phase: this.phase,
      source: "test-runner-host",
      target: hostname(),
      cpuPercent: totalDelta > 0 ? ((totalDelta - idleDelta) / totalDelta) * 100 : null,
      memoryUsedBytes: total - available,
      memoryLimitBytes: total,
      memoryPercent: total > 0 ? ((total - available) / total) * 100 : null,
      pids: null,
      restartCount: null,
      oomKilled: null,
      load1m: loadavg()[0] ?? null,
      hostMemoryAvailableBytes: available,
      note: `${cpus().length} logical CPUs; includes browser processes`,
    });
  }

  private async ssh(command: string): Promise<string> {
    if (!this.config.oscarSshTarget) return "";
    const args = [
      "-o", "BatchMode=yes",
      "-o", "StrictHostKeyChecking=yes",
      "-o", "ConnectTimeout=8",
      ...(this.config.sshIdentityFile
        ? ["-o", "IdentitiesOnly=yes", "-i", this.config.sshIdentityFile]
        : []),
      this.config.oscarSshTarget,
      command,
    ];
    const {stdout} = await execFileAsync("ssh", args, {timeout: 20_000, maxBuffer: 4 * 1024 * 1024});
    return stdout;
  }

  private async sampleOscarHost(): Promise<void> {
    const command = [
      "printf '__STATS__\\n'",
      "docker stats --no-stream --format '{{json .}}'",
      "printf '__INSPECT__\\n'",
      "docker inspect --format '{{json .Name}} {{.RestartCount}} {{.State.OOMKilled}}' $(docker ps -q)",
      "printf '__HOST__\\n'",
      "awk '{print $1}' /proc/loadavg",
      "awk '/MemAvailable:/ {print $2 * 1024}' /proc/meminfo",
      "awk '/MemTotal:/ {print $2 * 1024}' /proc/meminfo",
      "awk '/^cpu / {for (i=2; i<=NF; i++) total += $i; print total, $5 + $6}' /proc/stat",
    ].join("; ");
    const output = await this.ssh(command);
    const statsText = output.split("__STATS__\n")[1]?.split("__INSPECT__\n")[0] ?? "";
    const inspectText = output.split("__INSPECT__\n")[1]?.split("__HOST__\n")[0] ?? "";
    const hostLines = (output.split("__HOST__\n")[1] ?? "").trim().split(/\r?\n/);
    const load1m = Number.parseFloat(hostLines[0] ?? "");
    const available = Number.parseFloat(hostLines[1] ?? "");
    const totalMemory = Number.parseFloat(hostLines[2] ?? "");
    const [cpuTotalRaw, cpuIdleRaw] = (hostLines[3] ?? "").split(/\s+/);
    const remoteCpu = {total: Number.parseFloat(cpuTotalRaw ?? ""), idle: Number.parseFloat(cpuIdleRaw ?? "")};
    let hostCpuPercent: number | null = null;
    if (this.previousRemoteCpu && Number.isFinite(remoteCpu.total) && Number.isFinite(remoteCpu.idle)) {
      const totalDelta = remoteCpu.total - this.previousRemoteCpu.total;
      const idleDelta = remoteCpu.idle - this.previousRemoteCpu.idle;
      if (totalDelta > 0) hostCpuPercent = ((totalDelta - idleDelta) / totalDelta) * 100;
    }
    if (Number.isFinite(remoteCpu.total) && Number.isFinite(remoteCpu.idle)) this.previousRemoteCpu = remoteCpu;
    const inspections = new Map<string, InspectStat>();
    for (const line of inspectText.trim().split(/\r?\n/)) {
      const match = line.match(/^"\/?(.+?)"\s+(\d+)\s+(true|false)$/);
      if (!match) continue;
      inspections.set(match[1] ?? "", {
        name: match[1] ?? "",
        restartCount: Number.parseInt(match[2] ?? "0", 10),
        oomKilled: match[3] === "true",
      });
    }
    for (const stat of parseDockerStats(statsText)) {
      const name = stat.Name ?? stat.Container ?? "unknown";
      const [memoryUsedBytes, memoryLimitBytes] = splitMemory(stat.MemUsage);
      const inspect = inspections.get(name);
      this.reporter.metric({
        phase: this.phase,
        source: "oscar-container",
        target: name,
        cpuPercent: parsePercent(stat.CPUPerc),
        memoryUsedBytes,
        memoryLimitBytes,
        memoryPercent: parsePercent(stat.MemPerc),
        pids: stat.PIDs ? Number.parseInt(stat.PIDs, 10) : null,
        restartCount: inspect?.restartCount ?? null,
        oomKilled: inspect?.oomKilled ?? null,
        load1m: Number.isFinite(load1m) ? load1m : null,
        hostMemoryAvailableBytes: Number.isFinite(available) ? available : null,
        note: "",
      });
    }
    this.reporter.metric({
      phase: this.phase,
      source: "oscar-host",
      target: this.config.targetHost,
      cpuPercent: hostCpuPercent,
      memoryUsedBytes: Number.isFinite(totalMemory) && Number.isFinite(available) ? totalMemory - available : null,
      memoryLimitBytes: Number.isFinite(totalMemory) ? totalMemory : null,
      memoryPercent: Number.isFinite(totalMemory) && totalMemory > 0 && Number.isFinite(available)
        ? ((totalMemory - available) / totalMemory) * 100 : null,
      pids: null,
      restartCount: null,
      oomKilled: null,
      load1m: Number.isFinite(load1m) ? load1m : null,
      hostMemoryAvailableBytes: Number.isFinite(available) ? available : null,
      note: "host aggregate",
    });
  }
}
