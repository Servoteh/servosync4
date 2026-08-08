#!/usr/bin/env bash
# Pravi PROBNU BAZU za dokazivanje `migrate-kadrovska-sy15.ts`.
#
# ⚠️ Pokreće se NA ubuntusrv-u (treba mu `docker exec` do `sy15-db` i do PG kontejnera).
#    Nad produkcijom radi SAMO `pg_dump` — čitanje. Ništa se u sy15 ne menja.
#
# 🔴 ZAŠTO SVOJ KONTEJNER, A NE `servosync-dev`: deljena dev instanca je 08.08.2026
# tokom ovog posla imala `kadr_sema_shadow_005` i „DROP TABLE _prisma_migrations" —
# druga grana je uporedo vrtela `prisma migrate`. Prenos je dva puta pao na
# „Can't reach database server" iako je TCP port bio otvoren, a SSH radio. Probna baza
# koja služi kao DOKAZ ne sme da deli sudbinu tuđeg `migrate reset`-a.
# Kontejner se pravi ovom skriptom (`kadr-probna-pg`, port 5439) i briše se posle:
#   ssh ubuntusrv "docker rm -f kadr-probna-pg"
#
# Napravi dve baze na `kadr-probna-pg` (port 5439):
#   kadr_probna_src — struktura + SVI PODACI 65 tabela kadrovske iz žive sy15
#                     (+ `auth.users` kao kopija, jer mapa identiteta čita nju)
#   kadr_probna_dst — SAMO struktura, plus:
#                       · `users` (kopija 3.0 `users` iz `servosync-pg`)
#                       · 6 `uuid` kolona naloga prevedeno u `integer` — onako kako
#                         će 3.0 i imati (`users.id` je Int, ne uuid)
#
# Zašto se struktura klonira iz sy15 a ne iz `prisma/schema.prisma`: Prisma modeli
# kadrovske u 3.0 još ne postoje (izmereno 08.08.2026), a oni su zaseban posao/grana.
# Skripta prenosa je zato vođena `information_schema` ODREDIŠTA — kad Prisma šema
# stigne, isti prenos radi bez izmene, samo se probna baza zameni pravom.
#
# Pokretanje:
#   ssh ubuntusrv "bash -s" < backend/scripts/prep-kadrovska-probna.sh
set -euo pipefail

TABLES="employees departments sub_departments job_positions company_profile profile_groups
profile_positions absences vacation_requests vacation_entitlements vacation_history
vacation_change_requests vacation_bonus_days vacation_go_days makeup_requests
paid_leave_requests nop_requests kadr_holidays attendance_events attendance_corrections
attendance_notify_extra work_hours work_hours_remarks employee_badges katze_employee_map
worker_employee_map salary_payroll salary_terms employee_bank_cards employee_children
employee_documents employee_personal_docs employee_foreign_docs contracts kadr_certificates
kadr_medical_exams kadr_document_ack employee_talks corrective_plans corrective_measures
development_plans development_checkins employee_expectations assessments assessment_raters
assessment_answers assessment_results assessment_scores assessment_targets assessment_cycles
competences competence_groups competence_levels competence_profiles competence_questions
kadr_onboarding_runs kadr_onboarding_tasks kadr_onboarding_templates
kadr_onboarding_template_items kadr_notification_config kadr_notification_log kadr_audit_log
kadr_grid_editor_allowlist kadr_salary_viewer_allowlist kadr_vacation_editor_allowlist"

ARGS=""
for t in $TABLES; do ARGS="$ARGS -t public.$t"; done

PG="docker exec kadr-probna-pg psql -U probna"
PGI="docker exec -i kadr-probna-pg psql -U probna"

echo "== 0. sopstveni PG kontejner za probnu bazu (port 5439) =="
if ! docker exec kadr-probna-pg pg_isready -U probna -q 2>/dev/null; then
  docker rm -f kadr-probna-pg >/dev/null 2>&1 || true
  docker run -d --name kadr-probna-pg --shm-size=256m -p 5439:5432 \
    -e POSTGRES_USER=probna -e POSTGRES_PASSWORD=probna_kadr_2026 \
    -e POSTGRES_DB=postgres postgres:18 >/dev/null
  for _ in $(seq 1 60); do
    docker exec kadr-probna-pg pg_isready -U probna -q 2>/dev/null && break
    sleep 1
  done
fi
$PG -d postgres -Atc "SELECT 'PG verzija: ' || current_setting('server_version')"

echo "== 1. prazne probne baze =="
for db in kadr_probna_src kadr_probna_dst; do
  $PG -d postgres -q -c "DROP DATABASE IF EXISTS $db"
  $PG -d postgres -q -c "CREATE DATABASE $db"
  # btree_gist je uslov za EXCLUDE ograničenja (`absences` bez preklapanja datuma).
  # Bez njega probna baza ostaje BEZ te brane, pa dokaz vredi manje.
  $PG -d "$db" -q -c "CREATE EXTENSION IF NOT EXISTS btree_gist"
done

echo "== 2. pg_dump iz sy15 po sekcijama (READ-ONLY nad produkcijom) =="
docker exec sy15-db pg_dump -U supabase_admin -d postgres --no-owner --no-privileges \
  --section=pre-data  $ARGS > /tmp/kadr_pre.sql
docker exec sy15-db pg_dump -U supabase_admin -d postgres --no-owner --no-privileges \
  --section=data      $ARGS > /tmp/kadr_data.sql
docker exec sy15-db pg_dump -U supabase_admin -d postgres --no-owner --no-privileges \
  --section=post-data $ARGS > /tmp/kadr_post.sql
ls -la /tmp/kadr_pre.sql /tmp/kadr_data.sql /tmp/kadr_post.sql

# post-data nosi i trigere, RLS politike i FK ka `auth.users` — u probnoj bazi toga
# nema (funkcije/šema auth se ne prenose), pa se ti blokovi izbacuju. Ključevi,
# unique indeksi i CHECK-ovi OSTAJU: oni su brana koja bi loš prenos oborila.
echo "== 3. filtriram post-data (trigeri / RLS / FK ka auth) =="
python3 - <<'PY'
import re
src = open('/tmp/kadr_post.sql', encoding='utf-8').read()
blocks = re.split(r'\n(?=(?:--|CREATE|ALTER|SET|COMMENT))', src)
keep, dropped = [], 0
for b in blocks:
    u = b.upper()
    if ('CREATE TRIGGER' in u or 'CREATE POLICY' in u
            or 'ROW LEVEL SECURITY' in u or 'REFERENCES AUTH.' in u):
        dropped += 1
        continue
    keep.append(b)
open('/tmp/kadr_post_clean.sql', 'w', encoding='utf-8').write('\n'.join(keep))
print('izbaceno blokova:', dropped, '/ ostalo:', len(keep))
PY

echo "== 4. kadr_probna_src: struktura + PODACI + ključevi =="
for f in /tmp/kadr_pre.sql /tmp/kadr_data.sql /tmp/kadr_post_clean.sql; do
  $PGI -d kadr_probna_src -q < "$f" 2>&1 \
    | grep -i "^ERROR" | head -5 || true
done

echo "== 5. kadr_probna_src: auth.users (mapa identiteta čita nju) =="
$PG -d kadr_probna_src -q -c \
  "CREATE SCHEMA IF NOT EXISTS auth;
   CREATE TABLE IF NOT EXISTS auth.users (id uuid PRIMARY KEY, email text);"
docker exec sy15-db psql -U supabase_admin -d postgres -Atc \
  "COPY (SELECT id, email FROM auth.users) TO STDOUT" \
  | $PGI -d kadr_probna_src -q -c \
    "TRUNCATE auth.users; COPY auth.users(id,email) FROM STDIN"

echo "== 6. kadr_probna_dst: SAMO struktura =="
for f in /tmp/kadr_pre.sql /tmp/kadr_post_clean.sql; do
  $PGI -d kadr_probna_dst -q < "$f" 2>&1 \
    | grep -i "^ERROR" | head -5 || true
done

echo "== 7. kadr_probna_dst: 3.0 users =="
$PG -d kadr_probna_dst -q -c \
  "CREATE TABLE IF NOT EXISTS users (
     id integer PRIMARY KEY,
     email varchar(255) NOT NULL UNIQUE,
     password_hash varchar(255) NOT NULL DEFAULT '',
     full_name varchar(150),
     role varchar(30) NOT NULL DEFAULT 'user',
     active boolean NOT NULL DEFAULT true,
     must_change_password boolean NOT NULL DEFAULT false,
     email_verified_at timestamp, last_login_at timestamp, worker_id integer,
     created_at timestamp NOT NULL DEFAULT now(),
     updated_at timestamp NOT NULL DEFAULT now());"
docker exec servosync-pg psql -U servosync -d servosync -Atc \
  "COPY (SELECT id, email, full_name, role, active FROM users) TO STDOUT" \
  | $PGI -d kadr_probna_dst -q -c \
    "TRUNCATE users; COPY users(id,email,full_name,role,active) FROM STDIN"

echo "== 8. kadr_probna_dst: 6 uuid kolona naloga -> integer (kako će 3.0 imati) =="
$PG -d kadr_probna_dst -q -c "
  ALTER TABLE absences           ALTER COLUMN archived_by   TYPE integer USING NULL;
  ALTER TABLE contracts          ALTER COLUMN archived_by   TYPE integer USING NULL;
  ALTER TABLE employee_documents ALTER COLUMN uploaded_by   TYPE integer USING NULL;
  ALTER TABLE kadr_certificates  ALTER COLUMN created_by    TYPE integer USING NULL;
  ALTER TABLE kadr_medical_exams ALTER COLUMN created_by    TYPE integer USING NULL;
  ALTER TABLE kadr_audit_log     ALTER COLUMN actor_user_id TYPE integer USING NULL;"

echo "== 9. kontrola =="
$PG -d kadr_probna_src -Atc \
  "SELECT 'src: tabela='||count(*) FROM information_schema.tables WHERE table_schema='public'"
$PG -d kadr_probna_src -Atc \
  "SELECT 'src: attendance_events='||count(*) FROM attendance_events"
$PG -d kadr_probna_dst -Atc \
  "SELECT 'dst: tabela='||count(*) FROM information_schema.tables WHERE table_schema='public'"
$PG -d kadr_probna_dst -Atc \
  "SELECT 'dst: attendance_events='||count(*) FROM attendance_events"
echo "gotovo."
