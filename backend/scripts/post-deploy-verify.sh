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

# 🔴 SVEŽINA — da li ovo uopšte proverava NOVI kod?
#
# 08.08.2026: deploy je PAO (CI kapiju mu je oborio noviji merge koji ga je pretekao),
# stari kontejner je nastavio da služi saobraćaj, a ova skripta je prošla ZELENO na
# svih osam provera. Nijedna tvrdnja nije bila netačna — aplikacija JESTE radila — ali
# se nijedna nije odnosila na verziju koja je trebalo da ode. Bez ove provere
# „🟢 DEPLOY OK" znači samo „nešto radi", a to nije ono zbog čega se skripta pušta.
#
# Prag je namerno velik (30 min): skripta ide odmah posle deploy-a, a sam deploy ume da
# traje 15+ minuta. Stariji kontejner od toga NIJE dokaz kvara nego dokaz da ova provera
# ne meri ono što misliš — zato UPOZORENJE sa uputstvom, ne pad.
CREATED=$(docker inspect "$CONTAINER" --format '{{.Created}}' 2>/dev/null || echo "")
if [ -n "$CREATED" ]; then
  CREATED_TS=$(date -d "$CREATED" +%s 2>/dev/null || echo 0)
  AGE_MIN=$(( ( $(date +%s) - CREATED_TS ) / 60 ))
  if [ "$CREATED_TS" -gt 0 ] && [ "$AGE_MIN" -gt 30 ]; then
    printf '  ⚠️  %s\n' "kontejner je star ${AGE_MIN} min — ovo NIJE nova verzija. Proveri u GitHub Actions da li je deploy stvarno prošao, pa tek onda veruj ostatku ispisa."
  elif [ "$CREATED_TS" -gt 0 ]; then
    ok "svežina: kontejner napravljen pre ${AGE_MIN} min (nova verzija)"
  fi
fi

# 2) Nest boot uspešan (hvata dist/main.js / rootDir drift)
# Ceo log (ne --tail): boot poruka je na vrhu, a kontejner koji dugo radi ima
# hiljade runtime linija ispod. Ali crash-loop se vidi po ponovljenom modulu.
# ⚠️ NIKAD `grep -q` nad ovim logom: skripta radi pod `set -o pipefail`, a
# `grep -q` izlazi na PRVI pogodak → `docker logs` dobije SIGPIPE i vrati
# ne-nulu → pipefail celu cev proglasi palom BAŠ ZATO što je marker nađen.
# Lažni 🔴 je 04.08. tri puta prijavio zdrav deploy (svi endpointi zeleni).
# `grep -c` čita tok do kraja (nema SIGPIPE) i vraća 0 tek kad pogotka nema.
say "2) Nest boot"
CRASHCNT=$(docker logs "$CONTAINER" 2>&1 | grep -c "Cannot find module '/app/dist/main'" || true)
BOOTCNT=$(docker logs "$CONTAINER" 2>&1 | grep -c "Nest application successfully started" || true)
if [ "${CRASHCNT:-0}" -gt 0 ]; then
  bad "CRASH-LOOP: Cannot find module '/app/dist/main' (prisma/*.ts rootDir drift — vidi tsconfig.build.json exclude)"
elif [ "${BOOTCNT:-0}" -gt 0 ]; then
  ok "Nest application successfully started"
else
  bad "NEMA 'Nest successfully started' u logu — proveri boot (docker logs $CONTAINER)"
  docker logs "$CONTAINER" 2>&1 | tail -8 | sed 's/^/      /'
fi

# 3) WEB — javni gateway (login endpoint mora odgovoriti, 401 = živ do baze, 000/5xx = mrtav)
#
# ⚠️ Proba MORA biti ispravnog OBLIKA e-pošte (07.08.2026): od kada `/auth/login` ima pravi
# DTO (P12), telo `{"email":"_probe_"}` se odbija na `ValidationPipe`-u sa 400 — dakle PRE
# `AuthService` i pre ijednog dodira baze. Takva proba bi i dalje javljala „živ", a zapravo
# više ne bi dokazivala ništa osim da proces sluša. Sa ispravnim oblikom proba prolazi
# validaciju, stigne do `users` upita i vrati 401 „nepostojeći nalog" — to je dokaz da je
# CELA putanja prijave (ruta → guard → servis → baza) živa.
say "3) WEB pristup (gateway $GATEWAY)"
PROBE_BODY='{"email":"_probe_@servoteh.local","password":"_probe_"}'
WCODE=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$GATEWAY/api/auth/login" \
          -H 'Content-Type: application/json' -d "$PROBE_BODY" 2>/dev/null || echo 000)
case "$WCODE" in
  401)  ok "WEB login endpoint živ do baze (HTTP 401 za nepostojeći nalog)" ;;
  200)  ok "WEB login endpoint živ (HTTP 200 — probni nalog postoji?)" ;;
  400)  bad "WEB login vraća 400 na ISPRAVNO oblikovanu probu — validacija odbija telo pre servisa" ;;
  000)  bad "WEB login NEDOSTUPAN (gateway ne odgovara)" ;;
  *)    bad "WEB login neočekivan HTTP $WCODE" ;;
esac

# 4) LAN — same-origin :3000 mora servirati /login (NE 404 = API-only otkaz)
say "4) LAN pristup (http://$LAN_IP:$PORT)"
for path in / /login /index.html; do
  LCODE=$(curl -sS -o /dev/null -w '%{http_code}' "http://${LAN_IP}:${PORT}${path}" 2>/dev/null || echo 000)
  if [ "$LCODE" = "200" ]; then ok "LAN $path → 200"
  else bad "LAN $path → $LCODE (očekivano 200; 404 = frontend NIJE baked → LAN/offline login mrtav)"; fi
done
# LAN auth API isto mora biti živ (ista proba ispravnog oblika — vidi obrazloženje u tački 3)
ACODE=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "http://${LAN_IP}:${PORT}/api/auth/login" \
          -H 'Content-Type: application/json' -d "$PROBE_BODY" 2>/dev/null || echo 000)
case "$ACODE" in
  401|200) ok "LAN auth API živ do baze (HTTP $ACODE)" ;;
  400)     bad "LAN auth API vraća 400 na ISPRAVNO oblikovanu probu — telo pada na validaciji" ;;
  *)       bad "LAN auth API HTTP $ACODE" ;;
esac

# 5) Frontend baked u kontejneru (potvrda za tačku 4)
say "5) Frontend baked"
FECOUNT=$(docker exec "$CONTAINER" sh -c 'ls /app/frontend-static/ 2>/dev/null | grep -v "^\.gitkeep$" | wc -l' 2>/dev/null || echo 0)
if [ "${FECOUNT:-0}" -gt 1 ]; then ok "frontend-static ima $FECOUNT fajlova (login.html uklj.)"
else bad "frontend-static PRAZAN ($FECOUNT) → deploy je pao na API-only (static export fail?)"; fi

# 6) MOBILNA (/m/*) — rute moraju biti ŽIVE.
# Incident 21.07: /m/<modul> je vraćao Next 404 (run_worker_first falio). Golo /m
# je radilo pa je otkaz bio nevidljiv dok se ne proveri PODRUTA.
# Od gašenja 1.0 (PR #95, feat/cutover-1.0-gasenje) /m više ne servira staru
# aplikaciju nego vodi na 3.0 /mob; postoji i prekidač za povratak na 1.0. Zato
# se prihvataju OBA ispravna stanja i ispisuje se koje je zatečeno — pada samo
# kad ruta stvarno crkne (Next 404 ili prazno), a to je scenario zbog kog je
# provera i uvedena (ceo pogon bez mobilne).
say "6) Mobilna (/m/*)"
MOBHOST="${MOBHOST:-https://servosync.servoteh.com}"
for mp in /m /m/montaza /m/odrzavanje; do
  BODY=$(curl -sS --max-time 12 -A "Mozilla/5.0 (Android)" "${MOBHOST}${mp}" 2>/dev/null || echo "")
  if printf '%s' "$BODY" | grep -q "Servosync V1.0"; then ok "$mp → 1.0 mobilna (prekidač vraćen na staro)"
  elif printf '%s' "$BODY" | grep -qi "could not be found"; then bad "$mp → Next 404 (worker proxy ne hvata — run_worker_first u wrangler.jsonc?)"
  elif printf '%s' "$BODY" | grep -q "_next"; then ok "$mp → 3.0 (/mob, posle gašenja 1.0)"
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

########################################################################
# 8) Vremenska zona — mora biti UTC na SVA TRI mesta
#
# Zašto brana: 121 kolona u 48 tabela je `timestamp WITHOUT time zone`
# (nasleđe BigBit uvoza). One nemaju zonu u sebi, pa im značenje daje TZ
# procesa koji ih čita i piše. Danas je sve UTC — host, baza i backend —
# pa `pg` te vrednosti tumači kao UTC, API ih šalje sa `Z`, a pregledač
# ih prikaže u beogradskom vremenu. Ispravno, ali PO DOGOVORU, ne po tipu.
#
# Ako iko postavi TZ=Europe/Belgrade na backend kontejneru, tih 121 kolona
# se pomeri za 2 sata — i u čitanju i u UPISU, tiho i unazad nepopravljivo
# (nema traga koja vrednost je zapisana pod kojom zonom). Zato se meri.
########################################################################
say ""
say "8) Vremenska zona (UTC na sva tri mesta)"
TZ_HOST=$(date +%Z 2>/dev/null || echo "?")
TZ_DB=$(printf "SHOW timezone;" | psqlq | head -1 | tr -d ' ')
TZ_API=$(docker exec "$CONTAINER" node -e 'process.stdout.write(String(new Date().getTimezoneOffset()))' 2>/dev/null || echo "?")
if [ "$TZ_HOST" = "UTC" ]; then ok "host: UTC"; else bad "host NIJE UTC (=$TZ_HOST)"; fi
case "$TZ_DB" in
  Etc/UTC|UTC) ok "baza: $TZ_DB" ;;
  *) bad "baza NIJE UTC (=$TZ_DB) — 121 kolona bez zone menja značenje" ;;
esac
if [ "$TZ_API" = "0" ]; then ok "backend kontejner: UTC (offset 0)"
else bad "backend kontejner NIJE UTC (offset=$TZ_API min) — kolone bez zone se pomeraju u UPISU"; fi

say ""
if [ "$FAIL" = "0" ]; then
  say "🟢 DEPLOY OK — web + LAN + boot + upis + TZ svi zeleni."
else
  say "🔴 DEPLOY DEFEKTAN — NE javljati 'radi'. Vidi ❌ iznad. (docs: incident 21.07, memory incident-4.0-deploy-crash-lan)"
fi
exit "$FAIL"
