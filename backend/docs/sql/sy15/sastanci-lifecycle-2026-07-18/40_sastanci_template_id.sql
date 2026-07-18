-- =====================================================================================
-- sy15 (1.0 PRODUKCIJA) — S5: aditivna kolona `sastanci.template_id` + backfill
-- Datum: 2026-07-18 · Paket: FAZA 4 / S5 (docs/PLAN_IZMENE_KORISNIKA_2026-07.md)
-- Status: NIJE PRIMENJENO. Skriptu primenjuje ISKLJUČIVO vlasnik, ručno.
--         (Agent koji ju je napisao NE izvršava SQL nad bazom — ni lokalno ni udaljeno.)
-- =====================================================================================
--
-- ZAŠTO
-- -----
-- Tab „Šabloni" dobija kolonu „Poslednji sastanak" (poslednji već održan termin serije).
-- Veza instanca→šablon u 1.0 šemi NE POSTOJI: `sastanci_templates.instantiate` upisuje
-- samo `naslov := tpl.naziv`. Do primene ove skripte 2.0 backend koristi HEURISTIKU
-- `lower(btrim(sastanci.naslov)) = lower(btrim(sastanci_templates.naziv))`
-- (`backend/src/modules/sastanci/sastanci.service.ts` → `listTemplates`). Heuristika
-- promašuje čim korisnik ručno preimenuje instancu (novo dugme „Uredi", paket S4) ili
-- kad dva šablona nose isti naziv. Ova kolona je pravi, stabilan ključ.
--
-- ZAŠTO JE BEZBEDNO ZA PARALELAN RAD 1.0
-- --------------------------------------
-- 1. STROGO ADITIVNO: nova NULLABLE kolona bez DEFAULT-a. Postgres 11+ ovo radi kao
--    čistu izmenu kataloga (bez prepisivanja tabele, bez dugog lock-a); ništa se ne
--    briše, ne preimenuje i ne menja tip.
-- 2. 1.0 klijent kolonu ne poznaje — njegovi INSERT/UPDATE nabrajaju kolone, pa upisuje
--    NULL i nastavlja bez ikakve promene ponašanja. PostgREST/Supabase `SELECT *` samo
--    dobija jedno polje više.
-- 3. Bez FK ka `sastanci_templates` — NAMERNO: 1.0 šema uopšte ne koristi FK veze na
--    ovim tabelama (doktrina §A.1, `prisma/sy15.prisma` je bez relacija), a RESTRICT bi
--    slomio postojeći DELETE šablona (2.0 `deleteTemplate`). Osirotele reference su
--    prihvatljive: čitanje uvek ide kroz LEFT JOIN.
-- 4. Backfill puni SAMO redove gde je `template_id IS NULL` — idempotentan je i ponovno
--    pokretanje ne može da pregazi kasnije, tačnije vrednosti.
-- 5. Tabela `sastanci` je mala (redovi reda veličine stotina), pa je pun `CREATE INDEX`
--    (bez CONCURRENTLY) u transakciji kratak. CONCURRENTLY se NE koristi jer ne sme u
--    transakcioni blok, a atomičnost cele skripte je ovde vrednija.
--
-- ⚠ TRIGERI TOKOM BACKFILL-a
-- --------------------------
-- Na `sastanci` visi `sast_check_not_locked()` (SECURITY DEFINER): svaki UPDATE reda sa
-- `status='zakljucan'` puca sa ERRCODE 23514 osim ako `current_user_is_management()`
-- vrati TRUE. Ta funkcija čita `auth.jwt() ->> 'email'`, a u SQL editoru / psql sesiji
-- JWT-a NEMA → vraća FALSE → backfill bi pukao na svakom zaključanom sastanku (a upravo
-- su zaključani ono što nas zanima kao „poslednji"). Zato backfill ide uz
-- `SET LOCAL session_replication_role = replica` — trigeri se gase SAMO za ovu
-- transakciju i SAMO za ovu sesiju (bez lock-a na tabeli, bez uticaja na paralelne 1.0
-- sesije). Time se usput garantuje da nijedan `sastanci_enqueue_*` triger ne pošalje
-- mejl zbog tehničkog UPDATE-a.
-- Ako `session_replication_role` nije dozvoljen ulogom kojom se prijavljuješ, zameni ga
-- alternativom iz koraka 3b (ALTER TABLE ... DISABLE TRIGGER USER) — ona je takođe
-- korektna, ali drži ACCESS EXCLUSIVE lock nad `sastanci` do COMMIT-a.
--
-- KAKO PRIMENITI
-- --------------
--   1) PREPORUČENO — psql kao `supabase_admin` (doktrina §A.6: sy15 `postgres` NIJE
--      superuser; `SET LOCAL session_replication_role` u koraku 3 traži superuser-a,
--      pa bi kao `postgres` pao sa „permission denied to set parameter" → tada ide
--      alternativa 3b):
--        psql "$SY15_URL" -v ON_ERROR_STOP=1 -f 40_sastanci_template_id.sql
--      Kroz Supabase SQL editor takođe radi, ali PRVO obriši liniju `\set ON_ERROR_STOP on`
--      ispod — to je psql meta-komanda i editor je odbija kao sintaksnu grešku.
--   2) Pokreni PROVERE (dno fajla) i uporedi brojeve.
--   3) Tek posle uspešne primene: re-introspekcija `backend/prisma/sy15.prisma`
--      (`npx prisma db pull --schema prisma/sy15.prisma`) → doda se `templateId`;
--      zatim u kodu zameni heuristiku pravim JOIN-om i dopuni `instantiate()` da
--      upisuje `templateId`. Do tada `sy15.prisma` ostaje NETAKNUT.
--
-- ROLLBACK
-- --------
--   BEGIN;
--     DROP INDEX IF EXISTS public.idx_sastanci_template_id;
--     ALTER TABLE public.sastanci DROP COLUMN IF EXISTS template_id;
--   COMMIT;
--   Bezuslovno bezbedno dok 2.0 kod ne počne da ČITA `template_id` (do tada je kolona
--   samo skladište). Posle prelaska na pravi JOIN, rollback vraća UI na heuristiku —
--   pa prvo vrati kod, pa onda kolonu.
-- =====================================================================================

\set ON_ERROR_STOP on

BEGIN;

-- ── 1. Kolona ─────────────────────────────────────────────────────────────────────
ALTER TABLE public.sastanci
  ADD COLUMN IF NOT EXISTS template_id uuid NULL;

COMMENT ON COLUMN public.sastanci.template_id IS
  'Šablon iz kog je termin instanciran (sastanci_templates.id). NULL = ad-hoc sastanak '
  'ili termin stariji od uvođenja kolone koji backfill nije razrešio. Bez FK — 1.0 šema '
  'ne koristi FK veze; čitaoci koriste LEFT JOIN.';

-- ── 2. Indeks ─────────────────────────────────────────────────────────────────────
-- Parcijalan: pretražuju se samo redovi koji PRIPADAJU šablonu (upit „poslednji termin
-- po šablonu"); ad-hoc sastanci (NULL) ne troše prostor u indeksu.
CREATE INDEX IF NOT EXISTS idx_sastanci_template_id
  ON public.sastanci (template_id, datum DESC)
  WHERE template_id IS NOT NULL;

-- ── 3. Backfill po naslovu (ista heuristika koju kod trenutno koristi) ────────────
-- Šabloni sa DUPLIM nazivom se namerno preskaču (HAVING count(*) = 1): pripisivanje
-- termina nasumičnom od dva istoimena šablona bi napravilo tiho pogrešan podatak.
-- Takve serije ostaju NULL i razrešiće se same, ubuduće, kroz instantiate().
SET LOCAL session_replication_role = replica;  -- vidi ⚠ gore (samo ova transakcija)

UPDATE public.sastanci s
   SET template_id = t.id
  FROM (
    SELECT lower(btrim(naziv)) AS key, min(id) AS id
      FROM public.sastanci_templates
     GROUP BY lower(btrim(naziv))
    HAVING count(*) = 1
  ) t
 WHERE s.template_id IS NULL
   AND lower(btrim(s.naslov)) = t.key;

SET LOCAL session_replication_role = origin;   -- vrati u istoj transakciji

-- ── 3b. ALTERNATIVA za korak 3 ────────────────────────────────────────────────────
-- Koristi SAMO ako `SET LOCAL session_replication_role` odbije uloga kojom se prijavljuješ
-- (`ERROR: permission denied to set parameter`). Efekat je isti, ali se drži ACCESS
-- EXCLUSIVE lock nad `sastanci` do COMMIT-a (kod ove veličine tabele — trenutak).
--   ALTER TABLE public.sastanci DISABLE TRIGGER USER;
--   UPDATE public.sastanci s SET template_id = t.id
--     FROM ( SELECT lower(btrim(naziv)) AS key, min(id) AS id
--              FROM public.sastanci_templates GROUP BY 1 HAVING count(*) = 1 ) t
--    WHERE s.template_id IS NULL AND lower(btrim(s.naslov)) = t.key;
--   ALTER TABLE public.sastanci ENABLE TRIGGER USER;

COMMIT;

-- =====================================================================================
-- PROVERE (pokreni ODVOJENO, posle COMMIT-a; sve su read-only)
-- =====================================================================================
--
-- P1. Kolona i indeks postoje:
--   SELECT column_name, data_type, is_nullable
--     FROM information_schema.columns
--    WHERE table_schema = 'public' AND table_name = 'sastanci' AND column_name = 'template_id';
--   -- očekivano: template_id | uuid | YES
--   SELECT indexname FROM pg_indexes
--    WHERE schemaname = 'public' AND tablename = 'sastanci' AND indexname = 'idx_sastanci_template_id';
--
-- P2. Pokrivenost backfill-a:
--   SELECT count(*) FILTER (WHERE template_id IS NOT NULL) AS povezano,
--          count(*) FILTER (WHERE template_id IS NULL)     AS bez_sablona,
--          count(*)                                        AS ukupno
--     FROM public.sastanci;
--
-- P3. Šabloni koje backfill NIJE mogao da razreši zbog duplog naziva (očekuje se prazno):
--   SELECT lower(btrim(naziv)) AS naziv, count(*)
--     FROM public.sastanci_templates
--    GROUP BY 1 HAVING count(*) > 1;
--
-- P4. Kontrola: da li „poslednji sastanak" po NOVOJ koloni odgovara heuristici koju
--     UI trenutno prikazuje (očekuje se identičan datum po šablonu, uz eventualne
--     razlike samo tamo gde je naslov ručno menjan):
--   SELECT t.naziv,
--          (SELECT max(s.datum) FROM public.sastanci s
--            WHERE s.template_id = t.id
--              AND s.status <> 'otkazan' AND s.datum <= current_date)             AS po_koloni,
--          (SELECT max(s.datum) FROM public.sastanci s
--            WHERE lower(btrim(s.naslov)) = lower(btrim(t.naziv))
--              AND s.status <> 'otkazan' AND s.datum <= current_date)             AS po_heuristici
--     FROM public.sastanci_templates t
--    ORDER BY t.naziv;
--
-- P5. Osirotele reference (šablon obrisan posle backfill-a) — informativno, nije greška:
--   SELECT count(*) FROM public.sastanci s
--    WHERE s.template_id IS NOT NULL
--      AND NOT EXISTS (SELECT 1 FROM public.sastanci_templates t WHERE t.id = s.template_id);
-- =====================================================================================
