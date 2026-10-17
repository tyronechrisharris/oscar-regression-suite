#!/usr/bin/env bash
set -Eeuo pipefail

# Privileged target-side helper for the OSCAR 3.9.2 storage regression. It is copied to
# /tmp for one run and is never installed into the deployment. Mutating actions
# operate only on rows registered in oscar_regression_fixture and fail closed if
# a cold-deletion plan includes any other generation.

fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
[[ ${1:-} == --release-dir ]] || fail 'Expected --release-dir.'
release_dir=${2:-}; shift 2
[[ $release_dir == /* && $release_dir != *'/../'* && -f $release_dir/oscar.sh ]] ||
  fail 'Release directory is not a configured OSCAR release.'
action=${1:-}; (($#)) && shift
[[ ${EUID:-$(id -u)} -eq 0 ]] || fail 'Storage probe requires passwordless sudo.'
cd "$release_dir"

compose() { docker compose "$@"; }
psql_admin() {
  compose exec -T postgres sh -eu -c '
    PGPASSWORD=$(cat /run/secrets/postgres_bootstrap_password)
    PGOPTIONS=-csearch_path=oscar,public
    export PGPASSWORD PGOPTIONS
    exec psql --set=ON_ERROR_STOP=1 --username oscar_bootstrap --dbname gis "$@"
  ' psql-wrapper "$@"
}
scalar() { psql_admin --tuples-only --no-align --command "$1" | tr -d '[:space:]'; }
json_query() { psql_admin --tuples-only --no-align --command "$1" | tail -n 1; }
valid_run() { [[ $1 =~ ^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$ ]]; }
valid_uuid() { [[ $1 =~ ^[0-9a-fA-F-]{36}$ ]]; }
env_value() {
  local name=$1 fallback=$2 value
  value=$(awk -F= -v name="$name" '$1 == name { print substr($0, index($0, "=") + 1); exit }' .env)
  printf '%s' "${value:-$fallback}"
}
absolute_path() { case $1 in /*) printf '%s' "$1" ;; *) printf '%s/%s' "$release_dir" "${1#./}" ;; esac; }
directory_bytes() {
  [[ -d $1 ]] || { printf 0; return; }
  du -sb -- "$1" 2>/dev/null | awk '{print $1+0}'
}
ensure_fixture_table() {
  psql_admin --command "CREATE TABLE IF NOT EXISTS oscar_regression_fixture (
    run_id text PRIMARY KEY CHECK (run_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$'),
    cold_id bigint NOT NULL UNIQUE, hot_id bigint NOT NULL UNIQUE, datastream_id bigint NOT NULL,
    cold_time timestamptz NOT NULL, hot_time timestamptz NOT NULL,
    generation_id uuid, created_at timestamptz NOT NULL DEFAULT now()
  );" >/dev/null
}

case $action in
  platform)
    config=$(compose exec -T oscar sh -c 'find /var/lib/oscar -maxdepth 2 -type f -name "*.json" -print0 2>/dev/null | xargs -0 grep -l "OscarTieredObsSystemDatabase\|DailyFileJournalService" 2>/dev/null | head -n1' || true)
    config_text=''
    [[ -n $config ]] && config_text=$(compose exec -T oscar sh -c "cat -- '$config'" 2>/dev/null || true)
    interval=$(printf '%s' "$config_text" | sed -n 's/.*"intervalMinutes"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' | head -n1)
    grace=$(printf '%s' "$config_text" | sed -n 's/.*"rollbackGraceDays"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' | head -n1)
    delete_hot=null; printf '%s' "$config_text" | grep -Eq '"deleteHotAfterArchive"[[:space:]]*:[[:space:]]*true' && delete_hot=true || true
    printf '%s' "$config_text" | grep -Eq '"deleteHotAfterArchive"[[:space:]]*:[[:space:]]*false' && delete_hot=false || true
    schema=$(scalar "SELECT coalesce(max(version),0) FROM oscar_storage_schema_version;")
    checksums=$(scalar "SHOW data_checksums;")
    installed=$(scalar "SELECT EXISTS(SELECT 1 FROM pg_extension WHERE extname='pg_stat_statements');")
    preloaded=$(scalar "SELECT position('pg_stat_statements' in current_setting('shared_preload_libraries'))>0;")
    marker=$(compose exec -T postgres sh -c 'test -s /var/lib/postgresql/data/.oscar-data-checksum-init && echo t || echo f')
    batch=false
    # The 3.9.2 tiered database config sets reWriteBatchedInserts=true in code;
    # explicit serialized properties are also accepted for forward compatibility.
    printf '%s' "$config_text" | grep -Eq 'OscarTieredObsSystemDatabase|reWriteBatchedInserts[^A-Za-z]*(true|"true")' && batch=true || true
    journal=false
    printf '%s' "$config_text" | grep -q 'DailyFileJournalService' && journal=true || true
    printf '{"dataChecksums":"%s","pgStatStatementsInstalled":%s,"pgStatStatementsPreloaded":%s,"schemaVersion":%s,"archiveMarkerPresent":%s,"batchRewriteConfigured":%s,"dailyJournalConfigured":%s,"archiveIntervalMinutes":%s,"deleteHotAfterArchive":%s,"rollbackGraceDays":%s}\n' \
      "$checksums" "$([[ $installed == t ]] && echo true || echo false)" "$([[ $preloaded == t ]] && echo true || echo false)" "$schema" \
      "$([[ $marker == t ]] && echo true || echo false)" "$batch" "$journal" "${interval:-null}" "$delete_hot" "${grace:-null}"
    ;;

  snapshot)
    archive_dir=$(absolute_path "$(env_value OSCAR_ARCHIVE_DIR ./data/archive)")
    backup_dir=$(absolute_path "$(env_value OSCAR_BACKUP_DIR ./backups)")
    journal_bytes=$(compose exec -T oscar sh -c "du -sb /var/lib/oscar/files/.dailyfile-journal 2>/dev/null | awk '{print \\$1+0}'" || echo 0)
    daily_bytes=$(compose exec -T oscar sh -c "du -sb /var/lib/oscar/files/dailyfiles 2>/dev/null | awk '{print \\$1+0}'" || echo 0)
    media_bytes=$(compose exec -T oscar sh -c "du -sb /var/lib/oscar/files/videos/retained-media 2>/dev/null | awk '{print \\$1+0}'" || echo 0)
    archive_bytes=$(directory_bytes "$archive_dir"); backup_bytes=$(directory_bytes "$backup_dir")
    json_query "WITH db AS (
      SELECT pg_database_size(current_database()) database_size,
        coalesce(pg_total_relation_size('obs'::regclass),0) obs_total,
        coalesce(pg_relation_size('obs'::regclass),0) obs_heap),
    stats AS (SELECT temp_bytes,xact_commit,xact_rollback,tup_inserted,tup_updated,tup_deleted FROM pg_stat_database WHERE datname=current_database()),
    wal AS (SELECT wal_bytes::numeric wal_bytes FROM pg_stat_wal),
    statements AS (SELECT coalesce(sum(calls),0) calls,coalesce(sum(rows),0) rows FROM pg_stat_statements WHERE query ~* '^\\s*insert\\s+into\\s+(public\\.)?obs'),
    catalog AS (SELECT count(*) FILTER(WHERE state='ACTIVE') active,count(*) FILTER(WHERE state='SEALED') sealed,coalesce(sum(row_count),0) rows FROM oscar_archive_generation),
    jobs AS (SELECT count(*) FILTER(WHERE state='FAILED') failed FROM oscar_archive_job),
    parity AS (SELECT count(*) FILTER(WHERE status<>'PASSED') failed FROM oscar_archive_verification WHERE verification_type='PARITY'),
    holds AS (SELECT count(*) FILTER(WHERE released_at IS NULL) active FROM oscar_retention_hold),
    backups AS (SELECT count(*) FILTER(WHERE state='VERIFIED') verified FROM oscar_backup_epoch)
    SELECT json_build_object('databaseSizeBytes',db.database_size,'observationTableBytes',db.obs_heap,
      'observationIndexBytes',db.obs_total-db.obs_heap,'walBytes',wal.wal_bytes,'tempBytes',stats.temp_bytes,
      'tuplesInserted',stats.tup_inserted,'tuplesUpdated',stats.tup_updated,'tuplesDeleted',stats.tup_deleted,
      'transactionCommits',stats.xact_commit,'transactionRollbacks',stats.xact_rollback,
      'observationInsertCalls',statements.calls,'observationInsertRows',statements.rows,
      'observationRowsPerCall',CASE WHEN statements.calls=0 THEN NULL ELSE statements.rows/statements.calls END,
      'activeArchiveGenerations',catalog.active,'sealedArchiveGenerations',catalog.sealed,'archiveRows',catalog.rows,
      'archiveBytes',$archive_bytes,'failedArchiveJobs',jobs.failed,'failedParityReceipts',parity.failed,
      'activeHolds',holds.active,'verifiedBackups',backups.verified,'journalBytes',${journal_bytes:-0},
      'dailyFileBytes',${daily_bytes:-0},'retainedMediaBytes',${media_bytes:-0},'backupBytes',$backup_bytes)
    FROM db,stats,wal,statements,catalog,jobs,parity,holds,backups;"
    ;;

  archive-health)
    verify_passed=false
    sudo bash oscar.sh archive verify >/tmp/oscar-regression-archive-verify.log 2>&1 && verify_passed=true
    json_query "SELECT json_build_object(
      'activeGenerations',count(*) FILTER(WHERE g.state='ACTIVE'),
      'sealedGenerations',count(*) FILTER(WHERE g.state='SEALED'),
      'archiveRows',coalesce(sum(g.row_count),0),'archiveBytes',coalesce(sum(o.bytes) FILTER(WHERE o.state='ACTIVE'),0),
      'failedJobs',(SELECT count(*) FROM oscar_archive_job WHERE state='FAILED'),
      'parityFailures',(SELECT count(*) FROM oscar_archive_verification WHERE verification_type='PARITY' AND status<>'PASSED'),
      'activeHolds',(SELECT count(*) FROM oscar_retention_hold WHERE released_at IS NULL),
      'incompleteActiveObjects',count(*) FILTER(WHERE g.state IN ('ACTIVE','SEALED') AND (o.state IS NULL OR o.state<>'ACTIVE')),
      'checksumVerificationPassed',$verify_passed)
      FROM oscar_archive_generation g LEFT JOIN oscar_archive_object o ON o.generation_id=g.id;"
    ;;

  journal-status)
    compose exec -T oscar sh -eu -c '
      root=/var/lib/oscar/files; pubs="$root/dailyfiles"; journal="$root/.dailyfile-journal"
      partial=$(find "$pubs" "$journal" -type f \( -name "*.partial" -o -name "*.tmp" \) 2>/dev/null | wc -l)
      manifests=$(find "$pubs" -type f -name "*.manifest.v1.json" 2>/dev/null | wc -l)
      publications=$(find "$pubs" -type f -name "*.csv" 2>/dev/null | wc -l)
      open=$(find "$journal" -type f -name "*.open" 2>/dev/null | wc -l)
      segments=$(find "$journal" -type f -name "*.seg" 2>/dev/null | wc -l)
      validated=0; failures=0
      for manifest in $(find "$pubs" -type f -name "*.manifest.v1.json" 2>/dev/null); do
        csv=${manifest%.manifest.v1.json}
        expected_sha=$(sed -n "s/.*\"sha256\"[[:space:]]*:[[:space:]]*\"\([0-9a-f][0-9a-f]*\)\".*/\1/p" "$manifest" | head -n1)
        expected_bytes=$(sed -n "s/.*\"byteCount\"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p" "$manifest" | head -n1)
        expected_records=$(sed -n "s/.*\"recordCount\"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p" "$manifest" | head -n1)
        if [ -f "$csv" ]; then
          actual_sha=$(sha256sum "$csv" | awk "{print \\$1}")
          actual_bytes=$(wc -c <"$csv" | tr -d "[:space:]")
          actual_records=$(wc -l <"$csv" | tr -d "[:space:]")
        else actual_sha=missing; actual_bytes=-1; actual_records=-1; fi
        if [ -n "$expected_sha" ] && [ "$actual_sha" = "$expected_sha" ] &&
           [ "$actual_bytes" = "$expected_bytes" ] && [ "$actual_records" = "$expected_records" ]; then
          validated=$((validated+1))
        else failures=$((failures+1)); fi
      done
      printf "{\"publications\":%s,\"manifests\":%s,\"validatedManifests\":%s,\"manifestFailures\":%s,\"partialFiles\":%s,\"openSegments\":%s,\"sealedSegments\":%s}\n" "$publications" "$manifests" "$validated" "$failures" "$partial" "$open" "$segments"
    '
    ;;

  journal-restart)
    before=$(compose exec -T oscar sh -c 'find /var/lib/oscar/files/.dailyfile-journal -type f 2>/dev/null | wc -l')
    compose restart oscar >/dev/null
    deadline=$((SECONDS+180)); healthy=false
    while ((SECONDS < deadline)); do
      state=$(compose ps --format json oscar 2>/dev/null | grep -o '"Health":"[^"]*"' | head -n1 || true)
      [[ $state == *healthy* ]] && { healthy=true; break; }
      sleep 2
    done
    after=$(compose exec -T oscar sh -c 'find /var/lib/oscar/files/.dailyfile-journal -type f 2>/dev/null | wc -l')
    partial=$(compose exec -T oscar sh -c 'find /var/lib/oscar/files -type f \( -name "*.partial" -o -name "*.tmp" \) 2>/dev/null | wc -l')
    recovery_errors=$(compose logs --since 5m oscar 2>&1 | grep -Eic 'daily.?file.*(corrupt|recovery failed|checksum mismatch)' || true)
    printf '{"healthy":%s,"journalFilesBefore":%s,"journalFilesAfter":%s,"partialFiles":%s,"recoveryErrors":%s}\n' "$healthy" "${before:-0}" "${after:-0}" "${partial:-0}" "$recovery_errors"
    ;;

  fixture-create)
    run=${1:-}; retention=${2:-}; valid_run "$run" || fail 'Invalid run ID.'
    [[ $retention =~ ^[1-9][0-9]*$ ]] || fail 'Invalid retention days.'
    ensure_fixture_table
    [[ $(scalar "SELECT count(*) FROM oscar_regression_fixture WHERE run_id='$run';") == 0 ]] || fail 'Fixture already exists.'
    json_query "WITH source AS (
      SELECT o.* FROM obs o JOIN obs_datastreams d ON d.id=o.datastreamid
      WHERE d.data->>'outputName'='gammaCounts' ORDER BY o.id DESC LIMIT 1),
    cold AS (INSERT INTO obs(datastreamid,foiid,phenomenontime,resulttime,result)
      SELECT datastreamid,foiid,now()-make_interval(days=>$retention+2),now()-make_interval(days=>$retention+2),result FROM source RETURNING *),
    hot AS (INSERT INTO obs(datastreamid,foiid,phenomenontime,resulttime,result)
      SELECT datastreamid,foiid,now()-interval '1 minute',now()-interval '1 minute',result FROM source RETURNING *),
    registry AS (INSERT INTO oscar_regression_fixture(run_id,cold_id,hot_id,datastream_id,cold_time,hot_time)
      SELECT '$run',cold.id,hot.id,cold.datastreamid,cold.phenomenontime,hot.phenomenontime FROM cold,hot RETURNING *)
    SELECT json_build_object('runId',run_id,'coldId',cold_id,'hotId',hot_id,'datastreamId',datastream_id,
      'coldTime',cold_time,'hotTime',hot_time) FROM registry;"
    ;;

  fixture-status)
    run=${1:-}; valid_run "$run" || fail 'Invalid run ID.'; ensure_fixture_table
    json_query "WITH f AS (SELECT * FROM oscar_regression_fixture WHERE run_id='$run'), g AS (
      SELECT g.* FROM f JOIN oscar_archive_id_block b ON f.cold_id BETWEEN b.min_id AND b.max_id
      JOIN oscar_archive_generation g ON g.id=b.generation_id WHERE g.state IN ('ACTIVE','SEALED') ORDER BY g.activated_at DESC LIMIT 1),
    saved AS (UPDATE oscar_regression_fixture f SET generation_id=g.id FROM g WHERE f.run_id='$run' RETURNING f.*)
    SELECT json_build_object('exists',EXISTS(SELECT 1 FROM f),'generationId',(SELECT id FROM g),'generationState',(SELECT state FROM g),
      'parityVerified',coalesce((SELECT parity_verified FROM g),false),'generationRows',coalesce((SELECT row_count FROM g),0),
      'coldHotPresent',EXISTS(SELECT 1 FROM obs WHERE id=(SELECT cold_id FROM f)),
      'hotPresent',EXISTS(SELECT 1 FROM obs WHERE id=(SELECT hot_id FROM f))) ;"
    ;;

  fixture-accelerate)
    run=${1:-}; valid_run "$run" || fail 'Invalid run ID.'; ensure_fixture_table
    changed=$(scalar "WITH target AS (SELECT generation_id FROM oscar_regression_fixture WHERE run_id='$run'),
      exact AS (SELECT g.id FROM oscar_archive_generation g JOIN target t ON t.generation_id=g.id
        JOIN oscar_regression_fixture f ON f.run_id='$run'
        WHERE g.state='ACTIVE' AND g.parity_verified AND g.row_count=1
          AND g.min_id=f.cold_id AND g.max_id=f.cold_id),
      changed AS (UPDATE oscar_archive_generation g SET activated_at=now()-interval '100 years' FROM exact e WHERE g.id=e.id RETURNING 1)
      SELECT count(*) FROM changed;")
    [[ $changed == 1 ]] || fail 'Fixture generation is not uniquely ACTIVE and parity verified.'
    printf '{"accelerated":true}\n'
    ;;

  export-check)
    run=${1:-}; valid_run "$run" || fail 'Invalid run ID.'; ensure_fixture_table
    generation=$(scalar "SELECT generation_id FROM oscar_regression_fixture WHERE run_id='$run';")
    valid_uuid "$generation" || fail 'Fixture has no archive generation.'
    export_root=$(mktemp -d "/tmp/oscar-regression-export-${run}.XXXXXX")
    trap 'rm -rf -- "$export_root"' EXIT
    sudo bash oscar.sh archive export --generation "$generation" --destination "$export_root/portable" >/dev/null
    (cd "$export_root/portable" && sha256sum --check SHA256SUMS >/dev/null)
    parquet=$(find "$export_root/portable" -type f -name '*.parquet' | wc -l)
    manifests=$(find "$export_root/portable" -type f -name 'manifest*.json' | wc -l)
    schemas=$(find "$export_root/portable" -type f -name '*schema*' | wc -l)
    [[ -s $export_root/portable/query.sql && -s $export_root/portable/README.md && $parquet -gt 0 ]] || fail 'Portable export is incomplete.'
    printf '{"generationId":"%s","checksumVerified":true,"parquetFiles":%s,"manifestFiles":%s,"schemaFiles":%s,"querySql":true,"readme":true}\n' "$generation" "$parquet" "$manifests" "$schemas"
    ;;

  fixture-controls)
    run=${1:-}; valid_run "$run" || fail 'Invalid run ID.'; ensure_fixture_table
    generation=$(scalar "SELECT generation_id FROM oscar_regression_fixture WHERE run_id='$run';")
    valid_uuid "$generation" || fail 'Fixture has no archive generation.'
    [[ $(scalar "SELECT state FROM oscar_archive_generation WHERE id='$generation';") == SEALED ]] || fail 'Fixture generation is not SEALED.'
    hold_output=$(sudo bash oscar.sh archive hold create --generation "$generation" --reason "regression-$run" --created-by oscar-regression)
    hold=$(printf '%s' "$hold_output" | sed -n 's/^Retention hold created: //p' | tail -n1)
    valid_uuid "$hold" || fail 'Hold create did not return an ID.'
    [[ $(scalar "SELECT count(*) FROM oscar_retention_hold WHERE id='$hold' AND released_at IS NULL;") == 1 ]] || fail 'Created hold is not listed.'
    sudo bash oscar.sh archive hold release --id "$hold" --released-by oscar-regression >/dev/null
    [[ $(scalar "SELECT count(*) FROM oscar_retention_hold WHERE id='$hold' AND released_at IS NOT NULL;") == 1 ]] || fail 'Hold was not released.'
    cutoff=$(psql_admin --tuples-only --no-align --command "SELECT to_char(window_end+interval '1 second','YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') FROM oscar_archive_generation WHERE id='$generation';" | tr -d '[:space:]')
    dry=$(sudo bash oscar.sh archive dry-run --before "$cutoff" --requested-by oscar-regression)
    plan=$(printf '%s' "$dry" | sed -n 's/^Deletion plan: //p'); token=$(printf '%s' "$dry" | sed -n 's/^Confirmation token (shown once): //p')
    valid_uuid "$plan" && [[ $token =~ ^[0-9a-f]{48}$ ]] || fail 'Dry run did not return plan/token.'
    candidates=$(scalar "SELECT count(*) FROM oscar_deletion_plan_item WHERE plan_id='$plan';")
    only=$(scalar "SELECT count(*) FROM oscar_deletion_plan_item WHERE plan_id='$plan' AND generation_id='$generation';")
    if [[ $candidates != 1 || $only != 1 ]]; then
      psql_admin --command "DELETE FROM oscar_deletion_plan WHERE id='$plan' AND state='PLANNED';" >/dev/null
      fail 'Deletion plan included non-fixture generations; it was cancelled.'
    fi
    wrong=${token%?}0; [[ $wrong != "$token" ]] || wrong=${token%?}1
    if sudo bash oscar.sh archive purge --plan "$plan" --token "$wrong" >/dev/null 2>&1; then fail 'Wrong token unexpectedly succeeded.'; fi
    [[ $(scalar "SELECT state FROM oscar_deletion_plan WHERE id='$plan';") == PLANNED ]] || fail 'Wrong token changed plan state.'
    sudo bash oscar.sh archive purge --plan "$plan" --token "$token" >/dev/null
    replay_rejected=false; sudo bash oscar.sh archive purge --plan "$plan" --token "$token" >/dev/null 2>&1 || replay_rejected=true
    json_query "SELECT json_build_object('holdCreated',true,'holdListed',true,'holdReleased',true,'dryRunPlan','$plan',
      'wrongTokenRejected',true,'purged',g.state='PURGED','objectsDeleted',NOT EXISTS(SELECT 1 FROM oscar_archive_object o WHERE o.generation_id=g.id AND o.state<>'DELETED'),
      'tombstonePresent',EXISTS(SELECT 1 FROM oscar_tombstone t WHERE t.generation_id=g.id),
      'ledgerPresent',EXISTS(SELECT 1 FROM oscar_deletion_ledger l WHERE l.plan_id='$plan' AND l.outcome='DELETED'),
      'tokenReplayRejected',$replay_rejected) FROM oscar_archive_generation g WHERE g.id='$generation';"
    ;;

  backup-check)
    output=$(sudo bash oscar.sh backup)
    backup=$(printf '%s' "$output" | sed -n 's#^Backup created: .*/##p' | tail -n1)
    [[ $backup =~ ^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}$ ]] || fail 'Backup command did not return a backup ID.'
    backup_dir=$(absolute_path "$(env_value OSCAR_BACKUP_DIR ./backups)")
    retention=$(env_value OSCAR_BACKUP_RETENTION_COUNT 14)
    verified=$(find "$backup_dir" -mindepth 2 -maxdepth 2 -type f -name VERIFIED | wc -l)
    [[ -s $backup_dir/$backup/VERIFIED && -s $backup_dir/$backup/SHA256SUMS ]] || fail 'New backup is not automatically verified.'
    epoch=$(scalar "SELECT count(*) FROM oscar_backup_epoch WHERE state='VERIFIED' AND manifest_path='$backup/epoch.json';")
    printf '{"backupId":"%s","automaticVerification":true,"verifiedEpoch":%s,"verifiedBackups":%s,"retentionLimit":%s,"retentionRespected":%s,"restoreAttempted":false}\n' "$backup" "$([[ $epoch == 1 ]] && echo true || echo false)" "$verified" "$retention" "$([[ $verified -le $retention ]] && echo true || echo false)"
    ;;

  fixture-cleanup)
    run=${1:-}; valid_run "$run" || fail 'Invalid run ID.'; ensure_fixture_table
    # Only registered hot/cold rows are touched. Catalog evidence from a purged
    # generation is deliberately retained for auditability.
    deleted=$(scalar "WITH f AS (DELETE FROM oscar_regression_fixture WHERE run_id='$run' RETURNING cold_id,hot_id),
      d AS (DELETE FROM obs o USING f WHERE o.id IN (f.cold_id,f.hot_id) RETURNING 1) SELECT count(*) FROM d;")
    printf '{"fixtureRowsDeleted":%s}\n' "$deleted"
    ;;

  *) fail "Unknown storage probe action: $action" ;;
esac
