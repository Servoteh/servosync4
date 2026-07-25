#!/usr/bin/env bash
# Noćni backup on-prem stacka (ubuntusrv) — sy15 (1.0) + servosync-pg (2.0) + sy15 storage fajlovi.
# Instalacija: ~/ops/backup-nightly.sh, cron 02:30 (v. infra/self-host/ops/README u repou / crontab).
# Retencija: 7 dnevnih; nedeljom kopija u weekly/ (čuva se 28 dana). Off-site kopija = TODO (odluka).
#
# ŽIVA KOPIJA: ubuntusrv:/home/admnenad/ops/backup-nightly.sh (cron admnenad, 02:30).
# Ovde stoji verzionisana kopija — kod izmene ažuriraj OBE (repo je referenca, server je izvršilac).
# Verzionisano 25.07.2026 (DB audit DB-074); restore proceduru i status vidi u docs/DB_AUDIT_REPORT.md.
#
# RESTORE (testirano 25.07.2026, ~1m40s za 2.4GB bazu):
#   docker run -d --name restore-test-pg -e POSTGRES_PASSWORD=... postgres:18
#   docker exec restore-test-pg psql -U postgres -c "CREATE DATABASE servosync"
#   docker exec -i restore-test-pg pg_restore -U postgres -d servosync --no-owner --no-privileges \
#     < ~/backups/daily/servosync2_<datum>.dump
#   (2 FK-a se preskaču zbog orphan redova upisanih pod session_replication_role=replica —
#    v. DB audit; posle restore-a proveri pg_restore exit poruke.)
set -euo pipefail

BASE="${BACKUP_BASE:-$HOME/backups}"
DAILY="$BASE/daily"; WEEKLY="$BASE/weekly"
mkdir -p "$DAILY" "$WEEKLY"
STAMP="$(date +%F)"
echo "[backup] start $STAMP $(date +%T)"

# 1) sy15 (1.0) — ceo klaster-db 'postgres' (public+auth+storage+ostalo), custom format
docker exec sy15-db pg_dump -U supabase_admin -Fc -d postgres > "$DAILY/sy15_${STAMP}.dump.tmp"
mv "$DAILY/sy15_${STAMP}.dump.tmp" "$DAILY/sy15_${STAMP}.dump"

# 2) servosync 2.0 baza
docker exec servosync-pg pg_dump -U servosync -Fc -d servosync > "$DAILY/servosync2_${STAMP}.dump.tmp"
mv "$DAILY/servosync2_${STAMP}.dump.tmp" "$DAILY/servosync2_${STAMP}.dump"

# 3) sy15 storage fajlovi (named volume) — tar direktno iz volumena, read-only
docker run --rm -v servosync15_sy15-storage-data:/data:ro alpine \
  tar -C /data -czf - . > "$DAILY/sy15_storage_${STAMP}.tgz.tmp"
mv "$DAILY/sy15_storage_${STAMP}.tgz.tmp" "$DAILY/sy15_storage_${STAMP}.tgz"

# 4) integritet dump-ova (katalog se da pročitati)
docker exec -i sy15-db pg_restore --list < "$DAILY/sy15_${STAMP}.dump" > /dev/null
docker exec -i servosync-pg pg_restore --list < "$DAILY/servosync2_${STAMP}.dump" > /dev/null

# 5) nedeljom (u=7) kopija u weekly/
if [ "$(date +%u)" = "7" ]; then
  cp -f "$DAILY/sy15_${STAMP}.dump" "$DAILY/servosync2_${STAMP}.dump" "$DAILY/sy15_storage_${STAMP}.tgz" "$WEEKLY/"
fi

# 6) retencija
find "$DAILY"  -type f \( -name '*.dump' -o -name '*.tgz' \) -mtime +7  -delete
find "$WEEKLY" -type f \( -name '*.dump' -o -name '*.tgz' \) -mtime +28 -delete

# 7) marker za monitoring (svežina < 26h = zdravo)
date +%s > "$BASE/.last_ok"
echo "[backup] OK $(date +%T) — $(du -sh "$DAILY" | cut -f1) daily, $(du -sh "$WEEKLY" | cut -f1) weekly"
