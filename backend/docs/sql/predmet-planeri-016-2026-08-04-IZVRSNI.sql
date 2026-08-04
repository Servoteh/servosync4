-- ============================================================================
-- IZVRŠNI DEO — predmet_planeri po Strahinjinoj listi (zahtev 016/26)
-- Datum: 2026-08-04 · Baza: GLAVNA (servosync-pg, app baza — NE sy15)
-- Grana: fix/lansiranje-samo-primopredaja-016
-- ============================================================================
--
-- ⛔ OVAJ FAJL MENJA PODATKE (INSERT + DELETE). NE PUŠTATI dok:
--      1. nije pušten `predmet-planeri-016-2026-08-04-PREVIEW.sql` i izlaz
--         upoređen sa Strahinjinom listom, I
--      2. nisu odgovorena 4 PITANJA sa dna PREVIEW fajla (Servotransfer prese,
--         9400 nadređeni/9400-8, Strahinja globalno?, 9881→9811).
--
-- Obrazloženje, merenja i mapiranje brojeva predmeta u projects.id su u PREVIEW
-- fajlu — ovde se ne ponavljaju.
--
-- SIGURNOST: idempotentno (ON CONFLICT DO NOTHING nad
-- uq_predmet_planeri_project_user); predmeti se traže po `project_number`, ne po
-- ukucanom id-u; sve u jednoj transakciji.
-- ============================================================================

-- Ciljano mapiranje planer → predmeti, izvedeno iz brojeva predmeta.
CREATE TEMP VIEW zeljeno AS
WITH mapa(planer_email, broj) AS (
  VALUES
    -- Ljubiša Simović
    ('ljubisa.simovic@servoteh.com', '9811'),
    ('ljubisa.simovic@servoteh.com', '9811-1'),
    ('ljubisa.simovic@servoteh.com', '9811-2'),
    ('ljubisa.simovic@servoteh.com', '9811-3'),
    ('ljubisa.simovic@servoteh.com', '9811-4'),
    ('ljubisa.simovic@servoteh.com', '9811-5'),
    ('ljubisa.simovic@servoteh.com', '9811-6'),
    ('ljubisa.simovic@servoteh.com', '7701'),
    -- Dijana Kastratović
    ('dijana.kastratovic@servoteh.com', '9400/1'),
    ('dijana.kastratovic@servoteh.com', '9400/2'),
    ('dijana.kastratovic@servoteh.com', '9400/3'),
    ('dijana.kastratovic@servoteh.com', '9400/6'),
    ('dijana.kastratovic@servoteh.com', '9400/7'),
    -- Branislav Stanojević
    ('branislav.stanojevic@servoteh.com', '9000')
)
SELECT u.id AS planner_user_id, u.full_name, p.id AS project_id, m.broj
FROM mapa m
JOIN users u ON lower(u.email) = m.planer_email AND u.active
JOIN projects p ON p.project_number = m.broj;

-- KORAK 2 — IZMENA (transakcija)
-- ════════════════════════════════════════════════════════════════════════════
BEGIN;

-- 2a) Planeri predmeta (Ljubiša, Dijana, Branislav)
INSERT INTO predmet_planeri (project_id, planner_user_id, created_by_user_id)
SELECT z.project_id, z.planner_user_id, 2
FROM zeljeno z
ON CONFLICT (project_id, planner_user_id) DO NOTHING;

-- 2b) „Strahinja sve iznad navedeno" — unija svih predmeta iz liste.
INSERT INTO predmet_planeri (project_id, planner_user_id, created_by_user_id)
SELECT DISTINCT z.project_id,
       (SELECT id FROM users WHERE lower(email)='strahinja.petrovic@servoteh.com'),
       2
FROM zeljeno z
ON CONFLICT (project_id, planner_user_id) DO NOTHING;

-- 2c) ⚠️ ODLUKA (vidi PITANJE 3): Strahinjin GLOBALNI red (project_id IS NULL)
--     danas mu daje obaveštenja za SVE predmete u firmi. „Sve iznad navedeno"
--     doslovno znači SAMO nabrojane — što je SUŽAVANJE. Red se briše SAMO ako
--     je to potvrđeno; do tada je ovaj DELETE ZAKOMENTARISAN i Strahinja
--     zadržava globalno pokrivanje (2b mu ionako ništa ne oduzima).
-- DELETE FROM predmet_planeri
-- WHERE project_id IS NULL
--   AND planner_user_id = (SELECT id FROM users WHERE lower(email)='strahinja.petrovic@servoteh.com');

-- 2d) Ljubišin 9881 — predmet zatvoren (GOTOVO, 24.02.2026), 0 RN; u novoj listi
--     ga je zamenio „9811". Brisanje je bezbedno: red samo rutira obaveštenja.
DELETE FROM predmet_planeri pp
USING projects p, users u
WHERE pp.project_id = p.id
  AND pp.planner_user_id = u.id
  AND p.project_number = '9881'
  AND lower(u.email) = 'ljubisa.simovic@servoteh.com';

COMMIT;


-- ════════════════════════════════════════════════════════════════════════════
-- KORAK 3 — VERIFIKACIJA
-- ════════════════════════════════════════════════════════════════════════════

\echo '--- 3a. Konačno stanje po planeru ---'
SELECT u.full_name AS planer,
       count(*) FILTER (WHERE pp.project_id IS NOT NULL) AS predmeta,
       bool_or(pp.project_id IS NULL) AS globalni,
       string_agg(p.project_number, ', ' ORDER BY p.project_number) AS spisak
FROM predmet_planeri pp
JOIN users u ON u.id = pp.planner_user_id
LEFT JOIN projects p ON p.id = pp.project_id
GROUP BY u.full_name ORDER BY u.full_name;

\echo '--- 3b. Očekivano (mora biti 0 redova = sve traženo postoji) ---'
SELECT z.full_name, z.broj FROM zeljeno z
WHERE NOT EXISTS (
  SELECT 1 FROM predmet_planeri pp
  WHERE pp.project_id = z.project_id AND pp.planner_user_id = z.planner_user_id);

\echo '--- 3c. Strahinja pokriva sve iz liste (mora biti 0 redova) ---'
SELECT DISTINCT p.project_number FROM zeljeno z JOIN projects p ON p.id = z.project_id
WHERE NOT EXISTS (
  SELECT 1 FROM predmet_planeri pp
  WHERE pp.planner_user_id = (SELECT id FROM users WHERE lower(email)='strahinja.petrovic@servoteh.com')
    AND (pp.project_id = z.project_id OR pp.project_id IS NULL));


