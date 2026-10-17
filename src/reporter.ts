import {mkdirSync, writeFileSync} from "node:fs";
import {join} from "node:path";
import {toCsv} from "./csv.js";
import type {
  AggregateRow,
  ErrorRecord,
  FunctionalResult,
  MetricSample,
  RunMetadata,
  ResultStatus,
  StorageMetricSample,
} from "./types.js";

const FUNCTIONAL_COLUMNS: readonly (keyof FunctionalResult)[] = [
  "runId", "timestamp", "scenario", "category", "action", "target", "expected",
  "observed", "status", "durationMs", "evidence", "error",
];
const ERROR_COLUMNS: readonly (keyof ErrorRecord)[] = [
  "runId", "timestamp", "scenario", "source", "severity", "message", "evidence",
];
const METRIC_COLUMNS: readonly (keyof MetricSample)[] = [
  "runId", "timestamp", "phase", "source", "target", "cpuPercent", "memoryUsedBytes",
  "memoryLimitBytes", "memoryPercent", "pids", "restartCount", "oomKilled", "load1m",
  "hostMemoryAvailableBytes", "note",
];
const AGGREGATE_COLUMNS: readonly (keyof AggregateRow)[] = [
  "runId", "section", "group", "total", "correct", "incorrect", "skipped",
  "accuracyPercent", "peakCpuPercent", "peakMemoryBytes", "averageCpuPercent",
  "averageMemoryBytes",
];
const STORAGE_METRIC_COLUMNS: readonly (keyof StorageMetricSample)[] = [
  "runId", "timestamp", "phase", "databaseSizeBytes", "observationTableBytes",
  "observationIndexBytes", "walBytes", "tempBytes", "tuplesInserted", "tuplesUpdated",
  "tuplesDeleted", "transactionCommits", "transactionRollbacks", "observationInsertCalls",
  "observationInsertRows", "observationRowsPerCall", "activeArchiveGenerations",
  "sealedArchiveGenerations", "archiveRows", "archiveBytes", "failedArchiveJobs",
  "failedParityReceipts", "activeHolds", "verifiedBackups", "journalBytes",
  "dailyFileBytes", "retainedMediaBytes", "backupBytes", "note",
];

function mean(values: number[]): number | null {
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function maximum(values: number[]): number | null {
  return values.length ? Math.max(...values) : null;
}

function rounded(value: number | null, digits = 2): number | null {
  if (value === null) return null;
  return Number(value.toFixed(digits));
}

function oneLine(value: unknown): string {
  return String(value ?? "").replaceAll(/\s+/g, " ").trim();
}

export class RunReporter {
  readonly functional: FunctionalResult[] = [];
  readonly errors: ErrorRecord[] = [];
  readonly metrics: MetricSample[] = [];
  readonly storageMetrics: StorageMetricSample[] = [];
  readonly outputDir: string;
  readonly evidenceDir: string;
  readonly downloadDir: string;
  private readonly secrets: string[];
  private readonly metadata: RunMetadata;

  constructor(
    readonly runId: string,
    resultsRoot: string,
    secrets: string[] = [],
    metadata: RunMetadata,
  ) {
    this.outputDir = join(resultsRoot, runId);
    this.evidenceDir = join(this.outputDir, "evidence");
    this.downloadDir = join(this.outputDir, "downloads");
    mkdirSync(this.evidenceDir, {recursive: true});
    mkdirSync(this.downloadDir, {recursive: true});
    this.secrets = secrets.filter(Boolean);
    this.metadata = metadata;
  }

  addMetadata(values: Partial<RunMetadata>): void {
    Object.assign(this.metadata, values);
  }

  redact(value: unknown): string {
    let text = oneLine(value);
    for (const secret of this.secrets) text = text.replaceAll(secret, "[REDACTED]");
    return text.replaceAll(/(authorization\s*[:=]\s*basic\s+)[a-z0-9+/=]+/gi, "$1[REDACTED]");
  }

  record(input: Omit<FunctionalResult, "runId" | "timestamp">): void {
    this.functional.push({
      runId: this.runId,
      timestamp: new Date().toISOString(),
      ...input,
      observed: this.redact(input.observed),
      error: this.redact(input.error),
    });
  }

  outcome(
    scenario: string,
    category: string,
    action: string,
    target: string,
    expected: string,
    observed: string,
    status: ResultStatus,
    durationMs: number,
    evidence = "",
    error = "",
  ): void {
    this.record({scenario, category, action, target, expected, observed, status, durationMs, evidence, error});
  }

  error(
    scenario: string,
    source: string,
    message: unknown,
    evidence = "",
    severity: ErrorRecord["severity"] = "error",
  ): void {
    this.errors.push({
      runId: this.runId,
      timestamp: new Date().toISOString(),
      scenario,
      source,
      severity,
      message: this.redact(message),
      evidence,
    });
  }

  metric(sample: Omit<MetricSample, "runId" | "timestamp">): void {
    this.metrics.push({runId: this.runId, timestamp: new Date().toISOString(), ...sample});
  }

  storageMetric(sample: Omit<StorageMetricSample, "runId" | "timestamp">): void {
    this.storageMetrics.push({runId: this.runId, timestamp: new Date().toISOString(), ...sample});
  }

  aggregate(): AggregateRow[] {
    const rows: AggregateRow[] = [];
    const groups = new Map<string, FunctionalResult[]>();
    groups.set("all", this.functional);
    for (const item of this.functional) {
      for (const group of [
        `category:${item.category}`,
        `scenario:${item.scenario}`,
        `action:${item.scenario}/${item.action}`,
      ]) groups.set(group, [...(groups.get(group) ?? []), item]);
    }
    for (const [group, subset] of groups) {
      const correct = subset.filter((item) => item.status === "correct").length;
      const incorrect = subset.filter((item) => item.status === "incorrect").length;
      const skipped = subset.filter((item) => item.status === "skipped").length;
      const evaluated = correct + incorrect;
      rows.push({
        runId: this.runId,
        section: "correctness",
        group,
        total: subset.length,
        correct,
        incorrect,
        skipped,
        accuracyPercent: evaluated ? rounded((correct / evaluated) * 100) : null,
        peakCpuPercent: null,
        peakMemoryBytes: null,
        averageCpuPercent: null,
        averageMemoryBytes: null,
      });
    }

    const targets = new Set(this.metrics.map((item) => `${item.source}:${item.target}`));
    for (const target of targets) {
      const subset = this.metrics.filter((item) => `${item.source}:${item.target}` === target);
      const cpu = subset.flatMap((item) => item.cpuPercent === null ? [] : [item.cpuPercent]);
      const memory = subset.flatMap((item) => item.memoryUsedBytes === null ? [] : [item.memoryUsedBytes]);
      rows.push({
        runId: this.runId,
        section: "performance",
        group: target,
        total: subset.length,
        correct: 0,
        incorrect: 0,
        skipped: 0,
        accuracyPercent: null,
        peakCpuPercent: rounded(maximum(cpu)),
        peakMemoryBytes: rounded(maximum(memory), 0),
        averageCpuPercent: rounded(mean(cpu)),
        averageMemoryBytes: rounded(mean(memory), 0),
      });
    }
    return rows;
  }

  private addPerformanceHealthChecks(): void {
    if (!this.metadata.remoteMetricsExpected) return;
    const containers = this.metrics.filter((item) => item.source === "oscar-container");
    this.outcome(
      "performance", "performance", "capture OSCAR container metrics", this.metadata.oscarBaseUrl,
      "at least one OSCAR container sample is captured", `${containers.length} container samples`,
      containers.length ? "correct" : "incorrect", 0,
    );
    if (!containers.length) return;
    const oomTargets = [...new Set(containers.filter((item) => item.oomKilled).map((item) => item.target))];
    this.outcome(
      "performance", "performance", "detect container OOM kills", this.metadata.oscarBaseUrl,
      "no sampled container is OOM-killed", oomTargets.length ? `OOM-killed: ${oomTargets.join(", ")}` : "none",
      oomTargets.length ? "incorrect" : "correct", 0,
    );
    const increased: string[] = [];
    for (const target of new Set(containers.map((item) => item.target))) {
      const counts = containers
        .filter((item) => item.target === target && item.restartCount !== null)
        .map((item) => item.restartCount as number);
      if (counts.length > 1 && (counts.at(-1) ?? 0) > (counts[0] ?? 0)) increased.push(target);
    }
    this.outcome(
      "performance", "performance", "detect container restarts", this.metadata.oscarBaseUrl,
      "no sampled container restart count increases during the run",
      increased.length ? `restart count increased: ${increased.join(", ")}` : "no restart count increased",
      increased.length ? "incorrect" : "correct", 0,
    );
  }

  finalize(startedAt: Date, finishedAt = new Date()): {exitCode: number; outputDir: string} {
    this.addPerformanceHealthChecks();
    const aggregate = this.aggregate();
    writeFileSync(join(this.outputDir, "functional-results.csv"), toCsv(this.functional, FUNCTIONAL_COLUMNS));
    writeFileSync(join(this.outputDir, "errors.csv"), toCsv(this.errors, ERROR_COLUMNS));
    writeFileSync(join(this.outputDir, "performance.csv"), toCsv(this.metrics, METRIC_COLUMNS));
    writeFileSync(
      join(this.outputDir, "storage-performance.csv"),
      toCsv(this.storageMetrics, STORAGE_METRIC_COLUMNS),
    );
    writeFileSync(join(this.outputDir, "summary.csv"), toCsv(aggregate, AGGREGATE_COLUMNS));

    const overall = aggregate.find((row) => row.section === "correctness" && row.group === "all");
    const failures = this.functional.filter((item) => item.status === "incorrect");
    const warnings = this.errors.filter((item) => item.severity === "warning");
    const fatalErrors = this.errors.filter((item) => item.severity === "error");
    const performance = aggregate.filter((row) => row.section === "performance");
    const topCpu = [...performance]
      .filter((row) => row.peakCpuPercent !== null)
      .sort((a, b) => (b.peakCpuPercent ?? 0) - (a.peakCpuPercent ?? 0))[0];
    const topMemory = [...performance]
      .filter((row) => row.peakMemoryBytes !== null)
      .sort((a, b) => (b.peakMemoryBytes ?? 0) - (a.peakMemoryBytes ?? 0))[0];
    const status = failures.length === 0 && fatalErrors.length === 0 && this.functional.length > 0 ? "PASS" : "FAIL";
    const durationSeconds = (finishedAt.getTime() - startedAt.getTime()) / 1_000;
    const failureLines = failures.slice(0, 10).map((item) =>
      `- ${item.scenario} / ${item.action}: expected ${item.expected}; observed ${item.observed || item.error || "no result"}`,
    );
    const narrative = [
      `# OSCAR regression report — ${status}`,
      "",
      `Run \`${this.runId}\` started ${startedAt.toISOString()} and completed ${finishedAt.toISOString()} in ${durationSeconds.toFixed(1)} seconds.`,
      "",
      `OSCAR produced ${overall?.correct ?? 0} correct, ${overall?.incorrect ?? 0} incorrect, and ${overall?.skipped ?? 0} skipped checks (${overall?.accuracyPercent ?? "n/a"}% accuracy over evaluated checks).`,
      this.errors.length
        ? `${this.errors.length} runtime issue(s) were captured (${warnings.length} warning(s)); see \`errors.csv\` and evidence files.`
        : "No browser, API, or sampler errors were captured.",
      topCpu ? `Peak sampled CPU was ${topCpu.peakCpuPercent}% for \`${topCpu.group}\`.` : "CPU sampling was unavailable.",
      topMemory ? `Peak sampled memory was ${topMemory.peakMemoryBytes} bytes for \`${topMemory.group}\`.` : "Memory sampling was unavailable.",
      "",
      "## Incorrect checks",
      "",
      ...(failureLines.length ? failureLines : fatalErrors.length
        ? [`No functional assertion failed, but ${fatalErrors.length} runtime error(s) made this run fail.`]
        : this.functional.length === 0 ? ["No functional checks were evaluated; an empty run is invalid."] : ["None."]),
      "",
      "## Report files",
      "",
      "- `functional-results.csv`: one row per expected OSCAR behavior.",
      "- `performance.csv`: timestamped runner, host, and container CPU/memory samples.",
      "- `storage-performance.csv`: PostgreSQL, archive, journal, media, backup, and batch counters.",
      "- `summary.csv`: correctness counts and aggregate resource measurements.",
      "- `errors.csv`: browser, API, cleanup, and sampling errors.",
      "- `evidence/`: screenshots and supporting artifacts.",
      "- `downloads/`: generated OSCAR reports and alarm exports.",
      "",
    ].join("\n");
    writeFileSync(join(this.outputDir, "summary.md"), narrative);
    writeFileSync(join(this.outputDir, "run.json"), `${JSON.stringify({
      schemaVersion: 2,
      runId: this.runId,
      status,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationSeconds,
      environment: this.metadata,
      counts: overall,
      files: {
        functional: "functional-results.csv",
        performance: "performance.csv",
        storagePerformance: "storage-performance.csv",
        summary: "summary.csv",
        errors: "errors.csv",
        narrative: "summary.md",
      },
    }, null, 2)}\n`);
    return {exitCode: status === "PASS" ? 0 : 1, outputDir: this.outputDir};
  }
}
