-- ŠIFARNIK VRSTA USLUGE — KONTO PRIHODA I PORESKI TRETMAN IDU ZAJEDNO (05.08.2026).
-- Povod i merenja: backend/docs/USLUGE_KONTA_PREDLOG.md; potvrdili vlasnik i knjigovođa
-- 05.08.2026 („6501 zakup, ali to može posle da se promeni, sve ostalo ok").
--
-- ZATEČENO STANJE: konto prihoda uslužnog računa je bio KONSTANTA `6140`
-- (`sales/fakturisanje.service.ts`, `usluga ? 6140 : 6040`). Izmereno nad uvezenom
-- glavnom knjigom 2026 (potražna strana, `ledger_entries`):
--
--     6140  Prihodi od prodaje usluga na domaćem tržištu      45 stavki  18.273.557,50
--     6151  Prihodi od prodaje usluga na inostranom tržištu    2 stavke   2.490.465,79
--     6796  Naknadno utvrđeni vanr. prih. OTPAD čl.10/2/1     10 stavki   1.222.645,05
--     6501  Prihodi od zakupa poslovnog prostora               0 stavki           —
--
-- Dakle konstanta je bila tačna za 45 od 57 stavki, a za preostalih 12 je promet išao na
-- tuđe konto. Sva četiri konta postoje u kontnom planu (`accounts`, izmereno 05.08.2026).
-- Zakup u 2026. nema prometa, ali doneti papir `IFUSL 653/25` glasi „Zakup poslovnog
-- prostora za Decembar 2025" — vrsta postoji, samo je iz godine koja nije uvezena.
--
-- ⚠️ ZAŠTO ŠIFARNIK, A NE SLOBODAN IZBOR KONTA: uz konto ide i PORESKI TRETMAN. Kod
-- otpada PDV ne obračunavamo mi nego ga obračunava KUPAC (poreski dužnik je primalac,
-- čl. 10 st. 2 t. 1 ZPDV). Izmereno nad svih 10 dokumenata sa kontom 6796: kupčev DUG
-- (2040) je TAČNO jednak prihodu (6796), a nijedan od njih nema nijedan red na kontima
-- izlaznog PDV-a (`47xx`) — npr. `042/26`: 2040 DUG 123.552,00 / 6796 POT 123.552,00.
-- Kad bi se birao samo konto, neko bi pre ili kasnije izabrao 6796 a sistem bi svejedno
-- obračunao PDV — i faktura bi izašla sa porezom koji po zakonu obračunava kupac.
-- Vezivanjem konta i tretmana u JEDAN izbor ta greška postaje nemoguća, a komercijala
-- bira ŠTA PRODAJE umesto da zna ijedan konto.

-- ─────────────────────────────────────────────────────────────────────────────
-- ⚠️ BEZ IJEDNOG PL/pgSQL BLOKA I BEZ `IF EXISTS (...) AND <upit nad samom tabelom>`.
-- Takav uslov je 02.08.2026. (`20260802120000_datum_prometa_znacenje`) oborio SVE
-- backend deploy-e sa `42703`: PL/pgSQL ceo `IF` sprema kao JEDAN upit, pa nema kratkog
-- spoja i grana koja se „neće izvršiti" svejedno mora da se isplanira. Ovde se
-- idempotentnost dobija isključivo iz samog SQL-a:
--   • `CREATE TABLE IF NOT EXISTS` — CHECK je UNUTAR njega, pa se ni on ne dodaje dvaput
--     (`ADD CONSTRAINT` u PostgreSQL-u nema `IF NOT EXISTS`);
--   • `CREATE UNIQUE INDEX IF NOT EXISTS` pre `INSERT`-a, da `ON CONFLICT` ima na šta;
--   • `INSERT … ON CONFLICT DO NOTHING` — drugi prolaz ne dira ništa, a ne prepisuje ni
--     ono što je knjigovođa u međuvremenu izmenio (šifarnik je NJEGOV, v. odeljak 2);
--   • `ADD COLUMN IF NOT EXISTS`;
--   • `DROP CONSTRAINT IF EXISTS` + `ADD CONSTRAINT` — jedini idempotentan način da se
--     strani ključ postavi čistim SQL-om.
-- Svaka naredba je zasebna i izvršava se tek kad je prethodna gotova, pa nijedna ne
-- planira upit nad objektom koji još ne postoji.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "service_revenue_types" (
  "id"                   SERIAL         NOT NULL,
  -- Šifra koju vidi i knjigovođa i komercijala (USL, USL-INO, OTPAD, ZAKUP).
  "code"                 VARCHAR(20)    NOT NULL,
  -- Naziv koji komercijala bira sa padajuće liste — namerno bez ijednog konta u tekstu.
  "name"                 VARCHAR(100)   NOT NULL,
  -- Meki ref `accounts.code`: konto prihoda na koji ide osnovica ovog prometa.
  -- NIJE strani ključ, jer kontni plan sme da se pregrupiše, a šifarnik mora da
  -- preživi i red koji je knjigovođa privremeno uneo pre nego što otvori konto.
  "revenue_account_code" VARCHAR(10)    NOT NULL,
  -- KO OBRAČUNAVA PDV (v. `sales/service-revenue-type.ts`):
  --   TAXED          mi, po stopi stavke (USL 6140, ZAKUP 6501 → konto PDV-a 4703)
  --   REVERSE_CHARGE KUPAC — poreski dužnik je primalac, čl. 10 st. 2 t. 1 (OTPAD 6796)
  --   OUTSIDE_SCOPE  niko — mesto prometa je van RS, čl. 12 st. 3 (USL-INO 6151)
  -- Poslednja dva NISU izvoz: promet je domaći odn. van teritorije, ali u oba slučaja mi
  -- porez ne obračunavamo, pa je iznos za uplatu jednak osnovici.
  "vat_treatment"        VARCHAR(20)    NOT NULL,
  -- Napomena koja MORA da izađe na papiru (poreski dokument). NULL = nema napomene.
  "paper_note"           TEXT,
  "is_active"            BOOLEAN        NOT NULL DEFAULT true,
  "sort_order"           INTEGER        NOT NULL DEFAULT 0,
  "created_at"           TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at"           TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "pk_service_revenue_types" PRIMARY KEY ("id"),
  -- Spisak tretmana je ZATVOREN u bazi, ne samo u kodu: red sa nepoznatim tretmanom bi
  -- prošao kao „TAXED" i tiho obračunao PDV na prometu na kom ga ne sme biti.
  CONSTRAINT "chk_service_revenue_types_vat_treatment"
    CHECK ("vat_treatment" IN ('TAXED', 'REVERSE_CHARGE', 'OUTSIDE_SCOPE'))
);

CREATE UNIQUE INDEX IF NOT EXISTS "uq_service_revenue_types_code"
  ON "service_revenue_types" ("code");

-- ── SEED: četiri potvrđene vrste ────────────────────────────────────────────
-- `ON CONFLICT DO NOTHING`, a ne `DO UPDATE`: šifarnik uređuje knjigovođa, pa ponovno
-- puštanje migracije ne sme da mu vrati našu vrednost. Vlasnik je uz 6501 izričito
-- rekao „to može posle da se promeni" — promena se radi u šifarniku, ne u kodu.
--
-- Tekstovi napomena su prepisani DOSLOVNO iz potvrde od 05.08.2026. Oni su jedini izvor
-- za papir; `sales/vat-exemption.ts` drži samo rezervni tekst za slučaj da knjigovođa
-- napomenu obriše (v. tamo, „REZERVA, NE DRUGI PRIMERAK").
INSERT INTO "service_revenue_types"
  ("code", "name", "revenue_account_code", "vat_treatment", "paper_note", "sort_order")
VALUES
  ('USL',     'Usluga (domaće tržište)',   '6140', 'TAXED',          NULL, 10),
  ('USL-INO', 'Usluga stranom kupcu',      '6151', 'OUTSIDE_SCOPE',
   'PDV nije obračunat u skladu sa članom 12. stav 3. Zakona o PDV-u (mesto prometa usluge je van teritorije Republike Srbije)', 20),
  ('OTPAD',   'Prodaja otpada',            '6796', 'REVERSE_CHARGE',
   'PDV nije obračunat — poreski dužnik je primalac dobara, član 10. stav 2. tačka 1. Zakona o PDV-u', 30),
  ('ZAKUP',   'Zakup poslovnog prostora',  '6501', 'TAXED',          NULL, 40)
ON CONFLICT ("code") DO NOTHING;

-- ── VEZA SA DOKUMENTOM: ZAGLAVLJE, NE STAVKA ────────────────────────────────
-- IZMERENO (glavna knjiga 2026, po `ledger_entries.document_number`): od 57 dokumenata
-- sa uslužnim prihodom njih **57 nosi TAČNO JEDNO** konto prihoda — nijedan ne meša dva.
-- Jedini nalog koji naizgled meša (`journal_entries.id = 236`) je ZBIRNI nalog koji drži
-- TRI zasebna dokumenta: `042/26` (otpad, 123.552,00 bez PDV-a), `043/26` i `044/26`
-- (usluga, 44.600,00 + 63.800,00 sa PDV-om na 4703). Dakle knjigovođa različite vrste
-- već danas razdvaja u ZASEBNE RAČUNE — mešovit dokument ne postoji.
--
-- Uz to, tretman je po prirodi svojstvo celog dokumenta, ne reda: napomena o poreskom
-- dužniku je JEDAN red u dnu obrasca, `buildSalesLedgerLines` piše JEDAN red prihoda
-- (`totals.netTotal`), a e-faktura grupiše porez po paru (kategorija, stopa) na nivou
-- dokumenta. Zato polje ide na `invoices`, tačno kao `is_export`, koji je isti oblik
-- odluke (ceo dokument ide ili ne ide sa PDV-om).
ALTER TABLE "invoices"
  ADD COLUMN IF NOT EXISTS "service_revenue_type_id" INTEGER;

CREATE INDEX IF NOT EXISTS "idx_invoices_service_revenue_type"
  ON "invoices" ("service_revenue_type_id");

-- Strani ključ SA `RESTRICT`: vrsta koja je upotrebljena na računu ne sme da se obriše,
-- jer bi računu nestao i konto i poreski osnov. Gašenje ide kroz `is_active = false`.
-- `DROP … IF EXISTS` pa `ADD` je jedini idempotentan oblik bez PL/pgSQL-a.
ALTER TABLE "invoices"
  DROP CONSTRAINT IF EXISTS "fk_invoices_service_revenue_types";

ALTER TABLE "invoices"
  ADD CONSTRAINT "fk_invoices_service_revenue_types"
  FOREIGN KEY ("service_revenue_type_id")
  REFERENCES "service_revenue_types" ("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
