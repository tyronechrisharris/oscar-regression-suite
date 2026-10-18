import {execFile} from "node:child_process";
import {resolve} from "node:path";
import {promisify} from "node:util";
import type {SuiteConfig} from "./types.js";

const execFileAsync = promisify(execFile);
const TARGET_PATTERN = /^(?:[A-Za-z0-9_.-]+@)?(?:[A-Za-z0-9_.-]+|\[[0-9A-Fa-f:]+\])$/;
const ACTION_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const ARGUMENT_PATTERN = /^[A-Za-z0-9_./:@+=,-]{1,2048}$/;
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/;
const REMOTE_WORKSPACE_PATTERN = /^\/tmp\/oscar-storage-regression\.[A-Za-z0-9]{6,32}$/;

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export class StorageProbeClient {
  private readonly target: string;
  private readonly releaseDirectory: string;
  private remoteWorkspace: string | undefined;
  private remoteScript: string | undefined;
  private readonly alarmBaselineRuns = new Set<string>();
  private installed = false;

  constructor(private readonly config: SuiteConfig, runId: string) {
    if (!config.oscarSshTarget || !TARGET_PATTERN.test(config.oscarSshTarget)) {
      throw new Error("OSCAR_SSH_TARGET must be a simple [user@]host for storage regression");
    }
    if (!config.oscarReleaseDirectory) throw new Error("OSCAR_RELEASE_DIR is required");
    this.target = config.oscarSshTarget;
    this.releaseDirectory = config.oscarReleaseDirectory;
    const acknowledgement =
      `${config.targetHost}|${this.target}|${this.releaseDirectory}|DISPOSABLE-STORAGE`;
    if (config.storageTargetAcknowledgement !== acknowledgement) {
      throw new Error(`OSCAR_STORAGE_TARGET_ACK must exactly equal ${acknowledgement}`);
    }
    if (!RUN_ID_PATTERN.test(runId.replaceAll(/[^A-Za-z0-9_-]+/g, "_"))) {
      throw new Error("Regression run ID cannot be represented safely for the storage probe");
    }
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

  private async verifyTargetBinding(): Promise<void> {
    const script = [
      "set -eu",
      "requested=$1",
      "test \"$requested\" != /",
      "test -d \"$requested\"",
      "test ! -L \"$requested\"",
      "canonical=$(realpath -e -- \"$requested\")",
      "test \"$canonical\" = \"$requested\"",
      "test \"$canonical\" != /",
      "test -f \"$canonical/oscar.sh\"",
      "test ! -L \"$canonical/oscar.sh\"",
      "printf '%s\\n' \"$canonical\"",
    ].join("; ");
    const command = [
      "sudo", "-n", "bash", "-ceu", script, "oscar-storage-binding", this.releaseDirectory,
    ].map(shellQuote).join(" ");
    const {stdout} = await execFileAsync("ssh", [
      ...this.commonOptions(), this.target, command,
    ], {timeout: 20_000, maxBuffer: 1024 * 1024, encoding: "utf8"});
    const canonical = stdout.trim();
    if (canonical !== this.releaseDirectory || canonical.includes("\n") || canonical.includes("\r")) {
      throw new Error(
        "Storage probe refused: OSCAR_RELEASE_DIR is missing, linked, noncanonical, or changed remotely",
      );
    }
    const acknowledgement =
      `${this.config.targetHost}|${this.target}|${canonical}|DISPOSABLE-STORAGE`;
    if (this.config.storageTargetAcknowledgement !== acknowledgement) {
      throw new Error(`OSCAR_STORAGE_TARGET_ACK must exactly equal ${acknowledgement}`);
    }
  }

  private async createRemoteWorkspace(): Promise<void> {
    const command = [
      "umask 077",
      "workspace=$(mktemp -d /tmp/oscar-storage-regression.XXXXXXXX)",
      "chmod 700 \"$workspace\"",
      "printf '%s\\n' \"$workspace\"",
    ].join("; ");
    const {stdout} = await execFileAsync("ssh", [
      ...this.commonOptions(), this.target, command,
    ], {timeout: 20_000, maxBuffer: 1024 * 1024, encoding: "utf8"});
    const workspace = stdout.trim();
    if (!REMOTE_WORKSPACE_PATTERN.test(workspace)) {
      throw new Error("Storage probe could not create a private remote workspace");
    }
    this.remoteWorkspace = workspace;
    this.remoteScript = `${workspace}/probe.sh`;
  }

  private async removeRemoteWorkspace(): Promise<void> {
    const workspace = this.remoteWorkspace;
    if (!workspace || !REMOTE_WORKSPACE_PATTERN.test(workspace)) return;
    await execFileAsync("ssh", [
      ...this.commonOptions(), this.target, `rm -rf -- ${shellQuote(workspace)}`,
    ], {timeout: 20_000, maxBuffer: 1024 * 1024}).catch(() => undefined);
    this.remoteWorkspace = undefined;
    this.remoteScript = undefined;
  }

  async install(): Promise<void> {
    if (this.installed) return;
    const source = resolve("scripts/oscar-storage-regression-probe.sh");
    await this.verifyTargetBinding();
    try {
      await this.createRemoteWorkspace();
      await execFileAsync("scp", [
        ...this.commonOptions(),
        source,
        `${this.target}:${this.remoteScript!}`,
      ], {timeout: 60_000, maxBuffer: 4 * 1024 * 1024});
      this.installed = true;
    } catch (error) {
      await this.removeRemoteWorkspace();
      throw error;
    }
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
    if (this.installed) await this.verifyTargetBinding();
    else await this.install();
    if (!this.remoteScript) throw new Error("Storage probe is not installed");
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
      await this.removeRemoteWorkspace();
      return;
    }
    // Baselines are root-owned mode-0600 files in sticky /tmp. Ask the
    // installed, fail-closed probe to remove only the marker derived from each
    // validated run ID; the unprivileged SSH user cannot safely unlink it.
    let baselineCleanupError: unknown;
    for (const run of this.alarmBaselineRuns) {
      await this.verifyTargetBinding();
      if (!this.remoteScript) throw new Error("Storage probe is not installed");
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
    await this.removeRemoteWorkspace();
    this.installed = false;
    this.alarmBaselineRuns.clear();
  }
}
