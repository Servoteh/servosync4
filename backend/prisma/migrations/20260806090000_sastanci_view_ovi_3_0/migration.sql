-- Seoba sy15 -> 3.0, KORAK 1b: VIEW-ovi domena sastanaka.
-- Runbook: docs/SEOBA_SASTANCI_PB_2026-08-05.md (§ „Prepis preostale logike").
--
-- ZAŠTO RUČNO PISANA MIGRACIJA: `prisma migrate diff` ne vidi view-ove (Prisma ih
-- ne modeluje). Isti obrazac kao ostali SQL-only objekti u ovoj šemi (parcijalni
-- unique nad `projects.project_number`, trigram GIN nad `projects.description`).
--
-- Definicije su PREPISANE DOSLOVNO sa žive sy15 (`pg_view_definition`, 06.08.2026),
-- uz JEDINU izmenu koju traži seoba: `projekat_id` je u 3.0 `INTEGER` (FK na
-- `projects.id`) umesto sy15 `uuid` — ali kolona se u view-u samo PROSLEĐUJE, pa
-- se telo ne menja. Tip prati baznu tabelu.
--
-- ⚠️ Oba view-a su u sy15 `security_invoker` (RLS pozivaoca). U 3.0 nema RLS-a
-- (ODLUKE.md — guardovi + query-scoping), pa vidljivost reda sprovodi
-- `SastanciRlsService` u aplikaciji. Konkretno: `v_pm_teme_pregled` u sy15 NIJE
-- javan (politika `pmt_select` = predlagač ∨ mgmt ∨ učesnik ∨ draft+edit) — taj
-- filter je prenet u `SastanciRlsService.scopeTemeWhere()`.

-- v_akcioni_plan: akcioni plan + IZVEDENI `effective_status` (rok u prošlosti pomera
-- otvoren/u_toku u 'kasni') i `dana_do_roka`. Čita ga cela lista akcija, pretraga,
-- weekly-diff i `sast_dashboard_stats`.
CREATE OR REPLACE VIEW "v_akcioni_plan" AS
SELECT id,
    sastanak_id,
    tema_id,
    projekat_id,
    rb,
    naslov,
    opis,
    odgovoran_email,
    odgovoran_label,
    odgovoran_text,
    rok,
    rok_text,
    status,
    prioritet,
    zatvoren_at,
    zatvoren_by_email,
    zatvoren_napomena,
    created_at,
    created_by_email,
    updated_at,
    CASE
        WHEN (status = ANY (ARRAY['zavrsen'::text, 'odlozen'::text, 'otkazan'::text])) THEN status
        WHEN ((rok IS NOT NULL) AND (rok < CURRENT_DATE) AND (status = ANY (ARRAY['otvoren'::text, 'u_toku'::text]))) THEN 'kasni'::text
        ELSE status
    END AS effective_status,
    CASE
        WHEN (rok IS NULL) THEN NULL::integer
        ELSE (rok - CURRENT_DATE)
    END AS dana_do_roka
FROM akcioni_plan ap;

-- v_pm_teme_pregled: teme + izvedeni `visual_tag` (hitno/za razmatranje → boja reda).
CREATE OR REPLACE VIEW "v_pm_teme_pregled" AS
SELECT id,
    vrsta,
    oblast,
    naslov,
    opis,
    projekat_id,
    status,
    prioritet,
    sastanak_id,
    predlozio_email,
    predlozio_label,
    predlozio_at,
    resio_email,
    resio_label,
    resio_at,
    resio_napomena,
    created_at,
    updated_at,
    hitno,
    za_razmatranje,
    admin_rang,
    admin_rang_by_email,
    admin_rang_at,
    CASE
        WHEN (za_razmatranje AND hitno) THEN 'hitno_razmatra'::text
        WHEN za_razmatranje THEN 'razmatra'::text
        WHEN hitno THEN 'hitno'::text
        ELSE 'normalno'::text
    END AS visual_tag
FROM pm_teme t;
