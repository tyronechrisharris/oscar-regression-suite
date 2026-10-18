import {execFile} from "node:child_process";
import {resolve} from "node:path";
import {promisify} from "node:util";
import type {SuiteConfig} from "./types.js";

const execFileAsync = promisify(execFile);
const TARGET_PATTERN = /^(?:[A-Za-z0-9_.-]+@)?(?:[A-Za-z0-9_.-]+|\[[0-9A-Fa-f:]+\])$/;
const ACTION_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const ARGUMENT_PATTERN = /^[A-Za-z0-9_./:@+=,-]{1,512}$/;
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/;

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export class StorageProbeClient {
  private readonly target: string;
  private readonly releaseDirectory: string;
  private readonly remoteScript: string;
  private readonly alarmBaselineRuns = new Set<string>();
  private installed = false;

  constructor(private readonly config: SuiteConfig, runId: string) {
    if (!config.oscarSshTarget || !TARGET_PATTERN.test(config.oscarSshTarget)) {
      throw new Error("OSCAR_SSH_TARGET must be a simple [user@]host for storage regression");
    }
    if (!config.oscarReleaseDirectory) throw new Error("OSCAR_RELEASE_DIR is required");
    this.target = config.oscarSshTarget;
    this.releaseDirectory = config.oscarReleaseDirectory;
    const token = runId.toLowerCase().replaceAll(/[^a-z0-9-]+/g, "-").slice(-48) || "run";
    this.remoteScript = `/tmp/oscar-storage-regression-${token}.sh`;
  }

  private commonOptions(): string[] {
    return [
      "-o", "BatchMode=yes",
      "-o", "StrictHostKeyChecking=yes",
      "-o", "ConnectTimeout=10",
      ...(this.config.sshIdentityFile
        ? ["-o", "IdentitiesOnly=yes", "-i", this.config.sshIdentityFile]
        : []),
    ];
  }

  async install(): Promise<void> {
    if (this.installed) return;
    const source = resolve("scripts/oscar-storage-regression-probe.sh");
    await execFileAsync("scp", [
      ...this.commonOptions(),
      source,
      `${this.target}:${this.remoteScript}`,
    ], {timeout: 60_000, maxBuffer: 4 * 1024 * 1024});
    this.installed = true;
  }

  async runJson<T>(action: string, args: string[] = []): Promise<T> {
    if (!ACTION_PATTERN.test(action)) throw new Error(`Unsafe storage probe action: ${action}`);
    if (args.some(argument => !ARGUMENT_PATTERN.test(argument))) {
      throw new Error("Storage probe argument contains unsupported characters");
    }
    const alarmRun = args[0] && RUN_ID_PATTERN.test(args[0]) ? args[0] : undefined;
    // Register cleanup before the remote call. A lost acknowledgement after the
    // baseline link must not strand a privileged marker in /tmp.
    if (action === "alarm-media-baseline" && alarmRun) this.alarmBaselineRuns.add(alarmRun);
    await this.install();
    const command = [
      "sudo", "-n", "bash", this.remoteScript,
      "--release-dir", this.releaseDirectory,
      action,
      ...args,
    ].map(shellQuote).join(" ");
    const {stdout} = await execFileAsync("ssh", [
      ...this.commonOptions(),
      this.target,
      command,
    ], {
      timeout: this.config.storageProbeTimeoutMs,
      maxBuffer: 32 * 1024 * 1024,
    });
    const line = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
    if (!line) throw new Error(`Storage probe ${action} returned no JSON`);
    try {
      const result = JSON.parse(line) as T;
      if ((action === "alarm-media-forensics" || action === "alarm-media-cleanup") && alarmRun) {
        this.alarmBaselineRuns.delete(alarmRun);
      }
      return result;
    } catch (error) {
      throw new Error(`Storage probe ${action} returned invalid JSON`, {cause: error});
    }
  }

  async cleanup(): Promise<void> {
    if (!this.installed) {
      this.alarmBaselineRuns.clear();
      return;
    }
    // Baselines are root-owned mode-0600 files in sticky /tmp. Ask the
    // installed, fail-closed probe to remove only the marker derived from each
    // validated run ID; the unprivileged SSH user cannot safely unlink it.
    let baselineCleanupError: unknown;
    for (const run of this.alarmBaselineRuns) {
      const cleanupCommand = [
        "sudo", "-n", "bash", this.remoteScript,
        "--release-dir", this.releaseDirectory,
        "alarm-media-cleanup", run,
      ].map(shellQuote).join(" ");
      try {
        await execFileAsync("ssh", [...this.commonOptions(), this.target, cleanupCommand], {
          timeout: 20_000,
          maxBuffer: 1024 * 1024,
        });
      } catch (error) {
        baselineCleanupError ??= error;
      }
    }
    if (baselineCleanupError) {
      // Retain both the installed helper and the exact run IDs so a caller's
      // outer/final emergency cleanup can retry the privileged removal.
      throw new Error("Unable to remove a privileged alarm-media baseline marker", {
        cause: baselineCleanupError,
      });
    }
    await execFileAsync("ssh", [
      ...this.commonOptions(), this.target, `rm -f -- ${shellQuote(this.remoteScript)}`,
    ], {timeout: 20_000, maxBuffer: 1024 * 1024}).catch(() => undefined);
    this.installed = false;
    this.alarmBaselineRuns.clear();
  }
}
