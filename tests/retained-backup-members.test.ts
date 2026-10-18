import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {execFileSync, spawnSync} from "node:child_process";
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync,
  writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {dirname, join, resolve} from "node:path";
import test from "node:test";

const probe = readFileSync(resolve("scripts/oscar-storage-regression-probe.sh"), "utf8");

function shellFunction(name: string): string {
  const match = probe.match(new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?^\\}`, "mu"));
  assert.ok(match, `missing ${name}`);
  return match[0];
}

const verifierScript = [
  "set -Eeuo pipefail",
  "export LC_ALL=C",
  "fail() { printf 'ERROR: %s\\n' \"$*\" >&2; exit 1; }",
  shellFunction("sha256_file"),
  shellFunction("file_size"),
  shellFunction("verify_retained_backup_members"),
  "verify_retained_backup_members \"$1\" \"$2\" \"$3\"",
].join("\n");

function sha(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

interface Fixture {
  root: string;
  source: string;
  archive: string;
  inventory: string;
  work: string;
  members: Array<{kind: string; path: string; bytes: Buffer}>;
}

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "oscar-retained-backup-test-"));
  const source = join(root, "source");
  const base = "files/videos/retained-media/v1/events/event/lanes/lane/cameras/camera";
  const jpeg = Buffer.from([0xff, 0xd8, 0x11, 0x22, 0x33, 0xff, 0xd9]);
  const processed = Buffer.concat([
    Buffer.from("4f534341524d50490000000100000024", "hex"), Buffer.alloc(36, 1),
  ]);
  const deleted = Buffer.concat([
    Buffer.from("4f534341524d44490000000100000024", "hex"), Buffer.alloc(36, 2),
  ]);
  const members = [
    {kind: "M", path: `${base}/manifest.json`, bytes: Buffer.from("{\"schemaVersion\":1}\n")},
    ...Array.from({length: 5}, (_, index) => ({
      kind: "J", path: `${base}/frame-0${index + 1}.jpg`, bytes: jpeg,
    })),
    {kind: "C", path: "files/videos/retained-media/v1/.metadata-reclamation-checkpoint.json",
      bytes: Buffer.from("{\"schemaVersion\":2}\n")},
    {kind: "P", path: "files/videos/retained-media/v1/retention-processed-index/0000000000000000001-00.idx",
      bytes: processed},
    {kind: "D", path: "files/videos/retained-media/v1/deletion-index/aa/aabb.idx", bytes: deleted},
  ];
  for (const member of members) {
    const target = join(source, member.path);
    mkdirSync(dirname(target), {recursive: true});
    writeFileSync(target, member.bytes);
  }
  const inventory = join(root, "inventory.txt");
  writeFileSync(inventory, members.map(member =>
    `${member.kind}|${member.path}|${sha(member.bytes)}|${member.bytes.length}`).join("\n") + "\n");
  const archive = join(root, "state.tar.gz");
  execFileSync("tar", ["-czf", archive, ...members.map(member => member.path)], {cwd: source});
  const work = join(root, "work");
  mkdirSync(work, {mode: 0o700});
  return {root, source, archive, inventory, work, members};
}

function verify(value: Fixture): ReturnType<typeof spawnSync> {
  return spawnSync("bash", ["-ceu", verifierScript, "retained-backup-test",
    value.archive, value.inventory, value.work], {encoding: "utf8"});
}

test("exact retained backup verification accepts regular identity/type/hash/size members", {
  skip: process.platform === "win32",
}, () => {
  const value = fixture();
  try {
    const result = verify(value);
    assert.equal(result.status, 0, String(result.stderr));
    assert.equal(String(result.stdout), String(value.members.length));
  } finally { rmSync(value.root, {recursive: true, force: true}); }
});

test("exact retained backup verification rejects wrong-event equal counts and omissions", {
  skip: process.platform === "win32",
}, () => {
  const value = fixture();
  try {
    const expected = value.members[0]!;
    const wrong = expected.path.replace("/events/event/", "/events/wrong-event/");
    const wrongTarget = join(value.source, wrong);
    mkdirSync(dirname(wrongTarget), {recursive: true});
    writeFileSync(wrongTarget, expected.bytes);
    execFileSync("tar", ["-czf", value.archive, wrong,
      ...value.members.slice(1).map(member => member.path)], {cwd: value.source});
    const result = verify(value);
    assert.notEqual(result.status, 0);
    assert.match(String(result.stderr), /exactly one expected retained member/);
  } finally { rmSync(value.root, {recursive: true, force: true}); }
});

test("exact retained backup verification rejects duplicate member identities", {
  skip: process.platform === "win32",
}, () => {
  const value = fixture();
  try {
    const paths = value.members.map(member => member.path);
    execFileSync("tar", ["-czf", value.archive, paths[0]!, paths[0]!, ...paths.slice(1)],
      {cwd: value.source});
    const result = verify(value);
    assert.notEqual(result.status, 0);
    assert.match(String(result.stderr), /exactly one expected retained member/);
  } finally { rmSync(value.root, {recursive: true, force: true}); }
});

test("exact retained backup verification rejects symlink and wrong-hash members", {
  skip: process.platform === "win32",
}, () => {
  const linked = fixture();
  try {
    const expected = linked.members[0]!;
    rmSync(join(linked.source, expected.path));
    symlinkSync("frame-01.jpg", join(linked.source, expected.path));
    execFileSync("tar", ["-czf", linked.archive, ...linked.members.map(member => member.path)],
      {cwd: linked.source});
    const linkResult = verify(linked);
    assert.notEqual(linkResult.status, 0);
    assert.match(String(linkResult.stderr), /not a regular file/);
  } finally { rmSync(linked.root, {recursive: true, force: true}); }

  const tampered = fixture();
  try {
    writeFileSync(join(tampered.source, tampered.members[1]!.path),
      Buffer.from([0xff, 0xd8, 0x44, 0xff, 0xd9]));
    execFileSync("tar", ["-czf", tampered.archive, ...tampered.members.map(member => member.path)],
      {cwd: tampered.source});
    const hashResult = verify(tampered);
    assert.notEqual(hashResult.status, 0);
    assert.match(String(hashResult.stderr), /hash or size changed/);
  } finally { rmSync(tampered.root, {recursive: true, force: true}); }
});

test("private backup diagnostics resist the former fixed /tmp symlink clobber path", {
  skip: process.platform === "win32",
}, (context) => {
  const legacyLog = "/tmp/oscar-regression-backup-verify.log";
  if (existsSync(legacyLog)) {
    context.skip(`${legacyLog} already exists outside this isolated test`);
    return;
  }
  const root = mkdtempSync(join(tmpdir(), "oscar-log-clobber-test-"));
  const sentinel = join(root, "sentinel.txt");
  writeFileSync(sentinel, "unchanged\n");
  symlinkSync(sentinel, legacyLog);
  try {
    const allocation = probe.match(/^\s*backup_work=\$\(mktemp -d \/tmp\/oscar-regression-backup-check[.]XXXXXXXX\)$/m)?.[0];
    assert.ok(allocation, "missing private backup workspace allocation");
    const result = spawnSync("bash", ["-ceu", `umask 077
${allocation.trim()}
test "$(stat -c %a "$backup_work" 2>/dev/null || stat -f %Lp "$backup_work")" = 700
printf 'private diagnostic\n' >"$backup_work/backup-verify.log"
rm -rf -- "$backup_work"`], {encoding: "utf8"});
    assert.equal(result.status, 0, String(result.stderr));
    assert.equal(readFileSync(sentinel, "utf8"), "unchanged\n");
  } finally {
    if (existsSync(legacyLog)) unlinkSync(legacyLog);
    rmSync(root, {recursive: true, force: true});
  }
});
