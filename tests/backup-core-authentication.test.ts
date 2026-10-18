import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {createHash, createHmac} from "node:crypto";
import {mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";
import test from "node:test";

const probe = readFileSync(resolve("scripts/oscar-storage-regression-probe.sh"), "utf8");

function functionSource(name: string, close = "}"): string {
  const escaped = name.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const expression = close === ")"
    ? new RegExp(`^${escaped}\\(\\) \\(\\n[\\s\\S]*?^\\\\?\\)$`, "mu")
    : new RegExp(`^${escaped}\\(\\) \\{\\n[\\s\\S]*?^\\}`, "mu");
  const result = probe.match(expression)?.[0];
  assert.ok(result, `missing ${name}`);
  return result;
}

test("independent backup authentication defeats a successful stub verifier after mutation", () => {
  const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "oscar-backup-core-")));
  const keyFile = join(root, "..", `${root.split("/").pop()}.key`);
  const payload = join(root, "payload.bin");
  const manifest = join(root, "SHA256SUMS");
  const hmac = join(root, "SHA256SUMS.hmac");
  const key = Buffer.from("regression-only-backup-key", "utf8");
  try {
    writeFileSync(keyFile, key, {mode: 0o600});
    writeFileSync(payload, "authenticated payload\n", {mode: 0o600});
    const digest = createHash("sha256").update(readFileSync(payload)).digest("hex");
    writeFileSync(manifest, `${digest}  ./payload.bin\n`, {mode: 0o600});
    writeFileSync(hmac, `${createHmac("sha256", key).update(readFileSync(manifest)).digest("base64")}\n`,
      {mode: 0o600});
    const helpers = [
      functionSource("sha256_file"),
      functionSource("file_size"),
      functionSource("valid_backup_relative_path"),
      functionSource("verify_backup_core_authentication", ")"),
    ].join("\n");
    const script = `set -Eeuo pipefail
${helpers}
realpath() { command realpath "\${@: -1}"; }
calculate_backup_manifest_hmac() {
  local root=$1 key_file=$2
  local key
  key=$(cat "$key_file")
  openssl dgst -sha256 -hmac "$key" -binary "$root/SHA256SUMS" | openssl base64 -A
}
supported_backup_verifier() { return 0; }
supported_backup_verifier "$1"
verify_backup_core_authentication "$1" "$2" stub-image
`;
    assert.equal(execFileSync("bash", ["-c", script, "backup-test", root, keyFile], {
      encoding: "utf8",
    }), "verified");

    writeFileSync(payload, "mutated payload that the stub ignores\n", {mode: 0o600});
    assert.throws(() => execFileSync("bash", ["-c", script, "backup-test", root, keyFile], {
      stdio: ["ignore", "pipe", "pipe"],
    }), "independent checksum verification must fail even when the supported verifier is stubbed successful");

    writeFileSync(payload, "authenticated payload\n", {mode: 0o600});
    writeFileSync(hmac, `${Buffer.alloc(32, 7).toString("base64")}\n`, {mode: 0o600});
    assert.throws(() => execFileSync("bash", ["-c", script, "backup-test", root, keyFile], {
      stdio: ["ignore", "pipe", "pipe"],
    }), "independent HMAC verification must fail even when the supported verifier is stubbed successful");

    writeFileSync(hmac, `${createHmac("sha256", key).update(readFileSync(manifest)).digest("base64")}\n`,
      {mode: 0o600});
    writeFileSync(join(root, "unlisted.bin"), "not authenticated\n", {mode: 0o600});
    assert.throws(() => execFileSync("bash", ["-c", script, "backup-test", root, keyFile], {
      stdio: ["ignore", "pipe", "pipe"],
    }), "independent inventory verification must reject unlisted payloads despite a successful stub verifier");
  } finally {
    rmSync(root, {recursive: true, force: true});
    rmSync(keyFile, {force: true});
  }
});
