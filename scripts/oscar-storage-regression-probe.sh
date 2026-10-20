#!/usr/bin/env bash
set -Eeuo pipefail
export LC_ALL=C
umask 077

# Privileged target-side helper for the OSCAR 3.9.2 storage regression. It is copied to
# /tmp for one run and is never installed into the deployment. Ordinary
# lifecycle mutations operate only on rows registered in
# oscar_regression_fixture and fail closed if a cold-deletion plan includes any
# other generation. The separately selected restore-drill action intentionally
# replaces the isolated database, application state, cold archive, and credentials
# while preserving the append-only WAL archive; the runner binds that profile to
# exact target, data-loss, and canonical storage-path acknowledgements, and the
# probe additionally requires an exact per-run token.

fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
[[ ${1:-} == --release-dir ]] || fail 'Expected --release-dir.'
release_dir=${2:-}; shift 2
canonical_release=$(realpath -e -- "$release_dir" 2>/dev/null || true)
[[ $release_dir == /* && $release_dir != / && $release_dir != *'/../'* &&
   -d $release_dir && ! -L $release_dir && $canonical_release == "$release_dir" &&
   -f $release_dir/oscar.sh && ! -L $release_dir/oscar.sh ]] ||
  fail 'Release directory is not a configured OSCAR release.'
action=${1:-}; (($#)) && shift
[[ ${EUID:-$(id -u)} -eq 0 ]] || fail 'Storage probe requires passwordless sudo.'
cd "$release_dir"

compose() {
  env -u OSCAR_ARCHIVE_DIR -u OSCAR_BACKUP_DIR -u OSCAR_DEPLOYMENT_ID \
    -u OSCAR_HTTPS_PORT -u OSCAR_JAVA_OPTS -u OSCAR_POSTGIS_PLATFORM \
    -u OSCAR_SECRETS_DIR -u OSCAR_TLS_DIR -u OSCAR_VERSION \
    -u OSCAR_WAL_ARCHIVE_DIR \
    docker compose --project-name oscar --env-file .env --file compose.yaml "$@"
}
psql_admin() {
  compose exec -T postgres sh -eu -c '
    PGPASSWORD=$(cat /run/secrets/postgres_bootstrap_password)
    PGOPTIONS=-csearch_path=oscar,public
    export PGPASSWORD PGOPTIONS
    exec psql --set=ON_ERROR_STOP=1 --username oscar_bootstrap --dbname gis "$@"
  ' psql-wrapper "$@"
}
# These helpers are called from manifest/ledger read loops. psql/docker inherit
# stdin by default and would otherwise consume the loop's remaining records
# after validating the first item.
scalar() { psql_admin --quiet --tuples-only --no-align --command "$1" </dev/null | tr -d '[:space:]'; }
json_query() { psql_admin --quiet --tuples-only --no-align --command "$1" </dev/null | tail -n 1; }
valid_run() { [[ $1 =~ ^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$ ]]; }
valid_uuid() { [[ $1 =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]]; }
retention_hold_id_from_output() {
  local output=$1 expected_store=$2 expected_scope=$3 expected_resolution=$4
  local line hold_id='' store_key='' id_scope='' resolution='' matches=0
  while IFS= read -r line; do
    if [[ $line =~ ^Retention\ hold\ created:\ ([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\ \(store=([a-z_][a-z0-9_]{0,62}),\ id-scope=(-?[0-9]+),\ resolution=(GENERATION_EXACT|HOT_EXACT|COLD_RANGE_CONSERVATIVE)\)$ ]]; then
      hold_id=${BASH_REMATCH[1]}
      store_key=${BASH_REMATCH[2]}
      id_scope=${BASH_REMATCH[3]}
      resolution=${BASH_REMATCH[4]}
      matches=$((matches+1))
    fi
  done <<<"$output"
  [[ $matches -eq 1 && $store_key == "$expected_store" && $id_scope == "$expected_scope" &&
     $resolution == "$expected_resolution" ]] || return 1
  valid_uuid "$hold_id" || return 1
  printf '%s' "$hold_id"
}
valid_deployment_id() { valid_uuid "$1"; }
valid_store_key() { [[ $1 =~ ^[a-z_][a-z0-9_]{0,62}$ ]]; }
valid_id_scope() { [[ $1 =~ ^-?[0-9]+$ && $1 -ge -2147483648 && $1 -le 2147483647 ]]; }
valid_media_token() { [[ $1 =~ ^[A-Za-z0-9_-]+$ ]]; }
valid_alarm_video_path() {
  [[ $1 =~ ^videos/clips/[A-Za-z0-9._-]+/[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])_([01][0-9]|2[0-3])-[0-5][0-9]-[0-5][0-9]_[0-9]{3}-g[1-9][0-9]*\.mp4$ ]]
}
alarm_media_marker() {
  valid_run "$1" || fail 'Alarm-media run ID is invalid.'
  printf '/tmp/oscar-alarm-media-%s.baseline' "$1"
}
alarm_all_camera_artifacts() {
  local listing full relative name kind
  listing=$(compose exec -T oscar sh -eu -c '
    root=/var/lib/oscar/files/videos/clips
    test ! -L "$root"
    test -d "$root" || exit 0
    find "$root" -mindepth 2 -maxdepth 2 -type f -print
  ' alarm-camera-artifacts)
  while IFS= read -r full; do
    [[ -n $full ]] || continue
    relative=${full#/var/lib/oscar/files/}
    [[ $relative =~ ^videos/clips/[A-Za-z0-9._-]+/[^/]+$ ]] ||
      fail 'Alarm-media inventory encountered an unsafe clip path.'
    name=${relative##*/}
    case $name in
      *.partial-*|*.partial|*.partial.*|*.tmp|*.tmp.*) kind=partial ;;
      *.mp4) kind=final ;;
      *) continue ;;
    esac
    printf '%s\t%s\n' "$kind" "$relative"
  done <<<"$listing" | sort -u
}
env_value() {
  local name=$1 fallback=$2 value
  value=$(awk -F= -v name="$name" '$1 == name { print substr($0, index($0, "=") + 1); exit }' .env)
  printf '%s' "${value:-$fallback}"
}
ensure_restore_archive_canary_hierarchy() {
  local expected_uid=${1:-} expected_gid=${2:-} component component_mode
  shift 2 || fail 'Restore archive-canary ownership arguments are missing.'
  [[ $expected_uid =~ ^[0-9]+$ && $expected_gid =~ ^[0-9]+$ && $# -gt 0 ]] ||
    fail 'Restore archive-canary ownership or hierarchy is invalid.'
  for component in "$@"; do
    [[ $component == /* ]] || fail 'Restore archive-canary hierarchy must use absolute paths.'
    if [[ ! -e $component && ! -L $component ]]; then
      install -d -o "$expected_uid" -g "$expected_gid" -m 0750 -- "$component" ||
        fail 'Could not create a canonical restore archive-canary directory.'
    fi
    [[ -d $component && ! -L $component &&
       $(stat -c '%u:%g' -- "$component") == "$expected_uid:$expected_gid" ]] ||
      fail 'Restore archive-canary hierarchy has unsafe ownership or type.'
    component_mode=$(stat -c %a -- "$component")
    [[ $component_mode =~ ^[0-7]{3,4}$ ]] &&
      (( (8#$component_mode & 0700) == 0700 )) ||
      fail 'Restore archive-canary hierarchy is not owner-readable, writable, and searchable.'
  done
}
platform_config_fields() {
  local config_path=$1
  {
    cat <<'SQL'
\set ON_ERROR_STOP on
CREATE TEMP TABLE oscar_config_input (sequence bigserial, line text NOT NULL);
\copy oscar_config_input(line) FROM STDIN
SQL
    compose exec -T oscar base64 "$config_path"
    printf '\\.\n'
    cat <<'SQL'
WITH payload AS (
  SELECT convert_from(decode(string_agg(line, '' ORDER BY sequence), 'base64'), 'UTF8') AS text
  FROM oscar_config_input
), document AS (
  SELECT text::json AS raw FROM payload WHERE left(ltrim(text), 1) = '['
), items AS (
  SELECT item AS raw, ordinal
  FROM document, LATERAL json_array_elements(raw) WITH ORDINALITY AS entry(item, ordinal)
), expected(kind, class_name) AS (
  VALUES
    ('daily', 'com.botts.impl.service.dailyfile.DailyFileJournalServiceConfig'),
    ('oscar', 'com.botts.impl.service.oscar.OSCARServiceConfig'),
    ('database', 'org.sensorhub.impl.database.system.SystemDriverDatabaseConfig')
), candidates AS (
  SELECT expected.kind, items.ordinal, items.raw
  FROM items CROSS JOIN expected
  WHERE json_typeof(items.raw) = 'object'
    AND EXISTS (
      SELECT 1 FROM json_each(items.raw) pair
      WHERE pair.key = 'objClass' AND json_typeof(pair.value) = 'string'
        AND pair.value #>> '{}' = expected.class_name
    )
), selected AS (
  SELECT daily.raw AS daily, oscar.raw AS oscar, database.raw AS database
  FROM candidates daily CROSS JOIN candidates oscar CROSS JOIN candidates database
  WHERE daily.kind = 'daily' AND oscar.kind = 'oscar' AND database.kind = 'database'
    AND (SELECT count(*) FROM candidates WHERE kind = 'daily') = 1
    AND (SELECT count(*) FROM candidates WHERE kind = 'oscar') = 1
    AND (SELECT count(*) FROM candidates WHERE kind = 'database') = 1
), nested AS (
  SELECT daily, oscar, database,
    oscar->'videoRetentionConfig' AS media,
    database->'dbConfig' AS db_config,
    (database->'dbConfig')->'archive' AS archive
  FROM selected
), valid AS (
  SELECT * FROM nested
  WHERE NOT EXISTS (SELECT key FROM json_each(daily) GROUP BY key HAVING count(*) <> 1)
    AND NOT EXISTS (SELECT key FROM json_each(oscar) GROUP BY key HAVING count(*) <> 1)
    AND NOT EXISTS (SELECT key FROM json_each(database) GROUP BY key HAVING count(*) <> 1)
    AND json_typeof(media) = 'object'
    AND json_typeof(db_config) = 'object'
    AND json_typeof(archive) = 'object'
    AND NOT EXISTS (SELECT key FROM json_each(media) GROUP BY key HAVING count(*) <> 1)
    AND NOT EXISTS (SELECT key FROM json_each(db_config) GROUP BY key HAVING count(*) <> 1)
    AND NOT EXISTS (SELECT key FROM json_each(archive) GROUP BY key HAVING count(*) <> 1)
    AND daily->>'moduleClass' = 'com.botts.impl.service.dailyfile.DailyFileJournalService'
    AND oscar->>'moduleClass' = 'com.botts.impl.service.oscar.OSCARServiceModule'
    AND database->>'moduleClass' = 'org.sensorhub.impl.database.system.SystemDriverDatabase'
    AND db_config->>'objClass' = 'org.sensorhub.impl.datastore.postgis.database.OscarTieredObsSystemDatabaseConfig'
    AND db_config->>'moduleClass' = 'org.sensorhub.impl.datastore.postgis.database.OscarTieredObsSystemDatabase'
    AND archive->>'objClass' = 'org.sensorhub.impl.datastore.postgis.archive.TieredArchiveConfig'
    AND media->>'objClass' = 'com.botts.impl.service.oscar.video.VideoRetentionConfig'
    AND json_typeof(db_config->'useBatch') = 'boolean' AND (db_config->>'useBatch')::boolean
    AND json_typeof(media->'enableFrameRetention') = 'boolean'
    AND json_typeof(archive->'deleteHotAfterArchive') = 'boolean'
    AND json_typeof(oscar->'delegateObservationLifecycleToDatabase') = 'boolean'
    AND json_typeof(daily->'rootDirectory') = 'string'
    AND json_typeof(daily->'journalDirectory') = 'string'
    AND json_typeof(daily->'publicationDirectory') = 'string'
    AND json_typeof(daily->'zoneId') = 'string'
    AND json_typeof(daily->'dailyFileObservationMode') = 'string'
    AND json_typeof(archive->'duckDbTemporaryDirectory') = 'string'
    AND json_typeof(archive->'intervalMinutes') = 'number' AND archive->>'intervalMinutes' ~ '^[0-9]+$'
    AND json_typeof(archive->'rollbackGraceDays') = 'number' AND archive->>'rollbackGraceDays' ~ '^[0-9]+$'
    AND json_typeof(archive->'duckDbMemoryLimitMegabytes') = 'number' AND archive->>'duckDbMemoryLimitMegabytes' ~ '^[0-9]+$'
    AND json_typeof(archive->'duckDbThreads') = 'number' AND archive->>'duckDbThreads' ~ '^[0-9]+$'
    AND json_typeof(archive->'duckDbMaximumTemporaryMegabytes') = 'number' AND archive->>'duckDbMaximumTemporaryMegabytes' ~ '^[0-9]+$'
    AND json_typeof(archive->'duckDbMaximumConcurrentSessions') = 'number' AND archive->>'duckDbMaximumConcurrentSessions' ~ '^[0-9]+$'
    AND json_typeof(archive->'duckDbSessionAcquireTimeoutSeconds') = 'number' AND archive->>'duckDbSessionAcquireTimeoutSeconds' ~ '^[0-9]+$'
    AND json_typeof(media->'timeToRetention') = 'number' AND media->>'timeToRetention' ~ '^[0-9]+$'
    AND json_typeof(media->'videoQueryPeriod') = 'number' AND media->>'videoQueryPeriod' ~ '^[0-9]+$'
    AND json_typeof(media->'frameRetentionCount') = 'number' AND media->>'frameRetentionCount' ~ '^[0-9]+$'
    AND json_typeof(media->'jpegQuality') = 'number' AND media->>'jpegQuality' ~ '^[0-9]+$'
    AND json_typeof(media->'sourceRollbackGraceHours') = 'number' AND media->>'sourceRollbackGraceHours' ~ '^[0-9]+$'
    AND json_typeof(media->'metadataReclamationWorkLimit') = 'number' AND media->>'metadataReclamationWorkLimit' ~ '^[0-9]+$'
    AND json_typeof(daily->'fsyncIntervalMillis') = 'number' AND daily->>'fsyncIntervalMillis' ~ '^[0-9]+$'
    AND json_typeof(daily->'maxUnforcedRecords') = 'number' AND daily->>'maxUnforcedRecords' ~ '^[0-9]+$'
    AND json_typeof(daily->'maxUnforcedBytes') = 'number' AND daily->>'maxUnforcedBytes' ~ '^[0-9]+$'
    AND json_typeof(daily->'maxSegmentBytes') = 'number' AND daily->>'maxSegmentBytes' ~ '^[0-9]+$'
    AND json_typeof(daily->'maxSegmentAgeSeconds') = 'number' AND daily->>'maxSegmentAgeSeconds' ~ '^[0-9]+$'
    AND json_typeof(daily->'maxRecordBytes') = 'number' AND daily->>'maxRecordBytes' ~ '^[0-9]+$'
    AND json_typeof(daily->'sealedJournalRetentionDays') = 'number' AND daily->>'sealedJournalRetentionDays' ~ '^[0-9]+$'
    AND json_typeof(oscar->'dailyFilePurgeWorkLimit') = 'number' AND oscar->>'dailyFilePurgeWorkLimit' ~ '^[0-9]+$'
)
SELECT concat_ws('|',
  archive->>'intervalMinutes', archive->>'rollbackGraceDays',
  archive->>'duckDbMemoryLimitMegabytes', archive->>'duckDbThreads',
  archive->>'duckDbMaximumTemporaryMegabytes', archive->>'duckDbMaximumConcurrentSessions',
  archive->>'duckDbSessionAcquireTimeoutSeconds', archive->>'duckDbTemporaryDirectory',
  media->>'timeToRetention', media->>'videoQueryPeriod', media->>'frameRetentionCount',
  media->>'jpegQuality', media->>'sourceRollbackGraceHours', media->>'metadataReclamationWorkLimit',
  media->>'enableFrameRetention', archive->>'deleteHotAfterArchive',
  daily->>'rootDirectory', daily->>'journalDirectory', daily->>'publicationDirectory',
  daily->>'zoneId', daily->>'dailyFileObservationMode', daily->>'fsyncIntervalMillis',
  daily->>'maxUnforcedRecords', daily->>'maxUnforcedBytes', daily->>'maxSegmentBytes',
  daily->>'maxSegmentAgeSeconds', daily->>'maxRecordBytes', daily->>'sealedJournalRetentionDays',
  oscar->>'delegateObservationLifecycleToDatabase', oscar->>'dailyFilePurgeWorkLimit')
FROM valid;
SQL
  } | psql_admin --quiet --tuples-only --no-align | tail -n 1
}
entrypoint_has_managed_tmp_contract() {
  local entrypoint=$1
  [[ $(grep -Fxc 'NATIVE_TMP_DIR=/run/oscar-native' "$entrypoint") == 1 &&
     $(grep -Fxc 'readonly NATIVE_TMP_DIR' "$entrypoint") == 1 ]] &&
    awk '
      /^[[:space:]]*exec java \$\{JAVA_OPTS:-\}/ {
        java_opts++
        if (state == 0) state = 1
        next
      }
      /^[[:space:]]*-Djava\.io\.tmpdir="\$\{NATIVE_TMP_DIR\}"/ {
        java_tmp++
        if (state == 1) state = 2
        next
      }
      /^[[:space:]]*-Dorg\.bytedeco\.javacpp\.cachedir="\$\{NATIVE_TMP_DIR\}\/javacpp"/ {
        javacpp_cache++
        if (state == 2) state = 3
        next
      }
      /^[[:space:]]*-Doscar\.data\.tmpdir=\/tmp/ {
        data_tmp++
        if (state == 3) state = 4
      }
      END {
        exit !(state == 4 && java_opts == 1 && java_tmp == 1 &&
          javacpp_cache == 1 && data_tmp == 1)
      }
    ' "$entrypoint"
}
absolute_path() { case $1 in /*) printf '%s' "$1" ;; *) printf '%s/%s' "$release_dir" "${1#./}" ;; esac; }
canonical_directory() {
  local value=$1 resolved
  [[ $value == /* && $value != / && -d $value && ! -L $value ]] ||
    fail "Restore storage plane is not a non-root regular directory: $value"
  resolved=$(realpath -e -- "$value")
  [[ $resolved == "$value" ]] || fail "Restore storage plane is not canonical: $value"
  printf '%s' "$resolved"
}
paths_overlap() { [[ $1 == "$2" || $1 == "$2"/* || $2 == "$1"/* ]]; }
directory_bytes() {
  [[ -d $1 ]] || { printf 0; return; }
  du -sb -- "$1" 2>/dev/null | awk '{print $1+0}'
}
archive_scratch_json() {
  local scratch_path=$1 archive_path=$2
  compose exec -T oscar sh -eu -c '
    scratch=$1; archive=$2
    if [ ! -e "$scratch" ] && [ ! -L "$scratch" ]; then
      printf "{\"present\":false,\"realDirectory\":false,\"ownerUid\":null,\"ownerGid\":null,\"mode\":\"\",\"archiveDisjoint\":true,\"entryCount\":0}\n"
      exit 0
    fi
    real_directory=false
    if [ -d "$scratch" ] && [ ! -L "$scratch" ]; then real_directory=true; fi
    owner=$(stat -c %u -- "$scratch" 2>/dev/null || printf -1)
    group=$(stat -c %g -- "$scratch" 2>/dev/null || printf -1)
    mode=$(stat -c %a -- "$scratch" 2>/dev/null || printf missing)
    entries=0
    if [ "$real_directory" = true ]; then
      entries=$(find "$scratch" -mindepth 1 -maxdepth 1 -print 2>/dev/null | wc -l | tr -d "[:space:]")
    fi
    disjoint=false
    if [ "$real_directory" = true ] && [ -d "$archive" ] && [ ! -L "$archive" ]; then
      scratch_real=$(realpath -e -- "$scratch")
      archive_real=$(realpath -e -- "$archive")
      case "$scratch_real/" in "$archive_real/"*) ;; *)
        case "$archive_real/" in "$scratch_real/"*) ;; *) disjoint=true ;; esac
      esac
    fi
    printf "{\"present\":true,\"realDirectory\":%s,\"ownerUid\":%s,\"ownerGid\":%s,\"mode\":\"%s\",\"archiveDisjoint\":%s,\"entryCount\":%s}\n" \
      "$real_directory" "$owner" "$group" "$mode" "$disjoint" "${entries:-0}"
  ' scratch-health "$scratch_path" "$archive_path"
}
media_metadata_health_json() {
  local checkpoint=/var/lib/oscar/files/videos/retained-media/v1/.metadata-reclamation-checkpoint.json
  local checkpoint_present=false checkpoint_valid=false checkpoint_schema=null checkpoint_encoded='' checkpoint_result=''
  checkpoint_encoded=$(compose exec -T oscar sh -eu -c '
    path=$1
    if [ ! -e "$path" ] && [ ! -L "$path" ]; then exit 0; fi
    [ -f "$path" ] && [ ! -L "$path" ] || exit 20
    size=$(stat -c %s -- "$path")
    [ "$size" -gt 0 ] && [ "$size" -le 1048576 ] || exit 21
    openssl base64 -A -in "$path"
  ' media-metadata-checkpoint "$checkpoint") || fail 'Media metadata checkpoint is linked, non-regular, empty, or over 1 MiB.'
  if [[ -n $checkpoint_encoded ]]; then
    checkpoint_present=true
    [[ $checkpoint_encoded =~ ^[A-Za-z0-9+/]+=*$ && ${#checkpoint_encoded} -le 1398104 ]] ||
      fail 'Media metadata checkpoint is not bounded canonical base64.'
    checkpoint_result=$(scalar "WITH source AS (
        SELECT convert_from(decode('$checkpoint_encoded','base64'),'UTF8') AS text),
      doc AS (SELECT text::json AS raw, text::jsonb AS value FROM source)
      SELECT coalesce(value->>'schemaVersion','')||'|'||(
        jsonb_typeof(value)='object'
        AND (SELECT count(*) FROM json_object_keys(raw))=3
        AND value ?& ARRAY['schemaVersion','earliestProcessedObservationEpochHour','updatedAt']
        AND value->'schemaVersion'='2'::jsonb
        AND (jsonb_typeof(value->'earliestProcessedObservationEpochHour')='null' OR
          (jsonb_typeof(value->'earliestProcessedObservationEpochHour')='number'
           AND value->>'earliestProcessedObservationEpochHour' ~ '^(0|[1-9][0-9]*)$'
           AND (value->>'earliestProcessedObservationEpochHour')::numeric <= 8765802740110))
        AND jsonb_typeof(value->'updatedAt')='string'
        AND value->>'updatedAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,9})?Z$'
        AND (value->>'updatedAt')::timestamptz IS NOT NULL
      )::text FROM doc;")
    IFS='|' read -r checkpoint_schema checkpoint_valid_text <<<"$checkpoint_result"
    [[ $checkpoint_schema =~ ^[0-9]+$ ]] || checkpoint_schema=null
    [[ $checkpoint_valid_text == true ]] && checkpoint_valid=true
  fi
  compose exec -T oscar sh -eu -c '
    checkpoint_present=$1; checkpoint_valid=$2; checkpoint_schema=$3
    root=/var/lib/oscar/files/videos/retained-media/v1
    if [ ! -e "$root" ] && [ ! -L "$root" ]; then
      printf "{\"rootPresent\":false,\"checkpointPresent\":false,\"checkpointValid\":false,\"checkpointSchemaVersion\":null,\"processedIndexFiles\":0,\"processedIndexBytes\":0,\"deletionIndexFiles\":0,\"deletionIndexBytes\":0,\"retainedManifestFiles\":0,\"retainedJpegFiles\":0,\"legacyProcessedMarkerFiles\":0,\"legacyDeletionTombstones\":0,\"partialArtifacts\":0,\"unsafeEntries\":0,\"indexFormatFailures\":0}\n"
      exit 0
    fi
    [ -d "$root" ] && [ ! -L "$root" ] || exit 20
    total_entries=$(find "$root" -mindepth 1 -print | wc -l | tr -d "[:space:]")
    [ "${total_entries:-0}" -le 100000 ] || exit 21
    partials=$(find "$root" -type f \( -name "*.partial" -o -name "*.partial.*" -o -name "*.partial-*" -o -name "*.tmp" -o -name "*.tmp.*" -o -name "*.tmp-*" \) -print | wc -l | tr -d "[:space:]")
    unsafe=$(find "$root" -type l -print | wc -l | tr -d "[:space:]")
    processed_files=0; processed_bytes=0; deletion_files=0; deletion_bytes=0; format_failures=0
    processed_root="$root/retention-processed-index"
    if [ -e "$processed_root" ] || [ -L "$processed_root" ]; then
      if [ ! -d "$processed_root" ] || [ -L "$processed_root" ]; then unsafe=$((unsafe+1)); else
        while IFS= read -r index; do
          [ "$index" ] || continue
          name=${index##*/}; processed_files=$((processed_files+1))
          size=$(stat -c %s -- "$index" 2>/dev/null || printf 0)
          processed_bytes=$((processed_bytes+size))
          header=$(od -An -tx1 -N16 -- "$index" 2>/dev/null | tr -d " [:space:]")
          if ! printf "%s" "$name" | grep -Eq "^[0-9]{19}-(0[0-9]|1[01])[.]idx$" ||
             [ "$size" -lt 16 ] || [ $(((size-16)%36)) -ne 0 ] ||
             [ "$header" != 4f534341524d50490000000100000024 ]; then
            format_failures=$((format_failures+1))
          fi
        done <<EOF
$(find "$processed_root" -mindepth 1 -maxdepth 1 -type f -name "*.idx" -print | LC_ALL=C sort)
EOF
        unexpected=$(find "$processed_root" -mindepth 1 -maxdepth 1 ! -type f -print | wc -l | tr -d "[:space:]")
        unexpected_files=$(find "$processed_root" -mindepth 1 -maxdepth 1 -type f ! -name "*.idx" ! -name ".index.lock" -print | wc -l | tr -d "[:space:]")
        unsafe=$((unsafe+unexpected+unexpected_files))
        lock="$processed_root/.index.lock"
        if [ -e "$lock" ] || [ -L "$lock" ]; then
          if [ ! -f "$lock" ] || [ -L "$lock" ] || [ "$(stat -c %s -- "$lock" 2>/dev/null || printf -1)" -ne 0 ]; then
            unsafe=$((unsafe+1))
          fi
        fi
      fi
    fi
    deletion_root="$root/deletion-index"
    if [ -e "$deletion_root" ] || [ -L "$deletion_root" ]; then
      if [ ! -d "$deletion_root" ] || [ -L "$deletion_root" ]; then unsafe=$((unsafe+1)); else
        while IFS= read -r index; do
          [ "$index" ] || continue
          relative=${index#"$deletion_root"/}; shard=${relative%%/*}; name=${relative##*/}
          deletion_files=$((deletion_files+1))
          size=$(stat -c %s -- "$index" 2>/dev/null || printf 0)
          deletion_bytes=$((deletion_bytes+size))
          header=$(od -An -tx1 -N16 -- "$index" 2>/dev/null | tr -d " [:space:]")
          index_prefix=$(printf "%s" "${name%.idx}" | cut -c1-2)
          if ! printf "%s/%s" "$shard" "$name" | grep -Eq "^[0-9a-f]{2}/[0-9a-f]{4}[.]idx$" ||
             [ "$index_prefix" != "$shard" ]; then
            format_failures=$((format_failures+1))
          fi
          if [ "$size" -lt 16 ] || [ $(((size-16)%36)) -ne 0 ] ||
             [ "$header" != 4f534341524d44490000000100000024 ]; then
            format_failures=$((format_failures+1))
          fi
        done <<EOF
$(find "$deletion_root" -mindepth 2 -maxdepth 2 -type f -name "*.idx" -print | LC_ALL=C sort)
EOF
        unexpected=$(find "$deletion_root" -mindepth 1 -maxdepth 1 ! -type d -print | wc -l | tr -d "[:space:]")
        invalid_shards=$(find "$deletion_root" -mindepth 1 -maxdepth 1 -type d ! -name "[0-9a-f][0-9a-f]" -print | wc -l | tr -d "[:space:]")
        unexpected_files=$(find "$deletion_root" -mindepth 2 -maxdepth 2 -type f ! -name "*.idx" ! -name ".index.lock" -print | wc -l | tr -d "[:space:]")
        unexpected_members=$(find "$deletion_root" -mindepth 2 -maxdepth 2 ! -type f -print | wc -l | tr -d "[:space:]")
        unexpected_deep=$(find "$deletion_root" -mindepth 3 -print | wc -l | tr -d "[:space:]")
        invalid_locks=0
        while IFS= read -r lock; do
          [ "$lock" ] || continue
          if [ ! -f "$lock" ] || [ -L "$lock" ] || [ "$(stat -c %s -- "$lock" 2>/dev/null || printf -1)" -ne 0 ]; then
            invalid_locks=$((invalid_locks+1))
          fi
        done <<EOF
$(find "$deletion_root" -mindepth 2 -maxdepth 2 -name ".index.lock" -print | LC_ALL=C sort)
EOF
        unsafe=$((unsafe+unexpected+invalid_shards+unexpected_files+unexpected_members+unexpected_deep+invalid_locks))
      fi
    fi
    legacy_processed=$(find "$root/retention-processed" -type f -name "*.json" 2>/dev/null | wc -l | tr -d "[:space:]")
    legacy_deleted=$(find "$root/events" -type f -name ".deleted.json" 2>/dev/null | wc -l | tr -d "[:space:]")
    manifests=$(find "$root/events" -type f -name "manifest.json" 2>/dev/null | wc -l | tr -d "[:space:]")
    jpegs=$(find "$root/events" -type f -name "frame-0[1-5].jpg" 2>/dev/null | wc -l | tr -d "[:space:]")
    printf "{\"rootPresent\":true,\"checkpointPresent\":%s,\"checkpointValid\":%s,\"checkpointSchemaVersion\":%s,\"processedIndexFiles\":%s,\"processedIndexBytes\":%s,\"deletionIndexFiles\":%s,\"deletionIndexBytes\":%s,\"retainedManifestFiles\":%s,\"retainedJpegFiles\":%s,\"legacyProcessedMarkerFiles\":%s,\"legacyDeletionTombstones\":%s,\"partialArtifacts\":%s,\"unsafeEntries\":%s,\"indexFormatFailures\":%s}\n" \
      "$checkpoint_present" "$checkpoint_valid" "$checkpoint_schema" "$processed_files" "$processed_bytes" \
      "$deletion_files" "$deletion_bytes" "${manifests:-0}" "${jpegs:-0}" "${legacy_processed:-0}" \
      "${legacy_deleted:-0}" "${partials:-0}" "${unsafe:-0}" "$format_failures"
  ' media-metadata-health "$checkpoint_present" "$checkpoint_valid" "$checkpoint_schema"
}
retention_runtime_health_json() {
  local checkpoint=/var/lib/oscar/files/videos/retained-media/v1/.retention-scan-checkpoint.json
  local encoded='' result='' schema=null valid=false processed=null updated=null lag=null
  encoded=$(compose exec -T oscar sh -eu -c '
    path=$1
    if [ ! -e "$path" ] && [ ! -L "$path" ]; then exit 0; fi
    [ -f "$path" ] && [ ! -L "$path" ] || exit 20
    size=$(stat -c %s -- "$path")
    [ "$size" -gt 0 ] && [ "$size" -le 1048576 ] || exit 21
    openssl base64 -A -in "$path"
  ' retention-scan-checkpoint "$checkpoint") ||
    fail 'Retention scan checkpoint is linked, non-regular, empty, or over 1 MiB.'
  if [[ -z $encoded ]]; then
    printf '{"checkpointPresent":false,"checkpointValid":false,"checkpointSchemaVersion":null,"processedThrough":null,"updatedAt":null,"cursorLagSeconds":null}\n'
    return
  fi
  [[ $encoded =~ ^[A-Za-z0-9+/]+=*$ && ${#encoded} -le 1398104 ]] ||
    fail 'Retention scan checkpoint is not bounded canonical base64.'
  result=$(scalar "WITH source AS (
      SELECT convert_from(decode('$encoded','base64'),'UTF8') AS text),
    doc AS (SELECT text::json AS raw, text::jsonb AS value FROM source),
    checked AS (
      SELECT raw,value,(
        jsonb_typeof(value)='object'
        AND (SELECT count(*) FROM json_object_keys(raw))=3
        AND value ?& ARRAY['schemaVersion','processedThrough','updatedAt']
        AND value->'schemaVersion'='1'::jsonb
        AND jsonb_typeof(value->'processedThrough')='string'
        AND value->>'processedThrough' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,9})?Z$'
        AND jsonb_typeof(value->'updatedAt')='string'
        AND value->>'updatedAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,9})?Z$'
      ) AS valid FROM doc)
    SELECT coalesce(value->>'schemaVersion','')||'|'||valid::text||'|'||
      CASE WHEN valid THEN value->>'processedThrough' ELSE '' END||'|'||
      CASE WHEN valid THEN value->>'updatedAt' ELSE '' END||'|'||
      CASE WHEN valid THEN greatest(0,floor(extract(epoch FROM
        (clock_timestamp()-(value->>'processedThrough')::timestamptz))))::bigint::text ELSE '' END
    FROM checked;")
  IFS='|' read -r schema valid_text processed_text updated_text lag_text extra <<<"$result"
  [[ -z ${extra:-} ]] || fail 'Retention scan checkpoint produced an ambiguous result.'
  [[ $schema =~ ^[0-9]+$ ]] || schema=null
  if [[ $valid_text == true ]]; then
    valid=true
    safe_json_text "$processed_text"; safe_json_text "$updated_text"
    [[ $lag_text =~ ^[0-9]+$ ]] || fail 'Retention scan checkpoint lag is invalid.'
    processed=\"$processed_text\"; updated=\"$updated_text\"; lag=$lag_text
  fi
  printf '{"checkpointPresent":true,"checkpointValid":%s,"checkpointSchemaVersion":%s,"processedThrough":%s,"updatedAt":%s,"cursorLagSeconds":%s}\n' \
    "$valid" "$schema" "$processed" "$updated" "$lag"
}
safe_json_text() {
  [[ ${1:-} =~ ^[A-Za-z0-9._/:@+,-]*$ ]] || fail "Unsafe value in probe JSON: ${1:-}"
}
sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum -- "$1" | awk '{print $1}'
  else shasum --algorithm 256 -- "$1" | awk '{print $1}'
  fi
}
valid_backup_relative_path() {
  local relative=$1 segment remainder
  [[ $relative =~ ^[A-Za-z0-9._/-]+$ && $relative != /* && $relative != *'//' ]] || return 1
  remainder=$relative
  while :; do
    case $remainder in */*) segment=${remainder%%/*}; remainder=${remainder#*/} ;; *) segment=$remainder; remainder='' ;; esac
    [[ -n $segment && $segment != . && $segment != .. ]] || return 1
    [[ -n $remainder ]] || break
  done
}
calculate_backup_manifest_hmac() {
  local root=$1 key_file=$2 image=$3
  sudo docker run --rm --network none --read-only --cap-drop ALL \
    --security-opt no-new-privileges --user 0 --entrypoint sh \
    --volume "$root:/backup:ro" --volume "$key_file:/backup-key.txt:ro" "$image" -eu -c '
      key=$(cat /backup-key.txt)
      openssl dgst -sha256 -hmac "$key" -binary /backup/SHA256SUMS | openssl base64 -A
    ' | tr -d '\r\n'
}
verify_backup_core_authentication() (
  set -Eeuo pipefail
  local root=$1 key_file=$2 image=$3 root_real expected actual line digest relative candidate resolved
  local work manifest_paths actual_paths count=0
  [[ -d $root && ! -L $root && -f $root/SHA256SUMS && ! -L $root/SHA256SUMS &&
     -s $root/SHA256SUMS && -f $root/SHA256SUMS.hmac && ! -L $root/SHA256SUMS.hmac &&
     -s $root/SHA256SUMS.hmac && -f $key_file && ! -L $key_file && -n $image ]] || {
    printf 'Independent backup authentication inputs are unsafe.\n' >&2; return 1; }
  [[ $(file_size "$root/SHA256SUMS") -le 16777216 ]] || {
    printf 'Authenticated checksum manifest exceeds 16 MiB.\n' >&2; return 1; }
  root_real=$(realpath -e -- "$root")
  [[ $root_real == "$root" ]] || {
    printf 'Backup root is not canonical.\n' >&2; return 1; }
  expected=$(tr -d '\r\n' <"$root/SHA256SUMS.hmac")
  [[ $expected =~ ^[A-Za-z0-9+/]{43}=$ ]] || {
    printf 'Backup core HMAC is malformed.\n' >&2; return 1; }
  actual=$(calculate_backup_manifest_hmac "$root" "$key_file" "$image")
  [[ $actual == "$expected" ]] || {
    printf 'Independent SHA256SUMS HMAC verification failed.\n' >&2; return 1; }
  work=$(mktemp -d /tmp/oscar-regression-backup-auth.XXXXXXXX)
  trap 'rm -rf -- "$work"' EXIT HUP INT TERM
  manifest_paths=$work/manifest-paths
  actual_paths=$work/actual-paths
  : >"$manifest_paths"; : >"$actual_paths"
  while IFS= read -r line || [[ -n $line ]]; do
    count=$((count+1)); [[ $count -le 10000 ]] || {
      printf 'Authenticated checksum manifest exceeds 10,000 entries.\n' >&2; return 1; }
    [[ $line =~ ^([0-9a-f]{64})\ \ \./([A-Za-z0-9._/-]+)$ ]] || {
      printf 'Authenticated checksum entry is noncanonical.\n' >&2; return 1; }
    digest=${BASH_REMATCH[1]}; relative=${BASH_REMATCH[2]}
    valid_backup_relative_path "$relative" || {
      printf 'Authenticated checksum path is unsafe.\n' >&2; return 1; }
    candidate="$root/$relative"
    [[ -f $candidate && ! -L $candidate ]] || {
      printf 'Authenticated backup object is missing, linked, or non-regular.\n' >&2; return 1; }
    resolved=$(realpath -e -- "$candidate")
    [[ $resolved == "$root_real"/* ]] || {
      printf 'Authenticated backup object escapes its root.\n' >&2; return 1; }
    [[ $(sha256_file "$candidate") == "$digest" ]] || {
      printf 'Authenticated backup object checksum mismatch.\n' >&2; return 1; }
    printf '%s\n' "$relative" >>"$manifest_paths"
  done <"$root/SHA256SUMS"
  [[ $count -gt 0 && -z $(LC_ALL=C sort "$manifest_paths" | uniq -d) ]] || {
    printf 'Authenticated checksum manifest is empty or has duplicate paths.\n' >&2; return 1; }
  while IFS= read -r -d '' candidate; do
    [[ ! -L $candidate && ( -f $candidate || -d $candidate ) ]] || {
      printf 'Backup tree contains a link or special entry.\n' >&2; return 1; }
    [[ -f $candidate ]] || continue
    relative=${candidate#"$root/"}
    case $relative in VERIFIED|JOURNAL_CONFIRMED|SHA256SUMS|SHA256SUMS.hmac) continue ;; esac
    valid_backup_relative_path "$relative" || {
      printf 'Backup filesystem contains an unsafe path.\n' >&2; return 1; }
    printf '%s\n' "$relative" >>"$actual_paths"
  done < <(find "$root" -mindepth 1 -print0)
  LC_ALL=C sort -o "$manifest_paths" "$manifest_paths"
  LC_ALL=C sort -o "$actual_paths" "$actual_paths"
  cmp -s "$manifest_paths" "$actual_paths" || {
    printf 'Authenticated manifest does not exactly cover backup payload files.\n' >&2; return 1; }
  printf verified
)
credential_tree_inventory() {
  local root=$1 output=$2 entry relative kind uid gid mode bytes digest count=0
  [[ -d $root && ! -L $root && -f $root/.env && ! -L $root/.env &&
     -d $root/secrets && ! -L $root/secrets && -d $root/tls && ! -L $root/tls ]] || return 1
  : >"$output"
  while IFS= read -r -d '' entry; do
    count=$((count+1)); [[ $count -le 4096 ]] || return 1
    [[ ! -L $entry ]] || return 1
    relative=${entry#"$root/"}
    [[ $relative =~ ^([.]env|secrets|tls)(/[A-Za-z0-9._-]+)*$ &&
       $relative != *'/../'* && $relative != *'//' ]] || return 1
    uid=$(stat -c %u -- "$entry"); gid=$(stat -c %g -- "$entry"); mode=$(stat -c %a -- "$entry")
    if [[ -d $entry ]]; then
      kind=D; bytes=-; digest=-
    elif [[ -f $entry ]]; then
      kind=F; bytes=$(stat -c %s -- "$entry"); digest=$(sha256_file "$entry")
      [[ $bytes =~ ^[0-9]+$ && $digest =~ ^[0-9a-f]{64}$ ]] || return 1
    else return 1
    fi
    printf '%s|%s|%s|%s|%s|%s|%s\n' "$kind" "$relative" "$uid" "$gid" "$mode" "$bytes" "$digest" >>"$output"
  done < <(find "$root/.env" "$root/secrets" "$root/tls" -mindepth 0 -print0)
  [[ $count -gt 0 ]] || return 1
  LC_ALL=C sort -o "$output" "$output"
  [[ -z $(cut -d'|' -f2 "$output" | LC_ALL=C sort | uniq -d) ]]
}
file_size() {
  if stat -c %s "$1" >/dev/null 2>&1; then stat -c %s "$1"; else stat -f %z "$1"; fi
}
journal_prefix_matches() {
  local expected_sha=$1 expected_bytes=$2 candidate=$3 actual_size actual_sha
  [[ $expected_sha =~ ^[0-9a-f]{64}$ && $expected_bytes =~ ^[1-9][0-9]*$ &&
     -f $candidate && ! -L $candidate ]] || return 1
  actual_size=$(wc -c <"$candidate" | tr -d '[:space:]')
  [[ $actual_size =~ ^[0-9]+$ && $actual_size -ge $expected_bytes ]] || return 1
  if command -v sha256sum >/dev/null 2>&1; then
    actual_sha=$(head -c "$expected_bytes" -- "$candidate" | sha256sum | awk '{print $1}')
  else
    actual_sha=$(head -c "$expected_bytes" -- "$candidate" | shasum --algorithm 256 | awk '{print $1}')
  fi
  [[ $actual_sha == "$expected_sha" ]]
}
emit_command_diagnostics() {
  local label=$1 log=$2
  [[ -f $log && ! -L $log ]] || return 0
  printf '%s failed; bounded diagnostics follow:\n' "$label" >&2
  tail -n 200 -- "$log" >&2 || true
}
append_live_backup_member() {
  local inventory=$1 kind=$2 member=$3 expected_sha=${4:-} expected_bytes=${5:-}
  local live result_sha result_bytes
  [[ $kind =~ ^(M|J|C|P|D)$ ]] || fail 'Retained backup expectation has an invalid member kind.'
  [[ $member =~ ^files/videos/retained-media/v1/[A-Za-z0-9._/-]+$ &&
     $member != *'/../'* && $member != */.. && $member != *'//' ]] ||
    fail 'Retained backup expectation has an unsafe member path.'
  live=$(compose exec -T oscar sh -eu -c '
    path=/var/lib/oscar/$1
    [ -f "$path" ] && [ ! -L "$path" ]
    size=$(stat -c %s -- "$path")
    [ "$size" -gt 0 ]
    sha=$(sha256sum -- "$path" | awk "{print \$1}")
    printf "%s|%s\\n" "$sha" "$size"
  ' retained-backup-member "$member") || fail "Expected retained backup member is missing or unsafe: $member"
  IFS='|' read -r result_sha result_bytes extra <<<"$live"
  [[ -z ${extra:-} && $result_sha =~ ^[0-9a-f]{64}$ && $result_bytes =~ ^[1-9][0-9]*$ ]] ||
    fail 'Retained backup member snapshot returned invalid hash/size metadata.'
  [[ -z $expected_sha || $result_sha == "$expected_sha" ]] ||
    fail "Live retained frame hash does not match its authenticated API manifest: $member"
  [[ -z $expected_bytes || $result_bytes == "$expected_bytes" ]] ||
    fail "Live retained frame size does not match its authenticated API manifest: $member"
  printf '%s|%s|%s|%s\n' "$kind" "$member" "$result_sha" "$result_bytes" >>"$inventory"
}
append_quiesced_backup_member() {
  local inventory=$1 kind=$2 member=$3 image=$4 expected_sha=${5:-} expected_bytes=${6:-}
  local snapshot result_sha result_bytes extra
  [[ $kind =~ ^(M|J|C|P|D)$ && -n $image ]] ||
    fail 'Quiesced retained backup expectation has an invalid member kind or image.'
  [[ $member =~ ^files/videos/retained-media/v1/[A-Za-z0-9._/-]+$ &&
     $member != *'/../'* && $member != */.. && $member != *'//' ]] ||
    fail 'Quiesced retained backup expectation has an unsafe member path.'
  snapshot=$(docker run --rm --network none --read-only --cap-drop ALL \
    --security-opt no-new-privileges --workdir / --user 10001:10001 --entrypoint sh \
    --volume oscar_oscar_state:/state:ro "$image" -eu -c '
      path=/state/$1
      [ -f "$path" ] && [ ! -L "$path" ]
      size=$(stat -c %s -- "$path")
      [ "$size" -gt 0 ]
      sha=$(sha256sum -- "$path" | awk "{print \$1}")
      printf "%s|%s\\n" "$sha" "$size"
    ' retained-backup-member "$member") ||
    fail "Expected quiesced retained backup member is missing or unsafe: $member"
  IFS='|' read -r result_sha result_bytes extra <<<"$snapshot"
  [[ -z ${extra:-} && $result_sha =~ ^[0-9a-f]{64}$ && $result_bytes =~ ^[1-9][0-9]*$ ]] ||
    fail 'Quiesced retained backup member snapshot returned invalid hash/size metadata.'
  [[ -z $expected_sha || $result_sha == "$expected_sha" ]] ||
    fail "Quiesced retained frame hash does not match its authenticated API manifest: $member"
  [[ -z $expected_bytes || $result_bytes == "$expected_bytes" ]] ||
    fail "Quiesced retained frame size does not match its authenticated API manifest: $member"
  printf '%s|%s|%s|%s\n' "$kind" "$member" "$result_sha" "$result_bytes" >>"$inventory"
}
copy_quiesced_confirmation_member() {
  local member=$1 destination=$2 image=$3 byte_limit=$4 actual_bytes
  [[ -n $image && $byte_limit =~ ^[1-9][0-9]*$ && $byte_limit -le 1048576 ]] ||
    fail 'Quiesced daily-journal confirmation copy has invalid bounds.'
  [[ $member =~ ^files/[.]dailyfile-journal/backup-confirmations/([.]sets/[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}|[A-Za-z0-9._-]+/[0-9]{4}-[0-9]{2}-[0-9]{2})[.]json$ ]] ||
    fail 'Quiesced daily-journal confirmation member has an unsafe path.'
  docker run --rm --network none --read-only --cap-drop ALL \
    --security-opt no-new-privileges --workdir / --user 10001:10001 --entrypoint sh \
    --volume oscar_oscar_state:/state:ro "$image" -eu -c '
      member=$1
      limit=$2
      path=/state/$member
      current=/state
      old_ifs=$IFS
      IFS=/
      set -- $member
      IFS=$old_ifs
      for component do
        [ -n "$component" ] && [ "$component" != . ] && [ "$component" != .. ]
        current=$current/$component
        [ ! -L "$current" ]
      done
      [ -f "$path" ]
      size=$(stat -c %s -- "$path")
      [ "$size" -gt 0 ] && [ "$size" -le "$limit" ]
      cat -- "$path"
    ' live-journal-confirmation "$member" "$byte_limit" >"$destination" ||
    fail "Required quiesced daily-journal confirmation member is missing or unsafe: $member"
  [[ -f $destination && ! -L $destination ]] ||
    fail 'Quiesced daily-journal confirmation copy is not a regular file.'
  actual_bytes=$(file_size "$destination")
  [[ $actual_bytes =~ ^[1-9][0-9]*$ && $actual_bytes -le $byte_limit ]] ||
    fail 'Quiesced daily-journal confirmation copy violated its byte bound.'
}
verify_retained_backup_members() {
  local archive=$1 inventory=$2 work=$3 listing member_file line kind member expected_sha expected_bytes
  local lookup matches raw verbose actual_sha actual_bytes header verified=0
  [[ -f $archive && ! -L $archive && -f $inventory && ! -L $inventory && -s $inventory &&
     -d $work && ! -L $work ]] || fail 'Retained backup verification inputs are missing or unsafe.'
  listing=$work/state-members.txt
  tar -tzf "$archive" >"$listing"
  [[ $(wc -l <"$listing" | tr -d '[:space:]') -le 200000 ]] ||
    fail 'OSCAR state backup member inventory exceeds its 200,000-entry safety bound.'
  ! grep -Eq '(^/|(^|/)[.][.](/|$))' "$listing" ||
    fail 'OSCAR state backup contains an absolute or traversal member.'
  [[ $(cut -d'|' -f2 "$inventory" | LC_ALL=C sort | uniq -d | wc -l | tr -d '[:space:]') == 0 ]] ||
    fail 'Retained backup expectation contains duplicate member identities.'
  while IFS='|' read -r kind member expected_sha expected_bytes extra; do
    [[ -z ${extra:-} && $kind =~ ^(M|J|C|P|D)$ &&
       $member =~ ^files/videos/retained-media/v1/[A-Za-z0-9._/-]+$ &&
       $expected_sha =~ ^[0-9a-f]{64}$ && $expected_bytes =~ ^[1-9][0-9]*$ ]] ||
      fail 'Retained backup expectation inventory is malformed.'
    lookup=$(awk -v expected="$member" '
      { normalized=$0; if (substr(normalized,1,2)=="./") normalized=substr(normalized,3);
        if (normalized==expected) { count++; raw=$0 } }
      END { printf "%d|%s", count+0, raw }
    ' "$listing")
    IFS='|' read -r matches raw <<<"$lookup"
    [[ $matches == 1 && -n $raw ]] ||
      fail "Backup must contain exactly one expected retained member: $member"
    verbose=$(tar -tvzf "$archive" -- "$raw")
    [[ $(printf '%s\n' "$verbose" | wc -l | tr -d '[:space:]') == 1 ]] ||
      fail "Backup retained member has an ambiguous archive type: $member"
    [[ ${verbose:0:1} == - ]] || fail "Backup retained member is not a regular file: $member"
    member_file=$work/member-$verified
    tar -xOf "$archive" -- "$raw" >"$member_file"
    [[ -f $member_file && ! -L $member_file ]] || fail "Could not stream retained backup member: $member"
    actual_sha=$(sha256_file "$member_file")
    actual_bytes=$(file_size "$member_file")
    [[ $actual_sha == "$expected_sha" && $actual_bytes == "$expected_bytes" ]] ||
      fail "Retained backup member hash or size changed: $member"
    case $kind in
      J)
        header=$(od -An -tx1 -N2 -- "$member_file" | tr -d ' [:space:]')
        [[ $header == ffd8 && $(tail -c 2 -- "$member_file" | od -An -tx1 | tr -d ' [:space:]') == ffd9 ]] ||
          fail "Retained backup JPEG has an invalid content type: $member"
        ;;
      M|C)
        grep -Eq '^[[:space:]]*[{]' "$member_file" && grep -Eq '[}][[:space:]]*$' "$member_file" ||
          fail "Retained backup JSON has an invalid content type: $member"
        ;;
      P)
        header=$(od -An -tx1 -N16 -- "$member_file" | tr -d ' [:space:]')
        [[ $header == 4f534341524d50490000000100000024 && $actual_bytes -ge 16 &&
           $(((actual_bytes-16)%36)) -eq 0 ]] ||
          fail "Retained backup processed index has an invalid content type: $member"
        ;;
      D)
        header=$(od -An -tx1 -N16 -- "$member_file" | tr -d ' [:space:]')
        [[ $header == 4f534341524d44490000000100000024 && $actual_bytes -ge 16 &&
           $(((actual_bytes-16)%36)) -eq 0 ]] ||
          fail "Retained backup deletion index has an invalid content type: $member"
        ;;
    esac
    verified=$((verified+1))
  done <"$inventory"
  printf '%s' "$verified"
}
verify_daily_receipt_backup_members() {
  local archive=$1 listing=$2 directory_id=$3 day=$4 inventory=$5 work=$6
  local expected_names actual_names prefix name expected_bytes expected_sha lookup matches raw verbose member
  local actual_bytes actual_sha verified=0
  [[ -f $archive && ! -L $archive && -f $listing && ! -L $listing &&
     $directory_id =~ ^[A-Za-z0-9._-]+$ &&
     $day =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ && -s $inventory ]] || return 1
  expected_names=$(mktemp "$work/expected-segments.XXXXXXXX")
  actual_names=$(mktemp "$work/actual-segments.XXXXXXXX")
  : >"$expected_names"; : >"$actual_names"
  prefix="files/.dailyfile-journal/segments/$directory_id/$day/"
  while IFS='|' read -r name expected_bytes expected_sha extra; do
    [[ -z ${extra:-} && $name =~ ^[0-9]{6}[.]seg$ &&
       $expected_bytes =~ ^[1-9][0-9]*$ && $expected_sha =~ ^[0-9a-f]{64}$ ]] || return 1
    printf '%s\n' "$name" >>"$expected_names"
    lookup=$(awk -v expected="$prefix$name" '
      { normalized=$0; if (substr(normalized,1,2)=="./") normalized=substr(normalized,3);
        if (normalized==expected) { count++; raw=$0 } }
      END { printf "%d|%s", count+0, raw }
    ' "$listing")
    IFS='|' read -r matches raw <<<"$lookup"
    [[ $matches == 1 && -n $raw ]] || return 1
    verbose=$(tar -tvzf "$archive" -- "$raw")
    [[ $(printf '%s\n' "$verbose" | wc -l | tr -d '[:space:]') == 1 && ${verbose:0:1} == - ]] || return 1
    member=$(mktemp "$work/daily-segment.XXXXXXXX")
    tar -xOf "$archive" -- "$raw" >"$member"
    actual_bytes=$(file_size "$member"); actual_sha=$(sha256_file "$member")
    [[ $actual_bytes == "$expected_bytes" && $actual_sha == "$expected_sha" ]] || return 1
    rm -f -- "$member"
    verified=$((verified+1))
  done <"$inventory"
  [[ $verified -gt 0 && -z $(LC_ALL=C sort "$expected_names" | uniq -d) ]] || return 1
  awk -v prefix="$prefix" '
    { normalized=$0; if (substr(normalized,1,2)=="./") normalized=substr(normalized,3);
      if (index(normalized,prefix)==1) {
        name=substr(normalized,length(prefix)+1)
        if (name ~ /^[0-9]{6}[.](seg|open)$/) print name
      }
    }
  ' "$listing" | LC_ALL=C sort >"$actual_names"
  LC_ALL=C sort -o "$expected_names" "$expected_names"
  cmp -s "$expected_names" "$actual_names" || return 1
  printf '%s' "$verified"
}
file_owner_id() { if stat -c %u "$1" >/dev/null 2>&1; then stat -c %u "$1"; else stat -f %u "$1"; fi; }
file_group_id() { if stat -c %g "$1" >/dev/null 2>&1; then stat -c %g "$1"; else stat -f %g "$1"; fi; }
file_mode() { if stat -c %a "$1" >/dev/null 2>&1; then stat -c %a "$1"; else stat -f %Lp "$1"; fi; }
identity_value() {
  local marker=$1 name=$2
  awk -F= -v name="$name" '$1 == name { print substr($0, index($0, "=") + 1); exit }' "$marker"
}
storage_root_identity_json() {
  local root=$1 expected_kind=$2 expected_deployment=$3 expected_group expected_mode marker
  local format version deployment_id root_kind adoption claimed_at adopted_at adopted_by
  local marker_owner marker_group marker_mode root_owner root_group root_mode exact=false
  marker="$root/.oscar-storage-root"
  [[ -d $root && ! -L $root && -f $marker && ! -L $marker ]] ||
    fail "Storage root or identity marker is missing, linked, or non-regular: $root"
  format=$(identity_value "$marker" format)
  version=$(identity_value "$marker" version)
  deployment_id=$(identity_value "$marker" deployment_id)
  root_kind=$(identity_value "$marker" root_kind)
  adoption=$(identity_value "$marker" adoption)
  claimed_at=$(identity_value "$marker" claimed_at)
  adopted_at=$(identity_value "$marker" adopted_at)
  adopted_by=$(identity_value "$marker" adopted_by)
  marker_owner=$(file_owner_id "$marker"); marker_group=$(file_group_id "$marker"); marker_mode=$(file_mode "$marker")
  root_owner=$(file_owner_id "$root"); root_group=$(file_group_id "$root"); root_mode=$(file_mode "$root")
  case $expected_kind in
    archive) expected_group=10001; expected_mode=1770 ;;
    wal-archive) expected_group=999; expected_mode=1770 ;;
    backup) expected_group=0; expected_mode=700 ;;
    *) fail "Unknown expected storage-root kind: $expected_kind" ;;
  esac
  if [[ $(wc -l <"$marker" | tr -d '[:space:]') == 8 &&
        $(grep -Fxc 'format=oscar-storage-root-identity' "$marker") == 1 &&
        $(grep -Fxc 'version=1' "$marker") == 1 &&
        $(grep -Fxc "deployment_id=$expected_deployment" "$marker") == 1 &&
        $(grep -Fxc "root_kind=$expected_kind" "$marker") == 1 &&
        $(grep -Ec '^adoption=(new|explicit-existing)$' "$marker") == 1 &&
        $(grep -Ec '^claimed_at=[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$' "$marker") == 1 &&
        $(grep -Ec '^adopted_at=(none|[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z)$' "$marker") == 1 &&
        $(grep -Ec '^adopted_by=(none|[A-Za-z0-9_.@-]{1,128})$' "$marker") == 1 &&
        $format == oscar-storage-root-identity && $version == 1 &&
        $deployment_id == "$expected_deployment" && $root_kind == "$expected_kind" &&
        $marker_owner == 0 && $marker_group == 0 && $marker_mode == 600 &&
        $root_owner == 0 && $root_group == "$expected_group" && $root_mode == "$expected_mode" ]] &&
     { [[ $adoption == new && $adopted_at == none && $adopted_by == none ]] ||
       [[ $adoption == explicit-existing && $adopted_at != none && $adopted_by != none ]]; }; then
    exact=true
  fi
  for value in "$format" "$version" "$deployment_id" "$root_kind" "$adoption" "$claimed_at" "$adopted_at" "$adopted_by" \
    "$marker_owner" "$marker_group" "$marker_mode" "$root_owner" "$root_group" "$root_mode"; do safe_json_text "$value"; done
  printf '{"format":"%s","version":"%s","deploymentId":"%s","rootKind":"%s",' \
    "$format" "$version" "$deployment_id" "$root_kind"
  printf '"adoption":"%s","claimedAt":"%s","adoptedAt":"%s","adoptedBy":"%s",' \
    "$adoption" "$claimed_at" "$adopted_at" "$adopted_by"
  printf '"markerOwner":%s,"markerGroup":%s,"markerMode":"%s","rootOwner":%s,"rootGroup":%s,"rootMode":"%s","exact":%s}' \
    "$marker_owner" "$marker_group" "$marker_mode" "$root_owner" "$root_group" "$root_mode" "$exact"
}
image_id() { docker image inspect "$1" --format '{{.Id}}'; }
container_image_id() {
  local container
  container=$(compose ps -q "$1")
  [[ -n $container ]] || fail "Compose service is not created: $1"
  docker inspect "$container" --format '{{.Image}}'
}
image_label() {
  local value
  value=$(docker image inspect "$1" --format "{{ index .Config.Labels \"$2\" }}" 2>/dev/null || true)
  [[ $value == '<no value>' ]] && value=''
  printf '%s' "$value"
}
repo_digests_json() {
  local reference=$1 digest first=true
  printf '['
  while IFS= read -r digest; do
    [[ -n $digest ]] || continue
    [[ $digest =~ ^[A-Za-z0-9._/:@+-]+@sha256:[0-9a-f]{64}$ ]] ||
      fail "Image has an unsafe repository digest: $reference"
    $first || printf ','
    printf '"%s"' "$digest"
    first=false
  done < <(docker image inspect "$reference" --format '{{range .RepoDigests}}{{println .}}{{end}}')
  printf ']'
}
ensure_fixture_table() {
  psql_admin --command "CREATE TABLE IF NOT EXISTS oscar_regression_fixture (
    run_id text PRIMARY KEY CHECK (run_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$'),
    cold_id bigint NOT NULL UNIQUE, hot_id bigint NOT NULL UNIQUE, datastream_id bigint NOT NULL,
    cold_time timestamptz NOT NULL, hot_time timestamptz NOT NULL,
    generation_id uuid, created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS oscar_regression_fixture_allocator (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    leased_high_water bigint NOT NULL CHECK (leased_high_water > 0)
  );" >/dev/null
}
create_observation_fixture() {
  local run=$1 cold_time_sql=$2 hot_time_sql=$3 fixture_json
  # PostgisStore allocates positive observation IDs from an in-process AtomicLong
  # initialized from the durable hot/archive high-water. Keep direct SQL fixtures
  # in a test-only lease over 2^40 IDs beyond that high-water. The singleton
  # allocator UPSERT takes a PostgreSQL row lock and computes each new lease
  # from the latest committed allocator value, even when concurrent statements
  # began with the same READ COMMITTED snapshot. The obs primary key still
  # fails the entire statement if an outside writer reaches either candidate.
  # The archived cold ID is the top of the lease so its durable generation
  # high-water prevents the deleted hot ID from becoming the restart next ID.
  fixture_json=$(json_query "WITH source AS MATERIALIZED (
      SELECT o.* FROM obs o JOIN obs_datastreams d ON d.id=o.datastreamid
      WHERE d.data->>'outputName'='gammaCounts' AND o.archivegenerationid IS NULL
      ORDER BY o.id DESC LIMIT 1),
    fixture_clock AS MATERIALIZED (SELECT clock_timestamp() sampled_at),
    high_water AS MATERIALIZED (
      SELECT greatest(
        coalesce((SELECT max(id) FROM obs),0),
        coalesce((SELECT max(max_id) FROM oscar_archive_generation),0),
        coalesce((SELECT max(greatest(cold_id,hot_id)) FROM oscar_regression_fixture),0)
      ) id),
    allocated AS MATERIALIZED (
      INSERT INTO oscar_regression_fixture_allocator(singleton,leased_high_water)
      SELECT true,high_water.id+1099511627778 FROM high_water CROSS JOIN source
      WHERE high_water.id BETWEEN 0 AND 9223370937343148029
        AND NOT EXISTS (SELECT 1 FROM oscar_regression_fixture WHERE run_id='$run')
      ON CONFLICT (singleton) DO UPDATE SET leased_high_water=greatest(
        oscar_regression_fixture_allocator.leased_high_water,
        EXCLUDED.leased_high_water-1099511627778)+1099511627778
      WHERE greatest(oscar_regression_fixture_allocator.leased_high_water,
        EXCLUDED.leased_high_water-1099511627778) BETWEEN 0 AND 9223370937343148029
      RETURNING leased_high_water cold_id,leased_high_water-1 hot_id),
    collision_free AS MATERIALIZED (
      SELECT a.* FROM allocated a
      WHERE NOT EXISTS (SELECT 1 FROM obs WHERE id IN (a.cold_id,a.hot_id))
        AND NOT EXISTS (SELECT 1 FROM oscar_regression_fixture
          WHERE cold_id IN (a.cold_id,a.hot_id) OR hot_id IN (a.cold_id,a.hot_id))
        AND NOT EXISTS (SELECT 1 FROM oscar_archive_generation
          WHERE a.cold_id BETWEEN min_id AND max_id OR a.hot_id BETWEEN min_id AND max_id)
        AND NOT EXISTS (SELECT 1 FROM oscar_archive_id_block
          WHERE a.cold_id BETWEEN min_id AND max_id OR a.hot_id BETWEEN min_id AND max_id)
        AND NOT EXISTS (SELECT 1 FROM oscar_obs_overlay
          WHERE observation_id IN (a.cold_id,a.hot_id))),
    cold AS (INSERT INTO obs(id,datastreamid,foiid,phenomenontime,resulttime,result)
      SELECT allocation.cold_id,source.datastreamid,source.foiid,$cold_time_sql,$cold_time_sql,source.result
      FROM source CROSS JOIN collision_free allocation CROSS JOIN fixture_clock RETURNING *),
    hot AS (INSERT INTO obs(id,datastreamid,foiid,phenomenontime,resulttime,result)
      SELECT allocation.hot_id,source.datastreamid,source.foiid,$hot_time_sql,$hot_time_sql,source.result
      FROM source CROSS JOIN collision_free allocation CROSS JOIN fixture_clock RETURNING *),
    registry AS (INSERT INTO oscar_regression_fixture(run_id,cold_id,hot_id,datastream_id,cold_time,hot_time)
      SELECT '$run',cold.id,hot.id,cold.datastreamid,cold.phenomenontime,hot.phenomenontime
      FROM cold,hot RETURNING *)
    SELECT json_build_object('runId',run_id,'coldId',cold_id::text,'hotId',hot_id::text,
      'datastreamId',datastream_id,'coldTime',cold_time,'hotTime',hot_time) FROM registry;")
  [[ $fixture_json == \{* ]] ||
    fail 'Could not allocate two collision-free test observation IDs below the signed BIGINT limit.'
  printf '%s\n' "$fixture_json"
}

case $action in
  camera-recording-log-start)
    (($# == 0)) || fail 'Camera-recording log start accepts no arguments.'
    camera_log_started_at=$(date --utc +%Y-%m-%dT%H:%M:%S.%NZ)
    [[ $camera_log_started_at =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{9}Z$ ]] ||
      fail 'Could not capture a valid camera-recording log start time.'
    printf '{"startedAt":"%s"}\n' "$camera_log_started_at"
    ;;
  camera-recording-log-check)
    camera_log_started_at=${1:-}
    (($# == 1)) || fail 'Camera-recording log check requires exactly one start time.'
    [[ $camera_log_started_at =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{9}Z$ ]] ||
      fail 'Camera-recording log check start time is invalid.'
    camera_log=$(mktemp /tmp/oscar-camera-recording-log.XXXXXX)
    cleanup_camera_log() { rm -f -- "$camera_log"; }
    trap cleanup_camera_log EXIT
    if ! compose logs --since "$camera_log_started_at" oscar >"$camera_log" 2>&1; then
      emit_command_diagnostics 'Camera-recording service-log collection' "$camera_log"
      fail 'Could not collect the exact camera-recording service log window.'
    fi
    camera_timeout_quarantines=$(grep -Eic \
      'Timed out waiting for camera .* command; quarantining its queue' "$camera_log" || true)
    camera_queue_rejections=$(grep -Eic \
      'Camera .* command queue is quarantined' "$camera_log" || true)
    recording_result_timeouts=$(grep -Eic \
      'Timed out waiting for video files for occupancy generation' "$camera_log" || true)
    stale_generation_results=$(grep -Eic \
      'returned a stale or mismatched saved-video result for occupancy generation' "$camera_log" || true)
    camera_command_failures=$(grep -Eic \
      'Camera .* failed to close occupancy generation|Failed to finish matched camera recording generation' \
      "$camera_log" || true)
    printf '{"timeoutQuarantines":%s,"queueRejections":%s,"recordingResultTimeouts":%s,' \
      "$camera_timeout_quarantines" "$camera_queue_rejections" "$recording_result_timeouts"
    printf '"staleGenerationResults":%s,"cameraCommandFailures":%s}\n' \
      "$stale_generation_results" "$camera_command_failures"
    cleanup_camera_log
    trap - EXIT
    ;;
  alarm-media-baseline)
    run=${1:-}
    (($# == 1)) || fail 'Alarm-media baseline requires exactly one run ID.'
    valid_run "$run" || fail 'Alarm-media baseline requires a valid run ID.'
    marker=$(alarm_media_marker "$run")
    [[ ! -e $marker && ! -L $marker ]] || fail 'Alarm-media baseline marker already exists.'
    artifacts=$(alarm_all_camera_artifacts)
    marker_tmp=$(mktemp "/tmp/.oscar-alarm-media-$run.XXXXXX")
    cleanup_alarm_baseline() { rm -f -- "$marker_tmp"; }
    trap cleanup_alarm_baseline EXIT
    {
      printf 'version\t2\n'
      [[ -z $artifacts ]] || printf '%s\n' "$artifacts"
    } >"$marker_tmp"
    chmod 600 "$marker_tmp"
    ln -- "$marker_tmp" "$marker"
    rm -f -- "$marker_tmp"
    trap - EXIT
    baseline_finalized=$(awk -F '\t' '$1=="final" {count++} END {print count+0}' "$marker")
    baseline_partials=$(awk -F '\t' '$1=="partial" {count++} END {print count+0}' "$marker")
    printf '{"baselineCreated":true,"baselineFinalized":%s,"baselinePartials":%s}\n' \
      "$baseline_finalized" "$baseline_partials"
    ;;
  alarm-media-cleanup)
    run=${1:-}
    (($# == 1)) || fail 'Alarm-media cleanup requires exactly one run ID.'
    valid_run "$run" || fail 'Alarm-media cleanup requires a valid run ID.'
    marker=$(alarm_media_marker "$run")
    if [[ ! -e $marker && ! -L $marker ]]; then
      printf '{"removed":false}\n'
      exit 0
    fi
    [[ -f $marker && ! -L $marker && $(file_owner_id "$marker") == 0 && $(file_mode "$marker") == 600 ]] ||
      fail 'Alarm-media cleanup refused an unsafe baseline marker.'
    [[ $(grep -Fxc $'version\t2' "$marker") == 1 ]] ||
      fail 'Alarm-media cleanup refused an unknown baseline marker.'
    rm -f -- "$marker"
    printf '{"removed":true}\n'
    ;;
  alarm-media-source-status)
    (($# > 0)) || fail 'Alarm-media source status requires at least one path.'
    source_paths=$#
    source_existing=0
    source_nonzero=0
    for source_path in "$@"; do
      valid_alarm_video_path "$source_path" || fail "Alarm-media source path is invalid: $source_path"
      source_status=$(compose exec -T oscar sh -eu -c '
        source=/var/lib/oscar/files/$1
        if test -f "$source" && test ! -L "$source"; then
          bytes=$(wc -c <"$source" | tr -d "[:space:]")
          printf "1\\t%s\\n" "${bytes:-0}"
        else
          printf "0\\t0\\n"
        fi
      ' alarm-media-source "$source_path")
      source_exists=${source_status%%$'\t'*}
      source_bytes=${source_status#*$'\t'}
      [[ $source_exists == 1 ]] && source_existing=$((source_existing+1))
      [[ $source_bytes =~ ^[0-9]+$ ]] || fail 'Alarm-media source returned an invalid byte count.'
      ((source_bytes > 0)) && source_nonzero=$((source_nonzero+1))
    done
    printf '{"paths":%s,"existing":%s,"nonzero":%s}\n' \
      "$source_paths" "$source_existing" "$source_nonzero"
    ;;
  alarm-media-ledger)
    event_token=${1:-}; lane_token=${2:-}; camera_token=${3:-}
    (($# == 3)) || fail 'Alarm-media ledger requires event, lane, and camera tokens.'
    valid_media_token "$event_token" && valid_media_token "$lane_token" && valid_media_token "$camera_token" ||
      fail 'Alarm-media ledger token is invalid.'
    ledger_key="retained-media/v1/events/$event_token/lanes/$lane_token/cameras/$camera_token/.job.json"
    ledger_json=$(compose exec -T oscar sh -eu -c '
      ledger=/var/lib/oscar/files/videos/$1
      if test ! -f "$ledger" || test -L "$ledger"; then
        printf "MISSING\\n"
        exit 0
      fi
      cat -- "$ledger"
    ' alarm-media-ledger "$ledger_key")
    if [[ $ledger_json == MISSING ]]; then
      printf '{"exists":false}\n'
    else
      compact=$(printf '%s' "$ledger_json" | tr -d '\r\n')
      case $compact in \{*\}) ;; *) fail 'Alarm-media ledger is not a JSON object.' ;; esac
      printf '{"exists":true,"ledger":%s}\n' "$compact"
    fi
    ;;
  alarm-media-forensics)
    run=${1:-}; shift || true
    valid_run "$run" || fail 'Alarm-media forensics requires a valid run ID.'
    (($# > 0)) || fail 'Alarm-media forensics requires generated source paths.'
    marker=$(alarm_media_marker "$run")
    [[ -f $marker && ! -L $marker && $(file_owner_id "$marker") == 0 && $(file_mode "$marker") == 600 ]] ||
      fail 'Alarm-media baseline marker is missing or unsafe.'
    [[ $(grep -Fxc $'version\t2' "$marker") == 1 ]] || fail 'Alarm-media baseline marker has an unknown version.'
    for source_path in "$@"; do valid_alarm_video_path "$source_path" || fail 'Generated alarm-media path is invalid.'; done
    forensic_tmp=$(mktemp -d "/tmp/.oscar-alarm-media-forensics-$run.XXXXXX")
    cleanup_alarm_forensics() { rm -rf -- "$forensic_tmp"; }
    trap cleanup_alarm_forensics EXIT
    printf '%s\n' "$@" | sort -u >"$forensic_tmp/expected"
    [[ $(wc -l <"$forensic_tmp/expected" | tr -d '[:space:]') == $# ]] ||
      fail 'Generated alarm-media paths contain duplicates.'
    cut -d/ -f3 "$forensic_tmp/expected" | sort -u >"$forensic_tmp/cameras"
    awk -F '\t' 'NR==FNR {camera[$1]=1; next} $1=="final" {split($2,path,"/"); if (camera[path[3]]) print $2}' \
      "$forensic_tmp/cameras" "$marker" | sort -u >"$forensic_tmp/baseline-final"
    awk -F '\t' 'NR==FNR {camera[$1]=1; next} $1=="partial" {split($2,path,"/"); if (camera[path[3]]) print $2}' \
      "$forensic_tmp/cameras" "$marker" | sort -u >"$forensic_tmp/baseline-partial"
    alarm_all_camera_artifacts >"$forensic_tmp/current-all"
    awk -F '\t' 'NR==FNR {camera[$1]=1; next} $1=="final" {split($2,path,"/"); if (camera[path[3]]) print $2}' \
      "$forensic_tmp/cameras" "$forensic_tmp/current-all" | sort -u >"$forensic_tmp/current-final"
    awk -F '\t' 'NR==FNR {camera[$1]=1; next} $1=="partial" {split($2,path,"/"); if (camera[path[3]]) print $2}' \
      "$forensic_tmp/cameras" "$forensic_tmp/current-all" | sort -u >"$forensic_tmp/current-partial"
    comm -13 "$forensic_tmp/baseline-final" "$forensic_tmp/current-final" >"$forensic_tmp/new-final"
    expected_paths=$(wc -l <"$forensic_tmp/expected" | tr -d '[:space:]')
    current_expected=$(comm -12 "$forensic_tmp/expected" "$forensic_tmp/current-final" | wc -l | tr -d '[:space:]')
    new_finalized=$(wc -l <"$forensic_tmp/new-final" | tr -d '[:space:]')
    new_orphans=$(comm -23 "$forensic_tmp/new-final" "$forensic_tmp/expected" | wc -l | tr -d '[:space:]')
    new_partials=$(comm -13 "$forensic_tmp/baseline-partial" "$forensic_tmp/current-partial" | wc -l | tr -d '[:space:]')
    baseline_collisions=$(comm -12 "$forensic_tmp/expected" "$forensic_tmp/baseline-final" | wc -l | tr -d '[:space:]')
    rm -f -- "$marker"
    printf '{"baselineFound":true,"expectedPaths":%s,"currentExpectedPaths":%s,' \
      "$expected_paths" "$current_expected"
    printf '"newFinalizedPaths":%s,"newFinalizedOrphans":%s,"newPartialArtifacts":%s,' \
      "$new_finalized" "$new_orphans" "$new_partials"
    printf '"expectedAlreadyPresentAtBaseline":%s}\n' "$baseline_collisions"
    ;;
  platform)
    expected_release=3.9.2
    configured_release=$(env_value OSCAR_VERSION missing)
    template_release=$(awk -F= '$1 == "OSCAR_VERSION" { print substr($0, index($0, "=") + 1); exit }' .env.example)
    deployment_id=$(env_value OSCAR_DEPLOYMENT_ID missing)
    valid_deployment_id "$deployment_id" || fail 'OSCAR_DEPLOYMENT_ID is missing or is not a lowercase UUID.'
    archive_dir=$(realpath -e -- "$(absolute_path "$(env_value OSCAR_ARCHIVE_DIR ../oscar-storage/archive)")")
    wal_archive_dir=$(realpath -e -- "$(absolute_path "$(env_value OSCAR_WAL_ARCHIVE_DIR ../oscar-storage/wal-archive)")")
    backup_dir=$(realpath -e -- "$(absolute_path "$(env_value OSCAR_BACKUP_DIR ../oscar-storage/backups)")")
    archive_identity=$(storage_root_identity_json "$archive_dir" archive "$deployment_id")
    wal_identity=$(storage_root_identity_json "$wal_archive_dir" wal-archive "$deployment_id")
    backup_identity=$(storage_root_identity_json "$backup_dir" backup "$deployment_id")

    packaged_wal_helper=postgis/archive-wal.sh
    packaged_archive_helper=docker/oscar/archive-object-helper.sh
    packaged_prepare_restore_helper=postgis/prepare-restore.sh
    packaged_merge_wal_restore_helper=postgis/merge-wal-restore.sh
    packaged_atomic_source=docker/oscar/atomic-publish.c
    packaged_entrypoint=docker/oscar/entrypoint.sh
    [[ -f $packaged_wal_helper && ! -L $packaged_wal_helper &&
       -f $packaged_archive_helper && ! -L $packaged_archive_helper &&
       -f $packaged_prepare_restore_helper && ! -L $packaged_prepare_restore_helper &&
       -f $packaged_merge_wal_restore_helper && ! -L $packaged_merge_wal_restore_helper &&
       -f $packaged_atomic_source && ! -L $packaged_atomic_source &&
       -f $packaged_entrypoint && ! -L $packaged_entrypoint ]] ||
      fail 'A packaged storage helper is missing, linked, or non-regular.'
    packaged_wal_sha=$(sha256_file "$packaged_wal_helper")
    packaged_archive_sha=$(sha256_file "$packaged_archive_helper")
    packaged_prepare_restore_sha=$(sha256_file "$packaged_prepare_restore_helper")
    packaged_merge_wal_restore_sha=$(sha256_file "$packaged_merge_wal_restore_helper")
    packaged_atomic_source_sha=$(sha256_file "$packaged_atomic_source")
    packaged_entrypoint_sha=$(sha256_file "$packaged_entrypoint")
    entrypoint_tmp_contract=false
    if entrypoint_has_managed_tmp_contract "$packaged_entrypoint"; then
      entrypoint_tmp_contract=true
    fi
    wal_publication_contract=false
    if grep -Fq 'cmp -s -- "$source_path" "$destination"' "$packaged_wal_helper" &&
       grep -Fq 'sync -d "$partial"' "$packaged_wal_helper" &&
       grep -Fq 'if ln -- "$partial" "$destination"' "$packaged_wal_helper" &&
       grep -Fq 'sync -d "$destination"' "$packaged_wal_helper" &&
       grep -Fq 'sync -f "$archive_root"' "$packaged_wal_helper" &&
       ! grep -Eq '^[[:space:]]*mv[[:space:]]+-n([[:space:]]|$)' "$packaged_wal_helper"; then
      wal_publication_contract=true
    fi
    archive_export_helper_wired=false
    grep -Eq '^[[:space:]]+archive_object_helper copy "\$relative" "\$expected_sha" ro "\$partial"$' oscar-storage.sh &&
      archive_export_helper_wired=true
    archive_purge_helper_wired=false
    # The purge loop reads its work list from standard input. Require the
    # helper subprocess to detach from that stream so it cannot consume the
    # remaining object rows and silently leave a multi-object plan partial.
    grep -Eq '^[[:space:]]+delete_outcome=\$\(archive_object_helper delete "\$relative" "\$expected_sha" rw </dev/null\)$' oscar-storage.sh &&
      archive_purge_helper_wired=true
    wal_helper_regular=false
    compose exec -T postgres sh -c 'test -f /usr/local/bin/oscar-archive-wal && test ! -L /usr/local/bin/oscar-archive-wal && test -x /usr/local/bin/oscar-archive-wal' && wal_helper_regular=true
    archive_helper_regular=false
    compose exec -T oscar sh -c 'test -f /usr/local/bin/oscar-archive-object && test ! -L /usr/local/bin/oscar-archive-object && test -x /usr/local/bin/oscar-archive-object' && archive_helper_regular=true
    prepare_restore_helper_regular=false
    compose exec -T postgres sh -c 'test -f /usr/local/bin/oscar-prepare-restore && test ! -L /usr/local/bin/oscar-prepare-restore && test -x /usr/local/bin/oscar-prepare-restore' && prepare_restore_helper_regular=true
    merge_wal_restore_helper_regular=false
    compose exec -T postgres sh -c 'test -f /usr/local/bin/oscar-merge-wal-restore && test ! -L /usr/local/bin/oscar-merge-wal-restore && test -x /usr/local/bin/oscar-merge-wal-restore' && merge_wal_restore_helper_regular=true
    atomic_publisher_regular=false
    compose exec -T oscar sh -c 'test -f /usr/local/bin/oscar-atomic-publish && test ! -L /usr/local/bin/oscar-atomic-publish && test -x /usr/local/bin/oscar-atomic-publish' && atomic_publisher_regular=true
    atomic_source_stamp_regular=false
    compose exec -T oscar sh -c 'test -f /usr/local/share/oscar-atomic-publish.source.sha256 && test ! -L /usr/local/share/oscar-atomic-publish.source.sha256' && atomic_source_stamp_regular=true
    entrypoint_regular=false
    compose exec -T oscar sh -c 'test -f /usr/local/bin/oscar-entrypoint && test ! -L /usr/local/bin/oscar-entrypoint && test -x /usr/local/bin/oscar-entrypoint' && entrypoint_regular=true
    deployed_wal_sha=$(compose exec -T postgres sha256sum /usr/local/bin/oscar-archive-wal | awk '{print $1}')
    deployed_archive_sha=$(compose exec -T oscar sha256sum /usr/local/bin/oscar-archive-object | awk '{print $1}')
    deployed_prepare_restore_sha=$(compose exec -T postgres sha256sum /usr/local/bin/oscar-prepare-restore | awk '{print $1}')
    deployed_merge_wal_restore_sha=$(compose exec -T postgres sha256sum /usr/local/bin/oscar-merge-wal-restore | awk '{print $1}')
    deployed_atomic_sha=$(compose exec -T oscar sha256sum /usr/local/bin/oscar-atomic-publish | awk '{print $1}')
    deployed_atomic_source_sha=$(compose exec -T oscar cat /usr/local/share/oscar-atomic-publish.source.sha256 | tr -d '[:space:]')
    deployed_entrypoint_sha=$(compose exec -T oscar sha256sum /usr/local/bin/oscar-entrypoint | awk '{print $1}')
    for digest in "$packaged_wal_sha" "$packaged_archive_sha" "$packaged_prepare_restore_sha" \
      "$packaged_merge_wal_restore_sha" "$packaged_atomic_source_sha" "$deployed_wal_sha" \
      "$deployed_archive_sha" "$deployed_prepare_restore_sha" "$deployed_merge_wal_restore_sha" \
      "$deployed_atomic_sha" "$deployed_atomic_source_sha" "$packaged_entrypoint_sha" \
      "$deployed_entrypoint_sha"; do
      [[ $digest =~ ^[0-9a-f]{64}$ ]] || fail 'A packaged/deployed storage helper has an invalid SHA-256 identity.'
    done
    atomic_behavior_output=$(compose exec -T oscar sh -eu -c '
      root=$(mktemp -d /var/lib/oscar/.atomic-publish-regression.XXXXXX)
      trap '\''rm -rf -- "$root"'\'' EXIT HUP INT TERM
      mkdir "$root/source" "$root/destination"
      printf source > "$root/source/payload"
      printf destination > "$root/destination/payload"
      /usr/local/bin/oscar-atomic-publish "$root" source published
      test ! -e "$root/source" && test "$(cat "$root/published/payload")" = source
      printf "%s\n" first-publish-succeeded
      mkdir "$root/challenger"
      printf challenger > "$root/challenger/payload"
      set +e
      /usr/local/bin/oscar-atomic-publish "$root" challenger published >/dev/null 2>&1
      status=$?
      set -e
      test "$status" -ne 0
      printf "%s\n" collision-rejected
      test "$(cat "$root/challenger/payload")" = challenger
      printf "%s\n" source-preserved
      test "$(cat "$root/published/payload")" = source
      printf "%s\n" destination-preserved
    ' 2>/dev/null || true)
    atomic_behavior_tested=false
    atomic_first_publish_succeeded=false
    atomic_collision_rejected=false
    atomic_source_preserved=false
    atomic_destination_preserved=false
    grep -Fqx first-publish-succeeded <<<"$atomic_behavior_output" && atomic_first_publish_succeeded=true
    grep -Fqx collision-rejected <<<"$atomic_behavior_output" && atomic_collision_rejected=true
    grep -Fqx source-preserved <<<"$atomic_behavior_output" && atomic_source_preserved=true
    grep -Fqx destination-preserved <<<"$atomic_behavior_output" && atomic_destination_preserved=true
    if $atomic_first_publish_succeeded && $atomic_collision_rejected &&
       $atomic_source_preserved && $atomic_destination_preserved; then
      atomic_behavior_tested=true
    fi
    archive_mode=$(scalar 'SHOW archive_mode;')
    archive_command=$(psql_admin --tuples-only --no-align --command 'SHOW archive_command;' | sed -e 's/[[:space:]]*$//' | tail -n1)
    expected_archive_command='/usr/local/bin/oscar-archive-wal "%p" "%f" /var/lib/postgresql/wal-archive'
    archive_command_exact=false; [[ $archive_command == "$expected_archive_command" ]] && archive_command_exact=true

    case $(uname -s) in
      Linux) expected_lock_directory=/run/lock/oscar-storage ;;
      Darwin) expected_lock_directory=/private/var/run/oscar-storage ;;
      *) expected_lock_directory=/var/run/oscar-storage ;;
    esac
    lock_directory=$expected_lock_directory
    lock_file="$lock_directory/$deployment_id.lock"
    lock_log=$(mktemp /tmp/oscar-regression-lock.XXXXXX)
    trap 'rm -f -- "$lock_log"' EXIT
    [[ -d $lock_directory && ! -L $lock_directory && -f $lock_file && ! -L $lock_file ]] ||
      fail 'The deployment storage lock directory/file is missing, linked, or non-regular.'
    lock_owner=$(file_owner_id "$lock_file"); lock_mode=$(file_mode "$lock_file")
    lock_directory_owner=$(file_owner_id "$lock_directory"); lock_directory_mode=$(file_mode "$lock_directory")
    lock_path_stable=false
    [[ $lock_directory == "$expected_lock_directory" && $lock_file == "$expected_lock_directory/$deployment_id.lock" ]] &&
      lock_path_stable=true
    lock_private=false
    [[ $lock_owner == 0 && $lock_mode == 600 && $lock_directory_owner == 0 && $lock_directory_mode == 700 ]] &&
      lock_private=true
    lock_behavior_tested=false; concurrent_lock_rejected=false
    if command -v flock >/dev/null 2>&1; then
      lock_behavior_tested=true
      exec 8>>"$lock_file"
      flock -n 8 || fail 'Could not acquire the idle deployment lock for its concurrency oracle.'
      set +e
      (exec 8>&-; bash oscar.sh archive status) >"$lock_log" 2>&1
      concurrent_status=$?
      set -e
      flock -u 8
      exec 8>&-
      if [[ $concurrent_status -ne 0 ]] && grep -Fq 'Another OSCAR storage administration command is already running.' "$lock_log"; then
        concurrent_lock_rejected=true
      fi
    fi
    rm -f -- "$lock_log"
    trap - EXIT
    for value in "$deployment_id" "$archive_mode" "$expected_lock_directory" "$lock_directory" "$lock_file" \
      "$lock_owner" "$lock_mode" "$lock_directory_owner" "$lock_directory_mode"; do safe_json_text "$value"; done
    images=$(compose config --images)
    app_image=''; postgis_image=''; gateway_image=''
    while IFS= read -r image; do
      [[ -n $image ]] || continue
      case $image in
        oscar-postgis:*) [[ -z $postgis_image ]] || fail 'Compose selects multiple PostGIS images.'; postgis_image=$image ;;
        oscar:*) [[ -z $app_image ]] || fail 'Compose selects multiple OSCAR application images.'; app_image=$image ;;
        nginxinc/nginx-unprivileged:*) [[ -z $gateway_image ]] || fail 'Compose selects multiple gateway images.'; gateway_image=$image ;;
      esac
    done <<<"$images"
    [[ -n $app_image && -n $postgis_image && -n $gateway_image ]] ||
      fail 'Compose does not select exactly one OSCAR, PostGIS, and gateway image.'
    for value in "$configured_release" "$template_release" "$app_image" "$postgis_image" "$gateway_image"; do
      safe_json_text "$value"
    done
    app_id=$(image_id "$app_image"); postgis_id=$(image_id "$postgis_image"); gateway_id=$(image_id "$gateway_image")
    app_container_id=$(container_image_id oscar); postgis_container_id=$(container_image_id postgres); gateway_container_id=$(container_image_id gateway)
    app_container=$(compose ps -q oscar)
    postgres_container=$(compose ps -q postgres)
    container_entrypoint_exact=false
    [[ $(docker inspect "$app_container" --format '{{json .Config.Entrypoint}}') == \
      '["/usr/local/bin/oscar-entrypoint"]' ]] && container_entrypoint_exact=true
    native_runtime_output=$(compose exec -T oscar sh -u -c '
      mount_type() {
        awk -v target="$1" '\''
          $5 == target {
            matches++
            for (field = 7; field <= NF; field++)
              if ($field == "-") type = $(field + 1)
          }
          END {
            if (matches == 1 && type != "") print type
            else if (matches == 0) print "missing"
            else print "multiple"
          }
        '\'' /proc/self/mountinfo
      }
      mount_has_option() {
        if awk -v target="$1" -v required="$2" '\''
          $5 == target {
            count = split($6, options, ",")
            for (option = 1; option <= count; option++)
              if (options[option] == required) found = 1
          }
          END { exit found ? 0 : 1 }
        '\'' /proc/self/mountinfo; then printf true; return 0
        else printf false; return 1; fi
      }

      tmp_type=$(mount_type /tmp)
      native_path=/run/oscar-native
      native_type=$(mount_type "$native_path")
      tmp_rw=$(mount_has_option /tmp rw)
      tmp_noexec=$(mount_has_option /tmp noexec)
      tmp_nosuid=$(mount_has_option /tmp nosuid)
      tmp_nodev=$(mount_has_option /tmp nodev)
      native_rw=$(mount_has_option "$native_path" rw)
      if mount_has_option "$native_path" noexec >/dev/null; then native_noexec_absent=false
      else native_noexec_absent=true; fi
      native_nosuid=$(mount_has_option "$native_path" nosuid)
      native_nodev=$(mount_has_option "$native_path" nodev)

      native_directory=false
      [ -d "$native_path" ] && [ ! -L "$native_path" ] && native_directory=true
      metadata=$(stat -c "%u:%g:%a" "$native_path" 2>/dev/null || printf "-1:-1:missing")
      old_ifs=$IFS; IFS=:; set -- $metadata; IFS=$old_ifs
      native_owner_uid=${1:--1}; native_owner_gid=${2:--1}; native_mode=${3:-missing}
      filesystem=$(stat -f -c "%S:%b" "$native_path" 2>/dev/null || printf "0:0")
      old_ifs=$IFS; IFS=:; set -- $filesystem; IFS=$old_ifs
      case ${1:-}:${2:-} in
        *[!0-9:]*|:|:*|*:|0:*) native_size_bytes=-1 ;;
        *) native_size_bytes=$((${1} * ${2})) ;;
      esac

      native_executable=false
      exec_probe="$native_path/.regression-exec-probe.$$"
      if cp /bin/true "$exec_probe" 2>/dev/null && chmod 0500 "$exec_probe" 2>/dev/null &&
         "$exec_probe" >/dev/null 2>&1; then native_executable=true; fi
      if ! rm -f -- "$exec_probe" >/dev/null 2>&1; then native_executable=false; fi

      runtime_uid=$(id -u); runtime_gid=$(id -g)
      java_process_count=0
      java_tmp_property_count=0; effective_java_tmp=missing
      javacpp_cache_property_count=0; effective_javacpp_cache=missing
      data_tmp_property_count=0; effective_data_tmp=missing
      for process in /proc/[0-9]*; do
        executable=$(readlink "$process/exe" 2>/dev/null || true)
        case $executable in
          */java)
            java_process_count=$((java_process_count + 1))
            arguments=$(tr "\\000" "\\n" <"$process/cmdline" 2>/dev/null || true)
            old_ifs=$IFS
            IFS="
"
            for argument in $arguments; do
              case $argument in
                -Djava.io.tmpdir=*)
                  java_tmp_property_count=$((java_tmp_property_count + 1))
                  effective_java_tmp=${argument#-Djava.io.tmpdir=}
                  ;;
                -Dorg.bytedeco.javacpp.cachedir=*)
                  javacpp_cache_property_count=$((javacpp_cache_property_count + 1))
                  effective_javacpp_cache=${argument#-Dorg.bytedeco.javacpp.cachedir=}
                  ;;
                -Doscar.data.tmpdir=*)
                  data_tmp_property_count=$((data_tmp_property_count + 1))
                  effective_data_tmp=${argument#-Doscar.data.tmpdir=}
                  ;;
              esac
            done
            IFS=$old_ifs
            ;;
        esac
      done
      printf "%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s\\n" \
        "$tmp_type" "$tmp_rw" "$tmp_noexec" "$tmp_nosuid" "$tmp_nodev" \
        "$native_type" "$native_rw" "$native_noexec_absent" "$native_nosuid" "$native_nodev" \
        "$native_directory" "$native_executable" "$runtime_uid" "$runtime_gid" \
        "$native_owner_uid" "$native_owner_gid" "$native_mode" "$native_size_bytes" \
        "$java_process_count" "$java_tmp_property_count" "$effective_java_tmp" \
        "$javacpp_cache_property_count" "$effective_javacpp_cache" \
        "$data_tmp_property_count" "$effective_data_tmp" /tmp "$native_path"
    ')
    IFS='|' read -r tmp_mount_type tmp_mount_read_write tmp_mount_noexec tmp_mount_nosuid tmp_mount_nodev \
      native_mount_type native_mount_read_write native_mount_noexec_absent native_mount_nosuid native_mount_nodev \
      native_directory native_executable runtime_uid runtime_gid native_owner_uid native_owner_gid native_mode \
      native_size_bytes java_process_count java_tmp_property_count effective_java_tmp \
      javacpp_cache_property_count effective_javacpp_cache \
      data_tmp_property_count effective_data_tmp tmp_path native_path \
      <<<"$native_runtime_output"
    for value in "$tmp_mount_type" "$native_mount_type" "$native_mode" "$effective_java_tmp" \
      "$effective_javacpp_cache" "$effective_data_tmp" "$tmp_path" "$native_path"; do
      safe_json_text "$value"
    done
    for value in "$runtime_uid" "$runtime_gid" "$native_owner_uid" "$native_owner_gid" \
      "$native_size_bytes" "$java_process_count" "$java_tmp_property_count" \
      "$javacpp_cache_property_count" "$data_tmp_property_count"; do
      [[ $value =~ ^-?[0-9]+$ ]] || fail 'The OSCAR native-runtime probe returned a nonnumeric field.'
    done
    for value in "$tmp_mount_read_write" "$tmp_mount_noexec" "$tmp_mount_nosuid" "$tmp_mount_nodev" \
      "$native_mount_read_write" "$native_mount_noexec_absent" "$native_mount_nosuid" "$native_mount_nodev" \
      "$native_directory" "$native_executable"; do
      [[ $value == true || $value == false ]] || fail 'The OSCAR native-runtime probe returned a nonboolean field.'
    done
    app_backup_root_absent=false
    postgres_backup_root_absent=false
    if ! docker inspect "$app_container" --format '{{range .Mounts}}{{println .Destination}}{{end}}' |
         grep -Fqx /var/lib/oscar/backups; then
      app_backup_root_absent=true
    fi
    if ! docker inspect "$postgres_container" --format '{{range .Mounts}}{{println .Destination}}{{end}}' |
         grep -Fqx /var/lib/postgresql/backups; then
      postgres_backup_root_absent=true
    fi
    isolated_basebackup_wired=false
    if grep -Fq -- '--network "container:$postgres_container"' oscar-storage.sh &&
       grep -Fq -- '--volume "$work/postgres:/backup"' oscar-storage.sh &&
       grep -Fq -- '--volume "$script_dir/secrets/postgres-bootstrap-password.txt:/run/secrets/postgres_bootstrap_password:ro"' oscar-storage.sh &&
       ! grep -Fq 'target: /var/lib/postgresql/backups' compose.yaml &&
       ! grep -Fq 'target: /var/lib/oscar/backups' compose.yaml; then
      isolated_basebackup_wired=true
    fi
    app_version_label=$(image_label "$app_image" org.opencontainers.image.version)
    postgis_version_label=$(image_label "$postgis_image" org.opencontainers.image.version)
    postgis_profile_label=$(image_label "$postgis_image" com.botts.oscar.storage-profile)
    gateway_version_label=$(image_label "$gateway_image" org.opencontainers.image.version)
    for value in "$app_id" "$postgis_id" "$gateway_id" "$app_container_id" "$postgis_container_id" "$gateway_container_id" \
      "$app_version_label" "$postgis_version_label" "$postgis_profile_label" "$gateway_version_label"; do
      safe_json_text "$value"
    done
    app_digests=$(repo_digests_json "$app_image")
    postgis_digests=$(repo_digests_json "$postgis_image")
    gateway_digests=$(repo_digests_json "$gateway_image")
    config=/var/lib/oscar/config.json
    compose exec -T oscar sh -eu -c '
      path=$1
      test -f "$path" && test ! -L "$path"
      size=$(stat -c %s -- "$path")
      test "$size" -gt 0 && test "$size" -le 16777216
    ' config-contract "$config" || fail 'The live OSCAR config is missing, linked, empty, or over 16 MiB.'
    config_fields=$(platform_config_fields "$config") ||
      fail 'The live OSCAR config failed structural JSON extraction.'
    [[ -n $config_fields ]] ||
      fail 'The live OSCAR config does not contain exactly one correctly typed storage module set.'
    IFS='|' read -r interval grace duck_memory duck_threads duck_temp_limit duck_max_sessions \
      duck_acquire_timeout duck_temp_dir media_retention media_query_period media_frame_count \
      media_jpeg_quality media_source_grace media_metadata_work media_enabled delete_hot \
      daily_root daily_journal daily_publication daily_zone daily_mode daily_fsync daily_records \
      daily_unforced_bytes daily_segment_bytes daily_segment_age daily_record_bytes daily_retention \
      lifecycle_delegated daily_purge_work unexpected_config_field <<<"$config_fields"
    [[ -z ${unexpected_config_field:-} ]] || fail 'The structural OSCAR config result is ambiguous.'
    for value in "$daily_root" "$daily_journal" "$daily_publication" "$daily_zone" "$daily_mode"; do
      safe_json_text "$value"
    done
    schema=$(scalar "SELECT coalesce(max(version),0) FROM oscar_storage_schema_version;")
    schema_checksum=$(scalar "SELECT coalesce((SELECT checksum FROM oscar_storage_schema_version WHERE version=5),'');")
    safe_json_text "$schema_checksum"
    checksums=$(scalar "SHOW data_checksums;")
    installed=$(scalar "SELECT EXISTS(SELECT 1 FROM pg_extension WHERE extname='pg_stat_statements');")
    preloaded=$(scalar "SELECT position('pg_stat_statements' in current_setting('shared_preload_libraries'))>0;")
    marker_text=$(compose exec -T postgres sh -c 'marker=/var/lib/postgresql/data/.oscar-data-checksum-init; test -f "$marker" && test ! -L "$marker" && cat "$marker"' 2>/dev/null || true)
    marker_lines=$(compose exec -T postgres sh -c 'marker=/var/lib/postgresql/data/.oscar-data-checksum-init; test -f "$marker" && test ! -L "$marker" && awk "END {print NR}" "$marker"' 2>/dev/null || true)
    marker_present=false; marker_exact=false; marker_format=''; marker_version=''; marker_checksums=''; marker_initialized=''
    if [[ -n $marker_text ]]; then
      marker_present=true
      marker_format=$(printf '%s\n' "$marker_text" | awk -F= '$1=="format" {print substr($0,index($0,"=")+1); exit}')
      marker_version=$(printf '%s\n' "$marker_text" | awk -F= '$1=="version" {print substr($0,index($0,"=")+1); exit}')
      marker_checksums=$(printf '%s\n' "$marker_text" | awk -F= '$1=="data_checksums" {print substr($0,index($0,"=")+1); exit}')
      marker_initialized=$(printf '%s\n' "$marker_text" | awk -F= '$1=="initialized_at" {print substr($0,index($0,"=")+1); exit}')
      if [[ $marker_lines == 4 && $marker_format == oscar-storage-profile &&
            $marker_version == "$expected_release" && $marker_checksums == on &&
            $marker_initialized =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]]; then
        marker_exact=true
      fi
    fi
    for value in "$marker_format" "$marker_version" "$marker_checksums" "$marker_initialized" "$duck_temp_dir"; do safe_json_text "$value"; done
    archive_scratch=$(archive_scratch_json "$duck_temp_dir" /var/lib/oscar/archive)
    batch_evidence=$(psql_admin --quiet --tuples-only --no-align --command "
      WITH rewritten AS (
        SELECT coalesce(sum(calls),0)::bigint calls,coalesce(sum(rows),0)::bigint rows
        FROM pg_stat_statements
        WHERE query ~* '^[[:space:]]*insert[[:space:]]+into[[:space:]]+(public[.])?obs[[:space:]]*[(]'
          AND query ~ '[)][[:space:]]*,[[:space:]]*[(]')
      SELECT calls||'|'||rows FROM rewritten;" | tail -n 1)
    IFS='|' read -r batch_calls batch_rows batch_extra <<<"$batch_evidence"
    [[ -z ${batch_extra:-} && $batch_calls =~ ^[0-9]+$ && $batch_rows =~ ^[0-9]+$ ]] ||
      fail 'Could not obtain bounded PostgreSQL batch-rewrite execution evidence.'
    batch=false
    if [[ $batch_calls -gt 0 && $batch_rows -gt $batch_calls ]]; then batch=true; fi
    journal=true
    printf '{"expectedRelease":"%s","configuredRelease":"%s","templateRelease":"%s","deploymentId":"%s",' \
      "$expected_release" "$configured_release" "$template_release" "$deployment_id"
    printf '"storageRoots":{"archive":%s,"backup":%s,"walArchive":%s},' \
      "$archive_identity" "$backup_identity" "$wal_identity"
    printf '"storageLock":{"directory":"%s","file":"%s","stablePath":%s,"private":%s,"behaviorTested":%s,"concurrentRejected":%s},' \
      "$lock_directory" "$lock_file" "$lock_path_stable" "$lock_private" "$lock_behavior_tested" "$concurrent_lock_rejected"
    printf '"walArchive":{"archiveMode":"%s","archiveCommandExact":%s,"publicationContractExact":%s,"helperPath":"/usr/local/bin/oscar-archive-wal","packagedSha256":"%s","deployedSha256":"%s","regularExecutable":%s},' \
      "$archive_mode" "$archive_command_exact" "$wal_publication_contract" "$packaged_wal_sha" "$deployed_wal_sha" "$wal_helper_regular"
    printf '"archiveObjectHelper":{"helperPath":"/usr/local/bin/oscar-archive-object","packagedSha256":"%s","deployedSha256":"%s","regularExecutable":%s,"cliExportIntegrated":%s,"cliPurgeIntegrated":%s},' \
      "$packaged_archive_sha" "$deployed_archive_sha" "$archive_helper_regular" "$archive_export_helper_wired" "$archive_purge_helper_wired"
    printf '"restoreHelpers":{"prepare":{"helperPath":"/usr/local/bin/oscar-prepare-restore","packagedSha256":"%s","deployedSha256":"%s","regularExecutable":%s},"mergeWal":{"helperPath":"/usr/local/bin/oscar-merge-wal-restore","packagedSha256":"%s","deployedSha256":"%s","regularExecutable":%s}},' \
      "$packaged_prepare_restore_sha" "$deployed_prepare_restore_sha" "$prepare_restore_helper_regular" \
      "$packaged_merge_wal_restore_sha" "$deployed_merge_wal_restore_sha" "$merge_wal_restore_helper_regular"
    printf '"atomicPublisher":{"helperPath":"/usr/local/bin/oscar-atomic-publish","sourceStampPath":"/usr/local/share/oscar-atomic-publish.source.sha256","packagedSourceSha256":"%s","deployedSourceSha256":"%s","deployedBinarySha256":"%s","regularExecutable":%s,"sourceStampRegular":%s,"behaviorTested":%s,"firstPublishSucceeded":%s,"collisionRejected":%s,"sourcePreserved":%s,"destinationPreserved":%s},' \
      "$packaged_atomic_source_sha" "$deployed_atomic_source_sha" "$deployed_atomic_sha" \
      "$atomic_publisher_regular" "$atomic_source_stamp_regular" "$atomic_behavior_tested" \
      "$atomic_first_publish_succeeded" "$atomic_collision_rejected" "$atomic_source_preserved" "$atomic_destination_preserved"
    printf '"backupIsolation":{"appBackupRootAbsent":%s,"postgresBackupRootAbsent":%s,"isolatedBasebackupWired":%s},' \
      "$app_backup_root_absent" "$postgres_backup_root_absent" "$isolated_basebackup_wired"
    printf '"nativeRuntime":{"entrypointPath":"/usr/local/bin/oscar-entrypoint","packagedEntrypointSha256":"%s","deployedEntrypointSha256":"%s","entrypointRegularExecutable":%s,"containerEntrypointExact":%s,"managedPropertiesAfterJavaOpts":%s,' \
      "$packaged_entrypoint_sha" "$deployed_entrypoint_sha" "$entrypoint_regular" \
      "$container_entrypoint_exact" "$entrypoint_tmp_contract"
    printf '"tmpPath":"%s","tmpMountType":"%s","tmpReadWrite":%s,"tmpNoexec":%s,"tmpNosuid":%s,"tmpNodev":%s,' \
      "$tmp_path" "$tmp_mount_type" "$tmp_mount_read_write" "$tmp_mount_noexec" "$tmp_mount_nosuid" "$tmp_mount_nodev"
    printf '"nativePath":"%s","nativeMountType":"%s","nativeReadWrite":%s,"nativeNoexecAbsent":%s,"nativeNosuid":%s,"nativeNodev":%s,"nativeDirectory":%s,"nativeExecutable":%s,' \
      "$native_path" "$native_mount_type" "$native_mount_read_write" "$native_mount_noexec_absent" \
      "$native_mount_nosuid" "$native_mount_nodev" "$native_directory" "$native_executable"
    printf '"runtimeUid":%s,"runtimeGid":%s,"nativeOwnerUid":%s,"nativeOwnerGid":%s,"nativeMode":"%s","nativeSizeBytes":%s,"javaProcessCount":%s,"javaTmpPropertyCount":%s,"effectiveJavaTmp":"%s","javaCppCachePropertyCount":%s,"effectiveJavaCppCache":"%s","dataTmpPropertyCount":%s,"effectiveDataTmp":"%s"},' \
      "$runtime_uid" "$runtime_gid" "$native_owner_uid" "$native_owner_gid" "$native_mode" \
      "$native_size_bytes" "$java_process_count" "$java_tmp_property_count" "$effective_java_tmp" \
      "$javacpp_cache_property_count" "$effective_javacpp_cache" \
      "$data_tmp_property_count" "$effective_data_tmp"
    printf '"appImage":{"reference":"%s","imageId":"%s","containerImageId":"%s","repoDigests":%s,"versionLabel":"%s","storageProfileLabel":""},' \
      "$app_image" "$app_id" "$app_container_id" "$app_digests" "$app_version_label"
    printf '"postgisImage":{"reference":"%s","imageId":"%s","containerImageId":"%s","repoDigests":%s,"versionLabel":"%s","storageProfileLabel":"%s"},' \
      "$postgis_image" "$postgis_id" "$postgis_container_id" "$postgis_digests" "$postgis_version_label" "$postgis_profile_label"
    printf '"gatewayImage":{"reference":"%s","imageId":"%s","containerImageId":"%s","repoDigests":%s,"versionLabel":"%s","storageProfileLabel":""},' \
      "$gateway_image" "$gateway_id" "$gateway_container_id" "$gateway_digests" "$gateway_version_label"
    printf '"dataChecksums":"%s","pgStatStatementsInstalled":%s,"pgStatStatementsPreloaded":%s,"schemaVersion":%s,"schemaChecksum":"%s",' \
      "$checksums" "$([[ $installed == t ]] && echo true || echo false)" "$([[ $preloaded == t ]] && echo true || echo false)" "$schema" "$schema_checksum"
    printf '"archiveMarker":{"present":%s,"exact":%s,"format":"%s","version":"%s","dataChecksums":"%s","initializedAt":"%s"},' \
      "$marker_present" "$marker_exact" "$marker_format" "$marker_version" "$marker_checksums" "$marker_initialized"
    printf '"batchRewriteConfigured":%s,"batchRewriteObservedCalls":%s,"batchRewriteObservedRows":%s,"dailyJournalConfigured":%s,"archiveIntervalMinutes":%s,"deleteHotAfterArchive":%s,"rollbackGraceDays":%s,' \
      "$batch" "$batch_calls" "$batch_rows" "$journal" "${interval:-null}" "$delete_hot" "${grace:-null}"
    printf '"archiveResources":{"memoryLimitMegabytes":%s,"threads":%s,"maximumTemporaryMegabytes":%s,"maximumConcurrentSessions":%s,"sessionAcquireTimeoutSeconds":%s,"temporaryDirectory":"%s"},' \
      "${duck_memory:-null}" "${duck_threads:-null}" "${duck_temp_limit:-null}" \
      "${duck_max_sessions:-null}" "${duck_acquire_timeout:-null}" "$duck_temp_dir"
    printf '"archiveScratch":%s,' "$archive_scratch"
    printf '"dailyJournal":{"rootDirectory":"%s","journalDirectory":"%s","publicationDirectory":"%s","zoneId":"%s","observationMode":"%s","fsyncIntervalMillis":%s,"maxUnforcedRecords":%s,"maxUnforcedBytes":%s,"maxSegmentBytes":%s,"maxSegmentAgeSeconds":%s,"maxRecordBytes":%s,"sealedJournalRetentionDays":%s,"observationLifecycleDelegated":%s,"purgeWorkLimit":%s},' \
      "$daily_root" "$daily_journal" "$daily_publication" "$daily_zone" "$daily_mode" \
      "${daily_fsync:-null}" "${daily_records:-null}" "${daily_unforced_bytes:-null}" \
      "${daily_segment_bytes:-null}" "${daily_segment_age:-null}" "${daily_record_bytes:-null}" \
      "${daily_retention:-null}" "$lifecycle_delegated" "${daily_purge_work:-null}"
    printf '"videoRetention":{"enabled":%s,"timeToRetentionDays":%s,"queryPeriodMinutes":%s,"frameCount":%s,"jpegQuality":%s,"sourceRollbackGraceHours":%s,"metadataReclamationWorkLimit":%s}}\n' \
      "$media_enabled" "${media_retention:-null}" "${media_query_period:-null}" \
      "${media_frame_count:-null}" "${media_jpeg_quality:-null}" "${media_source_grace:-null}" \
      "${media_metadata_work:-null}"
    ;;

  archive-scratch-health)
    archive_scratch_json /var/lib/oscar/duckdb-tmp /var/lib/oscar/archive
    ;;

  media-metadata-health)
    media_metadata_health_json
    ;;

  retention-runtime-health)
    retention_runtime_health_json
    ;;

  snapshot)
    archive_dir=$(absolute_path "$(env_value OSCAR_ARCHIVE_DIR ./data/archive)")
    backup_dir=$(absolute_path "$(env_value OSCAR_BACKUP_DIR ./backups)")
    journal_bytes=$(compose exec -T oscar sh -c "du -sb /var/lib/oscar/files/.dailyfile-journal 2>/dev/null | awk '{print \$1+0}'" || echo 0)
    daily_bytes=$(compose exec -T oscar sh -c "du -sb /var/lib/oscar/files/dailyfiles 2>/dev/null | awk '{print \$1+0}'" || echo 0)
    media_bytes=$(compose exec -T oscar sh -c "du -sb /var/lib/oscar/files/videos/retained-media 2>/dev/null | awk '{print \$1+0}'" || echo 0)
    metadata_stats=$(compose exec -T oscar sh -eu -c '
      root=/var/lib/oscar/files/videos/retained-media/v1
      count() { path=$1; shift; find "$path" "$@" 2>/dev/null | wc -l | tr -d "[:space:]"; }
      bytes() { path=$1; shift; find "$path" "$@" -printf "%s\n" 2>/dev/null | awk "{sum+=\$1} END {print sum+0}"; }
      manifests=$(count "$root/events" -type f -name manifest.json)
      jpegs=$(count "$root/events" -type f -name "frame-0[1-5].jpg")
      processed=$(count "$root/retention-processed-index" -mindepth 1 -maxdepth 1 -type f -name "*.idx")
      processed_bytes=$(bytes "$root/retention-processed-index" -mindepth 1 -maxdepth 1 -type f -name "*.idx")
      deleted=$(count "$root/deletion-index" -mindepth 2 -maxdepth 2 -type f -name "*.idx")
      deleted_bytes=$(bytes "$root/deletion-index" -mindepth 2 -maxdepth 2 -type f -name "*.idx")
      legacy_processed=$(count "$root/retention-processed" -type f -name "*.json")
      legacy_deleted=$(count "$root/events" -type f -name .deleted.json)
      checkpoint=0
      checkpoint_path="$root/.metadata-reclamation-checkpoint.json"
      if [ -f "$checkpoint_path" ] && [ ! -L "$checkpoint_path" ]; then
        checkpoint=$(stat -c %s -- "$checkpoint_path")
      fi
      printf "%s|%s|%s|%s|%s|%s|%s|%s|%s\n" "$manifests" "$jpegs" "$processed" \
        "$processed_bytes" "$deleted" "$deleted_bytes" "$legacy_processed" "$legacy_deleted" "$checkpoint"
    ' metadata-stats)
    IFS='|' read -r media_manifests media_jpegs processed_indexes processed_index_bytes \
      deletion_indexes deletion_index_bytes legacy_markers legacy_tombstones metadata_checkpoint_bytes \
      <<<"$metadata_stats"
    for value in "$media_manifests" "$media_jpegs" "$processed_indexes" "$processed_index_bytes" \
      "$deletion_indexes" "$deletion_index_bytes" "$legacy_markers" "$legacy_tombstones" \
      "$metadata_checkpoint_bytes"; do
      [[ $value =~ ^[0-9]+$ ]] || fail 'Media metadata inventory returned a nonnumeric field.'
    done
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
      'dailyFileBytes',${daily_bytes:-0},'retainedMediaBytes',${media_bytes:-0},
      'retainedMediaManifestFiles',$media_manifests,'retainedMediaJpegFiles',$media_jpegs,
      'processedObservationIndexFiles',$processed_indexes,'processedObservationIndexBytes',$processed_index_bytes,
      'deletionIndexFiles',$deletion_indexes,'deletionIndexBytes',$deletion_index_bytes,
      'legacyProcessedMarkerFiles',$legacy_markers,'legacyDeletionTombstones',$legacy_tombstones,
      'mediaMetadataCheckpointBytes',$metadata_checkpoint_bytes,'backupBytes',$backup_bytes)
    FROM db,stats,wal,statements,catalog,jobs,parity,holds,backups;"
    ;;

  archive-health)
    archive_verify_work=$(mktemp -d /tmp/oscar-regression-archive-verify.XXXXXXXX)
    cleanup_archive_verify() { rm -rf -- "$archive_verify_work"; }
    trap cleanup_archive_verify EXIT
    archive_verify_log=$archive_verify_work/archive-verify.log
    verify_passed=false
    if sudo bash oscar.sh archive verify >"$archive_verify_log" 2>&1; then
      verify_passed=true
    else
      emit_command_diagnostics 'OSCAR archive verification' "$archive_verify_log"
    fi
    archive_dir=$(realpath -e -- "$(absolute_path "$(env_value OSCAR_ARCHIVE_DIR ../oscar-storage/archive)")")
    wal_archive_dir=$(realpath -e -- "$(absolute_path "$(env_value OSCAR_WAL_ARCHIVE_DIR ../oscar-storage/wal-archive)")")
    archive_partials=$(find "$archive_dir" -mindepth 1 \( -name '*.partial' -o -name '*.partial.*' -o -name '*.tmp' -o -name '*.tmp.*' \) -print | wc -l | tr -d '[:space:]')
    wal_partials=$(find "$wal_archive_dir" -mindepth 1 \( -name '*.partial' -o -name '*.partial.*' -o -name '*.tmp' -o -name '*.tmp.*' \) -print | wc -l | tr -d '[:space:]')
    json_query "WITH generations AS (
        SELECT count(*) FILTER(WHERE state='ACTIVE') active,
          count(*) FILTER(WHERE state='SEALED') sealed,
          coalesce(sum(row_count) FILTER(WHERE state IN ('ACTIVE','SEALED')),0) rows
        FROM oscar_archive_generation),
      objects AS (
        SELECT coalesce(sum(bytes) FILTER(WHERE state='ACTIVE'),0) bytes
        FROM oscar_archive_object),
      incomplete AS (
        SELECT count(*) count FROM oscar_archive_generation g
        WHERE g.state IN ('ACTIVE','SEALED') AND (
          NOT EXISTS (SELECT 1 FROM oscar_archive_object o WHERE o.generation_id=g.id) OR
          EXISTS (SELECT 1 FROM oscar_archive_object o WHERE o.generation_id=g.id AND o.state<>'ACTIVE')
        ))
      SELECT json_build_object(
        'activeGenerations',generations.active,'sealedGenerations',generations.sealed,
        'archiveRows',generations.rows,'archiveBytes',objects.bytes,
        'failedJobs',(SELECT count(*) FROM oscar_archive_job WHERE state='FAILED'),
        'parityFailures',(SELECT count(*) FROM oscar_archive_verification WHERE verification_type='PARITY' AND status<>'PASSED'),
        'activeHolds',(SELECT count(*) FROM oscar_retention_hold WHERE released_at IS NULL),
        'incompleteActiveObjects',incomplete.count,
        'archivePartialArtifacts',$archive_partials,
        'walPartialArtifacts',$wal_partials,
        'checksumVerificationPassed',$verify_passed)
      FROM generations,objects,incomplete;"
    cleanup_archive_verify
    trap - EXIT
    ;;

  journal-status)
    journal_metadata=$(compose exec -T oscar sh -eu -c '
      path=/var/lib/oscar/files/.dailyfile-journal/journal-metadata.v1.json
      [ -f "$path" ] && [ ! -L "$path" ] || exit 20
      size=$(stat -c %s -- "$path")
      [ "$size" -gt 0 ] && [ "$size" -le 65536 ] || exit 21
      openssl base64 -A -in "$path"
    ' journal-metadata) || fail 'Daily-file journal metadata is missing, linked, empty, or over 64 KiB.'
    [[ $journal_metadata =~ ^[A-Za-z0-9+/]+=*$ && ${#journal_metadata} -le 87384 ]] ||
      fail 'Daily-file journal metadata is not bounded canonical base64.'
    journal_metadata_result=$(scalar "WITH source AS (
        SELECT convert_from(decode('$journal_metadata','base64'),'UTF8') AS text),
      doc AS (SELECT text::json AS raw, text::jsonb AS value FROM source)
      SELECT (jsonb_typeof(value)='object'
        AND (SELECT count(*) FROM json_object_keys(raw))=2
        AND value ?& ARRAY['schemaVersion','zoneId']
        AND value->'schemaVersion'='1'::jsonb
        AND jsonb_typeof(value->'zoneId')='string'
        AND length(value->>'zoneId') BETWEEN 1 AND 128)::text
        ||'|'||coalesce(value->>'zoneId','') FROM doc;")
    IFS='|' read -r journal_metadata_valid journal_zone <<<"$journal_metadata_result"
    [[ $journal_metadata_valid == true &&
       $journal_zone =~ ^[A-Za-z0-9._+/-]{1,128}$ ]] ||
      fail 'Daily-file journal metadata is not the exact schema-1 configured-zone contract.'
    journal_today=$(scalar "SELECT to_char(current_timestamp AT TIME ZONE '$journal_zone','YYYY-MM-DD');")
    [[ $journal_today =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] ||
      fail 'Could not resolve the current daily-file date in the configured journal zone.'
    inventory=$(compose exec -T oscar sh -eu -c '
      today=$1
      root=/var/lib/oscar/files; pubs="$root/dailyfiles"; journal="$root/.dailyfile-journal"
      for path in "$root" "$pubs" "$journal"; do
        [ -d "$path" ] && [ ! -L "$path" ] || exit 20
      done
      segments_root="$journal/segments"
      [ -d "$segments_root" ] && [ ! -L "$segments_root" ] || exit 22
    total=$(find "$pubs" "$journal" -mindepth 1 -print | wc -l | tr -d "[:space:]")
    [ "$total" -le 100000 ] || exit 21
    partial=$(find "$pubs" "$journal" -type f \( -name "*.partial" -o -name "*.partial.*" -o -name "*.partial-*" -o -name "*.tmp" -o -name "*.tmp.*" -o -name "*.tmp-*" \) -print | wc -l | tr -d "[:space:]")
    manifests=$(find "$pubs" -mindepth 1 -maxdepth 1 -type f -name "*.manifest.v1.json" -print | wc -l | tr -d "[:space:]")
    publications=$(find "$pubs" -mindepth 1 -maxdepth 1 -type f -name "*.csv" -print | wc -l | tr -d "[:space:]")
    open=$(find "$journal" -type f -name "*.open" -print | wc -l | tr -d "[:space:]")
    segments=$(find "$journal" -type f -name "*.seg" -print | wc -l | tr -d "[:space:]")
    links=$(find "$pubs" "$journal" -type l -print | wc -l | tr -d "[:space:]")
    publication_nonfiles=$(find "$pubs" -mindepth 1 -maxdepth 1 ! -type f -print | wc -l | tr -d "[:space:]")
    publication_nested=$(find "$pubs" -mindepth 2 -print | wc -l | tr -d "[:space:]")
    publication_bad_names=$(find "$pubs" -mindepth 1 -maxdepth 1 -type f -printf "%f\n" |
      grep -Evc "^[A-Za-z0-9._-]+-[0-9a-f]{12}_[0-9]{4}-[0-9]{2}-[0-9]{2}[.]csv([.]manifest[.]v1[.]json)?$" || true)
    unsafe=$((publication_nonfiles+publication_nested+publication_bad_names))

    lane_non_dirs=$(find "$segments_root" -mindepth 1 -maxdepth 1 ! -type d -print | wc -l | tr -d "[:space:]")
    invalid_days=$(find "$segments_root" -mindepth 2 -maxdepth 2 -type d -printf "%f\n" |
      grep -Evc "^[0-9]{4}-[0-9]{2}-[0-9]{2}$" || true)
    eligible_days=$(find "$segments_root" -mindepth 2 -maxdepth 2 -type d -printf "%f\n" |
      awk -v today="$today" "\$0 ~ /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/ && \$0 < today { count++ } END { print count+0 }")
    future_days=$(find "$segments_root" -mindepth 2 -maxdepth 2 -type d -printf "%f\n" |
      awk -v today="$today" "\$0 ~ /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/ && \$0 > today { count++ } END { print count+0 }")
    current_dirs=$(find "$segments_root" -mindepth 2 -maxdepth 2 -type d -name "$today" -print |
      wc -l | tr -d "[:space:]")
    current_open=$(find "$segments_root" -mindepth 3 -maxdepth 3 -path "*/$today/*" -type f \
      -name "[0-9][0-9][0-9][0-9][0-9][0-9].open" -print | wc -l | tr -d "[:space:]")
    current_sealed=$(find "$segments_root" -mindepth 3 -maxdepth 3 -path "*/$today/*" -type f \
      -name "[0-9][0-9][0-9][0-9][0-9][0-9].seg" -print | wc -l | tr -d "[:space:]")
    current_bytes=$(find "$segments_root" -mindepth 3 -maxdepth 3 -path "*/$today/*" -type f \
      \( -name "[0-9][0-9][0-9][0-9][0-9][0-9].open" -o \
         -name "[0-9][0-9][0-9][0-9][0-9][0-9].seg" \) -printf "%s\n" |
      awk "{ total += \$1 } END { printf \"%.0f\n\", total+0 }")
    current_entries=$(find "$segments_root" -mindepth 3 -maxdepth 3 -path "*/$today/*" -print |
      wc -l | tr -d "[:space:]")
    current_expected=$((current_open+current_sealed))
    current_unexpected=$((current_entries-current_expected))
    [ "$current_unexpected" -ge 0 ] || current_unexpected=1
    empty_current_dirs=0
    for directory in "$segments_root"/*/"$today"; do
      [ -e "$directory" ] || [ -L "$directory" ] || continue
      [ -d "$directory" ] && [ ! -L "$directory" ] || continue
      count=$(find "$directory" -mindepth 1 -maxdepth 1 -type f \
        \( -name "[0-9][0-9][0-9][0-9][0-9][0-9].open" -o \
           -name "[0-9][0-9][0-9][0-9][0-9][0-9].seg" \) -print | wc -l | tr -d "[:space:]")
      [ "$count" -gt 0 ] || empty_current_dirs=$((empty_current_dirs+1))
    done
    header_failures=0
    for path in "$segments_root"/*/"$today"/*; do
      [ -e "$path" ] || [ -L "$path" ] || continue
      name=${path##*/}
      case $name in
        [0-9][0-9][0-9][0-9][0-9][0-9].open|[0-9][0-9][0-9][0-9][0-9][0-9].seg) ;;
        *) continue ;;
      esac
      size=$(stat -c %s -- "$path" 2>/dev/null || printf 0)
      header=$(od -An -tx1 -N8 -- "$path" 2>/dev/null | tr -d "[:space:]")
      if [ ! -f "$path" ] || [ -L "$path" ] || [ "$size" -lt 16 ] ||
         [ "$header" != 444a4e4c00000001 ]; then
        header_failures=$((header_failures+1))
      fi
    done
    journal_integrity_failures=$((lane_non_dirs+invalid_days+future_days+current_unexpected+empty_current_dirs+header_failures))
    printf "%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s\n" \
      "$publications" "$manifests" "$partial" "$open" "$segments" "$links" "$unsafe" \
      "$eligible_days" "$current_dirs" "$current_open" "$current_sealed" "$current_bytes" \
      "$journal_integrity_failures" "$total"
  ' journal-inventory "$journal_today") ||
      fail 'Daily-file roots are missing, linked, malformed, or exceed the 100,000-entry safety bound.'
    IFS='|' read -r publications manifests partial open segments unsafe_links unsafe_entries \
      eligible_prior_days current_day_directories current_day_open current_day_sealed current_day_bytes \
      journal_integrity_failures inventory_entries <<<"$inventory"
    for value in "$publications" "$manifests" "$partial" "$open" "$segments" "$unsafe_links" \
      "$unsafe_entries" "$eligible_prior_days" "$current_day_directories" "$current_day_open" \
      "$current_day_sealed" "$current_day_bytes" "$journal_integrity_failures" "$inventory_entries"; do
      [[ $value =~ ^[0-9]+$ ]] || fail 'Daily-file inventory returned a nonnumeric field.'
    done
    manifest_listing=$(compose exec -T oscar find /var/lib/oscar/files/dailyfiles \
      -mindepth 1 -maxdepth 1 -type f -name '*.manifest.v1.json' -print | LC_ALL=C sort)
    validated=0; failures=0
    # Materialize the bounded listing before validation. docker compose exec
    # commands inside the loop may read stdin even with -T; a read-driven loop
    # would therefore lose every path after the first validation.
    mapfile -t manifest_paths <<<"$manifest_listing"
    for manifest in "${manifest_paths[@]}"; do
      [[ -n $manifest ]] || continue
      if [[ ! $manifest =~ ^/var/lib/oscar/files/dailyfiles/[A-Za-z0-9._-]+-[0-9a-f]{12}_[0-9]{4}-[0-9]{2}-[0-9]{2}\.csv\.manifest\.v1\.json$ ]]; then
        failures=$((failures+1)); continue
      fi
      csv=${manifest%.manifest.v1.json}
      csv_name=${csv##*/}
      csv_day=${csv_name%.csv}; csv_day=${csv_day##*_}
      [[ $csv_day =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || {
        failures=$((failures+1)); continue;
      }
      manifest_size=$(compose exec -T oscar stat -c %s -- "$manifest" 2>/dev/null || printf 0)
      [[ $manifest_size =~ ^[0-9]+$ && $manifest_size -gt 0 && $manifest_size -le 1048576 ]] || {
        failures=$((failures+1)); continue;
      }
      manifest_encoded=$(compose exec -T oscar openssl base64 -A -in "$manifest" | tr -d '\r\n')
      if [[ ! $manifest_encoded =~ ^[A-Za-z0-9+/]+=*$ || ${#manifest_encoded} -gt 1398104 ]]; then
        failures=$((failures+1)); continue
      fi
      csv_stats=$(compose exec -T oscar sh -eu -c '
        path=$1
        [ -f "$path" ] && [ ! -L "$path" ] || exit 20
        digest=$(sha256sum "$path"); digest=${digest%% *}
        bytes=$(wc -c <"$path" | tr -d "[:space:]")
        records=$(wc -l <"$path" | tr -d "[:space:]")
        printf "%s|%s|%s\n" "$digest" "$bytes" "$records"
      ' journal-csv "$csv" 2>/dev/null || true)
      IFS='|' read -r actual_sha actual_bytes actual_records <<<"$csv_stats"
      if [[ ! $actual_sha =~ ^[0-9a-f]{64}$ || ! $actual_bytes =~ ^[0-9]+$ || ! $actual_records =~ ^[0-9]+$ ]]; then
        failures=$((failures+1)); continue
      fi
      manifest_valid=$(scalar "WITH source AS (
          SELECT convert_from(decode('$manifest_encoded','base64'),'UTF8') AS text),
        doc AS (SELECT text::json AS raw, text::jsonb AS value FROM source)
        SELECT jsonb_typeof(value)='object'
          AND (SELECT count(*) FROM json_object_keys(raw))=12
          AND value ?& ARRAY['schemaVersion','format','laneId','zoneId','windowStartInclusive',
            'windowEndExclusive','recordCount','byteCount','checksumAlgorithm','sha256','dataFile','publishedAt']
          AND value->'schemaVersion'='1'::jsonb
          AND value->>'format'='OSCAR_LEGACY_DAILY_CSV'
          AND jsonb_typeof(value->'laneId')='string' AND length(value->>'laneId') BETWEEN 1 AND 256
          AND value->>'zoneId'='$journal_zone'
          AND value->>'windowStartInclusive' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,9})?Z$'
          AND value->>'windowEndExclusive' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,9})?Z$'
          AND (value->>'windowStartInclusive')::timestamptz < (value->>'windowEndExclusive')::timestamptz
          AND (value->>'windowStartInclusive')::timestamptz =
            ('$csv_day'::date::timestamp AT TIME ZONE '$journal_zone')
          AND (value->>'windowEndExclusive')::timestamptz =
            ((('$csv_day'::date + 1)::timestamp) AT TIME ZONE '$journal_zone')
          AND jsonb_typeof(value->'recordCount')='number' AND value->>'recordCount' ~ '^(0|[1-9][0-9]*)$'
          AND (value->>'recordCount')::bigint=$actual_records
          AND jsonb_typeof(value->'byteCount')='number' AND value->>'byteCount' ~ '^(0|[1-9][0-9]*)$'
          AND (value->>'byteCount')::bigint=$actual_bytes
          AND value->>'checksumAlgorithm'='SHA-256'
          AND value->>'sha256'='$actual_sha'
          AND value->>'dataFile'='$csv_name'
          AND value->>'dataFile' ~ '^[A-Za-z0-9._-]+-[0-9a-f]{12}_[0-9]{4}-[0-9]{2}-[0-9]{2}[.]csv$'
          AND value->>'publishedAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,9})?Z$'
          AND (value->>'publishedAt')::timestamptz IS NOT NULL
          AND (value->>'publishedAt')::timestamptz >=
            (value->>'windowEndExclusive')::timestamptz
        FROM doc;")
      if [[ $manifest_valid == t ]]; then validated=$((validated+1)); else failures=$((failures+1)); fi
    done
    printf '{"publications":%s,"manifests":%s,"validatedManifests":%s,"manifestFailures":%s,"partialFiles":%s,"unsafeLinks":%s,"unsafeEntries":%s,"bounded":true,"inventoryEntries":%s,"zoneId":"%s","currentDate":"%s","eligiblePriorDayDirectories":%s,"currentDayDirectories":%s,"currentDayOpenSegments":%s,"currentDaySealedSegments":%s,"currentDayBytes":%s,"journalIntegrityFailures":%s,"openSegments":%s,"sealedSegments":%s}\n' \
      "$publications" "$manifests" "$validated" "$failures" "$partial" "$unsafe_links" "$unsafe_entries" \
      "$inventory_entries" "$journal_zone" "$journal_today" "$eligible_prior_days" \
      "$current_day_directories" "$current_day_open" "$current_day_sealed" "$current_day_bytes" \
      "$journal_integrity_failures" "$open" "$segments"
    ;;

  journal-lane-state)
    lane_uid=${1:-}
    [[ $lane_uid =~ ^urn:osh:system:lane:[A-Za-z0-9._-]{1,200}$ ]] ||
      fail 'Direct-journal lane UID is outside the canonical regression fixture namespace.'
    safe_lane=$(printf '%s' "$lane_uid" | sed 's/[^A-Za-z0-9._-]/_/g')
    if ((${#safe_lane} > 120)); then safe_lane=${safe_lane:0:120}; fi
    lane_hash=$(printf '%s' "$lane_uid" | sha256sum | cut -c1-12)
    directory_id="$safe_lane-$lane_hash"
    [[ $directory_id =~ ^[A-Za-z0-9._-]+$ ]] || fail 'Could not derive the direct-journal lane directory.'
    compose exec -T oscar sh -eu -c '
      directory_id=$1; lane_uid=$2
      root=/var/lib/oscar/files/.dailyfile-journal/segments
      [ -d "$root" ] && [ ! -L "$root" ] || exit 20
      lane="$root/$directory_id"
      if [ ! -e "$lane" ] && [ ! -L "$lane" ]; then
        printf "{\"directoryId\":\"%s\",\"present\":false,\"files\":0,\"bytes\":0,\"openSegments\":0,\"sealedSegments\":0,\"partialFiles\":0,\"unsafeEntries\":0,\"segments\":[]}\n" "$directory_id"
        exit 0
      fi
      [ -d "$lane" ] && [ ! -L "$lane" ] || exit 21
      entries=$(find "$lane" -mindepth 1 -print | wc -l | tr -d "[:space:]")
      [ "$entries" -le 10000 ] || exit 22
      identity_bad=0
      if [ ! -f "$lane/lane.id" ] || [ -L "$lane/lane.id" ] ||
         [ "$(wc -c <"$lane/lane.id" | tr -d "[:space:]")" -gt 4096 ] ||
         [ "$(cat -- "$lane/lane.id")" != "$lane_uid" ]; then identity_bad=1; fi
      invalid_days=$(find "$lane" -mindepth 1 -maxdepth 1 -type d -printf "%f\n" |
        grep -Evc "^[0-9]{4}-[0-9]{2}-[0-9]{2}$" || true)
      unexpected_root=$(find "$lane" -mindepth 1 -maxdepth 1 ! -type d ! -name lane.id -print | wc -l | tr -d "[:space:]")
      unexpected_deep=$(find "$lane" -mindepth 3 -print | wc -l | tr -d "[:space:]")
      invalid_segments=$(find "$lane" -mindepth 2 -maxdepth 2 -type f -printf "%f\n" |
        grep -Evc "^[0-9]{6}[.](open|seg)$" || true)
      nonfiles=$(find "$lane" -mindepth 2 -maxdepth 2 ! -type f -print | wc -l | tr -d "[:space:]")
      files=$(find "$lane" -mindepth 2 -maxdepth 2 -type f \( -name "*.open" -o -name "*.seg" \) -print | wc -l | tr -d "[:space:]")
      [ "$files" -le 512 ] || exit 23
      bytes=$(find "$lane" -mindepth 2 -maxdepth 2 -type f \( -name "*.open" -o -name "*.seg" \) -printf "%s\n" | awk "{sum+=\$1} END {print sum+0}")
      open=$(find "$lane" -mindepth 2 -maxdepth 2 -type f -name "*.open" -print | wc -l | tr -d "[:space:]")
      sealed=$(find "$lane" -mindepth 2 -maxdepth 2 -type f -name "*.seg" -print | wc -l | tr -d "[:space:]")
      partial=$(find "$lane" -type f \( -name "*.partial" -o -name "*.partial.*" -o -name "*.partial-*" -o -name "*.tmp" -o -name "*.tmp.*" -o -name "*.tmp-*" \) -print | wc -l | tr -d "[:space:]")
      links=$(find "$lane" -type l -print | wc -l | tr -d "[:space:]")
      unsafe=$((identity_bad+invalid_days+unexpected_root+unexpected_deep+invalid_segments+nonfiles+links))
      printf "{\"directoryId\":\"%s\",\"present\":true,\"files\":%s,\"bytes\":%s,\"openSegments\":%s,\"sealedSegments\":%s,\"partialFiles\":%s,\"unsafeEntries\":%s,\"segments\":[" \
        "$directory_id" "$files" "$bytes" "$open" "$sealed" "$partial" "$unsafe"
      first=true
      find "$lane" -mindepth 2 -maxdepth 2 -type f \( -name "*.open" -o -name "*.seg" \) -print | LC_ALL=C sort |
        while IFS= read -r segment; do
          relative=${segment#"$lane/"}; day=${relative%%/*}; name=${relative##*/}
          [ "$relative" = "$day/$name" ] &&
            printf "%s" "$relative" | grep -Eq "^[0-9]{4}-[0-9]{2}-[0-9]{2}/[0-9]{6}[.](open|seg)$" || exit 24
          size=$(stat -c %s -- "$segment"); sha=$(sha256sum -- "$segment" | awk "{print \$1}")
          kind=${name##*.}
          $first || printf ","
          first=false
          printf "{\"path\":\"%s\",\"kind\":\"%s\",\"bytes\":%s,\"sha256\":\"%s\"}" \
            "$relative" "$kind" "$size" "$sha"
        done
      printf "]}\n"
    ' journal-lane-state "$directory_id" "$lane_uid"
    ;;

  journal-restart)
    lane_uid=${1:-}
    [[ $lane_uid =~ ^urn:osh:system:lane:[A-Za-z0-9._-]{1,200}$ ]] ||
      fail 'Journal restart requires the canonical reserved-lane UID.'
    safe_lane=$(printf '%s' "$lane_uid" | sed 's/[^A-Za-z0-9._-]/_/g')
    if ((${#safe_lane} > 120)); then safe_lane=${safe_lane:0:120}; fi
    lane_hash=$(printf '%s' "$lane_uid" | sha256sum | cut -c1-12)
    directory_id="$safe_lane-$lane_hash"
    restart_work=$(mktemp -d /tmp/oscar-regression-journal-restart.XXXXXXXX)
    before_inventory=$restart_work/before.tsv
    cleanup_journal_restart() { rm -rf -- "$restart_work"; }
    trap cleanup_journal_restart EXIT
    compose exec -T oscar sh -eu -c '
      lane="/var/lib/oscar/files/.dailyfile-journal/segments/$1"
      [ -d "$lane" ] && [ ! -L "$lane" ]
      count=$(find "$lane" -mindepth 2 -maxdepth 2 -type f \( -name "*.open" -o -name "*.seg" \) -print | wc -l | tr -d "[:space:]")
      [ "$count" -gt 0 ] && [ "$count" -le 512 ]
      find "$lane" -mindepth 2 -maxdepth 2 -type f \( -name "*.open" -o -name "*.seg" \) -print | LC_ALL=C sort |
        while IFS= read -r segment; do
          [ -f "$segment" ] && [ ! -L "$segment" ]
          relative=${segment#"$lane/"}
          printf "%s" "$relative" | grep -Eq "^[0-9]{4}-[0-9]{2}-[0-9]{2}/[0-9]{6}[.](open|seg)$"
          size=$(stat -c %s -- "$segment"); [ "$size" -gt 0 ]
          sha=$(sha256sum -- "$segment" | awk "{print \$1}")
          printf "%s|%s|%s\n" "$relative" "$size" "$sha"
        done
    ' journal-restart-before "$directory_id" >"$before_inventory" ||
      fail 'Could not capture the bounded pre-restart segment inventory.'
    segments_before=$(wc -l <"$before_inventory" | tr -d '[:space:]')
    [[ $segments_before =~ ^[1-9][0-9]*$ && $segments_before -le 512 ]] ||
      fail 'Pre-restart segment inventory is empty or exceeds its bound.'
    restart_started=$(date --iso-8601=seconds)
    restart_log=$restart_work/supported-restart.log
    if ! sudo bash oscar.sh restart >"$restart_log" 2>&1; then
      emit_command_diagnostics 'Supported OSCAR restart' "$restart_log"
      fail 'The supported whole-deployment restart failed.'
    fi
    deadline=$((SECONDS+180)); healthy=false
    while ((SECONDS < deadline)); do
      state=$(compose ps --format json oscar 2>/dev/null | grep -o '"Health":"[^"]*"' | head -n1 || true)
      [[ $state == *healthy* ]] && { healthy=true; break; }
      sleep 2
    done
    segments_preserved=0; segment_failures=0; segments_verified=0
    mapfile -t before_rows <"$before_inventory"
    for before_row in "${before_rows[@]}"; do
      IFS='|' read -r relative before_bytes before_sha extra <<<"$before_row"
      [[ -z ${extra:-} && $relative =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}/[0-9]{6}\.(open|seg)$ &&
         $before_bytes =~ ^[1-9][0-9]*$ && $before_sha =~ ^[0-9a-f]{64}$ ]] ||
        fail 'Pre-restart segment inventory is malformed.'
      segments_verified=$((segments_verified+1))
      lane_root="/var/lib/oscar/files/.dailyfile-journal/segments/$directory_id"
      preserved=false
      if [[ $relative == *.seg ]]; then
        result=$(compose exec -T oscar sh -eu -c '
          candidate="$1/$2"; expected_bytes=$3; expected_sha=$4
          [ -f "$candidate" ] && [ ! -L "$candidate" ]
          [ "$(stat -c %s -- "$candidate")" = "$expected_bytes" ]
          [ "$(sha256sum -- "$candidate" | awk "{print \$1}")" = "$expected_sha" ]
          printf preserved
        ' journal-restart-sealed "$lane_root" "$relative" "$before_bytes" "$before_sha" 2>/dev/null || true)
        [[ $result == preserved ]] && preserved=true
      else
        sealed_relative=${relative%.open}.seg
        result=$(compose exec -T oscar sh -eu -c '
          root=$1; open=$2; sealed=$3; expected_bytes=$4; expected_sha=$5
          matches=0; candidate=
          for relative in "$open" "$sealed"; do
            path="$root/$relative"
            if [ -e "$path" ] || [ -L "$path" ]; then
              [ -f "$path" ] && [ ! -L "$path" ]; matches=$((matches+1)); candidate=$path
            fi
          done
          [ "$matches" -eq 1 ]
          size=$(stat -c %s -- "$candidate"); [ "$size" -ge "$expected_bytes" ]
          prefix_sha=$(head -c "$expected_bytes" -- "$candidate" | sha256sum | awk "{print \$1}")
          [ "$prefix_sha" = "$expected_sha" ]
          printf preserved
        ' journal-restart-open "$lane_root" "$relative" "$sealed_relative" "$before_bytes" "$before_sha" 2>/dev/null || true)
        [[ $result == preserved ]] && preserved=true
      fi
      if $preserved; then segments_preserved=$((segments_preserved+1));
      else segment_failures=$((segment_failures+1)); fi
    done
    [[ $segments_verified == "$segments_before" ]] ||
      fail 'Restart verification did not inspect every captured journal segment.'
    # Hidden camera partials created after the restart are legitimate active recordings on a
    # live multi-lane site.  Count only pre-restart partials that survived the supported restart,
    # plus every temporary publication artifact (which is never a live camera output).
    partial=$(compose exec -T oscar sh -eu -c '
      root=/var/lib/oscar/files; cutoff=$1
      {
        find "$root" -type f \( -name "*.partial" -o -name "*.partial.*" -o -name "*.partial-*" \) \
          ! -newermt "$cutoff" -print
        find "$root" -type f \( -name "*.tmp" -o -name "*.tmp.*" -o -name "*.tmp-*" \) -print
      } 2>/dev/null | wc -l
    ' journal-restart-partials "$restart_started")
    restart_service_log=$restart_work/restart-services.log
    if ! compose logs --since "$restart_started" oscar postgres >"$restart_service_log" 2>&1; then
      emit_command_diagnostics 'Supported restart service-log collection' "$restart_service_log"
      fail 'Could not collect the exact supported-restart service log window.'
    fi
    recovery_errors=$(grep -Eic 'daily.?file.*(corrupt|recovery failed|checksum mismatch)' "$restart_service_log" || true)
    shutdown_errors=$(grep -Eic '(BasicEventHandler|DataStreamTransactionHandler|DatabasePurger|ModuleRegistry).*(error|failed|timed out|timeout|administrator command)|(error|failed|timed out|timeout|administrator command).*(BasicEventHandler|DataStreamTransactionHandler|DatabasePurger|ModuleRegistry)' "$restart_service_log" || true)
    camera_recording_errors=$(grep -Eic 'Timed out waiting for camera .* command; quarantining its queue|Camera .* command queue is quarantined|Timed out waiting for video files for occupancy generation|returned a stale or mismatched saved-video result for occupancy generation|Camera .* failed to close occupancy generation|Failed to finish matched camera recording generation' "$restart_service_log" || true)
    printf '{"healthy":%s,"segmentsChecked":%s,"segmentsPreserved":%s,"segmentFailures":%s,"partialFiles":%s,"recoveryErrors":%s,"shutdownErrors":%s,"cameraRecordingErrors":%s}\n' \
      "$healthy" "$segments_before" "$segments_preserved" "$segment_failures" "${partial:-0}" "$recovery_errors" "$shutdown_errors" "$camera_recording_errors"
    cleanup_journal_restart
    trap - EXIT
    ;;

  fixture-create)
    run=${1:-}; retention=${2:-}; valid_run "$run" || fail 'Invalid run ID.'
    [[ $retention =~ ^[1-9][0-9]*$ ]] || fail 'Invalid retention days.'
    ensure_fixture_table
    [[ $(scalar "SELECT count(*) FROM oscar_regression_fixture WHERE run_id='$run';") == 0 ]] || fail 'Fixture already exists.'
    create_observation_fixture "$run" \
      "fixture_clock.sampled_at-make_interval(days=>$retention+2)" \
      "fixture_clock.sampled_at-interval '1 minute'"
    ;;

  fixture-create-race)
    run=${1:-}; retention=${2:-}; valid_run "$run" || fail 'Invalid run ID.'
    [[ $retention =~ ^[1-9][0-9]*$ ]] || fail 'Invalid retention days.'
    ensure_fixture_table
    [[ $(scalar "SELECT count(*) FROM oscar_regression_fixture WHERE run_id='$run';") == 0 ]] || fail 'Fixture already exists.'
    suffix=$(printf '%s' "$run" | sha256sum | awk '{print substr($1,1,12)}')
    trigger_name="oscar_regression_activation_$suffix"
    function_name="oscar_regression_activation_fn_$suffix"
    holder_app="oscar_regression_holder_$suffix"
    lock_class=$((16#${suffix:0:6})); lock_object=$((16#${suffix:6:6}))
    race_work=$(mktemp -d "/tmp/oscar-regression-activation-$suffix.XXXXXXXX")
    holder_log="$race_work/holder.log"
    holder_client=''; race_fixture_created=false; race_success=false
    cleanup_activation_race() {
      psql_admin --command "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name='$holder_app' AND pid<>pg_backend_pid();" >/dev/null 2>&1 || true
      if [[ -n $holder_client ]]; then wait "$holder_client" >/dev/null 2>&1 || true; fi
      psql_admin --command "DROP TRIGGER IF EXISTS $trigger_name ON obs; DROP FUNCTION IF EXISTS $function_name();" >/dev/null 2>&1 || true
      if [[ $race_success != true && -s $holder_log ]]; then
        emit_command_diagnostics 'PostgreSQL activation barrier holder' "$holder_log"
      fi
      rm -rf -- "$race_work"
      if [[ $race_fixture_created == true && $race_success != true ]]; then
        psql_admin --command "WITH f AS (DELETE FROM oscar_regression_fixture WHERE run_id='$run' RETURNING cold_id,hot_id)
          DELETE FROM obs WHERE id IN (SELECT cold_id FROM f UNION ALL SELECT hot_id FROM f);" >/dev/null 2>&1 || true
      fi
    }
    trap cleanup_activation_race EXIT
    [[ $(scalar "SELECT count(*) FROM pg_trigger WHERE tgname='$trigger_name';") == 0 ]] ||
      fail 'The activation-race trigger already exists.'
    (
      compose exec -T postgres sh -eu -c '
        PGPASSWORD=$(cat /run/secrets/postgres_bootstrap_password)
        PGOPTIONS=-csearch_path=oscar,public
        PGAPPNAME=$1
        export PGPASSWORD PGOPTIONS PGAPPNAME
        exec psql --set=ON_ERROR_STOP=1 --username oscar_bootstrap --dbname gis \
          --command "SELECT pg_advisory_lock($2,$3); SELECT pg_sleep(240);"
      ' activation-holder "$holder_app" "$lock_class" "$lock_object"
    ) >"$holder_log" 2>&1 &
    holder_client=$!
    deadline=$((SECONDS+30)); holder_ready=false
    while ((SECONDS < deadline)); do
      held=$(scalar "SELECT count(*) FROM pg_locks l JOIN pg_stat_activity a USING(pid)
        WHERE a.application_name='$holder_app' AND l.locktype='advisory' AND l.classid=$lock_class::oid
          AND l.objid=$lock_object::oid AND l.granted;")
      [[ $held == 1 ]] && { holder_ready=true; break; }
      sleep 1
    done
    $holder_ready || fail 'Could not establish the PostgreSQL activation barrier.'
    race_started=$(scalar "SELECT to_char(clock_timestamp(),'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"');")
    create_observation_fixture "$run" \
      "fixture_clock.sampled_at-interval '2 minutes'" \
      "fixture_clock.sampled_at-interval '1 minute'" >/dev/null
    race_fixture_created=true
    cold_id=$(scalar "SELECT cold_id FROM oscar_regression_fixture WHERE run_id='$run';")
    [[ $cold_id =~ ^[1-9][0-9]{0,18}$ ]] || fail 'Could not identify the activation-race cold row.'
    psql_admin --command "CREATE FUNCTION $function_name() RETURNS trigger LANGUAGE plpgsql AS \$\$
      DECLARE should_block boolean := false;
      BEGIN
        IF to_regclass('pg_temp.oscar_archive_activation_row') IS NOT NULL THEN
          EXECUTE 'SELECT EXISTS (SELECT 1 FROM pg_temp.oscar_archive_activation_row WHERE observation_id=$cold_id)'
            INTO should_block;
        END IF;
        IF should_block THEN PERFORM pg_advisory_xact_lock($lock_class,$lock_object); END IF;
        RETURN NULL;
      END \$\$;
      CREATE TRIGGER $trigger_name BEFORE UPDATE OF archivegenerationid ON obs FOR EACH STATEMENT
        EXECUTE FUNCTION $function_name();" >/dev/null
    chilled=$(scalar "WITH boundary AS (
        SELECT now()-make_interval(days=>$retention+2) archived_at),
      changed AS (UPDATE obs o SET phenomenontime=boundary.archived_at,resulttime=boundary.archived_at
        FROM boundary WHERE o.id=$cold_id AND o.archivegenerationid IS NULL RETURNING o.phenomenontime)
      UPDATE oscar_regression_fixture f SET cold_time=changed.phenomenontime FROM changed
        WHERE f.run_id='$run' AND f.cold_id=$cold_id RETURNING 1;")
    [[ $chilled == 1 ]] || fail 'Could not move the protected fixture row into the archive window.'
    fixture_json=$(json_query "SELECT json_build_object('runId',run_id,'coldId',cold_id::text,'hotId',hot_id::text,
        'datastreamId',datastream_id,'coldTime',cold_time,'hotTime',hot_time)
      FROM oscar_regression_fixture WHERE run_id='$run';")
    deadline=$((SECONDS+180)); activation_blocked=false
    while ((SECONDS < deadline)); do
      waiting=$(scalar "SELECT count(*) FROM pg_locks l JOIN pg_stat_activity a USING(pid)
        WHERE l.locktype='advisory' AND l.classid=$lock_class::oid AND l.objid=$lock_object::oid
          AND NOT l.granted AND a.application_name<>'$holder_app';")
      [[ $waiting =~ ^[1-9][0-9]*$ ]] && { activation_blocked=true; break; }
      sleep 1
    done
    $activation_blocked || fail 'Archive activation did not reach the controlled exact-row barrier.'
    changed=$(scalar "UPDATE obs SET resulttime=resulttime+interval '1 microsecond'
      WHERE id=(SELECT cold_id FROM oscar_regression_fixture WHERE run_id='$run') AND archivegenerationid IS NULL RETURNING 1;")
    [[ $changed == 1 ]] || fail 'Could not mutate the unactivated fixture row at the concurrency barrier.'
    psql_admin --command "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name='$holder_app' AND pid<>pg_backend_pid();" >/dev/null
    wait "$holder_client" >/dev/null 2>&1 || true; holder_client=''
    deadline=$((SECONDS+60)); stale_rejected=false
    while ((SECONDS < deadline)); do
      rejected=$(scalar "SELECT count(*) FROM oscar_archive_job j,oscar_regression_fixture f
        WHERE f.run_id='$run' AND j.window_start<=f.cold_time AND j.window_end>f.cold_time
          AND j.state='FAILED' AND j.updated_at>='$race_started'::timestamptz;")
      unmarked=$(scalar "SELECT count(*) FROM obs o JOIN oscar_regression_fixture f ON o.id=f.cold_id
        WHERE f.run_id='$run' AND o.archivegenerationid IS NULL;")
      [[ $rejected =~ ^[1-9][0-9]*$ && $unmarked == 1 ]] && { stale_rejected=true; break; }
      sleep 1
    done
    $stale_rejected || fail 'The stale archive export was not rejected with its exact source row left unmarked.'
    race_success=true
    cleanup_activation_race
    trap - EXIT
    printf '%s' "${fixture_json%?}"
    printf ',"activationBlocked":true,"sourceMutated":true,"staleActivationRejected":true,"staleRowUnmarked":true}\n'
    ;;

  fixture-status)
    run=${1:-}; valid_run "$run" || fail 'Invalid run ID.'; ensure_fixture_table
    json_query "WITH f AS (SELECT * FROM oscar_regression_fixture WHERE run_id='$run'), g AS (
      SELECT g.* FROM f LEFT JOIN obs archived_observation ON archived_observation.id=f.cold_id
      JOIN oscar_archive_generation g ON g.id=coalesce(f.generation_id,archived_observation.archivegenerationid)
      WHERE g.state IN ('ACTIVE','SEALED') ORDER BY g.activated_at DESC LIMIT 1),
    saved AS (UPDATE oscar_regression_fixture f SET generation_id=g.id FROM g WHERE f.run_id='$run' RETURNING f.*)
    SELECT json_build_object('exists',EXISTS(SELECT 1 FROM f),'generationId',(SELECT id FROM g),'generationState',(SELECT state FROM g),
      'parityVerified',coalesce((SELECT parity_verified FROM g),false),'generationRows',coalesce((SELECT row_count FROM g),0),
      'generationMinId',(SELECT min_id::text FROM g),'generationMaxId',(SELECT max_id::text FROM g),
      'markedRows',coalesce((SELECT count(*) FROM obs o,g WHERE o.archivegenerationid=g.id),0),
      'fixtureColdMarked',coalesce((SELECT o.archivegenerationid=g.id FROM obs o,f,g WHERE o.id=f.cold_id),false),
      'fixtureHotUnmarked',coalesce((SELECT o.archivegenerationid IS NULL FROM obs o,f WHERE o.id=f.hot_id),false),
      'exactRowOwnership',coalesce((SELECT g.row_count=1 AND g.min_id=f.cold_id AND g.max_id=f.cold_id
        AND (SELECT count(*) FROM obs o WHERE o.archivegenerationid=g.id)=1
        AND (SELECT o.archivegenerationid=g.id FROM obs o WHERE o.id=f.cold_id)
        AND (SELECT o.archivegenerationid IS NULL FROM obs o WHERE o.id=f.hot_id) FROM f,g),false),
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
    store_key=$(scalar "SELECT store_key FROM oscar_archive_generation WHERE id='$generation';")
    id_scope=$(scalar "SELECT id_scope FROM oscar_archive_generation WHERE id='$generation';")
    valid_store_key "$store_key" && valid_id_scope "$id_scope" ||
      fail 'Fixture archive generation has an invalid store identity.'
    export_root=$(mktemp -d "/tmp/oscar-regression-export-${run}.XXXXXX")
    trap 'rm -rf -- "$export_root"' EXIT
    sudo bash oscar.sh archive export --store-key "$store_key" --id-scope "$id_scope" \
      --generation "$generation" --destination "$export_root/portable" >/dev/null
    (cd "$export_root/portable" && sha256sum --check SHA256SUMS >/dev/null)
    parquet=$(find "$export_root/portable" -type f -name '*.parquet' | wc -l)
    manifests=$(find "$export_root/portable" -type f -name 'manifest*.json' | wc -l)
    schemas=$(find "$export_root/portable" -type f -name '*schema*' | wc -l)
    [[ -s $export_root/portable/query.sql && -s $export_root/portable/README.md && $parquet -gt 0 ]] || fail 'Portable export is incomplete.'
    printf '{"generationId":"%s","checksumVerified":true,"parquetFiles":%s,"manifestFiles":%s,"schemaFiles":%s,"querySql":true,"readme":true}\n' "$generation" "$parquet" "$manifests" "$schemas"
    ;;

  archive-helper-check)
    run=${1:-}; valid_run "$run" || fail 'Invalid run ID.'; ensure_fixture_table
    generation=$(scalar "SELECT generation_id FROM oscar_regression_fixture WHERE run_id='$run';")
    valid_uuid "$generation" || fail 'Fixture has no archive generation.'
    object=$(psql_admin --tuples-only --no-align --field-separator=$'\t' --command \
      "SELECT relative_path,sha256 FROM oscar_archive_object WHERE generation_id='$generation' AND state='ACTIVE' ORDER BY relative_path LIMIT 1;" | tail -n1)
    IFS=$'\t' read -r relative expected_sha <<<"$object"
    [[ -n $relative && $expected_sha =~ ^[0-9a-f]{64}$ ]] || fail 'Fixture has no valid active archive object.'
    export_root="/tmp/oscar-regression-archive-helper-$run"
    compose exec -T oscar sh -eu -c 'test ! -e "$1" && test ! -L "$1"; mkdir -m 0700 "$1"' helper-fixture "$export_root"
    cleanup_archive_helper_fixture() {
      compose exec -T oscar sh -eu -c 'case $1 in /tmp/oscar-regression-archive-helper-*) rm -rf -- "$1" ;; *) exit 2 ;; esac' \
        helper-cleanup "$export_root" >/dev/null 2>&1 || true
    }
    trap cleanup_archive_helper_fixture EXIT
    compose exec -T -e OSCAR_ARCHIVE_HELPER_ROOT=/var/lib/oscar/archive \
      -e OSCAR_ARCHIVE_HELPER_EXPORT_ROOT="$export_root" oscar \
      /usr/local/bin/oscar-archive-object verify "$relative" "$expected_sha" >/dev/null
    compose exec -T -e OSCAR_ARCHIVE_HELPER_ROOT=/var/lib/oscar/archive \
      -e OSCAR_ARCHIVE_HELPER_EXPORT_ROOT="$export_root" oscar \
      /usr/local/bin/oscar-archive-object copy "$relative" "$expected_sha" >/dev/null
    copied_sha=$(compose exec -T oscar sha256sum "$export_root/$relative" | awk '{print $1}')
    [[ $copied_sha == "$expected_sha" ]] || fail 'Archive-object helper copy did not preserve the catalog checksum.'
    wrong_sha=$(printf '0%.0s' {1..64}); [[ $wrong_sha != "$expected_sha" ]] || wrong_sha=$(printf '1%.0s' {1..64})
    mismatch_rejected=false
    if ! compose exec -T -e OSCAR_ARCHIVE_HELPER_ROOT=/var/lib/oscar/archive oscar \
      /usr/local/bin/oscar-archive-object verify "$relative" "$wrong_sha" >/dev/null 2>&1; then
      mismatch_rejected=true
    fi
    traversal_rejected=false
    if ! compose exec -T -e OSCAR_ARCHIVE_HELPER_ROOT=/var/lib/oscar/archive oscar \
      /usr/local/bin/oscar-archive-object verify '../escape' "$expected_sha" >/dev/null 2>&1; then
      traversal_rejected=true
    fi
    cleanup_archive_helper_fixture
    trap - EXIT
    printf '{"generationId":"%s","verified":true,"copied":true,"copyChecksumValid":true,"mismatchRejected":%s,"traversalRejected":%s}\n' \
      "$generation" "$mismatch_rejected" "$traversal_rejected"
    ;;

  wal-helper-check)
    run=${1:-}; valid_run "$run" || fail 'Invalid run ID.'
    wal_name=$(printf '%s' "$run" | sha256sum | awk '{print toupper(substr($1,1,8)) ".history"}')
    wal_root=/var/lib/postgresql/wal-archive
    work="/tmp/oscar-regression-wal-$run"
    wal_published=false
    compose exec -T postgres sh -eu -c '
      test ! -e "$2/$3" && test ! -L "$2/$3"
      test ! -e "$1" && test ! -L "$1"
      mkdir -m 0700 "$1"
      printf "first:%s\n" "$4" >"$1/one"
      printf "second:%s\n" "$4" >"$1/two"
    ' wal-fixture "$work" "$wal_root" "$wal_name" "$run"
    cleanup_wal_helper_fixture() {
      compose exec -T postgres sh -eu -c '
        case $1 in /tmp/oscar-regression-wal-*) rm -rf -- "$1" ;; *) exit 2 ;; esac
        if [ "$4" = true ]; then rm -f -- "$2/$3"; fi
        find "$2" -maxdepth 1 -type f -name ".$3.partial.*" -exec rm -f -- {} +
      ' wal-cleanup "$work" "$wal_root" "$wal_name" "$wal_published" >/dev/null 2>&1 || true
    }
    trap cleanup_wal_helper_fixture EXIT
    compose exec -T postgres /usr/local/bin/oscar-archive-wal "$work/one" "$wal_name" "$wal_root" >/dev/null
    wal_published=true
    compose exec -T postgres /usr/local/bin/oscar-archive-wal "$work/one" "$wal_name" "$wal_root" >/dev/null
    mismatch_rejected=false
    if ! compose exec -T postgres /usr/local/bin/oscar-archive-wal "$work/two" "$wal_name" "$wal_root" >/dev/null 2>&1; then
      mismatch_rejected=true
    fi
    compose exec -T postgres cmp -s -- "$work/one" "$wal_root/$wal_name" ||
      fail 'WAL helper mismatch attempt replaced the originally published bytes.'
    helper_partials=$(compose exec -T postgres sh -c 'find "$1" -maxdepth 1 -type f -name ".$2.partial.*" -print | wc -l' \
      wal-partials "$wal_root" "$wal_name" | tr -d '[:space:]')
    [[ $helper_partials == 0 ]] || fail 'WAL helper left a synthetic partial artifact.'
    cleanup_wal_helper_fixture
    trap - EXIT
    final_removed=false
    compose exec -T postgres sh -c 'test ! -e "$1/$2" && test ! -L "$1/$2"' wal-clean "$wal_root" "$wal_name" && final_removed=true
    printf '{"walName":"%s","published":true,"idempotentRetry":true,"mismatchRejected":%s,"originalPreserved":true,"partialArtifacts":%s,"fixtureRemoved":%s}\n' \
      "$wal_name" "$mismatch_rejected" "$helper_partials" "$final_removed"
    ;;

  fixture-hot-hold-create)
    run=${1:-}; valid_run "$run" || fail 'Invalid run ID.'; ensure_fixture_table
    generation=$(scalar "SELECT generation_id FROM oscar_regression_fixture WHERE run_id='$run';")
    valid_uuid "$generation" || fail 'Fixture has no archive generation.'
    store_key=$(scalar "SELECT store_key FROM oscar_archive_generation WHERE id='$generation';")
    id_scope=$(scalar "SELECT id_scope FROM oscar_archive_generation WHERE id='$generation';")
    hot_id=$(scalar "SELECT hot_id FROM oscar_regression_fixture WHERE run_id='$run';")
    valid_store_key "$store_key" && valid_id_scope "$id_scope" || fail 'Fixture has an invalid store identity.'
    [[ $hot_id =~ ^[1-9][0-9]{0,18}$ ]] || fail 'Fixture has no valid hot observation ID.'
    [[ $(scalar "SELECT count(*) FROM \"$store_key\" WHERE id=$hot_id;") == 1 ]] ||
      fail 'Fixture hot observation is no longer present.'
    hot_hold=''; keep_hot_hold=false
    cleanup_hot_hold_create() {
      if [[ $keep_hot_hold != true ]] && valid_uuid "$hot_hold"; then
        sudo bash oscar.sh archive hold release --id "$hot_hold" --released-by oscar-regression-cleanup >/dev/null 2>&1 || true
      fi
    }
    trap cleanup_hot_hold_create EXIT
    hot_output=$(sudo bash oscar.sh archive hold create --store-key "$store_key" --id-scope "$id_scope" \
      --observation "$hot_id" --reason "regression-hot-$run" --created-by oscar-regression)
    hot_hold=$(retention_hold_id_from_output "$hot_output" "$store_key" "$id_scope" HOT_EXACT) ||
      fail 'Hot observation hold did not return one canonical HOT_EXACT ID.'
    [[ $(scalar "SELECT count(*) FROM oscar_retention_hold WHERE id='$hot_hold' AND store_key='$store_key' AND id_scope=$id_scope AND subject_type='OBSERVATION' AND subject_id='$hot_id' AND resolution_mode='HOT_EXACT' AND reason='regression-hot-$run' AND created_by='oscar-regression' AND released_at IS NULL;") == 1 ]] ||
      fail 'Created hot observation hold is not exact or active.'
    hot_list=$(sudo bash oscar.sh archive hold list)
    hot_listed=false
    grep -Eq "^[[:space:]]*$hot_hold[[:space:]|]+$store_key[[:space:]|]+$id_scope[[:space:]|]+OBSERVATION[[:space:]|]+$hot_id[[:space:]|]+HOT_EXACT([[:space:]|]+|$)" <<<"$hot_list" && hot_listed=true
    [[ $hot_listed == true ]] || fail 'Created HOT_EXACT hold is absent from the operator list.'
    keep_hot_hold=true
    trap - EXIT
    printf '{"holdId":"%s","storeKey":"%s","idScope":%s,"hotId":"%s","resolution":"HOT_EXACT","listed":true}\n' \
      "$hot_hold" "$store_key" "$id_scope" "$hot_id"
    ;;

  fixture-hot-hold-release)
    run=${1:-}; hot_hold=${2:-}; valid_run "$run" || fail 'Invalid run ID.'
    valid_uuid "$hot_hold" || fail 'Invalid hot-hold ID.'; ensure_fixture_table
    exact=$(scalar "SELECT count(*) FROM oscar_retention_hold h JOIN oscar_regression_fixture f ON f.run_id='$run' JOIN oscar_archive_generation g ON g.id=f.generation_id WHERE h.id='$hot_hold' AND h.store_key=g.store_key AND h.id_scope=g.id_scope AND h.subject_type='OBSERVATION' AND h.subject_id=f.hot_id::text AND h.resolution_mode='HOT_EXACT' AND h.reason='regression-hot-$run' AND h.created_by='oscar-regression' AND h.released_at IS NULL;")
    [[ $exact == 1 ]] || fail 'Hot hold does not match the registered disposable fixture.'
    sudo bash oscar.sh archive hold release --id "$hot_hold" --released-by oscar-regression >/dev/null
    released=false
    [[ $(scalar "SELECT count(*) FROM oscar_retention_hold WHERE id='$hot_hold' AND released_at IS NOT NULL AND released_by='oscar-regression';") == 1 ]] && released=true
    printf '{"holdId":"%s","released":%s}\n' "$hot_hold" "$released"
    ;;

  fixture-controls)
    run=${1:-}; valid_run "$run" || fail 'Invalid run ID.'; ensure_fixture_table
    generation=$(scalar "SELECT generation_id FROM oscar_regression_fixture WHERE run_id='$run';")
    valid_uuid "$generation" || fail 'Fixture has no archive generation.'
    [[ $(scalar "SELECT state FROM oscar_archive_generation WHERE id='$generation';") == SEALED ]] || fail 'Fixture generation is not SEALED.'
    store_key=$(scalar "SELECT store_key FROM oscar_archive_generation WHERE id='$generation';")
    id_scope=$(scalar "SELECT id_scope FROM oscar_archive_generation WHERE id='$generation';")
    cold_id=$(scalar "SELECT cold_id FROM oscar_regression_fixture WHERE run_id='$run';")
    valid_store_key "$store_key" && valid_id_scope "$id_scope" ||
      fail 'Fixture archive generation has an invalid store identity.'
    [[ $cold_id =~ ^[1-9][0-9]{0,18}$ ]] || fail 'Fixture has no valid archived observation ID.'
    cutoff=$(psql_admin --tuples-only --no-align --command "SELECT to_char(window_end+interval '1 second','YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') FROM oscar_archive_generation WHERE id='$generation';" | tr -d '[:space:]')
    [[ $cutoff =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] ||
      fail 'Fixture archive generation has no canonical deletion cutoff.'
    generation_hold=''; observation_hold=''
    cleanup_control_holds() {
      set +e
      for pending_hold in "$generation_hold" "$observation_hold"; do
        valid_uuid "$pending_hold" || continue
        sudo bash oscar.sh archive hold release --id "$pending_hold" --released-by oscar-regression-cleanup >/dev/null 2>&1
      done
      while IFS= read -r pending_hold; do
        valid_uuid "$pending_hold" || continue
        sudo bash oscar.sh archive hold release --id "$pending_hold" --released-by oscar-regression-cleanup >/dev/null 2>&1
      done < <(psql_admin --quiet --tuples-only --no-align --command "
        SELECT id::text FROM oscar_retention_hold
         WHERE released_at IS NULL AND store_key='$store_key' AND id_scope=$id_scope
           AND created_by='oscar-regression'
           AND ((subject_type='ARCHIVE_GENERATION' AND subject_id='$generation' AND reason='regression-$run')
             OR (subject_type='OBSERVATION' AND subject_id='$cold_id' AND reason='regression-observation-$run'))
         ORDER BY id;")
      set -e
    }
    trap cleanup_control_holds EXIT
    hold_output=$(sudo bash oscar.sh archive hold create --store-key "$store_key" --id-scope "$id_scope" \
      --generation "$generation" --reason "regression-$run" --created-by oscar-regression)
    hold=$(retention_hold_id_from_output "$hold_output" "$store_key" "$id_scope" GENERATION_EXACT) ||
      fail 'Hold create did not return one canonical exact-generation ID.'
    generation_hold=$hold
    [[ $(scalar "SELECT count(*) FROM oscar_retention_hold WHERE id='$hold' AND subject_type='ARCHIVE_GENERATION' AND resolution_mode='GENERATION_EXACT' AND released_at IS NULL;") == 1 ]] || fail 'Created exact-generation hold is not listed.'
    generation_hold_listed=false
    hold_list=$(sudo bash oscar.sh archive hold list)
    grep -Eq "^[[:space:]]*$hold[[:space:]|]+$store_key[[:space:]|]+$id_scope[[:space:]|]+ARCHIVE_GENERATION[[:space:]|]+$generation[[:space:]|]+GENERATION_EXACT([[:space:]|]+|$)" <<<"$hold_list" &&
      generation_hold_listed=true
    generation_held_dry=$(sudo bash oscar.sh archive dry-run --store-key "$store_key" --id-scope "$id_scope" \
      --before "$cutoff" --requested-by oscar-regression)
    generation_held_plan=$(printf '%s' "$generation_held_dry" | sed -n 's/^Deletion plan: //p')
    valid_uuid "$generation_held_plan" || fail 'Generation-held dry run did not return a plan.'
    generation_hold_enforced=false
    if [[ $(scalar "SELECT count(*) FROM oscar_deletion_plan_item WHERE plan_id='$generation_held_plan';") == 0 &&
          $(scalar "SELECT hold_count FROM oscar_deletion_plan WHERE id='$generation_held_plan';") == 1 ]]; then
      generation_hold_enforced=true
    fi
    psql_admin --command "DELETE FROM oscar_deletion_plan WHERE id='$generation_held_plan' AND state='PLANNED';" >/dev/null
    sudo bash oscar.sh archive hold release --id "$hold" --released-by oscar-regression >/dev/null
    [[ $(scalar "SELECT count(*) FROM oscar_retention_hold WHERE id='$hold' AND released_at IS NOT NULL;") == 1 ]] || fail 'Hold was not released.'
    generation_hold=''
    observation_hold_output=$(sudo bash oscar.sh archive hold create --store-key "$store_key" --id-scope "$id_scope" \
      --observation "$cold_id" --reason "regression-observation-$run" --created-by oscar-regression)
    observation_hold=$(retention_hold_id_from_output "$observation_hold_output" "$store_key" "$id_scope" COLD_RANGE_CONSERVATIVE) ||
      fail 'Observation hold create did not return one canonical conservative cold-range ID.'
    [[ $(scalar "SELECT count(*) FROM oscar_retention_hold WHERE id='$observation_hold' AND subject_type='OBSERVATION' AND subject_id='$cold_id' AND resolution_mode='COLD_RANGE_CONSERVATIVE' AND released_at IS NULL;") == 1 ]] ||
      fail 'Created observation hold is not listed.'
    observation_hold_listed=false
    hold_list=$(sudo bash oscar.sh archive hold list)
    grep -Eq "^[[:space:]]*$observation_hold[[:space:]|]+$store_key[[:space:]|]+$id_scope[[:space:]|]+OBSERVATION[[:space:]|]+$cold_id[[:space:]|]+COLD_RANGE_CONSERVATIVE([[:space:]|]+|$)" <<<"$hold_list" &&
      observation_hold_listed=true
    observation_held_dry=$(sudo bash oscar.sh archive dry-run --store-key "$store_key" --id-scope "$id_scope" \
      --before "$cutoff" --requested-by oscar-regression)
    observation_held_plan=$(printf '%s' "$observation_held_dry" | sed -n 's/^Deletion plan: //p')
    valid_uuid "$observation_held_plan" || fail 'Observation-held dry run did not return a plan.'
    observation_hold_enforced=false
    if [[ $(scalar "SELECT count(*) FROM oscar_deletion_plan_item WHERE plan_id='$observation_held_plan';") == 0 &&
          $(scalar "SELECT hold_count FROM oscar_deletion_plan WHERE id='$observation_held_plan';") == 1 ]]; then
      observation_hold_enforced=true
    fi
    psql_admin --command "DELETE FROM oscar_deletion_plan WHERE id='$observation_held_plan' AND state='PLANNED';" >/dev/null
    sudo bash oscar.sh archive hold release --id "$observation_hold" --released-by oscar-regression >/dev/null
    [[ $(scalar "SELECT count(*) FROM oscar_retention_hold WHERE id='$observation_hold' AND released_at IS NOT NULL;") == 1 ]] ||
      fail 'Observation hold was not released.'
    observation_hold=''
    trap - EXIT
    dry=$(sudo bash oscar.sh archive dry-run --store-key "$store_key" --id-scope "$id_scope" \
      --before "$cutoff" --requested-by oscar-regression)
    plan=$(printf '%s' "$dry" | sed -n 's/^Deletion plan: //p'); token=$(printf '%s' "$dry" | sed -n 's/^Confirmation token (shown once): //p')
    valid_uuid "$plan" && [[ $token =~ ^[0-9a-f]{48}$ ]] || fail 'Dry run did not return plan/token.'
    candidates=$(scalar "SELECT count(*) FROM oscar_deletion_plan_item WHERE plan_id='$plan';")
    only=$(scalar "SELECT count(*) FROM oscar_deletion_plan_item WHERE plan_id='$plan' AND generation_id='$generation';")
    if [[ $candidates != 1 || $only != 1 ]]; then
      psql_admin --command "DELETE FROM oscar_deletion_plan WHERE id='$plan' AND state='PLANNED';" >/dev/null
      fail 'Deletion plan included non-fixture generations; it was cancelled.'
    fi
    wrong=${token%?}0; [[ $wrong != "$token" ]] || wrong=${token%?}1
    if sudo bash oscar.sh archive purge --store-key "$store_key" --id-scope "$id_scope" \
      --plan "$plan" --token "$wrong" >/dev/null 2>&1; then fail 'Wrong token unexpectedly succeeded.'; fi
    [[ $(scalar "SELECT state FROM oscar_deletion_plan WHERE id='$plan';") == PLANNED ]] || fail 'Wrong token changed plan state.'
    sudo bash oscar.sh archive purge --store-key "$store_key" --id-scope "$id_scope" \
      --plan "$plan" --token "$token" >/dev/null
    replay_rejected=false
    sudo bash oscar.sh archive purge --store-key "$store_key" --id-scope "$id_scope" \
      --plan "$plan" --token "$token" >/dev/null 2>&1 || replay_rejected=true
    json_query "SELECT json_build_object('holdCreated',true,'holdListed',true,'holdReleased',true,
      'generationHoldCreated',true,'generationHoldResolution','GENERATION_EXACT',
      'generationHoldListed',$generation_hold_listed,'generationHoldEnforced',$generation_hold_enforced,
      'observationHoldCreated',true,'observationHoldResolution','COLD_RANGE_CONSERVATIVE',
      'observationHoldListed',$observation_hold_listed,'coldObservationHoldEnforced',$observation_hold_enforced,
      'dryRunPlan','$plan',
      'wrongTokenRejected',true,'purged',g.state='PURGED','objectsDeleted',NOT EXISTS(SELECT 1 FROM oscar_archive_object o WHERE o.generation_id=g.id AND o.state<>'DELETED'),
      'tombstonePresent',EXISTS(SELECT 1 FROM oscar_tombstone t WHERE t.generation_id=g.id),
      'ledgerPresent',EXISTS(SELECT 1 FROM oscar_deletion_ledger l WHERE l.plan_id='$plan' AND l.outcome='DELETED'),
      'tokenReplayRejected',$replay_rejected) FROM oscar_archive_generation g WHERE g.id='$generation';"
    ;;

  backup-check)
    (($# > 0 && $# <= 8)) ||
      fail 'Backup certification requires one to eight exact retained-media set expectations.'
    backup_work=$(mktemp -d /tmp/oscar-regression-backup-check.XXXXXXXX)
    backup_services_quiesced=false
    cleanup_backup_check() {
      local status=$? recovery_log=$backup_work/service-recovery.log had_errexit=false
      [[ $- == *e* ]] && had_errexit=true
      trap - EXIT
      set +e
      if $backup_services_quiesced; then
        if ! sudo bash oscar.sh start >"$recovery_log" 2>&1; then
          emit_command_diagnostics 'OSCAR backup-check service recovery' "$recovery_log"
          status=1
        fi
      fi
      rm -rf -- "$backup_work"
      $had_errexit && set -e
      return "$status"
    }
    trap cleanup_backup_check EXIT
    expected_inventory=$backup_work/expected-retained-members.txt
    : >"$expected_inventory"
    expected_sets=0
    retained_records=("$@")
    for retained_record in "$@"; do
      IFS='.' read -r event_token lane_token camera_token \
        frame_1_sha frame_1_bytes frame_2_sha frame_2_bytes frame_3_sha frame_3_bytes \
        frame_4_sha frame_4_bytes frame_5_sha frame_5_bytes extra <<<"$retained_record"
      [[ -z ${extra:-} ]] && valid_media_token "$event_token" && valid_media_token "$lane_token" &&
        valid_media_token "$camera_token" || fail 'Retained-media backup expectation has an invalid identity.'
      frame_shas=("$frame_1_sha" "$frame_2_sha" "$frame_3_sha" "$frame_4_sha" "$frame_5_sha")
      frame_bytes=("$frame_1_bytes" "$frame_2_bytes" "$frame_3_bytes" "$frame_4_bytes" "$frame_5_bytes")
      for frame_index in 0 1 2 3 4; do
        [[ ${frame_shas[$frame_index]} =~ ^[0-9a-f]{64}$ &&
           ${frame_bytes[$frame_index]} =~ ^[1-9][0-9]*$ ]] ||
          fail 'Retained-media backup expectation has an invalid frame hash or size.'
      done
      expected_sets=$((expected_sets+1))
    done
    app_image=''
    while IFS= read -r candidate_image; do
      case $candidate_image in
        oscar:*) [[ -z $app_image ]] || fail 'Compose selects multiple OSCAR application images.'; app_image=$candidate_image ;;
      esac
    done < <(compose config --images)
    [[ -n $app_image ]] ||
      fail 'Could not resolve the OSCAR application image for quiesced backup inventory.'
    for service in gateway oscar postgres; do
      compose ps --status running --services | grep -Fxq "$service" ||
        fail "Backup certification requires the running $service service."
    done
    backup_services_quiesced=true
    compose stop gateway >/dev/null
    compose stop oscar >/dev/null
    for retained_record in "${retained_records[@]}"; do
      IFS='.' read -r event_token lane_token camera_token \
        frame_1_sha frame_1_bytes frame_2_sha frame_2_bytes frame_3_sha frame_3_bytes \
        frame_4_sha frame_4_bytes frame_5_sha frame_5_bytes extra <<<"$retained_record"
      frame_shas=("$frame_1_sha" "$frame_2_sha" "$frame_3_sha" "$frame_4_sha" "$frame_5_sha")
      frame_bytes=("$frame_1_bytes" "$frame_2_bytes" "$frame_3_bytes" "$frame_4_bytes" "$frame_5_bytes")
      base="files/videos/retained-media/v1/events/$event_token/lanes/$lane_token/cameras/$camera_token"
      append_quiesced_backup_member "$expected_inventory" M "$base/manifest.json" "$app_image"
      for frame_index in 0 1 2 3 4; do
        frame_name=$(printf 'frame-%02d.jpg' "$((frame_index+1))")
        append_quiesced_backup_member "$expected_inventory" J "$base/$frame_name" "$app_image" \
          "${frame_shas[$frame_index]}" "${frame_bytes[$frame_index]}"
      done
    done
    metadata_paths=$(docker run --rm --network none --read-only --cap-drop ALL \
      --security-opt no-new-privileges --workdir / --user 10001:10001 --entrypoint sh \
      --volume oscar_oscar_state:/state:ro "$app_image" -eu -c '
      root=/state/files/videos/retained-media/v1
      checkpoint=$root/.metadata-reclamation-checkpoint.json
      [ -f "$checkpoint" ] && [ ! -L "$checkpoint" ]
      printf "%s\\n" "$checkpoint"
      find "$root/retention-processed-index" -mindepth 1 -maxdepth 1 -type f -name "*.idx" -print
      if [ -d "$root/deletion-index" ] && [ ! -L "$root/deletion-index" ]; then
        find "$root/deletion-index" -mindepth 2 -maxdepth 2 -type f -name "*.idx" -print
      fi
    ' retained-backup-metadata) || fail 'Required retained-media checkpoint/index metadata is missing or unsafe.'
    processed_expected=0
    deletion_expected=0
    while IFS= read -r metadata_path; do
      [[ -n $metadata_path && $metadata_path == /state/files/videos/retained-media/v1/* ]] ||
        fail 'Retained-media metadata inventory escaped its expected root.'
      metadata_member=${metadata_path#/state/}
      case $metadata_member in
        files/videos/retained-media/v1/.metadata-reclamation-checkpoint.json)
          append_quiesced_backup_member "$expected_inventory" C "$metadata_member" "$app_image"
          ;;
        files/videos/retained-media/v1/retention-processed-index/*.idx)
          [[ ${metadata_member##*/} =~ ^[0-9]{19}-(0[0-9]|1[01])[.]idx$ ]] ||
            fail 'Retained-media processed index has a noncanonical name.'
          append_quiesced_backup_member "$expected_inventory" P "$metadata_member" "$app_image"
          processed_expected=$((processed_expected+1))
          ;;
        files/videos/retained-media/v1/deletion-index/[0-9a-f][0-9a-f]/[0-9a-f][0-9a-f][0-9a-f][0-9a-f].idx)
          append_quiesced_backup_member "$expected_inventory" D "$metadata_member" "$app_image"
          deletion_expected=$((deletion_expected+1))
          ;;
        *) fail 'Retained-media metadata inventory contains an unexpected path.' ;;
      esac
    done <<<"$metadata_paths"
    expected_member_count=$(wc -l <"$expected_inventory" | tr -d '[:space:]')
    [[ $expected_member_count == $((expected_sets * 6 + 1 + processed_expected + deletion_expected)) ]] ||
      fail 'Retained backup expectation inventory has an inconsistent exact member count.'
    output=$(sudo bash oscar.sh backup)
    backup=$(printf '%s' "$output" | sed -n 's#^Backup created: .*/##p' | tail -n1)
    [[ $backup =~ ^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}$ ]] || fail 'Backup command did not return a backup ID.'
    journal_confirmed_count=$(printf '%s\n' "$output" | sed -n \
      "s#^Confirmed \([0-9][0-9]*\) daily-file lane/day publication(s) from verified backup $backup\$#\1#p")
    [[ $journal_confirmed_count =~ ^[0-9]+$ && $journal_confirmed_count -le 100000 ]] ||
      fail 'Backup command did not report one bounded daily-journal confirmation outcome.'
    backup_dir=$(absolute_path "$(env_value OSCAR_BACKUP_DIR ./backups)")
    retention=$(env_value OSCAR_BACKUP_RETENTION_COUNT 14)
    verified=$(find "$backup_dir" -mindepth 2 -maxdepth 2 -type f -name VERIFIED | wc -l)
    root=$backup_dir/$backup
    for required in VERIFIED JOURNAL_CONFIRMED SHA256SUMS SHA256SUMS.hmac epoch.json image-inventory.txt; do
      [[ -f $root/$required && ! -L $root/$required && -s $root/$required ]] ||
        fail "Backup marker is missing, empty, linked, or non-regular: $required"
    done
    [[ -f $root/archive-generation-ids.txt && ! -L $root/archive-generation-ids.txt ]] ||
      fail 'Archive-generation inventory is missing, linked, or non-regular.'
    backup_key_file=$(absolute_path "$(env_value OSCAR_BACKUP_KEY_FILE ./secrets/backup-key.txt)")
    [[ -n $app_image && -f $backup_key_file && ! -L $backup_key_file ]] ||
      fail 'Cannot independently authenticate the backup core.'
    [[ $(verify_backup_core_authentication "$root" "$backup_key_file" "$app_image") == verified ]] ||
      fail 'Independent backup HMAC/checksum/inventory verification failed.'
    hmac=$(tr -d '\r\n' <"$root/SHA256SUMS.hmac")
    [[ $hmac =~ ^[A-Za-z0-9+/]{43}=$ ]] || fail 'Backup HMAC marker is malformed.'
    verified_at=$(tr -d '\r\n' <"$root/VERIFIED")
    [[ $verified_at =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] ||
      fail 'Backup VERIFIED marker is malformed.'
    epoch_id=$(awk -F'"' '/"backupEpochId"/ {print $4; exit}' "$root/epoch.json")
    epoch_backup=$(awk -F'"' '/"backupId"/ {print $4; exit}' "$root/epoch.json")
    epoch_format=$(awk -F'"' '/"format"/ {print $4; exit}' "$root/epoch.json")
    epoch_version=$(awk -F'[: ,]+' '/"version"/ {print $3; exit}' "$root/epoch.json")
    epoch_release=$(awk -F'"' '/"oscarVersion"/ {print $4; exit}' "$root/epoch.json")
    epoch_state=$(awk -F'"' '/"state"/ {print $4; exit}' "$root/epoch.json")
    epoch_created=$(awk -F'"' '/"createdAt"/ {print $4; exit}' "$root/epoch.json")
    valid_uuid "$epoch_id" || fail 'Backup epoch UUID is invalid.'
    [[ $epoch_backup == "$backup" && $epoch_format == oscar-backup-epoch && $epoch_version == 1 &&
          $epoch_release == 3.9.2 && $epoch_state == CREATED &&
          $epoch_created =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] ||
      fail 'Backup epoch identity, format, state, or release is invalid.'
    oscar_state_sha=$(awk '$2=="./oscar-state.tar.gz" {print $1}' "$root/SHA256SUMS")
    [[ $oscar_state_sha =~ ^[0-9a-f]{64}$ ]] || fail 'Authenticated manifest has no unique OSCAR state checksum.'
    [[ $(awk '$2=="./oscar-state.tar.gz" {count++} END {print count+0}' "$root/SHA256SUMS") == 1 ]] ||
      fail 'Authenticated manifest must contain exactly one OSCAR state entry.'
    [[ $(awk '$2=="./archive-generation-ids.txt" {count++} END {print count+0}' "$root/SHA256SUMS") == 1 ]] ||
      fail 'Authenticated manifest must contain exactly one archive-generation inventory.'
    generation_bytes=$(stat -c %s -- "$root/archive-generation-ids.txt")
    [[ $generation_bytes =~ ^[0-9]+$ && $generation_bytes -le 37000000 ]] ||
      fail 'Archive-generation inventory exceeds its 37,000,000-byte safety bound.'
    if [[ $generation_bytes -gt 0 ]]; then
      [[ $(tail -c 1 "$root/archive-generation-ids.txt" | od -An -t x1 | tr -d '[:space:]') == 0a ]] ||
        fail 'Archive-generation inventory is not canonically newline terminated.'
    fi
    generation_count=0
    generation_previous=''
    while IFS= read -r generation_id || [[ -n $generation_id ]]; do
      generation_count=$((generation_count+1))
      [[ $generation_count -le 1000000 &&
         $generation_id =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]] ||
        fail 'Archive-generation inventory contains a noncanonical UUID.'
      [[ -z $generation_previous || $generation_id > $generation_previous ]] ||
        fail 'Archive-generation inventory is unsorted or contains duplicates.'
      generation_previous=$generation_id
    done <"$root/archive-generation-ids.txt"
    [[ $generation_bytes == $((generation_count * 37)) ]] ||
      fail 'Archive-generation inventory has noncanonical fixed-width LF framing.'
    generation_sha=$(sha256_file "$root/archive-generation-ids.txt")
    [[ $generation_sha =~ ^[0-9a-f]{64}$ ]] ||
      fail 'Archive-generation inventory SHA-256 is invalid.'
    [[ $(awk '$2=="./JOURNAL_CONFIRMED" {count++} END {print count+0}' "$root/SHA256SUMS") == 0 ]] ||
      fail 'Post-verification journal confirmation must remain outside the authenticated core inventory.'
    [[ $(wc -l <"$root/JOURNAL_CONFIRMED" | tr -d '[:space:]') == 5 &&
          $(grep -Fxc 'format=oscar-journal-backup-confirmation' "$root/JOURNAL_CONFIRMED") == 1 &&
          $(grep -Fxc 'version=2' "$root/JOURNAL_CONFIRMED") == 1 &&
          $(grep -Fxc "backup_id=$backup" "$root/JOURNAL_CONFIRMED") == 1 &&
          $(grep -Fxc "oscar_state_sha256=$oscar_state_sha" "$root/JOURNAL_CONFIRMED") == 1 &&
          $(grep -Ec '^hmac_sha256=[A-Za-z0-9+/]{43}=$' "$root/JOURNAL_CONFIRMED") == 1 ]] ||
      fail 'Journal-confirmation audit sidecar does not match the accepted recovery point.'
    [[ -n $app_image && -f $backup_key_file && ! -L $backup_key_file ]] ||
      fail 'Cannot authenticate the journal-confirmation audit sidecar.'
    sidecar_expected=$(sed -n 's/^hmac_sha256=//p' "$root/JOURNAL_CONFIRMED")
    sidecar_actual=$(sudo docker run --rm --network none --read-only --cap-drop ALL \
      --security-opt no-new-privileges --user 0 --entrypoint sh \
      --volume "$root/JOURNAL_CONFIRMED:/journal-confirmation:ro" \
      --volume "$backup_key_file:/backup-key.txt:ro" "$app_image" -eu -c '
        key=$(cat /backup-key.txt)
        head -n 4 /journal-confirmation |
          openssl dgst -sha256 -hmac "$key" -binary | openssl base64 -A
      ' | tr -d '\r\n')
    [[ $sidecar_actual == "$sidecar_expected" ]] ||
      fail 'Journal-confirmation audit sidecar HMAC is invalid.'
    backup_verify_log=$backup_work/backup-verify.log
    if ! sudo bash oscar.sh backup-verify "$backup" >"$backup_verify_log" 2>&1; then
      emit_command_diagnostics 'OSCAR backup verification' "$backup_verify_log"
      fail 'Supported backup verification rejected the newly created backup.'
    fi
    catalog_inventory=$backup_work/catalog-generation-ids.txt
    psql_admin --quiet --tuples-only --no-align --command "
      SELECT id::text FROM oscar_archive_generation
      WHERE state IN ('ACTIVE','SEALED') AND activated_at <= '$epoch_created'::timestamptz
      ORDER BY id;" >"$catalog_inventory"
    cmp -s "$root/archive-generation-ids.txt" "$catalog_inventory" ||
      fail 'Authenticated archive-generation inventory differs from the captured catalog epoch.'
    epoch=$(scalar "SELECT count(*) FROM oscar_backup_epoch WHERE id='$epoch_id' AND state='VERIFIED' AND manifest_path='$backup/epoch.json';")
    catalog_generation_receipt=$(scalar "SELECT archive_generation_count||'|'||archive_generation_inventory_sha256||'|'||archive_generation_inventory_bytes FROM oscar_backup_epoch WHERE id='$epoch_id' AND state='VERIFIED' AND manifest_path='$backup/epoch.json';")
    [[ $epoch == 1 && $catalog_generation_receipt == "$generation_count|$generation_sha|$generation_bytes" ]] ||
      fail 'VERIFIED catalog epoch does not exactly match the authenticated backup-time archive-generation receipt.'
    backup_reference="oscar-backup:$backup/oscar-state.tar.gz#sha256=$oscar_state_sha"
    state_listing=$backup_work/state-listing.txt
    tar -tzf "$root/oscar-state.tar.gz" >"$state_listing"
    member_count=$(wc -l <"$state_listing" | tr -d '[:space:]')
    [[ $member_count =~ ^[0-9]+$ && $member_count -le 200000 ]] ||
      fail 'OSCAR state backup member inventory exceeds its 200,000-entry safety bound.'
    if grep -Eq '(^/|(^|/)[.][.](/|$))' "$state_listing"; then
      fail 'OSCAR state backup contains an absolute or traversal member.'
    fi
    receipt_count=0; invalid_receipts=0; receipt_segments_verified=0
    receipt_root=files/.dailyfile-journal/backup-confirmations
    confirmation_set_member="$receipt_root/.sets/$backup.json"
    if ((journal_confirmed_count > 0)); then
      confirmation_set_file=$backup_work/confirmation-set.json
      copy_quiesced_confirmation_member "$confirmation_set_member" "$confirmation_set_file" \
        "$app_image" 786432
    set_bytes=$(file_size "$confirmation_set_file")
    [[ $set_bytes =~ ^[1-9][0-9]*$ && $set_bytes -le 786432 ]] ||
      fail 'Daily-journal confirmation-set marker exceeds its 768 KiB decoded safety bound.'
    set_encoded=$(openssl base64 -A -in "$confirmation_set_file" | tr -d '\r\n')
    [[ $set_encoded =~ ^[A-Za-z0-9+/]+=*$ && ${#set_encoded} -le 1048576 ]] ||
      fail 'Daily-journal confirmation-set marker has invalid bounded base64.'
    set_valid=$(scalar "WITH source AS (
        SELECT convert_from(decode('$set_encoded','base64'),'UTF8') AS text),
      doc AS (SELECT text::json AS raw, text::jsonb AS value FROM source),
      receipts AS (SELECT raw_receipt, raw_receipt::jsonb AS receipt FROM doc,
        LATERAL json_array_elements(CASE WHEN json_typeof(raw->'receipts')='array'
          THEN raw->'receipts' ELSE '[]'::json END) raw_receipt)
      SELECT jsonb_typeof(value)='object'
        AND (SELECT count(*) FROM json_object_keys(raw))=6
        AND value ?& ARRAY['schemaVersion','format','confirmationSet','receiptCount','committedAt','receipts']
        AND value->'schemaVersion'='1'::jsonb
        AND value->>'format'='oscar-dailyfile-backup-confirmation-set'
        AND value->>'confirmationSet'='$backup'
        AND jsonb_typeof(value->'receiptCount')='number'
        AND (value->>'receiptCount')::bigint=(SELECT count(*) FROM receipts)
        AND (SELECT count(*) FROM receipts)=(SELECT count(DISTINCT receipt->>'path') FROM receipts)
        AND (value->>'receiptCount')::bigint>0
        AND jsonb_typeof(value->'committedAt')='string'
        AND value->>'committedAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,9})?Z$'
        AND NOT EXISTS (SELECT 1 FROM receipts WHERE
          jsonb_typeof(receipt)<>'object'
          OR (SELECT count(*) FROM json_object_keys(raw_receipt))<>2
          OR NOT (receipt ?& ARRAY['path','sha256'])
          OR receipt->>'path' !~ '^[A-Za-z0-9._-]+/[0-9]{4}-[0-9]{2}-[0-9]{2}[.]json$'
          OR receipt->>'sha256' !~ '^[0-9a-f]{64}$')
      FROM doc;")
    [[ $set_valid == t ]] || fail 'Atomic daily-journal confirmation-set marker is invalid.'
    receipt_set_rows=$backup_work/receipt-set-rows.txt
    psql_admin --quiet --tuples-only --no-align --field-separator='|' --command "WITH doc AS (
        SELECT convert_from(decode('$set_encoded','base64'),'UTF8')::jsonb AS value)
      SELECT receipt->>'path',receipt->>'sha256' FROM doc,
        LATERAL jsonb_array_elements(value->'receipts') receipt ORDER BY receipt->>'path';" >"$receipt_set_rows"
    while IFS='|' read -r receipt_relative receipt_expected_sha receipt_extra; do
      [[ -z ${receipt_extra:-} &&
         $receipt_relative =~ ^[A-Za-z0-9._-]+/[0-9]{4}-[0-9]{2}-[0-9]{2}[.]json$ &&
         $receipt_expected_sha =~ ^[0-9a-f]{64}$ ]] ||
        fail 'Authenticated daily-journal receipt identity is outside the exact receipt layout.'
      receipt_day=${receipt_relative##*/}; receipt_day=${receipt_day%.json}
      receipt_member="$receipt_root/$receipt_relative"
      receipt_file=$backup_work/receipt-$receipt_count.json
      copy_quiesced_confirmation_member "$receipt_member" "$receipt_file" "$app_image" 786432
      receipt_bytes=$(file_size "$receipt_file")
      [[ $receipt_bytes =~ ^[1-9][0-9]*$ && $receipt_bytes -le 786432 &&
         $(sha256_file "$receipt_file") == "$receipt_expected_sha" ]] || {
        invalid_receipts=$((invalid_receipts+1)); continue; }
      encoded=$(openssl base64 -A -in "$receipt_file" | tr -d '\r\n')
      [[ $encoded =~ ^[A-Za-z0-9+/]+=*$ && ${#encoded} -le 1048576 ]] ||
        fail 'Authenticated daily-journal receipt could not be represented as bounded base64.'
      receipt_reference=$(scalar "WITH doc AS (
        SELECT convert_from(decode('$encoded','base64'),'UTF8')::jsonb AS value)
        SELECT coalesce(value->>'backupReference','') FROM doc;")
      [[ $receipt_reference == "$backup_reference" ]] || continue
      receipt_count=$((receipt_count+1))
      receipt_valid=$(scalar "WITH source AS (
          SELECT convert_from(decode('$encoded','base64'),'UTF8') AS text),
        doc AS (SELECT text::json AS raw, text::jsonb AS value FROM source),
        segments AS (
          SELECT raw_segment, raw_segment::jsonb AS segment FROM doc, LATERAL json_array_elements(
            CASE WHEN json_typeof(raw->'sealedSegments')='array'
              THEN raw->'sealedSegments' ELSE '[]'::json END) AS raw_segment)
        SELECT jsonb_typeof(value)='object'
          AND (SELECT count(*) FROM json_object_keys(raw))=10
          AND value ?& ARRAY['schemaVersion','laneId','day','windowStartInclusive',
            'windowEndExclusive','sha256','backupReference','confirmationSet','sealedSegments','confirmedAt']
          AND value->'schemaVersion'='1'::jsonb
          AND jsonb_typeof(value->'laneId')='string' AND length(value->>'laneId') BETWEEN 1 AND 256
          AND jsonb_typeof(value->'day')='string'
          AND value->>'day'='$receipt_day'
          AND jsonb_typeof(value->'windowStartInclusive')='string'
          AND jsonb_typeof(value->'windowEndExclusive')='string'
          AND value->>'windowStartInclusive' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,9})?Z$'
          AND value->>'windowEndExclusive' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,9})?Z$'
          AND (value->>'windowStartInclusive')::timestamptz < (value->>'windowEndExclusive')::timestamptz
          AND jsonb_typeof(value->'sha256')='string' AND value->>'sha256' ~ '^[0-9a-f]{64}$'
          AND jsonb_typeof(value->'backupReference')='string'
          AND value->>'backupReference'='$backup_reference'
          AND jsonb_typeof(value->'confirmationSet')='string'
          AND value->>'confirmationSet'='$backup'
          AND jsonb_typeof(value->'sealedSegments')='array'
          AND jsonb_array_length(value->'sealedSegments') > 0
          AND NOT EXISTS (SELECT 1 FROM segments WHERE
            jsonb_typeof(segment)<>'object'
            OR (SELECT count(*) FROM json_object_keys(raw_segment))<>3
            OR NOT (segment ?& ARRAY['name','byteCount','sha256'])
            OR jsonb_typeof(segment->'name')<>'string'
            OR segment->>'name' !~ '^[A-Za-z0-9._-]+[.]seg$'
            OR jsonb_typeof(segment->'byteCount')<>'number'
            OR segment->>'byteCount' !~ '^[1-9][0-9]*$'
            OR jsonb_typeof(segment->'sha256')<>'string'
            OR segment->>'sha256' !~ '^[0-9a-f]{64}$')
          AND jsonb_typeof(value->'confirmedAt')='string'
          AND value->>'confirmedAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,9})?Z$'
        FROM doc;")
      relative=$receipt_relative
      receipt_sha=$(sha256_file "$receipt_file")
      membership=$(scalar "WITH doc AS (
          SELECT convert_from(decode('$set_encoded','base64'),'UTF8')::jsonb AS value)
        SELECT count(*)=1 FROM doc, LATERAL jsonb_array_elements(value->'receipts') receipt
        WHERE receipt->>'path'='$relative' AND receipt->>'sha256'='$receipt_sha';")
      [[ $receipt_valid == t && $membership == t ]] || invalid_receipts=$((invalid_receipts+1))
      receipt_rows=$backup_work/receipt-segments-$receipt_count.txt
      psql_admin --quiet --tuples-only --no-align --field-separator='|' --command "WITH doc AS (
          SELECT convert_from(decode('$encoded','base64'),'UTF8')::jsonb AS value)
        SELECT value->>'laneId',segment->>'name',segment->>'byteCount',segment->>'sha256'
        FROM doc,LATERAL jsonb_array_elements(value->'sealedSegments') segment
        ORDER BY segment->>'name';" >"$receipt_rows.with-lane"
      receipt_lane=''; : >"$receipt_rows"
      while IFS='|' read -r lane_id segment_name segment_bytes segment_sha segment_extra; do
        [[ -z ${segment_extra:-} && $lane_id =~ ^urn:osh:system:lane:[A-Za-z0-9._-]{1,200}$ ]] || {
          invalid_receipts=$((invalid_receipts+1)); continue; }
        [[ -z $receipt_lane || $receipt_lane == "$lane_id" ]] || invalid_receipts=$((invalid_receipts+1))
        receipt_lane=$lane_id
        printf '%s|%s|%s\n' "$segment_name" "$segment_bytes" "$segment_sha" >>"$receipt_rows"
      done <"$receipt_rows.with-lane"
      safe_lane=$(printf '%s' "$receipt_lane" | sed 's/[^A-Za-z0-9._-]/_/g')
      if ((${#safe_lane} > 120)); then safe_lane=${safe_lane:0:120}; fi
      receipt_directory="$safe_lane-$(printf '%s' "$receipt_lane" | sha256sum | cut -c1-12)"
      verified_segments=$(verify_daily_receipt_backup_members "$root/oscar-state.tar.gz" \
        "$state_listing" "$receipt_directory" "$receipt_day" "$receipt_rows" "$backup_work" || true)
      if [[ $verified_segments =~ ^[1-9][0-9]*$ ]]; then
        receipt_segments_verified=$((receipt_segments_verified+verified_segments))
      else invalid_receipts=$((invalid_receipts+1)); fi
    done <"$receipt_set_rows"
    set_count=$(scalar "WITH doc AS (
        SELECT convert_from(decode('$set_encoded','base64'),'UTF8')::jsonb AS value)
      SELECT (value->>'receiptCount')::bigint FROM doc;")
      [[ $set_count == "$receipt_count" ]] || invalid_receipts=$((invalid_receipts+1))
      [[ $receipt_count =~ ^[1-9][0-9]*$ && $receipt_count == "$journal_confirmed_count" &&
         $invalid_receipts == 0 ]] ||
        fail 'New backup did not produce its exact valid daily-journal confirmation set.'
    else
      docker run --rm --network none --read-only --cap-drop ALL \
        --security-opt no-new-privileges --workdir / --user 10001:10001 --entrypoint sh \
        --volume oscar_oscar_state:/state:ro "$app_image" -eu -c '
          path=/state/$1
          [ ! -e "$path" ] && [ ! -L "$path" ]
        ' empty-journal-confirmation "$confirmation_set_member" ||
        fail 'Zero-candidate daily-journal confirmation unexpectedly published a set marker.'
    fi
    duck_scratch_excluded=true
    grep -Eq '^([.]/)?duckdb-tmp(/|$)' "$state_listing" && duck_scratch_excluded=false
    retained_prefix=false
    grep -Eq '^([.]/)?files/videos/retained-media/v1(/|$)' "$state_listing" && retained_prefix=true
    checkpoint_included=false
    grep -Eq '^([.]/)?files/videos/retained-media/v1/[.]metadata-reclamation-checkpoint[.]json$' "$state_listing" && checkpoint_included=true
    processed_indexes=$(grep -Ec '^([.]/)?files/videos/retained-media/v1/retention-processed-index/[0-9]{19}-(0[0-9]|1[01])[.]idx$' "$state_listing" || true)
    deletion_indexes=$(grep -Ec '^([.]/)?files/videos/retained-media/v1/deletion-index/[0-9a-f]{2}/[0-9a-f]{4}[.]idx$' "$state_listing" || true)
    retained_manifests=$(grep -Ec '^([.]/)?files/videos/retained-media/v1/events/.+/manifest[.]json$' "$state_listing" || true)
    retained_jpegs=$(grep -Ec '^([.]/)?files/videos/retained-media/v1/events/.+/frame-0[1-5][.]jpg$' "$state_listing" || true)
    exact_retained_members=$(verify_retained_backup_members \
      "$root/oscar-state.tar.gz" "$expected_inventory" "$backup_work")
    [[ $exact_retained_members == "$expected_member_count" &&
       $processed_indexes == "$processed_expected" && $deletion_indexes == "$deletion_expected" ]] ||
      fail 'Backup did not preserve the complete exact retained-media expectation inventory.'
    cleanup_backup_check
    trap - EXIT
    printf '{"backupId":"%s","automaticVerification":true,"supportedVerification":true,"independentCoreAuthentication":true,"authenticatedManifest":true,"journalConfirmationAuthenticated":true,"journalConfirmedPublications":%s,"regularMarkers":true,"epochValid":true,"verifiedEpoch":%s,"archiveGenerationInventoryExact":true,"archiveGenerationCount":%s,"journalReceipts":%s,"journalReceiptReferencesValid":true,"journalReceiptSegmentsVerified":%s,"verifiedBackups":%s,"retentionLimit":%s,"retentionRespected":%s,"duckDbScratchExcluded":%s,"retainedMediaPrefixPresent":%s,"mediaMetadataCheckpointIncluded":%s,"processedObservationIndexesIncluded":%s,"deletionIndexesIncluded":%s,"retainedMediaManifestsIncluded":%s,"retainedMediaJpegsIncluded":%s,"retainedMediaExpectedSets":%s,"retainedMediaExpectedMembers":%s,"retainedMediaExactMembersVerified":%s,"expectedProcessedIndexes":%s,"expectedDeletionIndexes":%s,"backupMemberCount":%s,"restoreAttempted":false}\n' \
      "$backup" "$journal_confirmed_count" "$([[ $epoch == 1 ]] && echo true || echo false)" "$generation_count" "$receipt_count" "$receipt_segments_verified" "$verified" "$retention" "$([[ $verified -le $retention ]] && echo true || echo false)" \
      "$duck_scratch_excluded" "$retained_prefix" "$checkpoint_included" "$processed_indexes" \
      "$deletion_indexes" "$retained_manifests" "$retained_jpegs" "$expected_sets" \
      "$expected_member_count" "$exact_retained_members" "$processed_expected" "$deletion_expected" "$member_count"
    ;;

  restore-drill)
    run=${1:-}; confirmation=${2:-}; expected_archive=${3:-}; expected_wal=${4:-}; expected_backup=${5:-}
    valid_run "$run" || fail 'Invalid restore-drill run ID.'
    [[ $confirmation == "$run:DESTRUCTIVE-RESTORE" ]] ||
      fail 'Restore drill is destructive and requires the exact per-run confirmation token.'
    [[ $(env_value OSCAR_VERSION missing) == 3.9.2 ]] || fail 'Restore drill requires OSCAR_VERSION=3.9.2.'
    for expected in "$expected_archive" "$expected_wal" "$expected_backup"; do
      [[ $expected == /* && $expected != / && $expected =~ ^/[A-Za-z0-9._/-]+$ ]] ||
        fail 'Restore drill requires three canonical acknowledged storage paths.'
    done
    archive_dir=$(canonical_directory "$(absolute_path "$(env_value OSCAR_ARCHIVE_DIR ./data/archive)")")
    wal_dir=$(canonical_directory "$(absolute_path "$(env_value OSCAR_WAL_ARCHIVE_DIR ./data/wal-archive)")")
    backup_dir=$(canonical_directory "$(absolute_path "$(env_value OSCAR_BACKUP_DIR ./backups)")")
    [[ $archive_dir == "$expected_archive" && $wal_dir == "$expected_wal" && $backup_dir == "$expected_backup" ]] ||
      fail 'Restore storage planes do not exactly match the acknowledged archive/WAL/backup paths.'
    if paths_overlap "$archive_dir" "$wal_dir" || paths_overlap "$archive_dir" "$backup_dir" ||
       paths_overlap "$wal_dir" "$backup_dir"; then
      fail 'Restore archive, WAL, and backup directories must be distinct, non-overlapping planes.'
    fi
    ensure_fixture_table
    marker="$run:before"
    mutated="$run:after"
    state_relative="files/.restore-regression/$run.canary"
    archive_canary_day=$(date -u +%F)
    archive_canary_profile="restore_$run"
    archive_canary_parent="$archive_dir/datasets/observations/date=$archive_canary_day"
    archive_canary="$archive_canary_parent/profile=$archive_canary_profile"
    secret_canary="$release_dir/secrets/oscar-admin-password.txt"
    tls_canary="$release_dir/tls/server.crt"
    env_canary="# OSCAR_RESTORE_DRILL_CANARY=$marker"
    env_mutated="# OSCAR_RESTORE_DRILL_CANARY=$mutated"
    umask 077
    secret_restore_stage="$release_dir/.oscar-regression-restore-stage-$run-admin-password"
    tls_restore_stage="$release_dir/.oscar-regression-restore-stage-$run-server-cert"
    failure_bundle="/var/tmp/oscar-regression-restore-failure-$run"
    if ! stale_restore_stage=$(find "$release_dir" -mindepth 1 -maxdepth 1 \
        -name '.oscar-regression-restore-stage-*' -print -quit); then
      fail 'Could not inspect the release root for stale restore staging entries.'
    fi
    [[ -z $stale_restore_stage ]] ||
      fail 'A stale root-level restore staging entry exists; recover it before another drill.'
    [[ ! -e $secret_restore_stage && ! -L $secret_restore_stage &&
       ! -e $tls_restore_stage && ! -L $tls_restore_stage ]] ||
      fail 'A root-level restore staging path already exists; investigate a prior interrupted run.'
    [[ ! -e $failure_bundle && ! -L $failure_bundle ]] ||
      fail 'A restore-drill failure bundle already exists for this run ID.'
    restore_work=$(mktemp -d "/tmp/oscar-regression-restore-$run.XXXXXXXX")
    wal_baseline=$restore_work/source-wal.sha256
    secret_original=$restore_work/oscar-admin-password.original
    tls_original=$restore_work/server.crt.original
    private_originals_ready=false
    credentials_mutated=false
    credential_files_replaced=false
    restore_drill_verified=false

    restore_private_original() {
      local source=$1 target=$2 temporary=$3 source_sha source_metadata
      [[ -f $source && ! -L $source && -d ${target%/*} && ! -L ${target%/*} &&
         ${temporary%/*} == "$release_dir" ]] || return 1
      [[ ! -e $temporary && ! -L $temporary ]] || return 1
      source_sha=$(sha256_file "$source")
      source_metadata=$(stat -c '%u:%g:%a' -- "$source")
      [[ $source_sha =~ ^[0-9a-f]{64}$ && $source_metadata =~ ^[0-9]+:[0-9]+:[0-7]{3,4}$ ]] ||
        return 1
      if [[ -f $target && ! -L $target ]] &&
         cmp -s -- "$source" "$target" &&
         [[ $(sha256_file "$target") == "$source_sha" &&
            $(stat -c '%u:%g:%a' -- "$target") == "$source_metadata" ]]; then
        return 0
      fi
      if ! install -o 0 -g 0 -m 0600 -- "$source" "$temporary" ||
         [[ ! -f $temporary || -L $temporary ]] ||
         ! cmp -s -- "$source" "$temporary" ||
         [[ $(sha256_file "$temporary") != "$source_sha" ]] ||
         [[ $(stat -c '%u:%g:%a' -- "$temporary") != 0:0:600 ]] ||
         ! mv -fT -- "$temporary" "$target" ||
         ! chown --reference="$source" -- "$target" ||
         ! chmod --reference="$source" -- "$target" ||
         [[ ! -f $target || -L $target ]] ||
         ! cmp -s -- "$source" "$target" ||
         [[ $(sha256_file "$target") != "$source_sha" ]] ||
         [[ $(stat -c '%u:%g:%a' -- "$target") != "$source_metadata" ]]; then
        rm -f -- "$temporary"
        return 1
      fi
      credential_files_replaced=true
      return 0
    }

    oscar_services_healthy() {
      local service container state health
      for service in gateway oscar postgres; do
        container=$(compose ps -q "$service" 2>/dev/null) || return 1
        [[ $container =~ ^[0-9a-f]{64}$ ]] || return 1
        state=$(docker inspect "$container" --format '{{.State.Status}}' 2>/dev/null) || return 1
        health=$(docker inspect "$container" \
          --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' 2>/dev/null) ||
          return 1
        [[ $state == running && $health == healthy ]] || return 1
      done
      return 0
    }

    preserve_restore_diagnostics() {
      local source destination name
      [[ ! -e $failure_bundle && ! -L $failure_bundle ]] || return 1
      mkdir -m 0700 -- "$failure_bundle" || return 1
      chown 0:0 -- "$failure_bundle" && chmod 0700 -- "$failure_bundle" || return 1
      for source in "$wal_baseline" "$restore_work/backup-verify.log" \
                    "$restore_work/pre-restore-expected.tsv" "$restore_work/restore.log" \
                    "$restore_work/archive-verify.log" "$restore_work/pre-restore-actual.tsv" \
                    "$restore_work/credential-recovery-force-recreate.log" \
                    "$restore_work/credential-recovery-restart.log"; do
        [[ -f $source && ! -L $source ]] || continue
        name=${source##*/}
        destination=$failure_bundle/$name
        case $name in
          *.log) tail -c 1048576 -- "$source" >"$destination" || return 1 ;;
          *) head -c 4194304 -- "$source" >"$destination" || return 1 ;;
        esac
        chown 0:0 -- "$destination" && chmod 0600 -- "$destination" || return 1
      done
      printf 'run=%s\nbackup=%s\nrelease=%s\n' \
        "$run" "${backup:-unavailable}" "$release_dir" >"$failure_bundle/summary.txt" || return 1
      chown 0:0 -- "$failure_bundle/summary.txt" &&
        chmod 0600 -- "$failure_bundle/summary.txt" || return 1
      [[ $(stat -c '%u:%g:%a' -- "$failure_bundle") == 0:0:700 ]] || return 1
      return 0
    }

    cleanup_restore_drill() {
      local original_status=$? had_errexit=false credential_recovery_failed=false
      local cleanup_failed=false diagnostics_failed=false fixture_remaining marker_status
      local credential_restart_log
      [[ $- == *e* ]] && had_errexit=true
      trap - EXIT
      set +e
      if $credentials_mutated; then
        if ! $private_originals_ready; then
          credential_recovery_failed=true
        else
          restore_private_original "$secret_original" "$secret_canary" "$secret_restore_stage" ||
            credential_recovery_failed=true
          restore_private_original "$tls_original" "$tls_canary" "$tls_restore_stage" ||
            credential_recovery_failed=true
        fi
      fi
      rm -f -- "$secret_restore_stage" "$tls_restore_stage" 2>/dev/null
      if [[ -e $secret_restore_stage || -L $secret_restore_stage ||
            -e $tls_restore_stage || -L $tls_restore_stage ]]; then
        credential_recovery_failed=true
      fi
      if $credentials_mutated && ! $credential_recovery_failed; then
        if $credential_files_replaced; then
          credential_restart_log=$restore_work/credential-recovery-force-recreate.log
          if ! compose up --detach --force-recreate --no-deps --no-build --pull never \
              --wait --wait-timeout 240 oscar gateway >"$credential_restart_log" 2>&1; then
            emit_command_diagnostics 'OSCAR credential-recovery force recreation' \
              "$credential_restart_log"
            credential_recovery_failed=true
          fi
        elif ! oscar_services_healthy; then
          credential_restart_log=$restore_work/credential-recovery-restart.log
          if ! sudo bash oscar.sh restart >"$credential_restart_log" 2>&1; then
            emit_command_diagnostics 'OSCAR credential-recovery restart' "$credential_restart_log"
            credential_recovery_failed=true
          fi
        fi
        if ! $credential_recovery_failed; then
          for _ in {1..30}; do
            oscar_services_healthy && break
            sleep 2
          done
        fi
        oscar_services_healthy || credential_recovery_failed=true
      fi
      if compose ps --status running --services 2>/dev/null | grep -Fxq postgres; then
        if ! psql_admin --command "DELETE FROM oscar_regression_fixture WHERE run_id='$run';" \
            >/dev/null 2>&1 ||
           ! fixture_remaining=$(scalar \
             "SELECT count(*) FROM oscar_regression_fixture WHERE run_id='$run';" 2>/dev/null) ||
           [[ $fixture_remaining != 0 ]]; then
          cleanup_failed=true
        fi
      else
        cleanup_failed=true
      fi
      if compose ps --status running --services 2>/dev/null | grep -Fxq oscar; then
        if ! compose exec -T oscar sh -eu -c \
             'rm -f -- "/var/lib/oscar/$1"; test ! -e "/var/lib/oscar/$1" && test ! -L "/var/lib/oscar/$1"; rmdir /var/lib/oscar/files/.restore-regression 2>/dev/null || true' \
             cleanup "$state_relative" >/dev/null 2>&1; then
          cleanup_failed=true
        fi
      else
        cleanup_failed=true
      fi
      rmdir -- "$archive_canary" 2>/dev/null || true
      [[ ! -e $archive_canary && ! -L $archive_canary ]] || cleanup_failed=true
      rmdir -- "$archive_canary_parent" "$archive_dir/datasets/observations" \
        "$archive_dir/datasets" 2>/dev/null || true
      if ! sed -i "/^# OSCAR_RESTORE_DRILL_CANARY=$run:/d" .env 2>/dev/null; then
        cleanup_failed=true
      else
        marker_status=0
        grep -Eq "^# OSCAR_RESTORE_DRILL_CANARY=$run:" .env 2>/dev/null || marker_status=$?
        [[ $marker_status == 1 ]] || cleanup_failed=true
      fi
      if ! $credential_recovery_failed; then
        rm -f -- "$secret_original" "$tls_original" 2>/dev/null
        if [[ -e $secret_original || -L $secret_original ||
              -e $tls_original || -L $tls_original ]]; then
          credential_recovery_failed=true
        fi
      fi
      if $credential_recovery_failed; then
        chown -R 0:0 -- "$restore_work" 2>/dev/null || true
        chmod 0700 -- "$restore_work" 2>/dev/null || true
        printf 'Restore-drill credential recovery failed; private originals retained at %s\n' \
          "$restore_work" >&2
      elif ((original_status != 0)) || ! $restore_drill_verified || $cleanup_failed; then
        if preserve_restore_diagnostics; then
          rm -rf -- "$restore_work"
          if [[ -e $restore_work || -L $restore_work ]]; then
            diagnostics_failed=true
            printf 'Restore-drill workspace deletion failed after preserving diagnostics: %s\n' \
              "$restore_work" >&2
          else
            printf 'Restore-drill failure diagnostics retained at %s\n' "$failure_bundle" >&2
          fi
        else
          diagnostics_failed=true
          chown -R 0:0 -- "$restore_work" 2>/dev/null || true
          chmod 0700 -- "$restore_work" 2>/dev/null || true
          printf 'Restore-drill diagnostics preservation failed; bounded source workspace retained at %s\n' \
            "$restore_work" >&2
        fi
      else
        rm -rf -- "$restore_work"
        if [[ -e $restore_work || -L $restore_work ]]; then
          cleanup_failed=true
          printf 'Restore-drill workspace cleanup failed: %s\n' "$restore_work" >&2
        fi
      fi
      $had_errexit && set -e
      if ((original_status != 0)); then return "$original_status"; fi
      if $credential_recovery_failed || $cleanup_failed || $diagnostics_failed; then return 1; fi
      return 0
    }

    trap cleanup_restore_drill EXIT
    chmod 0700 -- "$restore_work"
    : >"$wal_baseline"
    [[ -f $secret_canary && ! -L $secret_canary && -s $secret_canary &&
       -f $tls_canary && ! -L $tls_canary && -s $tls_canary ]] ||
      fail 'Restore drill requires the existing approved admin-password and server-certificate files.'
    cp --preserve=mode,ownership,timestamps -- "$secret_canary" "$secret_original"
    cp --preserve=mode,ownership,timestamps -- "$tls_canary" "$tls_original"
    secret_original_sha=$(sha256_file "$secret_original")
    tls_original_sha=$(sha256_file "$tls_original")
    secret_original_metadata=$(stat -c '%u:%g:%a' -- "$secret_canary")
    tls_original_metadata=$(stat -c '%u:%g:%a' -- "$tls_canary")
    [[ $secret_original_sha =~ ^[0-9a-f]{64}$ && $tls_original_sha =~ ^[0-9a-f]{64}$ &&
       $secret_original_metadata =~ ^[0-9]+:[0-9]+:[0-7]{3,4}$ &&
       $tls_original_metadata =~ ^[0-9]+:[0-9]+:[0-7]{3,4}$ ]] ||
      fail 'Restore drill could not snapshot the approved credential canaries.'
    private_originals_ready=true
    compose exec -T oscar sh -eu -c 'test ! -e "/var/lib/oscar/$1" && test ! -L "/var/lib/oscar/$1"' \
      canary "$state_relative" || fail 'An application-state restore-drill canary already exists.'
    [[ ! -e $archive_canary && ! -L $archive_canary ]] ||
      fail 'A restore-drill canary already exists; investigate a prior interrupted run.'
    [[ $(scalar "SELECT count(*) FROM oscar_regression_fixture WHERE run_id='$run';") == 0 ]] ||
      fail 'Restore-drill run ID already exists in the fixture registry.'
    grep -Fq 'OSCAR_RESTORE_DRILL_CANARY=' .env &&
      fail 'The deployment .env contains an unresolved restore-drill canary.'
    # A registered database row plus canaries in each replaceable storage plane
    # prove that restore replaces, rather than merely restarts, PostgreSQL,
    # application state, archive, and deployment credentials. WAL is append-only;
    # real switched segments below prove both backup-era and post-backup preservation.
    canary_hex=$(printf '%s' "$run" | sha256sum | cut -c1-14)
    canary_id=$((16#$canary_hex))
    ((canary_id > 0)) || fail 'Could not derive a unique restore-drill database canary.'
    psql_admin --command "INSERT INTO oscar_regression_fixture(run_id,cold_id,hot_id,datastream_id,cold_time,hot_time)
      VALUES('$run',-$canary_id,-$((canary_id + 1)),1,now(),now());" >/dev/null
    psql_admin --command "ALTER TABLE oscar_regression_fixture ADD COLUMN IF NOT EXISTS restore_marker text;
      UPDATE oscar_regression_fixture SET restore_marker='$marker' WHERE run_id='$run';" >/dev/null
    compose exec -T oscar sh -eu -c 'mkdir -p /var/lib/oscar/files/.restore-regression; printf "%s\n" "$2" >"/var/lib/oscar/$1"' canary "$state_relative" "$marker"
    ensure_restore_archive_canary_hierarchy 10001 10001 \
      "$archive_dir/datasets" \
      "$archive_dir/datasets/observations" \
      "$archive_canary_parent" \
      "$archive_canary"
    printf '%s\n' "$env_canary" >>.env

    # Force and retain at least one source-timeline WAL object, then fingerprint every
    # source-timeline segment that the coordinated backup must capture. Restore must
    # preserve these immutable objects while archiving onto a newly promoted timeline.
    source_timeline=$(scalar "SELECT timeline_id FROM pg_control_checkpoint();")
    [[ $source_timeline =~ ^[1-9][0-9]{0,9}$ ]] || fail 'Could not determine the source PostgreSQL timeline.'
    source_prefix=$(printf '%08X' "$source_timeline")
    source_segment=$(scalar 'SELECT pg_walfile_name(pg_switch_wal());')
    [[ $source_segment =~ ^${source_prefix}[0-9A-F]{16}$ ]] ||
      fail 'PostgreSQL returned a WAL segment outside the source timeline.'
    source_archiver_failures=$(scalar 'SELECT failed_count FROM pg_stat_archiver;')
    for _ in {1..30}; do
      [[ -f $wal_dir/$source_segment && ! -L $wal_dir/$source_segment ]] && break
      [[ $(scalar 'SELECT failed_count FROM pg_stat_archiver;') == "$source_archiver_failures" ]] ||
        fail 'PostgreSQL WAL archival failed while establishing the restore baseline.'
      sleep 1
    done
    [[ -f $wal_dir/$source_segment && ! -L $wal_dir/$source_segment ]] ||
      fail 'Source-timeline WAL was not archived before the coordinated backup.'
    : >"$wal_baseline"
    while IFS= read -r -d '' source_wal; do
      source_name=${source_wal##*/}
      [[ $source_name =~ ^${source_prefix}[0-9A-F]{16}$ ]] || continue
      printf '%s  %s\n' "$(sha256_file "$source_wal")" "$source_name" >>"$wal_baseline"
    done < <(find "$wal_dir" -mindepth 1 -maxdepth 1 -type f -print0)
    sort -o "$wal_baseline" "$wal_baseline"
    [[ -s $wal_baseline ]] || fail 'No source-timeline WAL objects were available for restore preservation proof.'

    backup_output=$(sudo bash oscar.sh backup)
    backup=$(printf '%s' "$backup_output" | sed -n 's#^Backup created: .*/##p' | tail -n1)
    [[ $backup =~ ^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}$ ]] || fail 'Restore drill could not create a backup.'
    backup_root=$backup_dir/$backup
    backup_key_file=$(absolute_path "$(env_value OSCAR_BACKUP_KEY_FILE ./secrets/backup-key.txt)")
    app_image=''
    while IFS= read -r candidate_image; do
      case $candidate_image in
        oscar:*) [[ -z $app_image ]] || fail 'Compose selects multiple OSCAR application images.'; app_image=$candidate_image ;;
      esac
    done < <(compose config --images)
    [[ -n $app_image && -f $backup_key_file && ! -L $backup_key_file &&
       $(verify_backup_core_authentication "$backup_root" "$backup_key_file" "$app_image") == verified ]] ||
      fail 'Restore drill backup failed independent core authentication.'
    authenticated_backup_reverified=true
    restore_backup_verify_log=$restore_work/backup-verify.log
    if ! sudo bash oscar.sh backup-verify "$backup" >"$restore_backup_verify_log" 2>&1; then
      emit_command_diagnostics 'OSCAR restore-drill backup verification' "$restore_backup_verify_log"
      fail 'Restore drill refused a backup that failed supported verification.'
    fi

    psql_admin --command "UPDATE oscar_regression_fixture SET restore_marker='$mutated' WHERE run_id='$run';" >/dev/null
    future_segment=$(scalar 'SELECT pg_walfile_name(pg_switch_wal());')
    [[ $future_segment =~ ^${source_prefix}[0-9A-F]{16}$ ]] ||
      fail 'Post-backup mutation did not produce source-timeline WAL.'
    future_archiver_failures=$(scalar 'SELECT failed_count FROM pg_stat_archiver;')
    for _ in {1..30}; do
      [[ -f $wal_dir/$future_segment && ! -L $wal_dir/$future_segment ]] && break
      [[ $(scalar 'SELECT failed_count FROM pg_stat_archiver;') == "$future_archiver_failures" ]] ||
        fail 'PostgreSQL WAL archival failed while establishing the post-backup preservation canary.'
      sleep 1
    done
    [[ -f $wal_dir/$future_segment && ! -L $wal_dir/$future_segment ]] ||
      fail 'Post-backup source-timeline WAL was not archived before restore.'
    future_segment_sha=$(sha256_file "$wal_dir/$future_segment")
    compose exec -T oscar sh -eu -c 'printf "%s\n" "$2" >"/var/lib/oscar/$1"' canary "$state_relative" "$mutated"
    rmdir -- "$archive_canary" || fail 'Could not remove the empty post-backup archive directory canary.'
    [[ -f $secret_canary && ! -L $secret_canary && -f $tls_canary && ! -L $tls_canary ]] ||
      fail 'Approved credential canaries became unsafe before post-backup mutation.'
    credentials_mutated=true
    printf '%s\n' "$mutated" >"$secret_canary"
    printf '%s\n' "$mutated" >"$tls_canary"
    sed -i "s|^# OSCAR_RESTORE_DRILL_CANARY=$marker$|$env_mutated|" .env
    grep -Fqx "$env_mutated" .env || fail 'Could not mutate the restore-drill deployment canary.'
    expected_safety_inventory=$restore_work/pre-restore-expected.tsv
    credential_tree_inventory "$release_dir" "$expected_safety_inventory" ||
      fail 'Could not capture the exact mutated credential tree before restore.'

    restore_log=$restore_work/restore.log
    if ! sudo bash oscar.sh restore --backup "$backup" --confirm "$backup" >"$restore_log" 2>&1; then
      emit_command_diagnostics 'OSCAR destructive restore' "$restore_log"
      fail 'OSCAR restore command failed.'
    fi
    database_restored=false
    [[ $(scalar "SELECT count(*) FROM oscar_regression_fixture WHERE run_id='$run' AND restore_marker='$marker';") == 1 ]] && database_restored=true
    state_restored=false
    [[ $(compose exec -T oscar sh -c "cat -- '/var/lib/oscar/$state_relative'" 2>/dev/null || true) == "$marker" ]] && state_restored=true
    archive_restored=false; [[ -d $archive_canary && ! -L $archive_canary ]] && archive_restored=true
    credentials_restored=false
    if [[ -f $secret_canary && ! -L $secret_canary && -f $tls_canary && ! -L $tls_canary &&
          $(sha256_file "$secret_canary") == "$secret_original_sha" &&
          $(sha256_file "$tls_canary") == "$tls_original_sha" &&
          $(stat -c '%u:%g:%a' -- "$secret_canary") == "$secret_original_metadata" &&
          $(stat -c '%u:%g:%a' -- "$tls_canary") == "$tls_original_metadata" ]] &&
       cmp -s -- "$secret_original" "$secret_canary" &&
       cmp -s -- "$tls_original" "$tls_canary" &&
       [[ $(grep -Fxc "$env_canary" .env) == 1 ]]; then credentials_restored=true; fi
    services_healthy=true
    for service in gateway oscar postgres; do
      container=$(compose ps -q "$service")
      [[ -n $container && $(docker inspect "$container" --format '{{.State.Status}}') == running &&
            $(docker inspect "$container" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}') == healthy ]] ||
        services_healthy=false
    done
    archive_verified=false
    restore_archive_verify_log=$restore_work/archive-verify.log
    if sudo bash oscar.sh archive verify >"$restore_archive_verify_log" 2>&1; then
      archive_verified=true
    else
      emit_command_diagnostics 'Post-restore archive verification' "$restore_archive_verify_log"
    fi
    restored_timeline=$(scalar "SELECT timeline_id FROM pg_control_checkpoint();")
    fresh_timeline=false
    restored_prefix=''
    if [[ $restored_timeline =~ ^[1-9][0-9]{0,9}$ && $restored_timeline -gt $source_timeline ]]; then
      fresh_timeline=true
      restored_prefix=$(printf '%08X' "$restored_timeline")
    fi
    timeline_history_archived=false
    if [[ -n $restored_prefix && -f $wal_dir/$restored_prefix.history &&
          ! -L $wal_dir/$restored_prefix.history ]]; then
      timeline_history_archived=true
    fi
    new_timeline_wal_archived=false
    while IFS= read -r -d '' restored_wal; do
      restored_name=${restored_wal##*/}
      if [[ -n $restored_prefix && $restored_name =~ ^${restored_prefix}[0-9A-F]{16}$ ]]; then
        new_timeline_wal_archived=true
        break
      fi
    done < <(find "$wal_dir" -mindepth 1 -maxdepth 1 -type f -print0)
    prior_wal_preserved=true
    while read -r expected_sha prior_name; do
      [[ $expected_sha =~ ^[0-9a-f]{64}$ && $prior_name =~ ^${source_prefix}[0-9A-F]{16}$ &&
            -f $wal_dir/$prior_name && ! -L $wal_dir/$prior_name &&
            $(sha256_file "$wal_dir/$prior_name") == "$expected_sha" ]] || {
        prior_wal_preserved=false
        break
      }
    done <"$wal_baseline"
    post_backup_wal_preserved=false
    if [[ $future_segment_sha =~ ^[0-9a-f]{64}$ && -f $wal_dir/$future_segment &&
          ! -L $wal_dir/$future_segment &&
          $(sha256_file "$wal_dir/$future_segment") == "$future_segment_sha" ]]; then
      post_backup_wal_preserved=true
    fi
    wal_restored=false
    if $prior_wal_preserved && $post_backup_wal_preserved; then wal_restored=true; fi
    archiver_failure_free=false
    [[ $(scalar "SELECT coalesce((last_failed_time >= pg_postmaster_start_time())::text,'f') FROM pg_stat_archiver;") == f ]] &&
      archiver_failure_free=true
    recovery_settings_cleared=false
    recovery_defaults=$(scalar "SELECT CASE WHEN current_setting('restore_command')='' AND current_setting('recovery_target')='' AND current_setting('recovery_target_timeline')='latest' AND current_setting('recovery_target_action')='pause' THEN '1' ELSE '0' END;")
    recovery_pending=$(scalar "SELECT count(*) FROM pg_settings WHERE name IN ('restore_command','recovery_target','recovery_target_timeline','recovery_target_action') AND pending_restart;")
    if [[ $recovery_defaults == 1 && $recovery_pending == 0 ]] &&
       compose exec -T postgres sh -eu -c '
         test -f "$PGDATA/postgresql.auto.conf" && test ! -L "$PGDATA/postgresql.auto.conf"
         ! grep -Eq "^[[:space:]]*(restore_command|recovery_target(_[a-z_]+)?|primary_conninfo|primary_slot_name|promote_trigger_file)[[:space:]]*=" "$PGDATA/postgresql.auto.conf"
         test ! -e "$PGDATA/recovery.signal" && test ! -L "$PGDATA/recovery.signal"
         test ! -e "$PGDATA/standby.signal" && test ! -L "$PGDATA/standby.signal"
       '; then
      recovery_settings_cleared=true
    fi
    epoch_id=$(awk -F'"' '/"backupEpochId"/ {print $4; exit}' "$backup_dir/$backup/epoch.json")
    epoch_lsn=$(awk -F'"' '/"postgresLsn"/ {print $4; exit}' "$backup_dir/$backup/epoch.json")
    epoch_sha=$(sha256_file "$backup_dir/$backup/epoch.json")
    restored_generation_inventory=$backup_dir/$backup/archive-generation-ids.txt
    [[ -f $restored_generation_inventory && ! -L $restored_generation_inventory ]] ||
      fail 'Restored backup archive-generation inventory is missing or unsafe.'
    restored_generation_bytes=$(stat -c %s -- "$restored_generation_inventory")
    [[ $restored_generation_bytes =~ ^[0-9]+$ && $restored_generation_bytes -le 37000000 ]] ||
      fail 'Restored archive-generation inventory exceeds its byte bound.'
    if [[ $restored_generation_bytes -gt 0 ]]; then
      [[ $(tail -c 1 "$restored_generation_inventory" | od -An -t x1 | tr -d '[:space:]') == 0a ]] ||
        fail 'Restored archive-generation inventory is not LF terminated.'
    fi
    restored_generation_count=0
    restored_generation_previous=''
    while IFS= read -r restored_generation_id || [[ -n $restored_generation_id ]]; do
      restored_generation_count=$((restored_generation_count+1))
      [[ $restored_generation_count -le 1000000 &&
         $restored_generation_id =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]] ||
        fail 'Restored archive-generation inventory is noncanonical or exceeds its entry bound.'
      [[ -z $restored_generation_previous || $restored_generation_id > $restored_generation_previous ]] ||
        fail 'Restored archive-generation inventory is unsorted or contains duplicates.'
      restored_generation_previous=$restored_generation_id
    done <"$restored_generation_inventory"
    [[ $restored_generation_bytes == $((restored_generation_count * 37)) ]] ||
      fail 'Restored archive-generation inventory has noncanonical fixed-width LF framing.'
    restored_generation_sha=$(sha256_file "$restored_generation_inventory")
    [[ $restored_generation_sha =~ ^[0-9a-f]{64}$ ]] ||
      fail 'Restored archive-generation inventory SHA-256 is invalid.'
    valid_uuid "$epoch_id" && [[ $epoch_lsn =~ ^[0-9A-F]+/[0-9A-F]+$ && $epoch_sha =~ ^[0-9a-f]{64}$ ]] ||
      fail 'Restored backup has invalid authenticated epoch fields.'
    verified_epoch_restored=false
    [[ $(scalar "SELECT count(*) FROM oscar_backup_epoch WHERE id='$epoch_id' AND state='VERIFIED' AND postgres_lsn='$epoch_lsn' AND archive_generation_count=$restored_generation_count AND archive_generation_inventory_sha256='$restored_generation_sha' AND archive_generation_inventory_bytes=$restored_generation_bytes AND manifest_path='$backup/epoch.json' AND sha256='$epoch_sha' AND verified_at IS NOT NULL;") == 1 ]] &&
      verified_epoch_restored=true
    safety="$release_dir/pre-restore-$backup"
    [[ -d $safety && ! -L $safety && $(stat -c '%u:%g:%a' -- "$safety") == 0:0:700 &&
          -f $safety/.env && ! -L $safety/.env &&
          -d $safety/secrets && ! -L $safety/secrets &&
          -d $safety/tls && ! -L $safety/tls ]] ||
      fail 'Restore did not preserve a private, complete pre-restore credential safety directory.'
    actual_safety_inventory=$restore_work/pre-restore-actual.tsv
    pre_restore_safety_copy_verified=false
    if credential_tree_inventory "$safety" "$actual_safety_inventory" &&
       cmp -s "$expected_safety_inventory" "$actual_safety_inventory" &&
       [[ $(cat -- "$safety/secrets/oscar-admin-password.txt") == "$mutated" &&
          $(cat -- "$safety/tls/server.crt") == "$mutated" &&
          $(grep -Fxc "$env_mutated" "$safety/.env") == 1 ]]; then
      pre_restore_safety_copy_verified=true
    fi
    all_restored=false
    if $database_restored && $state_restored && $archive_restored && $wal_restored &&
       $credentials_restored && $services_healthy && $archive_verified && $fresh_timeline &&
       $timeline_history_archived && $new_timeline_wal_archived && $prior_wal_preserved &&
       $post_backup_wal_preserved &&
       $archiver_failure_free && $recovery_settings_cleared && $verified_epoch_restored &&
       $pre_restore_safety_copy_verified; then all_restored=true; fi
    restore_drill_verified=$all_restored
    printf '{"backupId":"%s","authenticatedBackupReverified":%s,"databaseRestored":%s,"applicationStateRestored":%s,"archiveRestored":%s,"walRestored":%s,"credentialsRestored":%s,"servicesHealthy":%s,"archiveVerified":%s,"freshTimeline":%s,"sourceTimeline":%s,"restoredTimeline":%s,"timelineHistoryArchived":%s,"newTimelineWalArchived":%s,"priorWalPreserved":%s,"postBackupWalPreserved":%s,"archiverFailureFree":%s,"recoverySettingsCleared":%s,"verifiedEpochRestored":%s,"allCanariesRestored":%s,"preRestoreSafetyCopyVerified":%s,"preRestoreSafetyDirectory":"%s"}\n' \
      "$backup" "$authenticated_backup_reverified" "$database_restored" "$state_restored" "$archive_restored" "$wal_restored" \
      "$credentials_restored" "$services_healthy" "$archive_verified" "$fresh_timeline" \
      "$source_timeline" "$restored_timeline" "$timeline_history_archived" "$new_timeline_wal_archived" \
      "$prior_wal_preserved" "$post_backup_wal_preserved" "$archiver_failure_free" "$recovery_settings_cleared" \
      "$verified_epoch_restored" "$all_restored" "$pre_restore_safety_copy_verified" "$safety"
    cleanup_restore_drill
    trap - EXIT
    ;;

  fixture-cleanup)
    run=${1:-}; valid_run "$run" || fail 'Invalid run ID.'; ensure_fixture_table
    while IFS= read -r fixture_hold; do
      [[ -n $fixture_hold ]] || continue
      valid_uuid "$fixture_hold" || fail 'Fixture cleanup found a malformed regression hold ID.'
      sudo bash oscar.sh archive hold release --id "$fixture_hold" --released-by oscar-regression-cleanup >/dev/null
    done < <(psql_admin --quiet --tuples-only --no-align --command "
      SELECT h.id::text FROM oscar_retention_hold h
      JOIN oscar_regression_fixture f ON f.run_id='$run'
      LEFT JOIN oscar_archive_generation g ON g.id=f.generation_id
      WHERE h.released_at IS NULL AND h.created_by='oscar-regression'
        AND h.store_key=g.store_key AND h.id_scope=g.id_scope
        AND ((h.subject_type='ARCHIVE_GENERATION' AND h.subject_id=f.generation_id::text
              AND h.reason='regression-$run')
          OR (h.subject_type='OBSERVATION' AND h.subject_id=f.cold_id::text
              AND h.reason='regression-observation-$run')
          OR (h.subject_type='OBSERVATION' AND h.subject_id=f.hot_id::text
              AND h.reason='regression-hot-$run'))
      ORDER BY h.id;")
    # Only registered hot/cold rows are touched. Catalog evidence from a purged
    # generation is deliberately retained for auditability.
    deleted=$(scalar "WITH f AS (DELETE FROM oscar_regression_fixture WHERE run_id='$run' RETURNING cold_id,hot_id),
      d AS (DELETE FROM obs o USING f WHERE o.id IN (f.cold_id,f.hot_id) RETURNING 1) SELECT count(*) FROM d;")
    printf '{"fixtureRowsDeleted":%s}\n' "$deleted"
    ;;

  *) fail "Unknown storage probe action: $action" ;;
esac
