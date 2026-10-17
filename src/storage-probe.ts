import {execFile} from "node:child_process";
import {resolve} from "node:path";
import {promisify} from "node:util";
import type {SuiteConfig} from "./types.js";

const execFileAsync = promisify(execFile);
const TARGET_PATTERN = /^(?:[A-Za-z0-9_.-]+@)?(?:[A-Za-z0-9_.-]+|\[[0-9A-Fa-f:]+\])$/;
const ACTION_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const ARGUMENT_PATTERN = /^[A-Za-z0-9_./:@+=,-]{1,512}$/;

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export class StorageProbeClient {
  private readonly target: string;
  private readonly releaseDirectory: string;
  private readonly remoteScript: string;
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
      return JSON.parse(line) as T;
    } catch (error) {
      throw new Error(`Storage probe ${action} returned invalid JSON`, {cause: error});
    }
  }

  async cleanup(): Promise<void> {
    if (!this.installed) return;
    const command = `rm -f -- ${shellQuote(this.remoteScript)}`;
    await execFileAsync("ssh", [...this.commonOptions(), this.target, command], {
      timeout: 20_000,
      maxBuffer: 1024 * 1024,
    }).catch(() => undefined);
    this.installed = false;
  }
}
