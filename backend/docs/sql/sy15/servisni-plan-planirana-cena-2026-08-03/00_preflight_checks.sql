-- Preflight: servisni plan — planirana cena servisa (03.08.2026)
-- Pokreni PRE 10_add_planned_cost.sql i uporedi izlaz sa očekivanjem u komentarima.
-- Pokretanje: docker exec -i sy15-db psql -U supabase_admin -d postgres -f -

\echo '== 1. Kolona planned_cost jos NE postoji (ocekivano: 0 redova) =='
SELECT table_name, column_name
FROM information_schema.columns
WHERE table_name IN ('maint_vehicle_service_plan', 'maint_asset_service_plan')
  AND column_name = 'planned_cost';

\echo '== 2. Oba view-a moraju imati security_invoker=true (ocekivano: 2 reda, {security_invoker=true}) =='
SELECT c.relname, c.reloptions
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('v_maint_vehicle_service_plan_due', 'v_maint_asset_service_plan_due');

\echo '== 3. Broj plan stavki pre izmene (kontrolni broj — mora biti isti posle) =='
SELECT 'vehicle' AS tip, count(*) FROM maint_vehicle_service_plan
UNION ALL
SELECT 'asset', count(*) FROM maint_asset_service_plan;

\echo '== 4. Redosled kolona view-a (CREATE OR REPLACE sme SAMO da dopisuje na kraj) =='
SELECT table_name, ordinal_position, column_name
FROM information_schema.columns
WHERE table_name IN ('v_maint_vehicle_service_plan_due', 'v_maint_asset_service_plan_due')
ORDER BY table_name, ordinal_position;
