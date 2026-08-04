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

-- Ključ agregacije i deduplikacije: nacrt (`handover_drafts.id`) iz kog je
-- pozicija potekla. Soft ref BEZ FK — isti razlog kao ostale kolone ove tabele
-- (batch-resolve obrazac; veza nacrt↔primopredaja je i inače heuristika preko
-- `handover_draft_items.drawing_id`, jer `drawing_handovers` NEMA FK ka nacrtu).
-- NULL = veza se nije razrešila (legacy red bez nacrta) → servis takav red
-- degradira na dosadašnje ponašanje „jedno obaveštenje po poziciji", da se
-- obaveštenje nikad ne izgubi tiho.
ALTER TABLE "work_order_launch_notifications"
  ADD COLUMN IF NOT EXISTS "handover_draft_id" INTEGER;

COMMENT ON COLUMN "work_order_launch_notifications"."handover_draft_id" IS
  'handover_drafts.id nacrta iz kog je pozicija potekla — ključ agregacije i dedupa obaveštenja (016/26 četvrti krug: tačno jedno obaveštenje po nacrtu). NULL = veza nerazrešena, red se šalje pojedinačno.';

-- Sweeper grupiše SAMO pending redove (notified_at IS NULL) po nacrtu.
-- Prisma šema ne ume WHERE indekse → SQL-only (dokumentovano u schema.prisma).
CREATE INDEX IF NOT EXISTS "idx_work_order_launch_notifications_pending_draft"
  ON "work_order_launch_notifications" ("handover_draft_id", "created_at")
  WHERE "notified_at" IS NULL;

-- Provera „da li je za ovaj nacrt obaveštenje VEĆ poslato" (dedup „tačno jednom
-- po nacrtu") gleda isključivo obrađene redove — parcijalni indeks je tačno taj skup.
CREATE INDEX IF NOT EXISTS "idx_work_order_launch_notifications_sent_draft"
  ON "work_order_launch_notifications" ("handover_draft_id")
  WHERE "notified_at" IS NOT NULL;

-- Stari pending indeks po akteru (migracija 20260803153000) se NAMERNO NE BRIŠE:
-- tabela je mala, a indeks je jedina stvar koja bi falila ako se deploy vrati na
-- prethodni image (rollback bez migracije unazad).

-- ── BACKFILL ────────────────────────────────────────────────────────────────
-- Bez ovoga bi prvi posle-deploy lansiranje SVAKOG već obrađenog nacrta poslalo
-- „nacrt lansiran" mejl iako je planer za taj nacrt već dobio 34 mejla (npr.
-- G-260724-010). Popunjava se istom heuristikom koju kod koristi
-- (`resolveDraftContext`): crtež primopredaje → najskorija NE-isključena stavka
-- nacrta (najveći draft_id, pa najveći id).
UPDATE "work_order_launch_notifications" n
SET "handover_draft_id" = d.draft_id
FROM (
  SELECT DISTINCT ON (i."drawing_id")
         i."drawing_id", i."draft_id"
  FROM "handover_draft_items" i
  WHERE i."exclude_from_handover" = false
  ORDER BY i."drawing_id", i."draft_id" DESC, i."id" DESC
) d
JOIN "drawing_handovers" h ON h."drawing_id" = d."drawing_id"
WHERE n."drawing_handover_id" = h."id"
  AND n."handover_draft_id" IS NULL;
