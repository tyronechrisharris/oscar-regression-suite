import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {readFileSync} from "node:fs";
import {resolve} from "node:path";
import test from "node:test";

const probePath = resolve("scripts/oscar-storage-regression-probe.sh");
const probe = readFileSync(probePath, "utf8");
const scenarios = readFileSync(resolve("src/scenarios.ts"), "utf8");

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
  assert.match(block, /archive_object_helper delete "\\\$relative" "\\\$expected_sha" rw/);
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
});

test("disposable lifecycle proves exact-row activation and deployed helper behavior", () => {
  const race = probe.slice(probe.indexOf("  fixture-create-race)"), probe.indexOf("  fixture-status)"));
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
  assert.match(block, /await this\.goto\(page, "\/dashboard"\)/);
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
  assert.match(scenarios.slice(start, fixtureCreate), /if \(!profileAccepted\)/);
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
