-- ============================================================================
-- ZAHTEVI 065/066/067 — IT oprema: polja po tipu uređaja (Veljko Mijajlović, 04.08.2026)
-- Grana: feat/it-oprema-polja-065-067
--
--   065 Računari : Korisnik, Computer name, PC/Laptop, OS, Model, Procesor,
--                  Matična ploča, RAM, Grafika
--   066 Štampači : IP adresa, Model, Kancelarija, Korisnik, Toneri/Ketridži
--   067 Switchevi: Lokacija, Switch, Model, Komentar/napomena, IP adresa,
--                  UniFi portovi
--
-- Već pokriveno postojećom šemom (maint_assets + maint_it_asset_details):
--   Korisnik=assigned_to · Computer name=hostname · PC/Laptop=device_type ·
--   OS=operating_system · Model=maint_assets.model · IP=ip_address ·
--   Switch(naziv)=maint_assets.name · Komentar=notes
-- NOVO (7 text kolona na maint_it_asset_details — širi se postojeća details
-- tabela po obrascu maint_vehicle_details, NE jsonb):
--   cpu, motherboard, ram, gpu            (065 — hardver računara)
--   office_location                       (066 Kancelarija / 067 Lokacija)
--   toner_cartridges                      (066 Toneri/Ketridži)
--   unifi_ports                           (067 UniFi portovi)
--
-- ⚠️ OVAJ FAJL SE NE IZVRŠAVA AUTOMATSKI I NIJE PRIMENJEN NA ŽIVU BAZU.
--    Primenu na sy15 (glavna baza, self-hosted Supabase na ubuntusrv) radi
--    glavna sesija RUČNO, kao supabase_admin (vlasnik fn/view). Nema Prisma
--    migracije — sy15 objekti NISU u 3.0 migracionom lancu (prisma/sy15.prisma
--    je introspekcija). Isti obrazac kao FIX_VOZILA_CREATE_STATUS_CAST.sql.
--
-- 🔴 REDOSLED OBAVEZAN: OVAJ SQL SE PRIMENJUJE **PRE** DEPLOY-a BACKENDA sa ove
--    grane. Prisma model MaintItAssetDetails posle ove grane SELECT-uje novih 7
--    kolona pri SVAKOM čitanju kartona (findUnique) → backend deployovan pre
--    primene SQL-a bi padao sa 42703 (undefined_column) na GET /maintenance/
--    it-assets/:id i PUT …/details. (Suprotno od FIX_VOZILA gde je redosled
--    bio slobodan.) Stari backend + primenjen SQL radi bez problema (nove
--    kolone su NULL-abilne i niko ih ne dira).
--
-- Sadržaj (redosled unutar fajla je i redosled izvršavanja):
--   1) ALTER TABLE maint_it_asset_details — 7 novih NULL-abilnih text kolona
--   2) CREATE OR REPLACE create_maint_it_asset — p_details prima novih 7
--      ključeva (NULLIF '' obrazac; enum kast statusa VEĆ postoji — pouka
--      42804 od 04.08). COR čuva vlasnika (supabase_admin) i EXECUTE grantove
--      (anon/authenticated/service_role) — GRANT-ovi NISU potrebni.
--   3) CREATE OR REPLACE VIEW v_maint_it_overview — postojeće kolone identično
--      (COR view dozvoljava SAMO dodavanje na kraj), novih 7 APPEND na kraj;
--      WITH (security_invoker = true) EKSPLICITNO (živa vrednost, ne sme da
--      ispadne — RLS na maint_* tabelama mora da važi za čitaoca).
--
-- ── Provera POSLE primene ───────────────────────────────────────────────────
--   SELECT count(*) FROM information_schema.columns
--    WHERE table_name='maint_it_asset_details'
--      AND column_name IN ('cpu','motherboard','ram','gpu','office_location',
--                          'toner_cartridges','unifi_ports');   -- mora biti 7
--   SELECT prosrc ~ 'unifi_ports' FROM pg_proc
--    WHERE proname='create_maint_it_asset';                     -- mora biti t
--   SELECT reloptions FROM pg_class
--    WHERE relname='v_maint_it_overview';    -- mora sadržati security_invoker=true
-- pa iz aplikacije: Održavanje → IT oprema → „Nova IT oprema" → tip „laptop"
-- (hardver polja) / „printer" (kancelarija+toneri) / „switch" (lokacija+portovi).
-- ============================================================================

-- ── 1) Nove kolone ──────────────────────────────────────────────────────────

ALTER TABLE public.maint_it_asset_details
  ADD COLUMN IF NOT EXISTS cpu               text,
  ADD COLUMN IF NOT EXISTS motherboard       text,
  ADD COLUMN IF NOT EXISTS ram               text,
  ADD COLUMN IF NOT EXISTS gpu               text,
  ADD COLUMN IF NOT EXISTS office_location   text,
  ADD COLUMN IF NOT EXISTS toner_cartridges  text,
  ADD COLUMN IF NOT EXISTS unifi_ports       text;

-- ── 2) create_maint_it_asset — prošireni details INSERT ─────────────────────

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
    cpu, motherboard, ram, gpu,
    office_location, toner_cartridges, unifi_ports,
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
    NULLIF(p_details->>'cpu', ''),
    NULLIF(p_details->>'motherboard', ''),
    NULLIF(p_details->>'ram', ''),
    NULLIF(p_details->>'gpu', ''),
    NULLIF(p_details->>'office_location', ''),
    NULLIF(p_details->>'toner_cartridges', ''),
    NULLIF(p_details->>'unifi_ports', ''),
    v_user_id
  );

  RETURN v_asset_id;
END;
$function$;

-- ── 3) v_maint_it_overview — novih 7 kolona APPEND na kraj ──────────────────
-- Postojeće kolone/izrazi 1:1 kao živa definicija (pg_get_viewdef 04.08.2026);
-- CREATE OR REPLACE VIEW dozvoljava samo dodavanje kolona NA KRAJ liste.

CREATE OR REPLACE VIEW public.v_maint_it_overview
WITH (security_invoker = true) AS
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
            WHEN d.license_expires_at IS NULL THEN 'unknown'::text
            WHEN d.license_expires_at < CURRENT_DATE THEN 'expired'::text
            WHEN d.license_expires_at <= (CURRENT_DATE + '30 days'::interval) THEN 'due_soon'::text
            ELSE 'ok'::text
        END AS license_status,
        CASE
            WHEN COALESCE(d.warranty_expires_at, a.warranty_until) IS NULL THEN 'unknown'::text
            WHEN COALESCE(d.warranty_expires_at, a.warranty_until) < CURRENT_DATE THEN 'expired'::text
            WHEN COALESCE(d.warranty_expires_at, a.warranty_until) <= (CURRENT_DATE + '30 days'::interval) THEN 'due_soon'::text
            ELSE 'ok'::text
        END AS warranty_status,
        CASE
            WHEN NOT COALESCE(d.backup_required, false) THEN 'not_required'::text
            WHEN d.last_backup_at IS NULL THEN 'missing'::text
            WHEN d.last_backup_at < (now() - '7 days'::interval) THEN 'stale'::text
            ELSE 'ok'::text
        END AS backup_status,
    ( SELECT count(*)::integer AS count
           FROM maint_work_orders wo
          WHERE wo.asset_id = a.asset_id AND (wo.status = ANY (ARRAY['novi'::maint_wo_status, 'dodeljen'::maint_wo_status, 'u_radu'::maint_wo_status]))) AS open_wo_count,
    d.cpu,
    d.motherboard,
    d.ram,
    d.gpu,
    d.office_location,
    d.toner_cartridges,
    d.unifi_ports
   FROM maint_assets a
     LEFT JOIN maint_it_asset_details d ON d.asset_id = a.asset_id
  WHERE a.asset_type = 'it'::maint_asset_type;
