-- ============================================================================
-- ZAHTEV 071 — IT oprema: tablet / UPS / access point (Veljko Mijajlović, 05.08.2026)
-- Grana: feat/071-it-polja  (nastavak 065/066/067 → ZAHTEV_065_066_067_IT_OPREMA_POLJA.sql)
--
--   Tablet       : ista polja kao laptop/desktop (procesor, matična ploča, RAM,
--                  grafika) — BEZ DDL-a, samo FE kategorizacija (itDeviceCategory
--                  „tablet" → 'computer'); kolone cpu/motherboard/ram/gpu postoje od 065.
--   UPS          : model, snaga (VA/W), lokacija
--   Access point : status, model, verzija (podaci sa UniFi naloga)
--
-- Već pokriveno postojećom šemom (NE dodaje se duplikat):
--   Model (UPS i AP)   = maint_assets.model         (polje „Model" u sekciji Hardver)
--   Status (AP)        = maint_assets.status        (enum maint_operational_status:
--                        running/degraded/down/maintenance — isti onaj koji lista i
--                        karton već prikazuju; 071 ga u formi čini EDITABILNIM,
--                        PatchAssetCoreDto.status je već postojao)
--   Lokacija (UPS)     = maint_it_asset_details.office_location (od 067; u formi
--                        „Lokacija" za mrežnu opremu / napajanje, „Kancelarija" za
--                        štampače). maint_assets.location_id NIJE upotrebljiv —
--                        maint_locations je prazna tabela (0 redova, 0/139 sredstava
--                        ima location_id, mereno na živoj sy15 05.08.2026).
-- NOVO (2 text kolone na maint_it_asset_details — isti obrazac kao 065/066/067,
-- NE jsonb):
--   power_rating      (071 UPS  — snaga, slobodan tekst „1500 VA / 900 W")
--   firmware_version  (071 mrežna oprema — verzija firmvera sa UniFi naloga;
--                      dodato CELOJ 'network' kategoriji, ne samo AP-u: switch,
--                      router i firewall imaju isti podatak na istom nalogu)
--
-- ⚠️ OVAJ FAJL SE NE IZVRŠAVA AUTOMATSKI I NIJE PRIMENJEN NA ŽIVU BAZU.
--    Primenu na sy15 (glavna baza, self-hosted Supabase na ubuntusrv) radi
--    glavna sesija RUČNO, kao supabase_admin (vlasnik fn/view). Nema Prisma
--    migracije — sy15 objekti NISU u 3.0 migracionom lancu (prisma/sy15.prisma
--    je introspekcija). Isti obrazac kao ZAHTEV_065_066_067_IT_OPREMA_POLJA.sql.
--
-- 🔴 REDOSLED OBAVEZAN: OVAJ SQL SE PRIMENJUJE **PRE MERGE-a NA `main`**.
--    Nije „pre deploy-a" — MERGE JESTE DEPLOY: .github/workflows/deploy-backend.yml
--    okida na push na `main` sa paths `backend/**` (minus docs/test/scripts), a
--    ova grana menja backend/src/** i backend/prisma/** → nema prozora „prvo
--    merge pa se nađe trenutak za SQL".
--    Prisma model MaintItAssetDetails posle ove grane SELECT-uje i nove 2 kolone
--    pri SVAKOM čitanju kartona (findUnique) → backend na produ bez primenjenog
--    SQL-a puca sa 42703 (undefined_column: „power_rating") na GET /maintenance/
--    it-assets/:id i PUT …/details.
--    ⚠️ Kvar je PODMUKAO, ne pada ceo modul: lista IT opreme ide kroz $queryRaw
--    SELECT * (nabraja kolone koje zatekne) pa i dalje radi — puca samo karton
--    pojedinačnog sredstva. Izgleda kao „ne otvara se jedan uređaj", ne kao
--    „održavanje je palo".
--    POVRATAK (rollback): vratiti deploy backenda na prethodni build, a KOLONE
--    OSTAVITI — stari backend ih ne poznaje i ne dira, view i funkcija sa novim
--    kolonama su mu nevidljivi (izmereno: obrnut smer, primenjen SQL + stari
--    backend, radi bez greške). DROP COLUMN nije potreban i nije poželjan (brisao
--    bi podatke koje je novi FE u međuvremenu upisao).
--
-- Sadržaj (redosled unutar fajla je i redosled izvršavanja):
--   1) ALTER TABLE maint_it_asset_details — 2 nove NULL-abilne text kolone
--   2) CREATE OR REPLACE create_maint_it_asset — p_details prima i nova 2
--      ključa (NULLIF '' obrazac; enum kast statusa OSTAJE — pouka 42804 od
--      04.08). Telo je živa definicija od 05.08.2026 (pg_get_functiondef) +
--      2 reda. COR čuva vlasnika (supabase_admin) i EXECUTE grantove —
--      GRANT-ovi NISU potrebni. Živi ACL (mereno 05.08.2026): supabase_admin,
--      postgres, authenticated, service_role. `anon` NEMA EXECUTE i NE dobija
--      ga ovim fajlom (kreiranje IT opreme nije javno).
--   3) CREATE OR REPLACE VIEW v_maint_it_overview — postojeće kolone identično
--      (COR view dozvoljava SAMO dodavanje na kraj), nova 2 APPEND na kraj;
--      WITH (security_invoker = true) EKSPLICITNO (živa vrednost 05.08.2026,
--      ne sme da ispadne — RLS na maint_* tabelama mora da važi za čitaoca).
--
-- ── Provera POSLE primene ───────────────────────────────────────────────────
--   SELECT count(*) FROM information_schema.columns
--    WHERE table_name='maint_it_asset_details'
--      AND column_name IN ('power_rating','firmware_version');   -- mora biti 2
--   SELECT prosrc ~ 'firmware_version' FROM pg_proc
--    WHERE proname='create_maint_it_asset';                      -- mora biti t
--   SELECT reloptions FROM pg_class
--    WHERE relname='v_maint_it_overview';    -- mora sadržati security_invoker=true
-- pa iz aplikacije: Održavanje → IT oprema → „Nova IT oprema" → tip „tablet"
-- (hardver polja) / „UPS" (lokacija + snaga) / „access point" (lokacija, UniFi
-- portovi, firmver + Status u sekciji Osnovno i Model u sekciji Hardver).
-- ============================================================================

-- SVA TRI KORAKA IDU U JEDNOJ TRANSAKCIJI (PostgreSQL je transakcion i za DDL).
-- Bez toga bi pad koraka 2 ili 3 ostavio commit-ovane kolone uz staru funkciju →
-- tih polu-rezultat: „Nova IT oprema" se i dalje kreira, ali snaga i firmver
-- uneti kroz nju NESTAJU bez ijedne greške (funkcija ih ne zna, INSERT prolazi).
-- Ako bilo šta pukne, ceo fajl se poništava — bolje nego pola primene.

BEGIN;

-- ── 1) Nove kolone ──────────────────────────────────────────────────────────

ALTER TABLE public.maint_it_asset_details
  ADD COLUMN IF NOT EXISTS power_rating      text,
  ADD COLUMN IF NOT EXISTS firmware_version  text;

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
    power_rating, firmware_version,
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
    NULLIF(p_details->>'power_rating', ''),
    NULLIF(p_details->>'firmware_version', ''),
    v_user_id
  );

  RETURN v_asset_id;
END;
$function$;

-- ── 3) v_maint_it_overview — nova 2 kolone APPEND na kraj ───────────────────
-- Postojeće kolone/izrazi 1:1 kao živa definicija (pg_get_viewdef 05.08.2026);
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
    d.unifi_ports,
    d.power_rating,
    d.firmware_version
   FROM maint_assets a
     LEFT JOIN maint_it_asset_details d ON d.asset_id = a.asset_id
  WHERE a.asset_type = 'it'::maint_asset_type;

COMMIT;
