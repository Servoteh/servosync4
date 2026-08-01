-- ============================================================================
-- ZAHTEV 041/26 — Šef sa pravom odobravanja GO unosi BOLOVANJE svom timu
-- Datum: 2026-07-29 · grana: feat/kadr-bolovanje-041
--
-- ⚠️ OVAJ FAJL SE NE IZVRŠAVA AUTOMATSKI. Primenu radi Nenad ručno na sy15
--    (glavna/1.0 baza), posle pregleda. NEMA Prisma migracije — sy15 objekti
--    NISU u 3.0 migracionom lancu (`backend/prisma/migrations` gađa 3.0 bazu,
--    `DATABASE_URL`; `work_hours`/`kadr_holidays`/`current_user_manages_employee`
--    žive u sy15, `SY15_DATABASE_URL`, introspektovano u `prisma/sy15.prisma`,
--    bez migracija). Isti obrazac kao `ZAHTEV_028_GO_BRANE.sql`.
--
-- ── Zašto ────────────────────────────────────────────────────────────────────
-- Zahtev 041/26 (poboljšanje): vođa tima koji SME da odobrava godišnji odmor
-- (permisija `kadrovska.vacreq_manage`) treba da može i da UNESE BOLOVANJE svom
-- članu tima (npr. Jelena Stanišić za Draganu Mađerčić). Danas u grid (work_hours)
-- piše samo allowlista urednika grida (Nikola Mrkajić, `can_edit_kadrovska_grid()`).
--
-- Odluka (potvrđena): Opcija A — piše se u GRID (`work_hours`, obračunski ispravno),
-- a NE samo u `absences`. Gejt je `current_user_manages_employee` (opseg tima), NE
-- allowlista urednika grida. Ruta na aplikaciji je iza `kadrovska.vacreq_manage`
-- (isključuje običnog `tim_lider`-a); ova funkcija je DRUGA (DB) brana.
--
-- ── Model upisa ──────────────────────────────────────────────────────────────
-- Doslovno po uzoru na `kadr_grid_set_go` (talasG-fn-defs-2026-07-12.sql:2971),
-- uz tri razlike:
--   1. INTERNI gejt na `current_user_manages_employee(p_employee_id)` umesto
--      `can_edit_kadrovska_grid()` — bolovanje sme SAMO šef tog radnika (opseg
--      pododeljenja / uloga), ne urednik grida. Gejt je unutar funkcije (SECURITY
--      DEFINER) pa štiti i puteve koje aplikacija ne dodiruje (ručni SQL, budući RPC).
--   2. `absence_code='bo'` + `absence_subtype = p_subtype` (validiran skup:
--      obicno / povreda_na_radu / odrzavanje_trudnoce) — poklapa se sa
--      `SICK_SUBTYPE_OPTS` i grid bo/bop/bot prikazom.
--   3. ON CONFLICT gazi SAMO ako je postojeći dan prazan (absence_code IS NULL)
--      ili već `bo` — nikad ne pregazi 'go' ili drugi tip dana (isti guard kao set_go).
--
-- Vikendi i praznici se PRESKAČU (isti filter kao set_go: isodow < 6 i nije
-- `kadr_holidays.is_workday=false`).
--
-- NAPOMENA: `kadr_grid_set_go` ovde SVESNO NEMA fond-guard iz ZAHTEV_028 — bolovanje
-- ne troši fond godišnjeg odmora, pa nema kape nad `vacation_entitlements`.
--
-- ── Vlasništvo / privilegije ─────────────────────────────────────────────────
-- Funkcija MORA biti napravljena pod ISTIM vlasnikom kao `kadr_grid_set_go`
-- (supabase_admin/postgres) da SECURITY DEFINER radi sa istim pravima. Aplikacija
-- je zove pod `SET LOCAL ROLE authenticated` (withUserRls) → treba GRANT EXECUTE
-- rolI `authenticated` (kao sve kadr_/hr_ DEFINER familije).
--
-- PRE PRIMENE uporediti sa živim stanjem (da polazne definicije nisu odlutale):
--   SELECT pg_get_functiondef('public.kadr_grid_set_go(uuid,date,date,text)'::regprocedure);
--   SELECT pg_get_functiondef('public.current_user_manages_employee(uuid)'::regprocedure);
-- ============================================================================


-- ============================================================================
-- 1) kadr_grid_set_sick — upis bolovanja u grid (opseg tima kao gejt)
-- ============================================================================
CREATE OR REPLACE FUNCTION public.kadr_grid_set_sick(
  p_employee_id uuid,
  p_date_from   date,
  p_date_to     date,
  p_subtype     text DEFAULT 'obicno',
  p_actor       text DEFAULT NULL::text
)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_n integer;
BEGIN
  IF p_employee_id IS NULL OR p_date_from IS NULL OR p_date_to IS NULL
     OR p_date_to < p_date_from THEN
    RETURN 0;
  END IF;

  /* ── GEJT: bolovanje sme SAMO šef ovog radnika (opseg tima), NE urednik grida ── */
  IF NOT public.current_user_manages_employee(p_employee_id) THEN
    RAISE EXCEPTION 'not_in_your_team'
      USING ERRCODE = '42501',
            HINT = 'Bolovanje možete uneti samo za člana svog tima.';
  END IF;

  /* ── Podtip bolovanja (poklapa se sa CHECK-om i SICK_SUBTYPE_OPTS) ─────────── */
  IF COALESCE(p_subtype, 'obicno') NOT IN ('obicno', 'povreda_na_radu', 'odrzavanje_trudnoce') THEN
    RAISE EXCEPTION 'invalid_subtype'
      USING ERRCODE = '22023',
            HINT = 'Podtip bolovanja mora biti obicno | povreda_na_radu | odrzavanje_trudnoce.';
  END IF;

  INSERT INTO work_hours (employee_id, work_date, hours, absence_code, absence_subtype, last_edited_by, updated_at)
  SELECT p_employee_id, g.d::date, 0, 'bo', COALESCE(p_subtype, 'obicno'), p_actor, now()
  FROM generate_series(p_date_from, p_date_to, interval '1 day') g(d)
  WHERE extract(isodow from g.d::date) < 6
    AND NOT EXISTS (
      SELECT 1 FROM kadr_holidays h
       WHERE h.holiday_date = g.d::date AND h.is_workday = false
    )
  ON CONFLICT (employee_id, work_date) DO UPDATE
    SET absence_code    = 'bo',
        absence_subtype = EXCLUDED.absence_subtype,
        hours           = 0,
        last_edited_by  = EXCLUDED.last_edited_by,
        updated_at      = now()
    WHERE work_hours.absence_code IS NULL OR work_hours.absence_code = 'bo';

  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$function$
;

GRANT EXECUTE ON FUNCTION public.kadr_grid_set_sick(uuid, date, date, text, text) TO authenticated;


-- ============================================================================
-- 2) kadr_grid_unset_sick — skidanje bolovanja (simetrično, isti gejt)
-- ============================================================================
CREATE OR REPLACE FUNCTION public.kadr_grid_unset_sick(
  p_employee_id uuid,
  p_date_from   date,
  p_date_to     date
)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_n integer;
BEGIN
  IF p_employee_id IS NULL OR p_date_from IS NULL OR p_date_to IS NULL THEN
    RETURN 0;
  END IF;

  IF NOT public.current_user_manages_employee(p_employee_id) THEN
    RAISE EXCEPTION 'not_in_your_team'
      USING ERRCODE = '42501',
            HINT = 'Bolovanje možete skinuti samo za člana svog tima.';
  END IF;

  DELETE FROM work_hours
   WHERE employee_id = p_employee_id
     AND work_date BETWEEN p_date_from AND p_date_to
     AND absence_code = 'bo';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$function$
;

GRANT EXECUTE ON FUNCTION public.kadr_grid_unset_sick(uuid, date, date) TO authenticated;


-- ============================================================================
-- ROLLBACK (ako zatreba)
-- ============================================================================
--   DROP FUNCTION IF EXISTS public.kadr_grid_set_sick(uuid, date, date, text, text);
--   DROP FUNCTION IF EXISTS public.kadr_grid_unset_sick(uuid, date, date);
-- ============================================================================
