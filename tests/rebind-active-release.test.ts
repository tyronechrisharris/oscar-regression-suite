import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";
import test from "node:test";

const script = resolve("scripts/rebind-active-release.sh");

test("active-release rebinding previews and atomically updates only nonsecret release identity", () => {
  if (process.platform === "win32") return;
  const root = mkdtempSync(join(tmpdir(), "oscar-active-release-"));
  try {
    const bin = join(root, "bin");
    mkdirSync(bin);
    const key = join(root, "id_test");
    writeFileSync(key, "test-only-key\n", {mode: 0o600});
    const envFile = join(root, ".env");
    writeFileSync(envFile, [
      "OSCAR_TEST_TARGET_ACK=192.0.2.10",
      "OSCAR_SSH_TARGET=tester@192.0.2.10",
      `OSCAR_SSH_IDENTITY_FILE=${key}`,
      "OSCAR_RELEASE_DIR=/srv/oscar/releases/old/oscar-3.9.2",
      "OSCAR_STORAGE_TARGET_ACK=192.0.2.10|tester@192.0.2.10|/srv/oscar/releases/old/oscar-3.9.2|DISPOSABLE-STORAGE",
      "OSCAR_BUILD_LABEL=old-build",
      "OSCAR_PASSWORD=unchanged-secret",
    ].join("\n") + "\n", {mode: 0o600});
    const ssh = join(bin, "ssh");
    writeFileSync(ssh, "#!/usr/bin/env bash\nprintf '%s\\n' '/srv/oscar/releases/new/oscar-3.9.2'\n");
    chmodSync(ssh, 0o755);
    const commandEnv = {...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`};

    const preview = execFileSync("bash", [script, "--env-file", envFile, "--build-label", "3.9.2-new"], {
      encoding: "utf8", env: commandEnv,
    });
    assert.match(preview, /Preview only/);
    assert.match(readFileSync(envFile, "utf8"), /OSCAR_RELEASE_DIR=.*old/);

    execFileSync("bash", [script, "--apply", "--env-file", envFile, "--build-label", "3.9.2-new"], {
      stdio: "pipe", env: commandEnv,
    });
    const updated = readFileSync(envFile, "utf8");
    assert.match(updated, /^OSCAR_RELEASE_DIR=\/srv\/oscar\/releases\/new\/oscar-3\.9\.2$/m);
    assert.match(updated, /^OSCAR_STORAGE_TARGET_ACK=192\.0\.2\.10\|tester@192\.0\.2\.10\|\/srv\/oscar\/releases\/new\/oscar-3\.9\.2\|DISPOSABLE-STORAGE$/m);
    assert.match(updated, /^OSCAR_BUILD_LABEL=3\.9\.2-new$/m);
    assert.match(updated, /^OSCAR_PASSWORD=unchanged-secret$/m);
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test("active-release rebinding refuses an environment armed for destructive restore", () => {
  if (process.platform === "win32") return;
  const root = mkdtempSync(join(tmpdir(), "oscar-active-release-restore-"));
  try {
    const key = join(root, "id_test");
    writeFileSync(key, "test-only-key\n", {mode: 0o600});
    const envFile = join(root, ".env");
    writeFileSync(envFile, [
      "OSCAR_TEST_TARGET_ACK=192.0.2.10",
      "OSCAR_SSH_TARGET=tester@192.0.2.10",
      `OSCAR_SSH_IDENTITY_FILE=${key}`,
      "OSCAR_RELEASE_DIR=/srv/oscar/release",
      "OSCAR_STORAGE_TARGET_ACK=192.0.2.10|tester@192.0.2.10|/srv/oscar/release|DISPOSABLE-STORAGE",
      "OSCAR_BUILD_LABEL=old-build",
      "OSCAR_RESTORE_TARGET_ACK=armed",
    ].join("\n") + "\n", {mode: 0o600});
    assert.throws(() => execFileSync("bash", [
      script, "--env-file", envFile, "--build-label", "3.9.2-new",
    ], {stdio: "pipe"}), /Command failed/);
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});
