import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {createHash} from "node:crypto";
import {appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {resolve} from "node:path";
import test from "node:test";

const probePath = resolve("scripts/oscar-storage-regression-probe.sh");
const probe = readFileSync(probePath, "utf8");
const scenarios = readFileSync(resolve("src/scenarios.ts"), "utf8");
const storageClient = readFileSync(resolve("src/storage-probe.ts"), "utf8");

function entrypointContractAccepts(entrypoint: string): boolean {
  const helper = probe.match(/^entrypoint_has_managed_tmp_contract\(\) \{\n[\s\S]*?^\}/mu)?.[0];
  assert.ok(helper, "missing entrypoint temp-contract helper");
  try {
    execFileSync("bash", ["-c", `set -Eeuo pipefail
${helper}
candidate=$(mktemp)
trap 'rm -f -- "$candidate"' EXIT
cat >"$candidate"
entrypoint_has_managed_tmp_contract "$candidate"`], {
      input: entrypoint,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return true;
  } catch {
    return false;
  }
}

function runProbeQueryHelpers(helperSource: string): string {
  return execFileSync("bash", ["-c", `set -Eeuo pipefail
psql_admin() {
  local quiet=false argument query
  for argument in "$@"; do [[ $argument == --quiet ]] && quiet=true; done
  query=\${!#}
  if [[ $query == *json* ]]; then printf '%s\\n' '{"ok":true}'
  else printf '%s\\n' '1'; fi
  $quiet || printf '%s\\n' 'UPDATE 1'
}
${helperSource}
scalar_value=$(scalar 'UPDATE fixture SET value=1 RETURNING 1')
json_value=$(json_query 'UPDATE fixture SET value=1 RETURNING json')
printf '%s\\t%s' "$scalar_value" "$json_value"`], {encoding: "utf8"});
}

function runHoldOutputParser(
  output: string,
  storeKey = "obs",
  idScope = "4",
  resolution = "GENERATION_EXACT",
): string {
  const validUuid = probe.match(/^valid_uuid\(\) \{[^\n]+\}$/mu)?.[0];
  const parser = probe.match(/^retention_hold_id_from_output\(\) \{\n[\s\S]*?^\}/mu)?.[0];
  assert.ok(validUuid && parser, "missing retention-hold output parser");
  return execFileSync("bash", ["-c", `set -Eeuo pipefail
${validUuid}
${parser}
retention_hold_id_from_output "$1" "$2" "$3" "$4"`,
  "hold-parser", output, storeKey, idScope, resolution], {
    encoding: "utf8",
  });
}

function structuralStorageFixtureAccepted(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  const object = (candidate: unknown): candidate is Record<string, unknown> =>
    Boolean(candidate) && typeof candidate === "object" && !Array.isArray(candidate);
  const exactly = (className: string) => value.filter(candidate =>
    object(candidate) && candidate.objClass === className);
  const daily = exactly("com.botts.impl.service.dailyfile.DailyFileJournalServiceConfig");
  const oscar = exactly("com.botts.impl.service.oscar.OSCARServiceConfig");
  const databases = exactly("org.sensorhub.impl.database.system.SystemDriverDatabaseConfig");
  if (daily.length !== 1 || oscar.length !== 1 || databases.length !== 1) return false;
  const media = object(oscar[0]!.videoRetentionConfig) ? oscar[0]!.videoRetentionConfig : undefined;
  const db = object(databases[0]!.dbConfig) ? databases[0]!.dbConfig : undefined;
  const archive = object(db) && object(db.archive) ? db.archive : undefined;
  return object(media) && object(db) && object(archive) &&
    typeof media.enableFrameRetention === "boolean" &&
    typeof media.frameRetentionCount === "number" &&
    typeof db.useBatch === "boolean" && db.useBatch === true &&
    typeof archive.deleteHotAfterArchive === "boolean" &&
    typeof daily[0]!.maxSegmentBytes === "number";
}

test("query helpers suppress DML command tags before parsing scalar and JSON rows", () => {
  const scalarHelper = probe.match(/^scalar\(\) \{[^\n]+\}$/mu)?.[0];
  const jsonHelper = probe.match(/^json_query\(\) \{[^\n]+\}$/mu)?.[0];
  assert.ok(scalarHelper && jsonHelper, "missing storage query helpers");
  const helpers = `${scalarHelper}\n${jsonHelper}`;
  assert.match(scalarHelper, /psql_admin --quiet --tuples-only --no-align/);
  assert.match(jsonHelper, /psql_admin --quiet --tuples-only --no-align/);
  assert.equal(runProbeQueryHelpers(helpers), '1\t{"ok":true}');

  const legacyHelpers = helpers.replaceAll(" --quiet", "");
  assert.equal(runProbeQueryHelpers(legacyHelpers), "1UPDATE1\tUPDATE 1");
});

test("retention-hold parser accepts the canonical scoped CLI line and rejects ambiguity", () => {
  const id = "ee6dda6f-af28-4f9c-951f-97b80c231cd5";
  const canonical = `Retention hold created: ${id} (store=obs, id-scope=4, resolution=GENERATION_EXACT)`;
  assert.equal(runHoldOutputParser(`administrative preface\n${canonical}\n`), id);
  assert.throws(() => runHoldOutputParser(canonical, "other_store", "4"));
  assert.throws(() => runHoldOutputParser(canonical, "obs", "5"));
  assert.throws(() => runHoldOutputParser(canonical, "obs", "4", "HOT_EXACT"));
  assert.throws(() => runHoldOutputParser(`Retention hold created: ${id}`));
  assert.throws(() => runHoldOutputParser(
    `Retention hold created: ${id} (store=obs, id-scope=4, resolution=UNKNOWN)`,
  ));
  assert.throws(() => runHoldOutputParser(
    `Retention hold created: ${id} (store=obs, id-scope=4, resolution=LEGACY_UNKNOWN)`,
  ));
  assert.throws(() => runHoldOutputParser(`${canonical}\n${canonical}`));
  assert.throws(() => runHoldOutputParser(canonical.toUpperCase()));
});

test("shell UUID validation enforces canonical version and variant bits", () => {
  const helper = probe.match(/^valid_uuid\(\) \{[^\n]+\}$/mu)?.[0];
  assert.ok(helper);
  const accepted = execFileSync("bash", ["-c", `set -Eeuo pipefail
${helper}
valid_uuid "$1"
printf accepted`, "uuid", "123e4567-e89b-42d3-a456-426614174000"], {encoding: "utf8"});
  assert.equal(accepted, "accepted");
  for (const value of [
    "123E4567-E89B-42D3-A456-426614174000",
    "123e4567-e89b-02d3-a456-426614174000",
    "123e4567-e89b-42d3-7456-426614174000",
    "00000000-0000-0000-0000-000000000000",
  ]) assert.throws(() => execFileSync("bash", ["-c", `${helper}; valid_uuid "$1"`, "uuid", value]));
});

test("storage probe remains valid Bash and gates exact 3.9.2 image identity", () => {
  assert.doesNotThrow(() => execFileSync("bash", ["-n", probePath]));
  for (const required of [
    "expected_release=3.9.2",
    "org.opencontainers.image.version",
    "com.botts.oscar.storage-profile",
    "nginxinc/nginx-unprivileged:",
    "containerImageId",
    "repoDigests",
    "oscar-storage-profile",
  ]) assert.ok(probe.includes(required), `missing probe identity contract: ${required}`);
  assert.match(probe, /docker compose --project-name oscar --env-file \.env --file compose\.yaml/);
  assert.match(probe, /env -u OSCAR_ARCHIVE_DIR/);
  assert.doesNotMatch(probe, /lock_directory=\$\{OSCAR_STORAGE_LOCK_DIR/);
});

test("alarm-media probe scopes a no-replace baseline and removes every temporary marker", () => {
  const start = probe.indexOf("  alarm-media-baseline)");
  const end = probe.indexOf("  platform)", start);
  const block = probe.slice(start, end);
  assert.ok(start > 0 && end > start, "missing alarm-media probe actions");
  for (const required of [
    "alarm-media-baseline)",
    "alarm-media-cleanup)",
    "alarm-media-source-status)",
    "alarm-media-ledger)",
    "alarm-media-forensics)",
    "alarm_all_camera_artifacts",
    "baseline-final",
    "baseline-partial",
    "new-final",
    "newFinalizedOrphans",
    "newPartialArtifacts",
    "expectedAlreadyPresentAtBaseline",
  ]) assert.ok(block.includes(required), `missing alarm-media forensic contract: ${required}`);
  assert.match(block, /ln -- "\$marker_tmp" "\$marker"/);
  assert.doesNotMatch(block, /mv -- "\$marker_tmp" "\$marker"/);
  assert.match(block, /chmod 600 "\$marker_tmp"/);
  assert.match(block, /version\\t2/);
  assert.match(block, /file_owner_id "\$marker"/);
  assert.match(block, /file_mode "\$marker"/);
  assert.match(block, /cut -d\/ -f3 "\$forensic_tmp\/expected"/);
  assert.match(block, /camera\[path\[3\]\]/);
  assert.match(block, /comm -13 "\$forensic_tmp\/baseline-final" "\$forensic_tmp\/current-final"/);
  assert.match(block, /rm -f -- "\$marker"/);
  assert.match(block, /trap cleanup_alarm_baseline EXIT/);
  assert.match(block, /trap cleanup_alarm_forensics EXIT/);
  assert.match(probe, /-g\[1-9\]\[0-9\]\*\\\.mp4/);
});

test("generated alarm-media scenario binds public observations, MP4 metadata, manifests, and ledgers", () => {
  const start = scenarios.indexOf("private async configuredAlarmCameraUids");
  const end = scenarios.indexOf("private storageUnavailable", start);
  const block = scenarios.slice(start, end);
  assert.ok(start > 0 && end > start, "missing generated alarm-media scenario coverage");
  for (const required of [
    "/sensorhub/api/observations/",
    "/sensorhub/api/systems?searchMembers=true",
    "cameraUidsForSystemComponents",
    "laneUidForSystemName",
    "assessAlarmVideoObservation",
    "assertAlarmVideoAssociationUnique",
    "loadedmetadata",
    "alarm-media-source-status",
    "/sensorhub/buckets/videos/media/",
    "assessRetainedMediaResponse",
    "sourceByCamera.get(mediaSet.cameraUid) !== mediaSet.sourceObjectKey",
    "mediaSet.laneUid !== expectedLaneUid",
    "alarm-media-ledger",
    'ledger.attempts === 1',
    'ledger.failure === ""',
    "alarm-media-forensics",
    "alarmMediaForensicsPassed",
  ]) assert.ok(block.includes(required), `missing generated alarm-media assertion: ${required}`);
  assert.match(block, /Buffer\.from\(item\.association\.eventId, "utf8"\)\.toString\("base64url"\)/);
  assert.match(block, /generated\.flatMap\(item =>[\s\S]*item\.association\.paths/);
  assert.doesNotMatch(block, /new Set\(generated\.flatMap/);
  assert.match(block, /"alarm-media-baseline", \[this\.alarmMediaRunKey\(\)\]\)/);
  assert.match(block, /if \(!this\.selected\("storage-lifecycle"\)/);
  assert.doesNotMatch(block, /baselineCreated:[\s\S]{0,120}cameras:/);
  assert.doesNotMatch(block, /originalRpmConfig\?\.camera_ids/);
});

test("storage probe client registers privileged alarm baseline cleanup before an uncertain remote outcome", () => {
  const client = storageClient;
  const register = client.indexOf(
    'if (action === "alarm-media-baseline" && alarmRun) this.alarmBaselineRuns.add(alarmRun)',
  );
  const remote = client.indexOf('await execFileAsync("ssh"', register);
  assert.ok(register > 0 && remote > register);
  const cleanup = client.slice(client.indexOf("async cleanup(): Promise<void>"));
  assert.match(cleanup, /for \(const run of this\.alarmBaselineRuns\)/);
  assert.match(cleanup, /"sudo", "-n", "bash", this\.remoteScript/);
  assert.match(cleanup, /"alarm-media-cleanup", run/);
  assert.match(cleanup, /baselineCleanupError \?\?= error/);
  assert.match(cleanup, /Unable to remove a privileged alarm-media baseline marker/);
  assert.match(cleanup, /removeRemoteWorkspace/);
  assert.doesNotMatch(cleanup, /rm -f -- \/tmp\/oscar-alarm-media/);
  assert.match(cleanup, /this\.alarmBaselineRuns\.clear\(\)/);
});

test("restore control state is pre-armed, descendant-aware, and fail-closed", () => {
  const state = storageClient.slice(
    storageClient.indexOf("private async waitForRestoreTermination"),
    storageClient.indexOf("private async restoreCommand"),
  );
  const wrapper = storageClient.slice(
    storageClient.indexOf("private async restoreCommand"),
    storageClient.indexOf("async install()"),
  );
  for (const required of [
    '[ -e \\"$control_path\\" ] || [ -L \\"$control_path\\" ]',
    "0:0:600",
    "ready + active + cancelled",
    'mv -T -- \\"$ready_path\\" \\"$cancelled_path\\"',
    "complete:%s",
    "ps -eo pid=,pgid=,sid=",
    "$2 == pgid || $3 == sid",
  ]) assert.ok(state.includes(required), `missing fail-closed restore state contract: ${required}`);
  assert.doesNotMatch(state, /not-started/);
  assert.ok(state.indexOf("ps -eo pid=,pgid=,sid=") < state.lastIndexOf("complete:%s"),
    "terminal status must not outrank exact session-member discovery");
  for (const required of [
    "oscar-storage-restore-arm",
    "not-launched",
    'mv -T -- \\"$ready_path\\" \\"$active_path\\"',
    "setsid --fork --wait",
    "wait_for_session_quiet",
    "trap finalize_wrapper EXIT",
    "publish_status",
  ]) assert.ok(wrapper.includes(required), `missing restore wrapper lifecycle contract: ${required}`);
  assert.ok(wrapper.indexOf("mv -fT --") < wrapper.indexOf('exec \\"${command[@]}\\"'),
    "session identity must be published before the product restore can execute");
});

test("platform probe binds roots, the stable lock, and exact helper provenance and behavior", () => {
  const block = probe.slice(probe.indexOf("  platform)"), probe.indexOf("  snapshot)"));
  for (const required of [
    "OSCAR_DEPLOYMENT_ID",
    "archive_identity",
    "backup_identity",
    "wal_identity",
    "/run/lock/oscar-storage",
    "$deployment_id.lock",
    "Another OSCAR storage administration command is already running.",
    "/usr/local/bin/oscar-archive-wal",
    "/usr/local/bin/oscar-archive-object",
    "/usr/local/bin/oscar-prepare-restore",
    "/usr/local/bin/oscar-merge-wal-restore",
    "/usr/local/bin/oscar-atomic-publish",
    "/usr/local/share/oscar-atomic-publish.source.sha256",
    "archive_command_exact",
    "wal_publication_contract",
    "publicationContractExact",
    "packagedSha256",
    "deployedSha256",
    "archive_export_helper_wired",
    "archive_purge_helper_wired",
    "cliExportIntegrated",
    "cliPurgeIntegrated",
    "packagedSourceSha256",
    "deployedSourceSha256",
    "deployedBinarySha256",
    "collisionRejected",
    "sourcePreserved",
    "destinationPreserved",
    "appBackupRootAbsent",
    "postgresBackupRootAbsent",
    "isolatedBasebackupWired",
  ]) assert.ok(block.includes(required), `missing platform hardening contract: ${required}`);
  assert.match(block, /archive_object_helper copy "\\\$relative" "\\\$expected_sha" ro "\\\$partial"/);
  assert.match(block,
    /archive_object_helper delete "\\\$relative" "\\\$expected_sha" rw <\/dev\/null/);
  assert.match(block, /if ln -- "\$partial" "\$destination"/);
  assert.match(block, /sync -d "\$partial"/);
  assert.match(block, /sync -f "\$archive_root"/);
  assert.match(block, /oscar-atomic-publish "\$root" source published/);
  assert.match(block, /oscar-atomic-publish "\$root" challenger published/);
  assert.match(block, /test "\$status" -ne 0/);
  assert.match(block, /--network "container:\$postgres_container"/);
  assert.match(block, /--volume "\$work\/postgres:\/backup"/);
  assert.match(block, /grep -Fqx \/var\/lib\/oscar\/backups/);
  assert.match(block, /grep -Fqx \/var\/lib\/postgresql\/backups/);
  for (const required of [".oscar-storage-root", "format=oscar-storage-root-identity", "version=1",
    "root_kind=$expected_kind"]) {
    assert.ok(probe.includes(required), `missing root-marker contract: ${required}`);
  }
  assert.match(block, /expected_archive_command='\/usr\/local\/bin\/oscar-archive-wal "%p" "%f" \/var\/lib\/postgresql\/wal-archive'/);
});

test("platform probe verifies the live split native and untrusted-data temp contract", () => {
  const block = probe.slice(probe.indexOf("  platform)"), probe.indexOf("  snapshot)"));
  for (const required of [
    "/proc/self/mountinfo",
    "packaged_entrypoint=docker/oscar/entrypoint.sh",
    "/usr/local/bin/oscar-entrypoint",
    "packagedEntrypointSha256",
    "deployedEntrypointSha256",
    "containerEntrypointExact",
    "managedPropertiesAfterJavaOpts",
    "native_path=/run/oscar-native",
    "mount_has_option /tmp noexec",
    'mount_has_option "$native_path" noexec',
    'stat -c "%u:%g:%a" "$native_path"',
    'stat -f -c "%S:%b" "$native_path"',
    'cp /bin/true "$exec_probe"',
    'readlink "$process/exe"',
    '-Djava.io.tmpdir=*',
    '-Dorg.bytedeco.javacpp.cachedir=*',
    '-Doscar.data.tmpdir=*',
    'effective_java_tmp=${argument#-Djava.io.tmpdir=}',
    'effective_javacpp_cache=${argument#-Dorg.bytedeco.javacpp.cachedir=}',
    'effective_data_tmp=${argument#-Doscar.data.tmpdir=}',
    '"nativeRuntime"',
    '"nativeNoexecAbsent"',
    '"nativeSizeBytes"',
    '"javaTmpPropertyCount"',
    '"javaCppCachePropertyCount"',
    '"dataTmpPropertyCount"',
  ]) assert.ok(block.includes(required), `missing live JVM temp contract: ${required}`);
  assert.match(block, /rm -f -- "\$exec_probe"/);
  assert.ok(!block.includes('mount_has_option "$native_path" exec'));
});

test("entrypoint contract requires one managed property tail after JAVA_OPTS", () => {
  const valid = `NATIVE_TMP_DIR=/run/oscar-native
readonly NATIVE_TMP_DIR
exec java \${JAVA_OPTS:-} \\
  -Djava.io.tmpdir="\${NATIVE_TMP_DIR}" \\
  -Dorg.bytedeco.javacpp.cachedir="\${NATIVE_TMP_DIR}/javacpp" \\
  -Doscar.data.tmpdir=/tmp \\
  com.example.Main
`;
  assert.equal(entrypointContractAccepts(valid), true);
  assert.equal(entrypointContractAccepts(valid.replace(
    "exec java ${JAVA_OPTS:-} \\\n  -Djava.io.tmpdir=\"${NATIVE_TMP_DIR}\"",
    "-Djava.io.tmpdir=\"${NATIVE_TMP_DIR}\" \\\nexec java ${JAVA_OPTS:-}",
  )), false);
  assert.equal(entrypointContractAccepts(valid.replace(
    "-Dorg.bytedeco.javacpp.cachedir=\"${NATIVE_TMP_DIR}/javacpp\" \\\n  -Doscar.data.tmpdir=/tmp",
    "-Doscar.data.tmpdir=/tmp \\\n  -Dorg.bytedeco.javacpp.cachedir=\"${NATIVE_TMP_DIR}/javacpp\"",
  )), false);
  assert.equal(entrypointContractAccepts(valid.replace(
    "  -Dorg.bytedeco.javacpp.cachedir=\"${NATIVE_TMP_DIR}/javacpp\" \\\n",
    "",
  )), false);
  assert.equal(entrypointContractAccepts(valid.replace(
    "  -Doscar.data.tmpdir=/tmp \\",
    "  -Doscar.data.tmpdir=/tmp \\\n  -Doscar.data.tmpdir=/tmp \\",
  )), false);
});

test("platform config uses structural JSON extraction and rejects decoys, duplicates, and type mismatch", () => {
  const block = probe.slice(probe.indexOf("  platform)"), probe.indexOf("  snapshot)"));
  const helper = probe.match(/^platform_config_fields\(\) \{\n[\s\S]*?^\}/mu)?.[0];
  assert.ok(helper, "missing structural config helper");
  const configContract = `${helper}\n${block}`;
  for (const required of [
    "json_array_elements", "json_each", "json_typeof", "WITH ORDINALITY",
    "count(*) FROM candidates WHERE kind = 'daily'", "count(*) FROM candidates WHERE kind = 'oscar'",
    "count(*) FROM candidates WHERE kind = 'database'", "GROUP BY key HAVING count(*) <> 1",
    "OscarTieredObsSystemDatabaseConfig", "useBatch", "videoRetentionConfig",
  ]) assert.ok(helper.includes(required), `missing structural config contract: ${required}`);
  assert.doesNotMatch(block, /config_text_matches|daily_config_text|oscar_config_text/);
  assert.doesNotMatch(block, /sed -n 's\/\.\*"(?:intervalMinutes|frameRetentionCount|maxSegmentBytes)/);
  for (const field of [
    "timeToRetention", "videoQueryPeriod", "enableFrameRetention", "frameRetentionCount", "jpegQuality",
    "sourceRollbackGraceHours", "metadataReclamationWorkLimit",
    "duckDbMemoryLimitMegabytes", "duckDbThreads", "duckDbMaximumTemporaryMegabytes",
    "duckDbMaximumConcurrentSessions", "duckDbSessionAcquireTimeoutSeconds",
    "duckDbTemporaryDirectory", "archiveResources", "schemaChecksum", "archiveScratch",
    "dailyJournal", "rootDirectory", "journalDirectory", "publicationDirectory",
    "dailyFileObservationMode", "fsyncIntervalMillis", "maxUnforcedRecords", "maxUnforcedBytes",
    "maxSegmentBytes", "maxSegmentAgeSeconds", "maxRecordBytes", "sealedJournalRetentionDays",
    "delegateObservationLifecycleToDatabase", "dailyFilePurgeWorkLimit",
  ]) assert.ok(configContract.includes(field), `missing bounded-storage preflight field: ${field}`);
  assert.match(block, /config=\/var\/lib\/oscar\/config[.]json/);
  assert.match(block, /test -f "\$path" && test ! -L "\$path"/);
  assert.match(block, /size.*-le 16777216/);
  assert.match(block, /WHERE version=5/);
  assert.match(block, /archive_scratch_json "\$duck_temp_dir" \/var\/lib\/oscar\/archive/);

  const daily = {objClass: "com.botts.impl.service.dailyfile.DailyFileJournalServiceConfig",
    moduleClass: "com.botts.impl.service.dailyfile.DailyFileJournalService", maxSegmentBytes: 67_108_864};
  const oscar = {objClass: "com.botts.impl.service.oscar.OSCARServiceConfig",
    moduleClass: "com.botts.impl.service.oscar.OSCARServiceModule",
    videoRetentionConfig: {enableFrameRetention: true, frameRetentionCount: 5}};
  const database = {objClass: "org.sensorhub.impl.database.system.SystemDriverDatabaseConfig",
    moduleClass: "org.sensorhub.impl.database.system.SystemDriverDatabase",
    dbConfig: {objClass: "org.sensorhub.impl.datastore.postgis.database.OscarTieredObsSystemDatabaseConfig",
      useBatch: true, archive: {deleteHotAfterArchive: false}}};
  const valid = [daily, oscar, database];
  assert.equal(structuralStorageFixtureAccepted(valid), true);
  assert.equal(structuralStorageFixtureAccepted([
    {objClass: "decoy", frameRetentionCount: 999, deleteHotAfterArchive: true}, ...valid,
  ]), true, "an unrelated decoy cannot supply scoped values");
  assert.equal(structuralStorageFixtureAccepted([...valid, structuredClone(daily)]), false,
    "a duplicate expected module must fail");
  const wrongType = structuredClone(valid);
  (wrongType[1] as typeof oscar).videoRetentionConfig.frameRetentionCount = "5" as unknown as number;
  assert.equal(structuralStorageFixtureAccepted(wrongType), false,
    "a shape-compatible string cannot satisfy a numeric storage field");
  assert.ok(block.includes("AND query ~ '[)][[:space:]]*,[[:space:]]*[(]'"));
  assert.match(block, /\$batch_rows -gt \$batch_calls/);
  assert.doesNotMatch(block, /reWriteBatchedInserts|OscarTieredObsSystemDatabase\|/);
});

test("archive health aggregates generations independently from archive objects", () => {
  const block = probe.slice(probe.indexOf("  archive-health)"), probe.indexOf("  journal-status)"));
  assert.match(block, /WITH generations AS/);
  assert.match(block, /objects AS/);
  assert.match(block, /incomplete AS/);
  assert.doesNotMatch(block, /FROM oscar_archive_generation g LEFT JOIN oscar_archive_object/);
  assert.match(block, /archivePartialArtifacts/);
  assert.match(block, /walPartialArtifacts/);
  assert.equal(block.match(/'activeHolds'/g)?.length, 1, "archive-health JSON must contain activeHolds once");
});

test("journal status validates exact bounded v1 manifests and direct lane state", () => {
  const block = probe.slice(probe.indexOf("  journal-status)"), probe.indexOf("  journal-restart)"));
  for (const required of [
    "total", "100000", "manifest_size", "1048576", "manifest_encoded",
    "json_object_keys(raw))=12", "OSCAR_LEGACY_DAILY_CSV", "checksumAlgorithm", "SHA-256",
    "windowStartInclusive", "windowEndExclusive", "dataFile", "publishedAt", "unsafeLinks",
    "unsafeEntries",
    "bounded", "journal-lane-state)", "urn:osh:system:lane:", "directory_id",
    "sha256sum | cut -c1-12", "lane.id", "-mindepth 2 -maxdepth 2",
    "openSegments", "sealedSegments", "unsafeEntries", "journal-metadata.v1.json",
    "eligiblePriorDayDirectories", "currentDayDirectories", "currentDayOpenSegments",
    "currentDaySealedSegments", "currentDayBytes", "journalIntegrityFailures",
    "444a4e4c00000001", "journal_zone", "journal_today",
  ]) assert.ok(block.includes(required), `missing direct-journal validation contract: ${required}`);
  assert.ok(block.includes(
    "^/var/lib/oscar/files/dailyfiles/[A-Za-z0-9._-]+-[0-9a-f]{12}_[0-9]{4}",
  ));
  assert.ok(block.includes(
    "value->>'dataFile' ~ '^[A-Za-z0-9._-]+-[0-9a-f]{12}_[0-9]{4}",
  ));
  const publicationPattern = block.match(/\[\[ ! \$manifest =~ (\^[^ ]+) \]\]/u)?.[1];
  assert.ok(publicationPattern, "missing executable flat publication-path pattern");
  const canonicalManifest =
    "/var/lib/oscar/files/dailyfiles/Lane50-0123456789ab_2026-10-18.csv.manifest.v1.json";
  execFileSync("bash", ["-c", `[[ $1 =~ ${publicationPattern} ]]`, "manifest-path", canonicalManifest]);
  assert.throws(() => execFileSync("bash", ["-c", `[[ $1 =~ ${publicationPattern} ]]`,
    "manifest-path", "/var/lib/oscar/files/dailyfiles/Lane50/2026-10-18.csv.manifest.v1.json"]));
  assert.match(block, /-name "[*][.]partial[.]\*"/);
  assert.match(block, /\(value->>'recordCount'\)::bigint=\$actual_records/);
  assert.match(block, /\(value->>'byteCount'\)::bigint=\$actual_bytes/);
  assert.match(block, /value->>'sha256'='\$actual_sha'/);
  assert.match(block, /value->>'dataFile'='\$csv_name'/);
  assert.match(block, /'\$csv_day'::date::timestamp AT TIME ZONE '\$journal_zone'/);
  assert.match(block, /publishedAt'\)::timestamptz >=/);
  assert.doesNotMatch(block, /for manifest in \$\(find/);
  assert.match(block, /awk -v today="\$today" "\\\$0 ~ \/\^\[0-9\]\{4\}/);
  assert.match(block, /awk "\{ total \+= \\\$1 \} END \{ printf \\"%\.0f\\n\\", total\+0 \}"/);
  assert.doesNotMatch(block, /awk -v today="\$today" '\$0/,
    "the container-shell program must not terminate the host's single-quoted sh -c argument");
});

test("journal inventory serializes one intact POSIX shell payload", () => {
  const block = probe.slice(probe.indexOf("  journal-status)"), probe.indexOf("  journal-restart)"));
  const start = block.indexOf("    inventory=$(compose exec -T oscar sh -eu -c '");
  const end = block.indexOf("\n    IFS='|' read -r publications", start);
  assert.ok(start >= 0 && end > start, "missing journal inventory command substitution");
  const assignment = block.slice(start, end);
  const root = mkdtempSync(resolve(tmpdir(), "oscar-journal-payload-"));
  const capture = resolve(root, "payload.sh");
  try {
    execFileSync("bash", ["-c", `set -Eeuo pipefail
capture=$1
compose() {
  [[ $# -eq 9 ]] || { printf 'unexpected compose argv count: %s\\n' "$#" >&2; return 90; }
  [[ $1 == exec && $2 == -T && $3 == oscar && $4 == sh && $5 == -eu && $6 == -c ]] || return 91
  [[ $8 == journal-inventory && $9 == 2026-10-18 ]] || return 92
  printf '%s' "$7" >"$capture"
  printf '%s\\n' '0|0|0|0|0|0|0|0|0|0|0|0|0|0'
}
fail() { printf '%s\\n' "$*" >&2; return 93; }
journal_today=2026-10-18
${assignment}
`, "journal-payload", capture], {stdio: ["ignore", "pipe", "pipe"]});
    const serialized = readFileSync(capture, "utf8");
    assert.match(serialized, /awk -v today="\$today" "\\\$0 ~/);
    assert.doesNotThrow(() => execFileSync("sh", ["-n", "-c", serialized], {
      stdio: ["ignore", "pipe", "pipe"],
    }));
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test("journal restart prefix oracle rejects truncation masked by later growth", () => {
  const helper = probe.match(/^journal_prefix_matches\(\) \{\n[\s\S]*?^\}/mu)?.[0];
  assert.ok(helper, "missing journal prefix helper");
  const root = mkdtempSync(resolve(tmpdir(), "oscar-journal-prefix-"));
  const candidate = resolve(root, "000001.open");
  const original = Buffer.from("durable-prefix-before-restart\n", "utf8");
  const digest = createHash("sha256").update(original).digest("hex");
  const run = () => execFileSync("bash", ["-c", `set -Eeuo pipefail
${helper}
journal_prefix_matches "$1" "$2" "$3"`, "prefix", digest, String(original.length), candidate]);
  try {
    writeFileSync(candidate, original);
    appendFileSync(candidate, "legitimate-growth\n");
    assert.doesNotThrow(run);
    writeFileSync(candidate, Buffer.concat([
      Buffer.from("TRUNCATED-AND-REPLACED!!!!!!!\n"),
      Buffer.alloc(original.length + 32, 0x78),
    ]));
    assert.throws(run, "growth after truncation must not satisfy byte-count monotonicity");
    writeFileSync(candidate, original.subarray(0, 5));
    assert.throws(run, "a shorter successor must fail");
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test("media metadata probe validates compact checkpoint and exact binary indexes", () => {
  const start = probe.indexOf("media_metadata_health_json()");
  const end = probe.indexOf("\n}\n", start);
  const helper = probe.slice(start, end + 2);
  for (const required of [
    ".metadata-reclamation-checkpoint.json", "checkpoint_schema",
    "earliestProcessedObservationEpochHour", "retention-processed-index", "deletion-index",
    "legacyProcessedMarkerFiles", "legacyDeletionTombstones", "indexFormatFailures", "100000",
    "4f534341524d50490000000100000024", "4f534341524d44490000000100000024",
  ]) assert.ok(helper.includes(required), `missing media metadata health contract: ${required}`);
  assert.match(helper, /\^\[0-9\]\{19\}-\(0\[0-9\]\|1\[01\]\)\[.]idx\$/);
  assert.match(helper, /\(\(\(size-16\)%36\)\)/);
  assert.doesNotMatch(helper, /records[^\n]*-gt 100000/,
    "valid high-rate five-minute index files must stream rather than fail format validation");
  assert.match(probe, /  media-metadata-health\)/);
  assert.match(probe, /  archive-scratch-health\)/);
});

test("storage snapshot emits activeHolds exactly once", () => {
  const block = probe.slice(probe.indexOf("  snapshot)"), probe.indexOf("  archive-health)"));
  assert.equal(block.match(/'activeHolds'/g)?.length, 1);
  assert.equal(
    block.match(/awk '\{print \\\$1\+0\}'/g)?.length,
    3,
    "snapshot byte probes must escape awk's positional field from the outer set -u shell",
  );
  assert.ok(
    !block.includes("awk '{print \\\\$1+0}'"),
    "a doubled backslash leaves $1 exposed to the outer shell",
  );
  for (const field of [
    "retainedMediaManifestFiles", "retainedMediaJpegFiles", "processedObservationIndexFiles",
    "processedObservationIndexBytes", "deletionIndexFiles", "deletionIndexBytes",
    "legacyProcessedMarkerFiles", "legacyDeletionTombstones", "mediaMetadataCheckpointBytes",
  ]) assert.ok(block.includes(field), `missing media storage metric: ${field}`);
});

test("backup check authenticates markers, epoch, supported verification, and journal receipts", () => {
  const block = probe.slice(probe.indexOf("  backup-check)"), probe.indexOf("  restore-drill)"));
  for (const required of [
    "SHA256SUMS.hmac",
    "JOURNAL_CONFIRMED",
    "epoch.json",
    "image-inventory.txt",
    "archive-generation-ids.txt",
    "backup-verify",
    "oscar-backup-epoch",
    "journalReceipts",
    "backup-confirmations",
    "journalConfirmationAuthenticated",
    "archiveGenerationInventoryExact",
    "oscar-dailyfile-backup-confirmation-set",
    "confirmationSet",
    "oscar-backup:$backup/oscar-state.tar.gz#sha256=$oscar_state_sha",
    "duckDbScratchExcluded",
    "retainedMediaPrefixPresent",
    "mediaMetadataCheckpointIncluded",
    "processedObservationIndexesIncluded",
    "deletionIndexesIncluded",
    "retainedMediaManifestsIncluded",
    "retainedMediaJpegsIncluded",
  ]) assert.ok(block.includes(required), `missing backup contract: ${required}`);
  assert.match(block, /-f \$root\/\$required && ! -L \$root\/\$required/);
  assert.match(block, /-f \$root\/archive-generation-ids\.txt && ! -L \$root\/archive-generation-ids\.txt/);
  assert.doesNotMatch(
    block,
    /-s \$root\/archive-generation-ids\.txt/,
    "a zero-generation inventory is the canonical empty file and must remain valid",
  );
  assert.match(block, /convert_from\(decode\('\$encoded','base64'\),'UTF8'\)::jsonb/);
  assert.match(block, /json_object_keys\(raw\)\)=10/);
  assert.match(block, /value->>'day'='\$receipt_day'/);
  assert.match(block, /value \?& ARRAY\['schemaVersion','laneId','day','windowStartInclusive'/);
  assert.match(block, /json_array_elements/);
  assert.match(block, /\$2=="\.\/JOURNAL_CONFIRMED" \{count\+\+\} END \{print count\+0\}' "\$root\/SHA256SUMS"\) == 0/);
  assert.match(block, /grep -Fxc 'version=2'/);
  assert.match(block, /hmac_sha256=/);
  assert.match(block, /openssl dgst -sha256 -hmac/);
  assert.match(block, /\.sets\/\$backup\.json/);
  assert.match(block, /receipt->>'path'='\$relative' AND receipt->>'sha256'='\$receipt_sha'/);
  assert.match(block, /archive-generation-ids\.txt" \{count\+\+\} END \{print count\+0\}' "\$root\/SHA256SUMS"\) == 1/);
  assert.match(block, /generation_bytes -le 37000000/);
  assert.match(block, /generation_count -le 1000000/);
  assert.match(block, /generation_bytes == \$\(\(generation_count \* 37\)\)/);
  assert.match(block, /generation_sha=\$\(sha256_file "\$root\/archive-generation-ids\.txt"\)/);
  assert.match(block, /archive_generation_count\|\|'\|'\|\|archive_generation_inventory_sha256\|\|'\|'\|\|archive_generation_inventory_bytes/);
  assert.match(block, /catalog_generation_receipt == "\$generation_count\|\$generation_sha\|\$generation_bytes"/);
  assert.doesNotMatch(block, /array_to_string\(archive_generation_ids/);
  assert.doesNotMatch(block, /paste -sd,/);
  assert.match(block, /tar -tzf "\$root\/oscar-state[.]tar[.]gz"/);
  assert.match(block, /duckdb-tmp/);
  assert.match(block, /retention-processed-index\/\[0-9\]\{19\}-\(0\[0-9\]\|1\[01\]\)/);
  assert.match(block, /verify_retained_backup_members/);
  assert.match(block, /expected-retained-members[.]txt/);
  assert.match(block, /retainedMediaExactMembersVerified/);
  assert.match(block, /expectedProcessedIndexes/);
  assert.match(block, /expectedDeletionIndexes/);
  assert.match(block, /frame-%02d[.]jpg/);
  assert.doesNotMatch(block, /grep -Fq "\\"backupReference/);
});

test("privileged command diagnostics use private workspaces, not fixed root logs", () => {
  assert.match(probe, /^umask 077$/m);
  for (const prefix of [
    "oscar-regression-archive-verify", "oscar-regression-activation-",
    "oscar-regression-backup-check", "oscar-regression-restore-",
  ]) assert.ok(probe.includes(`mktemp -d \"/tmp/${prefix}`) || probe.includes(`mktemp -d /tmp/${prefix}`));
  for (const fixed of [
    "/tmp/oscar-regression-archive-verify.log",
    "/tmp/oscar-regression-activation-holder-",
    "/tmp/oscar-regression-backup-verify.log",
    "/tmp/oscar-regression-restore-backup-verify.log",
    "/tmp/oscar-regression-restore.log",
    "/tmp/oscar-regression-restore-archive-verify.log",
  ]) assert.ok(!probe.includes(fixed), `fixed privileged log remains: ${fixed}`);
  assert.match(probe, /emit_command_diagnostics/);
});

test("restore drill is a separate exact-confirmation action with multi-plane canaries", () => {
  const block = probe.slice(probe.indexOf("  restore-drill)"), probe.indexOf("  fixture-cleanup)"));
  assert.match(block, /\$run:DESTRUCTIVE-RESTORE/);
  assert.match(block, /oscar\.sh restore --backup "\$backup" --confirm "\$backup"/);
  assert.match(block, /canonical_directory/);
  assert.match(block, /expected_archive/);
  assert.match(block, /paths_overlap/);
  assert.match(block, /test ! -e "\/var\/lib\/oscar\/\$1" && test ! -L/);
  assert.match(block, /restored_generation_bytes == \$\(\(restored_generation_count \* 37\)\)/);
  assert.match(block, /archive_generation_count=\$restored_generation_count/);
  assert.match(block, /archive_generation_inventory_sha256='\$restored_generation_sha'/);
  assert.match(block, /archive_generation_inventory_bytes=\$restored_generation_bytes/);
  for (const field of [
    "databaseRestored",
    "applicationStateRestored",
    "archiveRestored",
    "walRestored",
    "credentialsRestored",
    "servicesHealthy",
    "archiveVerified",
    "freshTimeline",
    "timelineHistoryArchived",
    "newTimelineWalArchived",
    "priorWalPreserved",
    "postBackupWalPreserved",
    "archiverFailureFree",
    "recoverySettingsCleared",
    "verifiedEpochRestored",
  ]) assert.ok(block.includes(field), `missing restore canary: ${field}`);
  assert.match(block, /SELECT pg_walfile_name\(pg_switch_wal\(\)\)/);
  assert.match(block, /SELECT timeline_id FROM pg_control_checkpoint\(\)/);
  assert.match(block, /restored_timeline -gt \$source_timeline/);
  assert.match(block, /future_segment_sha/);
  assert.doesNotMatch(block, /wal_canary/);
  assert.match(block, /state='VERIFIED'/);
  assert.match(block, /archive_canary_profile="restore_\$run"/);
  assert.match(block,
    /archive_canary="\$archive_canary_parent\/profile=\$archive_canary_profile"/);
  assert.match(block, /ensure_restore_archive_canary_hierarchy 10001 10001/);
  for (const component of [
    '"$archive_dir/datasets"',
    '"$archive_dir/datasets/observations"',
    '"$archive_canary_parent"',
    '"$archive_canary"',
  ]) assert.ok(block.includes(component), `missing canonical archive-canary component: ${component}`);
  assert.doesNotMatch(block, /install -d -o 10001 -g 10001 -m 0750 -- "\$archive_canary"/,
    "one-shot install must not leave intermediate archive-canary parents owned by root");
  assert.match(block, /rmdir -- "\$archive_canary" \|\| fail/);
  assert.match(block, /archive_restored=false; \[\[ -d \$archive_canary && ! -L \$archive_canary \]\]/);
  assert.doesNotMatch(block, /archive_dir\/[.]restore-regression-/,
    "archive restore canaries must stay inside the production-approved datasets layout");
  assert.match(block,
    /secret_canary="\$release_dir\/secrets\/oscar-admin-password[.]txt"/);
  assert.match(block, /tls_canary="\$release_dir\/tls\/server[.]crt"/);
  assert.doesNotMatch(block, /secrets\/[.]restore-regression-/,
    "restore must not add a file outside the production deployment-secrets allowlist");
  assert.doesNotMatch(block, /tls\/[.]restore-regression-/,
    "restore must not add a file outside the production deployment-secrets allowlist");
  for (const required of [
    'secret_original=$restore_work/oscar-admin-password.original',
    'tls_original=$restore_work/server.crt.original',
    'cp --preserve=mode,ownership,timestamps -- "$secret_canary" "$secret_original"',
    'cp --preserve=mode,ownership,timestamps -- "$tls_canary" "$tls_original"',
    'cmp -s -- "$secret_original" "$secret_canary"',
    'cmp -s -- "$tls_original" "$tls_canary"',
    '$(stat -c \'%u:%g:%a\' -- "$secret_canary") == "$secret_original_metadata"',
    '$(stat -c \'%u:%g:%a\' -- "$tls_canary") == "$tls_original_metadata"',
    '$(cat -- "$safety/secrets/oscar-admin-password.txt") == "$mutated"',
    '$(cat -- "$safety/tls/server.crt") == "$mutated"',
    'secret_restore_stage="$release_dir/.oscar-regression-restore-stage-$run-admin-password"',
    'tls_restore_stage="$release_dir/.oscar-regression-restore-stage-$run-server-cert"',
    '-name \'.oscar-regression-restore-stage-*\' -print -quit',
    'A stale root-level restore staging entry exists',
    'install -o 0 -g 0 -m 0600 -- "$source" "$temporary"',
    'mv -fT -- "$temporary" "$target"',
    'credential_files_replaced=true',
    'if $credential_files_replaced; then',
    'compose up --detach --force-recreate --no-deps --no-build --pull never',
    '--wait --wait-timeout 240 oscar gateway',
    'credential-recovery-force-recreate.log',
    'elif ! oscar_services_healthy; then',
    'sudo bash oscar.sh restart >"$credential_restart_log" 2>&1',
    'oscar_services_healthy || credential_recovery_failed=true',
    '"$restore_work/credential-recovery-restart.log"',
    'failure_bundle="/var/tmp/oscar-regression-restore-failure-$run"',
    'mkdir -m 0700 -- "$failure_bundle"',
    'Restore-drill failure diagnostics retained at %s',
    'Restore-drill credential recovery failed; private originals retained at %s',
    'SELECT count(*) FROM oscar_regression_fixture WHERE run_id=\'$run\';',
    'test ! -e "/var/lib/oscar/$1" && test ! -L "/var/lib/oscar/$1"',
    '[[ ! -e $archive_canary && ! -L $archive_canary ]] || cleanup_failed=true',
    '[[ $marker_status == 1 ]] || cleanup_failed=true',
    '[[ -e $restore_work || -L $restore_work ]]',
    'restore_drill_verified=false',
    'elif ((original_status != 0)) || ! $restore_drill_verified || $cleanup_failed; then',
  ]) assert.ok(block.includes(required), `missing allowlist-safe credential proof: ${required}`);
  assert.doesNotMatch(block, /temporary="\$target/,
    "credential recovery staging must not live inside secrets or tls");
  assert.match(block,
    /if \[\[ -f \$target && ! -L \$target \]\] &&[\s\S]*cmp -s -- "\$source" "\$target"[\s\S]*return 0/,
    "already exact credentials must avoid host replacement and unnecessary restart");
  const cleanupTrap = block.indexOf("trap cleanup_restore_drill EXIT");
  const firstPrivateCopy = block.indexOf(
    'cp --preserve=mode,ownership,timestamps -- "$secret_canary" "$secret_original"',
  );
  const firstPrivateHash = block.indexOf('secret_original_sha=$(sha256_file "$secret_original")');
  assert.ok(cleanupTrap > 0 && cleanupTrap < firstPrivateCopy && cleanupTrap < firstPrivateHash,
    "EXIT recovery must be installed before private credential snapshots and hashes");
  const removePrivateOriginals = block.indexOf('rm -f -- "$secret_original" "$tls_original"');
  const preserveDiagnostics = block.indexOf("preserve_restore_diagnostics");
  assert.ok(removePrivateOriginals > 0 && preserveDiagnostics > 0 &&
    removePrivateOriginals < block.lastIndexOf("preserve_restore_diagnostics"),
  "private originals must be removed before failure diagnostics are published");
  const restoreCredential = block.indexOf(
    'restore_private_original "$secret_original" "$secret_canary" "$secret_restore_stage"',
  );
  const supportedRecovery = block.indexOf(
    "compose up --detach --force-recreate --no-deps --no-build --pull never", restoreCredential,
  );
  const fixtureDelete = block.indexOf(
    'DELETE FROM oscar_regression_fixture WHERE run_id=\'$run\';', supportedRecovery,
  );
  assert.ok(restoreCredential > 0 && supportedRecovery > restoreCredential && fixtureDelete > supportedRecovery,
    "credential recovery and force recreation must precede database/application canary cleanup");
  const verifiedAssignment = block.indexOf("restore_drill_verified=$all_restored");
  const resultJson = block.indexOf('printf \'{"backupId"', verifiedAssignment);
  const explicitCleanup = block.lastIndexOf("cleanup_restore_drill");
  assert.ok(verifiedAssignment > 0 && resultJson > verifiedAssignment && explicitCleanup > resultJson,
    "restore acceptance must bind all_restored before JSON and explicit cleanup");
  const backupCreated = block.indexOf("backup_output=$(sudo bash oscar.sh backup)");
  const secretMutated = block.indexOf("printf '%s\\n' \"$mutated\" >\"$secret_canary\"");
  const tlsMutated = block.indexOf("printf '%s\\n' \"$mutated\" >\"$tls_canary\"");
  assert.ok(backupCreated > 0 && secretMutated > backupCreated && tlsMutated > backupCreated,
    "approved credential files may be mutated only after the backup captures their originals");
  const archiveCanaryRelative =
    "datasets/observations/date=2026-10-18/profile=restore_2026_10_18t17_43_32_227z_nimo_mme3l";
  assert.match(archiveCanaryRelative,
    /^datasets\/observations\/date=[0-9]{4}-[0-9]{2}-[0-9]{2}\/profile=[A-Za-z0-9_-]+$/u);
});

test("restore archive canary creates every hierarchy component with removable app ownership", () => {
  const helper = probe.match(/^ensure_restore_archive_canary_hierarchy\(\) \{\n[\s\S]*?^\}/mu)?.[0];
  assert.ok(helper, "missing restore archive-canary hierarchy helper");
  assert.match(helper, /install -d -o "\$expected_uid" -g "\$expected_gid" -m 0750 -- "\$component"/);
  assert.match(helper, /stat -c '%u:%g' -- "\$component"/);
  assert.match(helper, /\(8#\$component_mode & 0700\) == 0700/);
  if (process.platform !== "linux") return;
  const support = `fail() { printf 'ERROR: %s\\n' "$*" >&2; exit 1; }\n${helper}`;
  execFileSync("bash", ["-c", `set -Eeuo pipefail
${support}
root=$(mktemp -d)
trap 'rm -rf -- "$root"' EXIT
uid=$(id -u); gid=$(id -g)
components=("$root/datasets" "$root/datasets/observations" \
  "$root/datasets/observations/date=2026-10-18" \
  "$root/datasets/observations/date=2026-10-18/profile=restore_test")
ensure_restore_archive_canary_hierarchy "$uid" "$gid" "\${components[@]}"
for component in "\${components[@]}"; do
  test -d "$component" && test ! -L "$component"
  test "$(stat -c '%u:%g' -- "$component")" = "$uid:$gid"
  mode=$(stat -c %a -- "$component")
  (( (8#$mode & 0700) == 0700 ))
done`], {stdio: ["ignore", "pipe", "pipe"]});

  assert.throws(() => execFileSync("bash", ["-c", `set -Eeuo pipefail
${support}
root=$(mktemp -d)
trap 'rm -rf -- "$root"' EXIT
mkdir "$root/datasets"
chmod 0500 "$root/datasets"
ensure_restore_archive_canary_hierarchy "$(id -u)" "$(id -g)" \
  "$root/datasets" "$root/datasets/observations"`], {stdio: ["ignore", "pipe", "pipe"]}));
});

test("lifecycle uses the scoped 3.9.2 archive administration interface", () => {
  const exportBlock = probe.slice(probe.indexOf("  export-check)"), probe.indexOf("  fixture-controls)"));
  const hotBlock = probe.slice(probe.indexOf("  fixture-hot-hold-create)"), probe.indexOf("  fixture-controls)"));
  const controlBlock = probe.slice(probe.indexOf("  fixture-controls)"), probe.indexOf("  backup-check)"));
  assert.match(exportBlock, /archive export --store-key "\$store_key" --id-scope "\$id_scope"/);
  for (const operation of ["hold create", "dry-run", "purge"]) {
    assert.ok(
      controlBlock.includes(`archive ${operation} --store-key "$store_key" --id-scope "$id_scope"`),
      `missing scoped archive operation: ${operation}`,
    );
  }
  assert.match(controlBlock, /--generation "\$generation"/);
  assert.match(controlBlock, /--observation "\$cold_id"/);
  assert.ok(controlBlock.includes("generationHoldCreated"));
  assert.ok(controlBlock.includes("observationHoldCreated"));
  assert.ok(controlBlock.includes("generationHoldEnforced"));
  assert.ok(controlBlock.includes("coldObservationHoldEnforced"));
  assert.match(controlBlock, /hold_count FROM oscar_deletion_plan/);
  assert.match(controlBlock, /count\(\*\) FROM oscar_deletion_plan_item/);
  assert.match(controlBlock, /retention_hold_id_from_output "\$hold_output" "\$store_key" "\$id_scope" GENERATION_EXACT/);
  assert.match(controlBlock, /retention_hold_id_from_output "\$observation_hold_output" "\$store_key" "\$id_scope" COLD_RANGE_CONSERVATIVE/);
  assert.match(controlBlock, /resolution_mode='GENERATION_EXACT'/);
  assert.match(controlBlock, /resolution_mode='COLD_RANGE_CONSERVATIVE'/);
  assert.match(controlBlock, /created_by='oscar-regression'/);
  assert.match(controlBlock, /reason='regression-\$run'/);
  assert.match(controlBlock, /reason='regression-observation-\$run'/);
  for (const required of [
    "fixture-hot-hold-create)", "fixture-hot-hold-release)", "HOT_EXACT",
    "regression-hot-$run", "hotId", "listed", "released",
  ]) assert.ok(hotBlock.includes(required), `missing exact hot-hold contract: ${required}`);
  assert.match(hotBlock, /retention_hold_id_from_output "\$hot_output" "\$store_key" "\$id_scope" HOT_EXACT/);
});

test("disposable lifecycle proves exact-row activation and deployed helper behavior", () => {
  const allocator = probe.slice(probe.indexOf("create_observation_fixture()"), probe.indexOf("\n\ncase $action"));
  for (const required of [
    "INSERT INTO oscar_regression_fixture_allocator(singleton,leased_high_water)",
    "ON CONFLICT (singleton) DO UPDATE",
    "oscar_regression_fixture_allocator.leased_high_water",
    "EXCLUDED.leased_high_water-1099511627778",
    "max(id) FROM obs",
    "max(max_id) FROM oscar_archive_generation",
    "RETURNING leased_high_water cold_id,leased_high_water-1 hot_id",
    "9223370937343148029",
    "INSERT INTO obs(id,datastreamid",
    "cold_id::text",
    "hot_id::text",
    "oscar_archive_id_block",
    "oscar_obs_overlay",
  ]) assert.ok(allocator.includes(required), `missing collision-safe fixture allocation contract: ${required}`);
  const allocatorTable = probe.slice(probe.indexOf("ensure_fixture_table()"), probe.indexOf("create_observation_fixture()"));
  assert.match(allocatorTable, /oscar_regression_fixture_allocator/);
  assert.match(allocatorTable, /singleton boolean PRIMARY KEY/);
  assert.doesNotMatch(allocator, /pg_advisory_xact_lock/);
  assert.match(allocator, /WHERE id IN \(a\.cold_id,a\.hot_id\)/);
  assert.match(allocator, /FROM cold,hot RETURNING \*/);

  const create = probe.slice(probe.indexOf("  fixture-create)"), probe.indexOf("  fixture-create-race)"));
  const race = probe.slice(probe.indexOf("  fixture-create-race)"), probe.indexOf("  fixture-status)"));
  assert.match(create, /create_observation_fixture "\$run"/);
  assert.match(race, /create_observation_fixture "\$run"/);
  assert.match(race, /sampled_at-interval '2 minutes'/);
  assert.match(race, /sampled_at-interval '1 minute'/);
  assert.match(race, /BEFORE UPDATE OF archivegenerationid/);
  assert.match(race, /pg_advisory_xact_lock/);
  assert.match(race, /pg_temp\.oscar_archive_activation_row WHERE observation_id=\$cold_id/);
  assert.match(race, /resulttime=resulttime\+interval '1 microsecond'/);
  assert.match(race, /j\.state='FAILED'/);
  assert.match(race, /staleActivationRejected/);

  const status = probe.slice(probe.indexOf("  fixture-status)"), probe.indexOf("  fixture-accelerate)"));
  assert.match(status, /g\.row_count=1 AND g\.min_id=f\.cold_id AND g\.max_id=f\.cold_id/);
  assert.match(status, /o\.archivegenerationid=g\.id/);
  assert.match(status, /exactRowOwnership/);

  const cleanupStart = probe.indexOf("  fixture-cleanup)");
  const cleanup = probe.slice(cleanupStart, probe.indexOf("  *) fail", cleanupStart));
  assert.match(cleanup, /DELETE FROM oscar_regression_fixture WHERE run_id='\$run' RETURNING cold_id,hot_id/);
  assert.match(cleanup, /DELETE FROM obs o USING f WHERE o\.id IN \(f\.cold_id,f\.hot_id\)/);
  assert.doesNotMatch(cleanup, /DELETE FROM obs(?:\s+WHERE|;)/);

  const archiveHelper = probe.slice(probe.indexOf("  archive-helper-check)"), probe.indexOf("  wal-helper-check)"));
  assert.match(archiveHelper, /oscar-archive-object verify/);
  assert.match(archiveHelper, /oscar-archive-object copy/);
  assert.match(archiveHelper, /mismatchRejected/);
  assert.match(archiveHelper, /traversalRejected/);

  const walHelper = probe.slice(probe.indexOf("  wal-helper-check)"), probe.indexOf("  fixture-controls)"));
  assert.match(walHelper, /oscar-archive-wal/);
  assert.match(walHelper, /idempotentRetry/);
  assert.match(walHelper, /mismatchRejected/);
  assert.match(walHelper, /partialArtifacts/);
  assert.match(walHelper, /fixtureRemoved/);
});

test("retained-media scenario browser-decodes every assessed frame", () => {
  const start = scenarios.indexOf("action: \"verify exact-five retained JPEG API\"");
  const end = scenarios.indexOf("await this.verifyRetainedMediaGallery(", start);
  const originStart = scenarios.lastIndexOf("const page = await this.browser.oscarPage()", start);
  const block = scenarios.slice(originStart, end);
  assert.ok(originStart > 0 && start > originStart && end > start);
  assert.match(block, /await this\.goto\(page, "\/"\)/);
  assert.doesNotMatch(block, /await this\.goto\(page, "\/dashboard"\)/);
  assert.match(block, /for \(const asset of assessed\.assets\)/);
  assert.match(block, /page\.evaluate\(boundedFetch/);
  assert.match(block, /maxBytes: Math\.min\(asset\.bytes, MAX_RETAINED_FRAME_BYTES\)/);
  assert.match(block, /image\.decodedWidth === asset\.width && image\.decodedHeight === asset\.height/);
  assert.doesNotMatch(block, /response\.body\(\)|response\.json\(\)|image\.body\(\)/);
  assert.match(block, /assessed\.jpegQualities\.every\(quality => quality === 85\)/);
});

test("storage lifecycle refuses mutation when exact release/profile preflight fails", () => {
  const start = scenarios.indexOf("private async storageLifecycle");
  const fixtureCreate = scenarios.indexOf('"fixture-create-race"', start);
  const refusal = scenarios.indexOf("Storage lifecycle mutation refused", start);
  assert.ok(start > 0 && refusal > start && fixtureCreate > refusal);
  const block = scenarios.slice(start, fixtureCreate);
  assert.match(block, /if \(!profileAccepted\)/);
  assert.match(block, /media\.enabled === REGRESSION_MEDIA_RETENTION\.enabled/);
  assert.match(block, /media\.timeToRetentionDays === REGRESSION_MEDIA_RETENTION\.timeToRetentionDays/);
  assert.match(block, /media\.queryPeriodMinutes === REGRESSION_MEDIA_RETENTION\.queryPeriodMinutes/);
  assert.match(block, /media\.frameCount === REGRESSION_MEDIA_RETENTION\.frameCount/);
  assert.match(block, /media\.jpegQuality === REGRESSION_MEDIA_RETENTION\.jpegQuality/);
  assert.match(block, /media\.sourceRollbackGraceHours === REGRESSION_MEDIA_RETENTION\.sourceRollbackGraceHours/);
  assert.ok(block.indexOf("verifyGeneratedAlarmRetention") > block.indexOf("if (!profileAccepted)"));
});

test("lifecycle-only required storage refuses zero-media certification before lane mutation", () => {
  const start = scenarios.indexOf("private async storageLifecycle");
  const end = scenarios.indexOf("private async storageRestoreDrill", start);
  const block = scenarios.slice(start, end);
  const refusal = block.indexOf(
    "Storage lifecycle mutation refused without generated or explicitly configured retained-media proof",
  );
  const journalMutation = block.indexOf("prove direct journal append");
  assert.ok(refusal > 0 && journalMutation > refusal);
  assert.match(block, /this\.generatedAlarmMedia\.size === 0 && this\.retainedBackupExpectations\.size === 0/);
  assert.match(block, /proveConfiguredRetainedMediaEvent/);
  assert.match(block, /no exact retained-media set completed certification/);
});

test("storage lifecycle cleans an attempted fixture even when create acknowledgement is lost", () => {
  const start = scenarios.indexOf("private async storageLifecycle");
  const end = scenarios.indexOf("private async storageRestoreDrill", start);
  const block = scenarios.slice(start, end);
  const attempted = block.indexOf("fixtureCreateAttempted = true");
  const create = block.indexOf('probe.runJson<{coldId: string; hotId: string', attempted);
  const cleanup = block.indexOf('if (fixtureCreateAttempted) await probe.runJson("fixture-cleanup"', create);
  assert.ok(attempted > 0 && create > attempted && cleanup > create);
  assert.doesNotMatch(block, /fixtureCreated/);
});

test("storage lifecycle proves direct journal durability, hold enforcement, scratch cleanup, and metadata backup", () => {
  const start = scenarios.indexOf("private async storageLifecycle");
  const end = scenarios.indexOf("private async storageRestoreDrill", start);
  const block = scenarios.slice(start, end);
  for (const required of [
    "OSCAR_STORAGE_SCHEMA_CHECKSUM", "journal-lane-state", "prove direct journal append",
    "status.tamper_fault", "reserved lane journal bytes to advance", "verify compact media metadata",
    "mediaMetadataHealthIsSafe", "fixture-hot-hold-create", "HOT_EXACT",
    ".delete(", "fixture-hot-hold-release", "GENERATION_EXACT", "COLD_RANGE_CONSERVATIVE",
    "generationHoldEnforced", "coldObservationHoldEnforced", "archive-scratch-health",
    "verify clean DuckDB scratch before fixture mutation", "scratchAccepted",
    "archiveScratchIsSafe(value, true)", "duckDbScratchExcluded",
    "mediaMetadataCheckpointIncluded", "processedObservationIndexesIncluded",
    "deletionIndexesIncluded",
    "retainedMediaExpectedSets", "retainedMediaExpectedMembers",
    "retainedMediaExactMembersVerified", "expectedProcessedIndexes", "expectedDeletionIndexes",
  ]) assert.ok(block.includes(required), `missing 3.9.2 storage lifecycle assertion: ${required}`);
  const holdCreate = block.indexOf('"fixture-hot-hold-create"');
  const heldDelete = block.indexOf("request.delete(", holdCreate);
  const holdRelease = block.indexOf('"fixture-hot-hold-release"', heldDelete);
  const releasedDelete = block.indexOf("request.delete(", holdRelease);
  assert.ok(holdCreate > 0 && heldDelete > holdCreate && holdRelease > heldDelete && releasedDelete > holdRelease);
  assert.match(block, /lane\.bytes >= directJournalAfterAppend!\.bytes/);
});

test("restore drill re-runs release identity and scopes metrics disruption to the supported restore", () => {
  const start = scenarios.indexOf("private async storageRestoreDrill");
  const end = scenarios.indexOf("private async extendedOccupancy", start);
  const block = scenarios.slice(start, end);
  assert.equal(block.match(/storagePlatformHasExactReleaseIdentity/g)?.length, 2);
  assert.match(block, /const before = assessStoragePlatform/);
  assert.match(block, /const after = assessStoragePlatform/);
  assert.match(block, /expectRemoteMetricDisruptionPhase\(restoreDisruptionPhase\)/);
  const disruption = block.indexOf('this.metrics.setPhase(restoreDisruptionPhase)');
  const restore = block.indexOf('"restore-drill"', disruption);
  const steady = block.indexOf('this.metrics.setPhase("storage-restore-drill-post")', restore);
  assert.ok(disruption > 0 && restore > disruption && steady > restore);
});

test("retained-media gallery measures concurrency and proves selected content loaded", () => {
  const start = scenarios.indexOf("private async verifyRetainedMediaGallery");
  const end = scenarios.indexOf("private async storageHealth", start);
  const block = scenarios.slice(start, end);
  assert.match(block, /peakInFlightFrameRequests <= 3/);
  assert.match(block, /initialRequests === cameras/);
  assert.match(block, /selectedFrameRequested && selectedFrameLoaded/);
  assert.match(block, /image\.naturalWidth > 0/);
  assert.match(block, /source !== initialSource/);
});

test("full retained-media proof self-seeds without weakening smoke fixture requirements", () => {
  const policyStart = scenarios.indexOf("private fullRunCanSelfSeedRetainedMedia");
  const policyEnd = scenarios.indexOf("private async check", policyStart);
  const policy = scenarios.slice(policyStart, policyEnd);
  assert.match(policy, /\["full", "3\.9\.2-release"\]\.includes\(this\.config\.profile\)/);
  assert.match(policy, /this\.selected\("storage-lifecycle"\)/);
  for (const producer of ["rpm-alarms", "event-uuid", "adjudication"]) {
    assert.ok(policy.includes(`"${producer}"`), `missing retained-media producer ${producer}`);
  }

  const healthStart = scenarios.indexOf("private async storageHealth");
  const lifecycleStart = scenarios.indexOf("private async storageLifecycle", healthStart);
  const health = scenarios.slice(healthStart, lifecycleStart);
  assert.match(health, /if \(this\.fullRunCanSelfSeedRetainedMedia\(\)\)/);
  assert.match(health, /this\.retainedMediaProofDeferred = true/);
  assert.match(health, /full profile will self-seed an exact alarm UUID/);
  assert.match(health, /STORAGE_RETAINED_EVENT_ID is missing and this run cannot self-seed/);

  const generatedStart = scenarios.indexOf("private async verifyGeneratedAlarmRetention");
  const generatedEnd = scenarios.indexOf("private storageUnavailable", generatedStart);
  const generated = scenarios.slice(generatedStart, generatedEnd);
  assert.match(generated, /"self-seed retained-media proof"/);
  assert.match(generated, /generated events=\$\{this\.generatedAlarmMedia\.size\}/);
  assert.match(generated, /const galleryEventId = generated\[0\]!\.association\.eventId/);
  assert.match(generated, /"render self-seeded retained-media gallery"/);
  assert.match(generated, /await this\.verifyRetainedMediaGallery\(/);
});
