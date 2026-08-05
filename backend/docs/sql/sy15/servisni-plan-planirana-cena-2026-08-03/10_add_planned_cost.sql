-- Servisni plan: planirana cena servisa (03.08.2026)
--
-- ZAŠTO: plan stavka je do sada znala SAMO kad servis dospeva (interval mes/km), ne i
-- koliko košta. Bez toga se trošak vozila vidi tek pošto servis prođe. `planned_cost` je
-- očekivana cena te stavke; backend je pri „Generiši WO" prepisuje u
-- `maint_work_orders.estimated_cost`, pa se plan i realizacija porede u istoj valuti.
--
-- ADITIVNO: kolona je nullable bez defaulta, view-ovi dobijaju kolonu NA KRAJ (uslov za
-- CREATE OR REPLACE VIEW). Postojeći redovi i upiti se ne diraju.
--
-- 🔴 security_invoker=true se MORA ponoviti u CREATE OR REPLACE — bez toga view pada na
-- vlasnika (supabase_admin) i zaobilazi RLS (regresija iz sanacije 31.07.2026).
--
-- Pokretanje: docker exec -i sy15-db psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -f -

BEGIN;

ALTER TABLE public.maint_vehicle_service_plan
  ADD COLUMN IF NOT EXISTS planned_cost numeric(10, 2);
COMMENT ON COLUMN public.maint_vehicle_service_plan.planned_cost
  IS 'Očekivana cena servisa (RSD). Prepisuje se u maint_work_orders.estimated_cost pri auto-generisanju naloga.';

ALTER TABLE public.maint_asset_service_plan
  ADD COLUMN IF NOT EXISTS planned_cost numeric(10, 2);
COMMENT ON COLUMN public.maint_asset_service_plan.planned_cost
  IS 'Očekivana cena servisa (RSD). Prepisuje se u maint_work_orders.estimated_cost pri auto-generisanju naloga.';

-- ── v_maint_vehicle_service_plan_due — identična definicija + planned_cost na kraju ──
CREATE OR REPLACE VIEW public.v_maint_vehicle_service_plan_due
WITH (security_invoker = true) AS
SELECT p.plan_id,
    p.asset_id,
    p.name,
    p.vehicle_service_category,
    p.interval_km,
    p.interval_months,
    p.last_done_at,
    p.last_done_km,
    p.notes,
    p.priority,
    p.active,
    p.created_at,
    p.updated_at,
    vd.odometer_km AS current_odometer_km,
        CASE
            WHEN p.interval_months IS NULL THEN NULL::date
            WHEN p.last_done_at IS NULL THEN CURRENT_DATE
            ELSE (p.last_done_at + ((p.interval_months || ' months'::text)::interval))::date
        END AS next_due_at,
        CASE
            WHEN p.interval_km IS NULL THEN NULL::integer
            WHEN p.last_done_km IS NULL THEN NULL::integer
            ELSE p.last_done_km + p.interval_km
        END AS next_due_km,
        CASE
            WHEN p.interval_months IS NULL THEN NULL::integer
            ELSE
            CASE
                WHEN p.last_done_at IS NULL THEN 0
                ELSE (p.last_done_at + ((p.interval_months || ' months'::text)::interval))::date - CURRENT_DATE
            END
        END AS days_to_due,
        CASE
            WHEN p.interval_km IS NULL OR p.last_done_km IS NULL OR vd.odometer_km IS NULL THEN NULL::integer
            ELSE p.last_done_km + p.interval_km - vd.odometer_km
        END AS km_to_due,
        CASE
            WHEN p.active = false THEN 'inactive'::text
            WHEN p.interval_months IS NOT NULL AND (p.last_done_at IS NULL OR (p.last_done_at + ((p.interval_months || ' months'::text)::interval))::date < CURRENT_DATE) OR p.interval_km IS NOT NULL AND p.last_done_km IS NOT NULL AND vd.odometer_km IS NOT NULL AND (p.last_done_km + p.interval_km) < vd.odometer_km THEN 'overdue'::text
            WHEN p.interval_months IS NOT NULL AND p.last_done_at IS NOT NULL AND (p.last_done_at + ((p.interval_months || ' months'::text)::interval))::date <= (CURRENT_DATE + '30 days'::interval) OR p.interval_km IS NOT NULL AND p.last_done_km IS NOT NULL AND vd.odometer_km IS NOT NULL AND (p.last_done_km + p.interval_km) <= (vd.odometer_km + 1000) THEN 'due_soon'::text
            ELSE 'ok'::text
        END AS due_status,
    (EXISTS ( SELECT 1
           FROM maint_work_orders wo
          WHERE wo.service_plan_id = p.plan_id AND (wo.status <> ALL (ARRAY['zavrsen'::maint_wo_status, 'otkazan'::maint_wo_status])))) AS has_open_wo,
    ( SELECT wo.wo_id
           FROM maint_work_orders wo
          WHERE wo.service_plan_id = p.plan_id AND (wo.status <> ALL (ARRAY['zavrsen'::maint_wo_status, 'otkazan'::maint_wo_status]))
          ORDER BY wo.created_at DESC
         LIMIT 1) AS open_wo_id,
    p.planned_cost
   FROM maint_vehicle_service_plan p
     LEFT JOIN maint_vehicle_details vd ON vd.asset_id = p.asset_id;

-- ── v_maint_asset_service_plan_due — identična definicija + planned_cost na kraju ──
CREATE OR REPLACE VIEW public.v_maint_asset_service_plan_due
WITH (security_invoker = true) AS
SELECT p.plan_id,
    p.asset_id,
    a.asset_code,
    a.asset_type,
    a.name AS asset_name,
    p.name,
    p.interval_months,
    p.last_done_at,
    p.notes,
    p.priority,
    p.active,
    (p.last_done_at + ((p.interval_months || ' months'::text)::interval))::date AS next_due_at,
        CASE
            WHEN NOT p.active THEN 'inactive'::text
            WHEN p.last_done_at IS NULL THEN 'due_soon'::text
            WHEN (p.last_done_at + ((p.interval_months || ' months'::text)::interval))::date < CURRENT_DATE THEN 'overdue'::text
            WHEN (p.last_done_at + ((p.interval_months || ' months'::text)::interval))::date <= (CURRENT_DATE + '30 days'::interval) THEN 'due_soon'::text
            ELSE 'ok'::text
        END AS due_status,
    (EXISTS ( SELECT 1
           FROM maint_work_orders wo
          WHERE wo.asset_service_plan_id = p.plan_id AND (wo.status <> ALL (ARRAY['zavrsen'::maint_wo_status, 'otkazan'::maint_wo_status])))) AS has_open_wo,
    ( SELECT wo.wo_id
           FROM maint_work_orders wo
          WHERE wo.asset_service_plan_id = p.plan_id AND (wo.status <> ALL (ARRAY['zavrsen'::maint_wo_status, 'otkazan'::maint_wo_status]))
          ORDER BY wo.created_at DESC
         LIMIT 1) AS open_wo_id,
    p.planned_cost
   FROM maint_asset_service_plan p
     JOIN maint_assets a ON a.asset_id = p.asset_id;

COMMIT;

-- Provera posle primene: obe kolone postoje, oba view-a i dalje security_invoker=true.
SELECT table_name, column_name, data_type
FROM information_schema.columns
WHERE column_name = 'planned_cost'
ORDER BY table_name;

SELECT c.relname, c.reloptions
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('v_maint_vehicle_service_plan_due', 'v_maint_asset_service_plan_due');
