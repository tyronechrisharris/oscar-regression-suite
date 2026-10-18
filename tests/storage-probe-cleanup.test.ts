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
      oscarSshTarget: "tester@test.invalid",
      oscarReleaseDirectory: "/opt/oscar-test",
      storageProbeTimeoutMs: 10_000,
    } as SuiteConfig, "run_cleanup_test");
    await assert.rejects(
      client.runJson("alarm-media-baseline", ["run_cleanup_test"]),
    );
    await client.cleanup();

    const commands = readFileSync(log, "utf8").trim().split(/\r?\n/);
    assert.equal(commands.length, 3);
    assert.match(commands[0]!, /alarm-media-baseline.*run_cleanup_test/);
    assert.match(commands[1]!, /sudo.*alarm-media-cleanup.*run_cleanup_test/);
    assert.match(commands[2]!, /rm -f --.*oscar-storage-regression-run-cleanup-test\.sh/);
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
      oscarSshTarget: "tester@test.invalid",
      oscarReleaseDirectory: "/opt/oscar-test",
      storageProbeTimeoutMs: 10_000,
    } as SuiteConfig, "run_cleanup_retry_test");
    await assert.rejects(client.runJson("alarm-media-baseline", ["run_cleanup_retry_test"]));
    await assert.rejects(client.cleanup(), /privileged alarm-media baseline marker/);
    let commands = readFileSync(log, "utf8").trim().split(/\r?\n/);
    assert.equal(commands.length, 2);
    assert.doesNotMatch(commands.join("\n"), /rm -f --/);

    writeFileSync(allowCleanup, "ready\n");
    await client.cleanup();
    commands = readFileSync(log, "utf8").trim().split(/\r?\n/);
    assert.equal(commands.length, 4);
    assert.match(commands[2]!, /sudo.*alarm-media-cleanup.*run_cleanup_retry_test/);
    assert.match(commands[3]!, /rm -f --.*oscar-storage-regression-run-cleanup-retry-test\.sh/);
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
