-- ============================================================================
-- RUTIRANJE OBAVEŠTENJA O LANSIRANJU: predmet_planeri po Strahinjinoj listi
-- Zahtev 016/26 (četvrti krug), komentar 04.08.2026 08:09
-- Datum: 2026-08-04 · Baza: GLAVNA (servosync-pg, app baza — NE sy15)
-- Grana: fix/lansiranje-samo-primopredaja-016
-- ============================================================================
--
-- ✅ OVAJ FAJL JE ČIST SELECT — bezbedno ga pusti u celini (`psql -f`). Ništa ne menja.
--    Izvršni deo je u ZASEBNOM fajlu: predmet-planeri-016-2026-08-04-IZVRSNI.sql —
--    NE puštati ga dok se ne odgovori na PITANJA na dnu ovog fajla.
--
-- ZAHTEV (doslovno): „I proveriti opet ovo:
--     Ljubisa - 9811, 7701, Servotransfer prese
--     Dijana  - 9400/1, 9400/2, 9400/3, 9400/6, 9400/7
--     Branislav - 9000
--     Strahinja sve iznad navedeno."
--
-- ── IZMERENO STANJE NA PRODU 04.08.2026 ─────────────────────────────────────
-- `predmet_planeri` ima UKUPNO 4 reda:
--     id  project_id  broj    planer
--      9      9509     9033   Ljubiša Simović   (Servo transfer presa broj 9)
--     10      9510     9034   Ljubiša Simović   (Servo transfer presa broj 10)
--      3     10335     9881   Ljubiša Simović   (PO 49011040 — Robert Bosch)
--      7      NULL      —     Strahinja Petrović (GLOBALNI: svi predmeti)
-- Dakle: DIJANA I BRANISLAV NEMAJU NIJEDAN RED — do danas nisu mogli da dobiju
-- nijedno obaveštenje o lansiranju. To je jezgro Strahinjinog „proveriti opet ovo".
--
-- Korisnici (users): Ljubiša Simović 44, Dijana Kastratović 48,
--                    Branislav Stanojević 68, Strahinja Petrović 43 — svi aktivni.
--
-- ── MAPIRANJE „broj predmeta" → projects.id (izmereno) ──────────────────────
--   7701   → 9068   (RM Alkon Stahl; 744 RN u 2026 — živ)
--   9000   → 9470   (Perun - automatski punjač; 163 RN u 2026 — živ)
--   9400/1 → 10348    9400/2 → 10349    9400/3 → 10350
--   9400/6 → 10353    9400/7 → 10354
--   9811 = PORODICA, ne jedan predmet:
--     9811   → 10255 (Termička linija ST-TO-14; 12 RN u 2026)
--     9811-1 → 10301 (301 RN)   9811-2 → 10302 (124)   9811-3 → 10303 (148)
--     9811-4 → 10304 (0)        9811-5 → 10305 (162)   9811-6 → 10306 (2)
--   Zašto cela porodica: Strahinja je za Dijanu podstavke NABROJAO (9400/1…/7), a
--   za Ljubišu napisao samo „9811" — a lansiranja se dešavaju baš na podstavkama
--   (9811-2 i 9811-5 su nosili nacrte iz merenja). Sam predmet „9811" bez
--   podstavki dao bi Ljubiši skoro ništa.
--   9811-4 (0 RN) je uključen jer je deo iste porodice i posao tek dolazi.
--
-- ── ŠTA OVAJ SKRIPT RADI ────────────────────────────────────────────────────
--   DODAJE redove za: Ljubišu (9811 porodica + 7701), Dijanu (5× 9400/x),
--   Branislava (9000), i Strahinju (UNIJA svega gore — vidi KORAK 2c).
--   BRIŠE: Ljubišin red za 9881 (id 3) — predmet je GOTOVO/zatvoren 24.02.2026,
--          ima 0 RN, i Strahinja ga je u novoj listi zamenio sa „9811"
--          (u prvobitnom zahtevu 24.07. je pisalo „9881", sad piše „9811").
--   NE DIRA: Ljubišine redove 9033/9034 — to JESU „Servotransfer prese"
--          (vidi PITANJE 1); brisanje bi bilo tiha regresija.
--
-- ── SIGURNOST ───────────────────────────────────────────────────────────────
--   • IDEMPOTENTNO: INSERT … ON CONFLICT DO NOTHING nad UNIQUE
--     `uq_predmet_planeri_project_user` (project_id, planner_user_id).
--     Drugo pokretanje upiše 0 redova.
--   • Predmeti se NE kucaju po id-u nego se traže po `project_number` — ako se
--     broj ne poklopi, red se prosto ne kreira (nema tihog pogađanja pogrešnog
--     predmeta). KORAK 1 pokazuje tačno šta će biti kreirano.
--   • Sve u jednoj transakciji.
--   • `created_by_user_id` = 2 (sistemski/admin nalog koji pušta skript) — kolona
--     je nullable, promeni ili ostavi NULL ako želiš.
--
-- UPUTSTVO: pusti ovaj fajl, uporedi izlaz sa listom, odgovori na PITANJA (dno),
-- pa tek onda …-IZVRSNI.sql (KORAK 2 + 3).
-- ============================================================================


-- ════════════════════════════════════════════════════════════════════════════
-- KORAK 1 — PREGLED (čist SELECT, ništa ne menja)
-- ════════════════════════════════════════════════════════════════════════════

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

\echo '--- 1a. TRENUTNO stanje predmet_planeri ---'
SELECT pp.id, pp.project_id, p.project_number, u.full_name AS planer
FROM predmet_planeri pp
LEFT JOIN projects p ON p.id = pp.project_id
LEFT JOIN users u ON u.id = pp.planner_user_id
ORDER BY u.full_name, p.project_number NULLS FIRST;

\echo '--- 1b. ŠTA ĆE BITI DODATO (planeri predmeta) ---'
SELECT z.full_name AS planer, z.broj, z.project_id
FROM zeljeno z
WHERE NOT EXISTS (
  SELECT 1 FROM predmet_planeri pp
  WHERE pp.project_id = z.project_id AND pp.planner_user_id = z.planner_user_id)
ORDER BY z.full_name, z.broj;

\echo '--- 1c. ŠTA ĆE BITI DODATO ZA STRAHINJU (unija svega gore) ---'
SELECT DISTINCT p.project_number, z.project_id
FROM zeljeno z JOIN projects p ON p.id = z.project_id
WHERE NOT EXISTS (
  SELECT 1 FROM predmet_planeri pp
  WHERE pp.project_id = z.project_id
    AND pp.planner_user_id = (SELECT id FROM users WHERE lower(email)='strahinja.petrovic@servoteh.com'))
ORDER BY p.project_number;

\echo '--- 1d. PROVERA: da li se neki broj predmeta NIJE našao (mora biti prazno) ---'
WITH mapa(broj) AS (
  VALUES ('9811'),('9811-1'),('9811-2'),('9811-3'),('9811-4'),('9811-5'),('9811-6'),
         ('7701'),('9400/1'),('9400/2'),('9400/3'),('9400/6'),('9400/7'),('9000')
)
SELECT m.broj AS nema_takvog_predmeta FROM mapa m
WHERE NOT EXISTS (SELECT 1 FROM projects p WHERE p.project_number = m.broj);

\echo '--- 1e. ŠTA ĆE BITI OBRISANO (Ljubišin 9881 — zatvoren predmet) ---'
SELECT pp.id, p.project_number, p.status, p.closed_at, u.full_name
FROM predmet_planeri pp
JOIN projects p ON p.id = pp.project_id
JOIN users u ON u.id = pp.planner_user_id
WHERE p.project_number = '9881' AND lower(u.email) = 'ljubisa.simovic@servoteh.com';


-- ════════════════════════════════════════════════════════════════════════════

-- ============================================================================
-- OTVORENA PITANJA ZA STRAHINJU (zato ovaj skript NIJE izvršen)
-- ============================================================================
--
-- PITANJE 1 — „Servotransfer prese": koji su to tačno predmeti?
--   Nije broj predmeta, a u bazi postoji SEDAM kandidata (svi „U TOKU",
--   komitent Servoteh d.o.o.) — numeracija im se čak i preklapa (dva „broj 7"):
--     6900  „5. Servo Transfer presa"        (205 RN, poslednji 07/2024)
--     7380  „6. Servo Transfer presa"        (894 RN, poslednji 12/2025)
--     7498  „7. Servo Transfer presa"        (0 RN)
--     8034  „Servotransfer presa broj 7"     (300 RN, 11 u 2026, 2 nacrta)
--     8035  „Servotransfer presa broj 8"     (209 RN, 1 u 2026)
--     9033  „Servo transfer presa broj 9"    (199 RN, 3 u 2026)  ← Ljubiša VEĆ ima
--     9034  „Servo transfer presa broj 10"   (199 RN, 2 u 2026)  ← Ljubiša VEĆ ima
--   Ovaj skript NE dira nijedan od njih (9033/9034 ostaju). Kad Strahinja kaže
--   koji ulaze, dodaju se u `mapa` gore po istom obrascu.
--
-- PITANJE 2 — 9400: zašto baš /1, /2, /3, /6, /7?
--   U bazi postoje i:
--     9400   (id 9833)  — NADREĐENI predmet, 789 RN u 2026 i 55 nacrta (NAJŽIVLJI
--                         od svih 9400!) — a nije na listi;
--     9400/4 (10351) i 9400/5 (10352) — 0 RN (verovatno zato izostavljeni);
--     9400/8 (10355) — 5 RN u 2026, nije na listi.
--   Ako lansiranja idu i na sam „9400", Dijana ih po ovoj listi NEĆE dobijati.
--   Skript poštuje listu doslovno; dodavanje 9400 i/ili 9400/8 je jedan red u `mapa`.
--
-- PITANJE 3 — Strahinja: globalno ili samo nabrojano? (KORAK 2c)
--   Danas je globalni planer (svi predmeti u firmi). „Sve iznad navedeno" bi ga
--   suzilo na 14 nabrojanih predmeta. Prvobitni zahtev (24.07) je tražio suprotno:
--   „Svi radni nalozi koji se lansiraju u proizvodnju - Strahinja Petrovic".
--   Do potvrde ostaje globalan (DELETE je zakomentarisan) — 2b mu svejedno
--   eksplicitno upisuje nabrojane predmete, pa je ishod isti u oba čitanja.
--
-- PITANJE 4 — 9881 → 9811: potvrda da je u pitanju ISPRAVKA, ne dodatak.
--   24.07. je pisalo „RN7701, 9881, Servotransfer prese"; 04.08. piše
--   „9811, 7701, Servotransfer prese". 9881 je zatvoren (GOTOVO 24.02.2026, 0 RN),
--   pa je skript tretira kao ispravku i briše je (KORAK 2d). Ako je bio dodatak,
--   obrisati KORAK 2d.
-- ============================================================================
