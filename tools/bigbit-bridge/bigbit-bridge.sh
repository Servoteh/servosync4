#!/usr/bin/env bash
# =============================================================================
# ServoSync BigBit bridge  --  BigBit ERP (Access .mdb) -> ServoSync 2.0 PG
# -----------------------------------------------------------------------------
# Runs on the Ubuntu server (ubuntusrv, 192.168.64.28) once a day via a systemd
# timer (see install-timer.sh). Reader = mdb-tools inside a small docker image;
# mdb-tools reads the raw Jet file and IGNORES Access ULS workgroup security, so
# NO password / PID / workgroup file is needed (decision Nenad, 2026-07-11 - the
# "Slavisa" credential turned out to be workgroup PIDs, not a login password).
#
# Writer = local `docker exec servosync-pg psql` on the SAME host, so there is
# no need to expose PG 5432 on the LAN and no dedicated bb_sync role.
#
# Per table: mdb-export -> CSV -> psql staging temp table + INSERT ON CONFLICT
# DO UPDATE (UPSERT). One transaction per table. Rows present in PG but missing
# from BigBit are NEVER deleted, only counted/logged (plan section 7.3).
#
# Exit codes (systemd "status"):
#   0  ok
#   1  at least one table failed
#   2  BigBit source unreadable (missing .mdb / mdb-export failed)
#   3  configuration invalid or prerequisite missing (docker, image, psql)
#   4  PostgreSQL container not reachable
# =============================================================================
set -u -o pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE="${1:-$SCRIPT_DIR/bigbit-bridge.env}"

EXIT_OK=0; EXIT_TABLE_FAILED=1; EXIT_SRC=2; EXIT_CONFIG=3; EXIT_PG=4

# ---- config ---------------------------------------------------------------
if [[ -f "$CONFIG_FILE" ]]; then
  # shellcheck disable=SC1090
  set -a; source "$CONFIG_FILE"; set +a
fi
BB_SRC_MDB="${BB_SRC_MDB:-}"
BB_PG_CONTAINER="${BB_PG_CONTAINER:-servosync-pg}"
BB_PG_USER="${BB_PG_USER:-servosync}"
BB_PG_DB="${BB_PG_DB:-servosync}"
BB_MDBTOOLS_IMAGE="${BB_MDBTOOLS_IMAGE:-servosync/mdbtools:local}"
BB_TMP_DIR="${BB_TMP_DIR:-/tmp/bigbit-bridge}"
BB_LOG_FILE="${BB_LOG_FILE:-$SCRIPT_DIR/bigbit-bridge.log}"
BB_ONLY="${BB_ONLY:-}"          # optional: sync a single Access table (pilot/debug)
BB_DRY_RUN="${BB_DRY_RUN:-0}"   # 1 = ROLLBACK instead of COMMIT

MANIFEST="$SCRIPT_DIR/tables.manifest"
SQL_DIR="$SCRIPT_DIR/sql"

log() {
  local level="$1"; shift
  local line; line="$(date '+%Y-%m-%d %H:%M:%S') ${level} $*"
  echo "$line"
  # a broken log path must never kill the run
  { echo "$line" >>"$BB_LOG_FILE"; } 2>/dev/null || true
}

die() { local code="$1"; shift; log "ERROR" "$*"; exit "$code"; }

# ---- prerequisites --------------------------------------------------------
[[ -n "$BB_SRC_MDB" ]] || die $EXIT_CONFIG "BB_SRC_MDB nije postavljen (vidi bigbit-bridge.env.example)."
# BB_SRC_MDB may be a FILE or a DROP FOLDER. If it is a folder (BigBit spusta
# izvoz tamo automatski preko deljenog foldera), pick the NEWEST *.mdb in it.
if [[ -d "$BB_SRC_MDB" ]]; then
  src_dir_conf="$BB_SRC_MDB"
  BB_SRC_MDB="$(find "$src_dir_conf" -maxdepth 1 -type f -iname '*.mdb' -printf '%T@ %p\n' 2>/dev/null | sort -rn | head -1 | cut -d' ' -f2-)"
  [[ -n "$BB_SRC_MDB" ]] || die $EXIT_SRC "U drop folderu '$src_dir_conf' nema nijednog .mdb (BigBit jos nije spustio izvoz?)."
fi
[[ -f "$BB_SRC_MDB" ]] || die $EXIT_SRC "BigBit .mdb nije nadjen: $BB_SRC_MDB (proveri drop folder / CIFS mount / nocnu kopiju)."
[[ -f "$MANIFEST" ]] || die $EXIT_CONFIG "Manifest nije nadjen: $MANIFEST"
command -v docker >/dev/null 2>&1 || die $EXIT_CONFIG "docker nije na PATH-u."
docker image inspect "$BB_MDBTOOLS_IMAGE" >/dev/null 2>&1 || \
  die $EXIT_CONFIG "docker image '$BB_MDBTOOLS_IMAGE' ne postoji - pokreni install-timer.sh (build) ili: docker build -t $BB_MDBTOOLS_IMAGE -f Dockerfile.mdbtools ."
docker exec "$BB_PG_CONTAINER" psql -U "$BB_PG_USER" -d "$BB_PG_DB" -Atc "SELECT 1" >/dev/null 2>&1 || \
  die $EXIT_PG "PG kontejner '$BB_PG_CONTAINER' nedostupan (SELECT 1 pao) - proveri da radi i BB_PG_USER/DB."

MODE="upsert"; [[ "$BB_DRY_RUN" == "1" ]] && MODE="DRY-RUN(rollback)"
log "INFO" "=== BigBit bridge start - mod=$MODE, src=$BB_SRC_MDB, pg=$BB_PG_CONTAINER/$BB_PG_DB as $BB_PG_USER ==="

SRC_DIR="$(cd "$(dirname "$BB_SRC_MDB")" && pwd)"
SRC_BASE="$(basename "$BB_SRC_MDB")"
RUN_DIR="$BB_TMP_DIR/run-$(date '+%Y%m%d_%H%M%S')"
mkdir -p "$RUN_DIR"

# staging area inside the PG container
docker exec "$BB_PG_CONTAINER" mkdir -p /tmp/bb 2>/dev/null || true

ok=0; failed=0; total_read=0; total_ins=0; total_upd=0

# ---- per-table sync -------------------------------------------------------
while IFS='|' read -r access_table target sql_file || [[ -n "$access_table" ]]; do
  # skip comments / blank lines
  [[ -z "${access_table// }" || "${access_table#\#}" != "$access_table" ]] && continue
  access_table="${access_table// }"; target="${target// }"; sql_file="${sql_file// }"

  if [[ -n "$BB_ONLY" && "$BB_ONLY" != "$access_table" && "$BB_ONLY" != "$target" ]]; then
    continue
  fi

  t0=$(date +%s)
  csv_host="$RUN_DIR/$target.csv"
  sql_path="$SQL_DIR/$sql_file"
  if [[ ! -f "$sql_path" ]]; then
    log "ERROR" "$access_table -> $target: SQL fajl nedostaje ($sql_path)."; failed=$((failed+1)); continue
  fi

  # 1) mdb-export the whole table to CSV (ULS-free). '-H' would drop the header;
  #    we KEEP the header and \copy skips it (HEADER true), loading positionally.
  if ! docker run --rm -v "$SRC_DIR":/db:ro "$BB_MDBTOOLS_IMAGE" \
        mdb-export -q '"' "/db/$SRC_BASE" "$access_table" > "$csv_host" 2>"$RUN_DIR/$target.mdberr"; then
    log "ERROR" "$access_table: mdb-export pao ($(head -1 "$RUN_DIR/$target.mdberr"))."; failed=$((failed+1)); continue
  fi
  rows_read=$(( $(wc -l < "$csv_host") - 1 )); [[ $rows_read -lt 0 ]] && rows_read=0
  if [[ $rows_read -eq 0 ]]; then
    log "WARN" "$access_table: izvor vratio 0 redova - sumnjivo za sifarnik; upsert svejedno ide (nista se ne brise)."
  fi

  # 2) stage + upsert in one transaction. CSV goes into the container /tmp/bb;
  #    the SQL file \copy-es from that fixed path and (for dry-run) we swap the
  #    final COMMIT with ROLLBACK on the fly.
  if ! docker cp "$csv_host" "$BB_PG_CONTAINER:/tmp/bb/$target.csv" 2>>"$RUN_DIR/$target.mdberr"; then
    log "ERROR" "$access_table -> $target: docker cp CSV pao."; failed=$((failed+1)); continue
  fi
  sql_stream="$(cat "$sql_path")"
  [[ "$BB_DRY_RUN" == "1" ]] && sql_stream="${sql_stream//COMMIT;/ROLLBACK; -- dry-run}"

  out="$(printf '%s' "$sql_stream" | docker exec -i "$BB_PG_CONTAINER" \
        psql -U "$BB_PG_USER" -d "$BB_PG_DB" -v ON_ERROR_STOP=1 -q -t -A 2>&1)"
  rc=$?
  docker exec "$BB_PG_CONTAINER" rm -f "/tmp/bb/$target.csv" 2>/dev/null || true
  if [[ $rc -ne 0 ]]; then
    log "ERROR" "$access_table -> $target: psql exit $rc ($(echo "$out" | tr '\n' ' ' | head -c 300)) - transakcija po tabeli, nista delimicno."
    failed=$((failed+1)); continue
  fi

  # counters line: staged|inserted|updated|missing_in_source
  counts="$(echo "$out" | grep -E '^[0-9]+\|[0-9]+\|[0-9]+\|[0-9]+$' | tail -1)"
  if [[ -z "$counts" ]]; then
    log "ERROR" "$access_table -> $target: psql prosao ali nema brojaca u izlazu ('$(echo "$out" | tr '\n' ' ' | head -c 200)')."
    failed=$((failed+1)); continue
  fi
  staged="${counts%%|*}"; rest="${counts#*|}"
  inserted="${rest%%|*}"; rest="${rest#*|}"
  updated="${rest%%|*}"; missing="${rest##*|}"
  unchanged=$(( staged - inserted - updated ))
  t1=$(date +%s); dur=$(( t1 - t0 ))
  tag=""; [[ "$BB_DRY_RUN" == "1" ]] && tag=" [DRY-RUN, ROLLBACK]"
  log "INFO" "$access_table -> $target: read=$rows_read inserted=$inserted updated=$updated unchanged=$unchanged missing_in_source=$missing (${dur}s)$tag"
  [[ "$missing" -gt 0 ]] && log "WARN" "$target: $missing red(ova) u PG a nema ih vise u BigBit izvoru - NIKAD se ne brisu automatski (odluka 7.3); proveri rucno."

  ok=$((ok+1)); total_read=$((total_read+rows_read)); total_ins=$((total_ins+inserted)); total_upd=$((total_upd+updated))
done < "$MANIFEST"

if [[ -n "$BB_ONLY" && $ok -eq 0 && $failed -eq 0 ]]; then
  die $EXIT_CONFIG "BB_ONLY='$BB_ONLY' ne odgovara nijednoj tabeli u manifestu."
fi

# cleanup: keep the run dir only on failure (diagnostics)
if [[ $failed -eq 0 ]]; then
  rm -rf "$RUN_DIR"
else
  log "INFO" "Temp folder ZADRZAN (dijagnostika): $RUN_DIR"
fi
# prune old kept run dirs (>14 dana)
find "$BB_TMP_DIR" -maxdepth 1 -type d -name 'run-*' -mtime +14 -exec rm -rf {} + 2>/dev/null || true

tag=""; [[ "$BB_DRY_RUN" == "1" ]] && tag=" [DRY-RUN - nista upisano]"
log "INFO" "REZIME: tabele OK=$ok palo=$failed, read=$total_read inserted=$total_ins updated=$total_upd$tag"
[[ $failed -gt 0 ]] && exit $EXIT_TABLE_FAILED
exit $EXIT_OK
