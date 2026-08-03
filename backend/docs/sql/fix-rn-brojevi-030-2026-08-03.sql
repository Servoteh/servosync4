-- ============================================================================
-- DATA-FIX: renumeracija otrovnih RN brojeva u predmetu 7701 (zahtev 030/26)
-- Datum: 2026-08-03 · Baza: GLAVNA (servosync-pg, app baza — NE sy15)
-- Grana: fix/rn-numbering-030
-- ============================================================================
--
-- ZAŠTO: legacy typo red '770171831' (wo.id 40199, 21.01.2026 — ukucana „7"
-- umesto „/") je preko split('/').pop() hranio MAX+1 brojač sa 770 miliona.
-- Kod-fix (PR #49, 27.07.) je popravio WorkOrderNumberingService, ali je
-- handovers.service.ts imao DUPLIKAT te logike (nextWorkOrderIdent, „ne
-- importovati" po tadašnjem uputstvu) BEZ popravke — a Jovica RN-ove otvara
-- kroz primopredaju, pa je 03.08. 08:31–10:50 dobio još DESET kaskadnih RN
-- (7701/770171835…844). Na grani fix/rn-numbering-030 duplikat je UKINUT
-- (primopredaja koristi deljeni servis: prefiks-provera + sanity prag
-- 100.000), ali brojevi na tih 10 naloga i dalje stoje besmisleni — ovaj
-- skript ih vraća u normalan niz.
--
-- IZMERENO NA PRODU 03.08.2026 (podloga za prag i obuhvat):
--   • najveći legitiman ordinal IGDE = 2.273 (upravo 7701); opseg
--     10.000–99.999 je prazan (0 od 40.786 idents sa kosom crtom);
--   • otrovni redovi predmeta 7701 (14 kom): '770171831' + '7701/770171832…844';
--   • predmeti 6938 i 7350 NISU otrovani — raniji nalazi „86 outliera
--     (max 1.276.133)" i „272.111" su artefakt merenja koje je SPAJALO sve
--     cifre poslednjeg segmenta ('6938/1276-13.3' → „1276133"). Stvarni parser
--     (parseInt vodećih cifara) vidi 1276 — to je NAMERNA konvencija
--     podnumeracije (glavni-pod.podpod) i NE DIRA SE. Jedina anomalija u 6938
--     je jedan legacy red bez kose crte '693871504' (wo.id 29146, 08.04.2024,
--     lansiran) — kod ga od 27.07. ignoriše; odluka o preimenovanju ide Nenadu.
--
-- ŠTA RADI: naloge predmeta 7701 čiji je ordinal ≥ 100.000, koji NISU
-- lansirani i NEMAJU nikakav trag rada (uslovi dole), renumeriše na sledeće
-- slobodne normalne ordinale REDOM PO created_at → očekivano
-- 7701/770171835…844 (10 kom, id 47648, 47682–47685, 47687–47691) postaju
-- 7701/2274…2283.
--
-- ŠTA OSTAVLJA (popisano u KORAKU 1, akcija 'OSTAJE'):
--   • 40199  '770171831'      — izvorni typo; LANSIRAN (handover_status_id=3),
--                               is_locked, ima 1 tech_processes red;
--   • 47518  '7701/770171832' — lansiran 23.07, ZAVRŠEN, ima rad/lokacije;
--   • 47519  '7701/770171833' — lansiran 23.07;
--   • 47582  '7701/770171834' — lansiran 27.07, ZAVRŠEN, ima rad/lokacije.
--   (Presuda 27.07: lansirani ostaju kakvi jesu — pogon radi po odštampanom
--   nalogu; preimenovanje bi razvezalo papir od baze.)
--
-- GDE SE IDENT REFERENCIRA STRINGOM (provereno u schema.prisma 03.08):
--   tech_processes.ident_number, work_time_entries.ident_number,
--   labels.ident_number + labels.bar_code, nonconformity_reports.ident_number,
--   quality_documents.ident_number, tech_process_backup.ident_number.
--   RNZ barkod (`RNZ:<id>:<ident>:<var>:<rev>`) se GENERIŠE PRI ŠTAMPI iz živih
--   podataka (barcode.service / locations/barcode.ts) i ne čuva se van
--   `labels`. Svi kandidati imaju NULA redova u SVIM ovim tabelama — to nije
--   samo provereno merenjem, nego je i TVRDI USLOV u WHERE (NOT EXISTS po
--   work_order_id I po ident stringu), pa je skript bezbedan i ako se stanje
--   promeni između čitanja i izvršavanja. Preostali rizik: RN PDF štampa se
--   nigde ne loguje — ako je neko danas odštampao papir kandidata, na njemu
--   je stari broj (nalozi nisu lansirani, pogon po njima ne radi; Jovica je
--   brojeve sam prijavio kao pogrešne).
--
-- SIGURNOST:
--   • IDEMPOTENTNO — posle prvog prolaza kandidati imaju normalne ordinale
--     (< 100.000) pa ih drugi prolaz ne nalazi (0 redova).
--   • Advisory lock ISTI kao u aplikaciji (pg_advisory_xact_lock(project_id))
--     → nema trke sa istovremenim otvaranjem novog RN u 7701.
--   • Novi ordinali se RAČUNAJU iz baze u istoj transakciji (MAX legitimnih
--     + redni broj), ništa nije ukucano; uq (project_id, ident_number,
--     variant) obara transakciju ako bi ipak došlo do kolizije.
--   • Jedina hardkodovana vrednost: broj predmeta '7701' (+ prag 100000,
--     isti kao SANITY_MAX_ORDINAL u kodu).
--
-- UPUTSTVO: prvo pusti KORAK 1 (pregled) i uporedi sa spiskom gore
-- (očekivano: 10× RENUMERIŠE sa predlogom 2274…2283, 4× OSTAJE). Ako se
-- poklapa, pusti KORAK 2. Zatim KORAK 3 (provera).
--
-- KO GA PUŠTA: nalog sa UPDATE na work_orders (sekvence se NE diraju —
-- nema INSERT-a).
-- ============================================================================


-- ═════════════════════════════════════════════════════════════════════════════
-- KORAK 1 — PREGLED (ništa ne menja). Očekivano 14 redova:
--   10 × akcija='RENUMERIŠE' (novi_ident 7701/2274…2283, redom po created_at),
--    4 × akcija='OSTAJE …' (40199, 47518, 47519, 47582).
-- ═════════════════════════════════════════════════════════════════════════════
WITH proj AS (
  SELECT id, project_number FROM projects WHERE project_number = '7701'
),
otrov AS (  -- svi otrovni redovi predmeta: bez prefiksa ILI ordinal ≥ praga
  SELECT w.id, w.ident_number, w.created_at, w.handover_status_id, w.is_locked,
         p.project_number,
         (substring(regexp_replace(w.ident_number, '^.*/', '') from '^[0-9]+'))::bigint AS ord,
         w.ident_number NOT LIKE p.project_number || '/%' AS bez_prefiksa
  FROM work_orders w
  JOIN proj p ON p.id = w.project_id
  WHERE w.ident_number NOT LIKE p.project_number || '/%'
     OR (substring(regexp_replace(w.ident_number, '^.*/', '') from '^[0-9]+'))::bigint >= 100000
),
tragovi AS (  -- bezbednosne provere po redu (i po FK i po ident stringu)
  SELECT o.*,
         EXISTS (SELECT 1 FROM work_order_launches l
                  WHERE l.work_order_id = o.id AND l.is_launched)          AS lansiran_wol,
         EXISTS (SELECT 1 FROM tech_processes tp
                  WHERE tp.work_order_id = o.id
                     OR (tp.project_id = (SELECT id FROM proj)
                         AND tp.ident_number = o.ident_number))            AS ima_tp,
         EXISTS (SELECT 1 FROM labels lb
                  WHERE lb.work_order_id = o.id
                     OR lb.ident_number = o.ident_number)                  AS ima_nalepnice,
         EXISTS (SELECT 1 FROM part_locations pl
                  WHERE pl.work_order_id = o.id)                           AS ima_lokacije,
         EXISTS (SELECT 1 FROM work_time_entries wte
                  WHERE wte.ident_number = o.ident_number)                 AS ima_sate,
         EXISTS (SELECT 1 FROM nonconformity_reports nr
                  WHERE nr.ident_number = o.ident_number)                  AS ima_neusagl,
         EXISTS (SELECT 1 FROM quality_documents qd
                  WHERE qd.ident_number = o.ident_number)                  AS ima_kval_dok
  FROM otrov o
),
ocena AS (
  SELECT t.*,
         (NOT t.bez_prefiksa                       -- typo red se NE renumeriše ovim skriptom
          AND t.handover_status_id <> 3            -- 3 = LANSIRAN (WO_STATUS.LAUNCHED)
          AND COALESCE(t.is_locked, false) = false
          AND NOT t.lansiran_wol AND NOT t.ima_tp AND NOT t.ima_nalepnice
          AND NOT t.ima_lokacije AND NOT t.ima_sate
          AND NOT t.ima_neusagl AND NOT t.ima_kval_dok) AS za_renumeraciju
  FROM tragovi t
),
baza AS (  -- najveći LEGITIMAN ordinal (isti filter kao kod: prefiks + prag)
  SELECT COALESCE(MAX((substring(regexp_replace(w.ident_number, '^.*/', '') from '^[0-9]+'))::bigint), 0) AS max_ord
  FROM work_orders w
  JOIN proj p ON p.id = w.project_id
  WHERE w.ident_number LIKE p.project_number || '/%'
    AND (substring(regexp_replace(w.ident_number, '^.*/', '') from '^[0-9]+'))::bigint < 100000
)
SELECT o.id, o.ident_number AS stari_ident,
       o.created_at, o.handover_status_id, o.is_locked,
       o.lansiran_wol, o.ima_tp, o.ima_nalepnice, o.ima_lokacije,
       o.ima_sate, o.ima_neusagl, o.ima_kval_dok,
       CASE WHEN o.za_renumeraciju
            THEN 'RENUMERIŠE → ' || o.project_number || '/' ||
                 (b.max_ord + row_number() OVER (PARTITION BY o.za_renumeraciju
                                                 ORDER BY o.created_at, o.id))::text
            ELSE 'OSTAJE (lansiran / zaključan / ima trag rada / typo bez prefiksa)'
       END AS akcija
FROM ocena o CROSS JOIN baza b
ORDER BY o.za_renumeraciju DESC, o.created_at;

-- Kontrola pre upisa: ciljni opseg mora biti SLOBODAN (očekivano 0 redova).
WITH proj AS (SELECT id, project_number FROM projects WHERE project_number = '7701'),
baza AS (
  SELECT COALESCE(MAX((substring(regexp_replace(w.ident_number, '^.*/', '') from '^[0-9]+'))::bigint), 0) AS max_ord
  FROM work_orders w JOIN proj p ON p.id = w.project_id
  WHERE w.ident_number LIKE p.project_number || '/%'
    AND (substring(regexp_replace(w.ident_number, '^.*/', '') from '^[0-9]+'))::bigint < 100000
)
SELECT w.id, w.ident_number
FROM work_orders w JOIN proj p ON p.id = w.project_id, baza b
WHERE w.ident_number IN (SELECT p2.project_number || '/' || g::text
                         FROM proj p2, generate_series(b.max_ord + 1, b.max_ord + 20) g);


-- ═════════════════════════════════════════════════════════════════════════════
-- KORAK 2 — UPIS. Jedna transakcija; isti advisory lock kao aplikacija, pa se
-- baza (MAX) i dodela računaju bez trke sa otvaranjem novih RN.
-- ═════════════════════════════════════════════════════════════════════════════
BEGIN;

-- Isti lock kao WorkOrderNumberingService.next(tx, projectId).
SELECT pg_advisory_xact_lock(id) FROM projects WHERE project_number = '7701';

WITH proj AS (
  SELECT id, project_number FROM projects WHERE project_number = '7701'
),
baza AS (
  SELECT COALESCE(MAX((substring(regexp_replace(w.ident_number, '^.*/', '') from '^[0-9]+'))::bigint), 0) AS max_ord
  FROM work_orders w
  JOIN proj p ON p.id = w.project_id
  WHERE w.ident_number LIKE p.project_number || '/%'
    AND (substring(regexp_replace(w.ident_number, '^.*/', '') from '^[0-9]+'))::bigint < 100000
),
kandidat AS (
  SELECT w.id, w.ident_number,
         row_number() OVER (ORDER BY w.created_at, w.id) AS rb
  FROM work_orders w
  JOIN proj p ON p.id = w.project_id
  WHERE w.ident_number LIKE p.project_number || '/%'                    -- ne typo redovi
    AND (substring(regexp_replace(w.ident_number, '^.*/', '') from '^[0-9]+'))::bigint >= 100000
    AND w.handover_status_id <> 3                                       -- nije LANSIRAN
    AND COALESCE(w.is_locked, false) = false
    AND NOT EXISTS (SELECT 1 FROM work_order_launches l
                     WHERE l.work_order_id = w.id AND l.is_launched)
    AND NOT EXISTS (SELECT 1 FROM tech_processes tp
                     WHERE tp.work_order_id = w.id
                        OR (tp.project_id = w.project_id
                            AND tp.ident_number = w.ident_number))
    AND NOT EXISTS (SELECT 1 FROM labels lb
                     WHERE lb.work_order_id = w.id
                        OR lb.ident_number = w.ident_number)
    AND NOT EXISTS (SELECT 1 FROM part_locations pl
                     WHERE pl.work_order_id = w.id)
    AND NOT EXISTS (SELECT 1 FROM work_time_entries wte
                     WHERE wte.ident_number = w.ident_number)
    AND NOT EXISTS (SELECT 1 FROM nonconformity_reports nr
                     WHERE nr.ident_number = w.ident_number)
    AND NOT EXISTS (SELECT 1 FROM quality_documents qd
                     WHERE qd.ident_number = w.ident_number)
)
UPDATE work_orders w
   SET ident_number = p.project_number || '/' || (b.max_ord + k.rb)::text,
       updated_at   = now()
  FROM kandidat k, baza b, proj p
 WHERE w.id = k.id
RETURNING w.id, k.ident_number AS stari_ident, w.ident_number AS novi_ident;

-- Očekivano: UPDATE 10, stari 7701/770171835…844 → novi 7701/2274…2283
-- (redom po created_at). Ako broj ne odgovara KORAKU 1: ROLLBACK;

COMMIT;


-- ═════════════════════════════════════════════════════════════════════════════
-- KORAK 3 — PROVERA POSLE UPISA.
-- ═════════════════════════════════════════════════════════════════════════════
-- 3a) Otrovnih redova u 7701 ostaje TAČNO 4 (40199, 47518, 47519, 47582):
WITH proj AS (SELECT id, project_number FROM projects WHERE project_number = '7701')
SELECT w.id, w.ident_number, w.handover_status_id, w.is_locked, w.created_at
FROM work_orders w JOIN proj p ON p.id = w.project_id
WHERE w.ident_number NOT LIKE p.project_number || '/%'
   OR (substring(regexp_replace(w.ident_number, '^.*/', '') from '^[0-9]+'))::bigint >= 100000
ORDER BY w.created_at;

-- 3b) Novi niz bez rupa i duplikata (očekivano: 10 redova 2274…2283, cnt=1):
WITH proj AS (SELECT id, project_number FROM projects WHERE project_number = '7701')
SELECT (substring(regexp_replace(w.ident_number, '^.*/', '') from '^[0-9]+'))::bigint AS ord,
       count(*) AS cnt, min(w.id) AS wo_id
FROM work_orders w JOIN proj p ON p.id = w.project_id
WHERE w.ident_number LIKE p.project_number || '/%'
  AND (substring(regexp_replace(w.ident_number, '^.*/', '') from '^[0-9]+'))::bigint BETWEEN 2274 AND 2283
GROUP BY 1 ORDER BY 1;

-- 3c) Idempotentnost: ponovni KORAK 2 mora da vrati UPDATE 0.
