-- =============================================================================
-- 016/26 ČETVRTI KRUG — obaveštenje SAMO o lansiranju NACRTA primopredaje
-- (Strahinja Petrović, 04.08.2026 08:09)
-- =============================================================================
-- ZAHTEV (doslovno): „Ukinuti da stižu obaveštenja kad se lansira tehnologija u
-- proizvodnju. Nek stiže obaveštenje na mejl samo kad se lansira primopredaja i
-- to je to. Ništa drugo. […] samo obaveštenje kad se lansira primopredaja za
-- projekat i to je to."
--
-- ŠTA STRAHINJA RAZLIKUJE (iz njegovog sopstvenog opisa, komentar 27.07 na
-- zahtevu 016/26 — NIJE naša interpretacija):
--   „…kada stiže obaveštenje da stigne za celu primopredaju, tj NACRT
--    primopredaje da je puštena, a ne za svaku pojedinačnu poziciju u toj
--    primopredaji […] može da se desi da jedna primopredaja ima 50 crteža."
--   uz DOSLOVAN šablon mejla koji želi:
--      Primopredaja je lansirana u proizvodnju:
--      • Nacrt primopredaje : G-260724-010
--      • Predmet: 9400/7
--      • Komitent: 14. OKTOBAR d.o.o. Kruševac
--      • Lansirao: Dragan Ristanic 20.08.2026
-- Dakle: „lansira se tehnologija" = POJEDINAČNA POZICIJA (RN) — to se gasi;
--        „lansira se primopredaja za projekat" = NACRT (`handover_drafts`) —
--        ostaje, tačno JEDNOM po nacrtu.
--
-- ZAŠTO DOSADAŠNJA AGREGACIJA PO AKTERU NIJE BILA DOVOLJNA (izmereno na produ
-- 04.08.2026 nad `work_order_launch_notifications` + `drawing_handovers`):
--   • 181 obaveštenje = 181 različita primopredaja (pozicija) = samo 34 NACRTA;
--   • nacrt se NE lansira u jednom talasu: od 349 ikad lansiranih nacrta samo
--     95 (27%) je celo stalo u 3 minuta, a 113 (32%) se lansira DUŽE OD DANA;
--   • školski primer je baš nacrt iz Strahinjinog šablona — G-260724-010
--     (predmet 9400/7): 34 lansiranja razvučena na 4.381 minut (3 dana).
--   Prozor tišine od 3 min zato NIKAKO ne može da svede nacrt na jedan mejl —
--   ključ agregacije mora biti NACRT, ne akter.
--
-- ZAŠTO „PRVO LANSIRANJE NACRTA", A NE „KAD JE NACRT 100% LANSIRAN" (izmereno):
--   od 365 nacrta sa primopredajama 27 je trajno DELIMIČNO lansirano, a 16 nema
--   nijedno lansiranje; npr. G-260801-002 ima 139 pozicija a lansirane su 4.
--   Čekanje na potpunost bi tim nacrtima obaveštenje TIHO POJELO zauvek. Zato:
--   obaveštenje ide na PRVO lansiranje bilo koje pozicije nacrta, tačno jednom.
--
-- ZAŠTO SE NE GASI PUT `source='work_order'` (ekran „Radni nalozi"): IZMERENO —
--   svih 181/181 dosadašnjih lansiranja došlo je baš tim putem, nijedno sa
--   ekrana „Primopredaje" (`source='handover'`). Doslovno gašenje tog puta
--   značilo bi NULA obaveštenja. Ekran je samo ulazna tačka; događaj koji
--   Strahinja opisuje („primopredaja za projekat je lansirana") je isti bez
--   obzira odakle je kliknut, pa se gasi PO-POZICIJI granularnost, ne put.
--
-- ADITIVNO i idempotentno (ADD COLUMN / CREATE INDEX IF NOT EXISTS + UPDATE sa
-- WHERE …IS NULL). Postojeći redovi se ne brišu.
-- =============================================================================

-- ⚠️ REVIEW-BLOKER (isti dan): veza crtež→nacrt NEMA FK i NIJE jednoznačna —
-- izmereno 358 od 3.658 crteža (9,8%) pripada VIŠE nacrta. Dok je ta veza bila
-- kozmetička etiketa (kolona „Nacrt" u listi), pogrešan pogodak je bio ružan ali
-- bezopasan; kao KLJUČ garancije „tačno jednom zauvek" pogrešan pogodak trajno
-- UĆUTKUJE tuđi nacrt. Zato važi princip: DEDUP SAMO NA SIGURNOM —
-- `handover_draft_id` se popunjava ISKLJUČIVO kad crtež pripada TAČNO JEDNOM
-- ne-isključenom nacrtu I kad je predmet tog nacrta ISTI kao predmet RN-a
-- (izmereno: 280 pozicija u 33 nacrta razrešava u nacrt DRUGOG predmeta).
-- NULL = dvosmisleno/nerazrešeno → red ide starim putem (jedno obaveštenje po
-- poziciji, kao pre ovog paketa). Bolje 9,8% dvosmislenih crteža i dalje
-- pojedinačno nego ijedan nacrt koji trajno zanemi.
ALTER TABLE "work_order_launch_notifications"
  ADD COLUMN IF NOT EXISTS "handover_draft_id" INTEGER;

COMMENT ON COLUMN "work_order_launch_notifications"."handover_draft_id" IS
  'handover_drafts.id nacrta iz kog je pozicija potekla — ključ agregacije i dedupa (016/26 četvrti krug: tačno jedno obaveštenje po nacrtu). Popunjeno SAMO kad je veza SIGURNA (crtež u tačno jednom ne-isključenom nacrtu + isti predmet kao RN). NULL = dvosmisleno/nerazrešeno → obaveštenje ide pojedinačno po poziciji.';

-- Razdvajanje „obrađeno" od „ISPORUČENO". `notified_at` znači samo da je red
-- obrađen u nekom prolazu (pa i kad nije bilo kome da se šalje); dedup po nacrtu
-- sme da se osloni ISKLJUČIVO na stvarnu isporuku. Bez ove kolone bi SMTP ispad
-- u trenutku prvog lansiranja nacrta taj nacrt zapečatio zauvek.
ALTER TABLE "work_order_launch_notifications"
  ADD COLUMN IF NOT EXISTS "sent_at" TIMESTAMPTZ(6);

COMMENT ON COLUMN "work_order_launch_notifications"."sent_at" IS
  'Trenutak STVARNE isporuke (bar jedan mejl ili zvonce uspeo) — jedini osnov za dedup „jedno obaveštenje po nacrtu". NULL uz popunjen notified_at = red obrađen, ali ništa nije isporučeno (nema planera / pad slanja) → nacrt NIJE zapečaćen.';

-- Sweeper grupiše SAMO pending redove (notified_at IS NULL) po nacrtu.
-- Prisma šema ne ume WHERE indekse → SQL-only (dokumentovano u schema.prisma).
CREATE INDEX IF NOT EXISTS "idx_work_order_launch_notifications_pending_draft"
  ON "work_order_launch_notifications" ("handover_draft_id", "created_at")
  WHERE "notified_at" IS NULL;

-- Provera „da li je za ovaj nacrt obaveštenje VEĆ ISPORUČENO" (dedup „tačno
-- jednom po nacrtu") gleda isključivo isporučene redove — parcijalni indeks je
-- tačno taj skup.
CREATE INDEX IF NOT EXISTS "idx_work_order_launch_notifications_sent_draft"
  ON "work_order_launch_notifications" ("handover_draft_id")
  WHERE "sent_at" IS NOT NULL;

-- Stari pending indeks po akteru (migracija 20260803153000) se NAMERNO NE BRIŠE:
-- tabela je mala, a indeks je jedina stvar koja bi falila ako se deploy vrati na
-- prethodni image (rollback bez migracije unazad).

-- ── BACKFILL ────────────────────────────────────────────────────────────────
-- Bez ovoga bi prvi posle-deploy lansiranje SVAKOG već obrađenog nacrta poslalo
-- „nacrt lansiran" mejl iako je planer za taj nacrt već dobio 34 mejla (npr.
-- G-260724-010). Popunjava se ISTIM STROGIM uslovom kao kod (`resolveDraft`):
-- crtež mora pripadati TAČNO JEDNOM ne-isključenom nacrtu, a predmet tog nacrta
-- mora biti ISTI kao predmet RN-a. Verzija sa `DISTINCT ON` (uzmi najskoriji
-- nacrt) je IZMERENO opasna: 4 nacrta bi odmah po deploy-u postala trajno nema
-- jer im crteži razrešavaju u već javljene nacrte (npr. G-260724-004 →
-- G-260724-009; G-260724-008 → G-260724-010, ISTI predmet 9400/7 pa ni provera
-- predmeta to ne bi uhvatila — jedini lek je uslov jednoznačnosti).
WITH jednoznacni AS (
  SELECT i."drawing_id", min(i."draft_id") AS draft_id
  FROM "handover_draft_items" i
  WHERE i."exclude_from_handover" = false
  GROUP BY i."drawing_id"
  HAVING count(DISTINCT i."draft_id") = 1
)
-- ⚠️ PostgreSQL: ciljna tabela UPDATE-a (`n`) se NE SME referencirati u JOIN
-- uslovu unutar FROM klauzule — daje 42P01 „invalid reference to FROM-clause
-- entry". Zato veza sa `work_orders` ide kroz EXISTS, a ne kroz JOIN.
-- (Prva verzija je baš tako pala pri deploy-u 04.08. i blokirala migracije.)
UPDATE "work_order_launch_notifications" n
SET "handover_draft_id" = j.draft_id
FROM jednoznacni j
JOIN "drawing_handovers" h ON h."drawing_id" = j."drawing_id"
JOIN "handover_drafts" hd ON hd."id" = j.draft_id
WHERE n."drawing_handover_id" = h."id"
  AND n."handover_draft_id" IS NULL
  AND EXISTS (                            -- predmet nacrta = predmet RN-a
    SELECT 1 FROM "work_orders" w
    WHERE w."id" = n."work_order_id" AND w."project_id" = hd."project_id"
  );

-- Postojeći redovi SU isporučeni (poslati su po starom, pojedinačnom toku) —
-- bez ovoga bi dedup mislio da nijedan nacrt nije javljen i posle deploy-a bi
-- na prvo sledeće lansiranje poslao „nacrt lansiran" za već ispričane nacrte.
UPDATE "work_order_launch_notifications"
SET "sent_at" = "notified_at"
WHERE "notified_at" IS NOT NULL AND "sent_at" IS NULL;
