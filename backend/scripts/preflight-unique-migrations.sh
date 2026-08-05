#!/usr/bin/env bash
# ============================================================================
# PRED-POLETNA PROVERA ZA MIGRACIJE KOJE DODAJU UNIQUE INDEKS
# ============================================================================
#
# Pokrenuti SA SERVERA ili preko:  ssh ubuntusrv 'bash -s' < backend/scripts/preflight-unique-migrations.sh
#
# ZAŠTO POSTOJI
# `CREATE UNIQUE INDEX` nad tabelom koja VEĆ ima duplikate PADA — i time obara ceo deploy
# (`prisma migrate deploy` se zaustavi, kontejner ne krene). Migracije ispod su namerno
# napisane tako da padnu sa IMENOVANIM duplikatima umesto sa golim „could not create unique
# index", ali to je dijagnostika POSLE pada. Ovo je provera PRE.
#
# Pravilo iz kojeg je nastalo: izmeri PRODUKCIJU pre migracije koja dira bazu — dev baza je
# prazna šema i ne dokazuje ništa o produkcijskim podacima.
#
# Sve je READ-ONLY: samo `SELECT count(*)`. Ništa se ne menja.
#
# ISHOD
#   svi brojevi 0  → migracije mogu na deploy
#   bilo koji > 0  → NE deployuj; razreši duplikate (koji red je merodavan zna čovek koji
#                    vidi stanje na SEF portalu / u proizvodnji), pa ponovi ovu proveru.
# ============================================================================
set -u

DBCONTAINER="${DBCONTAINER:-servosync-pg}"
DBSUPER="${DBSUPER:-servosync}"   # superuser klastera (rola 'postgres' NE postoji)
DBNAME="${DBNAME:-servosync}"

q() { docker exec -i "$DBCONTAINER" psql -U "$DBSUPER" -d "$DBNAME" -At 2>/dev/null; }

if ! docker ps --filter "name=${DBCONTAINER}" --format '{{.Names}}' | grep -q "$DBCONTAINER"; then
  echo "✗ DB kontejner $DBCONTAINER ne radi — provera nije izvedena (NE deployuj na slepo)."
  exit 2
fi

fail=0

# ── 20260804140000_sef_outbox_jedan_zivi_red ────────────────────────────────
# Živi statusi (blokiraju nov red): PENDING/SENT/DELIVERED/CANCEL_PENDING.
sef=$(echo "SELECT count(*) FROM (SELECT 1 FROM sef_outbox WHERE status NOT IN ('CANCELLED','REJECTED') GROUP BY invoice_id HAVING count(*) > 1) d;" | q)
echo "uq_sef_outbox_live        — faktura sa >1 živim outbox redom: ${sef:-?}"
if [ "${sef:-1}" != "0" ]; then
  fail=1
  echo "  pregled:"
  echo "SELECT invoice_id, array_agg(id ORDER BY id), array_agg(status ORDER BY id) FROM sef_outbox WHERE status NOT IN ('CANCELLED','REJECTED') GROUP BY invoice_id HAVING count(*) > 1 LIMIT 20;" | q | sed 's/^/    /'
fi

# ── 20260804160000_tech_processes_jedan_otvoren_red ─────────────────────────
tp=$(echo "SELECT count(*) FROM (SELECT 1 FROM tech_processes WHERE is_process_finished IS NOT TRUE GROUP BY project_id, ident_number, variant, operation_number, work_center_code HAVING count(*) > 1) d;" | q)
echo "uq_tech_processes_open    — operacija sa >1 otvorenim redom:   ${tp:-?}"
if [ "${tp:-1}" != "0" ]; then
  fail=1
  echo "  pregled:"
  echo "SELECT project_id||' / '||ident_number||' / v'||variant||' / op'||operation_number||' / '||work_center_code||' -> '||count(*) FROM tech_processes WHERE is_process_finished IS NOT TRUE GROUP BY project_id, ident_number, variant, operation_number, work_center_code HAVING count(*) > 1 ORDER BY count(*) DESC LIMIT 20;" | q | sed 's/^/    /'
fi

echo
if [ "$fail" = "0" ]; then
  echo "✓ Nema duplikata — obe unique migracije mogu na deploy."
else
  echo "✗ Duplikati postoje — NE deployuj dok se ne razreše (migracija bi oborila deploy)."
  exit 1
fi
