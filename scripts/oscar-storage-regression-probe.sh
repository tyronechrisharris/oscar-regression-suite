#!/usr/bin/env bash
set -Eeuo pipefail

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
[[ $release_dir == /* && $release_dir != *'/../'* && -f $release_dir/oscar.sh ]] ||
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
scalar() { psql_admin --quiet --tuples-only --no-align --command "$1" | tr -d '[:space:]'; }
json_query() { psql_admin --quiet --tuples-only --no-align --command "$1" | tail -n 1; }
valid_run() { [[ $1 =~ ^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$ ]]; }
valid_uuid() { [[ $1 =~ ^[0-9a-fA-F-]{36}$ ]]; }
retention_hold_id_from_output() {
  local output=$1 expected_store=$2 expected_scope=$3 line hold_id='' store_key='' id_scope='' matches=0
  while IFS= read -r line; do
    if [[ $line =~ ^Retention\ hold\ created:\ ([0-9a-fA-F-]{36})\ \(store=([a-z_][a-z0-9_]{0,62}),\ id-scope=(-?[0-9]+)\)$ ]]; then
      hold_id=${BASH_REMATCH[1]}
      store_key=${BASH_REMATCH[2]}
      id_scope=${BASH_REMATCH[3]}
      matches=$((matches+1))
    fi
  done <<<"$output"
  [[ $matches -eq 1 && $store_key == "$expected_store" && $id_scope == "$expected_scope" ]] || return 1
  valid_uuid "$hold_id" || return 1
  printf '%s' "$hold_id"
}
valid_deployment_id() { [[ $1 =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]]; }
valid_store_key() { [[ $1 =~ ^[a-z_][a-z0-9_]{0,62}$ ]]; }
valid_id_scope() { [[ $1 =~ ^-?[0-9]+$ && $1 -ge -2147483648 && $1 -le 2147483647 ]]; }
env_value() {
  local name=$1 fallback=$2 value
  value=$(awk -F= -v name="$name" '$1 == name { print substr($0, index($0, "=") + 1); exit }' .env)
  printf '%s' "${value:-$fallback}"
}
config_text_matches() {
  local text=$1 pattern=$2
  grep -Eq -- "$pattern" <<<"$text"
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
safe_json_text() {
  [[ ${1:-} =~ ^[A-Za-z0-9._/:@+,-]*$ ]] || fail "Unsafe value in probe JSON: ${1:-}"
}
sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum -- "$1" | awk '{print $1}'
  else shasum --algorithm 256 -- "$1" | awk '{print $1}'
  fi
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
    grep -Eq '^[[:space:]]+delete_outcome=\$\(archive_object_helper delete "\$relative" "\$expected_sha" rw\)$' oscar-storage.sh &&
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
    config=$(compose exec -T oscar sh -c 'find /var/lib/oscar -maxdepth 2 -type f -name "*.json" -print0 2>/dev/null | xargs -0 grep -l "OscarTieredObsSystemDatabase\|DailyFileJournalService" 2>/dev/null | head -n1' || true)
    config_text=''
    [[ -n $config ]] && config_text=$(compose exec -T oscar sh -c "cat -- '$config'" 2>/dev/null || true)
    interval=$(printf '%s' "$config_text" | sed -n 's/.*"intervalMinutes"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' | head -n1)
    grace=$(printf '%s' "$config_text" | sed -n 's/.*"rollbackGraceDays"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' | head -n1)
    delete_hot=null; config_text_matches "$config_text" '"deleteHotAfterArchive"[[:space:]]*:[[:space:]]*true' && delete_hot=true || true
    config_text_matches "$config_text" '"deleteHotAfterArchive"[[:space:]]*:[[:space:]]*false' && delete_hot=false || true
    schema=$(scalar "SELECT coalesce(max(version),0) FROM oscar_storage_schema_version;")
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
    for value in "$marker_format" "$marker_version" "$marker_checksums" "$marker_initialized"; do safe_json_text "$value"; done
    batch=false
    # The 3.9.2 tiered database config sets reWriteBatchedInserts=true in code;
    # explicit serialized properties are also accepted for forward compatibility.
    config_text_matches "$config_text" 'OscarTieredObsSystemDatabase|reWriteBatchedInserts[^A-Za-z]*(true|"true")' && batch=true || true
    journal=false
    config_text_matches "$config_text" 'DailyFileJournalService' && journal=true || true
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
    printf '"dataChecksums":"%s","pgStatStatementsInstalled":%s,"pgStatStatementsPreloaded":%s,"schemaVersion":%s,' \
      "$checksums" "$([[ $installed == t ]] && echo true || echo false)" "$([[ $preloaded == t ]] && echo true || echo false)" "$schema"
    printf '"archiveMarker":{"present":%s,"exact":%s,"format":"%s","version":"%s","dataChecksums":"%s","initializedAt":"%s"},' \
      "$marker_present" "$marker_exact" "$marker_format" "$marker_version" "$marker_checksums" "$marker_initialized"
    printf '"batchRewriteConfigured":%s,"dailyJournalConfigured":%s,"archiveIntervalMinutes":%s,"deleteHotAfterArchive":%s,"rollbackGraceDays":%s}\n' \
      "$batch" "$journal" "${interval:-null}" "$delete_hot" "${grace:-null}"
    ;;

  snapshot)
    archive_dir=$(absolute_path "$(env_value OSCAR_ARCHIVE_DIR ./data/archive)")
    backup_dir=$(absolute_path "$(env_value OSCAR_BACKUP_DIR ./backups)")
    journal_bytes=$(compose exec -T oscar sh -c "du -sb /var/lib/oscar/files/.dailyfile-journal 2>/dev/null | awk '{print \$1+0}'" || echo 0)
    daily_bytes=$(compose exec -T oscar sh -c "du -sb /var/lib/oscar/files/dailyfiles 2>/dev/null | awk '{print \$1+0}'" || echo 0)
    media_bytes=$(compose exec -T oscar sh -c "du -sb /var/lib/oscar/files/videos/retained-media 2>/dev/null | awk '{print \$1+0}'" || echo 0)
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
          digest_line=$(sha256sum "$csv")
          actual_sha=${digest_line%% *}
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
    holder_log="/tmp/oscar-regression-activation-holder-$suffix.log"
    holder_client=''; race_fixture_created=false; race_success=false
    cleanup_activation_race() {
      psql_admin --command "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name='$holder_app' AND pid<>pg_backend_pid();" >/dev/null 2>&1 || true
      if [[ -n $holder_client ]]; then wait "$holder_client" >/dev/null 2>&1 || true; fi
      psql_admin --command "DROP TRIGGER IF EXISTS $trigger_name ON obs; DROP FUNCTION IF EXISTS $function_name();" >/dev/null 2>&1 || true
      rm -f -- "$holder_log"
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
    generation_hold=''; observation_hold=''
    cleanup_control_holds() {
      set +e
      for pending_hold in "$generation_hold" "$observation_hold"; do
        [[ $pending_hold =~ ^[0-9a-fA-F-]{36}$ ]] || continue
        sudo bash oscar.sh archive hold release --id "$pending_hold" --released-by oscar-regression-cleanup >/dev/null 2>&1
      done
      while IFS= read -r pending_hold; do
        [[ $pending_hold =~ ^[0-9a-fA-F-]{36}$ ]] || continue
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
    hold=$(retention_hold_id_from_output "$hold_output" "$store_key" "$id_scope") ||
      fail 'Hold create did not return one canonical scoped ID.'
    generation_hold=$hold
    [[ $(scalar "SELECT count(*) FROM oscar_retention_hold WHERE id='$hold' AND released_at IS NULL;") == 1 ]] || fail 'Created hold is not listed.'
    sudo bash oscar.sh archive hold release --id "$hold" --released-by oscar-regression >/dev/null
    [[ $(scalar "SELECT count(*) FROM oscar_retention_hold WHERE id='$hold' AND released_at IS NOT NULL;") == 1 ]] || fail 'Hold was not released.'
    generation_hold=''
    observation_hold_output=$(sudo bash oscar.sh archive hold create --store-key "$store_key" --id-scope "$id_scope" \
      --observation "$cold_id" --reason "regression-observation-$run" --created-by oscar-regression)
    observation_hold=$(retention_hold_id_from_output "$observation_hold_output" "$store_key" "$id_scope") ||
      fail 'Observation hold create did not return one canonical scoped ID.'
    [[ $(scalar "SELECT count(*) FROM oscar_retention_hold WHERE id='$observation_hold' AND subject_type='OBSERVATION' AND subject_id='$cold_id' AND released_at IS NULL;") == 1 ]] ||
      fail 'Created observation hold is not listed.'
    sudo bash oscar.sh archive hold release --id "$observation_hold" --released-by oscar-regression >/dev/null
    [[ $(scalar "SELECT count(*) FROM oscar_retention_hold WHERE id='$observation_hold' AND released_at IS NOT NULL;") == 1 ]] ||
      fail 'Observation hold was not released.'
    observation_hold=''
    trap - EXIT
    cutoff=$(psql_admin --tuples-only --no-align --command "SELECT to_char(window_end+interval '1 second','YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') FROM oscar_archive_generation WHERE id='$generation';" | tr -d '[:space:]')
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
      'generationHoldCreated',true,'observationHoldCreated',true,'dryRunPlan','$plan',
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
    root=$backup_dir/$backup
    for required in VERIFIED JOURNAL_CONFIRMED SHA256SUMS SHA256SUMS.hmac epoch.json image-inventory.txt archive-generation-ids.txt; do
      [[ -f $root/$required && ! -L $root/$required && -s $root/$required ]] ||
        fail "Backup marker is missing, empty, linked, or non-regular: $required"
    done
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
    valid_uuid "$epoch_id" || fail 'Backup epoch UUID is invalid.'
    [[ $epoch_backup == "$backup" && $epoch_format == oscar-backup-epoch && $epoch_version == 1 &&
          $epoch_release == 3.9.2 && $epoch_state == CREATED ]] ||
      fail 'Backup epoch identity, format, state, or release is invalid.'
    oscar_state_sha=$(awk '$2=="./oscar-state.tar.gz" {print $1}' "$root/SHA256SUMS")
    [[ $oscar_state_sha =~ ^[0-9a-f]{64}$ ]] || fail 'Authenticated manifest has no unique OSCAR state checksum.'
    [[ $(awk '$2=="./oscar-state.tar.gz" {count++} END {print count+0}' "$root/SHA256SUMS") == 1 ]] ||
      fail 'Authenticated manifest must contain exactly one OSCAR state entry.'
    [[ $(awk '$2=="./archive-generation-ids.txt" {count++} END {print count+0}' "$root/SHA256SUMS") == 1 ]] ||
      fail 'Authenticated manifest must contain exactly one archive-generation inventory.'
    generation_bytes=$(wc -c <"$root/archive-generation-ids.txt" | tr -d '[:space:]')
    [[ $generation_bytes =~ ^[0-9]+$ && $generation_bytes -le 37000000 ]] ||
      fail 'Archive-generation inventory exceeds its 37,000,000-byte safety bound.'
    if [[ $generation_bytes -gt 0 ]]; then
      [[ $(tail -c 1 "$root/archive-generation-ids.txt" | od -An -t x1 | tr -d '[:space:]') == 0a ]] ||
        fail 'Archive-generation inventory is not canonically newline terminated.'
    fi
    generation_count=$(wc -l <"$root/archive-generation-ids.txt" | tr -d '[:space:]')
    [[ $generation_count =~ ^[0-9]+$ && $generation_count -le 1000000 ]] ||
      fail 'Archive-generation inventory exceeds its one-million-entry safety bound.'
    if grep -Evq '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' \
        "$root/archive-generation-ids.txt"; then
      fail 'Archive-generation inventory contains a noncanonical UUID.'
    fi
    LC_ALL=C sort -c -u "$root/archive-generation-ids.txt" >/dev/null 2>&1 ||
      fail 'Archive-generation inventory is unsorted or contains duplicates.'
    inventory_generation_ids=$(paste -sd, "$root/archive-generation-ids.txt")
    [[ $(awk '$2=="./JOURNAL_CONFIRMED" {count++} END {print count+0}' "$root/SHA256SUMS") == 0 ]] ||
      fail 'Post-verification journal confirmation must remain outside the authenticated core inventory.'
    [[ $(wc -l <"$root/JOURNAL_CONFIRMED" | tr -d '[:space:]') == 5 &&
          $(grep -Fxc 'format=oscar-journal-backup-confirmation' "$root/JOURNAL_CONFIRMED") == 1 &&
          $(grep -Fxc 'version=2' "$root/JOURNAL_CONFIRMED") == 1 &&
          $(grep -Fxc "backup_id=$backup" "$root/JOURNAL_CONFIRMED") == 1 &&
          $(grep -Fxc "oscar_state_sha256=$oscar_state_sha" "$root/JOURNAL_CONFIRMED") == 1 &&
          $(grep -Ec '^hmac_sha256=[A-Za-z0-9+/]{43}=$' "$root/JOURNAL_CONFIRMED") == 1 ]] ||
      fail 'Journal-confirmation audit sidecar does not match the accepted recovery point.'
    backup_key_file=$(absolute_path "$(env_value OSCAR_BACKUP_KEY_FILE ./secrets/backup-key.txt)")
    app_image=$(compose config --images | grep -E '^oscar:[^[:space:]]+$' | head -n1)
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
    sudo bash oscar.sh backup-verify "$backup" >/tmp/oscar-regression-backup-verify.log 2>&1
    epoch=$(scalar "SELECT count(*) FROM oscar_backup_epoch WHERE id='$epoch_id' AND state='VERIFIED' AND manifest_path='$backup/epoch.json';")
    catalog_generation_ids=$(scalar "SELECT coalesce(array_to_string(archive_generation_ids,','),'') FROM oscar_backup_epoch WHERE id='$epoch_id' AND state='VERIFIED' AND manifest_path='$backup/epoch.json';")
    [[ $epoch == 1 && $catalog_generation_ids == "$inventory_generation_ids" ]] ||
      fail 'VERIFIED catalog epoch does not exactly match the authenticated backup-time archive-generation inventory.'
    backup_reference="oscar-backup:$backup/oscar-state.tar.gz#sha256=$oscar_state_sha"
    receipt_count=0; invalid_receipts=0
    receipt_root=/var/lib/oscar/files/.dailyfile-journal/backup-confirmations
    confirmation_set=$receipt_root/.sets/$backup.json
    compose exec -T oscar sh -c 'test -f "$1" && test ! -L "$1"' marker-check "$confirmation_set" ||
      fail 'Atomic daily-journal confirmation-set marker is missing or unsafe.'
    set_encoded=$(compose exec -T oscar openssl base64 -A -in "$confirmation_set" | tr -d '\r\n')
    [[ $set_encoded =~ ^[A-Za-z0-9+/]+=*$ && ${#set_encoded} -le 89478488 ]] ||
      fail 'Daily-journal confirmation-set marker exceeds the 64 MiB decoded safety bound.'
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
    while IFS= read -r receipt; do
      [[ -n $receipt ]] || continue
      [[ $receipt =~ ^/var/lib/oscar/files/\.dailyfile-journal/backup-confirmations/[A-Za-z0-9._-]+/[0-9]{4}-[0-9]{2}-[0-9]{2}\.json$ ]] ||
        fail 'Daily-journal receipt path is outside the exact receipt layout.'
      receipt_day=${receipt##*/}; receipt_day=${receipt_day%.json}
      encoded=$(compose exec -T oscar openssl base64 -A -in "$receipt" | tr -d '\r\n')
      [[ $encoded =~ ^[A-Za-z0-9+/]+=*$ && ${#encoded} -le 1048576 ]] ||
        fail 'Daily-journal receipt could not be represented as bounded base64.'
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
      relative=${receipt#"$receipt_root"/}
      receipt_sha=$(compose exec -T oscar sha256sum "$receipt" | awk '{print $1}')
      membership=$(scalar "WITH doc AS (
          SELECT convert_from(decode('$set_encoded','base64'),'UTF8')::jsonb AS value)
        SELECT count(*)=1 FROM doc, LATERAL jsonb_array_elements(value->'receipts') receipt
        WHERE receipt->>'path'='$relative' AND receipt->>'sha256'='$receipt_sha';")
      [[ $receipt_valid == t && $membership == t ]] || invalid_receipts=$((invalid_receipts+1))
    done < <(compose exec -T oscar find "$receipt_root" -path "$receipt_root/.sets" -prune -o \
      -mindepth 2 -maxdepth 2 -type f -name '*.json' -print 2>/dev/null || true)
    set_count=$(scalar "WITH doc AS (
        SELECT convert_from(decode('$set_encoded','base64'),'UTF8')::jsonb AS value)
      SELECT (value->>'receiptCount')::bigint FROM doc;")
    [[ $set_count == "$receipt_count" ]] || invalid_receipts=$((invalid_receipts+1))
    [[ $receipt_count =~ ^[0-9]+$ && $receipt_count -gt 0 && $invalid_receipts == 0 ]] ||
      fail 'New backup did not produce valid, authenticated daily-journal receipts.'
    printf '{"backupId":"%s","automaticVerification":true,"supportedVerification":true,"authenticatedManifest":true,"journalConfirmationAuthenticated":true,"regularMarkers":true,"epochValid":true,"verifiedEpoch":%s,"archiveGenerationInventoryExact":true,"archiveGenerationCount":%s,"journalReceipts":%s,"journalReceiptReferencesValid":true,"verifiedBackups":%s,"retentionLimit":%s,"retentionRespected":%s,"restoreAttempted":false}\n' \
      "$backup" "$([[ $epoch == 1 ]] && echo true || echo false)" "$generation_count" "$receipt_count" "$verified" "$retention" "$([[ $verified -le $retention ]] && echo true || echo false)"
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
    archive_canary="$archive_dir/.restore-regression-$run.canary"
    secret_canary="$release_dir/secrets/.restore-regression-$run.canary"
    tls_canary="$release_dir/tls/.restore-regression-$run.canary"
    env_canary="# OSCAR_RESTORE_DRILL_CANARY=$marker"
    env_mutated="# OSCAR_RESTORE_DRILL_CANARY=$mutated"
    wal_baseline=$(mktemp "/tmp/oscar-restore-wal-$run.XXXXXX")
    compose exec -T oscar sh -eu -c 'test ! -e "/var/lib/oscar/$1" && test ! -L "/var/lib/oscar/$1"' \
      canary "$state_relative" || fail 'An application-state restore-drill canary already exists.'
    [[ ! -e $archive_canary && ! -L $archive_canary && ! -e $secret_canary &&
          ! -L $secret_canary && ! -e $tls_canary && ! -L $tls_canary ]] ||
      fail 'A restore-drill canary already exists; investigate a prior interrupted run.'
    [[ $(scalar "SELECT count(*) FROM oscar_regression_fixture WHERE run_id='$run';") == 0 ]] ||
      fail 'Restore-drill run ID already exists in the fixture registry.'
    grep -Fq 'OSCAR_RESTORE_DRILL_CANARY=' .env &&
      fail 'The deployment .env contains an unresolved restore-drill canary.'

    cleanup_restore_drill() {
      set +e
      if compose ps --status running --services 2>/dev/null | grep -Fxq postgres; then
        psql_admin --command "DELETE FROM oscar_regression_fixture WHERE run_id='$run';" >/dev/null 2>&1
      fi
      if compose ps --status running --services 2>/dev/null | grep -Fxq oscar; then
        compose exec -T oscar sh -c "rm -f -- '/var/lib/oscar/$state_relative'; rmdir /var/lib/oscar/files/.restore-regression 2>/dev/null || true" >/dev/null 2>&1
      fi
      rm -f -- "$archive_canary" "$secret_canary" "$tls_canary"
      rm -f -- "$wal_baseline"
      sed -i "/^# OSCAR_RESTORE_DRILL_CANARY=$run:/d" .env 2>/dev/null
      set -e
    }
    trap cleanup_restore_drill EXIT
    umask 077
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
    printf '%s\n' "$marker" >"$archive_canary"
    printf '%s\n' "$marker" >"$secret_canary"
    printf '%s\n' "$marker" >"$tls_canary"
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
    sudo bash oscar.sh backup-verify "$backup" >/tmp/oscar-regression-restore-backup-verify.log 2>&1

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
    printf '%s\n' "$mutated" >"$archive_canary"
    printf '%s\n' "$mutated" >"$secret_canary"
    printf '%s\n' "$mutated" >"$tls_canary"
    sed -i "s|^# OSCAR_RESTORE_DRILL_CANARY=$marker$|$env_mutated|" .env
    grep -Fqx "$env_mutated" .env || fail 'Could not mutate the restore-drill deployment canary.'

    sudo bash oscar.sh restore --backup "$backup" --confirm "$backup" >/tmp/oscar-regression-restore.log 2>&1
    database_restored=false
    [[ $(scalar "SELECT count(*) FROM oscar_regression_fixture WHERE run_id='$run' AND restore_marker='$marker';") == 1 ]] && database_restored=true
    state_restored=false
    [[ $(compose exec -T oscar sh -c "cat -- '/var/lib/oscar/$state_relative'" 2>/dev/null || true) == "$marker" ]] && state_restored=true
    archive_restored=false; [[ $(cat -- "$archive_canary" 2>/dev/null || true) == "$marker" ]] && archive_restored=true
    credentials_restored=false
    if [[ $(cat -- "$secret_canary" 2>/dev/null || true) == "$marker" &&
          $(cat -- "$tls_canary" 2>/dev/null || true) == "$marker" &&
          $(grep -Fxc "$env_canary" .env) == 1 ]]; then credentials_restored=true; fi
    services_healthy=true
    for service in gateway oscar postgres; do
      container=$(compose ps -q "$service")
      [[ -n $container && $(docker inspect "$container" --format '{{.State.Status}}') == running &&
            $(docker inspect "$container" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}') == healthy ]] ||
        services_healthy=false
    done
    archive_verified=false
    sudo bash oscar.sh archive verify >/tmp/oscar-regression-restore-archive-verify.log 2>&1 && archive_verified=true
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
    recovery_defaults=$(scalar "SELECT (current_setting('restore_command')='' AND current_setting('recovery_target')='' AND current_setting('recovery_target_timeline')='latest' AND current_setting('recovery_target_action')='pause')::text;")
    recovery_pending=$(scalar "SELECT count(*) FROM pg_settings WHERE name IN ('restore_command','recovery_target','recovery_target_timeline','recovery_target_action') AND pending_restart;")
    if [[ $recovery_defaults == t && $recovery_pending == 0 ]] &&
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
    valid_uuid "$epoch_id" && [[ $epoch_lsn =~ ^[0-9A-F]+/[0-9A-F]+$ && $epoch_sha =~ ^[0-9a-f]{64}$ ]] ||
      fail 'Restored backup has invalid authenticated epoch fields.'
    verified_epoch_restored=false
    [[ $(scalar "SELECT count(*) FROM oscar_backup_epoch WHERE id='$epoch_id' AND state='VERIFIED' AND postgres_lsn='$epoch_lsn' AND manifest_path='$backup/epoch.json' AND sha256='$epoch_sha' AND verified_at IS NOT NULL;") == 1 ]] &&
      verified_epoch_restored=true
    safety="$release_dir/pre-restore-$backup"
    [[ -d $safety && ! -L $safety && $(stat -c '%a' -- "$safety") == 700 &&
          -f $safety/.env && ! -L $safety/.env &&
          -d $safety/secrets && ! -L $safety/secrets &&
          -d $safety/tls && ! -L $safety/tls ]] ||
      fail 'Restore did not preserve a private, complete pre-restore credential safety directory.'
    all_restored=false
    if $database_restored && $state_restored && $archive_restored && $wal_restored &&
       $credentials_restored && $services_healthy && $archive_verified && $fresh_timeline &&
       $timeline_history_archived && $new_timeline_wal_archived && $prior_wal_preserved &&
       $post_backup_wal_preserved &&
       $archiver_failure_free && $recovery_settings_cleared && $verified_epoch_restored; then all_restored=true; fi
    printf '{"backupId":"%s","databaseRestored":%s,"applicationStateRestored":%s,"archiveRestored":%s,"walRestored":%s,"credentialsRestored":%s,"servicesHealthy":%s,"archiveVerified":%s,"freshTimeline":%s,"sourceTimeline":%s,"restoredTimeline":%s,"timelineHistoryArchived":%s,"newTimelineWalArchived":%s,"priorWalPreserved":%s,"postBackupWalPreserved":%s,"archiverFailureFree":%s,"recoverySettingsCleared":%s,"verifiedEpochRestored":%s,"allCanariesRestored":%s,"preRestoreSafetyDirectory":"%s"}\n' \
      "$backup" "$database_restored" "$state_restored" "$archive_restored" "$wal_restored" \
      "$credentials_restored" "$services_healthy" "$archive_verified" "$fresh_timeline" \
      "$source_timeline" "$restored_timeline" "$timeline_history_archived" "$new_timeline_wal_archived" \
      "$prior_wal_preserved" "$post_backup_wal_preserved" "$archiver_failure_free" "$recovery_settings_cleared" \
      "$verified_epoch_restored" "$all_restored" "$safety"
    cleanup_restore_drill
    trap - EXIT
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
