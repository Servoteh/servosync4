-- Preflight: prijava kvara kroz chat za SVA sredstva (03.08.2026)
-- Pokretanje: docker exec -i sy15-db psql -U supabase_admin -d postgres -f -

\echo '== 1. Postojece stanje: ai_chat_prijavi_kvar radi samo za masine =='
SELECT proname, pg_get_function_identity_arguments(oid) AS argumenti,
       prosecdef AS security_definer
  FROM pg_proc
 WHERE proname IN ('ai_chat_prijavi_kvar', 'ai_chat_maint_resolve', 'ai_chat_asset_resolve');

\echo '== 2. Incidenti po tipu sredstva (ocekivano: samo machine) =='
SELECT asset_type, count(*) FROM maint_incidents GROUP BY 1;

\echo '== 3. Sredstva koja ce novo razresenje moci da nadje (ocekivano: 88 machine + 43 vehicle) =='
SELECT asset_type, count(*) FILTER (WHERE archived_at IS NULL) AS aktivnih
  FROM maint_assets GROUP BY 1 ORDER BY 1;

\echo '== 4. machine_code je NOT NULL — za vozilo upisujemo asset_code (paritet FE pravila 24) =='
SELECT column_name, is_nullable
  FROM information_schema.columns
 WHERE table_name = 'maint_incidents' AND column_name IN ('machine_code', 'asset_id', 'asset_type');

\echo '== 5. Kontrolni uzorak: tablice koje moraju biti pronadjive =='
SELECT a.asset_code, a.name, vd.registration_plate
  FROM maint_assets a
  JOIN maint_vehicle_details vd ON vd.asset_id = a.asset_id
 WHERE a.archived_at IS NULL AND vd.registration_plate IS NOT NULL
 LIMIT 5;
