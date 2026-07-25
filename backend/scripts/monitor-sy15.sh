#!/usr/bin/env bash
# Monitoring on-prem stacka (ubuntusrv) — cron */10 min. Skuplja probleme i šalje mejl (Resend, max 1/h).
# DRY=1 ./monitor-sy15.sh  → samo ispiše izveštaj, ne šalje mejl.
#
# ŽIVA KOPIJA: ubuntusrv:/home/admnenad/ops/monitor-sy15.sh (cron root, */10 min).
# Ovde stoji verzionisana kopija — kod izmene ažuriraj OBE (repo je referenca, server je izvršilac).
# Tajni nema u fajlu: RESEND ključ se čita iz ~/servosync15/.env u trenutku slanja.
set -uo pipefail

ENVF="$HOME/servosync15/.env"
BASE="${BACKUP_BASE:-$HOME/backups}"
LOCK="$BASE/.monitor_last_mail"
TO="nenad.jarakovic@servoteh.com"
PROBLEMS=""
add() { PROBLEMS="${PROBLEMS}- $1"$'\n'; }

psq() { docker exec sy15-db psql -U supabase_admin -d postgres -tAc "$1" 2>/dev/null; }

# 1) kontejneri
for c in sy15-db sy15-rest sy15-auth sy15-storage sy15-functions sy15-gateway sy15-scheduler servosync-pg servosync-backend cloudflared; do
  st="$(docker inspect -f '{{.State.Status}}' "$c" 2>/dev/null || echo missing)"
  [ "$st" = "running" ] || add "kontejner $c: $st"
done

# 2) outbox: queued stariji od 30 min (dispatch ne prazni) + failed u zadnjih 60 min
Q=$(psq "select coalesce(sum(c),0) from (
  select count(*) c from kadr_notification_log     where status='queued' and created_at < now()-interval '30 min'
  union all select count(*) from sastanci_notification_log where status='queued' and created_at < now()-interval '30 min'
  union all select count(*) from maint_notification_log    where status='queued' and created_at < now()-interval '30 min'
  union all select count(*) from pb_notification_log       where status='queued' and created_at < now()-interval '30 min') x")
[ "${Q:-0}" -gt 0 ] && add "outbox: $Q queued redova starijih od 30 min"
F=$(psq "select coalesce(sum(c),0) from (
  select count(*) c from kadr_notification_log     where status='failed' and coalesce(last_attempt_at,created_at) > now()-interval '60 min'
  union all select count(*) from sastanci_notification_log where status='failed' and coalesce(last_attempt_at,created_at) > now()-interval '60 min'
  union all select count(*) from maint_notification_log    where status='failed' and coalesce(last_attempt_at,created_at) > now()-interval '60 min'
  union all select count(*) from pb_notification_log       where status='failed' and coalesce(last_attempt_at,created_at) > now()-interval '60 min') x")
[ "${F:-0}" -gt 0 ] && add "outbox: $F failed u zadnjih 60 min"

# 3) bridge (user systemd)
XDG_RUNTIME_DIR="/run/user/$(id -u)" systemctl --user is-active servoteh-bridge >/dev/null 2>&1 \
  || add "servoteh-bridge servis nije active"

# 4) svežina tokova
SC=$(psq "select coalesce(extract(epoch from now()-max(ts))::int, 999999) from scada_history")
[ "${SC:-999999}" -gt 900 ] && add "SCADA: poslednji zapis pre $((SC/60)) min (repoint SCADA VM?)"
LH=$(psq "select coalesce(extract(epoch from now()-max(last_seen))::int, 999999) from loc_sync_worker_heartbeat")
[ "${LH:-999999}" -gt 900 ] && add "loc-sync heartbeat star $((LH/60)) min"
# crteži (bigtehn_drawings_cache) provera UGAŠENA 2026-07-15: 1.0 sync se penzioniše,
# 2.0 već servira kompletan PDF korpus (drawing_pdfs, 5425/5425) — vidi [[bridge-inventar-penzionisanje]].
# WO cache provera UGAŠENA 2026-07-25 (zahtev 017/26): praćenje proizvodnje je 3.0-native
# od 19.07, sy15 WO feed se penzioniše (F5) — keš legitimno stoji, alarm nema smisla.
# WO=$(psq "select coalesce(extract(epoch from now()-max(synced_at))::int, 999999) from bigtehn_work_orders_cache")
# [ "${WO:-999999}" -gt 21600 ] && add "production sync: WO cache star $((WO/3600)) h"

# 5) disk
PCT=$(df --output=pcent / | tail -1 | tr -dc '0-9')
[ "${PCT:-0}" -ge 85 ] && add "disk: ${PCT}% zauzeto"

# 6) backup svežina (posle prvog backupa)
if [ -f "$BASE/.last_ok" ]; then
  AGE=$(( $(date +%s) - $(cat "$BASE/.last_ok") ))
  [ "$AGE" -gt 93600 ] && add "backup: poslednji uspešan pre $((AGE/3600)) h"
else
  add "backup: još nijedan uspešan run (.last_ok ne postoji)"
fi

# 7) katbroj duplikati (DB audit DB-081) — ratchet: alarm SAMO ako broj duplikat-grupa
# poraste (dokaz da BigBit brana ne drži); čišćenje sme samo da ga smanjuje.
# Case-insensitive grupisanje (odluka 25.07). Baseline se sam spušta pri čišćenju.
psq2() { docker exec servosync-pg psql -U servosync -d servosync -tAc "$1" 2>/dev/null; }
KB_BASE_FILE="$HOME/ops/.katbroj_baseline"
KB_CUR=$(psq2 "select count(*) from (select lower(catalog_number) from items where btrim(coalesce(catalog_number,''))<>'' group by lower(catalog_number) having count(*)>1) d")
if [ -n "${KB_CUR:-}" ]; then
  if [ -f "$KB_BASE_FILE" ]; then KB_BASE=$(cat "$KB_BASE_FILE"); else KB_BASE="$KB_CUR"; echo "$KB_CUR" > "$KB_BASE_FILE"; fi
  [ "$KB_CUR" -gt "$KB_BASE" ] && add "items: duplikat-grupe kataloškog broja PORASLE ($KB_BASE → $KB_CUR) — BigBit brana ne drži? (DB-081)"
  [ "$KB_CUR" -lt "$KB_BASE" ] && echo "$KB_CUR" > "$KB_BASE_FILE"
fi

[ -z "$PROBLEMS" ] && exit 0
echo "[monitor] $(date +'%F %T') problemi:"; printf '%s' "$PROBLEMS"
[ "${DRY:-0}" = "1" ] && exit 0

# throttle: max 1 mejl na sat
if [ -f "$LOCK" ] && [ $(( $(date +%s) - $(stat -c %Y "$LOCK") )) -lt 3600 ]; then exit 0; fi

KEY=$(grep -E '^RESEND_API_KEY=' "$ENVF" | cut -d= -f2-)
FROM=$(grep -E '^RESEND_FROM=' "$ENVF" | cut -d= -f2-)
[ -z "$KEY" ] && exit 0
BODY=$(printf '%s' "$PROBLEMS" | sed 's/$/<br>/' | tr -d '\n')
curl -s -o /dev/null -X POST https://api.resend.com/emails \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d "{\"from\":\"${FROM:-Servoteh <obavestenja@servoteh.com>}\",\"to\":[\"$TO\"],\"subject\":\"[ubuntusrv] monitoring: problemi na on-prem stacku\",\"html\":\"$BODY\"}" \
  && touch "$LOCK"
