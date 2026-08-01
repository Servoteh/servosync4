-- =============================================================================
-- REGISTAR VRSTA DOKUMENATA + KOEFICIJENT CENE NA DOKUMENTU
-- (28.07.2026; docs/PLAN_UNOS_DOKUMENATA.md §5.1, §5.3, §5.4 i odluke §8/O1, O4)
-- =============================================================================
-- Temelj za „pun ekran unosa dokumenata". Tri celine, sve ADITIVNE i bez
-- obaranja postojećih redova (svaka kolona je NULL-abilna ili ima default):
--
--   1) `document_types` postaje KONFIGURACIJA EKRANA, ne samo šifarnik. BigBit
--      nema 57 ekrana za 57 vrsta — ima jedan skelet koji `R_Vrste dokumenata`
--      konfiguriše. Bez ovih kolona bi svaka nova vrsta značila novu granu u
--      frontend kodu, tj. tačno ono na šta se vlasnik žali (§2.1).
--
--   2) `invoices.price_coefficient` — ODLUKA §8/O1 („na samoj formi profakture
--      imaš koef da uneseš i njime primeni dugme da pomnožiš svaku stavku").
--      BigBitov obrazac „primeni pa upiši" je DESTRUKTIVAN: drugi klik pomnoži
--      već pomnoženo, a koeficijent se posle ne može ni promeniti ni poništiti.
--      Zato koeficijent živi na zaglavlju, a stavka pamti OSNOVNU cenu
--      (`invoice_items.base_unit_price`); cena na štampi je IZVEDENA:
--          unit_price = base_unit_price × price_coefficient
--      Posledica: dugme se sme pritisnuti više puta (rezultat isti), koeficijent
--      se sme ispraviti sa 1,15 na 1,10, i sme se vratiti na 1 (u BigBitu je to
--      nepovratno).
--
--   3) `invoices.line_profile` — profil stavki (GOODS | SERVICE) je PREDLOG iz
--      registra, PREKUCLJIV po dokumentu (§8/O4.5). Vrsta dokumenta u BigBitu ne
--      određuje tabelu: u `T_Usluge dokumenta` žive i IFR, IZVRO i IFGP —
--      uključujući `IFGP 068/26` iz tekuće godine. Da je profil tvrda validacija
--      po vrsti, uvoz bi odbio stvarne podatke iz godine u kojoj radimo.
--
-- ŠTA OVA MIGRACIJA NAMERNO NE RADI (druge stavke plana, druge migracije):
--   • NE dira `uq_invoices_company_type_number` (obaranje tog indeksa je §8/O3 i
--     ide zasebnom migracijom, pred uvoz istorije — redosled radova §8/O4.4);
--   • NE prebacuje ključ `document_number_sequences` na `numbering_group`
--     (korak 3 istog redosleda — sme tek POSLE uvoza istorije, uz konsolidaciju
--     brojača po MAX preko grupe, inače sledeća faktura dobije zauzet broj);
--   • NE dira `document_number_prefix` postojećih vrsta (prazan/NULL prefiks
--     ostaje kakav jeste — `numbering.service.ts` pada na statičku mapu; promena
--     formata broja je zaseban posao, docs/ODLUKA_NUMERACIJA_DOKUMENATA.md §1).
-- =============================================================================

-- ── 1) document_types: konfiguracija ekrana (§5.1) ───────────────────────────
ALTER TABLE "document_types"
  ADD COLUMN IF NOT EXISTS "numbering_group"            VARCHAR(20),
  ADD COLUMN IF NOT EXISTS "numbering_mode"             VARCHAR(10),
  ADD COLUMN IF NOT EXISTS "screen_kind"                VARCHAR(10),
  ADD COLUMN IF NOT EXISTS "stock_check"                VARCHAR(10),
  ADD COLUMN IF NOT EXISTS "reserves_stock"             BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS "writes_price_list"          BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS "default_price_list_code"    VARCHAR(20),
  ADD COLUMN IF NOT EXISTS "default_vat_exemption_code" VARCHAR(20),
  ADD COLUMN IF NOT EXISTS "requires_project"           BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS "requires_work_order"        BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS "requires_po_number"         BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS "allowed_print_variants"     TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN IF NOT EXISTS "carry_over_targets"         TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

COMMENT ON COLUMN "document_types"."numbering_group" IS
  'Grupa numeracije — više vrsta deli JEDAN godišnji niz (§8/O4.2): INVOICE_OUT | OFFER | ADVANCE | CREDIT | PURCHASE …';
COMMENT ON COLUMN "document_types"."numbering_mode" IS
  'SEQ (brojač) | MAX (prvi slobodan broj iz grupe) | COUNT — oba BigBit mehanizma.';
COMMENT ON COLUMN "document_types"."screen_kind" IS
  'Profil ekrana — PREDLOG, ne tvrdo pravilo (§8/O4.5): GOODS | SERVICE | ORDER. Dokument sme da ga prekuca preko invoices.line_profile.';
COMMENT ON COLUMN "document_types"."stock_check" IS
  'BLOCK | WARN | OFF. Blokira se SAMO ako i magacin vodi zalihe — konjunkcija dva uslova (§2.7).';

-- CHECK-ovi dozvoljavaju NULL: vrste koje plan ne pominje ostaju neopredeljene,
-- a ne dobijaju izmišljenu vrednost.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_document_types_screen_kind') THEN
    ALTER TABLE "document_types" ADD CONSTRAINT "chk_document_types_screen_kind"
      CHECK ("screen_kind" IS NULL OR "screen_kind" IN ('GOODS', 'SERVICE', 'ORDER'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_document_types_stock_check') THEN
    ALTER TABLE "document_types" ADD CONSTRAINT "chk_document_types_stock_check"
      CHECK ("stock_check" IS NULL OR "stock_check" IN ('BLOCK', 'WARN', 'OFF'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_document_types_numbering_mode') THEN
    ALTER TABLE "document_types" ADD CONSTRAINT "chk_document_types_numbering_mode"
      CHECK ("numbering_mode" IS NULL OR "numbering_mode" IN ('SEQ', 'MAX', 'COUNT'));
  END IF;
END $$;

-- Ekran čita registar po grupi („koje vrste dele ovaj niz brojeva").
CREATE INDEX IF NOT EXISTS "idx_document_types_numbering_group"
  ON "document_types" ("numbering_group");

-- ── 2) invoices: koeficijent cene + profil stavki (§5.3, §8/O1, §8/O4.5) ─────
ALTER TABLE "invoices"
  ADD COLUMN IF NOT EXISTS "price_coefficient"            NUMERIC(19, 6) NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS "price_coefficient_applied_at" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "price_coefficient_applied_by" INTEGER,
  ADD COLUMN IF NOT EXISTS "line_profile"                 VARCHAR(10);

COMMENT ON COLUMN "invoices"."price_coefficient" IS
  'Množilac SVIH stavki dokumenta (§8/O1). unit_price = base_unit_price × price_coefficient je IZVEDENO — koeficijent se nikad ne upisuje u cenu stavke.';
COMMENT ON COLUMN "invoices"."line_profile" IS
  'GOODS | SERVICE — profil stavki OVOG dokumenta. NULL = uzmi predlog iz document_types.screen_kind (§8/O4.5).';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_invoices_line_profile') THEN
    ALTER TABLE "invoices" ADD CONSTRAINT "chk_invoices_line_profile"
      CHECK ("line_profile" IS NULL OR "line_profile" IN ('GOODS', 'SERVICE'));
  END IF;
  -- Koeficijent 0 ili negativan bi tiho obrisao/obrnuo ceo dokument, a nema
  -- poslovno značenje. „Bez koeficijenta" = 1, ne 0.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_invoices_price_coefficient') THEN
    ALTER TABLE "invoices" ADD CONSTRAINT "chk_invoices_price_coefficient"
      CHECK ("price_coefficient" > 0);
  END IF;
END $$;

-- ── 3) invoice_items: osnovna cena PRE koeficijenta (§5.4, §8/O1) ────────────
ALTER TABLE "invoice_items"
  ADD COLUMN IF NOT EXISTS "base_unit_price" NUMERIC(19, 4) NOT NULL DEFAULT 0;

COMMENT ON COLUMN "invoice_items"."base_unit_price" IS
  'Cena iz cenovnika / prekucana cena, PRE koeficijenta dokumenta (§8/O1). unit_price = base_unit_price × invoices.price_coefficient.';

-- Backfill: svi zatečeni dokumenti imaju koeficijent 1 (default kolone gore), pa
-- je za njih base_unit_price po definiciji jednaka unit_price. Bez ovoga bi prvo
-- otvaranje starog dokumenta na novom ekranu prikazalo osnovnu cenu 0.
UPDATE "invoice_items"
   SET "base_unit_price" = "unit_price"
 WHERE "base_unit_price" = 0
   AND "unit_price" <> 0;

-- ── 4) SEED registra za vrste koje danas postoje u kodu ──────────────────────
-- Izvor vrsta: `Invoice.documentType` (schema.prisma) + `PREFIX_BY_TYPE`
-- (src/modules/sales/numbering.service.ts) + `CARRY_OVER_TARGET_TYPES`
-- (src/modules/sales/carry-over.service.ts). Rasporede daje §8/O4.4:
--
--   screen_kind     GOODS   → IFR, IFGP, IZVRO, IZVGP (+ robni PON/PROF, UFROB)
--                   SERVICE → IFUSL, IZVUS (+ AVR: uslužni profil, bez artikla)
--   numbering_group INVOICE_OUT → IFR, IFGP, IFUSL, IZVRO, IZVGP, IZVUS
--                                 (JEDNA zajednička serija NNN/YY — izmereno, ne
--                                 pretpostavljeno: §8/O4.2, pet nezavisnih merenja)
--                   OFFER       → PON, PROF (dash-serija 0NNN-YY)
--                   ADVANCE     → AVR (ne sme u INVOICE_OUT — 100+ istorijskih sudara)
--
-- numbering_mode: MAX za INVOICE_OUT (broj se kuca ručno, sistem nudi „prvi
-- slobodan iz grupe" po document_number_seq — §5.6), SEQ za OFFER/ADVANCE (živ
-- BigBit brojač: „Poslednji broj profakture = 264").
--
-- stock_check: OFF na ponudi/predračunu — BigBit kod je tu ZAKOMENTARISAN uz
-- obrazloženje „Pošto je ovo profaktura, nema provera zaliha" (§2.7); OFF na
-- uslužnim vrstama (uslužna stavka nema ni magacin ni šifru artikla, §2.1);
-- BLOCK na robnim izlaznim fakturama („Izdajete veću količinu nego što su vam
-- zalihe", §2.7/A4). Prava odluka je i dalje konjunkcija sa `warehouses`.
--
-- requires_work_order: TRUE samo za IFUSL — jedina vrsta za koju plan izričito
-- kaže „O" (§3.2: „Radni nalog | U (IFUSL: O)"). IZVUS ostaje FALSE dok se ne
-- potvrdi; ovde se ništa ne nagađa.
--
-- IDEMPOTENTNO i NEDESTRUKTIVNO: nove vrste se INSERT-uju, postojeće se dopunjuju
-- samo tamo gde je vrednost još NULL (ručnu izmenu u Podešavanjima ne gazi).
-- Guard je `WHERE NOT EXISTS` po `code`, a ne `ON CONFLICT` — `uq_document_types_code`
-- na nekim bazama još nije primenjen (isti obrazac kao 20260724160000).

CREATE TEMP TABLE "_reg_vrsta" (
  "code"                VARCHAR(5)  NOT NULL,
  "description"         VARCHAR(50) NOT NULL,
  "is_inbound"          BOOLEAN     NOT NULL,
  "affects_stock"       BOOLEAN     NOT NULL,
  "post_in_vat_ledger"  BOOLEAN     NOT NULL,
  "screen_kind"         VARCHAR(10),
  "numbering_group"     VARCHAR(20),
  "numbering_mode"      VARCHAR(10),
  "stock_check"         VARCHAR(10),
  "requires_work_order" BOOLEAN     NOT NULL
);

INSERT INTO "_reg_vrsta" VALUES
  -- kod      opis                                 ulaz   zalihe  KIF   ekran      grupa          numeracija  zalihe-provera  RN
  ('IFR',   'Izlazna faktura — roba (izdatnica)',  FALSE, TRUE,   TRUE, 'GOODS',   'INVOICE_OUT', 'MAX',      'BLOCK',        FALSE),
  ('IFGP',  'Izlazna faktura — gotov proizvod',    FALSE, TRUE,   TRUE, 'GOODS',   'INVOICE_OUT', 'MAX',      'BLOCK',        FALSE),
  ('IZVRO', 'Izvozna faktura — roba',              FALSE, TRUE,   TRUE, 'GOODS',   'INVOICE_OUT', 'MAX',      'BLOCK',        FALSE),
  ('IZVGP', 'Izvozna faktura — gotov proizvod',    FALSE, TRUE,   TRUE, 'GOODS',   'INVOICE_OUT', 'MAX',      'BLOCK',        FALSE),
  ('IFUSL', 'Izlazna faktura — usluge',            FALSE, FALSE,  TRUE, 'SERVICE', 'INVOICE_OUT', 'MAX',      'OFF',          TRUE),
  ('IZVUS', 'Izvozna faktura — usluge',            FALSE, FALSE,  TRUE, 'SERVICE', 'INVOICE_OUT', 'MAX',      'OFF',          FALSE),
  ('PON',   'Ponuda',                              FALSE, FALSE, FALSE, 'GOODS',   'OFFER',       'SEQ',      'OFF',          FALSE),
  ('PROF',  'Predračun (profaktura)',              FALSE, FALSE, FALSE, 'GOODS',   'OFFER',       'SEQ',      'OFF',          FALSE),
  ('AVR',   'Avansni račun',                       FALSE, FALSE,  TRUE, 'SERVICE', 'ADVANCE',     'SEQ',      'OFF',          FALSE),
  -- REV (revers) i UFROB (ulaz robe) plan ne raspoređuje po grupama numeracije —
  -- dobijaju SAMO profil ekrana iz §2.1 (oba su P1 ROBNI), grupa ostaje NULL.
  ('REV',   'Revers',                              FALSE, TRUE,  FALSE, 'GOODS',   NULL,          NULL,       NULL,           FALSE);

INSERT INTO "document_types" (
  "code", "description", "is_inbound", "affects_stock", "post_in_vat_ledger",
  "screen_kind", "numbering_group", "numbering_mode", "stock_check", "requires_work_order"
)
SELECT r."code", r."description", r."is_inbound", r."affects_stock", r."post_in_vat_ledger",
       r."screen_kind", r."numbering_group", r."numbering_mode", r."stock_check", r."requires_work_order"
  FROM "_reg_vrsta" r
 WHERE NOT EXISTS (SELECT 1 FROM "document_types" d WHERE d."code" = r."code");

UPDATE "document_types" d
   SET "screen_kind"         = COALESCE(d."screen_kind", r."screen_kind"),
       "numbering_group"     = COALESCE(d."numbering_group", r."numbering_group"),
       "numbering_mode"      = COALESCE(d."numbering_mode", r."numbering_mode"),
       "stock_check"         = COALESCE(d."stock_check", r."stock_check"),
       "requires_work_order" = d."requires_work_order" OR r."requires_work_order"
  FROM "_reg_vrsta" r
 WHERE d."code" = r."code";

-- UFROB već postoji kao robni ulaz (šema kontiranja 3) — dopunjuje mu se samo
-- profil ekrana, ništa drugo. Grupa numeracije nabavne strane nije predmet ovog
-- plana (§5.1 pominje PURCHASE, ali bez rasporeda vrsta).
UPDATE "document_types"
   SET "screen_kind" = 'GOODS'
 WHERE "code" = 'UFROB'
   AND "screen_kind" IS NULL;

DROP TABLE "_reg_vrsta";
