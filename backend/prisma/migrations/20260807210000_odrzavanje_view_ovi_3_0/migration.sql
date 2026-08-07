-- Seoba sy15 -> 3.0, KORAK 2b: VIEW-ovi domena ODRŽAVANJA (CMMS).
-- Runbook: docs/SEOBA_ODRZAVANJA_2026-08-06.md (§7, blokada 4).
--
-- ZAŠTO RUČNO PISANA MIGRACIJA: `prisma migrate diff` ne vidi view-ove (Prisma ih
-- ne modeluje) — isti obrazac kao `20260806090000_sastanci_view_ovi_3_0`.
--
-- Definicije su PREPISANE DOSLOVNO sa ŽIVE sy15 (`pg_get_viewdef`, 06.08.2026).
-- Jedina sistematska izmena koju traži seoba: 23 PG enuma su u 3.0 String + CHECK
-- (BACKEND_RULES §2.2), pa svi `::maint_*` castovi otpadaju. Skup vrednosti je
-- nepromenjen. Kolone naloga (`responsible_user_id`, `archived_by`, `created_by`,
-- `uploaded_by`, `auth_user_id`, `assigned_to`, `reported_by`) su u 3.0 INTEGER
-- umesto uuid, ali se u view-ovima samo PROSLEĐUJU — telo se zbog toga ne menja.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- 🔴 SVIH 16 `v_maint_*` VIEW-OVA JE U sy15 `security_invoker = true`
-- ══════════════════════════════════════════════════════════════════════════════
-- Izmereno (`pg_class.reloptions`), ne pretpostavljeno. To znači da se RLS
-- POZIVAOCA primenjivao I KROZ VIEW: `v_maint_vehicle_overview` je operateru
-- vraćao nula vozila, ne sva. U 3.0 RLS-a nema (ODLUKE.md), pa view vraća SVE
-- redove i **scope MORA eksplicitno u upit koji view čita**.
--
-- Parnjaci su u `OdrzavanjeAuthzService`:
--   machineScopeSql()          -> `machine_code` (current_status, task_due_dates,
--                                  machine_last_check)
--   nonMachineViewScopeSql()   -> vozila / IT / objekti / rezervacije / planovi
--                                  (nema per-red scope: „sva ili nijedno")
--   driversViewScopeSql()      -> drivers_overview (+ per-red „ja sam taj vozač")
--   partsViewScopeSql()        -> parts_with_vehicles, vehicle_parts
--   canReadFullSummary()       -> cmms_daily_summary (v. napomenu uz taj view)
--
-- Ovo je najtiši način da prava nestanu: upit i dalje radi, samo vraća VIŠE
-- redova nego što sme. Zato je uz svaki view ispod imenovan njegov scope.
--
-- ⚠️ `security_invoker` se ovde NE postavlja: u 3.0 nema RLS-a koji bi taj
-- prekidač uopšte imao šta da primeni, pa bi bio prazno obećanje.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- 🔴 `v_maint_machines_importable` SE NAMERNO NE PRAVI
-- ══════════════════════════════════════════════════════════════════════════════
-- Taj view čita `public.bigtehn_machines_cache` (90 redova) — tabelu koja NIJE
-- `maint_*` i koju 3.0 baza NEMA (blokada 9 runbook-a: stiže sa svojim domenom).
-- Da je napravimo praznu, „Uvoz iz kataloga" bi pod `3.0` tiho nudio nula mašina.
-- Zato ta putanja pod `3.0` GLASNO pada (`OdrzavanjeFnService.importFromCacheNijePreneto`).
--
-- Isto važi za `v_rev_machines` (Reversi, korak 3): pod `3.0` se mašine čitaju
-- Prisma putem iz 3.0 `maint_machines`, bez view-a — v. `reversi.service.ts`.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. `v_maint_machine_last_check` — poslednja kontrola po (zadatak, mašina).
--    Tranzitivna zavisnost: čita je `v_maint_task_due_dates`, a nju
--    `v_maint_machine_current_status` i `v_maint_cmms_daily_summary`.
--    SCOPE: `machineScopeSql()`.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW "v_maint_machine_last_check" AS
SELECT DISTINCT ON (task_id, machine_code)
    task_id,
    machine_code,
    performed_at,
    result
  FROM maint_checks
 ORDER BY task_id, machine_code, performed_at DESC;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. `v_maint_task_due_dates` — kad preventivni zadatak sledeći put dospeva.
--    ⚠️ `COALESCE(..., now())`: zadatak koji NIKAD nije izvršen dospeva ODMAH.
--    SCOPE: `machineScopeSql()`.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW "v_maint_task_due_dates" AS
SELECT t.id AS task_id,
    t.machine_code,
    t.title,
    t.severity,
    t.interval_value,
    t.interval_unit,
    t.grace_period_days,
    COALESCE(lc.performed_at +
        CASE t.interval_unit
            WHEN 'hours' THEN (t.interval_value::text || ' hours')::interval
            WHEN 'days' THEN (t.interval_value::text || ' days')::interval
            WHEN 'weeks' THEN (((t.interval_value * 7)::text) || ' days')::interval
            WHEN 'months' THEN (t.interval_value::text || ' months')::interval
            ELSE NULL::interval
        END, now()) AS next_due_at,
    lc.performed_at AS last_performed_at
   FROM maint_tasks t
     LEFT JOIN v_maint_machine_last_check lc
            ON lc.task_id = t.id AND lc.machine_code = t.machine_code
  WHERE t.active = true;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. `v_maint_machine_current_status` — operativni status mašine.
--    Prikazuje SAMO aktivne praćene mašine; ručni `override` gazi izvedeni status.
--    SCOPE: `machineScopeSql()`.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW "v_maint_machine_current_status" AS
SELECT m.machine_code,
    COALESCE(mso.status,
        CASE
            WHEN (EXISTS ( SELECT 1
               FROM maint_incidents i
              WHERE i.machine_code = m.machine_code
                AND (i.status <> ALL (ARRAY['resolved', 'closed']))
                AND i.severity = 'critical')) THEN 'down'
            WHEN (EXISTS ( SELECT 1
               FROM maint_incidents i
              WHERE i.machine_code = m.machine_code
                AND (i.status <> ALL (ARRAY['resolved', 'closed']))
                AND i.severity = 'major')) THEN 'degraded'
            WHEN (EXISTS ( SELECT 1
               FROM v_maint_task_due_dates d
              WHERE d.machine_code = m.machine_code
                AND d.severity = 'critical'
                AND d.next_due_at < (now() - ((d.grace_period_days::text || ' days')::interval)))) THEN 'degraded'
            WHEN (EXISTS ( SELECT 1
               FROM v_maint_task_due_dates d
              WHERE d.machine_code = m.machine_code
                AND d.next_due_at < now())) THEN 'degraded'
            ELSE 'running'
        END) AS status,
    ( SELECT count(*)::integer
           FROM maint_incidents i
          WHERE i.machine_code = m.machine_code
            AND (i.status <> ALL (ARRAY['resolved', 'closed']))) AS open_incidents_count,
    ( SELECT count(*)::integer
           FROM v_maint_task_due_dates d
          WHERE d.machine_code = m.machine_code AND d.next_due_at < now()) AS overdue_checks_count,
    mso.reason AS override_reason,
    mso.valid_until AS override_valid_until
   FROM maint_machines m
     LEFT JOIN maint_machine_status_override mso
            ON mso.machine_code = m.machine_code
           AND (mso.valid_until IS NULL OR mso.valid_until > now())
  WHERE m.archived_at IS NULL AND m.tracked = true;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. `v_maint_machines_with_responsible` — mašina + ime odgovornog.
--    SCOPE: `machineScopeSql()`.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW "v_maint_machines_with_responsible" AS
SELECT m.machine_code,
    m.name,
    m.type,
    m.manufacturer,
    m.model,
    m.location,
    m.archived_at,
    m.tracked,
    m.responsible_user_id,
    p.full_name AS responsible_full_name,
    p.role AS responsible_role
   FROM maint_machines m
     LEFT JOIN maint_user_profiles p ON p.user_id = m.responsible_user_id;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. `v_maint_documents_with_status` — dokumenta + status važenja.
--    ⚠️ `WHERE deleted_at IS NULL` je DEO view-a (soft-delete), ne upita.
--    SCOPE: `documentListWhere()` (kaskada po popunjenom FK-u).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW "v_maint_documents_with_status" AS
SELECT document_id,
    entity_type,
    entity_id,
    asset_id,
    wo_id,
    incident_id,
    preventive_task_id,
    file_name,
    storage_path,
    mime_type,
    size_bytes,
    category,
    description,
    uploaded_at,
    uploaded_by,
    deleted_at,
    valid_until,
    driver_id,
        CASE
            WHEN valid_until IS NULL THEN 'unknown'
            WHEN valid_until < CURRENT_DATE THEN 'expired'
            WHEN valid_until <= (CURRENT_DATE + '30 days'::interval) THEN 'due_soon'
            ELSE 'ok'
        END AS validity_status,
        CASE
            WHEN valid_until IS NULL THEN NULL::integer
            ELSE valid_until - CURRENT_DATE
        END AS days_to_expiry
   FROM maint_documents d
  WHERE deleted_at IS NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. `v_maint_drivers_overview` — vozači + statusi dokumenata.
--    SCOPE: `driversViewScopeSql()` — bool deo ∨ per-red `auth_user_id = ja`.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW "v_maint_drivers_overview" AS
SELECT driver_id,
    full_name,
    is_internal,
    auth_user_id,
    drivers_license_number,
    drivers_license_categories,
    drivers_license_valid_until,
    id_card_number,
    id_card_valid_until,
    medical_check_valid_until,
    phone,
    jmbg,
    address,
    notes,
    active,
    archived_at,
    archive_reason,
    created_at,
    updated_at,
        CASE
            WHEN drivers_license_valid_until IS NULL THEN 'unknown'
            WHEN drivers_license_valid_until < CURRENT_DATE THEN 'expired'
            WHEN drivers_license_valid_until <= (CURRENT_DATE + '30 days'::interval) THEN 'due_soon'
            ELSE 'ok'
        END AS license_status,
        CASE
            WHEN medical_check_valid_until IS NULL THEN 'unknown'
            WHEN medical_check_valid_until < CURRENT_DATE THEN 'expired'
            WHEN medical_check_valid_until <= (CURRENT_DATE + '30 days'::interval) THEN 'due_soon'
            ELSE 'ok'
        END AS medical_status,
        CASE
            WHEN id_card_valid_until IS NULL THEN 'unknown'
            WHEN id_card_valid_until < CURRENT_DATE THEN 'expired'
            WHEN id_card_valid_until <= (CURRENT_DATE + '30 days'::interval) THEN 'due_soon'
            ELSE 'ok'
        END AS id_card_status,
    ( SELECT count(*)::integer
           FROM maint_vehicle_details vd
          WHERE vd.primary_driver_id = d.driver_id) AS vehicle_count
   FROM maint_drivers d;

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. `v_maint_vehicle_overview` — najveći view domena (vozilo + detalji +
--    vlasnik + vozač + gume + nalozi + trošak).
--    SCOPE: `nonMachineViewScopeSql()`.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW "v_maint_vehicle_overview" AS
SELECT a.asset_id,
    a.asset_code,
    a.name,
    a.status,
    a.manufacturer,
    a.model,
    a.archived_at,
    a.responsible_user_id,
    vd.registration_plate,
    vd.vin,
    vd.year_of_manufacture,
    vd.vehicle_kind,
    vd.payload_kg,
    vd.passenger_seats,
    vd.fuel_type,
    vd.usage_type,
    vd.gps_provider,
    vd.gps_device_id,
    vd.first_aid_kit_expires_at,
    vd.is_private_vehicle,
    vd.registration_expires_at,
    vd.insurance_expires_at,
    vd.service_due_at,
    vd.service_interval_km,
    vd.next_service_mileage_km,
    vd.odometer_km,
        CASE
            WHEN vd.next_service_mileage_km IS NULL OR vd.odometer_km IS NULL THEN NULL::integer
            ELSE vd.next_service_mileage_km - vd.odometer_km
        END AS km_to_service,
        CASE
            WHEN vd.registration_expires_at IS NULL THEN 'unknown'
            WHEN vd.registration_expires_at < CURRENT_DATE THEN 'expired'
            WHEN vd.registration_expires_at <= (CURRENT_DATE + '30 days'::interval) THEN 'due_soon'
            ELSE 'ok'
        END AS registration_status,
        CASE
            WHEN vd.first_aid_kit_expires_at IS NULL THEN 'unknown'
            WHEN vd.first_aid_kit_expires_at < CURRENT_DATE THEN 'expired'
            WHEN vd.first_aid_kit_expires_at <= (CURRENT_DATE + '30 days'::interval) THEN 'due_soon'
            ELSE 'ok'
        END AS first_aid_status,
    vd.owner_id,
    o.name AS owner_name,
    o.owner_type,
    ( SELECT COALESCE(sum(t.count), 0::bigint)::integer
           FROM maint_vehicle_tires t
          WHERE t.asset_id = a.asset_id AND t.season = 'summer') AS tire_summer_count,
    ( SELECT COALESCE(sum(t.count), 0::bigint)::integer
           FROM maint_vehicle_tires t
          WHERE t.asset_id = a.asset_id AND t.season = 'winter') AS tire_winter_count,
    ( SELECT count(*)::integer
           FROM maint_work_orders wo
          WHERE wo.asset_id = a.asset_id
            AND (wo.status = ANY (ARRAY['novi', 'dodeljen', 'u_radu']))) AS open_wo_count,
    ( SELECT max(wo.completed_at)
           FROM maint_work_orders wo
          WHERE wo.asset_id = a.asset_id AND wo.status = 'zavrsen') AS last_service_at,
    ( SELECT wo.odometer_km_at_service
           FROM maint_work_orders wo
          WHERE wo.asset_id = a.asset_id AND wo.status = 'zavrsen'
          ORDER BY wo.completed_at DESC NULLS LAST
         LIMIT 1) AS last_service_km,
    ( SELECT COALESCE(sum(wo.cost_total), 0::numeric)::numeric(12,2)
           FROM maint_work_orders wo
          WHERE wo.asset_id = a.asset_id AND wo.status = 'zavrsen') AS total_service_cost,
    a.archive_reason,
    a.archived_by,
    vd.primary_driver_id,
    drv.full_name AS driver_full_name,
    drv.is_internal AS driver_is_internal,
    drv.drivers_license_valid_until AS driver_license_valid_until,
    vd.parts_shelf,
    vd.has_parts_set,
    vd.parts_notes,
    vd.primary_photo_storage_path
   FROM maint_assets a
     JOIN maint_vehicle_details vd ON vd.asset_id = a.asset_id
     LEFT JOIN maint_vehicle_owners o ON o.owner_id = vd.owner_id
     LEFT JOIN maint_drivers drv ON drv.driver_id = vd.primary_driver_id
  WHERE a.asset_type = 'vehicle';

-- ─────────────────────────────────────────────────────────────────────────────
-- 8. `v_maint_it_overview` — IT oprema + licenca/garancija/backup status.
--    Čita ga i `maint_check_it_facility_deadlines` (posao `maint-deadlines`).
--    SCOPE: `nonMachineViewScopeSql()`.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW "v_maint_it_overview" AS
SELECT a.asset_id,
    a.asset_code,
    a.name,
    a.status,
    a.manufacturer,
    a.model,
    a.serial_number,
    a.supplier,
    a.notes,
    a.location_id,
    a.responsible_user_id,
    a.archived_at,
    a.archive_reason,
    a.warranty_until,
    a.qr_token,
    d.device_type,
    d.hostname,
    d.ip_address,
    d.mac_address,
    d.operating_system,
    d.assigned_to,
    d.license_key,
    d.license_expires_at,
    d.warranty_expires_at,
    d.backup_required,
    d.last_backup_at,
    d.notes AS it_notes,
        CASE
            WHEN d.license_expires_at IS NULL THEN 'unknown'
            WHEN d.license_expires_at < CURRENT_DATE THEN 'expired'
            WHEN d.license_expires_at <= (CURRENT_DATE + '30 days'::interval) THEN 'due_soon'
            ELSE 'ok'
        END AS license_status,
        CASE
            WHEN COALESCE(d.warranty_expires_at, a.warranty_until) IS NULL THEN 'unknown'
            WHEN COALESCE(d.warranty_expires_at, a.warranty_until) < CURRENT_DATE THEN 'expired'
            WHEN COALESCE(d.warranty_expires_at, a.warranty_until) <= (CURRENT_DATE + '30 days'::interval) THEN 'due_soon'
            ELSE 'ok'
        END AS warranty_status,
        CASE
            WHEN NOT COALESCE(d.backup_required, false) THEN 'not_required'
            WHEN d.last_backup_at IS NULL THEN 'missing'
            WHEN d.last_backup_at < (now() - '7 days'::interval) THEN 'stale'
            ELSE 'ok'
        END AS backup_status,
    ( SELECT count(*)::integer
           FROM maint_work_orders wo
          WHERE wo.asset_id = a.asset_id
            AND (wo.status = ANY (ARRAY['novi', 'dodeljen', 'u_radu']))) AS open_wo_count,
    d.cpu,
    d.motherboard,
    d.ram,
    d.gpu,
    d.office_location,
    d.toner_cartridges,
    d.unifi_ports,
    d.power_rating,
    d.firmware_version
   FROM maint_assets a
     LEFT JOIN maint_it_asset_details d ON d.asset_id = a.asset_id
  WHERE a.asset_type = 'it';

-- ─────────────────────────────────────────────────────────────────────────────
-- 9. `v_maint_facility_overview` — objekti + inspekcija/PP rok.
--    🔴 Kolonu `cadastral_parcels` NE nabraja ni sy15 view — 3.0 ga prati
--    doslovno (parcele se čitaju sa `maint_facility_details`, ne odavde).
--    SCOPE: `nonMachineViewScopeSql()`.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW "v_maint_facility_overview" AS
SELECT a.asset_id,
    a.asset_code,
    a.name,
    a.status,
    a.manufacturer,
    a.model,
    a.serial_number,
    a.supplier,
    a.notes,
    a.location_id,
    a.responsible_user_id,
    a.archived_at,
    a.archive_reason,
    a.qr_token,
    d.facility_type,
    d.floor_area_m2,
    d.floor_or_zone,
    d.criticality,
    d.inspection_due_at,
    d.fire_safety_due_at,
    d.service_contract,
    d.service_provider,
    d.last_inspection_at,
    d.notes AS facility_notes,
        CASE
            WHEN d.inspection_due_at IS NULL THEN 'unknown'
            WHEN d.inspection_due_at < CURRENT_DATE THEN 'expired'
            WHEN d.inspection_due_at <= (CURRENT_DATE + '30 days'::interval) THEN 'due_soon'
            ELSE 'ok'
        END AS inspection_status,
        CASE
            WHEN d.fire_safety_due_at IS NULL THEN 'unknown'
            WHEN d.fire_safety_due_at < CURRENT_DATE THEN 'expired'
            WHEN d.fire_safety_due_at <= (CURRENT_DATE + '30 days'::interval) THEN 'due_soon'
            ELSE 'ok'
        END AS fire_safety_status,
    ( SELECT count(*)::integer
           FROM maint_work_orders wo
          WHERE wo.asset_id = a.asset_id
            AND (wo.status = ANY (ARRAY['novi', 'dodeljen', 'u_radu']))) AS open_wo_count
   FROM maint_assets a
     LEFT JOIN maint_facility_details d ON d.asset_id = a.asset_id
  WHERE a.asset_type = 'facility';

-- ─────────────────────────────────────────────────────────────────────────────
-- 10. `v_maint_vehicle_bookings` — rezervacije + izvedeno `current_state`.
--     SCOPE: `nonMachineViewScopeSql()`.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW "v_maint_vehicle_bookings" AS
SELECT b.booking_id,
    b.asset_id,
    b.driver_id,
    b.start_at,
    b.end_at,
    b.purpose,
    b.status,
    b.notes,
    b.created_at,
    b.updated_at,
    b.created_by,
    a.asset_code,
    a.name AS vehicle_name,
    d.full_name AS driver_name,
    d.is_internal AS driver_is_internal,
        CASE
            WHEN b.status = ANY (ARRAY['otkazana', 'zavrsena']) THEN b.status
            WHEN b.start_at > now() THEN 'planirana'
            WHEN b.end_at < now() THEN 'isteklo'
            ELSE 'u_toku'
        END AS current_state
   FROM maint_vehicle_bookings b
     JOIN maint_assets a ON a.asset_id = b.asset_id
     LEFT JOIN maint_drivers d ON d.driver_id = b.driver_id;

-- ─────────────────────────────────────────────────────────────────────────────
-- 11. `v_maint_vehicle_service_plan_due` — plan servisa vozila (rok po mesecima
--     I po kilometraži). Čita ga `ensure_vehicle_service_wos`.
--     ⚠️ Redosled `AND`/`OR` u `due_status` je prepisan DOSLOVNO: u PostgreSQL-u
--     `AND` veže jače od `OR`, pa je izraz „(mesečni prekoračen) OR (km prekoračen)".
--     SCOPE: `nonMachineViewScopeSql()`.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW "v_maint_vehicle_service_plan_due" AS
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
            ELSE (p.last_done_at + ((p.interval_months || ' months')::interval))::date
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
                ELSE (p.last_done_at + ((p.interval_months || ' months')::interval))::date - CURRENT_DATE
            END
        END AS days_to_due,
        CASE
            WHEN p.interval_km IS NULL OR p.last_done_km IS NULL OR vd.odometer_km IS NULL THEN NULL::integer
            ELSE p.last_done_km + p.interval_km - vd.odometer_km
        END AS km_to_due,
        CASE
            WHEN p.active = false THEN 'inactive'
            WHEN p.interval_months IS NOT NULL AND (p.last_done_at IS NULL OR (p.last_done_at + ((p.interval_months || ' months')::interval))::date < CURRENT_DATE) OR p.interval_km IS NOT NULL AND p.last_done_km IS NOT NULL AND vd.odometer_km IS NOT NULL AND (p.last_done_km + p.interval_km) < vd.odometer_km THEN 'overdue'
            WHEN p.interval_months IS NOT NULL AND p.last_done_at IS NOT NULL AND (p.last_done_at + ((p.interval_months || ' months')::interval))::date <= (CURRENT_DATE + '30 days'::interval) OR p.interval_km IS NOT NULL AND p.last_done_km IS NOT NULL AND vd.odometer_km IS NOT NULL AND (p.last_done_km + p.interval_km) <= (vd.odometer_km + 1000) THEN 'due_soon'
            ELSE 'ok'
        END AS due_status,
    (EXISTS ( SELECT 1
           FROM maint_work_orders wo
          WHERE wo.service_plan_id = p.plan_id
            AND (wo.status <> ALL (ARRAY['zavrsen', 'otkazan'])))) AS has_open_wo,
    ( SELECT wo.wo_id
           FROM maint_work_orders wo
          WHERE wo.service_plan_id = p.plan_id
            AND (wo.status <> ALL (ARRAY['zavrsen', 'otkazan']))
          ORDER BY wo.created_at DESC
         LIMIT 1) AS open_wo_id,
    p.planned_cost
   FROM maint_vehicle_service_plan p
     LEFT JOIN maint_vehicle_details vd ON vd.asset_id = p.asset_id;

-- ─────────────────────────────────────────────────────────────────────────────
-- 12. `v_maint_asset_service_plan_due` — plan održavanja sredstva (samo meseci).
--     Čita ga `ensure_asset_service_wos`.
--     ⚠️ `last_done_at IS NULL` -> `due_soon` (ne `overdue`) — plan koji nikad
--     nije izvršen je „uskoro", ne „probijen". Prepis, ne izbor.
--     SCOPE: `assetScopedWhere()` / `nonMachineViewScopeSql()` zavisno od tipa.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW "v_maint_asset_service_plan_due" AS
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
    (p.last_done_at + ((p.interval_months || ' months')::interval))::date AS next_due_at,
        CASE
            WHEN NOT p.active THEN 'inactive'
            WHEN p.last_done_at IS NULL THEN 'due_soon'
            WHEN (p.last_done_at + ((p.interval_months || ' months')::interval))::date < CURRENT_DATE THEN 'overdue'
            WHEN (p.last_done_at + ((p.interval_months || ' months')::interval))::date <= (CURRENT_DATE + '30 days'::interval) THEN 'due_soon'
            ELSE 'ok'
        END AS due_status,
    (EXISTS ( SELECT 1
           FROM maint_work_orders wo
          WHERE wo.asset_service_plan_id = p.plan_id
            AND (wo.status <> ALL (ARRAY['zavrsen', 'otkazan'])))) AS has_open_wo,
    ( SELECT wo.wo_id
           FROM maint_work_orders wo
          WHERE wo.asset_service_plan_id = p.plan_id
            AND (wo.status <> ALL (ARRAY['zavrsen', 'otkazan']))
          ORDER BY wo.created_at DESC
         LIMIT 1) AS open_wo_id,
    p.planned_cost
   FROM maint_asset_service_plan p
     JOIN maint_assets a ON a.asset_id = p.asset_id;

-- ─────────────────────────────────────────────────────────────────────────────
-- 13. `v_maint_parts_with_vehicles` — deo + na koliko je vozila vezan.
--     SCOPE: `partsViewScopeSql()`.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW "v_maint_parts_with_vehicles" AS
SELECT p.part_id,
    p.part_code,
    p.name AS part_name,
    p.description,
    p.unit,
    p.current_stock,
    p.min_stock,
    p.unit_cost,
    p.supplier_id,
    s.name AS supplier_name,
    p.active,
    count(pv.asset_id) FILTER (WHERE pv.asset_id IS NOT NULL)::integer AS vehicle_count,
    array_agg(DISTINCT a.asset_code) FILTER (WHERE a.asset_code IS NOT NULL) AS vehicle_codes
   FROM maint_parts p
     LEFT JOIN maint_part_vehicles pv ON pv.part_id = p.part_id
     LEFT JOIN maint_assets a ON a.asset_id = pv.asset_id AND a.asset_type = 'vehicle'
     LEFT JOIN maint_suppliers s ON s.supplier_id = p.supplier_id
  GROUP BY p.part_id, p.part_code, p.name, p.description, p.unit, p.current_stock,
           p.min_stock, p.unit_cost, p.supplier_id, s.name, p.active;

-- ─────────────────────────────────────────────────────────────────────────────
-- 14. `v_maint_vehicle_parts` — delovi jednog vozila + izvedeni `stock_status`.
--     ⚠️ `WHERE p.active = true` je deo view-a.
--     SCOPE: `partsViewScopeSql()` + `nonMachineViewScopeSql()`.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW "v_maint_vehicle_parts" AS
SELECT pv.asset_id,
    p.part_id,
    p.part_code,
    p.name AS part_name,
    p.description,
    p.unit,
    p.supplier_id,
    s.name AS supplier_name,
    p.manufacturer,
    p.model AS part_model,
    p.current_stock,
    COALESCE(pv.qty_min, p.min_stock) AS effective_min,
    pv.qty_min AS vehicle_qty_min,
    p.min_stock AS global_min_stock,
    p.unit_cost,
    pv.notes,
    pv.created_at AS linked_at,
        CASE
            WHEN p.current_stock IS NULL THEN 'unknown'
            WHEN p.current_stock <= 0::numeric THEN 'out'
            WHEN p.current_stock < COALESCE(pv.qty_min, p.min_stock, 0::numeric) THEN 'low'
            ELSE 'ok'
        END AS stock_status
   FROM maint_part_vehicles pv
     JOIN maint_parts p ON p.part_id = pv.part_id
     LEFT JOIN maint_suppliers s ON s.supplier_id = p.supplier_id
  WHERE p.active = true;

-- ─────────────────────────────────────────────────────────────────────────────
-- 15. `v_maint_cmms_daily_summary` — KPI kartica (8 brojki).
--
--     🔴 NAJOSETLJIVIJI VIEW DOMENA ZA PRAVA. U sy15 je `security_invoker`, pa su
--     SVE brojke bile SUŽENE na ono što pozivalac sme da vidi (operater je video
--     „1 otvoren kvar", ne stanje cele firme). Ovde view broji SVE.
--     Zato ga sme čitati samo onaj za koga `canReadFullSummary()` daje `true`
--     (vidi sve mašine ∧ sva ne-mašinska sredstva ∧ magacin). Ostalima se KPI
--     mora računati suženo ili ne prikazivati — v. runbook §7, blokada 4.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW "v_maint_cmms_daily_summary" AS
SELECT ( SELECT count(*)
           FROM maint_work_orders w
          WHERE w.status <> ALL (ARRAY['zavrsen', 'otkazan'])) AS active_work_orders,
    ( SELECT count(*)
           FROM maint_incidents i
          WHERE i.status <> ALL (ARRAY['resolved', 'closed'])) AS open_incidents,
    ( SELECT count(*)
           FROM maint_incidents i
          WHERE i.severity = 'critical'
            AND (i.status <> ALL (ARRAY['resolved', 'closed']))) AS open_critical_incidents,
    ( SELECT count(*)
           FROM v_maint_task_due_dates d
          WHERE d.next_due_at IS NOT NULL AND d.next_due_at < now()) AS overdue_preventive_tasks,
    ( SELECT count(*)
           FROM maint_parts p
          WHERE p.active AND p.current_stock < p.min_stock) AS parts_below_min_stock,
    ( SELECT count(*)
           FROM maint_work_orders w
          WHERE (w.status <> ALL (ARRAY['zavrsen', 'otkazan']))
            AND w.priority = 'p1_zastoj') AS open_wo_p1,
    ( SELECT count(*)
           FROM maint_work_orders w
          WHERE (w.status <> ALL (ARRAY['zavrsen', 'otkazan']))
            AND w.priority = 'p2_smetnja') AS open_wo_p2,
    ( SELECT count(*)
           FROM maint_work_orders w
          WHERE (w.status <> ALL (ARRAY['zavrsen', 'otkazan']))
            AND w.due_at IS NOT NULL AND w.due_at < now()) AS overdue_work_orders;
