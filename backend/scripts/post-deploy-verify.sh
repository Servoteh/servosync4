#!/usr/bin/env bash
# ============================================================================
# post-deploy-verify.sh — OBAVEZNA provera posle SVAKOG backend deploy-a.
#
# Pokrenuti SA SERVERA (ubuntusrv) ili preko `ssh ubuntusrv 'bash -s' < ovaj-fajl`.
# Proverava CEO lanac koji je 21.07.2026 tiho pao i ostavio firmu bez logina 1h:
#   1. kontejner je STABILAN (Up, ne Restarting/crash-loop)
#   2. entrypoint radi (Nest boot, dist/main.js) — hvata prisma/*.ts rootDir drift
#   3. WEB pristup (javni gateway) — login endpoint živ
#   4. LAN pristup (same-origin :3000) — /login servira frontend, NE 404 (API-only)
#   5. frontend je BAKED (frontend-static popunjen) — hvata static-export fail
#
# Exit != 0 = deploy je defektan → istraži PRE nego što javiš „radi".
# Nijedan 404 na /login se NE toleriše (to je bio tihi LAN otkaz).
# ============================================================================
set -uo pipefail

LAN_IP="${LAN_IP:-192.168.64.28}"
PORT="${PORT:-3000}"
GATEWAY="${GATEWAY:-https://api.servosync.servoteh.com}"
CONTAINER="${CONTAINER:-servosync-backend}"
FAIL=0

say()  { printf '%s\n' "$*"; }
ok()   { printf '  ✅ %s\n' "$*"; }
bad()  { printf '  ❌ %s\n' "$*"; FAIL=1; }

say "=== POST-DEPLOY VERIFY ($(date '+%H:%M:%S')) ==="

# 1) Kontejner stabilnost — mora Up, ne Restarting
say "1) Kontejner stabilnost"
STATUS=$(docker ps --filter "name=${CONTAINER}" --format '{{.Status}}' 2>/dev/null)
case "$STATUS" in
  Up*)          ok "kontejner: $STATUS" ;;
  *Restarting*) bad "kontejner u restart-petlji: $STATUS (verovatno crash-loop entry point)" ;;
  "")           bad "kontejner $CONTAINER NE POSTOJI / ne radi" ;;
  *)            bad "kontejner neočekivan status: $STATUS" ;;
esac

# 2) Nest boot uspešan (hvata dist/main.js / rootDir drift)
# Ceo log (ne --tail): boot poruka je na vrhu, a kontejner koji dugo radi ima
# hiljade runtime linija ispod. Ali crash-loop se vidi po ponovljenom modulu.
say "2) Nest boot"
LOGS=$(docker logs "$CONTAINER" 2>&1)
if printf '%s' "$LOGS" | grep -q "Cannot find module '/app/dist/main'"; then
  bad "CRASH-LOOP: Cannot find module '/app/dist/main' (prisma/*.ts rootDir drift — vidi tsconfig.build.json exclude)"
elif printf '%s' "$LOGS" | grep -q "Nest application successfully started"; then
  ok "Nest application successfully started"
else
  bad "NEMA 'Nest successfully started' u logu — proveri boot (docker logs $CONTAINER)"
  printf '%s' "$LOGS" | tail -8 | sed 's/^/      /'
fi

# 3) WEB — javni gateway (login endpoint mora odgovoriti, 200/401/400 = živ, 000/5xx = mrtav)
say "3) WEB pristup (gateway $GATEWAY)"
WCODE=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$GATEWAY/api/auth/login" \
          -H 'Content-Type: application/json' -d '{"email":"_probe_","password":"_probe_"}' 2>/dev/null || echo 000)
case "$WCODE" in
  200|400|401) ok "WEB login endpoint živ (HTTP $WCODE)" ;;
  000)         bad "WEB login NEDOSTUPAN (gateway ne odgovara)" ;;
  *)           bad "WEB login neočekivan HTTP $WCODE" ;;
esac

# 4) LAN — same-origin :3000 mora servirati /login (NE 404 = API-only otkaz)
say "4) LAN pristup (http://$LAN_IP:$PORT)"
for path in / /login /index.html; do
  LCODE=$(curl -sS -o /dev/null -w '%{http_code}' "http://${LAN_IP}:${PORT}${path}" 2>/dev/null || echo 000)
  if [ "$LCODE" = "200" ]; then ok "LAN $path → 200"
  else bad "LAN $path → $LCODE (očekivano 200; 404 = frontend NIJE baked → LAN/offline login mrtav)"; fi
done
# LAN auth API isto mora biti živ
ACODE=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "http://${LAN_IP}:${PORT}/api/auth/login" \
          -H 'Content-Type: application/json' -d '{"email":"_probe_","password":"_probe_"}' 2>/dev/null || echo 000)
case "$ACODE" in
  200|400|401) ok "LAN auth API živ (HTTP $ACODE)" ;;
  *)           bad "LAN auth API HTTP $ACODE" ;;
esac

# 5) Frontend baked u kontejneru (potvrda za tačku 4)
say "5) Frontend baked"
FECOUNT=$(docker exec "$CONTAINER" sh -c 'ls /app/frontend-static/ 2>/dev/null | grep -v "^\.gitkeep$" | wc -l' 2>/dev/null || echo 0)
if [ "${FECOUNT:-0}" -gt 1 ]; then ok "frontend-static ima $FECOUNT fajlova (login.html uklj.)"
else bad "frontend-static PRAZAN ($FECOUNT) → deploy je pao na API-only (static export fail?)"; fi

# 6) MOBILNA 1.0 (/m/*) — worker proxy mora servirati 1.0, ne 3.0 Next 404.
# Incident 21.07: /m/<modul> je vraćao Next 404 (run_worker_first falio). Golo /m
# je radilo pa je otkaz bio nevidljiv dok se ne proveri PODRUTA.
say "6) Mobilna 1.0 (/m/*)"
MOBHOST="${MOBHOST:-https://servosync.servoteh.com}"
for mp in /m /m/montaza /m/odrzavanje; do
  BODY=$(curl -sS --max-time 12 -A "Mozilla/5.0 (Android)" "${MOBHOST}${mp}" 2>/dev/null || echo "")
  if printf '%s' "$BODY" | grep -q "Servosync V1.0"; then ok "$mp → 1.0 mobilna"
  elif printf '%s' "$BODY" | grep -qi "could not be found"; then bad "$mp → Next 404 (worker proxy ne hvata — run_worker_first u wrangler.jsonc?)"
  else bad "$mp → neočekivano (${BODY:0:40})"; fi
done

# 7) UPIS — DB privilegije app role (incident 27.07: setval bez UPDATE prava).
# Verify je do 27.07 proveravao samo ČITANJE (boot/login/strane) pa je rupa u
# privilegijama preživela vikend i oborila proizvodnju u ponedeljak ujutru.
# Ovde: (a) sve sekvence moraju imati USAGE+UPDATE (setval!), (b) sve tabele
# INSERT, (c) stvarni upis-put: 3-arg setval poravnanje POD APP ROLOM —
# idempotentno (poravna sekvencu na MAX(id), isto što app radi pre svakog
# INSERT-a), ne menja podatke.
say "7) Upis — DB privilegije app role"
DBCONTAINER="${DBCONTAINER:-servosync-pg}"
DBSUPER="${DBSUPER:-servosync}"   # superuser klastera (rola 'postgres' NE postoji!)
DBNAME="${DBNAME:-servosync}"
APPROLE="${APPROLE:-servosync_app}"
psqlq() { docker exec -i "$DBCONTAINER" psql -U "$DBSUPER" -d "$DBNAME" -At 2>/dev/null; }
if ! docker ps --filter "name=${DBCONTAINER}" --format '{{.Names}}' | grep -q "$DBCONTAINER"; then
  bad "DB kontejner $DBCONTAINER ne radi — upis-provere preskočene"
else
  SEQMISS=$(printf "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind='S' AND n.nspname='public' AND (NOT has_sequence_privilege('%s', c.oid, 'USAGE') OR NOT has_sequence_privilege('%s', c.oid, 'UPDATE'));" "$APPROLE" "$APPROLE" | psqlq)
  if [ "${SEQMISS:-x}" = "0" ]; then ok "sekvence: sve imaju USAGE+UPDATE za $APPROLE"
  else bad "sekvence BEZ USAGE/UPDATE za $APPROLE: ${SEQMISS:-provera pala} (setval pada sa 42501 → kiosk/TP/RN upisi mrtvi)"; fi
  TABMISS=$(printf "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind='r' AND n.nspname='public' AND NOT has_table_privilege('%s', c.oid, 'INSERT');" "$APPROLE" | psqlq)
  if [ "${TABMISS:-x}" = "0" ]; then ok "tabele: sve imaju INSERT za $APPROLE"
  else bad "tabele BEZ INSERT za $APPROLE: ${TABMISS:-provera pala}"; fi
  # psql -At štampa i komandne tagove (SET/RESET) — hvatamo isključivo t/f red.
  SVOK=$(printf "SET ROLE %s; SELECT setval(pg_get_serial_sequence('work_orders','id'), COALESCE((SELECT MAX(id) FROM work_orders),1), EXISTS(SELECT 1 FROM work_orders)) IS NOT NULL; RESET ROLE;" "$APPROLE" | psqlq | grep -m1 -E '^[tf]$')
  if [ "$SVOK" = "t" ]; then ok "stvarni upis-put: setval poravnanje pod $APPROLE prolazi"
  else bad "setval pod $APPROLE NE prolazi (42501? — vidi memory incident-sekvence-2026-07-27)"; fi
fi

say ""
if [ "$FAIL" = "0" ]; then
  say "🟢 DEPLOY OK — web + LAN + boot + upis svi zeleni."
else
  say "🔴 DEPLOY DEFEKTAN — NE javljati 'radi'. Vidi ❌ iznad. (docs: incident 21.07, memory incident-4.0-deploy-crash-lan)"
fi
exit "$FAIL"
