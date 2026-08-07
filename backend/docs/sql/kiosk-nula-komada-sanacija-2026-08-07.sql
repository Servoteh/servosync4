-- ============================================================================
-- DATA-FIX: vraćanje u otvoreno operacija zatvorenih BEZ IJEDNOG KOMADA
-- Datum: 2026-08-07 · Baza: GLAVNA (servosync-pg, app baza — NE sy15)
-- Grana: fix/kiosk-nula-komada
-- ============================================================================
--
-- ZAŠTO: od 05.08.2026. (zahtev 064/26) kiosk pita „Otkucao si X od Y. Da li je
-- operacija gotova?" kad kumulativ ne dostiže plan. Pitanje je iskakalo i kad je
-- otkucano NULA komada („Otkucao si 0 od 1 kom." — slika sa pogona), pa je
-- radnik dobijao dugme „Da — gotova je" za operaciju na kojoj ništa nije
-- napravljeno. Dugme pri tom ne radi ono što radnik misli: od zahteva 069/26
-- plan računa gotovost po DOBRIM komadima, pa operacija sa nula komada NIKAD ne
-- dobije kvačicu u planu — jedini stvarni efekat je da NESTANE sa liste
-- otvorenih (lista filtrira po sirovoj zastavici `is_process_finished`).
--
-- Kod je popravljen na ovoj grani (odluka Nenad 07.08.2026):
--   • kiosk u nula-slučaju uopšte ne nudi „Da — gotova je";
--   • server odbija `operacijaGotova = true` kad je kumulativ operacije ≤ 0 (422).
-- Ovaj skript čisti ZATEČENO stanje — samo od 05.08. naovamo (era pitanja).
--
-- 🔴 SKRIPT SE NE PUŠTA PRE NEGO ŠTO KOD SA OVE GRANE ODE NA PROD — inače će
-- kiosk istog dana ponovo zatvoriti iste redove.
--
-- 🔴 KORAK 2 MENJA PODATKE. Pušta se TEK posle pregleda (KORAK 1), i to sam —
-- `psql -f <ceo fajl>` bi izvršio i njega. (Incident 05.08.: verifikator je
-- `sed`-om zahvatio sva tri bloka i nehotice upisao izmenu na produ.)
--
-- ─────────────────────────────────────────────────────────────────────────────
-- IZMERENO NA PRODU 07.08.2026 (SELECT-only, `docker exec servosync-pg psql`)
--
-- 🕐 ZONA — pročitaj pre nego što uporediš bilo koje vreme odavde sa smenom:
-- `tech_processes.finished_at` i `entered_at` su `timestamp WITHOUT time zone`, a
-- aplikacija u njih piše UTC. Zato `SET TIME ZONE 'Europe/Belgrade'` NE pomera te
-- kolone — psql ih ispisuje sirovo, dva sata unazad. Konverzija je izričita:
--     finished_at AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Belgrade'
-- Sva vremena u OVOM zaglavlju su već prevedena u BEOGRADSKO. Kad pustiš KORAK 1,
-- njegov ispis je SIROV (UTC) — dodaj 2 sata pre nego što kažeš „kraj smene".
--
-- ⚠️ POPULACIJA JE ŽIVA — pogon radi dok ovo čitaš, i to se već videlo:
-- u 09:00 je kandidata bilo TRI, a u 10:00 DVA, jer je RN 9400/2/486 (op 35,
-- RC 8.2) u međuvremenu prošao ZAVRŠNU KONTROLU (op 70 / RC 8.3, 07.08. u 07:35)
-- pa je ispao iz populacije po pravilu „kroz ZK = zastavica je tačna".
-- Brojke ispod su SNIMAK, ne konstanta: pusti KORAK 1 neposredno pre KORAKA 2 i
-- radi sa NJEGOVIM ispisom.
--
--   granica 05.08.2026 (dan uvođenja pitanja o gotovosti — ODLUKA NENADA):
--     • 2 operacije · 2 reda · 2 RN — sve tri stavke ispod se otvaraju:
--         tp 119234 · RN 9400/2/340 · op 40 · RC 3.16 · plan 1 · zatvoreno 06.08 15:59 BGD (13:59 UTC)
--         tp 119224 · RN 9400/3/300 · op 20 · RC 3.40 · plan 4 · zatvoreno 06.08 15:59 BGD (13:59 UTC)
--       Oba u istom minutu na KRAJU SMENE — to je „čišćenje liste na izlasku",
--       a ne stvarno završena operacija; zato se i vraćaju u otvoreno.
--     • 0 redova se otkupljuje (svaka operacija ima tačno JEDAN red)
--
--   levak (kako se od svih „nula" zatvaranja stiže do populacije):
--     mrtve operacije sa kumulativom 0 (svi redovi zatvoreni)  2.524 (PUNA ISTORIJA)
--     + poslednje zatvaranje od 05.08.2026                         3
--     + RC nije opšti nalog ni završna kontrola                    3
--     + RN nije završen i nije prošao ZK                           2  ← populacija
--
--   šta je izmereno a NIJE u populaciji (i zašto):
--     • 16 redova ima `piece_count = 0` od 05.08., ali samo 5 pripada operaciji
--       čiji je KUMULATIV nula, a od tih 5 su 2 (tp 118545 i 118618, RN 9033/7
--       op 10 RC 3.22) na operaciji koja JOŠ ima otvorene redove — nije mrtva.
--       Ostalih 11 su legitimna zatvaranja ispod plana (kumulativ operacije 1, 1,
--       2, 4, 6, 12, 18, 18, 23, 45, 385) — FIX A razbija kucanja na više redova,
--       pa `piece_count` JEDNOG reda NIJE merodavan. Brana na redu umesto na
--       operaciji bespotrebno bi oborila baš tih 11;
--     • RN 9400/2/486 (tp 119200) — prošao ZAVRŠNU KONTROLU 07.08. u 07:35 (op 70,
--       RC 8.3, 1 kom) i RN je označen kao završen; po odluci Nese (10.07.) deo
--       koji je prošao ZK fizički je prošao i prethodne operacije → zastavica
--       je TAČNA. Do 07.08. ujutru je bio treći kandidat;
--     • 3.969 zatvorenih redova RC 0.0 (OPŠTI NALOG) sa nula komada — to je
--       NORMALAN put čišćenja reda, ne kvar;
--     • 2.521 mrtva „nula" operacija zatvorena PRE 05.08. — svesno se ne dira
--       (deo se objašnjava kaskadom završne kontrole).
--
--   ⚙️ storno danas ne pravi lažnog kandidata: grupa sa `SUM = 0` ali
--   `MAX(ABS) > 0` (npr. +3 pa −3) ima NULA pojava, kao i grupa sa negativnim
--   kumulativom (0 od 69.273). Uslov `max_abs = 0` svejedno stoji da ostane
--   tačan i ubuduće.
-- ─────────────────────────────────────────────────────────────────────────────
--
-- ŠTA RADI (u jednoj transakciji):
--   (0) AUDIT PRE UPISA: `audit_log` red sa spiskom svih dirnutih id-eva i
--       njihovim izvornim `worker_id`/`finished_at` — povratak bez CSV-a.
--   (a) SVIM redovima kandidat-operacije: `is_process_finished = false`,
--       `finished_at = NULL` (isti par kao `reopen()` u servisu). Mora SVIM
--       redovima — kanon čitanja je `bool_or(is_process_finished)`, pa bi jedan
--       preostali `true` ostavio operaciju „završenom".
--   (b) OTKUP (`worker_id → 0`) svima OSIM najstarijeg reda po operaciji.
--       „Moji otvoreni" lista REDOVE, ne operacije, pa bi radnik inače dobio
--       više identičnih redova iste operacije. Danas je ovo prazan skup (svaka
--       kandidat-operacija ima jedan red), ali pravilo stoji za ubuduće.
--       Vlasnika zadržava NAJSTARIJI red — `findRoutingTp` bira
--       `ORDER BY is_process_finished ASC, id ASC`, pa je to baš red u koji će
--       sledeći sken knjižiti.
--   (c) prioritet 255 → 100 samo za radna mesta koja prioritet koriste
--       (`operations.uses_priority` — na produ 2 od 90 RC; nijedan od današnja
--       dva kandidata nije takav, pa je i ovaj korak danas prazan).
--
-- ŠTA NE DIRA (svesno izostavljeno iz populacije):
--   • operacije sa BILO KOJIM otkucanim komadom (kumulativ ≠ 0) — za njih je
--     pitanje o gotovosti legitimno i odgovor „Da" je radnikova odluka;
--   • operacije čiji kumulativ jeste 0 ali JEDAN red nosi + a drugi − komada
--     (storno netiranje) — tamo su komadi fizički pravljeni pa stornirani; to
--     traži čoveka, ne batch. Zato uslov nije samo `SUM = 0` nego i `MAX(ABS) = 0`;
--   • operacije koje JOŠ imaju otvoren red (nisu mrtve — neko na njima radi);
--   • zatvaranja PRE 05.08.2026 (2.499 komada istorije — odluka Nenada);
--   • OPŠTI NALOG (`operations.without_process`): nema plan, po dizajnu je uvek
--     otvoren, a zatvoren red mu je ISTORIJA (`findOrOpenRoutingTp` otvara nov);
--   • redove ZAVRŠNE KONTROLE (`significant_for_finishing`) — zapis o kvalitetu;
--   • RN koji je završen (`work_orders.status`) ili je prošao ZAVRŠNU KONTROLU;
--   • operacije koje više NISU u rutingu tekućeg RN-a (BUG-P1-05 fantomski redovi);
--   • operacije u KOOPERACIJI ili ARHIVIRANE u planu proizvodnje;
--   • `piece_count` (nijedan komad se ne dodaje ni oduzima), `work_orders.status`,
--     `part_locations`, `work_time_entries` (vreme rada radnika OSTAJE upisano).
--
-- 🔴 ŠTA ĆE KORISNICI PRIMETITI:
--   • Plan proizvodnje i Praćenje: te operacije se vraćaju iz „završeno" u „u radu";
--   • „Gotovost RN" (036/26): broj završenih operacija i „datum realizacije" padaju;
--   • KIOSK „Moji otvoreni": redovi se vraćaju na listu svojih radnika
--     (danas: 2 reda, 2 različita radnika — po jedan svakom).
--
-- ⚙️ JEDINO PODESIVO: `granica` (CTE u sva tri koraka). Podrazumevano
-- DATE '2026-08-05' (dan uvođenja pitanja o gotovosti). Menja se u SVA TRI
-- koraka istovremeno, i tek posle ponovljenog KORAKA 1.
--
-- SIGURNOST:
--   • IDEMPOTENTNO — posle prolaza kandidati imaju `is_process_finished = false`,
--     pa ih WHERE (koji traži da su SVI redovi zatvoreni) više ne nalazi.
--   • Bez INSERT-a u proizvodne tabele i bez DELETE-a → sekvence se ne diraju.
--   • Sve odluke se računaju iz baze u istoj transakciji; ništa nije ukucano
--     osim granice datuma (nijedan `tp.id` nije zapisan u WHERE).
--
-- UPUTSTVO: (1) pusti KORAK 1 i radi sa NJEGOVIM ispisom; (2) pusti KORAK 2
-- (jedna transakcija); (3) pusti KORAK 3 (provera).
--
-- KO GA PUŠTA: nalog sa UPDATE na `tech_processes` i `work_order_operations` +
-- INSERT na `audit_log`.
-- ============================================================================


-- ═════════════════════════════════════════════════════════════════════════════
-- KORAK 1 — PREGLED (ništa ne menja).
-- Kolona `akcija` kaže šta se dešava sa svakim redom:
--   'OTVARA SE + ostaje vlasniku'                 → vraća se radniku na listu
--   'OTVARA SE + otkup (duplikat iste operacije)' → red bi bio duplikat na listi
-- Zbirni red na kraju daje ukupne brojeve.
-- ═════════════════════════════════════════════════════════════════════════════
WITH granica AS (SELECT DATE '2026-08-05' AS od),   -- ⚙️ jedina podesiva vrednost
op AS (   -- ključ OPERACIJE (ne reda): FIX A ume da razbije kucanja na više redova
  SELECT project_id, ident_number, variant, operation_number, work_center_code,
         SUM(piece_count)                                          AS cum,
         MAX(ABS(piece_count))                                     AS max_abs,
         COUNT(*) FILTER (WHERE COALESCE(is_process_finished, false) = false) AS otvorenih,
         MAX(finished_at)                                          AS zadnje_zatvaranje
  FROM tech_processes
  GROUP BY 1, 2, 3, 4, 5
),
kandidat AS (
  SELECT t.id, t.worker_id, t.piece_count AS red_kom, t.finished_at,
         t.project_id, t.ident_number, t.variant,
         t.operation_number, t.work_center_code,
         wo.id AS wo_id, wo.ident_number AS rn, wo.piece_count AS plan
  FROM tech_processes t
  CROSS JOIN granica g
  JOIN op k ON k.project_id = t.project_id AND k.ident_number = t.ident_number
           AND k.variant = t.variant AND k.operation_number = t.operation_number
           AND k.work_center_code = t.work_center_code
  JOIN work_orders wo ON wo.project_id = t.project_id
                     AND wo.ident_number = t.ident_number
                     AND wo.variant = t.variant
  LEFT JOIN operations o ON o.work_center_code = t.work_center_code
  WHERE k.cum = 0                    -- 🔴 NIJEDAN komad na CELOJ operaciji…
    AND k.max_abs = 0                -- …i to ne zbog storno netiranja (+3 pa −3)
    AND k.otvorenih = 0              -- operacija je mrtva (nema nijedan otvoren red)
    AND k.zadnje_zatvaranje >= g.od  -- ⚙️ era pitanja o gotovosti (v. header)
    AND COALESCE(o.without_process, false) = false          -- opšti nalog: zatvoren red = istorija
    AND COALESCE(o.significant_for_finishing, false) = false -- završna kontrola se ne dira
    AND COALESCE(wo.status, false) = false                  -- RN nije završen
    -- RN NIJE prošao završnu kontrolu (kaskadno zatvaranje prethodnih operacija je
    -- legitimno — odluka Nesa 10.07.; isti oblik JOIN-a kao u skriptu od 05.08.)
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
-- JEDAN red po operaciji zadržava vlasnika: najstariji (findRoutingTp bira MIN id)
vlasnik AS (
  SELECT DISTINCT ON (wo_id, operation_number, work_center_code) id
  FROM kandidat
  ORDER BY wo_id, operation_number, work_center_code, id
)
SELECT 'ZBIR' AS vrsta, NULL::int AS tp_id, NULL::int AS wo_id, NULL::text AS rn,
       NULL::int AS op, NULL::text AS rc, NULL::int AS radnik,
       NULL::int AS red_kom, NULL::int AS plan, NULL::timestamp AS finished_at,
       COUNT(*)::text || ' redova se otvara · ' ||
       COUNT(DISTINCT (wo_id, operation_number, work_center_code))::text || ' operacija · ' ||
       COUNT(DISTINCT wo_id)::text || ' RN · ' ||
       (SELECT COUNT(*) FROM vlasnik)::text || ' ostaje vlasniku · ' ||
       (COUNT(*) - (SELECT COUNT(*) FROM vlasnik))::text || ' otkup' AS akcija
FROM kandidat
UNION ALL
SELECT 'RED', c.id, c.wo_id, c.rn, c.operation_number, c.work_center_code, c.worker_id,
       c.red_kom, c.plan, c.finished_at::timestamp(0),
       CASE WHEN c.id IN (SELECT id FROM vlasnik)
            THEN 'OTVARA SE + ostaje vlasniku'
            ELSE 'OTVARA SE + otkup (duplikat iste operacije)' END
FROM kandidat c
ORDER BY vrsta, finished_at NULLS FIRST, tp_id;


-- ═════════════════════════════════════════════════════════════════════════════
-- KORAK 2 — UPIS. Jedna transakcija. Ista definicija kandidata kao u KORAKU 1
-- (kopija, ne referenca — skript se pušta blok po blok).
-- ═════════════════════════════════════════════════════════════════════════════
BEGIN;

WITH granica AS (SELECT DATE '2026-08-05' AS od),   -- ⚙️ ISTA vrednost kao u KORAKU 1
op AS (
  SELECT project_id, ident_number, variant, operation_number, work_center_code,
         SUM(piece_count) AS cum,
         MAX(ABS(piece_count)) AS max_abs,
         COUNT(*) FILTER (WHERE COALESCE(is_process_finished, false) = false) AS otvorenih,
         MAX(finished_at) AS zadnje_zatvaranje
  FROM tech_processes
  GROUP BY 1, 2, 3, 4, 5
),
kandidat AS (
  SELECT t.id, t.worker_id, t.finished_at, t.project_id, t.ident_number, t.variant,
         t.operation_number, t.work_center_code, wo.id AS wo_id
  FROM tech_processes t
  CROSS JOIN granica g
  JOIN op k ON k.project_id = t.project_id AND k.ident_number = t.ident_number
           AND k.variant = t.variant AND k.operation_number = t.operation_number
           AND k.work_center_code = t.work_center_code
  JOIN work_orders wo ON wo.project_id = t.project_id
                     AND wo.ident_number = t.ident_number
                     AND wo.variant = t.variant
  LEFT JOIN operations o ON o.work_center_code = t.work_center_code
  WHERE k.cum = 0
    AND k.max_abs = 0
    AND k.otvorenih = 0
    AND k.zadnje_zatvaranje >= g.od
    AND COALESCE(o.without_process, false) = false
    AND COALESCE(o.significant_for_finishing, false) = false
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
vlasnik AS (
  SELECT DISTINCT ON (wo_id, operation_number, work_center_code) id
  FROM kandidat
  ORDER BY wo_id, operation_number, work_center_code, id
),
-- (0) AUDIT PRE UPISA: ceo spisak + izvorne vrednosti (povratak bez CSV-a).
revizija AS (
  INSERT INTO audit_log (action, entity_type, entity_id, before_data, metadata, created_at)
  SELECT 'SANACIJA kiosk-nula-komada 2026-08-07 (vraćanje u otvoreno)',
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
-- (a) skini zastavicu SVIM redovima kandidat-operacije (bool_or traži da nijedan
--     ne ostane true) i (b) otkupi sve osim najstarijeg reda po operaciji
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
--   1. preostali kandidati = 0 (idempotentnost — drugi prolaz ne bi dirnuo ništa),
--   2. SVE mrtve „nula" operacije od granice — pada za broj iz KORAKA 1, a ostatak
--      su svesno izuzete (07.08.: 3 → 1, jer RN 9400/2/486 ima prošlu ZK),
--   3. broj OTVORENIH operacija sa kumulativom 0 porastao za broj iz KORAKA 1
--      (mereno 07.08.: 15 → očekivano 17),
--   4. nijedna operacija nema VIŠE od jednog otvorenog reda sa vlasnikom
--      (⚠️ ZATEČENO 05.08. = 1, RN 9000/95 v1 op 20 RC 3.12 — MORA ostati 1),
--   5. audit red postoji (povratak je moguć),
--   6. dokazni primeri iz KORAKA 1 su otvoreni (07.08.: tp 119224 i 119234 → f/NULL).
-- ═════════════════════════════════════════════════════════════════════════════
WITH granica AS (SELECT DATE '2026-08-05' AS od),   -- ⚙️ ISTA vrednost kao gore
op AS (
  SELECT project_id, ident_number, variant, operation_number, work_center_code,
         SUM(piece_count) AS cum,
         MAX(ABS(piece_count)) AS max_abs,
         COUNT(*) FILTER (WHERE COALESCE(is_process_finished, false) = false) AS otvorenih,
         MAX(finished_at) AS zadnje_zatvaranje
  FROM tech_processes
  GROUP BY 1, 2, 3, 4, 5
),
kandidat AS (
  SELECT t.id
  FROM tech_processes t
  CROSS JOIN granica g
  JOIN op k ON k.project_id = t.project_id AND k.ident_number = t.ident_number
           AND k.variant = t.variant AND k.operation_number = t.operation_number
           AND k.work_center_code = t.work_center_code
  JOIN work_orders wo ON wo.project_id = t.project_id
                     AND wo.ident_number = t.ident_number
                     AND wo.variant = t.variant
  LEFT JOIN operations o ON o.work_center_code = t.work_center_code
  WHERE k.cum = 0 AND k.max_abs = 0 AND k.otvorenih = 0
    AND k.zadnje_zatvaranje >= g.od
    AND COALESCE(o.without_process, false) = false
    AND COALESCE(o.significant_for_finishing, false) = false
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
SELECT '2. SVE mrtve „nula" operacije od granice (ostatak = svesno izuzete)',
       (SELECT COUNT(*)::text FROM op k CROSS JOIN granica g
         WHERE k.cum = 0 AND k.max_abs = 0 AND k.otvorenih = 0
           AND k.zadnje_zatvaranje >= g.od)
UNION ALL
SELECT '3. OTVORENE operacije sa kumulativom 0 (bilo 15 pre sanacije)',
       (SELECT COUNT(*)::text FROM op WHERE cum = 0 AND otvorenih > 0)
UNION ALL
-- 🔴 sanacija ne sme da NAPRAVI operaciju sa više otvorenih redova istog vlasnika
-- („Moji otvoreni" bi prikazao duplikate).
SELECT '4. operacije sa >1 otvorenim redom koji ima vlasnika (MORA ostati 1)',
       (SELECT COUNT(*)::text FROM (
          SELECT 1 FROM tech_processes t
           WHERE COALESCE(t.is_process_finished, false) = false AND t.worker_id <> 0
           GROUP BY t.project_id, t.ident_number, t.variant,
                    t.operation_number, t.work_center_code
          HAVING COUNT(*) > 1) x)
UNION ALL
SELECT '5. audit red sanacije (povratak moguć)',
       (SELECT COALESCE(MAX(id)::text, 'NEMA')
          FROM audit_log
         WHERE action LIKE 'SANACIJA kiosk-nula-komada 2026-08-07%')
UNION ALL
SELECT '6. dokazni primeri tp 119224 / 119234 (očekivano f/NULL)',
       (SELECT COALESCE(string_agg(id || '=' || COALESCE(is_process_finished::text, 'null')
                          || '/' || COALESCE(finished_at::text, 'NULL'), ' · ' ORDER BY id), 'NEMA')
          FROM tech_processes WHERE id IN (119224, 119234));
