-- ============================================================================
-- DATA-FIX: skidanje LAŽNE zastavice „operacija gotova" sa nedovršenih operacija
-- Datum: 2026-08-05 · Baza: GLAVNA (servosync-pg, app baza — NE sy15)
-- Grana: feat/kiosk-pitanje-gotovo
-- ============================================================================
--
-- ZAŠTO: kiosk dugme „Kraj rada" (POST tech-processes/:id/stop-work) je do
-- 05.08.2026. UVEK upisivalo `is_process_finished = true`, bez obzira na
-- količinu (FIX B, 15.07.). Radnici ga koriste kao „gotov sam za danas", pa je
-- operacija sa 21 od 200 komada u bazi stajala kao ZAVRŠENA — a
-- `bool_or(is_process_finished)` je kanon čitanja u celom modulu (plan
-- proizvodnje, praćenje, „Gotovost RN", usko grlo). Isto je radilo i dugme
-- „Odustani" (`:id/dismiss`), koje po sopstvenom docblock-u služi za redove
-- otvorene GREŠKOM kroz probu kucanja.
-- Kod je popravljen na ovoj grani (pitanje „Otkucao si X od Y. Da li je
-- operacija gotova?" sa podrazumevanim NE + serversko pravilo; „Odustani" više
-- nikad ne diže zastavicu). Ovaj skript čisti ZATEČENO stanje.
--
-- 🔴 SKRIPT SE NE PUŠTA PRE NEGO ŠTO KOD SA OVE GRANE ODE NA PROD — inače će
-- kiosk ponovo zatvoriti iste redove istog dana.
--
-- 🔴 KORAK 2 MENJA PODATKE. Pušta se TEK posle pregleda (KORAK 1), i to sam —
-- `psql -f <ceo fajl>` bi izvršio i njega. (Incident 05.08.: verifikator je
-- `sed`-om zahvatio sva tri bloka i nehotice upisao izmenu na produ; vraćena je
-- istog trena.)
--
-- ─────────────────────────────────────────────────────────────────────────────
-- IZMERENO NA PRODU 05.08.2026 u 10:51 (SELECT-only, `docker exec servosync-pg psql`)
--
-- ⚠️ POPULACIJA JE ŽIVA — pogon radi dok ovo čitaš. Isti upit je 05.08. u 09:12
-- vraćao 32 reda, u 10:51 — 31 (u međuvremenu je jedan RN prošao završnu
-- kontrolu, a pojavili su se novi zatvoreni redovi). Brojke ispod su SNIMAK, ne
-- konstanta: pusti KORAK 1 neposredno pre KORAKA 2 i radi sa njegovim ispisom.
--
--   granica 01.07.2026 (era 3.0 kioska — ODLUKA NENADA, podrazumevano):
--     • 31 red se OTVARA · 22 operacije · 18 RN
--     • 19 redova ZADRŽAVA vlasnika (vraćaju se u „Moji otvoreni"; najviše 2 po
--       radniku, 14 radnika)
--     • 12 redova se OTKUPLJUJE (`worker_id → 0`) — v. „ZAŠTO SE OTKUPLJUJE"
--     • 3 operacije već imaju otvoren red (neko je nastavio rad)
--
--   za poređenje (isti upit, druge granice — NISU podrazumevane):
--     • od 01.01.2026:            274 reda · 149 operacija ·  93 RN
--     • PUNA ISTORIJA (od 2016):  3.344 reda · 1.577 operacija · 1.311 RN · 74
--       radnika; jednom radniku (id 31) bi vratila 279 redova iz 2016–2024 i
--       pretrpala kiosk — zato NIJE izabrana.
--
--   levak (kako se od svih zatvorenih redova dolazi do populacije, PUNA ISTORIJA):
--     zatvoreni redovi čija je operacija ispod plana          19.567 redova / 3.398 RN
--     + RN nije završen (work_orders.status)                  18.525 redova / 2.918 RN
--     + RN nije prošao završnu kontrolu                       12.483 redova / 1.330 RN
--     + RC nije opšti nalog ni završna kontrola                3.423 reda  / 1.329 RN
--     + operacija još postoji u rutingu tekućeg RN-a           3.344 reda  / 1.311 RN
--     (kooperacija/arhiva iz plana proizvodnje ne izbacuju NIJEDAN red — mereno,
--      filter svejedno stoji u WHERE-u da ostane tačan i ubuduće)
--
--   dokazni primer (Nenadova prijava): RN 9400/6/74 (wo 45246, crtež 1119578,
--   plan 1 kom), operacija 20 / RC 3.33 — Jakov Neđić (radnik 113) je 03.08. i
--   04.08. dva puta kroz „Kraj rada" zatvorio operaciju sa 0 otkucanih komada
--   (redovi 119002 i 119015), a 05.08. je radnik 119 na istoj operaciji ponovo
--   START-ovao (red 119095, otvoren). Oba zatvorena reda SU u populaciji; pošto
--   operacija VEĆ ima otvoren red, oba se otkupljuju (ne vraćaju se ni na čiju listu).
--
--   ⚠️ Brojke iz naloga za rad („1.475 operacija / 781 RN", „1.039 / 420") NISU
--   reprodukovane nijednom isprobanom definicijom (najšira daje 4.647/3.398,
--   „RN otvoren + nije kroz ZK" 1.601/1.323). Važe brojke izmerene gore.
-- ─────────────────────────────────────────────────────────────────────────────
--
-- ŠTA RADI (u jednoj transakciji):
--   (a) SVIM kandidat-redovima: `is_process_finished = false`, `finished_at = NULL`
--       (isti par kao `reopen()` u servisu). Mora SVIM redovima operacije — kanon
--       čitanja je `bool_or(is_process_finished)`, pa bi jedan preostali `true`
--       ostavio operaciju „završenom" i posao bi bio uzaludan.
--   (b) OTKUP (`worker_id → 0`) svima OSIM jednog reda po operaciji.
--       🔴 ZAŠTO SE OTKUPLJUJE: „Moji otvoreni" lista REDOVE, ne operacije
--       (`tech_processes WHERE worker_id = ja AND NOT is_process_finished`). Bez
--       ovoga bi radnik 119 dobio ŠEST identičnih redova za istu operaciju
--       (RN 9033/7, op 10, RC 3.22, plan 1 — svih 6 zatvorio isti čovek istim
--       dugmetom). Otkupljen red OSTAJE otvoren i uračunat u kumulativ; samo se
--       ne prikazuje nikome u „Mojim otvorenim". `worker_id = 0` je postojeći
--       sentinel („Korisnik") koji `findOrOpenRoutingTp` već koristi za nove
--       redove; izvorni vlasnik ostaje u `audit_log` snapshotu (v. korak (0)).
--       Vlasnika zadržava NAJSTARIJI kandidat-red operacije — `findRoutingTp`
--       bira `ORDER BY is_process_finished ASC, id ASC`, pa je to baš red u koji
--       će sledeći sken knjižiti; radnik tako vidi red koji se stvarno koristi.
--       Ako operacija VEĆ ima otvoren red (neko je nastavio rad), otkupljuju se
--       SVI kandidati — operacija je već živa i vidi je onaj ko na njoj radi.
--   (c) prioritet 255 → 100 samo za radna mesta koja prioritet koriste
--       (`operations.uses_priority` — na produ 2 od 90 RC), isto kao `reopen()`.
--
-- ŠTA NE DIRA (svesno izostavljeno iz populacije):
--   • operacije čiji kumulativ JESTE dostigao plan (zastavica je tačna);
--   • RN koji je završen (`work_orders.status = true`) — zatvaranje je overeno;
--   • RN koji je prošao ZAVRŠNU KONTROLU (ima zatvoren red na RC sa
--     `significant_for_finishing`): kontrola po dizajnu KASKADNO zatvara sve
--     prethodne operacije (Nesa 10.07.) — deo je fizički prošao, zastavica je tačna;
--   • OPŠTI NALOG (`operations.without_process`): nema plan i po dizajnu je uvek
--     otvoren, a zatvoreni red mu je ISTORIJA (findOrOpenRoutingTp otvara nov);
--   • redove ZAVRŠNE KONTROLE (`significant_for_finishing`) — to je zapis o
--     kvalitetu, ne o radu;
--   • redove dorade/škarta (`quality_type_id <> 0`) — isto, zapis kontrole;
--   • operacije koje više NISU u rutingu tekućeg RN-a (BUG-P1-05 fantomski redovi);
--   • operacije u KOOPERACIJI ili ARHIVIRANE u planu proizvodnje;
--   • `piece_count` (nijedan komad se ne dodaje ni oduzima), `work_orders.status`,
--     `part_locations`, `work_time_entries`.
--
-- 🔴 UPOZORENJE — OVO MENJA ŠTA KORISNICI VIDE NA VIŠE EKRANA:
--   • Plan proizvodnje i Praćenje: operacije se vraćaju iz „završeno" u „u radu"
--     (`is_done_in_bigtehn`, `local_status`, usko grlo, „x/y operacija").
--   • „Gotovost RN" (036/26): `finished_operation_count` i „datum realizacije"
--     (`last_completed_at` = MAX(finished_at)) padaju — RN koji je izgledao gotov
--     više neće izgledati tako. To je i poenta, ali će ljudi primetiti.
--   • KIOSK „Moji otvoreni": 19 redova se vraća na liste 14 radnika (najviše 2 po
--     radniku). Ostalih 12 je otkupljeno i ne vidi ih niko.
--   • Operacije se vraćaju na prioritetnu listu samo za 2 RC koja prioritet koriste.
--
-- ⚙️ JEDINO PODESIVO: `granica` (CTE u sva tri koraka). Podrazumevano
-- DATE '2026-07-01' (era 3.0 kioska, odluka Nenada 05.08.). Menja se u SVA TRI
-- koraka istovremeno, i tek posle ponovljenog KORAKA 1.
--
-- SIGURNOST:
--   • IDEMPOTENTNO — posle prolaza kandidati imaju `is_process_finished = false`,
--     pa ih WHERE (koji traži TRUE) više ne nalazi (drugi prolaz = 0 redova).
--   • Bez INSERT-a u proizvodne tabele i bez DELETE-a → sekvence se ne diraju.
--   • KORAK 2 prvo upiše `audit_log` red sa spiskom svih dirnutih id-eva i njihovih
--     izvornih `worker_id`/`finished_at` — povratak je moguć i bez CSV-a.
--   • Sve odluke se računaju iz baze u istoj transakciji; ništa nije ukucano
--     osim granice datuma.
--
-- UPUTSTVO: (1) pusti KORAK 1 i uporedi zbir sa njegovim SOPSTVENIM ispisom (ne
-- sa brojkama iz headera — populacija je živa); (2) pusti KORAK 2 (jedna
-- transakcija); (3) pusti KORAK 3 (provera).
--
-- KO GA PUŠTA: nalog sa UPDATE na `tech_processes` i `work_order_operations` +
-- INSERT na `audit_log`.
-- ============================================================================


-- ═════════════════════════════════════════════════════════════════════════════
-- KORAK 1 — PREGLED (ništa ne menja).
-- Kolona `akcija` kaže šta se dešava sa svakim redom:
--   'OTVARA SE + ostaje vlasniku'                    → vraća se radniku na listu
--   'OTVARA SE + otkup (duplikat iste operacije)'    → operacija već ima red na listi
--   'OTVARA SE + otkup (operacija već ima otvoren red)' → neko je nastavio rad
-- Zbirni red na kraju daje ukupne brojeve.
-- ═════════════════════════════════════════════════════════════════════════════
WITH granica AS (SELECT DATE '2026-07-01' AS od),   -- ⚙️ jedina podesiva vrednost
kum AS (   -- kumulativ CELE operacije (svi redovi, svi kvaliteti) — ista metrika
           -- koju koriste assertPieceCountWithinPlan i FIX A u kodu
  SELECT project_id, ident_number, variant, operation_number, work_center_code,
         SUM(piece_count) AS cum
  FROM tech_processes
  GROUP BY 1, 2, 3, 4, 5
),
kandidat AS (
  SELECT t.id, t.worker_id, t.piece_count AS red_kom, t.finished_at,
         t.project_id, t.ident_number, t.variant,
         t.operation_number, t.work_center_code,
         k.cum AS operacija_kom, wo.id AS wo_id, wo.ident_number AS rn,
         wo.piece_count AS plan
  FROM tech_processes t
  CROSS JOIN granica g
  JOIN kum k ON k.project_id = t.project_id AND k.ident_number = t.ident_number
            AND k.variant = t.variant AND k.operation_number = t.operation_number
            AND k.work_center_code = t.work_center_code
  JOIN work_orders wo ON wo.project_id = t.project_id
                     AND wo.ident_number = t.ident_number
                     AND wo.variant = t.variant
  LEFT JOIN operations o ON o.work_center_code = t.work_center_code
  WHERE COALESCE(t.is_process_finished, false) IS TRUE
    AND t.finished_at >= g.od                        -- ⚙️ granica (v. header)
    AND t.quality_type_id = 0                        -- dorada/škart = zapis kontrole
    AND COALESCE(o.without_process, false) = false   -- opšti nalog: zatvoren red = istorija
    AND COALESCE(o.significant_for_finishing, false) = false  -- završna kontrola se ne dira
    AND wo.piece_count > 0
    AND k.cum < wo.piece_count                       -- 🔴 količina NIJE puna
    AND COALESCE(wo.status, false) = false           -- RN nije završen
    -- RN NIJE prošao završnu kontrolu (kaskadno zatvaranje prethodnih operacija je
    -- legitimno — isti oblik JOIN-a kao plan_rn_final_control_done u planu proizvodnje)
    AND NOT EXISTS (
      SELECT 1 FROM work_order_operations l3
      JOIN operations m3 ON m3.work_center_code = l3.work_center_code
      JOIN tech_processes t3
        ON t3.work_order_id = l3.work_order_id
       AND t3.operation_number = l3.operation_number
       AND NOT (NULLIF(BTRIM(t3.work_center_code), '') IS DISTINCT FROM NULLIF(BTRIM(l3.work_center_code), ''))
       AND COALESCE(t3.is_process_finished, false) IS TRUE
      WHERE l3.work_order_id = wo.id
        AND COALESCE(m3.significant_for_finishing, false) IS TRUE)
    -- operacija JOŠ postoji u rutingu tekućeg RN-a (BUG-P1-05: fantomski redovi)
    AND EXISTS (
      SELECT 1 FROM work_order_operations l4
      WHERE l4.work_order_id = wo.id
        AND l4.operation_number = t.operation_number
        AND NOT (NULLIF(BTRIM(l4.work_center_code), '') IS DISTINCT FROM NULLIF(BTRIM(t.work_center_code), '')))
    -- nije arhivirana ni u ručnoj kooperaciji (plan proizvodnje overlay)
    AND NOT EXISTS (
      SELECT 1 FROM work_order_operations l5
      JOIN plan_proizvodnje_overlays ov
        ON ov.work_order_id = l5.work_order_id AND ov.line_id = l5.id
      WHERE l5.work_order_id = wo.id
        AND l5.operation_number = t.operation_number
        AND NOT (NULLIF(BTRIM(l5.work_center_code), '') IS DISTINCT FROM NULLIF(BTRIM(t.work_center_code), ''))
        AND (ov.archived_at IS NOT NULL OR COALESCE(ov.cooperation_status, 'none') <> 'none'))
    -- nije u automatskoj kooperacionoj grupi (RJ grupa radnog mesta)
    AND NOT EXISTS (
      SELECT 1 FROM plan_proizvodnje_auto_cooperation_groups gg
      WHERE gg.rj_group_code = NULLIF(BTRIM(t.work_center_code), '')
        AND gg.removed_at IS NULL)
),
-- operacija koja VEĆ ima otvoren red (neko je nastavio rad) — tu se ne vraća niko
vec_otvorena AS (
  SELECT DISTINCT c.wo_id, c.operation_number, c.work_center_code
  FROM kandidat c
  WHERE EXISTS (
    SELECT 1 FROM tech_processes t2
     WHERE t2.project_id = c.project_id AND t2.ident_number = c.ident_number
       AND t2.variant = c.variant AND t2.operation_number = c.operation_number
       AND t2.work_center_code = c.work_center_code
       AND COALESCE(t2.is_process_finished, false) = false)
),
-- JEDAN red po operaciji zadržava vlasnika: najstariji (findRoutingTp bira MIN id)
vlasnik AS (
  SELECT DISTINCT ON (wo_id, operation_number, work_center_code) id
  FROM kandidat c
  WHERE NOT EXISTS (SELECT 1 FROM vec_otvorena v
                     WHERE v.wo_id = c.wo_id
                       AND v.operation_number = c.operation_number
                       AND v.work_center_code = c.work_center_code)
  ORDER BY wo_id, operation_number, work_center_code, id
)
SELECT 'ZBIR' AS vrsta, NULL::int AS tp_id, NULL::int AS wo_id, NULL::text AS rn,
       NULL::int AS op, NULL::text AS rc, NULL::int AS radnik,
       NULL::int AS red_kom, NULL::bigint AS operacija_kom, NULL::int AS plan,
       NULL::timestamp AS finished_at,
       COUNT(*)::text || ' redova se otvara · ' ||
       COUNT(DISTINCT (wo_id, operation_number, work_center_code))::text || ' operacija · ' ||
       COUNT(DISTINCT wo_id)::text || ' RN · ' ||
       (SELECT COUNT(*) FROM vlasnik)::text || ' ostaje vlasniku · ' ||
       (COUNT(*) - (SELECT COUNT(*) FROM vlasnik))::text || ' otkup' AS akcija
FROM kandidat
UNION ALL
SELECT 'RED', c.id, c.wo_id, c.rn, c.operation_number, c.work_center_code, c.worker_id,
       c.red_kom, c.operacija_kom, c.plan, c.finished_at::timestamp(0),
       CASE
         WHEN c.id IN (SELECT id FROM vlasnik) THEN 'OTVARA SE + ostaje vlasniku'
         WHEN EXISTS (SELECT 1 FROM vec_otvorena v
                       WHERE v.wo_id = c.wo_id AND v.operation_number = c.operation_number
                         AND v.work_center_code = c.work_center_code)
              THEN 'OTVARA SE + otkup (operacija već ima otvoren red)'
         ELSE 'OTVARA SE + otkup (duplikat iste operacije)'
       END
FROM kandidat c
ORDER BY vrsta, finished_at NULLS FIRST, tp_id;


-- ═════════════════════════════════════════════════════════════════════════════
-- KORAK 2 — UPIS. Jedna transakcija. Ista definicija kandidata kao u KORAKU 1
-- (kopija, ne referenca — skript se pušta blok po blok).
-- ═════════════════════════════════════════════════════════════════════════════
BEGIN;

WITH granica AS (SELECT DATE '2026-07-01' AS od),   -- ⚙️ ISTA vrednost kao u KORAKU 1
kum AS (
  SELECT project_id, ident_number, variant, operation_number, work_center_code,
         SUM(piece_count) AS cum
  FROM tech_processes
  GROUP BY 1, 2, 3, 4, 5
),
kandidat AS (
  SELECT t.id, t.worker_id, t.finished_at, t.project_id, t.ident_number, t.variant,
         t.operation_number, t.work_center_code, wo.id AS wo_id
  FROM tech_processes t
  CROSS JOIN granica g
  JOIN kum k ON k.project_id = t.project_id AND k.ident_number = t.ident_number
            AND k.variant = t.variant AND k.operation_number = t.operation_number
            AND k.work_center_code = t.work_center_code
  JOIN work_orders wo ON wo.project_id = t.project_id
                     AND wo.ident_number = t.ident_number
                     AND wo.variant = t.variant
  LEFT JOIN operations o ON o.work_center_code = t.work_center_code
  WHERE COALESCE(t.is_process_finished, false) IS TRUE
    AND t.finished_at >= g.od
    AND t.quality_type_id = 0
    AND COALESCE(o.without_process, false) = false
    AND COALESCE(o.significant_for_finishing, false) = false
    AND wo.piece_count > 0
    AND k.cum < wo.piece_count
    AND COALESCE(wo.status, false) = false
    AND NOT EXISTS (
      SELECT 1 FROM work_order_operations l3
      JOIN operations m3 ON m3.work_center_code = l3.work_center_code
      JOIN tech_processes t3
        ON t3.work_order_id = l3.work_order_id
       AND t3.operation_number = l3.operation_number
       AND NOT (NULLIF(BTRIM(t3.work_center_code), '') IS DISTINCT FROM NULLIF(BTRIM(l3.work_center_code), ''))
       AND COALESCE(t3.is_process_finished, false) IS TRUE
      WHERE l3.work_order_id = wo.id
        AND COALESCE(m3.significant_for_finishing, false) IS TRUE)
    AND EXISTS (
      SELECT 1 FROM work_order_operations l4
      WHERE l4.work_order_id = wo.id
        AND l4.operation_number = t.operation_number
        AND NOT (NULLIF(BTRIM(l4.work_center_code), '') IS DISTINCT FROM NULLIF(BTRIM(t.work_center_code), '')))
    AND NOT EXISTS (
      SELECT 1 FROM work_order_operations l5
      JOIN plan_proizvodnje_overlays ov
        ON ov.work_order_id = l5.work_order_id AND ov.line_id = l5.id
      WHERE l5.work_order_id = wo.id
        AND l5.operation_number = t.operation_number
        AND NOT (NULLIF(BTRIM(l5.work_center_code), '') IS DISTINCT FROM NULLIF(BTRIM(t.work_center_code), ''))
        AND (ov.archived_at IS NOT NULL OR COALESCE(ov.cooperation_status, 'none') <> 'none'))
    AND NOT EXISTS (
      SELECT 1 FROM plan_proizvodnje_auto_cooperation_groups gg
      WHERE gg.rj_group_code = NULLIF(BTRIM(t.work_center_code), '')
        AND gg.removed_at IS NULL)
),
vec_otvorena AS (
  SELECT DISTINCT c.wo_id, c.operation_number, c.work_center_code
  FROM kandidat c
  WHERE EXISTS (
    SELECT 1 FROM tech_processes t2
     WHERE t2.project_id = c.project_id AND t2.ident_number = c.ident_number
       AND t2.variant = c.variant AND t2.operation_number = c.operation_number
       AND t2.work_center_code = c.work_center_code
       AND COALESCE(t2.is_process_finished, false) = false)
),
vlasnik AS (
  SELECT DISTINCT ON (wo_id, operation_number, work_center_code) id
  FROM kandidat c
  WHERE NOT EXISTS (SELECT 1 FROM vec_otvorena v
                     WHERE v.wo_id = c.wo_id
                       AND v.operation_number = c.operation_number
                       AND v.work_center_code = c.work_center_code)
  ORDER BY wo_id, operation_number, work_center_code, id
),
-- (0) AUDIT PRE UPISA: ceo spisak + izvorne vrednosti (povratak bez CSV-a).
revizija AS (
  INSERT INTO audit_log (action, entity_type, entity_id, before_data, metadata, created_at)
  SELECT 'SANACIJA kiosk-gotovo 2026-08-05 (skidanje lažne zastavice)',
         'tech-processes',
         'batch',
         jsonb_build_object('redovi', (
           SELECT jsonb_agg(jsonb_build_object(
                    'id', c.id,
                    'worker_id', c.worker_id,
                    'finished_at', c.finished_at,
                    'otkup', (c.id NOT IN (SELECT id FROM vlasnik)))
                  ORDER BY c.id)
             FROM kandidat c)),
         jsonb_build_object('granica', (SELECT od FROM granica),
                            'ukupno', (SELECT COUNT(*) FROM kandidat),
                            'ostaje_vlasniku', (SELECT COUNT(*) FROM vlasnik)),
         now()
  RETURNING id
),
-- (a) skini lažnu zastavicu SVIM kandidatima (bool_or traži da nijedan ne ostane
--     true) i (b) otkupi sve osim jednog reda po operaciji
otvoreno AS (
  UPDATE tech_processes t
     SET is_process_finished = false,
         finished_at = NULL,
         worker_id = CASE WHEN t.id IN (SELECT id FROM vlasnik) THEN t.worker_id ELSE 0 END
   WHERE t.id IN (SELECT id FROM kandidat)
     AND (SELECT COUNT(*) FROM revizija) = 1   -- veže audit i upis u isti prolaz
  RETURNING t.work_order_id, t.operation_number, t.work_center_code, t.id
)
-- (c) vrati operaciju na prioritetnu listu (255 → 100) samo za RC koja prioritet
--     koriste — isto pravilo kao reopen(); ostali RC nisu ni na listi.
UPDATE work_order_operations l
   SET priority = 100
  FROM otvoreno ot
  JOIN operations om ON om.work_center_code = ot.work_center_code
 WHERE om.uses_priority IS TRUE
   AND l.work_order_id = ot.work_order_id
   AND l.operation_number = ot.operation_number
   AND NOT (NULLIF(BTRIM(l.work_center_code), '') IS DISTINCT FROM NULLIF(BTRIM(ot.work_center_code), ''))
   AND l.priority = 255;

COMMIT;


-- ═════════════════════════════════════════════════════════════════════════════
-- KORAK 3 — PROVERA. Očekivano:
--   1. preostali kandidati = 0 (idempotentnost),
--   2. zatvoreni redovi ispod plana od granice = pali za broj iz KORAKA 1,
--   3. nijedna operacija nema VIŠE od jednog otvorenog reda sa vlasnikom,
--   4. audit red postoji (povratak je moguć),
--   5. dokazni primer je otvoren.
-- ═════════════════════════════════════════════════════════════════════════════
WITH granica AS (SELECT DATE '2026-07-01' AS od),   -- ⚙️ ISTA vrednost kao gore
kum AS (
  SELECT project_id, ident_number, variant, operation_number, work_center_code,
         SUM(piece_count) AS cum
  FROM tech_processes
  GROUP BY 1, 2, 3, 4, 5
),
kandidat AS (
  SELECT t.id
  FROM tech_processes t
  CROSS JOIN granica g
  JOIN kum k ON k.project_id = t.project_id AND k.ident_number = t.ident_number
            AND k.variant = t.variant AND k.operation_number = t.operation_number
            AND k.work_center_code = t.work_center_code
  JOIN work_orders wo ON wo.project_id = t.project_id
                     AND wo.ident_number = t.ident_number
                     AND wo.variant = t.variant
  LEFT JOIN operations o ON o.work_center_code = t.work_center_code
  WHERE COALESCE(t.is_process_finished, false) IS TRUE
    AND t.finished_at >= g.od
    AND t.quality_type_id = 0
    AND COALESCE(o.without_process, false) = false
    AND COALESCE(o.significant_for_finishing, false) = false
    AND wo.piece_count > 0
    AND k.cum < wo.piece_count
    AND COALESCE(wo.status, false) = false
    AND NOT EXISTS (
      SELECT 1 FROM work_order_operations l3
      JOIN operations m3 ON m3.work_center_code = l3.work_center_code
      JOIN tech_processes t3
        ON t3.work_order_id = l3.work_order_id
       AND t3.operation_number = l3.operation_number
       AND NOT (NULLIF(BTRIM(t3.work_center_code), '') IS DISTINCT FROM NULLIF(BTRIM(l3.work_center_code), ''))
       AND COALESCE(t3.is_process_finished, false) IS TRUE
      WHERE l3.work_order_id = wo.id
        AND COALESCE(m3.significant_for_finishing, false) IS TRUE)
    AND EXISTS (
      SELECT 1 FROM work_order_operations l4
      WHERE l4.work_order_id = wo.id
        AND l4.operation_number = t.operation_number
        AND NOT (NULLIF(BTRIM(l4.work_center_code), '') IS DISTINCT FROM NULLIF(BTRIM(t.work_center_code), '')))
)
SELECT '1. preostali kandidati (MORA biti 0 — idempotentnost)' AS mera,
       COUNT(*)::text AS vrednost
FROM kandidat
UNION ALL
-- Pre KORAKA 2 ovo je bilo 524 (05.08. 09:12) / 519 (10:51); posle popravke mora
-- pasti za broj dirnutih redova. Ostatak su svesno ostavljeni (opšti nalog,
-- završna kontrola, RN kroz ZK, završen RN, dorada/škart, van rutinga).
SELECT '2. SVI zatvoreni redovi ispod plana od granice',
       (SELECT COUNT(*)::text
          FROM tech_processes t
          CROSS JOIN granica g
          JOIN kum k ON k.project_id = t.project_id AND k.ident_number = t.ident_number
                    AND k.variant = t.variant AND k.operation_number = t.operation_number
                    AND k.work_center_code = t.work_center_code
          JOIN work_orders wo ON wo.project_id = t.project_id
                             AND wo.ident_number = t.ident_number
                             AND wo.variant = t.variant
         WHERE COALESCE(t.is_process_finished, false) IS TRUE
           AND t.finished_at >= g.od
           AND wo.piece_count > 0 AND k.cum < wo.piece_count)
UNION ALL
-- 🔴 F2: sanacija ne sme da NAPRAVI operaciju sa više otvorenih redova istog
-- vlasnika („Moji otvoreni" bi prikazao duplikate).
-- ⚠️ ZATEČENO STANJE 05.08.2026 = 1 (RN 9000/95, varijanta 1, op 20, RC 3.12 —
-- radnik 130 ima DESET otvorenih redova iste operacije; nije posledica ovog
-- skripta, nastalo je ranije kroz FIX A). Posle KORAKA 2 broj MORA ostati 1.
SELECT '3. operacije sa >1 otvorenim redom koji ima vlasnika (MORA ostati 1)',
       (SELECT COUNT(*)::text FROM (
          SELECT 1 FROM tech_processes t
           WHERE COALESCE(t.is_process_finished, false) = false AND t.worker_id <> 0
           GROUP BY t.project_id, t.ident_number, t.variant,
                    t.operation_number, t.work_center_code
          HAVING COUNT(*) > 1) x)
UNION ALL
SELECT '4. audit red sanacije (povratak moguć)',
       (SELECT COALESCE(MAX(id)::text, 'NEMA')
          FROM audit_log
         WHERE action LIKE 'SANACIJA kiosk-gotovo 2026-08-05%')
UNION ALL
SELECT '5. dokazni primer RN 9400/6/74 — redovi 119002/119015 (očekivano f, f)',
       (SELECT string_agg(id || '=' || COALESCE(is_process_finished::text, 'null')
                          || '/' || COALESCE(finished_at::text, 'NULL'), ' · ' ORDER BY id)
          FROM tech_processes WHERE id IN (119002, 119015));
