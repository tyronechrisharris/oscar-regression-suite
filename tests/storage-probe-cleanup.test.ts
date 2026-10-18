import assert from "node:assert/strict";
import {chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";
import {StorageProbeClient} from "../src/storage-probe.js";
import type {SuiteConfig} from "../src/types.js";

test("a lost baseline acknowledgement still invokes privileged marker cleanup", {
  skip: process.platform === "win32",
}, async () => {
  const directory = mkdtempSync(join(tmpdir(), "oscar-probe-cleanup-"));
  const log = join(directory, "ssh.log");
  const oldPath = process.env.PATH;
  const oldLog = process.env.OSCAR_TEST_SSH_LOG;
  try {
    const scp = join(directory, "scp");
    const ssh = join(directory, "ssh");
    writeFileSync(scp, "#!/bin/sh\nexit 0\n", {mode: 0o700});
    writeFileSync(ssh, `#!/bin/sh
printf '%s\\n' "$*" >> "$OSCAR_TEST_SSH_LOG"
case "$*" in
  *oscar-storage-binding*) printf '/opt/oscar-test\\n' ;;
  *mktemp\\ -d*) printf '/tmp/oscar-storage-regression.ABC12345\\n' ;;
  *alarm-media-baseline*) exit 255 ;;
  *alarm-media-cleanup*) printf '{"removed":true}\\n' ;;
  *) exit 0 ;;
esac
`, {mode: 0o700});
    chmodSync(scp, 0o700);
    chmodSync(ssh, 0o700);
    process.env.PATH = `${directory}:${oldPath ?? ""}`;
    process.env.OSCAR_TEST_SSH_LOG = log;

    const client = new StorageProbeClient({
      targetHost: "viewer.test.invalid",
      oscarSshTarget: "tester@test.invalid",
      oscarReleaseDirectory: "/opt/oscar-test",
      storageTargetAcknowledgement:
        "viewer.test.invalid|tester@test.invalid|/opt/oscar-test|DISPOSABLE-STORAGE",
      storageProbeTimeoutMs: 10_000,
    } as SuiteConfig, "run_cleanup_test");
    await assert.rejects(
      client.runJson("alarm-media-baseline", ["run_cleanup_test"]),
      /alarm-media-baseline/,
    );
    await client.cleanup();

    const commands = readFileSync(log, "utf8").trim().split(/\r?\n/);
    assert.equal(commands.length, 6);
    assert.match(commands[0]!, /oscar-storage-binding.*\/opt\/oscar-test/);
    assert.match(commands[1]!, /mktemp -d \/tmp\/oscar-storage-regression/);
    assert.match(commands[2]!, /alarm-media-baseline.*run_cleanup_test/);
    assert.match(commands[3]!, /oscar-storage-binding.*\/opt\/oscar-test/);
    assert.match(commands[4]!, /sudo.*alarm-media-cleanup.*run_cleanup_test/);
    assert.match(commands[5]!, /rm -rf --.*oscar-storage-regression\.ABC12345/);
  } finally {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    if (oldLog === undefined) delete process.env.OSCAR_TEST_SSH_LOG;
    else process.env.OSCAR_TEST_SSH_LOG = oldLog;
    rmSync(directory, {recursive: true, force: true});
  }
});

test("a failed privileged marker cleanup remains retryable before helper removal", {
  skip: process.platform === "win32",
}, async () => {
  const directory = mkdtempSync(join(tmpdir(), "oscar-probe-cleanup-retry-"));
  const log = join(directory, "ssh.log");
  const allowCleanup = join(directory, "allow-cleanup");
  const oldPath = process.env.PATH;
  const oldLog = process.env.OSCAR_TEST_SSH_LOG;
  const oldAllowCleanup = process.env.OSCAR_TEST_ALLOW_CLEANUP;
  try {
    writeFileSync(join(directory, "scp"), "#!/bin/sh\nexit 0\n", {mode: 0o700});
    writeFileSync(join(directory, "ssh"), `#!/bin/sh
printf '%s\\n' "$*" >> "$OSCAR_TEST_SSH_LOG"
case "$*" in
  *oscar-storage-binding*) printf '/opt/oscar-test\\n' ;;
  *mktemp\\ -d*) printf '/tmp/oscar-storage-regression.DEF67890\\n' ;;
  *alarm-media-baseline*) exit 255 ;;
  *alarm-media-cleanup*)
    test -f "$OSCAR_TEST_ALLOW_CLEANUP" || exit 1
    printf '{"removed":true}\\n'
    ;;
  *) exit 0 ;;
esac
`, {mode: 0o700});
    process.env.PATH = `${directory}:${oldPath ?? ""}`;
    process.env.OSCAR_TEST_SSH_LOG = log;
    process.env.OSCAR_TEST_ALLOW_CLEANUP = allowCleanup;

    const client = new StorageProbeClient({
      targetHost: "viewer.test.invalid",
      oscarSshTarget: "tester@test.invalid",
      oscarReleaseDirectory: "/opt/oscar-test",
      storageTargetAcknowledgement:
        "viewer.test.invalid|tester@test.invalid|/opt/oscar-test|DISPOSABLE-STORAGE",
      storageProbeTimeoutMs: 10_000,
    } as SuiteConfig, "run_cleanup_retry_test");
    await assert.rejects(client.runJson("alarm-media-baseline", ["run_cleanup_retry_test"]));
    await assert.rejects(client.cleanup(), /privileged alarm-media baseline marker/);
    let commands = readFileSync(log, "utf8").trim().split(/\r?\n/);
    assert.equal(commands.length, 5);
    assert.doesNotMatch(commands.join("\n"), /rm -rf --/);

    writeFileSync(allowCleanup, "ready\n");
    await client.cleanup();
    commands = readFileSync(log, "utf8").trim().split(/\r?\n/);
    assert.equal(commands.length, 8);
    assert.match(commands[6]!, /sudo.*alarm-media-cleanup.*run_cleanup_retry_test/);
    assert.match(commands[7]!, /rm -rf --.*oscar-storage-regression\.DEF67890/);
  } finally {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    if (oldLog === undefined) delete process.env.OSCAR_TEST_SSH_LOG;
    else process.env.OSCAR_TEST_SSH_LOG = oldLog;
    if (oldAllowCleanup === undefined) delete process.env.OSCAR_TEST_ALLOW_CLEANUP;
    else process.env.OSCAR_TEST_ALLOW_CLEANUP = oldAllowCleanup;
    rmSync(directory, {recursive: true, force: true});
  }
});

test("storage probe binds Viewer host, SSH target, and release before any remote write", () => {
  assert.throws(() => new StorageProbeClient({
    targetHost: "viewer.test.invalid",
    oscarSshTarget: "tester@test.invalid",
    oscarReleaseDirectory: "/opt/oscar-test",
    storageTargetAcknowledgement:
      "other.test.invalid|tester@test.invalid|/opt/oscar-test|DISPOSABLE-STORAGE",
    storageProbeTimeoutMs: 10_000,
  } as SuiteConfig, "binding_test"), /OSCAR_STORAGE_TARGET_ACK/);
});

test("storage probe refuses a remotely symlinked or noncanonical release before scp", {
  skip: process.platform === "win32",
}, async () => {
  const directory = mkdtempSync(join(tmpdir(), "oscar-probe-binding-refusal-"));
  const sshLog = join(directory, "ssh.log");
  const scpLog = join(directory, "scp.log");
  const oldPath = process.env.PATH;
  const oldSshLog = process.env.OSCAR_TEST_SSH_LOG;
  const oldScpLog = process.env.OSCAR_TEST_SCP_LOG;
  try {
    writeFileSync(join(directory, "ssh"), `#!/bin/sh
printf '%s\\n' "$*" >> "$OSCAR_TEST_SSH_LOG"
# Simulate realpath resolving a release symlink to a different canonical path.
printf '/srv/releases/oscar-real\\n'
`, {mode: 0o700});
    writeFileSync(join(directory, "scp"), `#!/bin/sh
printf '%s\\n' "$*" >> "$OSCAR_TEST_SCP_LOG"
exit 0
`, {mode: 0o700});
    process.env.PATH = `${directory}:${oldPath ?? ""}`;
    process.env.OSCAR_TEST_SSH_LOG = sshLog;
    process.env.OSCAR_TEST_SCP_LOG = scpLog;
    const client = new StorageProbeClient({
      targetHost: "viewer.test.invalid",
      oscarSshTarget: "tester@test.invalid",
      oscarReleaseDirectory: "/opt/oscar-test",
      storageTargetAcknowledgement:
        "viewer.test.invalid|tester@test.invalid|/opt/oscar-test|DISPOSABLE-STORAGE",
      storageProbeTimeoutMs: 10_000,
    } as SuiteConfig, "binding_refusal_test");
    await assert.rejects(client.runJson("platform"), /missing, linked, noncanonical, or changed/);
    assert.match(readFileSync(sshLog, "utf8"), /oscar-storage-binding/);
    assert.throws(() => readFileSync(scpLog, "utf8"), /ENOENT/);
  } finally {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    if (oldSshLog === undefined) delete process.env.OSCAR_TEST_SSH_LOG;
    else process.env.OSCAR_TEST_SSH_LOG = oldSshLog;
    if (oldScpLog === undefined) delete process.env.OSCAR_TEST_SCP_LOG;
    else process.env.OSCAR_TEST_SCP_LOG = oldScpLog;
    rmSync(directory, {recursive: true, force: true});
  }
});
