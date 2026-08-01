-- ============================================================================
-- ZAHTEV 047/26 (review popravka) — rename mašine mora da PONESE SREDSTVO
-- Datum: 2026-07-31 · grana: fix/zahtev-047-masina-sifra · PR #64
--
-- ⚠️ OVAJ FAJL SE NE IZVRŠAVA AUTOMATSKI I NIJE PRIMENJEN NA ŽIVU BAZU.
--    Primenu na sy15 (glavna baza, self-hosted Supabase na ubuntusrv) radi glavna
--    sesija RUČNO. Nema Prisma migracije — sy15 objekti NISU u 3.0 migracionom
--    lancu (`backend/prisma/migrations` gađa 3.0 bazu preko `DATABASE_URL`;
--    `maint_*` živi u sy15, `SY15_DATABASE_URL`, introspektovano u
--    `prisma/sy15.prisma`, bez migracija). Isti obrazac kao
--    `ZAHTEV_028_GO_BRANE.sql` / `ZAHTEV_041_BOLOVANJE_TIM.sql`.
--
-- 🔴 REDOSLED JE OBAVEZAN: OVAJ SQL SE PRIMENJUJE **PRE** MERGE-A/DEPLOY-A PR-a #64.
--    Otpis mašine iz 3.0 od PR-a #64 zove `maint_machine_rename` na SVAKOM otpisu i
--    restore-u. Sa starom (živom) definicijom funkcije taj rename OTKAČI mašinu od
--    njenog `maint_assets` reda → gubi se istorija radnih naloga i dokumenata.
--
-- ── Šta je pokvareno (nalazi review-a PR #64) ────────────────────────────────
-- Živa `public.maint_machine_rename` (snapshot: docs/design/authz-snapshots/
-- talasF-fn-defs-2026-07-12.sql:1581) radi INSERT-kopiju reda `maint_machines`
-- pod novom šifrom, pa DELETE stare. Lista kolona u toj kopiji NE sadrži
-- `asset_id` (ni `responsible_user_id`), pa BEFORE INSERT trigger
-- `maint_machines_ensure_asset` traži sredstvo PO ŠIFRI:
--
--     SELECT a.asset_id ... WHERE lower(a.asset_code) = lower(NEW.machine_code)
--                             AND a.asset_type = 'machine'
--     -- ako ne nađe → INSERT novog reda u maint_assets
--
-- Posledice na produkciji (mašina 3.10 otpisana 30.07.2026):
--   1. Otpis `3.10` → `3.10#ARH-20260730`: trigger ne nalazi sredstvo pod novom
--      šifrom i PRAVI NOVO (prazno) sredstvo. Radni nalozi, prijave kvarova i
--      dokumenta vise o STAROM `asset_id` → karton otpisane mašine je prazan,
--      iako dijalog korisniku obećava da istorija ostaje.
--   2. `archive_reason` / `archived_by` (otpis ih upisuje na sredstvo PRE rename-a)
--      ostaju na osirotelom starom sredstvu.
--   3. Nova mašina pod oslobođenom šifrom `3.10` → trigger je veže na STARO
--      (arhivirano, `active=false`) sredstvo → nasleđuje tuđu istoriju i NE pojavljuje
--      se u pickerima novog naloga/prijave kvara. To je tačno ono što 047/26 traži
--      da radi — pa funkcija u tom obliku obara sam zahtev.
--   4. Restore: mašina se vrati na i dalje arhivirano originalno sredstvo, a
--      privremeno `#ARH` sredstvo ostane AKTIVAN fantom u registru sredstava.
--   5. `maint_machine_files` (ključ `machine_code`, bez FK) se NE seli → dokumenta
--      stare mašine preuzima nova mašina sa istom šifrom.
--
-- ── Šta ovaj fajl radi ───────────────────────────────────────────────────────
--   1) CREATE OR REPLACE `public.maint_machine_rename`:
--        a) kopija reda nosi `asset_id` I `responsible_user_id` (trigger poštuje
--           već popunjen `asset_id`: `IF NEW.asset_id IS NOT NULL THEN RETURN NEW`),
--        b) `maint_assets.asset_code` sredstva TE mašine se preimenuje u istoj
--           transakciji (ogledalo ostaje konzistentno, a nova mašina pod oslobođenom
--           šifrom više ne može da „nasledi" staro sredstvo),
--        c) seli se i `maint_machine_files` (7. tabela; ključ je `machine_code` —
--           provereno u `prisma/sy15.prisma` model `MaintMachineFile` i u
--           `maint_machine_delete_hard` koji briše `WHERE machine_code = …`),
--        d) potpis i povratni JSON ostaju kompatibilni (samo se DODAJU brojači
--           `files`, `asset_id`, `asset_code_renamed`).
--   2) DATA-FIX zatečenog stanja (odvojena transakcija, idempotentan DO blok).
--
-- Trigger `maint_machines_ensure_asset` se NE menja — već poštuje prosleđen
-- `asset_id` i ostaje jedina fabrika sredstava za NOVE mašine.
--
-- SVESNO NETAKNUTO: `loc_locations` (skriveno pravilo §2.5.14 — rename mašine ne
-- dira lokacije jer o `location_code` vise `part_locations` iz BigTehn domena).
--
-- ── Vlasništvo / privilegije ─────────────────────────────────────────────────
-- `CREATE OR REPLACE` zadržava vlasnika i GRANT-ove postojeće funkcije, ali MORA
-- se izvršiti kao VLASNIK funkcije (supabase_admin) — inače „must be owner of
-- function". Ne dodajemo nove GRANT-ove: aplikacija je već zove pod
-- `SET LOCAL ROLE authenticated` (withUserRls).
--
-- PRE PRIMENE uporediti sa živim stanjem (da polazna definicija nije odlutala):
--   SELECT pg_get_functiondef('public.maint_machine_rename(text,text)'::regprocedure);
--   SELECT pg_get_functiondef('public.maint_machines_ensure_asset()'::regprocedure);
--
-- ── DIJAGNOSTIKA PRE DATA-FIX-a (read-only; pokrenuti i sačuvati izlaz!) ──────
--   SELECT m.machine_code,
--          m.archived_at                                   AS masina_arhivirana,
--          ma.asset_id                                     AS trenutni_asset,
--          ma.asset_code                                   AS trenutni_asset_kod,
--          ma.active, ma.archived_at AS asset_arhiviran, ma.archive_reason,
--          (SELECT count(*) FROM public.maint_work_orders w
--            WHERE w.asset_id = ma.asset_id)                AS naloga_na_trenutnom,
--          oa.asset_id                                     AS original_asset,
--          oa.asset_code                                   AS original_kod,
--          oa.active AS original_active, oa.archived_at AS original_arhiviran,
--          oa.archive_reason                               AS original_razlog,
--          (SELECT count(*) FROM public.maint_work_orders w
--            WHERE w.asset_id = oa.asset_id)                AS naloga_na_originalu,
--          (SELECT count(*) FROM public.maint_documents d
--            WHERE d.asset_id = oa.asset_id AND d.deleted_at IS NULL)
--                                                          AS dokumenata_na_originalu,
--          (SELECT count(*) FROM public.maint_machine_files f
--            WHERE f.machine_code = regexp_replace(m.machine_code,
--                                    '#ARH-[0-9]{8}(-[0-9]+)?$', ''))
--                                                          AS fajlova_na_staroj_sifri,
--          (SELECT count(*) FROM public.maint_machines m2
--            WHERE m2.asset_id = oa.asset_id)               AS masina_na_originalu
--     FROM public.maint_machines m
--     JOIN public.maint_assets   ma ON ma.asset_id = m.asset_id
--     LEFT JOIN public.maint_assets oa
--            ON oa.asset_type = 'machine'
--           AND lower(oa.asset_code) = lower(regexp_replace(m.machine_code,
--                                              '#ARH-[0-9]{8}(-[0-9]+)?$', ''))
--    WHERE m.machine_code ~ '#ARH-[0-9]{8}(-[0-9]+)?$'
--    ORDER BY m.machine_code;
--
--   Očekivano za zatečeni prod: jedan red — `3.10#ARH-20260730`, `trenutni_asset_kod`
--   = `3.10#ARH-20260730` (fantom, `naloga_na_trenutnom` = 0), `original_kod` = `3.10`
--   sa `naloga_na_originalu` > 0 i `masina_na_originalu` = 0. Ako je
--   `masina_na_originalu` > 0 (neko je već uneo novu mašinu 3.10), DATA-FIX taj red
--   PRESKAČE i ispisuje NOTICE — tada odluku donosi čovek.
-- ============================================================================


-- ============================================================================
-- 1) maint_machine_rename — rename PK-a koji NOSI sredstvo i dokumenta
-- ============================================================================
BEGIN;

CREATE OR REPLACE FUNCTION public.maint_machine_rename(p_old_code text, p_new_code text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_allowed     BOOLEAN;
  v_asset_id    UUID;
  v_asset_code  TEXT;
  v_asset_ren   BOOLEAN := false;
  v_cnt_tasks   INT := 0;
  v_cnt_checks  INT := 0;
  v_cnt_inc     INT := 0;
  v_cnt_notes   INT := 0;
  v_cnt_ovr     INT := 0;
  v_cnt_notif   INT := 0;
  v_cnt_files   INT := 0;
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

  SELECT m.asset_id INTO v_asset_id
    FROM public.maint_machines m
   WHERE m.machine_code = p_old_code;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'maint_machine_rename: machine "%" does not exist', p_old_code;
  END IF;
  IF EXISTS (SELECT 1 FROM public.maint_machines WHERE machine_code = p_new_code) THEN
    RAISE EXCEPTION 'maint_machine_rename: machine "%" already exists', p_new_code;
  END IF;

  /* 1) Kreiraj novi katalog red kao KOPIJU starog. Izbegavamo direktan UPDATE PK
        da bi child redovi u sledećim koracima uspeli da nađu novi red (nemamo FK).

        ⚠️ 047/26: kopija MORA da ponese `asset_id` (i `responsible_user_id`).
        Bez `asset_id` BEFORE INSERT trigger `maint_machines_ensure_asset` traži
        sredstvo po NOVOJ šifri i, kad ga ne nađe, pravi PRAZNO novo — mašina tako
        gubi radne naloge, prijave kvarova i dokumenta (sve visi o `asset_id`).
        Trigger poštuje već popunjen `asset_id` (`IF NEW.asset_id IS NOT NULL
        THEN RETURN NEW`), pa ovde ne treba nikakva izmena trigera. */
  INSERT INTO public.maint_machines (
    machine_code, name, type, manufacturer, model, serial_number,
    year_of_manufacture, year_commissioned, location, department_id,
    power_kw, weight_kg, notes, tracked, archived_at, source,
    responsible_user_id, asset_id,
    created_at, updated_at, updated_by
  )
  SELECT
    p_new_code, name, type, manufacturer, model, serial_number,
    year_of_manufacture, year_commissioned, location, department_id,
    power_kw, weight_kg, notes, tracked, archived_at, source,
    responsible_user_id, asset_id,
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

  /* 2b) 047/26 — 7. tabela: dokumenta mašine. `maint_machine_files` je vezan
         ISKLJUČIVO po `machine_code` (nema `asset_id`, nema FK — vidi
         `prisma/sy15.prisma` model MaintMachineFile i `maint_machine_delete_hard`
         koji briše `WHERE machine_code = …`). Bez ovog koraka fajlovi ostaju na
         staroj šifri i pripadnu prvoj sledećoj mašini koja je zauzme. */
  UPDATE public.maint_machine_files SET machine_code = p_new_code
   WHERE machine_code = p_old_code;
  GET DIAGNOSTICS v_cnt_files = ROW_COUNT;

  /* 3) 047/26 — ogledalo u `maint_assets`. Šifra sredstva prati šifru mašine samo
        ako je do sada bila njen odraz (trigger je tako i pravi). Time:
          • lookup po `asset_code` ostaje konzistentan,
          • oslobođena stara šifra više ne pokazuje ni na jedno sredstvo, pa nova
            mašina pod tom šifrom dobija SVOJE novo sredstvo (a ne tuđu istoriju).
        Ako sredstvo ima ručno zadatu (drugačiju) šifru — ne diramo ga. */
  IF v_asset_id IS NOT NULL THEN
    SELECT a.asset_code INTO v_asset_code
      FROM public.maint_assets a
     WHERE a.asset_id = v_asset_id;

    IF lower(coalesce(v_asset_code, '')) = lower(p_old_code) THEN
      IF EXISTS (
        SELECT 1 FROM public.maint_assets a2
         WHERE a2.asset_id <> v_asset_id
           AND a2.asset_type = 'machine'
           AND lower(a2.asset_code) = lower(p_new_code)
      ) THEN
        RAISE EXCEPTION
          'maint_machine_rename: šifru sredstva "%" već koristi drugo sredstvo — očisti maint_assets pa ponovi',
          p_new_code USING ERRCODE = '23505';
      END IF;

      UPDATE public.maint_assets
         SET asset_code = p_new_code,
             updated_by = auth.uid()
       WHERE asset_id = v_asset_id;
      v_asset_ren := true;
    END IF;
  END IF;

  /* 4) Obriši stari katalog red. */
  DELETE FROM public.maint_machines WHERE machine_code = p_old_code;

  RETURN jsonb_build_object(
    'old_code',      p_old_code,
    'new_code',      p_new_code,
    'tasks',         v_cnt_tasks,
    'checks',        v_cnt_checks,
    'incidents',     v_cnt_inc,
    'notes',         v_cnt_notes,
    'overrides',     v_cnt_ovr,
    'notifications', v_cnt_notif,
    -- NOVO (047/26): dokumenta i sredstvo
    'files',              v_cnt_files,
    'asset_id',           v_asset_id,
    'asset_code_renamed', v_asset_ren
  );
END;
$function$;

COMMIT;


-- ============================================================================
-- 2) DATA-FIX zatečenog stanja (ODVOJENA transakcija — sme i da se preskoči)
--    Sanira mašine koje su OTPISANE STARIM rename-om, pa su ostale otkačene od
--    svog sredstva. Idempotentno: drugi put ne radi ništa (uslov `trenutni asset
--    nosi #ARH šifru` više ne važi).
--
--    Konkretno zatečeno stanje: `3.10#ARH-20260730` (otpisana 30.07.2026).
--    Blok je pisan generički (svaka `%#ARH-YYYYMMDD[-N]` mašina), ali sa tvrdim
--    branama — svaki sumnjiv slučaj se PRESKAČE uz NOTICE, ništa se ne pogađa
--    „na slepo".
-- ============================================================================
BEGIN;

DO $fix$
DECLARE
  v_m        RECORD;
  v_phantom  public.maint_assets%ROWTYPE;
  v_orig     public.maint_assets%ROWTYPE;
  v_refs     INT;
  v_fixed    INT := 0;
  v_skipped  INT := 0;
BEGIN
  FOR v_m IN
    SELECT m.machine_code,
           m.asset_id,
           regexp_replace(m.machine_code, '#ARH-[0-9]{8}(-[0-9]+)?$', '') AS base_code
      FROM public.maint_machines m
     WHERE m.machine_code ~ '#ARH-[0-9]{8}(-[0-9]+)?$'
     ORDER BY m.machine_code
  LOOP
    -- Sredstvo na koje mašina TRENUTNO pokazuje.
    SELECT * INTO v_phantom
      FROM public.maint_assets WHERE asset_id = v_m.asset_id;

    -- Ako sredstvo ne nosi ARH šifru → mašina je već ispravno vezana (ili je
    -- sredstvo ručno imenovano) → ne diramo.
    CONTINUE WHEN v_phantom.asset_id IS NULL
               OR lower(v_phantom.asset_code) <> lower(v_m.machine_code);

    -- Originalno sredstvo = ono koje je ostalo pod BAZNOM šifrom.
    SELECT * INTO v_orig
      FROM public.maint_assets
     WHERE asset_type = 'machine'
       AND lower(asset_code) = lower(v_m.base_code)
     ORDER BY created_at
     LIMIT 1;

    IF v_orig.asset_id IS NULL THEN
      RAISE NOTICE '047 data-fix: % — nema sredstva pod baznom šifrom "%", preskačem',
        v_m.machine_code, v_m.base_code;
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;

    -- BRANA: ako je originalno sredstvo u međuvremenu preuzela NEKA mašina
    -- (npr. već je uneta nova 3.10), NE otimamo ga — odluku donosi čovek.
    IF EXISTS (SELECT 1 FROM public.maint_machines m2
                WHERE m2.asset_id = v_orig.asset_id) THEN
      RAISE NOTICE '047 data-fix: % — originalno sredstvo % već koristi druga mašina, preskačem',
        v_m.machine_code, v_orig.asset_code;
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;

    -- 2a) Mašina se vraća na SVOJE (istorijsko) sredstvo…
    UPDATE public.maint_machines
       SET asset_id = v_orig.asset_id
     WHERE machine_code = v_m.machine_code;

    -- 2b) …a sredstvo dobija ARH šifru (ogledalo, kao posle popravljenog rename-a).
    UPDATE public.maint_assets
       SET asset_code = v_m.machine_code
     WHERE asset_id = v_orig.asset_id;

    -- 2c) Fantom: briše se SAMO ako baš ništa ne pokazuje na njega.
    SELECT
      (SELECT count(*) FROM public.maint_work_orders        WHERE asset_id = v_phantom.asset_id)
    + (SELECT count(*) FROM public.maint_documents          WHERE asset_id = v_phantom.asset_id)
    + (SELECT count(*) FROM public.maint_incidents          WHERE asset_id = v_phantom.asset_id)
    + (SELECT count(*) FROM public.maint_tasks              WHERE asset_id = v_phantom.asset_id)
    + (SELECT count(*) FROM public.maint_asset_service_plan WHERE asset_id = v_phantom.asset_id)
    + (SELECT count(*) FROM public.maint_machines           WHERE asset_id = v_phantom.asset_id)
    + (SELECT count(*) FROM public.maint_vehicle_details    WHERE asset_id = v_phantom.asset_id)
    + (SELECT count(*) FROM public.maint_it_asset_details   WHERE asset_id = v_phantom.asset_id)
    + (SELECT count(*) FROM public.maint_facility_details   WHERE asset_id = v_phantom.asset_id)
      INTO v_refs;

    IF v_refs = 0 THEN
      DELETE FROM public.maint_assets WHERE asset_id = v_phantom.asset_id;
      RAISE NOTICE '047 data-fix: % — vezana na %, fantom sredstvo obrisano',
        v_m.machine_code, v_orig.asset_id;
    ELSE
      -- Neko je ipak zakačio nešto za fantom → ne brišemo, samo ga gasimo da ne
      -- visi u registru/pickerima sredstava.
      UPDATE public.maint_assets
         SET active      = false,
             archived_at = coalesce(archived_at, now()),
             asset_code  = v_phantom.asset_code || '#FANTOM',
             notes       = coalesce(notes || E'\n', '')
                           || '047/26: privremeno sredstvo iz starog rename-a; ima ' || v_refs || ' referenci — ručno prebaciti pa obrisati.'
       WHERE asset_id = v_phantom.asset_id;
      RAISE NOTICE '047 data-fix: % — vezana na %, fantom ima % referenci → deaktiviran, NIJE obrisan',
        v_m.machine_code, v_orig.asset_id, v_refs;
    END IF;

    v_fixed := v_fixed + 1;
  END LOOP;

  RAISE NOTICE '047 data-fix: sanirano %, preskočeno %', v_fixed, v_skipped;
END
$fix$;

COMMIT;


-- ============================================================================
-- PROVERA POSLE PRIMENE (read-only)
-- ============================================================================
-- 1) Funkcija nosi asset_id i fajlove:
--   SELECT pg_get_functiondef('public.maint_machine_rename(text,text)'::regprocedure)
--          LIKE '%maint_machine_files%'  AS seli_fajlove,
--          pg_get_functiondef('public.maint_machine_rename(text,text)'::regprocedure)
--          LIKE '%responsible_user_id, asset_id%' AS nosi_asset;
--
-- 2) Nijedna otpisana (#ARH) mašina više ne visi o „praznom" sredstvu:
--   SELECT m.machine_code, ma.asset_code,
--          (SELECT count(*) FROM public.maint_work_orders w WHERE w.asset_id = m.asset_id) AS naloga
--     FROM public.maint_machines m
--     JOIN public.maint_assets ma ON ma.asset_id = m.asset_id
--    WHERE m.machine_code ~ '#ARH-[0-9]{8}(-[0-9]+)?$';
--   -- očekivano: asset_code = machine_code i naloga > 0 tamo gde je mašina imala istoriju
--
-- 3) Nema fantomskih sredstava bez mašine pod ARH šifrom:
--   SELECT a.asset_id, a.asset_code, a.active
--     FROM public.maint_assets a
--    WHERE a.asset_type = 'machine'
--      AND a.asset_code ~ '#ARH-'
--      AND NOT EXISTS (SELECT 1 FROM public.maint_machines m WHERE m.asset_id = a.asset_id);
--   -- očekivano: 0 redova
--
-- 4) Dokumenta otpisane mašine su na ARH šifri (a ne na oslobođenoj):
--   SELECT machine_code, count(*) FROM public.maint_machine_files
--    WHERE deleted_at IS NULL GROUP BY 1 ORDER BY 1;
