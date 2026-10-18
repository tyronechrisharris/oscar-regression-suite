import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {readFileSync} from "node:fs";
import {resolve} from "node:path";
import test from "node:test";

const probePath = resolve("scripts/oscar-storage-regression-probe.sh");
const probe = readFileSync(probePath, "utf8");
const scenarios = readFileSync(resolve("src/scenarios.ts"), "utf8");

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

function runHoldOutputParser(output: string, storeKey = "obs", idScope = "4"): string {
  const validUuid = probe.match(/^valid_uuid\(\) \{[^\n]+\}$/mu)?.[0];
  const parser = probe.match(/^retention_hold_id_from_output\(\) \{\n[\s\S]*?^\}/mu)?.[0];
  assert.ok(validUuid && parser, "missing retention-hold output parser");
  return execFileSync("bash", ["-c", `set -Eeuo pipefail
${validUuid}
${parser}
retention_hold_id_from_output "$1" "$2" "$3"`, "hold-parser", output, storeKey, idScope], {
    encoding: "utf8",
  });
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
  const canonical = `Retention hold created: ${id} (store=obs, id-scope=4)`;
  assert.equal(runHoldOutputParser(`administrative preface\n${canonical}\n`), id);
  assert.throws(() => runHoldOutputParser(canonical, "other_store", "4"));
  assert.throws(() => runHoldOutputParser(canonical, "obs", "5"));
  assert.throws(() => runHoldOutputParser(`Retention hold created: ${id}`));
  assert.throws(() => runHoldOutputParser(`${canonical}\n${canonical}`));
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
    "assessAlarmVideoObservation",
    "loadedmetadata",
    "alarm-media-source-status",
    "/sensorhub/buckets/videos/media/",
    "assessRetainedMediaResponse",
    "sourceByCamera.get(mediaSet.cameraUid) !== mediaSet.sourceObjectKey",
    "alarm-media-ledger",
    'ledger.attempts === 1',
    'ledger.failure === ""',
    "alarm-media-forensics",
    "alarmMediaForensicsPassed",
  ]) assert.ok(block.includes(required), `missing generated alarm-media assertion: ${required}`);
  assert.match(block, /Buffer\.from\(item\.association\.eventId, "utf8"\)\.toString\("base64url"\)/);
  assert.match(block, /generated\.flatMap\(item =>[\s\S]*item\.association\.paths/);
  assert.match(block, /"alarm-media-baseline", \[this\.alarmMediaRunKey\(\)\]\)/);
  assert.doesNotMatch(block, /baselineCreated:[\s\S]{0,120}cameras:/);
  assert.doesNotMatch(block, /originalRpmConfig\?\.camera_ids/);
});

test("storage probe client registers privileged alarm baseline cleanup before an uncertain remote outcome", () => {
  const client = readFileSync(resolve("src/storage-probe.ts"), "utf8");
  const register = client.indexOf(
    'if (action === "alarm-media-baseline" && alarmRun) this.alarmBaselineRuns.add(alarmRun)',
  );
  const remote = client.indexOf('const {stdout} = await execFileAsync("ssh"');
  assert.ok(register > 0 && remote > register);
  const cleanup = client.slice(client.indexOf("async cleanup(): Promise<void>"));
  assert.match(cleanup, /for \(const run of this\.alarmBaselineRuns\)/);
  assert.match(cleanup, /"sudo", "-n", "bash", this\.remoteScript/);
  assert.match(cleanup, /"alarm-media-cleanup", run/);
  assert.match(cleanup, /baselineCleanupError \?\?= error/);
  assert.match(cleanup, /Unable to remove a privileged alarm-media baseline marker/);
  assert.match(cleanup, /rm -f -- \$\{shellQuote\(this\.remoteScript\)\}/);
  assert.doesNotMatch(cleanup, /rm -f -- \/tmp\/oscar-alarm-media/);
  assert.match(cleanup, /this\.alarmBaselineRuns\.clear\(\)/);
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

test("platform config probes remain pipefail-safe for a large persisted configuration", () => {
  const block = probe.slice(probe.indexOf("  platform)"), probe.indexOf("  snapshot)"));
  const helper = probe.match(/config_text_matches\(\) \{\n[\s\S]*?\n\}/)?.[0];
  assert.ok(helper, "missing config_text_matches helper");
  assert.match(helper, /grep -Eq -- "\$pattern" <<<"\$text"/);
  assert.equal(block.match(/config_text_matches "\$config_text"/g)?.length, 6);
  assert.doesNotMatch(block, /printf[^\n]*\$config_text[^\n]*\|[^\n]*grep/);
  for (const field of [
    "timeToRetention", "videoQueryPeriod", "enableFrameRetention", "frameRetentionCount", "jpegQuality",
  ]) assert.ok(block.includes(field), `missing retained-media preflight field: ${field}`);

  const largeConfig = [
    '"OscarTieredObsSystemDatabase": {},',
    '"DailyFileJournalService": {},',
    '"deleteHotAfterArchive": true,',
    '"reWriteBatchedInserts": true,',
    `"padding":"${"x".repeat(1024 * 1024)}"`,
  ].join("\n");
  const legacyPipeline = `set -o pipefail
config_text=$(cat)
printf '%s' "$config_text" | grep -q DailyFileJournalService`;
  assert.throws(
    () => execFileSync("bash", ["-c", legacyPipeline], {input: largeConfig, stdio: ["pipe", "pipe", "pipe"]}),
    "large-config fixture must reproduce the legacy SIGPIPE failure",
  );

  const safeProbe = `set -Eeuo pipefail
${helper}
config_text=$(cat)
config_text_matches "$config_text" 'OscarTieredObsSystemDatabase'
config_text_matches "$config_text" 'DailyFileJournalService'
config_text_matches "$config_text" '"deleteHotAfterArchive"[[:space:]]*:[[:space:]]*true'
config_text_matches "$config_text" 'reWriteBatchedInserts[^A-Za-z]*(true|"true")'
! config_text_matches "$config_text" '"deleteHotAfterArchive"[[:space:]]*:[[:space:]]*false'`;
  assert.doesNotThrow(() => execFileSync("bash", ["-c", safeProbe], {
    input: largeConfig,
    stdio: ["pipe", "pipe", "pipe"],
  }));
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

test("journal status extracts SHA-256 without exposing nested positional parameters", () => {
  const block = probe.slice(probe.indexOf("  journal-status)"), probe.indexOf("  journal-restart)"));
  const digestFragment = block.match(/digest_line=\$\(sha256sum "\$csv"\)\n\s*actual_sha=\$\{digest_line%% \*\}/)?.[0];
  assert.ok(digestFragment, "missing nesting-safe journal digest extraction");
  assert.doesNotMatch(block, /awk[^\n]*\\\\\$1/);
  const actual = execFileSync("sh", ["-eu", "-c", `csv=$1
${digestFragment}
printf '%s' "$actual_sha"`, "journal-digest", resolve("package.json")], {encoding: "utf8"});
  const expected = execFileSync("sha256sum", [resolve("package.json")], {encoding: "utf8"}).split(/\s+/u)[0];
  assert.equal(actual, expected);
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
  ]) assert.ok(block.includes(required), `missing backup contract: ${required}`);
  assert.match(block, /-f \$root\/\$required && ! -L \$root\/\$required/);
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
  assert.match(block, /sort -c -u "\$root\/archive-generation-ids\.txt"/);
  assert.match(block, /array_to_string\(archive_generation_ids,','\)/);
  assert.match(block, /catalog_generation_ids == "\$inventory_generation_ids"/);
  assert.doesNotMatch(block, /grep -Fq "\\"backupReference/);
});

test("restore drill is a separate exact-confirmation action with multi-plane canaries", () => {
  const block = probe.slice(probe.indexOf("  restore-drill)"), probe.indexOf("  fixture-cleanup)"));
  assert.match(block, /\$run:DESTRUCTIVE-RESTORE/);
  assert.match(block, /oscar\.sh restore --backup "\$backup" --confirm "\$backup"/);
  assert.match(block, /canonical_directory/);
  assert.match(block, /expected_archive/);
  assert.match(block, /paths_overlap/);
  assert.match(block, /test ! -e "\/var\/lib\/oscar\/\$1" && test ! -L/);
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
});

test("lifecycle uses the scoped 3.9.2 archive administration interface", () => {
  const exportBlock = probe.slice(probe.indexOf("  export-check)"), probe.indexOf("  fixture-controls)"));
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
  assert.match(controlBlock, /retention_hold_id_from_output "\$hold_output" "\$store_key" "\$id_scope"/);
  assert.match(controlBlock, /retention_hold_id_from_output "\$observation_hold_output" "\$store_key" "\$id_scope"/);
  assert.match(controlBlock, /created_by='oscar-regression'/);
  assert.match(controlBlock, /reason='regression-\$run'/);
  assert.match(controlBlock, /reason='regression-observation-\$run'/);
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
  const end = scenarios.indexOf("action: \"render retained-media gallery\"", start);
  const originStart = scenarios.lastIndexOf("const page = await this.browser.oscarPage()", start);
  const block = scenarios.slice(originStart, end);
  assert.ok(originStart > 0 && start > originStart && end > start);
  assert.match(block, /await this\.goto\(page, "\/"\)/);
  assert.doesNotMatch(block, /await this\.goto\(page, "\/dashboard"\)/);
  assert.match(block, /for \(const asset of assessment\.assets\)/);
  assert.match(block, /createImageBitmap\(blob\)/);
  assert.match(block, /bitmap\.width === width && bitmap\.height === height/);
  assert.match(block, /assessment\.jpegQualities\.every\(quality => quality === 85\)/);
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
  assert.ok(block.indexOf("verifyGeneratedAlarmRetention") > block.indexOf("if (!profileAccepted)"));
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

test("retained-media gallery measures concurrency and proves selected content loaded", () => {
  const start = scenarios.indexOf('action: "render retained-media gallery"');
  const end = scenarios.indexOf("const legacyId", start);
  const block = scenarios.slice(start, end);
  assert.match(block, /peakInFlightFrameRequests <= 3/);
  assert.match(block, /initialRequests === cameras/);
  assert.match(block, /selectedFrameRequested && selectedFrameLoaded/);
  assert.match(block, /image\.naturalWidth > 0/);
  assert.match(block, /source !== initialSource/);
});
