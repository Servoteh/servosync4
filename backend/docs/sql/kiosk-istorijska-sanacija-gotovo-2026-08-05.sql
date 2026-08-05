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
-- IZMERENO NA PRODU 05.08.2026 (SELECT-only, kroz `docker exec servosync-pg psql`):
--
--   populacija (definicija iz KORAKA 1, svi filteri):
--     • od 01.07.2026 (era 3.0 kioska, PODRAZUMEVANO):
--         32 reda · 23 operacije · 19 RN · 18 radnika (najstariji 01.07., najnoviji 05.08.)
--     • od 01.01.2026:            274 reda · 149 operacija ·  93 RN · 39 radnika
--     • PUNA ISTORIJA (od 2016):  3.344 reda · 1.577 operacija · 1.311 RN · 74 radnika
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
--   START-ovao (red 119095, otvoren). Oba zatvorena reda SU u populaciji.
--
--   ⚠️ Brojevi iz naloga za rad („1.475 operacija / 781 RN", „1.039 / 420") NISU
--   reprodukovani ni jednom od isprobanih definicija (merenja 05.08. daju 4.647/3.398
--   na najširoj i 1.601/1.323 na „RN otvoren + nije kroz ZK" definiciji). Verovatno
--   je reč o drugoj definiciji kumulativa; ovde važe brojke izmerene gore.
--
-- ŠTA RADI: kandidatima postavlja `is_process_finished = false` i `finished_at =
-- NULL` (isti par kao `reopen()` u servisu) i vraća operaciju na listu prioriteta
-- (255 → 100) SAMO za radna mesta koja prioritet koriste (`operations.uses_priority`
-- — na produ 2 od 90 RC).
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
--   • operacije koje više NISU u rutingu tekućeg RN-a (BUG-P1-05 fantomski redovi):
--     njihovo otvaranje ne bi imalo gde da se nastavi;
--   • operacije u KOOPERACIJI ili ARHIVIRANE u planu proizvodnje;
--   • `work_orders.status` i `part_locations` — ništa se ne skida ni ne knjiži.
--
-- 🔴 UPOZORENJE — OVO MENJA ŠTA KORISNICI VIDE NA VIŠE EKRANA:
--   • Plan proizvodnje i Praćenje: operacije se vraćaju iz „završeno" u „u radu"
--     (`is_done_in_bigtehn`, `local_status`, usko grlo, „x/y operacija").
--   • „Gotovost RN" (036/26): `finished_operation_count` i „datum realizacije"
--     (`last_completed_at` = MAX(finished_at)) padaju — RN koji je izgledao gotov
--     više neće izgledati tako. To je i poenta, ali će ljudi primetiti.
--   • KIOSK „Moji otvoreni": svaki dirnut red se VRAĆA na listu radnika iz kolone
--     `tech_processes.worker_id`. Zato je podrazumevana granica 01.07.2026 (32
--     reda / 18 radnika). PUNA ISTORIJA bi jednom radniku (id 31) vratila 279
--     redova iz 2016–2024 i pretrpala kiosk — ako se ipak želi, to je odluka
--     Nenada, a ne podrazumevano ponašanje ovog skripta.
--   • Operacije se vraćaju na prioritetnu listu samo za 2 RC koja prioritet koriste.
--
-- ⚙️ JEDINO PODESIVO: `granica` (CTE u sva tri koraka). Podrazumevano
-- DATE '2026-07-01' (era 3.0 kioska). Za punu istoriju staviti DATE '1900-01-01'
-- u SVA TRI koraka — i tek posle ponovljenog KORAKA 1.
--
-- SIGURNOST:
--   • IDEMPOTENTNO — posle prolaza kandidati imaju `is_process_finished = false`,
--     pa ih WHERE (koji traži TRUE) više ne nalazi (drugi prolaz = 0 redova).
--   • Bez INSERT-a i bez DELETE-a → sekvence se ne diraju.
--   • Sve odluke se računaju iz baze u istoj transakciji; ništa nije ukucano
--     osim granice datuma.
--   • Povratak: `is_process_finished` se vraća na `true` za id-jeve iz KORAKA 1
--     (spisak sačuvati pre KORAKA 2), ali `finished_at` je posle toga NULL —
--     zato KORAK 1 ISPISUJE i `finished_at`, pa se snimi kao CSV.
--
-- UPUTSTVO: (1) pusti KORAK 1 i uporedi zbir sa brojkama gore, spisak sačuvaj;
-- (2) pusti KORAK 2 (jedna transakcija); (3) pusti KORAK 3 (provera, očekivano
-- 0 preostalih kandidata + prikaz koliko je dirnuto).
--
-- KO GA PUŠTA: nalog sa UPDATE na `tech_processes` i `work_order_operations`.
-- ============================================================================


-- ═════════════════════════════════════════════════════════════════════════════
-- KORAK 1 — PREGLED (ništa ne menja). Očekivano (granica 2026-07-01):
--   zbirni red: 32 reda / 23 operacije / 19 RN / 18 radnika
--   spisak: među njima 119002 i 119015 (RN 9400/6/74, op 20, RC 3.33, radnik 113).
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
         t.operation_number, t.work_center_code,
         k.cum AS operacija_kom, wo.id AS wo_id, wo.ident_number, wo.piece_count AS plan
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
)
SELECT 'ZBIR' AS vrsta, NULL::int AS tp_id, NULL::int AS wo_id, NULL::text AS rn,
       NULL::int AS op, NULL::text AS rc, NULL::int AS radnik,
       NULL::int AS red_kom, NULL::bigint AS operacija_kom, NULL::int AS plan,
       NULL::timestamp AS finished_at,
       COUNT(*)::text || ' redova · ' ||
       COUNT(DISTINCT (wo_id, operation_number, work_center_code))::text || ' operacija · ' ||
       COUNT(DISTINCT wo_id)::text || ' RN · ' ||
       COUNT(DISTINCT worker_id)::text || ' radnika' AS napomena
FROM kandidat
UNION ALL
SELECT 'RED', id, wo_id, ident_number, operation_number, work_center_code, worker_id,
       red_kom, operacija_kom, plan, finished_at::timestamp(0),
       'vraća se u rad (' || operacija_kom || '/' || plan || ' kom)'
FROM kandidat
ORDER BY vrsta, finished_at NULLS FIRST, tp_id;


-- ═════════════════════════════════════════════════════════════════════════════
-- KORAK 2 — UPIS. Jedna transakcija. Ista definicija kandidata kao u KORAKU 1
-- (kopija, ne referenca — skript se pušta i deo po deo).
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
-- (a) skini lažnu zastavicu + datum završetka (isti par kao reopen() u servisu)
otvoreno AS (
  UPDATE tech_processes t
     SET is_process_finished = false, finished_at = NULL
   WHERE t.id IN (SELECT id FROM kandidat)
  RETURNING t.work_order_id, t.operation_number, t.work_center_code, t.id
)
-- (b) vrati operaciju na prioritetnu listu (255 → 100) samo za RC koja prioritet
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
--   „preostali kandidati" = 0 (idempotentnost),
--   „vraćeno u rad danas" = broj dirnutih redova iz KORAKA 1 (32 za granicu 01.07.),
--   „i dalje zatvoreni ispod plana" = redovi koji su svesno ostavljeni
--     (opšti nalog, završna kontrola, RN kroz ZK, završen RN, van rutinga…).
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
-- Pre KORAKA 2 ovo je bilo 524 (mereno 05.08. za granicu 01.07.2026); posle
-- popravke mora pasti tačno za broj dirnutih redova (32 → očekivano 492).
-- Ostatak su svesno ostavljeni: opšti nalog, završna kontrola, RN kroz ZK,
-- završen RN, dorada/škart, operacije van rutinga.
SELECT '2. SVI zatvoreni redovi ispod plana od granice (bilo 524 pre popravke)',
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
-- Dokazni primer: oba reda MORAJU biti `f` (i finished_at NULL).
SELECT '3. dokazni primer RN 9400/6/74 — redovi 119002/119015 (očekivano f, f)',
       (SELECT string_agg(id || '=' || COALESCE(is_process_finished::text, 'null')
                          || '/' || COALESCE(finished_at::text, 'NULL'), ' · ' ORDER BY id)
          FROM tech_processes WHERE id IN (119002, 119015))
UNION ALL
-- Prioritet vraćen samo za RC koja ga koriste (na produ 2 od 90) — ostali ostaju 255.
SELECT '4. operacije na prioritetnoj listi (priority=100) na dirnutim RN-ovima',
       (SELECT COUNT(*)::text
          FROM work_order_operations l
          JOIN operations om ON om.work_center_code = l.work_center_code
         WHERE om.uses_priority IS TRUE AND l.priority = 100);
