-- ============================================================================
-- FIX — POST /maintenance/vehicles pada sa 42804 (kreiranje vozila NIKAD ne prolazi)
-- Datum: 2026-08-04 · grana: fix/vozila-create-enum-cast
-- Prijava: Nikola Savić, 04.08.2026 08:34 (ponovljeno 3+ puta) — korisnik dobija 500.
--
-- ⚠️ OVAJ FAJL SE NE IZVRŠAVA AUTOMATSKI I NIJE PRIMENJEN NA ŽIVU BAZU.
--    Primenu na sy15 (glavna baza, self-hosted Supabase na ubuntusrv) radi glavna
--    sesija RUČNO. Nema Prisma migracije — sy15 objekti NISU u 3.0 migracionom
--    lancu (`prisma/sy15.prisma` je introspekcija, bez migracija). Isti obrazac
--    kao ZAHTEV_047_MASINA_RENAME_FIX.sql.
--
-- ✅ REDOSLED SLOBODAN: backend NE treba nikakav deploy — poziv iz
--    `odrzavanje.service.ts` (`createAssetViaRpc` → `create_maint_vehicle`) je
--    ispravan (text argumenti za text parametre). Čim se ovaj SQL primeni,
--    kreiranje vozila proradi sa VEĆ deployovanim backendom.
--
-- ── Koren (izmereno na živoj sy15, 04.08.2026) ──────────────────────────────
-- Živa `public.create_maint_vehicle(text,…)` u INSERT-u u `maint_assets` upisuje
--
--     COALESCE(NULLIF(p_status, ''), 'running')                    -- ← tip: text
--
-- u kolonu `status` tipa PG ENUM `maint_operational_status` BEZ kasta →
-- SQLSTATE 42804 „column "status" is of type maint_operational_status but
-- expression is of type text" na SVAKOM pozivu (funkcija je „rođena pokvarena";
-- i snapshot docs/design/authz-snapshots/talasF-fn-defs-2026-07-12.sql:301 je
-- bez kasta). Sestrinske `create_maint_it_asset` (snapshot:235) i
-- `create_maint_facility` (snapshot:168) IMAJU kast — samo je vozilo promašeno.
-- Vrednost koju FE šalje (`status:'running'`, vozilo-edit-modal.tsx) JESTE
-- validna labela enum-a {running,degraded,down,maintenance} — problem je
-- isključivo tip izraza, ne vrednost.
--
-- ── Šta menja ───────────────────────────────────────────────────────────────
-- JEDNA linija: `::public.maint_operational_status` kast na status izrazu —
-- identično obrascu iz `create_maint_it_asset`/`create_maint_facility`. Drugi
-- INSERT iste fn (u `maint_vehicle_details`) već ispravno kastuje svoje enume
-- (`::public.maint_vehicle_kind`, `::…usage_type`, `::…gps_provider`) — ne dira se.
-- CREATE OR REPLACE čuva vlasnika (supabase_admin) i postojeće EXECUTE grantove
-- (anon/authenticated/service_role) — GRANT-ovi NISU potrebni.
--
-- ── Provera POSLE primene ───────────────────────────────────────────────────
--   SELECT prosrc ~ 'maint_operational_status' FROM pg_proc
--    WHERE proname = 'create_maint_vehicle';   -- mora vratiti `t`
-- pa iz aplikacije: Održavanje → Vozila → „Novo vozilo" → sačuvaj (Nikola).
-- ============================================================================

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
    COALESCE(NULLIF(p_status, ''), 'running')::public.maint_operational_status,
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
$function$;
