-- AUTHZ/RPC SNAPSHOT: Talas F — Održavanje (CMMS, maint_*) — snimljeno 2026-07-12
-- Izvor: zamrznuti cloud = restore-izvor sy15. Re-verifikovati na zivoj sy15 pre R1 (doktrina A5).
-- 51 funkcija (40 maint_* + touch_updated_at + trg_maint_wo_asset_service_plan_completion + 9 create/archive/restore/ensure bez maint prefiksa).
-- + KOMPLETAN dump 102 RLS politike (pg_policies) + 4 storage politike + 34 trigera + 1 pg_cron job.
-- ⚠ ODVOJEN role sistem: maint_user_profiles po auth.uid() (NE po email-u) — GUC most MORA slati ispravan sub.
-- ⚠ Edge worker maint-notify-dispatch očekuje maint_dispatch_dequeue/mark_sent/mark_failed — NE POSTOJE na živoj bazi (pipeline mrtav; vidi MODULE_SPEC §2.6).

-- ============================================================
-- INDEKS FUNKCIJA (klasifikacija front vs pozadina)
-- ============================================================
--   archive_maint_asset  →  FRONT-RPC (IT/objekti soft-delete)
--   archive_maint_vehicle  →  FRONT-RPC (soft-delete + razlog)
--   create_maint_facility  →  FRONT-RPC (atomski asset+details)
--   create_maint_it_asset  →  FRONT-RPC (atomski asset+details)
--   create_maint_vehicle  →  FRONT-RPC (atomski asset+details)
--   ensure_asset_service_wos  →  FRONT-RPC (IT/objekti plan → WO)
--   ensure_vehicle_service_wos  →  FRONT-RPC (overdue/due_soon plan → WO)
--   maint_apply_part_stock_movement  →  TRIGGER (stock ledger delta)
--   maint_asset_service_plan_guard  →  TRIGGER (guard: samo it/facility)
--   maint_asset_visible  →  POLICY-HELPER (row visibility)
--   maint_assignable_users  →  FRONT-RPC (dropdown dodele)
--   maint_assigned_machine_codes  →  POLICY-HELPER (operator machine-scope)
--   maint_attach_incident_files  →  RPC — POSTOJI u bazi, NEPOZIVAN iz živog 1.0 koda (foto ide direktnim PATCH-om); kandidat za 2.0 foto tok
--   maint_can_close_incident  →  POLICY-HELPER (ko sme close)
--   maint_check_all_deadlines  →  CRON (pg_cron job 15, 07:00 UTC dnevno)
--   maint_check_it_facility_deadlines  →  CRON-HELPER (poziva ga maint_check_all_deadlines)
--   maint_check_vehicle_deadlines  →  CRON-HELPER + FRONT-RPC (ručno „Proveri rokove" dugme)
--   maint_create_preventive_work_order  →  FRONT-RPC (preventiva → WO)
--   maint_dispatch_fanout  →  WORKER-RPC (edge maint-notify-dispatch; ⚠ dequeue/mark_sent/mark_failed NE POSTOJE na živoj bazi → pipeline mrtav)
--   maint_document_visible  →  POLICY-HELPER (dokumenti po entitetu)
--   maint_enqueue_notification  →  DB-INTERNAL (pozivaju trigeri + cron)
--   maint_facility_details_guard  →  TRIGGER (guard asset_type=facility)
--   maint_has_floor_read_access  →  POLICY-HELPER (globalne role po EMAIL-u)
--   maint_incident_row_visible  →  POLICY-HELPER
--   maint_incidents_autocreate_work_order  →  TRIGGER (major/critical/safety → auto WO)
--   maint_incidents_enqueue_notify  →  TRIGGER (major/critical → outbox)
--   maint_incidents_log_changes  →  TRIGGER (audit events)
--   maint_incidents_set_asset_fields  →  TRIGGER (denormalizacija asset_id/type)
--   maint_is_erp_admin  →  POLICY-HELPER (user_roles admin po EMAIL-u)
--   maint_is_erp_admin_or_management  →  POLICY-HELPER (admin/menadzment/MAGACIONER po EMAIL-u)
--   maint_it_asset_details_guard  →  TRIGGER (guard asset_type=it)
--   maint_machine_delete_hard  →  FRONT-RPC (hard delete + audit log)
--   maint_machine_dept_code  →  DB-INTERNAL (mapiranje mašina → M.* hala, loc sync)
--   maint_machine_rename  →  FRONT-RPC (atomski rename PK kroz 6 tabela)
--   maint_machine_visible  →  POLICY-HELPER (jezgro machine-scope)
--   maint_machines_ensure_asset  →  TRIGGER (mašina → maint_assets red + qr_token)
--   maint_machines_import_from_cache  →  FRONT-RPC (uvoz iz bigtehn_machines_cache)
--   maint_machines_sync_to_loc  →  TRIGGER (most ka loc_locations MACHINE redovima!)
--   maint_normalize_name  →  DB-INTERNAL (tokenizacija imena)
--   maint_notification_retry  →  FRONT-RPC (failed → queued)
--   maint_profile_role  →  POLICY-HELPER (maint_user_profiles po auth.uid()!)
--   maint_profiles_guard_role  →  TRIGGER (SoD: role/active menja SAMO ERP admin)
--   maint_vehicle_details_guard  →  TRIGGER (guard asset_type=vehicle)
--   maint_wo_log_field_changes  →  TRIGGER (audit WO polja)
--   maint_wo_row_visible  →  POLICY-HELPER (assigned/reported/asset-visible)
--   maint_wo_service_plan_completion  →  TRIGGER (WO zavrsen → vehicle plan last_done)
--   maint_work_orders_assign_wo_number  →  TRIGGER (WO-YYYY-NNNNN counter)
--   restore_maint_asset  →  FRONT-RPC
--   restore_maint_vehicle  →  FRONT-RPC
--   touch_updated_at  →  TRIGGER (deljeni app-wide updated_at helper)
--   trg_maint_wo_asset_service_plan_completion  →  TRIGGER (WO zavrsen → asset plan last_done)

-- ============ archive_maint_asset ============
-- KLASA: FRONT-RPC (IT/objekti soft-delete)
CREATE OR REPLACE FUNCTION public.archive_maint_asset(p_asset_id uuid, p_reason text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_found INTEGER;
BEGIN
  IF NOT (public.maint_is_erp_admin_or_management()
       OR public.maint_profile_role() IN ('chief', 'admin')) THEN
    RAISE EXCEPTION 'Nemaš ovlašćenje za arhiviranje sredstva';
  END IF;
  IF p_asset_id IS NULL THEN
    RAISE EXCEPTION 'asset_id je obavezan';
  END IF;
  IF p_reason IS NULL OR length(trim(p_reason)) = 0 THEN
    RAISE EXCEPTION 'Razlog arhiviranja je obavezan';
  END IF;

  UPDATE public.maint_assets
     SET archived_at    = COALESCE(archived_at, now()),
         archive_reason = trim(p_reason),
         archived_by    = auth.uid(),
         active         = FALSE,
         updated_by     = auth.uid(),
         updated_at     = now()
   WHERE asset_id   = p_asset_id
     AND asset_type IN ('it', 'facility');

  GET DIAGNOSTICS v_found = ROW_COUNT;
  RETURN v_found > 0;
END;
$function$

-- ============ archive_maint_vehicle ============
-- KLASA: FRONT-RPC (soft-delete + razlog)
CREATE OR REPLACE FUNCTION public.archive_maint_vehicle(p_asset_id uuid, p_reason text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_found INTEGER;
BEGIN
  IF NOT (public.maint_is_erp_admin_or_management()
       OR public.maint_profile_role() IN ('chief', 'admin')) THEN
    RAISE EXCEPTION 'Nemaš ovlašćenje za arhiviranje vozila';
  END IF;
  IF p_asset_id IS NULL THEN
    RAISE EXCEPTION 'asset_id je obavezan';
  END IF;
  IF p_reason IS NULL OR length(trim(p_reason)) = 0 THEN
    RAISE EXCEPTION 'Razlog arhiviranja je obavezan (npr. prodato, rashodovano, vraćeno leasingu)';
  END IF;

  UPDATE public.maint_assets
     SET archived_at    = COALESCE(archived_at, now()),
         archive_reason = trim(p_reason),
         archived_by    = auth.uid(),
         active         = FALSE,
         updated_by     = auth.uid(),
         updated_at     = now()
   WHERE asset_id   = p_asset_id
     AND asset_type = 'vehicle';

  GET DIAGNOSTICS v_found = ROW_COUNT;
  RETURN v_found > 0;
END;
$function$

-- ============ create_maint_facility ============
-- KLASA: FRONT-RPC (atomski asset+details)
CREATE OR REPLACE FUNCTION public.create_maint_facility(p_asset_code text, p_name text, p_status text DEFAULT 'running'::text, p_manufacturer text DEFAULT NULL::text, p_model text DEFAULT NULL::text, p_serial_number text DEFAULT NULL::text, p_supplier text DEFAULT NULL::text, p_asset_notes text DEFAULT NULL::text, p_details jsonb DEFAULT '{}'::jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_asset_id UUID;
  v_user_id  UUID := auth.uid();
BEGIN
  IF NOT (public.maint_is_erp_admin_or_management()
       OR public.maint_profile_role() IN ('chief', 'admin')) THEN
    RAISE EXCEPTION 'Nemaš ovlašćenje za kreiranje objekta (potreban je ERP admin/menadzment ili maint chief/admin)';
  END IF;

  IF p_asset_code IS NULL OR length(trim(p_asset_code)) = 0 THEN
    RAISE EXCEPTION 'Šifra objekta je obavezna';
  END IF;
  IF p_name IS NULL OR length(trim(p_name)) = 0 THEN
    RAISE EXCEPTION 'Naziv objekta je obavezan';
  END IF;

  INSERT INTO public.maint_assets (
    asset_type, asset_code, name, status, manufacturer, model,
    serial_number, supplier, notes, active, updated_by
  ) VALUES (
    'facility',
    trim(p_asset_code),
    trim(p_name),
    COALESCE(NULLIF(p_status, ''), 'running')::public.maint_operational_status,
    NULLIF(p_manufacturer, ''),
    NULLIF(p_model, ''),
    NULLIF(p_serial_number, ''),
    NULLIF(p_supplier, ''),
    NULLIF(p_asset_notes, ''),
    TRUE,
    v_user_id
  )
  RETURNING asset_id INTO v_asset_id;

  INSERT INTO public.maint_facility_details (
    asset_id,
    facility_type, floor_area_m2, floor_or_zone, criticality,
    inspection_due_at, fire_safety_due_at, service_contract,
    service_provider, last_inspection_at, notes,
    updated_by
  ) VALUES (
    v_asset_id,
    NULLIF(p_details->>'facility_type', ''),
    NULLIF(p_details->>'floor_area_m2', '')::NUMERIC(12, 2),
    NULLIF(p_details->>'floor_or_zone', ''),
    NULLIF(p_details->>'criticality', ''),
    NULLIF(p_details->>'inspection_due_at', '')::DATE,
    NULLIF(p_details->>'fire_safety_due_at', '')::DATE,
    NULLIF(p_details->>'service_contract', ''),
    NULLIF(p_details->>'service_provider', ''),
    NULLIF(p_details->>'last_inspection_at', '')::DATE,
    NULLIF(p_details->>'notes', ''),
    v_user_id
  );

  RETURN v_asset_id;
END;
$function$

-- ============ create_maint_it_asset ============
-- KLASA: FRONT-RPC (atomski asset+details)
CREATE OR REPLACE FUNCTION public.create_maint_it_asset(p_asset_code text, p_name text, p_status text DEFAULT 'running'::text, p_manufacturer text DEFAULT NULL::text, p_model text DEFAULT NULL::text, p_serial_number text DEFAULT NULL::text, p_supplier text DEFAULT NULL::text, p_asset_notes text DEFAULT NULL::text, p_details jsonb DEFAULT '{}'::jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_asset_id UUID;
  v_user_id  UUID := auth.uid();
BEGIN
  IF NOT (public.maint_is_erp_admin_or_management()
       OR public.maint_profile_role() IN ('chief', 'admin')) THEN
    RAISE EXCEPTION 'Nemaš ovlašćenje za kreiranje IT opreme (potreban je ERP admin/menadzment ili maint chief/admin)';
  END IF;

  IF p_asset_code IS NULL OR length(trim(p_asset_code)) = 0 THEN
    RAISE EXCEPTION 'Šifra IT opreme je obavezna';
  END IF;
  IF p_name IS NULL OR length(trim(p_name)) = 0 THEN
    RAISE EXCEPTION 'Naziv IT opreme je obavezan';
  END IF;

  INSERT INTO public.maint_assets (
    asset_type, asset_code, name, status, manufacturer, model,
    serial_number, supplier, notes, active, updated_by
  ) VALUES (
    'it',
    trim(p_asset_code),
    trim(p_name),
    COALESCE(NULLIF(p_status, ''), 'running')::public.maint_operational_status,
    NULLIF(p_manufacturer, ''),
    NULLIF(p_model, ''),
    NULLIF(p_serial_number, ''),
    NULLIF(p_supplier, ''),
    NULLIF(p_asset_notes, ''),
    TRUE,
    v_user_id
  )
  RETURNING asset_id INTO v_asset_id;

  INSERT INTO public.maint_it_asset_details (
    asset_id,
    device_type, hostname, ip_address, mac_address,
    operating_system, assigned_to, license_key, license_expires_at,
    warranty_expires_at, backup_required, last_backup_at, notes,
    updated_by
  ) VALUES (
    v_asset_id,
    NULLIF(p_details->>'device_type', ''),
    NULLIF(p_details->>'hostname', ''),
    NULLIF(NULLIF(p_details->>'ip_address', ''), NULL)::INET,
    NULLIF(p_details->>'mac_address', ''),
    NULLIF(p_details->>'operating_system', ''),
    NULLIF(p_details->>'assigned_to', ''),
    NULLIF(p_details->>'license_key', ''),
    NULLIF(p_details->>'license_expires_at', '')::DATE,
    NULLIF(p_details->>'warranty_expires_at', '')::DATE,
    COALESCE((p_details->>'backup_required')::BOOLEAN, FALSE),
    NULLIF(p_details->>'last_backup_at', '')::TIMESTAMPTZ,
    NULLIF(p_details->>'notes', ''),
    v_user_id
  );

  RETURN v_asset_id;
END;
$function$

-- ============ create_maint_vehicle ============
-- KLASA: FRONT-RPC (atomski asset+details)
CREATE OR REPLACE FUNCTION public.create_maint_vehicle(p_asset_code text, p_name text, p_status text DEFAULT 'running'::text, p_manufacturer text DEFAULT NULL::text, p_model text DEFAULT NULL::text, p_serial_number text DEFAULT NULL::text, p_supplier text DEFAULT NULL::text, p_asset_notes text DEFAULT NULL::text, p_details jsonb DEFAULT '{}'::jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_asset_id UUID;
  v_user_id  UUID := auth.uid();
BEGIN
  IF NOT (public.maint_is_erp_admin_or_management()
       OR public.maint_profile_role() IN ('chief', 'admin')) THEN
    RAISE EXCEPTION 'Nemaš ovlašćenje za kreiranje vozila';
  END IF;
  IF p_asset_code IS NULL OR length(trim(p_asset_code)) = 0 THEN
    RAISE EXCEPTION 'Šifra vozila je obavezna';
  END IF;
  IF p_name IS NULL OR length(trim(p_name)) = 0 THEN
    RAISE EXCEPTION 'Naziv vozila je obavezan';
  END IF;

  INSERT INTO public.maint_assets (
    asset_type, asset_code, name, status, manufacturer, model,
    serial_number, supplier, notes, active, updated_by
  ) VALUES (
    'vehicle', trim(p_asset_code), trim(p_name),
    COALESCE(NULLIF(p_status, ''), 'running'),
    NULLIF(p_manufacturer, ''), NULLIF(p_model, ''),
    NULLIF(p_serial_number, ''), NULLIF(p_supplier, ''),
    NULLIF(p_asset_notes, ''), TRUE, v_user_id
  )
  RETURNING asset_id INTO v_asset_id;

  INSERT INTO public.maint_vehicle_details (
    asset_id,
    registration_plate, vin, odometer_km, fuel_type,
    registration_expires_at, insurance_expires_at, service_due_at,
    service_interval_km, next_service_mileage_km, notes,
    year_of_manufacture, vehicle_kind, payload_kg, passenger_seats,
    usage_type, gps_provider, gps_device_id, first_aid_kit_expires_at,
    is_private_vehicle, owner_id, primary_driver_id,
    updated_by
  ) VALUES (
    v_asset_id,
    NULLIF(p_details->>'registration_plate', ''),
    NULLIF(p_details->>'vin', ''),
    NULLIF(p_details->>'odometer_km', '')::INT,
    NULLIF(p_details->>'fuel_type', ''),
    NULLIF(p_details->>'registration_expires_at', '')::DATE,
    NULLIF(p_details->>'insurance_expires_at', '')::DATE,
    NULLIF(p_details->>'service_due_at', '')::DATE,
    NULLIF(p_details->>'service_interval_km', '')::INT,
    NULLIF(p_details->>'next_service_mileage_km', '')::INT,
    NULLIF(p_details->>'notes', ''),
    NULLIF(p_details->>'year_of_manufacture', '')::SMALLINT,
    NULLIF(p_details->>'vehicle_kind', '')::public.maint_vehicle_kind,
    NULLIF(p_details->>'payload_kg', '')::INT,
    NULLIF(p_details->>'passenger_seats', '')::SMALLINT,
    NULLIF(p_details->>'usage_type', '')::public.maint_vehicle_usage_type,
    COALESCE(NULLIF(p_details->>'gps_provider', '')::public.maint_vehicle_gps_provider, 'nema'::public.maint_vehicle_gps_provider),
    NULLIF(p_details->>'gps_device_id', ''),
    NULLIF(p_details->>'first_aid_kit_expires_at', '')::DATE,
    COALESCE((p_details->>'is_private_vehicle')::BOOLEAN, FALSE),
    NULLIF(p_details->>'owner_id', '')::UUID,
    NULLIF(p_details->>'primary_driver_id', '')::UUID,
    v_user_id
  );

  RETURN v_asset_id;
END;
$function$

-- ============ ensure_asset_service_wos ============
-- KLASA: FRONT-RPC (IT/objekti plan → WO)
CREATE OR REPLACE FUNCTION public.ensure_asset_service_wos(p_asset_id uuid DEFAULT NULL::uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  r RECORD;
  v_count INT := 0;
  v_user_id UUID := auth.uid();
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Mora postojati ulogovan korisnik za auto-WO';
  END IF;
  IF NOT (public.maint_is_erp_admin_or_management()
       OR public.maint_profile_role() IN ('chief', 'admin', 'technician')) THEN
    RAISE EXCEPTION 'Nemaš ovlašćenje za generisanje WO iz plana';
  END IF;

  FOR r IN
    SELECT v.*
    FROM public.v_maint_asset_service_plan_due v
    JOIN public.maint_assets a ON a.asset_id = v.asset_id
    WHERE v.active
      AND v.due_status IN ('overdue', 'due_soon')
      AND v.has_open_wo = FALSE
      AND a.archived_at IS NULL
      AND (p_asset_id IS NULL OR v.asset_id = p_asset_id)
  LOOP
    INSERT INTO public.maint_work_orders (
      type, asset_id, asset_type, title, description,
      priority, status, reported_by, due_at, asset_service_plan_id
    ) VALUES (
      CASE WHEN r.asset_type = 'facility' THEN 'inspekcija'::public.maint_wo_type ELSE 'preventiva'::public.maint_wo_type END,
      r.asset_id,
      r.asset_type,
      r.name,
      'Auto-generisan iz plana održavanja (' || r.interval_months || ' mes).',
      r.priority,
      'novi',
      v_user_id,
      CASE WHEN r.next_due_at IS NOT NULL THEN r.next_due_at::TIMESTAMPTZ ELSE NULL END,
      r.plan_id
    );
    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$function$

-- ============ ensure_vehicle_service_wos ============
-- KLASA: FRONT-RPC (overdue/due_soon plan → WO)
CREATE OR REPLACE FUNCTION public.ensure_vehicle_service_wos(p_asset_id uuid DEFAULT NULL::uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_count   INT := 0;
  v_user_id UUID := auth.uid();
  r RECORD;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Mora postojati ulogovan korisnik za auto-WO';
  END IF;
  IF NOT (public.maint_is_erp_admin_or_management()
       OR public.maint_profile_role() IN ('chief', 'admin', 'technician')) THEN
    RAISE EXCEPTION 'Nemaš ovlašćenje za generisanje WO iz plana servisa';
  END IF;

  FOR r IN
    SELECT pl.*
    FROM public.v_maint_vehicle_service_plan_due pl
    JOIN public.maint_assets a ON a.asset_id = pl.asset_id
    WHERE pl.active = TRUE
      AND pl.due_status IN ('overdue', 'due_soon')
      AND pl.has_open_wo = FALSE
      AND a.archived_at IS NULL
      AND (p_asset_id IS NULL OR pl.asset_id = p_asset_id)
  LOOP
    INSERT INTO public.maint_work_orders (
      type, asset_id, asset_type,
      title, description,
      priority, status, reported_by,
      due_at, service_plan_id, trigger_odometer_km
    ) VALUES (
      'servis',
      r.asset_id,
      'vehicle',
      r.name,
      'Auto-generisan iz Plana servisa.'
        || CASE WHEN r.next_due_at IS NOT NULL
             THEN E'\nRok: ' || to_char(r.next_due_at, 'DD.MM.YYYY')
             ELSE '' END
        || CASE WHEN r.next_due_km IS NOT NULL
             THEN E'\nPrag km: ' || r.next_due_km::TEXT
             ELSE '' END
        || CASE WHEN r.notes IS NOT NULL AND length(trim(r.notes)) > 0
             THEN E'\n\n' || r.notes
             ELSE '' END,
      r.priority,
      'novi',
      v_user_id,
      CASE WHEN r.next_due_at IS NOT NULL THEN r.next_due_at::TIMESTAMPTZ ELSE NULL END,
      r.plan_id,
      r.next_due_km
    );
    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$function$

-- ============ maint_apply_part_stock_movement ============
-- KLASA: TRIGGER (stock ledger delta)
CREATE OR REPLACE FUNCTION public.maint_apply_part_stock_movement()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_delta NUMERIC(12, 4);
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RETURN NEW;
  END IF;

  v_delta := CASE NEW.movement_type
    WHEN 'in' THEN NEW.quantity
    WHEN 'return' THEN NEW.quantity
    WHEN 'out' THEN -NEW.quantity
    WHEN 'adjustment' THEN NEW.quantity
  END;

  UPDATE public.maint_parts
  SET current_stock = current_stock + v_delta
  WHERE part_id = NEW.part_id;

  RETURN NEW;
END;
$function$

-- ============ maint_asset_service_plan_guard ============
-- KLASA: TRIGGER (guard: samo it/facility)
CREATE OR REPLACE FUNCTION public.maint_asset_service_plan_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.maint_assets a
    WHERE a.asset_id = NEW.asset_id
      AND a.asset_type IN ('it', 'facility')
  ) THEN
    RAISE EXCEPTION 'maint_asset_service_plan.asset_id must reference IT or facility asset';
  END IF;
  RETURN NEW;
END;
$function$

-- ============ maint_asset_visible ============
-- KLASA: POLICY-HELPER (row visibility)
CREATE OR REPLACE FUNCTION public.maint_asset_visible(p_asset_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM public.maint_assets a
    WHERE a.asset_id = p_asset_id
      AND (
        (
          a.asset_type = 'machine'
          AND EXISTS (
            SELECT 1
            FROM public.maint_machines m
            WHERE m.asset_id = a.asset_id
              AND public.maint_machine_visible(m.machine_code)
          )
        )
        OR (
          a.asset_type <> 'machine'
          AND (
            public.maint_has_floor_read_access()
            OR public.maint_is_erp_admin()
            OR public.maint_profile_role() IN ('chief', 'management', 'admin')
          )
        )
      )
  );
$function$

-- ============ maint_assignable_users ============
-- KLASA: FRONT-RPC (dropdown dodele)
CREATE OR REPLACE FUNCTION public.maint_assignable_users()
 RETURNS TABLE(user_id uuid, full_name text, maint_role text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT p.user_id, p.full_name, p.role::text AS maint_role
  FROM public.maint_user_profiles p
  WHERE p.active = true
    AND p.role::text IN ('operator', 'technician', 'chief', 'admin')
  ORDER BY p.full_name;
$function$

-- ============ maint_assigned_machine_codes ============
-- KLASA: POLICY-HELPER (operator machine-scope)
CREATE OR REPLACE FUNCTION public.maint_assigned_machine_codes()
 RETURNS text[]
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT coalesce(
    (SELECT assigned_machine_codes
     FROM public.maint_user_profiles
     WHERE user_id = auth.uid() AND active = true
     LIMIT 1),
    ARRAY[]::text[]
  );
$function$

-- ============ maint_attach_incident_files ============
-- KLASA: RPC — POSTOJI u bazi, NEPOZIVAN iz živog 1.0 koda (foto ide direktnim PATCH-om); kandidat za 2.0 foto tok
CREATE OR REPLACE FUNCTION public.maint_attach_incident_files(p_incident_id uuid, p_urls text[])
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_updated int;
begin
  if p_incident_id is null or p_urls is null or array_length(p_urls, 1) is null then
    return false;
  end if;

  update public.maint_incidents i
     set attachment_urls = (
           select array_agg(distinct u)
           from unnest(coalesce(i.attachment_urls, '{}'::text[]) || p_urls) as u
         ),
         updated_at = now()
   where i.id = p_incident_id
     and i.reported_by = auth.uid();

  get diagnostics v_updated = row_count;
  return v_updated > 0;
end;
$function$

-- ============ maint_can_close_incident ============
-- KLASA: POLICY-HELPER (ko sme close)
CREATE OR REPLACE FUNCTION public.maint_can_close_incident()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT public.maint_is_erp_admin_or_management()
      OR public.maint_is_erp_admin()
      OR public.maint_profile_role() IN ('chief', 'admin');
$function$

-- ============ maint_check_all_deadlines ============
-- KLASA: CRON (pg_cron job 15, 07:00 UTC dnevno)
CREATE OR REPLACE FUNCTION public.maint_check_all_deadlines(p_lookahead_days integer DEFAULT 30)
 RETURNS TABLE(source text, enqueued integer, skipped integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v RECORD;
BEGIN
  FOR v IN SELECT * FROM public.maint_check_vehicle_deadlines(p_lookahead_days) LOOP
    RETURN QUERY SELECT 'vehicle'::TEXT, v.enqueued, v.skipped;
  END LOOP;
  FOR v IN SELECT * FROM public.maint_check_it_facility_deadlines(p_lookahead_days) LOOP
    RETURN QUERY SELECT 'it_facility'::TEXT, v.enqueued, v.skipped;
  END LOOP;
END;
$function$

-- ============ maint_check_it_facility_deadlines ============
-- KLASA: CRON-HELPER (poziva ga maint_check_all_deadlines)
CREATE OR REPLACE FUNCTION public.maint_check_it_facility_deadlines(p_lookahead_days integer DEFAULT 30)
 RETURNS TABLE(enqueued integer, skipped integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_enq INT := 0;
  v_skip INT := 0;
  r RECORD;
  v_exists BOOLEAN;
BEGIN
  FOR r IN
    SELECT asset_id, asset_code, name, license_expires_at, warranty_expires_at, backup_status
    FROM public.v_maint_it_overview
    WHERE archived_at IS NULL
  LOOP
    IF r.license_expires_at IS NOT NULL
       AND r.license_expires_at <= CURRENT_DATE + (p_lookahead_days || ' days')::INTERVAL THEN
      SELECT EXISTS (
        SELECT 1 FROM public.maint_notification_log nl
        WHERE nl.related_entity_type = 'asset' AND nl.related_entity_id = r.asset_id
          AND nl.payload->>'deadline_kind' = 'it_license'
          AND nl.payload->>'deadline_date' = r.license_expires_at::TEXT
          AND nl.status IN ('queued', 'sent')
      ) INTO v_exists;
      IF NOT v_exists THEN
        PERFORM public.maint_enqueue_notification(
          'email'::public.maint_notification_channel, 'pending', NULL,
          'IT licenca ističe: ' || COALESCE(r.name, r.asset_code),
          'Licenca za ' || COALESCE(r.name, r.asset_code) || ' ističe ' || to_char(r.license_expires_at, 'DD.MM.YYYY'),
          'asset', r.asset_id, NULL, 0,
          jsonb_build_object('deadline_kind', 'it_license', 'deadline_date', r.license_expires_at::TEXT, 'asset_code', r.asset_code)
        );
        v_enq := v_enq + 1;
      ELSE v_skip := v_skip + 1; END IF;
    END IF;

    IF r.warranty_expires_at IS NOT NULL
       AND r.warranty_expires_at <= CURRENT_DATE + (p_lookahead_days || ' days')::INTERVAL THEN
      SELECT EXISTS (
        SELECT 1 FROM public.maint_notification_log nl
        WHERE nl.related_entity_type = 'asset' AND nl.related_entity_id = r.asset_id
          AND nl.payload->>'deadline_kind' = 'it_warranty'
          AND nl.payload->>'deadline_date' = r.warranty_expires_at::TEXT
          AND nl.status IN ('queued', 'sent')
      ) INTO v_exists;
      IF NOT v_exists THEN
        PERFORM public.maint_enqueue_notification(
          'email'::public.maint_notification_channel, 'pending', NULL,
          'IT garancija ističe: ' || COALESCE(r.name, r.asset_code),
          'Garancija za ' || COALESCE(r.name, r.asset_code) || ' ističe ' || to_char(r.warranty_expires_at, 'DD.MM.YYYY'),
          'asset', r.asset_id, NULL, 0,
          jsonb_build_object('deadline_kind', 'it_warranty', 'deadline_date', r.warranty_expires_at::TEXT, 'asset_code', r.asset_code)
        );
        v_enq := v_enq + 1;
      ELSE v_skip := v_skip + 1; END IF;
    END IF;

    IF r.backup_status IN ('missing', 'stale') THEN
      SELECT EXISTS (
        SELECT 1 FROM public.maint_notification_log nl
        WHERE nl.related_entity_type = 'asset' AND nl.related_entity_id = r.asset_id
          AND nl.payload->>'deadline_kind' = 'it_backup'
          AND nl.payload->>'backup_status' = r.backup_status
          AND nl.created_at >= CURRENT_DATE - INTERVAL '7 days'
          AND nl.status IN ('queued', 'sent')
      ) INTO v_exists;
      IF NOT v_exists THEN
        PERFORM public.maint_enqueue_notification(
          'email'::public.maint_notification_channel, 'pending', NULL,
          'IT backup pažnja: ' || COALESCE(r.name, r.asset_code),
          'Backup status za ' || COALESCE(r.name, r.asset_code) || ': ' || r.backup_status,
          'asset', r.asset_id, NULL, 0,
          jsonb_build_object('deadline_kind', 'it_backup', 'backup_status', r.backup_status, 'asset_code', r.asset_code)
        );
        v_enq := v_enq + 1;
      ELSE v_skip := v_skip + 1; END IF;
    END IF;
  END LOOP;

  FOR r IN
    SELECT asset_id, asset_code, name, inspection_due_at, fire_safety_due_at
    FROM public.v_maint_facility_overview
    WHERE archived_at IS NULL
  LOOP
    IF r.inspection_due_at IS NOT NULL
       AND r.inspection_due_at <= CURRENT_DATE + (p_lookahead_days || ' days')::INTERVAL THEN
      SELECT EXISTS (
        SELECT 1 FROM public.maint_notification_log nl
        WHERE nl.related_entity_type = 'asset' AND nl.related_entity_id = r.asset_id
          AND nl.payload->>'deadline_kind' = 'facility_inspection'
          AND nl.payload->>'deadline_date' = r.inspection_due_at::TEXT
          AND nl.status IN ('queued', 'sent')
      ) INTO v_exists;
      IF NOT v_exists THEN
        PERFORM public.maint_enqueue_notification(
          'email'::public.maint_notification_channel, 'pending', NULL,
          'Inspekcija objekta: ' || COALESCE(r.name, r.asset_code),
          'Inspekcija za ' || COALESCE(r.name, r.asset_code) || ' dospeva ' || to_char(r.inspection_due_at, 'DD.MM.YYYY'),
          'asset', r.asset_id, NULL, 0,
          jsonb_build_object('deadline_kind', 'facility_inspection', 'deadline_date', r.inspection_due_at::TEXT, 'asset_code', r.asset_code)
        );
        v_enq := v_enq + 1;
      ELSE v_skip := v_skip + 1; END IF;
    END IF;

    IF r.fire_safety_due_at IS NOT NULL
       AND r.fire_safety_due_at <= CURRENT_DATE + (p_lookahead_days || ' days')::INTERVAL THEN
      SELECT EXISTS (
        SELECT 1 FROM public.maint_notification_log nl
        WHERE nl.related_entity_type = 'asset' AND nl.related_entity_id = r.asset_id
          AND nl.payload->>'deadline_kind' = 'facility_fire_safety'
          AND nl.payload->>'deadline_date' = r.fire_safety_due_at::TEXT
          AND nl.status IN ('queued', 'sent')
      ) INTO v_exists;
      IF NOT v_exists THEN
        PERFORM public.maint_enqueue_notification(
          'email'::public.maint_notification_channel, 'pending', NULL,
          'PP rok objekta: ' || COALESCE(r.name, r.asset_code),
          'PP zaštita za ' || COALESCE(r.name, r.asset_code) || ' dospeva ' || to_char(r.fire_safety_due_at, 'DD.MM.YYYY'),
          'asset', r.asset_id, NULL, 0,
          jsonb_build_object('deadline_kind', 'facility_fire_safety', 'deadline_date', r.fire_safety_due_at::TEXT, 'asset_code', r.asset_code)
        );
        v_enq := v_enq + 1;
      ELSE v_skip := v_skip + 1; END IF;
    END IF;
  END LOOP;

  RETURN QUERY SELECT v_enq, v_skip;
END;
$function$

-- ============ maint_check_vehicle_deadlines ============
-- KLASA: CRON-HELPER + FRONT-RPC (ručno „Proveri rokove" dugme)
CREATE OR REPLACE FUNCTION public.maint_check_vehicle_deadlines(p_lookahead_days integer DEFAULT 30)
 RETURNS TABLE(enqueued integer, skipped integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_enq INT := 0;
  v_skip INT := 0;
  r RECORD;

  /* helper inline check — vraća TRUE ako notif za taj entity+kind+date već postoji */
  v_exists BOOLEAN;
BEGIN
  /* ── 1. VOZILA — registracija, osiguranje, prva pomoć, servis ──────── */
  FOR r IN
    SELECT
      a.asset_id, a.asset_code, a.name AS vehicle_name,
      vd.registration_plate,
      vd.registration_expires_at, vd.insurance_expires_at,
      vd.first_aid_kit_expires_at, vd.service_due_at
    FROM public.maint_assets a
    JOIN public.maint_vehicle_details vd ON vd.asset_id = a.asset_id
    WHERE a.asset_type = 'vehicle' AND a.archived_at IS NULL
  LOOP
    /* Registracija */
    IF r.registration_expires_at IS NOT NULL
       AND r.registration_expires_at <= CURRENT_DATE + (p_lookahead_days || ' days')::INTERVAL THEN
      SELECT EXISTS (
        SELECT 1 FROM public.maint_notification_log nl
        WHERE nl.related_entity_type = 'asset'
          AND nl.related_entity_id = r.asset_id
          AND nl.payload->>'deadline_kind' = 'registration'
          AND nl.payload->>'deadline_date' = r.registration_expires_at::TEXT
          AND nl.status IN ('queued', 'sent')
      ) INTO v_exists;
      IF NOT v_exists THEN
        PERFORM public.maint_enqueue_notification(
          'email'::public.maint_notification_channel, 'pending', NULL,
          'Registracija ističe: ' || COALESCE(r.vehicle_name, r.asset_code),
          'Registracija za vozilo ' || COALESCE(r.vehicle_name, r.asset_code) ||
            ' (' || COALESCE(r.registration_plate, r.asset_code) ||
            ') ističe ' || to_char(r.registration_expires_at, 'DD.MM.YYYY'),
          'asset', r.asset_id, NULL, 0,
          jsonb_build_object('deadline_kind', 'registration', 'deadline_date', r.registration_expires_at::TEXT, 'asset_code', r.asset_code)
        );
        v_enq := v_enq + 1;
      ELSE v_skip := v_skip + 1; END IF;
    END IF;

    /* Osiguranje */
    IF r.insurance_expires_at IS NOT NULL
       AND r.insurance_expires_at <= CURRENT_DATE + (p_lookahead_days || ' days')::INTERVAL THEN
      SELECT EXISTS (
        SELECT 1 FROM public.maint_notification_log nl
        WHERE nl.related_entity_type = 'asset' AND nl.related_entity_id = r.asset_id
          AND nl.payload->>'deadline_kind' = 'insurance'
          AND nl.payload->>'deadline_date' = r.insurance_expires_at::TEXT
          AND nl.status IN ('queued', 'sent')
      ) INTO v_exists;
      IF NOT v_exists THEN
        PERFORM public.maint_enqueue_notification(
          'email'::public.maint_notification_channel, 'pending', NULL,
          'Osiguranje ističe: ' || COALESCE(r.vehicle_name, r.asset_code),
          'Polisa osiguranja za ' || COALESCE(r.vehicle_name, r.asset_code) ||
            ' (' || COALESCE(r.registration_plate, r.asset_code) ||
            ') ističe ' || to_char(r.insurance_expires_at, 'DD.MM.YYYY'),
          'asset', r.asset_id, NULL, 0,
          jsonb_build_object('deadline_kind', 'insurance', 'deadline_date', r.insurance_expires_at::TEXT, 'asset_code', r.asset_code)
        );
        v_enq := v_enq + 1;
      ELSE v_skip := v_skip + 1; END IF;
    END IF;

    /* Prva pomoć */
    IF r.first_aid_kit_expires_at IS NOT NULL
       AND r.first_aid_kit_expires_at <= CURRENT_DATE + (p_lookahead_days || ' days')::INTERVAL THEN
      SELECT EXISTS (
        SELECT 1 FROM public.maint_notification_log nl
        WHERE nl.related_entity_type = 'asset' AND nl.related_entity_id = r.asset_id
          AND nl.payload->>'deadline_kind' = 'first_aid'
          AND nl.payload->>'deadline_date' = r.first_aid_kit_expires_at::TEXT
          AND nl.status IN ('queued', 'sent')
      ) INTO v_exists;
      IF NOT v_exists THEN
        PERFORM public.maint_enqueue_notification(
          'email'::public.maint_notification_channel, 'pending', NULL,
          'Prva pomoć ističe: ' || COALESCE(r.vehicle_name, r.asset_code),
          'Komplet prve pomoći u ' || COALESCE(r.vehicle_name, r.asset_code) ||
            ' (' || COALESCE(r.registration_plate, r.asset_code) ||
            ') ističe ' || to_char(r.first_aid_kit_expires_at, 'DD.MM.YYYY'),
          'asset', r.asset_id, NULL, 0,
          jsonb_build_object('deadline_kind', 'first_aid', 'deadline_date', r.first_aid_kit_expires_at::TEXT, 'asset_code', r.asset_code)
        );
        v_enq := v_enq + 1;
      ELSE v_skip := v_skip + 1; END IF;
    END IF;
  END LOOP;

  /* ── 2. VOZAČI — vozačka, lekarski, lična karta ────────────────────── */
  FOR r IN
    SELECT driver_id, full_name,
           drivers_license_valid_until, medical_check_valid_until, id_card_valid_until
    FROM public.maint_drivers
    WHERE archived_at IS NULL AND active = TRUE
  LOOP
    /* Vozačka */
    IF r.drivers_license_valid_until IS NOT NULL
       AND r.drivers_license_valid_until <= CURRENT_DATE + (p_lookahead_days || ' days')::INTERVAL THEN
      SELECT EXISTS (
        SELECT 1 FROM public.maint_notification_log nl
        WHERE nl.related_entity_type = 'driver' AND nl.related_entity_id = r.driver_id
          AND nl.payload->>'deadline_kind' = 'drivers_license'
          AND nl.payload->>'deadline_date' = r.drivers_license_valid_until::TEXT
          AND nl.status IN ('queued', 'sent')
      ) INTO v_exists;
      IF NOT v_exists THEN
        PERFORM public.maint_enqueue_notification(
          'email'::public.maint_notification_channel, 'pending', NULL,
          'Vozačka ističe: ' || r.full_name,
          'Vozačka dozvola za ' || r.full_name ||
            ' ističe ' || to_char(r.drivers_license_valid_until, 'DD.MM.YYYY'),
          'driver', r.driver_id, NULL, 0,
          jsonb_build_object('deadline_kind', 'drivers_license', 'deadline_date', r.drivers_license_valid_until::TEXT)
        );
        v_enq := v_enq + 1;
      ELSE v_skip := v_skip + 1; END IF;
    END IF;

    /* Lekarski */
    IF r.medical_check_valid_until IS NOT NULL
       AND r.medical_check_valid_until <= CURRENT_DATE + (p_lookahead_days || ' days')::INTERVAL THEN
      SELECT EXISTS (
        SELECT 1 FROM public.maint_notification_log nl
        WHERE nl.related_entity_type = 'driver' AND nl.related_entity_id = r.driver_id
          AND nl.payload->>'deadline_kind' = 'medical'
          AND nl.payload->>'deadline_date' = r.medical_check_valid_until::TEXT
          AND nl.status IN ('queued', 'sent')
      ) INTO v_exists;
      IF NOT v_exists THEN
        PERFORM public.maint_enqueue_notification(
          'email'::public.maint_notification_channel, 'pending', NULL,
          'Lekarski ističe: ' || r.full_name,
          'Lekarski uput za ' || r.full_name ||
            ' ističe ' || to_char(r.medical_check_valid_until, 'DD.MM.YYYY'),
          'driver', r.driver_id, NULL, 0,
          jsonb_build_object('deadline_kind', 'medical', 'deadline_date', r.medical_check_valid_until::TEXT)
        );
        v_enq := v_enq + 1;
      ELSE v_skip := v_skip + 1; END IF;
    END IF;

    /* Lična karta */
    IF r.id_card_valid_until IS NOT NULL
       AND r.id_card_valid_until <= CURRENT_DATE + (p_lookahead_days || ' days')::INTERVAL THEN
      SELECT EXISTS (
        SELECT 1 FROM public.maint_notification_log nl
        WHERE nl.related_entity_type = 'driver' AND nl.related_entity_id = r.driver_id
          AND nl.payload->>'deadline_kind' = 'id_card'
          AND nl.payload->>'deadline_date' = r.id_card_valid_until::TEXT
          AND nl.status IN ('queued', 'sent')
      ) INTO v_exists;
      IF NOT v_exists THEN
        PERFORM public.maint_enqueue_notification(
          'email'::public.maint_notification_channel, 'pending', NULL,
          'Lična karta ističe: ' || r.full_name,
          'Lična karta za ' || r.full_name ||
            ' ističe ' || to_char(r.id_card_valid_until, 'DD.MM.YYYY'),
          'driver', r.driver_id, NULL, 0,
          jsonb_build_object('deadline_kind', 'id_card', 'deadline_date', r.id_card_valid_until::TEXT)
        );
        v_enq := v_enq + 1;
      ELSE v_skip := v_skip + 1; END IF;
    END IF;
  END LOOP;

  /* ── 3. DOKUMENTI sa valid_until (saobraćajna, osiguranje, ...) ────── */
  FOR r IN
    SELECT
      d.document_id, d.entity_type::text AS entity_type, d.entity_id,
      d.file_name, d.category, d.valid_until,
      d.asset_id, d.driver_id
    FROM public.maint_documents d
    WHERE d.deleted_at IS NULL
      AND d.valid_until IS NOT NULL
      AND d.valid_until <= CURRENT_DATE + (p_lookahead_days || ' days')::INTERVAL
  LOOP
    SELECT EXISTS (
      SELECT 1 FROM public.maint_notification_log nl
      WHERE nl.related_entity_type = 'document' AND nl.related_entity_id = r.document_id
        AND nl.payload->>'deadline_kind' = 'document_validity'
        AND nl.payload->>'deadline_date' = r.valid_until::TEXT
        AND nl.status IN ('queued', 'sent')
    ) INTO v_exists;
    IF NOT v_exists THEN
      PERFORM public.maint_enqueue_notification(
        'email'::public.maint_notification_channel, 'pending', NULL,
        'Dokument ističe: ' || COALESCE(r.category, r.file_name),
        'Dokument „' || r.file_name || '"' ||
          CASE WHEN r.category IS NOT NULL THEN ' (' || r.category || ')' ELSE '' END ||
          ' ističe ' || to_char(r.valid_until, 'DD.MM.YYYY'),
        'document', r.document_id, NULL, 0,
        jsonb_build_object(
          'deadline_kind', 'document_validity',
          'deadline_date', r.valid_until::TEXT,
          'doc_entity_type', r.entity_type,
          'doc_category', r.category
        )
      );
      v_enq := v_enq + 1;
    ELSE v_skip := v_skip + 1; END IF;
  END LOOP;

  RETURN QUERY SELECT v_enq, v_skip;
END;
$function$

-- ============ maint_create_preventive_work_order ============
-- KLASA: FRONT-RPC (preventiva → WO)
CREATE OR REPLACE FUNCTION public.maint_create_preventive_work_order(p_task_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_allowed BOOLEAN;
  v_task public.maint_tasks%ROWTYPE;
  v_asset UUID;
  v_asset_type public.maint_asset_type;
  v_existing UUID;
  v_wo UUID;
  v_settings public.maint_settings%ROWTYPE;
BEGIN
  v_allowed := public.maint_is_erp_admin_or_management() OR public.maint_profile_role() IN ('technician', 'chief', 'admin');
  IF NOT v_allowed THEN
    RAISE EXCEPTION 'maint_create_preventive_work_order: not authorized' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_task FROM public.maint_tasks WHERE id = p_task_id AND active = true;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Preventive task not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_task.asset_id IS NOT NULL THEN
    SELECT a.asset_id, a.asset_type INTO v_asset, v_asset_type FROM public.maint_assets a WHERE a.asset_id = v_task.asset_id;
  ELSE
    SELECT m.asset_id, 'machine'::public.maint_asset_type INTO v_asset, v_asset_type FROM public.maint_machines m WHERE m.machine_code = v_task.machine_code LIMIT 1;
  END IF;
  IF v_asset IS NULL THEN
    RAISE EXCEPTION 'Preventive task has no CMMS asset' USING ERRCODE = '23503';
  END IF;
  SELECT wo_id INTO v_existing FROM public.maint_work_orders WHERE source_preventive_task_id = p_task_id AND status <> 'otkazan'::public.maint_wo_status ORDER BY created_at DESC LIMIT 1;
  IF v_existing IS NOT NULL THEN
    RETURN v_existing;
  END IF;
  SELECT * INTO v_settings FROM public.maint_settings WHERE id = 1;
  INSERT INTO public.maint_work_orders (type, asset_id, asset_type, source_preventive_task_id, title, description, priority, status, reported_by, safety_marker, due_at)
  VALUES ('preventive'::public.maint_wo_type, v_asset, v_asset_type, p_task_id, 'Preventiva: ' || v_task.title, v_task.instructions, COALESCE(v_settings.default_wo_priority, 'p4_planirano'::public.maint_wo_priority), 'novi'::public.maint_wo_status, auth.uid(), false, now() + make_interval(days => COALESCE(v_settings.preventive_due_warning_days, 7)))
  RETURNING wo_id INTO v_wo;
  INSERT INTO public.maint_wo_events (wo_id, actor, event_type, comment) VALUES (v_wo, auth.uid(), 'preventive_auto_wo', 'Radni nalog kreiran iz preventivnog roka.');
  RETURN v_wo;
END;
$function$

-- ============ maint_dispatch_fanout ============
-- KLASA: WORKER-RPC (edge maint-notify-dispatch; ⚠ dequeue/mark_sent/mark_failed NE POSTOJE na živoj bazi → pipeline mrtav)
CREATE OR REPLACE FUNCTION public.maint_dispatch_fanout(p_parent_id uuid)
 RETURNS integer
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH parent AS (
    SELECT *
      FROM public.maint_notification_log
     WHERE id = p_parent_id
  ),
  targets AS (
    SELECT p.user_id, p.full_name, p.phone
      FROM public.maint_user_profiles p, parent
     WHERE p.active = true
       AND p.role::text = ANY (
         CASE WHEN (parent.payload->>'severity') = 'critical'
              THEN ARRAY['chief', 'management']
              ELSE ARRAY['chief']
         END
       )
       AND p.phone IS NOT NULL
       AND p.phone <> ''
  ),
  inserted AS (
    INSERT INTO public.maint_notification_log (
      channel, recipient, recipient_user_id, subject, body,
      related_entity_type, related_entity_id, machine_code,
      escalation_level, status, scheduled_at, next_attempt_at, payload
    )
    SELECT
      parent.channel, t.phone, t.user_id, parent.subject, parent.body,
      parent.related_entity_type, parent.related_entity_id, parent.machine_code,
      parent.escalation_level, 'queued', now(), now(),
      coalesce(parent.payload, '{}'::jsonb)
        || jsonb_build_object('fanout_parent', parent.id, 'to_name', t.full_name)
      FROM parent, targets t
    RETURNING 1
  ),
  cnt AS (
    SELECT count(*)::int AS c FROM inserted
  ),
  upd AS (
    UPDATE public.maint_notification_log
       SET status  = 'sent',
           sent_at = now(),
           error   = format('FANOUT_DONE: %s recipients', (SELECT c FROM cnt))
     WHERE id = p_parent_id
       AND EXISTS (SELECT 1 FROM parent)
    RETURNING 1
  )
  SELECT coalesce((SELECT c FROM cnt), 0);
$function$

-- ============ maint_document_visible ============
-- KLASA: POLICY-HELPER (dokumenti po entitetu)
CREATE OR REPLACE FUNCTION public.maint_document_visible(p_entity_type maint_document_entity_type, p_asset_id uuid, p_wo_id uuid, p_incident_id uuid, p_preventive_task_id uuid, p_driver_id uuid DEFAULT NULL::uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT CASE
    WHEN p_asset_id IS NOT NULL THEN public.maint_asset_visible(p_asset_id)
    WHEN p_wo_id IS NOT NULL THEN EXISTS (
      SELECT 1 FROM public.maint_work_orders w
      WHERE w.wo_id = p_wo_id
        AND public.maint_wo_row_visible(w.asset_id, w.assigned_to, w.reported_by)
    )
    WHEN p_incident_id IS NOT NULL THEN EXISTS (
      SELECT 1 FROM public.maint_incidents i
      WHERE i.id = p_incident_id
        AND public.maint_incident_row_visible(i.machine_code, i.asset_id)
    )
    WHEN p_preventive_task_id IS NOT NULL THEN EXISTS (
      SELECT 1 FROM public.maint_tasks t
      JOIN public.maint_machines m ON m.machine_code = t.machine_code
      WHERE t.id = p_preventive_task_id
        AND public.maint_asset_visible(m.asset_id)
    )
    WHEN p_driver_id IS NOT NULL THEN
      -- Dokumenti vozača: vidljivi svima koji imaju floor read access ili maint profile,
      -- plus samom vozaču ako je auth_user povezan
      public.maint_has_floor_read_access()
      OR public.maint_is_erp_admin_or_management()
      OR public.maint_profile_role() IN ('chief', 'admin', 'technician', 'operator')
      OR EXISTS (
        SELECT 1 FROM public.maint_drivers d
         WHERE d.driver_id = p_driver_id
           AND d.auth_user_id = auth.uid()
      )
    ELSE FALSE
  END;
$function$

-- ============ maint_enqueue_notification ============
-- KLASA: DB-INTERNAL (pozivaju trigeri + cron)
CREATE OR REPLACE FUNCTION public.maint_enqueue_notification(p_channel maint_notification_channel, p_recipient text, p_recipient_user_id uuid, p_subject text, p_body text, p_related_entity_type text, p_related_entity_id uuid, p_machine_code text, p_escalation_level integer DEFAULT 0, p_payload jsonb DEFAULT NULL::jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_id UUID;
BEGIN
  INSERT INTO public.maint_notification_log (
    channel, recipient, recipient_user_id, subject, body,
    related_entity_type, related_entity_id, machine_code,
    escalation_level, status, scheduled_at, next_attempt_at, payload
  ) VALUES (
    p_channel,
    coalesce(p_recipient, 'pending'),
    p_recipient_user_id,
    p_subject,
    p_body,
    p_related_entity_type,
    p_related_entity_id,
    p_machine_code,
    coalesce(p_escalation_level, 0),
    'queued',
    now(), now(),
    p_payload
  )
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$function$

-- ============ maint_facility_details_guard ============
-- KLASA: TRIGGER (guard asset_type=facility)
CREATE OR REPLACE FUNCTION public.maint_facility_details_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.maint_assets a
    WHERE a.asset_id = NEW.asset_id
      AND a.asset_type = 'facility'::public.maint_asset_type
  ) THEN
    RAISE EXCEPTION 'maint_facility_details.asset_id must reference a facility asset'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$

-- ============ maint_has_floor_read_access ============
-- KLASA: POLICY-HELPER (globalne role po EMAIL-u)
CREATE OR REPLACE FUNCTION public.maint_has_floor_read_access()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT public.maint_is_erp_admin()
    OR EXISTS (
      SELECT 1
      FROM public.user_roles ur
      WHERE ur.is_active = true
        AND ur.project_id IS NULL
        AND lower(ur.email) = lower(coalesce(auth.jwt()->>'email', ''))
        AND lower(ur.role::text) IN ('admin', 'pm', 'leadpm', 'menadzment', 'magacioner', 'monter', 'tim_lider')
    );
$function$

-- ============ maint_incident_row_visible ============
-- KLASA: POLICY-HELPER
CREATE OR REPLACE FUNCTION public.maint_incident_row_visible(p_machine_code text, p_asset_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT CASE
    WHEN p_asset_id IS NOT NULL THEN public.maint_asset_visible(p_asset_id)
    ELSE public.maint_machine_visible(p_machine_code)
  END;
$function$

-- ============ maint_incidents_autocreate_work_order ============
-- KLASA: TRIGGER (major/critical/safety → auto WO)
CREATE OR REPLACE FUNCTION public.maint_incidents_autocreate_work_order()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_asset UUID;
  v_tcode public.maint_asset_type;
  v_pri public.maint_wo_priority;
  v_st public.maint_wo_status;
  v_t public.maint_wo_type := 'incident';
  v_wo UUID;
  v_settings public.maint_settings%ROWTYPE;
  v_safety BOOLEAN := COALESCE(NEW.safety_marker, false);
  v_due_hours INT;
BEGIN
  IF NEW.work_order_id IS NOT NULL THEN
    RETURN NEW;
  END IF;
  SELECT * INTO v_settings FROM public.maint_settings WHERE id = 1;
  IF NOT FOUND THEN
    v_settings.auto_create_wo_major := true;
    v_settings.auto_create_wo_critical := true;
    v_settings.safety_marker_requires_wo := true;
    v_settings.default_wo_priority := 'p4_planirano'::public.maint_wo_priority;
    v_settings.major_wo_due_hours := 48;
    v_settings.critical_wo_due_hours := 8;
  END IF;
  IF NOT ((NEW.severity = 'critical' AND COALESCE(v_settings.auto_create_wo_critical, true)) OR (NEW.severity = 'major' AND COALESCE(v_settings.auto_create_wo_major, true)) OR (v_safety AND COALESCE(v_settings.safety_marker_requires_wo, true))) THEN
    RETURN NEW;
  END IF;
  IF NEW.asset_id IS NOT NULL THEN
    SELECT a.asset_id, a.asset_type INTO v_asset, v_tcode FROM public.maint_assets a WHERE a.asset_id = NEW.asset_id;
  ELSE
    SELECT m.asset_id, 'machine'::public.maint_asset_type INTO v_asset, v_tcode FROM public.maint_machines m WHERE m.machine_code = NEW.machine_code LIMIT 1;
  END IF;
  IF v_asset IS NULL THEN
    RETURN NEW;
  END IF;
  v_pri := CASE WHEN NEW.severity = 'critical' OR v_safety THEN 'p1_zastoj'::public.maint_wo_priority WHEN NEW.severity = 'major' THEN COALESCE(v_settings.default_wo_priority, 'p2_smetnja'::public.maint_wo_priority) ELSE COALESCE(v_settings.default_wo_priority, 'p4_planirano'::public.maint_wo_priority) END;
  v_st := CASE NEW.severity WHEN 'critical' THEN 'potvrden'::public.maint_wo_status ELSE 'novi'::public.maint_wo_status END;
  v_due_hours := CASE WHEN NEW.severity = 'critical' OR v_safety THEN COALESCE(v_settings.critical_wo_due_hours, 8) ELSE COALESCE(v_settings.major_wo_due_hours, 48) END;
  INSERT INTO public.maint_work_orders (type, asset_id, asset_type, source_incident_id, title, description, priority, status, reported_by, assigned_to, safety_marker, due_at)
  VALUES (v_t, v_asset, v_tcode, NEW.id, NEW.title, NEW.description, v_pri, v_st, NEW.reported_by, NEW.assigned_to, v_safety, now() + make_interval(hours => v_due_hours))
  RETURNING wo_id INTO v_wo;
  UPDATE public.maint_incidents SET work_order_id = v_wo WHERE id = NEW.id;
  RETURN NEW;
END;
$function$

-- ============ maint_incidents_enqueue_notify ============
-- KLASA: TRIGGER (major/critical → outbox)
CREATE OR REPLACE FUNCTION public.maint_incidents_enqueue_notify()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_subject TEXT;
  v_body TEXT;
  v_settings public.maint_settings%ROWTYPE;
  v_have_settings BOOLEAN := false;
  v_rule RECORD;
  v_asset_type public.maint_asset_type;
  v_count INT := 0;
  v_notification_id UUID;
BEGIN
  SELECT * INTO v_settings FROM public.maint_settings WHERE id = 1;
  v_have_settings := FOUND;
  IF v_have_settings AND COALESCE(v_settings.notification_enabled, true) IS FALSE THEN RETURN NEW; END IF;
  IF NEW.severity = 'major' AND v_have_settings AND COALESCE(v_settings.notify_on_major_incident, true) IS FALSE THEN RETURN NEW; END IF;
  IF NEW.severity = 'critical' AND v_have_settings AND COALESCE(v_settings.notify_on_critical_incident, true) IS FALSE THEN RETURN NEW; END IF;
  IF NEW.severity NOT IN ('major', 'critical') THEN RETURN NEW; END IF;
  v_asset_type := NEW.asset_type;
  v_subject := format('[Održavanje] %s incident: %s', upper(NEW.severity::text), NEW.title);
  v_body := format('Sredstvo %s — %s (%s). Status: %s.', COALESCE(NEW.machine_code, NEW.asset_id::text, '—'), NEW.title, NEW.severity, NEW.status);
  FOR v_rule IN SELECT * FROM public.maint_notification_rules r WHERE r.enabled AND r.event_type = 'incident_created' AND (r.severity IS NULL OR r.severity = NEW.severity::text) AND (r.asset_type IS NULL OR r.asset_type = v_asset_type) AND (NOT v_have_settings OR v_settings.notification_channels IS NULL OR r.channel = ANY(v_settings.notification_channels)) ORDER BY r.escalation_level ASC, r.delay_minutes ASC
  LOOP
    v_notification_id := public.maint_enqueue_notification(v_rule.channel, NULL, NULL, v_subject, v_body, 'maint_incident', NEW.id, NEW.machine_code, v_rule.escalation_level, jsonb_build_object('severity', NEW.severity, 'reported_by', NEW.reported_by, 'assigned_to', NEW.assigned_to, 'target_role', v_rule.target_role, 'rule_id', v_rule.rule_id));
    UPDATE public.maint_notification_log SET scheduled_at = now() + make_interval(mins => COALESCE(v_rule.delay_minutes, 0)), next_attempt_at = now() + make_interval(mins => COALESCE(v_rule.delay_minutes, 0)) WHERE id = v_notification_id;
    v_count := v_count + 1;
  END LOOP;
  IF v_count = 0 THEN
    PERFORM public.maint_enqueue_notification('in_app'::public.maint_notification_channel, NULL, NULL, v_subject, v_body, 'maint_incident', NEW.id, NEW.machine_code, 0, jsonb_build_object('severity', NEW.severity, 'reported_by', NEW.reported_by, 'assigned_to', NEW.assigned_to));
  END IF;
  RETURN NEW;
END;
$function$

-- ============ maint_incidents_log_changes ============
-- KLASA: TRIGGER (audit events)
CREATE OR REPLACE FUNCTION public.maint_incidents_log_changes()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_actor uuid;
BEGIN
  v_actor := auth.uid();

  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.maint_incident_events (incident_id, actor, event_type, from_value, to_value, comment)
    VALUES (NEW.id, v_actor, 'created', NULL, NEW.status::text, NULL);
    RETURN NEW;
  END IF;

  IF OLD.status IS DISTINCT FROM NEW.status THEN
    INSERT INTO public.maint_incident_events (incident_id, actor, event_type, from_value, to_value, comment)
    VALUES (NEW.id, v_actor, 'status_change', OLD.status::text, NEW.status::text, NULL);
  END IF;

  IF OLD.assigned_to IS DISTINCT FROM NEW.assigned_to THEN
    INSERT INTO public.maint_incident_events (incident_id, actor, event_type, from_value, to_value, comment)
    VALUES (
      NEW.id,
      v_actor,
      'assigned',
      OLD.assigned_to::text,
      NEW.assigned_to::text,
      NULL
    );
  END IF;

  RETURN NEW;
END;
$function$

-- ============ maint_incidents_set_asset_fields ============
-- KLASA: TRIGGER (denormalizacija asset_id/type)
CREATE OR REPLACE FUNCTION public.maint_incidents_set_asset_fields()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_asset public.maint_assets%ROWTYPE;
BEGIN
  IF NEW.asset_id IS NULL THEN
    SELECT a.* INTO v_asset
    FROM public.maint_machines m
    JOIN public.maint_assets a ON a.asset_id = m.asset_id
    WHERE m.machine_code = NEW.machine_code
    LIMIT 1;
  ELSE
    SELECT a.* INTO v_asset
    FROM public.maint_assets a
    WHERE a.asset_id = NEW.asset_id
    LIMIT 1;
  END IF;

  IF v_asset.asset_id IS NOT NULL THEN
    NEW.asset_id := v_asset.asset_id;
    NEW.asset_type := v_asset.asset_type;
    IF NEW.machine_code IS NULL OR length(btrim(NEW.machine_code)) = 0 THEN
      NEW.machine_code := v_asset.asset_code;
    END IF;
  END IF;

  RETURN NEW;
END;
$function$

-- ============ maint_is_erp_admin ============
-- KLASA: POLICY-HELPER (user_roles admin po EMAIL-u)
CREATE OR REPLACE FUNCTION public.maint_is_erp_admin()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM public.user_roles ur
    WHERE ur.is_active = true
      AND ur.project_id IS NULL
      AND lower(ur.email) = lower(coalesce(auth.jwt()->>'email', ''))
      AND lower(ur.role::text) = 'admin'
  );
$function$

-- ============ maint_is_erp_admin_or_management ============
-- KLASA: POLICY-HELPER (admin/menadzment/MAGACIONER po EMAIL-u)
CREATE OR REPLACE FUNCTION public.maint_is_erp_admin_or_management()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM public.user_roles ur
    WHERE ur.is_active = true
      AND ur.project_id IS NULL
      AND lower(ur.email) = lower(coalesce(auth.jwt()->>'email', ''))
      AND lower(ur.role::text) IN ('admin', 'menadzment', 'magacioner')
  );
$function$

-- ============ maint_it_asset_details_guard ============
-- KLASA: TRIGGER (guard asset_type=it)
CREATE OR REPLACE FUNCTION public.maint_it_asset_details_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.maint_assets a
    WHERE a.asset_id = NEW.asset_id
      AND a.asset_type = 'it'::public.maint_asset_type
  ) THEN
    RAISE EXCEPTION 'maint_it_asset_details.asset_id must reference an IT asset'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$

-- ============ maint_machine_delete_hard ============
-- KLASA: FRONT-RPC (hard delete + audit log)
CREATE OR REPLACE FUNCTION public.maint_machine_delete_hard(p_code text, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_allowed   BOOLEAN;
  v_row       public.maint_machines%ROWTYPE;
  v_counts    JSONB;
  v_email     TEXT;
  v_clean_code TEXT;
  v_clean_reason TEXT;
BEGIN
  v_clean_code   := trim(coalesce(p_code, ''));
  v_clean_reason := trim(coalesce(p_reason, ''));

  v_allowed := public.maint_is_erp_admin()
            OR public.maint_is_erp_admin_or_management()
            OR public.maint_profile_role() IN ('chief', 'admin');
  IF NOT v_allowed THEN
    RAISE EXCEPTION 'maint_machine_delete_hard: not authorized'
      USING ERRCODE = '42501';
  END IF;

  IF v_clean_code = '' THEN
    RAISE EXCEPTION 'maint_machine_delete_hard: machine_code je obavezan'
      USING ERRCODE = '22023';
  END IF;
  IF length(v_clean_reason) < 5 THEN
    RAISE EXCEPTION 'maint_machine_delete_hard: razlog je obavezan (min 5 karaktera)'
      USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_row
  FROM public.maint_machines
  WHERE machine_code = v_clean_code;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'maint_machine_delete_hard: masina % ne postoji u katalogu', v_clean_code
      USING ERRCODE = 'P0002';
  END IF;

  SELECT jsonb_build_object(
    'tasks',     (SELECT count(*)::int FROM public.maint_tasks                  WHERE machine_code = v_clean_code),
    'checks',    (SELECT count(*)::int FROM public.maint_checks                 WHERE machine_code = v_clean_code),
    'incidents', (SELECT count(*)::int FROM public.maint_incidents              WHERE machine_code = v_clean_code),
    'notes',     (SELECT count(*)::int FROM public.maint_machine_notes          WHERE machine_code = v_clean_code),
    'files',     (SELECT count(*)::int FROM public.maint_machine_files          WHERE machine_code = v_clean_code AND deleted_at IS NULL),
    'override',  (SELECT count(*)::int FROM public.maint_machine_status_override WHERE machine_code = v_clean_code)
  ) INTO v_counts;

  v_email := coalesce(auth.jwt()->>'email', '');

  INSERT INTO public.maint_machines_deletion_log (
    machine_code, machine_name, snapshot, related_counts,
    reason, deleted_by, deleted_by_email
  ) VALUES (
    v_clean_code,
    v_row.name,
    to_jsonb(v_row),
    v_counts,
    v_clean_reason,
    auth.uid(),
    v_email
  );

  DELETE FROM public.maint_incident_events
    WHERE incident_id IN (SELECT id FROM public.maint_incidents WHERE machine_code = v_clean_code);
  DELETE FROM public.maint_incidents              WHERE machine_code = v_clean_code;
  DELETE FROM public.maint_checks                 WHERE machine_code = v_clean_code;
  DELETE FROM public.maint_tasks                  WHERE machine_code = v_clean_code;
  DELETE FROM public.maint_machine_notes          WHERE machine_code = v_clean_code;
  DELETE FROM public.maint_machine_files          WHERE machine_code = v_clean_code;
  DELETE FROM public.maint_machine_status_override WHERE machine_code = v_clean_code;

  DELETE FROM public.maint_machines WHERE machine_code = v_clean_code;

  RETURN jsonb_build_object(
    'ok', true,
    'machine_code', v_clean_code,
    'machine_name', v_row.name,
    'related',      v_counts,
    'deleted_at',   now()
  );
END;
$function$

-- ============ maint_machine_dept_code ============
-- KLASA: DB-INTERNAL (mapiranje mašina → M.* hala, loc sync)
CREATE OR REPLACE FUNCTION public.maint_machine_dept_code(p_machine_code text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT CASE
    WHEN p_machine_code IS NULL OR length(trim(p_machine_code)) = 0 THEN 'M.OST'
    /* Sečenje i savijanje */
    WHEN p_machine_code IN ('1.10','1.2','1.30','1.40','1.50','1.60','1.71','1.72') THEN 'M.SEC'
    /* Bravarsko */
    WHEN p_machine_code IN ('4.1','4.11','4.12','4.2','4.3','4.4') THEN 'M.BRA'
    /* Farbanje (5.1–5.8 + 5.11) — 5.9 i 5.10 idu u Ostalo */
    WHEN p_machine_code IN ('5.1','5.2','5.3','5.4','5.5','5.6','5.7','5.8','5.11') THEN 'M.FAR'
    /* CAM */
    WHEN p_machine_code IN ('17.0','17.1') THEN 'M.CAM'
    /* Ažistiranje — samo 8.2 */
    WHEN p_machine_code = '8.2' THEN 'M.AZI'
    /* Erodiranje */
    WHEN p_machine_code IN ('10.1','10.2','10.3','10.4','10.5') THEN 'M.ERO'
    /* Brušenje: prefiks 6 osim 6.8 */
    WHEN p_machine_code LIKE '6.%' AND p_machine_code <> '6.8' THEN 'M.BRU'
    WHEN p_machine_code = '6' THEN 'M.BRU'
    /* Glodanje: prefiks 3 */
    WHEN p_machine_code LIKE '3.%' OR p_machine_code = '3' THEN 'M.GLO'
    /* Struganje: prefiks 2 osim 21.x (3D štampa) */
    WHEN (p_machine_code LIKE '2.%' OR p_machine_code = '2')
         AND p_machine_code NOT LIKE '21.%' AND p_machine_code <> '21' THEN 'M.STR'
    /* Sve ostalo */
    ELSE 'M.OST'
  END
$function$

-- ============ maint_machine_rename ============
-- KLASA: FRONT-RPC (atomski rename PK kroz 6 tabela)
CREATE OR REPLACE FUNCTION public.maint_machine_rename(p_old_code text, p_new_code text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_allowed    BOOLEAN;
  v_cnt_tasks  INT := 0;
  v_cnt_checks INT := 0;
  v_cnt_inc    INT := 0;
  v_cnt_notes  INT := 0;
  v_cnt_ovr    INT := 0;
  v_cnt_notif  INT := 0;
BEGIN
  v_allowed := public.maint_is_erp_admin()
            OR public.maint_profile_role() IN ('chief', 'admin');
  IF NOT v_allowed THEN
    RAISE EXCEPTION 'maint_machine_rename: not authorized' USING ERRCODE = '42501';
  END IF;

  IF p_old_code IS NULL OR btrim(p_old_code) = '' THEN
    RAISE EXCEPTION 'maint_machine_rename: old code is required';
  END IF;
  IF p_new_code IS NULL OR btrim(p_new_code) = '' THEN
    RAISE EXCEPTION 'maint_machine_rename: new code is required';
  END IF;
  IF p_old_code = p_new_code THEN
    RAISE EXCEPTION 'maint_machine_rename: old and new codes are the same';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.maint_machines WHERE machine_code = p_old_code) THEN
    RAISE EXCEPTION 'maint_machine_rename: machine "%" does not exist', p_old_code;
  END IF;
  IF EXISTS (SELECT 1 FROM public.maint_machines WHERE machine_code = p_new_code) THEN
    RAISE EXCEPTION 'maint_machine_rename: machine "%" already exists', p_new_code;
  END IF;

  /* 1) Kreiraj novi katalog red kao KOPIJU starog (isti metapodaci,
        source beleži poreklo, updated_by = trenutni korisnik). Izbegavamo
        direktan UPDATE PK da bi child redovi u sledećim koracima uspeli da
        nađu novi red (iako nemamo FK). */
  INSERT INTO public.maint_machines (
    machine_code, name, type, manufacturer, model, serial_number,
    year_of_manufacture, year_commissioned, location, department_id,
    power_kw, weight_kg, notes, tracked, archived_at, source,
    created_at, updated_at, updated_by
  )
  SELECT
    p_new_code, name, type, manufacturer, model, serial_number,
    year_of_manufacture, year_commissioned, location, department_id,
    power_kw, weight_kg, notes, tracked, archived_at, source,
    created_at, now(), auth.uid()
  FROM public.maint_machines
  WHERE machine_code = p_old_code;

  /* 2) Prebaci sve reference. Redosled nije bitan jer ne postoje FK, ali
        držimo ga konzistentnim radi čitljivosti.
        GET DIAGNOSTICS ROW_COUNT je portabilniji od CTE+count i ne pravi
        probleme pri plpgsql varijable-vs-relacija parsiranju. */
  UPDATE public.maint_tasks SET machine_code = p_new_code
   WHERE machine_code = p_old_code;
  GET DIAGNOSTICS v_cnt_tasks = ROW_COUNT;

  UPDATE public.maint_checks SET machine_code = p_new_code
   WHERE machine_code = p_old_code;
  GET DIAGNOSTICS v_cnt_checks = ROW_COUNT;

  UPDATE public.maint_incidents SET machine_code = p_new_code
   WHERE machine_code = p_old_code;
  GET DIAGNOSTICS v_cnt_inc = ROW_COUNT;

  UPDATE public.maint_machine_notes SET machine_code = p_new_code
   WHERE machine_code = p_old_code;
  GET DIAGNOSTICS v_cnt_notes = ROW_COUNT;

  UPDATE public.maint_machine_status_override SET machine_code = p_new_code
   WHERE machine_code = p_old_code;
  GET DIAGNOSTICS v_cnt_ovr = ROW_COUNT;

  UPDATE public.maint_notification_log SET machine_code = p_new_code
   WHERE machine_code = p_old_code;
  GET DIAGNOSTICS v_cnt_notif = ROW_COUNT;

  /* 3) Obriši stari katalog red. */
  DELETE FROM public.maint_machines WHERE machine_code = p_old_code;

  RETURN jsonb_build_object(
    'old_code',     p_old_code,
    'new_code',     p_new_code,
    'tasks',        v_cnt_tasks,
    'checks',       v_cnt_checks,
    'incidents',    v_cnt_inc,
    'notes',        v_cnt_notes,
    'overrides',    v_cnt_ovr,
    'notifications', v_cnt_notif
  );
END;
$function$

-- ============ maint_machine_visible ============
-- KLASA: POLICY-HELPER (jezgro machine-scope)
CREATE OR REPLACE FUNCTION public.maint_machine_visible(p_machine_code text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT public.maint_has_floor_read_access()
    OR public.maint_profile_role() IN ('chief', 'technician', 'management', 'admin')
    OR (
      public.maint_profile_role() = 'operator'
      AND coalesce(cardinality(public.maint_assigned_machine_codes()), 0) > 0
      AND p_machine_code = ANY (public.maint_assigned_machine_codes())
    );
$function$

-- ============ maint_machines_ensure_asset ============
-- KLASA: TRIGGER (mašina → maint_assets red + qr_token)
CREATE OR REPLACE FUNCTION public.maint_machines_ensure_asset()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_id uuid;
BEGIN
  IF NEW.asset_id IS NOT NULL THEN
    RETURN NEW;
  END IF;
  SELECT a.asset_id INTO v_id
  FROM public.maint_assets a
  WHERE lower(a.asset_code) = lower(NEW.machine_code)
    AND a.asset_type = 'machine'
  LIMIT 1;
  IF v_id IS NOT NULL THEN
    NEW.asset_id := v_id;
    RETURN NEW;
  END IF;
  INSERT INTO public.maint_assets (
    asset_code,
    asset_type,
    name,
    status,
    responsible_user_id,
    manufacturer,
    model,
    serial_number,
    notes,
    active,
    archived_at,
    qr_token,
    created_at,
    updated_at
  ) VALUES (
    NEW.machine_code,
    'machine',
    NEW.name,
    'running',
    NEW.responsible_user_id,
    NEW.manufacturer,
    NEW.model,
    NEW.serial_number,
    NEW.notes,
    (NEW.archived_at IS NULL),
    NEW.archived_at,
    gen_random_uuid()::text,
    COALESCE(NEW.created_at, now()),
    COALESCE(NEW.updated_at, now())
  )
  RETURNING asset_id INTO v_id;
  NEW.asset_id := v_id;
  RETURN NEW;
END;
$function$

-- ============ maint_machines_import_from_cache ============
-- KLASA: FRONT-RPC (uvoz iz bigtehn_machines_cache)
CREATE OR REPLACE FUNCTION public.maint_machines_import_from_cache(p_codes text[])
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_allowed BOOLEAN;
  v_count   INT := 0;
BEGIN
  v_allowed := public.maint_is_erp_admin()
            OR public.maint_profile_role() IN ('chief', 'admin');
  IF NOT v_allowed THEN
    RAISE EXCEPTION 'maint_machines_import_from_cache: not authorized' USING ERRCODE = '42501';
  END IF;

  IF p_codes IS NULL OR cardinality(p_codes) = 0 THEN
    RETURN 0;
  END IF;

  INSERT INTO public.maint_machines (
    machine_code, name, department_id, source, tracked, archived_at, updated_by
  )
  SELECT
    c.rj_code,
    COALESCE(NULLIF(TRIM(c.name), ''), c.rj_code),
    c.department_id,
    'bigtehn',
    TRUE,
    NULL,
    auth.uid()
  FROM public.bigtehn_machines_cache c
  WHERE c.rj_code = ANY (p_codes)
  ON CONFLICT (machine_code) DO NOTHING;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$function$

-- ============ maint_machines_sync_to_loc ============
-- KLASA: TRIGGER (most ka loc_locations MACHINE redovima!)
CREATE OR REPLACE FUNCTION public.maint_machines_sync_to_loc()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_parent_id  UUID;
  v_dept_code  TEXT;
  v_should_be_active BOOLEAN;
BEGIN
  IF TG_OP = 'INSERT' THEN
    /* Upiši samo aktivne, praćene mašine (isto pravilo kao postojeći seed). */
    IF NEW.archived_at IS NOT NULL OR NEW.tracked = FALSE THEN
      RETURN NEW;
    END IF;
    IF NEW.machine_code IS NULL OR length(trim(NEW.machine_code)) = 0 THEN
      RETURN NEW;
    END IF;

    v_dept_code := public.maint_machine_dept_code(NEW.machine_code);

    SELECT id INTO v_parent_id
      FROM public.loc_locations
     WHERE location_code = v_dept_code
     LIMIT 1;

    /* Ako fallback hala iz nekog razloga ne postoji, ne diži exception u
     * INSERT-u maint_machines — samo upozori. UI bi inače pao na nečemu što
     * nema veze sa korisnikom. */
    IF v_parent_id IS NULL THEN
      RAISE WARNING
        'maint_machines_sync_to_loc: dept hala % ne postoji za mašinu %; preskačem loc_locations sync.',
        v_dept_code, NEW.machine_code;
      RETURN NEW;
    END IF;

    INSERT INTO public.loc_locations
      (location_code, name, location_type, parent_id, is_active, notes)
    VALUES
      (NEW.machine_code,
       COALESCE(NULLIF(trim(NEW.name), ''), 'Mašina ' || NEW.machine_code),
       'MACHINE'::public.loc_type_enum,
       v_parent_id,
       TRUE,
       'Auto-sync iz maint_machines (Faza 2 trigger).')
    ON CONFLICT DO NOTHING;

    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    /* Promene koje pratimo: name, archived_at, tracked. machine_code (PK)
     * ne pratimo — rename se radi kroz `renameMaintMachine` RPC koji NE
     * dira loc_locations (dokumentovano u header-u migracije). */
    IF NEW.machine_code IS NULL OR length(trim(NEW.machine_code)) = 0 THEN
      RETURN NEW;
    END IF;

    v_should_be_active := (NEW.archived_at IS NULL AND NEW.tracked <> FALSE);

    /* Ako red u loc_locations ne postoji, a mašina je sada aktivna —
     * tretiraj kao INSERT (npr. mašina je bila netracked pa je vraćena). */
    IF NOT EXISTS (
      SELECT 1 FROM public.loc_locations WHERE location_code = NEW.machine_code
    ) THEN
      IF v_should_be_active THEN
        v_dept_code := public.maint_machine_dept_code(NEW.machine_code);
        SELECT id INTO v_parent_id
          FROM public.loc_locations
         WHERE location_code = v_dept_code
         LIMIT 1;
        IF v_parent_id IS NOT NULL THEN
          INSERT INTO public.loc_locations
            (location_code, name, location_type, parent_id, is_active, notes)
          VALUES
            (NEW.machine_code,
             COALESCE(NULLIF(trim(NEW.name), ''), 'Mašina ' || NEW.machine_code),
             'MACHINE'::public.loc_type_enum,
             v_parent_id,
             TRUE,
             'Auto-sync iz maint_machines (UPDATE → INSERT, Faza 2 trigger).')
          ON CONFLICT DO NOTHING;
        END IF;
      END IF;
      RETURN NEW;
    END IF;

    /* Postoji — ažuriraj name + is_active. NULLIF/COALESCE da praznu vrednost
     * ne pretvorimo u prazan string. */
    UPDATE public.loc_locations
       SET name = COALESCE(NULLIF(trim(NEW.name), ''), name),
           is_active = v_should_be_active
     WHERE location_code = NEW.machine_code
       AND (
            name IS DISTINCT FROM COALESCE(NULLIF(trim(NEW.name), ''), name)
         OR is_active IS DISTINCT FROM v_should_be_active
       );

    RETURN NEW;
  END IF;

  RETURN NEW;
END;
$function$

-- ============ maint_normalize_name ============
-- KLASA: DB-INTERNAL (tokenizacija imena)
CREATE OR REPLACE FUNCTION public.maint_normalize_name(p_name text)
 RETURNS text[]
 LANGUAGE sql
 IMMUTABLE
AS $function$
  SELECT array_agg(t ORDER BY t)
  FROM (
    SELECT DISTINCT t
    FROM unnest(
      regexp_split_to_array(
        translate(
          replace(lower(coalesce(p_name, '')), 'dj', 'd'),
          'čćžšđ', 'cczsd'
        ),
        '\s+'
      )
    ) AS t
    WHERE length(trim(t)) > 0
  ) toks;
$function$

-- ============ maint_notification_retry ============
-- KLASA: FRONT-RPC (failed → queued)
CREATE OR REPLACE FUNCTION public.maint_notification_retry(p_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_allowed BOOLEAN;
BEGIN
  v_allowed := public.maint_is_erp_admin()
            OR public.maint_profile_role() IN ('chief', 'admin');
  IF NOT v_allowed THEN
    RAISE EXCEPTION 'maint_notification_retry: not authorized' USING ERRCODE = '42501';
  END IF;

  UPDATE public.maint_notification_log
     SET status          = 'queued',
         error           = NULL,
         next_attempt_at = now(),
         /* Spusti attempts na max-1 = 7 ako je dostigao plafon, inače zadrži. */
         attempts        = LEAST(attempts, 7)
   WHERE id = p_id;

  RETURN FOUND;
END;
$function$

-- ============ maint_profile_role ============
-- KLASA: POLICY-HELPER (maint_user_profiles po auth.uid()!)
CREATE OR REPLACE FUNCTION public.maint_profile_role()
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT p.role::text
  FROM public.maint_user_profiles p
  WHERE p.user_id = auth.uid() AND p.active = true
  LIMIT 1;
$function$

-- ============ maint_profiles_guard_role ============
-- KLASA: TRIGGER (SoD: role/active menja SAMO ERP admin)
CREATE OR REPLACE FUNCTION public.maint_profiles_guard_role()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  if (new.role is distinct from old.role or new.active is distinct from old.active)
     and not public.maint_is_erp_admin() then
    raise exception 'permission_denied'
      using errcode='42501',
            hint='Samo ERP admin sme da menja role/active u maint_user_profiles.';
  end if;
  return new;
end $function$

-- ============ maint_vehicle_details_guard ============
-- KLASA: TRIGGER (guard asset_type=vehicle)
CREATE OR REPLACE FUNCTION public.maint_vehicle_details_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.maint_assets a
    WHERE a.asset_id = NEW.asset_id
      AND a.asset_type = 'vehicle'::public.maint_asset_type
  ) THEN
    RAISE EXCEPTION 'maint_vehicle_details.asset_id must reference a vehicle asset'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$

-- ============ maint_wo_log_field_changes ============
-- KLASA: TRIGGER (audit WO polja)
CREATE OR REPLACE FUNCTION public.maint_wo_log_field_changes()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  u uuid;
BEGIN
  u := auth.uid();
  IF TG_OP <> 'UPDATE' THEN
    RETURN NEW;
  END IF;
  IF OLD.status IS DISTINCT FROM NEW.status THEN
    INSERT INTO public.maint_wo_events (wo_id, actor, at, event_type, from_value, to_value, comment)
    VALUES (NEW.wo_id, u, now(), 'status_change', OLD.status::text, NEW.status::text, NULL);
  END IF;
  IF OLD.assigned_to IS DISTINCT FROM NEW.assigned_to THEN
    INSERT INTO public.maint_wo_events (wo_id, actor, at, event_type, from_value, to_value, comment)
    VALUES (NEW.wo_id, u, now(), 'assigned_change', OLD.assigned_to::text, NEW.assigned_to::text, NULL);
  END IF;
  IF OLD.priority IS DISTINCT FROM NEW.priority THEN
    INSERT INTO public.maint_wo_events (wo_id, actor, at, event_type, from_value, to_value, comment)
    VALUES (NEW.wo_id, u, now(), 'priority_change', OLD.priority::text, NEW.priority::text, NULL);
  END IF;
  RETURN NEW;
END;
$function$

-- ============ maint_wo_row_visible ============
-- KLASA: POLICY-HELPER (assigned/reported/asset-visible)
CREATE OR REPLACE FUNCTION public.maint_wo_row_visible(p_asset_id uuid, p_assigned uuid, p_reported uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT p_assigned IS NOT NULL AND p_assigned = auth.uid()
      OR p_reported IS NOT NULL AND p_reported = auth.uid()
      OR public.maint_asset_visible(p_asset_id);
$function$

-- ============ maint_wo_service_plan_completion ============
-- KLASA: TRIGGER (WO zavrsen → vehicle plan last_done)
CREATE OR REPLACE FUNCTION public.maint_wo_service_plan_completion()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  -- Kad se WO sa service_plan_id završi (transition na 'zavrsen'),
  -- automatski ažuriramo last_done_at i last_done_km u plan stavci.
  IF NEW.service_plan_id IS NOT NULL
     AND NEW.status = 'zavrsen'
     AND (OLD.status IS DISTINCT FROM NEW.status) THEN
    UPDATE public.maint_vehicle_service_plan
       SET last_done_at = COALESCE(NEW.completed_at::DATE, CURRENT_DATE),
           last_done_km = COALESCE(NEW.odometer_km_at_service, last_done_km),
           updated_at = now(),
           updated_by = NEW.updated_by
     WHERE plan_id = NEW.service_plan_id;
  END IF;
  RETURN NEW;
END;
$function$

-- ============ maint_work_orders_assign_wo_number ============
-- KLASA: TRIGGER (WO-YYYY-NNNNN counter)
CREATE OR REPLACE FUNCTION public.maint_work_orders_assign_wo_number()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  y   INT;
  n   INT;
  lbl TEXT;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RETURN NEW;
  END IF;
  IF NEW.wo_number IS NOT NULL AND length(btrim(NEW.wo_number)) > 0 THEN
    RETURN NEW;
  END IF;
  y := EXTRACT(YEAR FROM COALESCE(NEW.created_at, now()))::INT;

  INSERT INTO public.maint_wo_number_counter (year, last_value)
  VALUES (y, 1)
  ON CONFLICT (year) DO UPDATE
  SET last_value = public.maint_wo_number_counter.last_value + 1
  RETURNING last_value INTO n;

  lbl := lpad(n::text, 5, '0');
  NEW.wo_number := 'WO-' || y::text || '-' || lbl;
  RETURN NEW;
END;
$function$

-- ============ restore_maint_asset ============
-- KLASA: FRONT-RPC
CREATE OR REPLACE FUNCTION public.restore_maint_asset(p_asset_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_found INTEGER;
BEGIN
  IF NOT (public.maint_is_erp_admin_or_management()
       OR public.maint_profile_role() IN ('chief', 'admin')) THEN
    RAISE EXCEPTION 'Nemaš ovlašćenje za vraćanje sredstva u upotrebu';
  END IF;

  UPDATE public.maint_assets
     SET archived_at    = NULL,
         archive_reason = NULL,
         archived_by    = NULL,
         active         = TRUE,
         updated_by     = auth.uid(),
         updated_at     = now()
   WHERE asset_id   = p_asset_id
     AND asset_type IN ('it', 'facility');

  GET DIAGNOSTICS v_found = ROW_COUNT;
  RETURN v_found > 0;
END;
$function$

-- ============ restore_maint_vehicle ============
-- KLASA: FRONT-RPC
CREATE OR REPLACE FUNCTION public.restore_maint_vehicle(p_asset_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_found INTEGER;
BEGIN
  IF NOT (public.maint_is_erp_admin_or_management()
       OR public.maint_profile_role() IN ('chief', 'admin')) THEN
    RAISE EXCEPTION 'Nemaš ovlašćenje za vraćanje vozila u upotrebu';
  END IF;

  UPDATE public.maint_assets
     SET archived_at    = NULL,
         archive_reason = NULL,
         archived_by    = NULL,
         active         = TRUE,
         updated_by     = auth.uid(),
         updated_at     = now()
   WHERE asset_id   = p_asset_id
     AND asset_type = 'vehicle';

  GET DIAGNOSTICS v_found = ROW_COUNT;
  RETURN v_found > 0;
END;
$function$

-- ============ touch_updated_at ============
-- KLASA: TRIGGER (deljeni app-wide updated_at helper)
CREATE OR REPLACE FUNCTION public.touch_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'auth', 'pg_temp'
AS $function$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$function$

-- ============ trg_maint_wo_asset_service_plan_completion ============
-- KLASA: TRIGGER (WO zavrsen → asset plan last_done)
CREATE OR REPLACE FUNCTION public.trg_maint_wo_asset_service_plan_completion()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.status = 'zavrsen' AND (OLD.status IS DISTINCT FROM NEW.status)
     AND NEW.asset_service_plan_id IS NOT NULL THEN
    UPDATE public.maint_asset_service_plan
       SET last_done_at = COALESCE(NEW.completed_at::date, CURRENT_DATE),
           updated_at = now(),
           updated_by = auth.uid()
     WHERE plan_id = NEW.asset_service_plan_id;
  END IF;
  RETURN NEW;
END;
$function$

-- ============================================================
-- RLS POLITIKE — pg_policies dump, public šema, 102 politika (sve PERMISSIVE)
-- ============================================================

-- ── maint_asset_service_plan ──
--   [ALL] maint_asp_write  roles={public}
--     USING: (maint_is_erp_admin_or_management() OR (maint_profile_role() = ANY (ARRAY['chief'::text, 'admin'::text])))
--     CHECK: (maint_is_erp_admin_or_management() OR (maint_profile_role() = ANY (ARRAY['chief'::text, 'admin'::text])))
--   [SELECT] maint_asp_select  roles={public}
--     USING: maint_asset_visible(asset_id)

-- ── maint_assets ──
--   [DELETE] maint_assets_delete  roles={public}
--     USING: (maint_is_erp_admin() OR (maint_profile_role() = ANY (ARRAY['chief'::text, 'admin'::text])))
--   [INSERT] maint_assets_insert  roles={public}
--     CHECK: (maint_is_erp_admin() OR (maint_profile_role() = ANY (ARRAY['chief'::text, 'admin'::text])))
--   [SELECT] maint_assets_select  roles={public}
--     USING: maint_asset_visible(asset_id)
--   [UPDATE] maint_assets_update  roles={public}
--     USING: (maint_is_erp_admin() OR (maint_profile_role() = ANY (ARRAY['chief'::text, 'admin'::text])))
--     CHECK: (maint_is_erp_admin() OR (maint_profile_role() = ANY (ARRAY['chief'::text, 'admin'::text])))

-- ── maint_checks ──
--   [INSERT] maint_checks_insert  roles={public}
--     CHECK: ((performed_by = auth.uid()) AND maint_machine_visible(machine_code))
--   [SELECT] maint_checks_select  roles={public}
--     USING: maint_machine_visible(machine_code)
--   [UPDATE] maint_checks_update  roles={public}
--     USING: (maint_machine_visible(machine_code) AND ((performed_by = auth.uid()) OR maint_is_erp_admin() OR (maint_profile_role() = ANY (ARRAY['chief'::text, 'technician'::text, 'admin'::text]))))
--     CHECK: maint_machine_visible(machine_code)

-- ── maint_documents ──
--   [DELETE] maint_documents_delete  roles={public}
--     USING: maint_document_visible(entity_type, asset_id, wo_id, incident_id, preventive_task_id, driver_id)
--   [INSERT] maint_documents_insert  roles={public}
--     CHECK: ((uploaded_by = auth.uid()) AND maint_document_visible(entity_type, asset_id, wo_id, incident_id, preventive_task_id, driver_id))
--   [SELECT] maint_documents_select  roles={public}
--     USING: maint_document_visible(entity_type, asset_id, wo_id, incident_id, preventive_task_id, driver_id)
--   [UPDATE] maint_documents_update  roles={public}
--     USING: maint_document_visible(entity_type, asset_id, wo_id, incident_id, preventive_task_id, driver_id)
--     CHECK: maint_document_visible(entity_type, asset_id, wo_id, incident_id, preventive_task_id, driver_id)

-- ── maint_drivers ──
--   [DELETE] maint_drivers_delete  roles={public}
--     USING: (maint_is_erp_admin_or_management() OR (maint_profile_role() = 'admin'::text))
--   [INSERT] maint_drivers_insert  roles={public}
--     CHECK: (maint_is_erp_admin_or_management() OR (maint_profile_role() = ANY (ARRAY['chief'::text, 'admin'::text])))
--   [SELECT] maint_drivers_select  roles={public}
--     USING: (maint_has_floor_read_access() OR maint_is_erp_admin_or_management() OR (maint_profile_role() = ANY (ARRAY['chief'::text, 'admin'::text, 'technician'::text, 'operator'::text])) OR (auth_user_id = auth.uid()))
--   [UPDATE] maint_drivers_update  roles={public}
--     USING: (maint_is_erp_admin_or_management() OR (maint_profile_role() = ANY (ARRAY['chief'::text, 'admin'::text])))
--     CHECK: (maint_is_erp_admin_or_management() OR (maint_profile_role() = ANY (ARRAY['chief'::text, 'admin'::text])))

-- ── maint_facility_details ──
--   [INSERT] maint_facility_details_insert  roles={public}
--     CHECK: (maint_asset_visible(asset_id) AND (maint_is_erp_admin_or_management() OR (maint_profile_role() = ANY (ARRAY['chief'::text, 'admin'::text]))))
--   [SELECT] maint_facility_details_select  roles={public}
--     USING: maint_asset_visible(asset_id)
--   [UPDATE] maint_facility_details_update  roles={public}
--     USING: (maint_asset_visible(asset_id) AND (maint_is_erp_admin_or_management() OR (maint_profile_role() = ANY (ARRAY['chief'::text, 'admin'::text]))))
--     CHECK: maint_asset_visible(asset_id)

-- ── maint_incident_events ──
--   [INSERT] maint_inc_events_insert  roles={public}
--     CHECK: ((EXISTS ( SELECT 1
--               FROM maint_incidents i
--              WHERE ((i.id = maint_incident_events.incident_id) AND maint_machine_visible(i.machine_code)))) AND ((actor IS NULL) OR (actor = auth.uid())))
--   [SELECT] maint_inc_events_select  roles={public}
--     USING: (EXISTS ( SELECT 1
--               FROM maint_incidents i
--              WHERE ((i.id = maint_incident_events.incident_id) AND maint_machine_visible(i.machine_code))))

-- ── maint_incidents ──
--   [INSERT] maint_incidents_insert  roles={authenticated}
--     CHECK: (reported_by = auth.uid())
--   [SELECT] maint_incidents_select  roles={public}
--     USING: maint_incident_row_visible(machine_code, asset_id)
--   [UPDATE] maint_incidents_update  roles={public}
--     USING: (maint_incident_row_visible(machine_code, asset_id) AND (maint_is_erp_admin_or_management() OR maint_is_erp_admin() OR (maint_profile_role() = ANY (ARRAY['technician'::text, 'chief'::text, 'admin'::text]))))
--     CHECK: (maint_incident_row_visible(machine_code, asset_id) AND ((status <> 'closed'::maint_incident_status) OR maint_can_close_incident() OR maint_is_erp_admin_or_management() OR (maint_profile_role() = ANY (ARRAY['chief'::text, 'admin'::text]))))

-- ── maint_it_asset_details ──
--   [INSERT] maint_it_asset_details_insert  roles={public}
--     CHECK: (maint_asset_visible(asset_id) AND (maint_is_erp_admin_or_management() OR (maint_profile_role() = ANY (ARRAY['chief'::text, 'admin'::text]))))
--   [SELECT] maint_it_asset_details_select  roles={public}
--     USING: maint_asset_visible(asset_id)
--   [UPDATE] maint_it_asset_details_update  roles={public}
--     USING: (maint_asset_visible(asset_id) AND (maint_is_erp_admin_or_management() OR (maint_profile_role() = ANY (ARRAY['chief'::text, 'admin'::text]))))
--     CHECK: maint_asset_visible(asset_id)

-- ── maint_locations ──
--   [DELETE] maint_locations_delete  roles={public}
--     USING: (maint_is_erp_admin() OR (maint_profile_role() = ANY (ARRAY['chief'::text, 'admin'::text])))
--   [INSERT] maint_locations_insert  roles={public}
--     CHECK: (maint_is_erp_admin() OR (maint_profile_role() = ANY (ARRAY['chief'::text, 'admin'::text])))
--   [SELECT] maint_locations_select  roles={public}
--     USING: (maint_has_floor_read_access() OR (maint_profile_role() = ANY (ARRAY['technician'::text, 'chief'::text, 'management'::text, 'admin'::text])))
--   [UPDATE] maint_locations_update  roles={public}
--     USING: (maint_is_erp_admin() OR (maint_profile_role() = ANY (ARRAY['chief'::text, 'admin'::text])))
--     CHECK: (maint_is_erp_admin() OR (maint_profile_role() = ANY (ARRAY['chief'::text, 'admin'::text])))

-- ── maint_machine_files ──
--   [DELETE] mmf_delete  roles={public}
--     USING: (maint_is_erp_admin() OR (maint_profile_role() = ANY (ARRAY['chief'::text, 'admin'::text])) OR ((uploaded_by = auth.uid()) AND (uploaded_at > (now() - '24:00:00'::interval)) AND (maint_profile_role() = ANY (ARRAY['operator'::text, 'technician'::text]))))
--   [INSERT] mmf_insert  roles={public}
--     CHECK: ((uploaded_by = auth.uid()) AND (maint_is_erp_admin() OR maint_is_erp_admin_or_management() OR (maint_profile_role() = ANY (ARRAY['operator'::text, 'technician'::text, 'chief'::text, 'admin'::text]))))
--   [SELECT] mmf_select  roles={public}
--     USING: maint_machine_visible(machine_code)
--   [UPDATE] mmf_update  roles={public}
--     USING: (maint_is_erp_admin() OR (maint_profile_role() = ANY (ARRAY['chief'::text, 'admin'::text])) OR ((uploaded_by = auth.uid()) AND (uploaded_at > (now() - '24:00:00'::interval)) AND (maint_profile_role() = ANY (ARRAY['operator'::text, 'technician'::text]))))
--     CHECK: (maint_is_erp_admin() OR (maint_profile_role() = ANY (ARRAY['chief'::text, 'admin'::text])) OR ((uploaded_by = auth.uid()) AND (uploaded_at > (now() - '24:00:00'::interval)) AND (maint_profile_role() = ANY (ARRAY['operator'::text, 'technician'::text]))))

-- ── maint_machine_notes ──
--   [INSERT] maint_notes_insert  roles={public}
--     CHECK: ((author = auth.uid()) AND maint_machine_visible(machine_code) AND (maint_is_erp_admin() OR (maint_profile_role() = ANY (ARRAY['operator'::text, 'technician'::text, 'chief'::text, 'admin'::text]))))
--   [SELECT] maint_notes_select  roles={public}
--     USING: ((deleted_at IS NULL) AND maint_machine_visible(machine_code))
--   [UPDATE] maint_notes_update  roles={public}
--     USING: (maint_machine_visible(machine_code) AND (maint_is_erp_admin() OR (maint_profile_role() = ANY (ARRAY['chief'::text, 'admin'::text])) OR ((author = auth.uid()) AND (created_at > (now() - '24:00:00'::interval)) AND (maint_profile_role() = ANY (ARRAY['operator'::text, 'technician'::text])))))
--     CHECK: maint_machine_visible(machine_code)

-- ── maint_machine_status_override ──
--   [DELETE] maint_override_delete  roles={public}
--     USING: (maint_is_erp_admin() OR (maint_profile_role() = ANY (ARRAY['chief'::text, 'admin'::text])))
--   [INSERT] maint_override_insert  roles={public}
--     CHECK: (maint_is_erp_admin() OR (maint_profile_role() = ANY (ARRAY['chief'::text, 'admin'::text])))
--   [SELECT] maint_override_select  roles={public}
--     USING: maint_machine_visible(machine_code)
--   [UPDATE] maint_override_update  roles={public}
--     USING: (maint_is_erp_admin() OR (maint_profile_role() = ANY (ARRAY['chief'::text, 'admin'::text])))
--     CHECK: (maint_is_erp_admin() OR (maint_profile_role() = ANY (ARRAY['chief'::text, 'admin'::text])))

-- ── maint_machines ──
--   [DELETE] maint_machines_delete  roles={public}
--     USING: (maint_is_erp_admin() OR (maint_profile_role() = ANY (ARRAY['chief'::text, 'admin'::text])))
--   [INSERT] maint_machines_insert  roles={public}
--     CHECK: (maint_is_erp_admin() OR (maint_profile_role() = ANY (ARRAY['chief'::text, 'admin'::text])))
--   [SELECT] maint_machines_select  roles={public}
--     USING: maint_machine_visible(machine_code)
--   [UPDATE] maint_machines_update  roles={public}
--     USING: (maint_is_erp_admin() OR (maint_profile_role() = ANY (ARRAY['chief'::text, 'admin'::text])))
--     CHECK: (maint_is_erp_admin() OR (maint_profile_role() = ANY (ARRAY['chief'::text, 'admin'::text])))

-- ── maint_machines_deletion_log ──
--   [DELETE] mmdl_delete  roles={public}
--     USING: false
--   [INSERT] mmdl_insert  roles={public}
--     CHECK: false
--   [SELECT] mmdl_select  roles={public}
--     USING: (maint_is_erp_admin() OR maint_is_erp_admin_or_management() OR (maint_profile_role() = ANY (ARRAY['chief'::text, 'admin'::text, 'management'::text])))
--   [UPDATE] mmdl_update  roles={public}
--     USING: false

-- ── maint_notification_log ──
--   [INSERT] maint_notif_insert  roles={public}
--     CHECK: false
--   [SELECT] maint_notif_select  roles={public}
--     USING: (maint_is_erp_admin() OR (maint_profile_role() = ANY (ARRAY['chief'::text, 'management'::text, 'admin'::text])))

-- ── maint_notification_rules ──
--   [INSERT] maint_notification_rules_insert  roles={public}
--     CHECK: (maint_is_erp_admin_or_management() OR (maint_profile_role() = ANY (ARRAY['chief'::text, 'admin'::text])))
--   [SELECT] maint_notification_rules_select  roles={public}
--     USING: (maint_is_erp_admin_or_management() OR (maint_profile_role() = ANY (ARRAY['chief'::text, 'management'::text, 'admin'::text])))
--   [UPDATE] maint_notification_rules_update  roles={public}
--     USING: (maint_is_erp_admin_or_management() OR (maint_profile_role() = ANY (ARRAY['chief'::text, 'admin'::text])))
--     CHECK: (maint_is_erp_admin_or_management() OR (maint_profile_role() = ANY (ARRAY['chief'::text, 'admin'::text])))

-- ── maint_part_stock_movements ──
--   [INSERT] maint_stock_movements_insert  roles={public}
--     CHECK: ((created_by = auth.uid()) AND (maint_is_erp_admin_or_management() OR (maint_profile_role() = ANY (ARRAY['technician'::text, 'chief'::text, 'admin'::text]))) AND ((wo_id IS NULL) OR (EXISTS ( SELECT 1
--               FROM maint_work_orders w
--              WHERE ((w.wo_id = maint_part_stock_movements.wo_id) AND maint_wo_row_visible(w.asset_id, w.assigned_to, w.reported_by))))))
--   [SELECT] maint_stock_movements_select  roles={public}
--     USING: (maint_has_floor_read_access() OR (maint_profile_role() = ANY (ARRAY['technician'::text, 'chief'::text, 'management'::text, 'admin'::text])))

-- ── maint_part_vehicles ──
--   [DELETE] maint_pv_delete  roles={public}
--     USING: (maint_is_erp_admin_or_management() OR (maint_profile_role() = ANY (ARRAY['chief'::text, 'admin'::text])))
--   [INSERT] maint_pv_insert  roles={public}
--     CHECK: (maint_is_erp_admin_or_management() OR (maint_profile_role() = ANY (ARRAY['chief'::text, 'admin'::text, 'technician'::text])))
--   [SELECT] maint_pv_select  roles={public}
--     USING: maint_asset_visible(asset_id)
--   [UPDATE] maint_pv_update  roles={public}
--     USING: (maint_is_erp_admin_or_management() OR (maint_profile_role() = ANY (ARRAY['chief'::text, 'admin'::text, 'technician'::text])))
--     CHECK: (maint_is_erp_admin_or_management() OR (maint_profile_role() = ANY (ARRAY['chief'::text, 'admin'::text, 'technician'::text])))

-- ── maint_parts ──
--   [INSERT] maint_parts_insert  roles={public}
--     CHECK: (maint_is_erp_admin_or_management() OR (maint_profile_role() = ANY (ARRAY['chief'::text, 'admin'::text])))
--   [SELECT] maint_parts_select  roles={public}
--     USING: (maint_has_floor_read_access() OR (maint_profile_role() = ANY (ARRAY['technician'::text, 'chief'::text, 'management'::text, 'admin'::text])))
--   [UPDATE] maint_parts_update  roles={public}
--     USING: (maint_is_erp_admin_or_management() OR (maint_profile_role() = ANY (ARRAY['chief'::text, 'admin'::text])))
--     CHECK: (maint_is_erp_admin_or_management() OR (maint_profile_role() = ANY (ARRAY['chief'::text, 'admin'::text])))

-- ── maint_settings ──
--   [SELECT] maint_settings_select  roles={public}
--     USING: (maint_is_erp_admin_or_management() OR (maint_profile_role() = ANY (ARRAY['operator'::text, 'technician'::text, 'chief'::text, 'admin'::text])))
--   [UPDATE] maint_settings_update  roles={public}
--     USING: (maint_is_erp_admin_or_management() OR (maint_profile_role() = ANY (ARRAY['chief'::text, 'admin'::text])))
--     CHECK: (maint_is_erp_admin_or_management() OR (maint_profile_role() = ANY (ARRAY['chief'::text, 'admin'::text])))

-- ── maint_suppliers ──
--   [INSERT] maint_suppliers_insert  roles={public}
--     CHECK: (maint_is_erp_admin_or_management() OR (maint_profile_role() = ANY (ARRAY['chief'::text, 'admin'::text])))
--   [SELECT] maint_suppliers_select  roles={public}
--     USING: (maint_has_floor_read_access() OR (maint_profile_role() = ANY (ARRAY['technician'::text, 'chief'::text, 'management'::text, 'admin'::text])))
--   [UPDATE] maint_suppliers_update  roles={public}
--     USING: (maint_is_erp_admin_or_management() OR (maint_profile_role() = ANY (ARRAY['chief'::text, 'admin'::text])))
--     CHECK: (maint_is_erp_admin_or_management() OR (maint_profile_role() = ANY (ARRAY['chief'::text, 'admin'::text])))

-- ── maint_tasks ──
--   [DELETE] maint_tasks_delete  roles={public}
--     USING: (maint_is_erp_admin() OR (maint_profile_role() = ANY (ARRAY['chief'::text, 'admin'::text])))
--   [INSERT] maint_tasks_insert  roles={public}
--     CHECK: (maint_is_erp_admin() OR (maint_profile_role() = ANY (ARRAY['chief'::text, 'admin'::text])))
--   [SELECT] maint_tasks_select  roles={public}
--     USING: maint_machine_visible(machine_code)
--   [UPDATE] maint_tasks_update  roles={public}
--     USING: (maint_is_erp_admin() OR (maint_profile_role() = ANY (ARRAY['chief'::text, 'admin'::text])))
--     CHECK: (maint_is_erp_admin() OR (maint_profile_role() = ANY (ARRAY['chief'::text, 'admin'::text])))

-- ── maint_user_profiles ──
--   [DELETE] maint_profiles_delete  roles={public}
--     USING: maint_is_erp_admin()
--   [INSERT] maint_profiles_insert  roles={public}
--     CHECK: maint_is_erp_admin()
--   [SELECT] maint_profiles_select  roles={public}
--     USING: ((auth.uid() = user_id) OR maint_is_erp_admin())
--   [UPDATE] maint_profiles_update  roles={public}
--     USING: (maint_is_erp_admin() OR (auth.uid() = user_id))
--     CHECK: (maint_is_erp_admin() OR (auth.uid() = user_id))

-- ── maint_vehicle_bookings ──
--   [DELETE] maint_booking_delete  roles={public}
--     USING: (maint_is_erp_admin_or_management() OR (maint_profile_role() = ANY (ARRAY['chief'::text, 'admin'::text])))
--   [INSERT] maint_booking_insert  roles={public}
--     CHECK: (maint_is_erp_admin_or_management() OR (maint_profile_role() = ANY (ARRAY['chief'::text, 'admin'::text, 'technician'::text, 'operator'::text])))
--   [SELECT] maint_booking_select  roles={public}
--     USING: maint_asset_visible(asset_id)
--   [UPDATE] maint_booking_update  roles={public}
--     USING: (maint_is_erp_admin_or_management() OR (maint_profile_role() = ANY (ARRAY['chief'::text, 'admin'::text])) OR (created_by = auth.uid()))
--     CHECK: (maint_is_erp_admin_or_management() OR (maint_profile_role() = ANY (ARRAY['chief'::text, 'admin'::text])) OR (created_by = auth.uid()))

-- ── maint_vehicle_details ──
--   [INSERT] maint_vehicle_details_insert  roles={public}
--     CHECK: (maint_asset_visible(asset_id) AND (maint_is_erp_admin_or_management() OR (maint_profile_role() = ANY (ARRAY['chief'::text, 'admin'::text]))))
--   [SELECT] maint_vehicle_details_select  roles={public}
--     USING: maint_asset_visible(asset_id)
--   [UPDATE] maint_vehicle_details_update  roles={public}
--     USING: (maint_asset_visible(asset_id) AND (maint_is_erp_admin_or_management() OR (maint_profile_role() = ANY (ARRAY['chief'::text, 'admin'::text]))))
--     CHECK: maint_asset_visible(asset_id)

-- ── maint_vehicle_owners ──
--   [ALL] maint_vehicle_owners_write  roles={authenticated}
--     USING: (maint_is_erp_admin_or_management() OR (maint_profile_role() = ANY (ARRAY['chief'::text, 'admin'::text])))
--     CHECK: (maint_is_erp_admin_or_management() OR (maint_profile_role() = ANY (ARRAY['chief'::text, 'admin'::text])))
--   [SELECT] maint_vehicle_owners_select  roles={authenticated}
--     USING: true

-- ── maint_vehicle_service_plan ──
--   [DELETE] maint_vsp_delete  roles={public}
--     USING: (maint_is_erp_admin_or_management() OR (maint_profile_role() = ANY (ARRAY['chief'::text, 'admin'::text])))
--   [INSERT] maint_vsp_insert  roles={public}
--     CHECK: (maint_is_erp_admin_or_management() OR (maint_profile_role() = ANY (ARRAY['chief'::text, 'admin'::text])))
--   [SELECT] maint_vsp_select  roles={public}
--     USING: maint_asset_visible(asset_id)
--   [UPDATE] maint_vsp_update  roles={public}
--     USING: (maint_is_erp_admin_or_management() OR (maint_profile_role() = ANY (ARRAY['chief'::text, 'admin'::text])))
--     CHECK: (maint_is_erp_admin_or_management() OR (maint_profile_role() = ANY (ARRAY['chief'::text, 'admin'::text])))

-- ── maint_vehicle_tires ──
--   [ALL] maint_vehicle_tires_write  roles={authenticated}
--     USING: (maint_asset_visible(asset_id) AND (maint_is_erp_admin_or_management() OR (maint_profile_role() = ANY (ARRAY['chief'::text, 'admin'::text]))))
--     CHECK: (maint_asset_visible(asset_id) AND (maint_is_erp_admin_or_management() OR (maint_profile_role() = ANY (ARRAY['chief'::text, 'admin'::text]))))
--   [SELECT] maint_vehicle_tires_select  roles={authenticated}
--     USING: maint_asset_visible(asset_id)

-- ── maint_wo_events ──
--   [INSERT] maint_wo_events_write  roles={public}
--     CHECK: (EXISTS ( SELECT 1
--               FROM maint_work_orders w
--              WHERE ((w.wo_id = maint_wo_events.wo_id) AND maint_wo_row_visible(w.asset_id, w.assigned_to, w.reported_by) AND (maint_is_erp_admin_or_management() OR (maint_profile_role() = ANY (ARRAY['technician'::text, 'chief'::text, 'admin'::text]))))))
--   [SELECT] maint_wo_events_select  roles={public}
--     USING: (EXISTS ( SELECT 1
--               FROM maint_work_orders w
--              WHERE ((w.wo_id = maint_wo_events.wo_id) AND maint_wo_row_visible(w.asset_id, w.assigned_to, w.reported_by))))

-- ── maint_wo_labor ──
--   [ALL] maint_wo_labor_all  roles={public}
--     USING: (EXISTS ( SELECT 1
--               FROM maint_work_orders w
--              WHERE ((w.wo_id = maint_wo_labor.wo_id) AND maint_wo_row_visible(w.asset_id, w.assigned_to, w.reported_by))))
--     CHECK: (EXISTS ( SELECT 1
--               FROM maint_work_orders w
--              WHERE ((w.wo_id = maint_wo_labor.wo_id) AND maint_wo_row_visible(w.asset_id, w.assigned_to, w.reported_by) AND (maint_is_erp_admin_or_management() OR (maint_profile_role() = ANY (ARRAY['technician'::text, 'chief'::text, 'admin'::text]))))))

-- ── maint_wo_number_counter ──
--   [ALL] maint_wo_num_counter_deny  roles={authenticated}
--     USING: false
--     CHECK: false

-- ── maint_wo_parts ──
--   [ALL] maint_wo_parts_all  roles={public}
--     USING: (EXISTS ( SELECT 1
--               FROM maint_work_orders w
--              WHERE ((w.wo_id = maint_wo_parts.wo_id) AND maint_wo_row_visible(w.asset_id, w.assigned_to, w.reported_by))))
--     CHECK: (EXISTS ( SELECT 1
--               FROM maint_work_orders w
--              WHERE ((w.wo_id = maint_wo_parts.wo_id) AND maint_wo_row_visible(w.asset_id, w.assigned_to, w.reported_by) AND (maint_is_erp_admin_or_management() OR (maint_profile_role() = ANY (ARRAY['technician'::text, 'chief'::text, 'admin'::text]))))))

-- ── maint_work_orders ──
--   [DELETE] maint_wo_delete  roles={public}
--     USING: (maint_is_erp_admin_or_management() OR (maint_profile_role() = ANY (ARRAY['chief'::text, 'admin'::text])))
--   [INSERT] maint_wo_insert  roles={public}
--     CHECK: ((reported_by = auth.uid()) AND maint_asset_visible(asset_id) AND (maint_is_erp_admin_or_management() OR (maint_profile_role() = ANY (ARRAY['operator'::text, 'technician'::text, 'chief'::text, 'admin'::text]))))
--   [SELECT] maint_wo_select  roles={public}
--     USING: maint_wo_row_visible(asset_id, assigned_to, reported_by)
--   [UPDATE] maint_wo_update  roles={public}
--     USING: (maint_wo_row_visible(asset_id, assigned_to, reported_by) AND (maint_is_erp_admin_or_management() OR (maint_profile_role() = ANY (ARRAY['technician'::text, 'chief'::text, 'admin'::text]))))
--     CHECK: maint_wo_row_visible(asset_id, assigned_to, reported_by)

-- ============================================================
-- STORAGE POLITIKE — bucket maint-machine-files (private), 4 politike na storage.objects
-- ============================================================
--   [DELETE] mmf_storage_delete  roles={authenticated}
--     USING: ((bucket_id = 'maint-machine-files'::text) AND (maint_is_erp_admin() OR (maint_profile_role() = ANY (ARRAY['chief'::text, 'admin'::text])) OR (owner = auth.uid())))
--   [INSERT] mmf_storage_insert  roles={authenticated}
--     CHECK: ((bucket_id = 'maint-machine-files'::text) AND (maint_is_erp_admin_or_management() OR (maint_profile_role() = ANY (ARRAY['operator'::text, 'technician'::text, 'chief'::text, 'admin'::text]))))
--   [SELECT] mmf_storage_read  roles={authenticated}
--     USING: ((bucket_id = 'maint-machine-files'::text) AND maint_has_floor_read_access())
--   [UPDATE] mmf_storage_update  roles={authenticated}
--     USING: ((bucket_id = 'maint-machine-files'::text) AND (maint_is_erp_admin() OR (maint_profile_role() = ANY (ARRAY['chief'::text, 'admin'::text]))))
--     CHECK: ((bucket_id = 'maint-machine-files'::text) AND (maint_is_erp_admin() OR (maint_profile_role() = ANY (ARRAY['chief'::text, 'admin'::text]))))

-- ============================================================
-- TRIGERI na maint_* tabelama (34)
-- ============================================================
-- maint_asset_service_plan.maint_asset_service_plan_guard_biu → maint_asset_service_plan_guard()
--   CREATE TRIGGER maint_asset_service_plan_guard_biu BEFORE INSERT OR UPDATE ON public.maint_asset_service_plan FOR EACH ROW EXECUTE FUNCTION maint_asset_service_plan_guard()
-- maint_assets.maint_assets_touch_updated → touch_updated_at()
--   CREATE TRIGGER maint_assets_touch_updated BEFORE UPDATE ON public.maint_assets FOR EACH ROW EXECUTE FUNCTION touch_updated_at()
-- maint_checks.maint_checks_touch_updated → touch_updated_at()
--   CREATE TRIGGER maint_checks_touch_updated BEFORE UPDATE ON public.maint_checks FOR EACH ROW EXECUTE FUNCTION touch_updated_at()
-- maint_facility_details.maint_facility_details_guard_biu → maint_facility_details_guard()
--   CREATE TRIGGER maint_facility_details_guard_biu BEFORE INSERT OR UPDATE ON public.maint_facility_details FOR EACH ROW EXECUTE FUNCTION maint_facility_details_guard()
-- maint_facility_details.maint_facility_details_touch_updated → touch_updated_at()
--   CREATE TRIGGER maint_facility_details_touch_updated BEFORE UPDATE ON public.maint_facility_details FOR EACH ROW EXECUTE FUNCTION touch_updated_at()
-- maint_incidents.maint_incidents_audit → maint_incidents_log_changes()
--   CREATE TRIGGER maint_incidents_audit AFTER INSERT OR UPDATE ON public.maint_incidents FOR EACH ROW EXECUTE FUNCTION maint_incidents_log_changes()
-- maint_incidents.maint_incidents_autocreate_wo → maint_incidents_autocreate_work_order()
--   CREATE TRIGGER maint_incidents_autocreate_wo AFTER INSERT ON public.maint_incidents FOR EACH ROW EXECUTE FUNCTION maint_incidents_autocreate_work_order()
-- maint_incidents.maint_incidents_enqueue_notify → maint_incidents_enqueue_notify()
--   CREATE TRIGGER maint_incidents_enqueue_notify AFTER INSERT ON public.maint_incidents FOR EACH ROW EXECUTE FUNCTION maint_incidents_enqueue_notify()
-- maint_incidents.maint_incidents_set_asset_fields → maint_incidents_set_asset_fields()
--   CREATE TRIGGER maint_incidents_set_asset_fields BEFORE INSERT OR UPDATE OF machine_code, asset_id ON public.maint_incidents FOR EACH ROW EXECUTE FUNCTION maint_incidents_set_asset_fields()
-- maint_incidents.maint_incidents_touch_updated → touch_updated_at()
--   CREATE TRIGGER maint_incidents_touch_updated BEFORE UPDATE ON public.maint_incidents FOR EACH ROW EXECUTE FUNCTION touch_updated_at()
-- maint_it_asset_details.maint_it_asset_details_guard_biu → maint_it_asset_details_guard()
--   CREATE TRIGGER maint_it_asset_details_guard_biu BEFORE INSERT OR UPDATE ON public.maint_it_asset_details FOR EACH ROW EXECUTE FUNCTION maint_it_asset_details_guard()
-- maint_it_asset_details.maint_it_asset_details_touch_updated → touch_updated_at()
--   CREATE TRIGGER maint_it_asset_details_touch_updated BEFORE UPDATE ON public.maint_it_asset_details FOR EACH ROW EXECUTE FUNCTION touch_updated_at()
-- maint_locations.maint_locations_touch_updated → touch_updated_at()
--   CREATE TRIGGER maint_locations_touch_updated BEFORE UPDATE ON public.maint_locations FOR EACH ROW EXECUTE FUNCTION touch_updated_at()
-- maint_machine_notes.maint_notes_touch_updated → touch_updated_at()
--   CREATE TRIGGER maint_notes_touch_updated BEFORE UPDATE ON public.maint_machine_notes FOR EACH ROW EXECUTE FUNCTION touch_updated_at()
-- maint_machines.maint_machines_ensure_asset → maint_machines_ensure_asset()
--   CREATE TRIGGER maint_machines_ensure_asset BEFORE INSERT ON public.maint_machines FOR EACH ROW EXECUTE FUNCTION maint_machines_ensure_asset()
-- maint_machines.maint_machines_touch_updated → touch_updated_at()
--   CREATE TRIGGER maint_machines_touch_updated BEFORE UPDATE ON public.maint_machines FOR EACH ROW EXECUTE FUNCTION touch_updated_at()
-- maint_machines.trg_maint_machines_loc_sync → maint_machines_sync_to_loc()
--   CREATE TRIGGER trg_maint_machines_loc_sync AFTER INSERT OR UPDATE OF name, archived_at, tracked ON public.maint_machines FOR EACH ROW EXECUTE FUNCTION maint_machines_sync_to_loc()
-- maint_notification_rules.maint_notification_rules_touch_updated → touch_updated_at()
--   CREATE TRIGGER maint_notification_rules_touch_updated BEFORE UPDATE ON public.maint_notification_rules FOR EACH ROW EXECUTE FUNCTION touch_updated_at()
-- maint_part_stock_movements.maint_part_stock_movements_apply → maint_apply_part_stock_movement()
--   CREATE TRIGGER maint_part_stock_movements_apply AFTER INSERT ON public.maint_part_stock_movements FOR EACH ROW EXECUTE FUNCTION maint_apply_part_stock_movement()
-- maint_parts.maint_parts_touch_updated → touch_updated_at()
--   CREATE TRIGGER maint_parts_touch_updated BEFORE UPDATE ON public.maint_parts FOR EACH ROW EXECUTE FUNCTION touch_updated_at()
-- maint_settings.maint_settings_touch_updated → touch_updated_at()
--   CREATE TRIGGER maint_settings_touch_updated BEFORE UPDATE ON public.maint_settings FOR EACH ROW EXECUTE FUNCTION touch_updated_at()
-- maint_suppliers.maint_suppliers_touch_updated → touch_updated_at()
--   CREATE TRIGGER maint_suppliers_touch_updated BEFORE UPDATE ON public.maint_suppliers FOR EACH ROW EXECUTE FUNCTION touch_updated_at()
-- maint_tasks.maint_tasks_touch_updated → touch_updated_at()
--   CREATE TRIGGER maint_tasks_touch_updated BEFORE UPDATE ON public.maint_tasks FOR EACH ROW EXECUTE FUNCTION touch_updated_at()
-- maint_user_profiles.maint_profiles_guard_role_trg → maint_profiles_guard_role()
--   CREATE TRIGGER maint_profiles_guard_role_trg BEFORE UPDATE ON public.maint_user_profiles FOR EACH ROW EXECUTE FUNCTION maint_profiles_guard_role()
-- maint_user_profiles.maint_profiles_touch_updated → touch_updated_at()
--   CREATE TRIGGER maint_profiles_touch_updated BEFORE UPDATE ON public.maint_user_profiles FOR EACH ROW EXECUTE FUNCTION touch_updated_at()
-- maint_vehicle_details.maint_vehicle_details_guard_biu → maint_vehicle_details_guard()
--   CREATE TRIGGER maint_vehicle_details_guard_biu BEFORE INSERT OR UPDATE ON public.maint_vehicle_details FOR EACH ROW EXECUTE FUNCTION maint_vehicle_details_guard()
-- maint_vehicle_details.maint_vehicle_details_touch_updated → touch_updated_at()
--   CREATE TRIGGER maint_vehicle_details_touch_updated BEFORE UPDATE ON public.maint_vehicle_details FOR EACH ROW EXECUTE FUNCTION touch_updated_at()
-- maint_vehicle_owners.maint_vehicle_owners_touch_updated → touch_updated_at()
--   CREATE TRIGGER maint_vehicle_owners_touch_updated BEFORE UPDATE ON public.maint_vehicle_owners FOR EACH ROW EXECUTE FUNCTION touch_updated_at()
-- maint_vehicle_tires.maint_vehicle_tires_touch_updated → touch_updated_at()
--   CREATE TRIGGER maint_vehicle_tires_touch_updated BEFORE UPDATE ON public.maint_vehicle_tires FOR EACH ROW EXECUTE FUNCTION touch_updated_at()
-- maint_work_orders.maint_wo_audit_fields → maint_wo_log_field_changes()
--   CREATE TRIGGER maint_wo_audit_fields BEFORE UPDATE ON public.maint_work_orders FOR EACH ROW EXECUTE FUNCTION maint_wo_log_field_changes()
-- maint_work_orders.maint_wo_biu_wo_number → maint_work_orders_assign_wo_number()
--   CREATE TRIGGER maint_wo_biu_wo_number BEFORE INSERT ON public.maint_work_orders FOR EACH ROW EXECUTE FUNCTION maint_work_orders_assign_wo_number()
-- maint_work_orders.maint_wo_touch_updated → touch_updated_at()
--   CREATE TRIGGER maint_wo_touch_updated BEFORE UPDATE ON public.maint_work_orders FOR EACH ROW EXECUTE FUNCTION touch_updated_at()
-- maint_work_orders.trg_maint_wo_asset_service_plan_completion → trg_maint_wo_asset_service_plan_completion()
--   CREATE TRIGGER trg_maint_wo_asset_service_plan_completion AFTER UPDATE OF status ON public.maint_work_orders FOR EACH ROW EXECUTE FUNCTION trg_maint_wo_asset_service_plan_completion()
-- maint_work_orders.trg_maint_wo_service_plan_completion → maint_wo_service_plan_completion()
--   CREATE TRIGGER trg_maint_wo_service_plan_completion AFTER UPDATE OF status ON public.maint_work_orders FOR EACH ROW EXECUTE FUNCTION maint_wo_service_plan_completion()

-- ============================================================
-- PG_CRON
-- ============================================================
-- job 15 'maint-deadline-check-daily'  schedule='0 7 * * *'  command=SELECT public.maint_check_all_deadlines(30);
-- (NEMA cron/scheduler poziva za edge maint-notify-dispatch — outbox se NE prazni: 30 queued / 2 sent na dan snimka.)
