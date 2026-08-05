-- ŠIFARNIK OSNOVA PORESKOG OSLOBOĐENJA — OSNOV SE BIRA, NE IZVODI (05.08.2026).
-- Povod: odgovori knjigovođe 8, 9 i 10 (`backend/docs/ODGOVORI_38_UTICAJ.md` §1.3).
--
-- 🔴 ZATEČENI ŽIV KVAR KOJI OVO ZATVARA: papir i e-faktura su za IZVOZ ROBE navodili
-- RAZLIČIT član. Papir je štampao „član 24. stav 1 tačka 2" (`sales/vat-exemption.ts`),
-- a SEF šifra i razlog `PDV-RS-24-1-5` / „Izvoz dobara (čl. 24 st. 1 tač. 5)" — i u istom
-- fajlu i ukucano u `sef/ubl-builder.service.ts`. Dva pravna osnova za isti posao istom
-- kupcu, na dva dokumenta koja su oba original. Knjigovođa je presudio: izvoz je 24.1.2,
-- a 24.1.5 pripada slobodnoj zoni — dakle papir je bio tačan, a SEF šifra pogrešna.
--
-- ── ZAŠTO ŠIFARNIK, A NE POPRAVKA JEDNE ŠIFRE ───────────────────────────────
-- `vat-exemption.ts` je osnov IZVODIO iz dokumenta, uz komentar da „namerno ne gleda
-- documentType nego suštinu". To više ne radi: po odgovorima ista situacija „izvoz robe"
-- daje TRI osnova, a sva tri na dokumentu izgledaju identično (`is_export = true`, PDV 0,
-- ista vrsta dokumenta):
--
--     24.1.2   redovan izvoz dobara               → NE ide na SEF
--     24.1.5   unos dobara u slobodnu zonu        → IDE na SEF
--     24.1.7   oplemenjivanje (povraćaj ino primaocu)
--
-- Koji je od tri, zna samo onaj ko dokument pravi. Zato se bira, i zato osnov nosi i
-- kapiju „ide / ne ide na SEF": odgovor 8 uz osnov vezuje i TOK, i to dva SUPROTNA toka
-- za dva osnova koja se ničim drugim ne razlikuju. Do danas je o tome odlučivala samo
-- zastavica `is_export` (`sef/sef.service.ts` je odbijao SVAKI izvoz), pa se faktura za
-- slobodnu zonu — koja MORA na SEF — nije mogla poslati.
--
-- ── IZMERENO NA PRODUKCIJI 05.08.2026 (samo čitanje) ────────────────────────
-- `invoices = 0`, `invoice_items = 0` → nijedan zatečen papir se ne menja, cena promene
-- je najniža koja će ikad biti. `document_types` ima 15 vrsta i kolona
-- `default_vat_exemption_code` je prazna kod SVIH 15, a nijedan kod je ne čita (v. dole).

-- ─────────────────────────────────────────────────────────────────────────────
-- ⚠️ BEZ IJEDNOG PL/pgSQL BLOKA I BEZ `IF EXISTS (...) AND <upit nad samom tabelom>`.
-- Takav uslov je 02.08.2026. (`20260802120000_datum_prometa_znacenje`) oborio SVE backend
-- deploy-e sa `42703`: PL/pgSQL ceo `IF` sprema kao JEDAN upit, pa nema kratkog spoja i
-- grana koja se „neće izvršiti" svejedno mora da se isplanira. Idempotentnost ovde dolazi
-- isključivo iz samog SQL-a — `CREATE TABLE IF NOT EXISTS` (sa CHECK-om UNUTRA, jer
-- `ADD CONSTRAINT` nema `IF NOT EXISTS`), `CREATE UNIQUE INDEX IF NOT EXISTS` pre
-- `INSERT`-a da `ON CONFLICT` ima na šta, `INSERT … ON CONFLICT DO NOTHING`,
-- `ADD COLUMN IF NOT EXISTS`, i `DROP CONSTRAINT IF EXISTS` + `ADD CONSTRAINT`.
-- Uzor: `20260803090000_companies_postal_code` i `20260805190000_sifarnik_vrsta_usluge`.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "vat_exemption_bases" (
  "id"          SERIAL         NOT NULL,
  -- Šifra koju vidi i knjigovođa i komercijala (IZVOZ-DOBARA, SLOBODNA-ZONA…).
  "code"        VARCHAR(30)    NOT NULL,
  -- Naziv sa padajuće liste — kratak opis SITUACIJE, ne prepis člana.
  "name"        VARCHAR(150)   NOT NULL,
  -- DOSLOVAN tekst koji izlazi na papir. Jedini izvor za štampu; `vat-exemption.ts`
  -- drži samo rezervu za dokument koji osnov nema.
  "paper_text"  TEXT           NOT NULL,
  -- Šifra razloga za SEF (EN16931 BT-121), oblik `PDV-RS-24-1-2`. NULL je dozvoljen i
  -- znači „za ovaj osnov šifra nije utvrđena" — čl. 12 st. 3 nije oslobođenje po čl. 24
  -- nego promet van polja primene, pa u UBL ide samo tekst razloga (BT-120), što
  -- EN16931 dozvoljava (BR-E-10 traži tekst ILI šifru).
  "sef_code"    VARCHAR(30),
  -- Tekst razloga za SEF (BT-120). NOT NULL: bez razloga SEF odbija svaku kategoriju
  -- bez poreza, pa red bez njega ne bi mogao da se upotrebi.
  "sef_reason"  TEXT           NOT NULL,
  -- 🔴 IDE LI DOKUMENT SA OVIM OSNOVOM NA SEF (odgovor 8). Nije izvedeno iz `is_export`:
  -- izvoz (24.1.2) i slobodna zona (24.1.5) su oba `is_export`, a idu suprotno.
  "goes_to_sef" BOOLEAN        NOT NULL,
  "is_active"   BOOLEAN        NOT NULL DEFAULT true,
  "sort_order"  INTEGER        NOT NULL DEFAULT 0,
  "created_at"  TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at"  TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "pk_vat_exemption_bases" PRIMARY KEY ("id"),
  -- Prazan tekst je isto što i nedostajući: papir bi odštampao prazan red na poreskom
  -- dokumentu, a SEF bi odbio razlog bez sadržaja. Zatvara se u bazi, ne samo u DTO-u.
  CONSTRAINT "chk_vat_exemption_bases_paper_text" CHECK (btrim("paper_text") <> ''),
  CONSTRAINT "chk_vat_exemption_bases_sef_reason" CHECK (btrim("sef_reason") <> '')
);

CREATE UNIQUE INDEX IF NOT EXISTS "uq_vat_exemption_bases_code"
  ON "vat_exemption_bases" ("code");

-- ── SEED: šest osnova iz odgovora 8, 9 i 10 ─────────────────────────────────
-- `ON CONFLICT DO NOTHING`, a ne `DO UPDATE`: šifarnik uređuje knjigovođa, pa ponovno
-- puštanje migracije ne sme da mu vrati našu vrednost.
--
-- ⚠️ TEKSTOVI ZA PAPIR SU PREPISANI DOSLOVNO IZ ODGOVORA, uključujući i ono što izgleda
-- kao omaška. Odgovor 10 glasi „…člana 24 stav 1 tačka 5 o PDV-u" (bez reči „Zakona"),
-- i tako je i upisano — mi ne ispravljamo pravnu formulaciju knjigovođe, on je ispravlja
-- u šifarniku. 🔴 Zapisano kao pitanje za potvrdu, v. `docs/ODGOVORI_38_UTICAJ.md`.
--
-- ⚠️ 24.1.5 SE POJAVLJUJE U DVA REDA (slobodna zona i domaći oslobođen promet) — tako je
-- po odgovorima 8 i 10 i redovi se NAMERNO ne spajaju. Nisu isti: razlikuju se i po
-- tekstu za papir i po tome što je jedan izvozni a drugi domaći promet. 🔴 Da li je za
-- domaći promet zaista mišljena tačka 5, ostaje pitanje za knjigovođu (v. izveštaj).
INSERT INTO "vat_exemption_bases"
  ("code", "name", "paper_text", "sef_code", "sef_reason", "goes_to_sef", "sort_order")
VALUES
  -- Odgovor 8: „Za izvoz robe koristimo član 24.1.2. Takva faktura ne ide na sef."
  ('IZVOZ-DOBARA', 'Izvoz dobara (čl. 24 st. 1 t. 2)',
   'Napomena o poreskom oslobodjenju: Oslobodjeno PDV na osnovu člana 24. stav 1 tačka 2 Zakona o PDV.',
   'PDV-RS-24-1-2', 'Izvoz dobara (čl. 24 st. 1 tač. 2 ZPDV)', false, 10),

  -- Odgovor 8: „Član 24.1.5 je vezan za robu koja se izdaje kod unosa dobara u slobodnu
  -- zonu. Takva faktura se šalje na SEF, i ručno unosimo poreska oslobođenja."
  ('SLOBODNA-ZONA', 'Unos dobara u slobodnu zonu (čl. 24 st. 1 t. 5)',
   'Napomena o poreskom oslobodjenju: Oslobodjeno PDV na osnovu člana 24. stav 1 tačka 5 Zakona o PDV.',
   'PDV-RS-24-1-5', 'Unos dobara u slobodnu zonu (čl. 24 st. 1 tač. 5 ZPDV)', true, 20),

  -- Odgovor 9: „Za ino fakture koristimo oslobođenje 24.1.7 — za robu koja je nabavljena
  -- od strane ino primaoca a kasnije se njemu i vraća (oplemenjivanje)."
  -- 🔴 Doslovan tekst za PAPIR nije dat; sastavljen je po obrascu potvrđenog 24.1.2 reda
  -- (ista rečenica, promenjena tačka) da papir ne bi ostao prazan. ČEKA POTVRDU.
  -- `goes_to_sef = false` je IZVEDENO, ne rečeno: primalac je ino lice, a SEF je domaći
  -- registar — isti razlog iz kog na SEF ne ide ni izvoz 24.1.2. ČEKA POTVRDU.
  ('OPLEMENJIVANJE', 'Oplemenjivanje — povraćaj robe ino primaocu (čl. 24 st. 1 t. 7)',
   'Napomena o poreskom oslobodjenju: Oslobodjeno PDV na osnovu člana 24. stav 1 tačka 7 Zakona o PDV.',
   'PDV-RS-24-1-7', 'Oplemenjivanje dobara (čl. 24 st. 1 tač. 7 ZPDV)', false, 30),

  -- Odgovor 10 (domaći promet bez PDV-a), DOSLOVNO — v. napomenu o „o PDV-u" iznad.
  ('DOMACI-OSLOBODJEN', 'Domaći oslobođen promet (čl. 24 st. 1 t. 5)',
   'Napomena o poreskom oslobođenju: Oslobođeno PDV-a na osnovu člana 24 stav 1 tačka 5 o PDV-u',
   'PDV-RS-24-1-5', 'Oslobođen promet (čl. 24 st. 1 tač. 5 ZPDV)', true, 40),

  -- Odgovor 9, prva varijanta — usluga izvršena u INOSTRANSTVU (doslovan tekst).
  -- `sef_code` NULL: čl. 12 st. 3 nije oslobođenje po čl. 24 nego promet čije mesto nije
  -- u RS, pa `PDV-RS` šifra za njega nije utvrđena. BT-120 tekst je dovoljan.
  ('USLUGA-VAN-RS', 'Usluga izvršena u inostranstvu (čl. 12 st. 3)',
   'PDV nije obračunat u skladu sa članom 12. stav 3. Zakona o PDV-u (mesto prometa usluge je van teritorije Republike Srbije)',
   NULL, 'Mesto prometa usluge je van teritorije RS (čl. 12 st. 3 ZPDV)', false, 50),

  -- Odgovor 9, druga varijanta — usluga u RS za stranog poreskog obveznika: „samo se tada
  -- ne navodi VAN TERITORIJE REPUBLIKE SRBIJE". Zato ISTA rečenica bez te zagrade.
  ('USLUGA-STRANO-LICE', 'Usluga u RS za stranog poreskog obveznika (čl. 12 st. 3)',
   'PDV nije obračunat u skladu sa članom 12. stav 3. Zakona o PDV-u',
   NULL, 'Mesto prometa usluge se određuje po čl. 12 st. 3 ZPDV', false, 60)
ON CONFLICT ("code") DO NOTHING;

-- ── VEZA SA DOKUMENTOM: ZAGLAVLJE, NE STAVKA ────────────────────────────────
-- IZMERENO 05.08.2026. nad uvezenom glavnom knjigom 2026 (`ledger_entries` ×
-- `journal_entries`, vrste IFR/IFGP/IFUSL/IZVUS): **254 izlazna dokumenta, od toga 13 bez
-- ijednog reda na kontima izlaznog PDV-a (47xx) — dakle oslobođena u CELINI — i 241 sa
-- PDV-om. Nijedan od 254 ne meša oslobođen i oporezovan deo, i nijedan ne nosi više od
-- JEDNOG konta prihoda.** Trinaest oslobođenih: 10 × otpad (6796), 2 × usluga stranom
-- kupcu (6151), 1 bez konta prihoda.
--
-- Uz to, izvozna robna dokumenta iz BigBit izvoza (26 komada, 2017–2024) nose 12–18
-- stavki po dokumentu, a njihova tabela stavki (`bb_mdb_stage_robne_stavke`, 13 kolona)
-- NEMA NIJEDNU poresku kolonu — dakle osnov po stavci nije postojao ni u izvornom
-- sistemu, ni kad je dokument imao 18 redova.
--
-- I po prirodi: napomena o oslobođenju je JEDAN red u dnu obrasca, carinska deklaracija
-- prati ceo dokument, a kapija „ide / ne ide na SEF" je odluka o CELOM dokumentu — pola
-- fakture se ne može poslati. Zato polje ide na `invoices`, isti oblik odluke kao
-- `is_export` i `service_revenue_type_id`.
ALTER TABLE "invoices"
  ADD COLUMN IF NOT EXISTS "vat_exemption_basis_id" INTEGER;

CREATE INDEX IF NOT EXISTS "idx_invoices_vat_exemption_basis"
  ON "invoices" ("vat_exemption_basis_id");

-- Strani ključ sa `RESTRICT`: osnov upotrebljen na računu ne sme da se obriše, jer bi
-- računu nestao i tekst na papiru i šifra na e-fakturi. Gašenje ide kroz `is_active`.
ALTER TABLE "invoices"
  DROP CONSTRAINT IF EXISTS "fk_invoices_vat_exemption_bases";

ALTER TABLE "invoices"
  ADD CONSTRAINT "fk_invoices_vat_exemption_bases"
  FOREIGN KEY ("vat_exemption_basis_id")
  REFERENCES "vat_exemption_bases" ("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── PODRAZUMEVANA VREDNOST ──────────────────────────────────────────────────
-- Kolona `document_types.default_vat_exemption_code` postoji od
-- `20260728150000_registar_vrsta_i_koeficijent_dokumenta`, PRAZNA je kod svih 15 vrsta i
-- do danas je nijedan kod nije čitao (izmereno 05.08.2026). Ovde dobija sadržaj i postaje
-- izvor predloga pri otvaranju dokumenta (`SalesService`), pa komercijala u redovnom toku
-- ne mora ništa da bira — bira samo kad je posao izuzetak (slobodna zona, oplemenjivanje).
--
-- Popunjavaju se SAMO tri izvozne vrste, jer je samo za njih oslobođenje pravilo:
--   IZVRO / IZVGP → redovan izvoz dobara (odgovor 8: „za izvoz robe koristimo 24.1.2")
--   IZVUS         → usluga izvršena u inostranstvu (odgovor 9: „pozivamo se na čl. 12 st. 3")
-- Domaće vrste (IFR/IFGP/IFUSL/AVR/PON/PROF/REV…) NAMERNO ostaju prazne: domaći promet je
-- po pravilu OPOREZIV, pa bi predlog oslobođenja bio poreska tvrdnja koju niko nije
-- izabrao. Ko izda domaći oslobođen račun, bira `DOMACI-OSLOBODJEN` svesno.
--
-- Idempotentno bez ijedne provere: `WHERE` gađa tačno tri šifre i upisuje istu vrednost,
-- pa drugi prolaz ne menja ništa. Uslov `coalesce(btrim(...), '') = ''` uz to ČUVA ono što
-- je knjigovođa u međuvremenu upisao — nikad ne prepisuje njegov izbor.
UPDATE "document_types"
   SET "default_vat_exemption_code" = 'IZVOZ-DOBARA'
 WHERE "code" IN ('IZVRO', 'IZVGP')
   AND coalesce(btrim("default_vat_exemption_code"), '') = '';

UPDATE "document_types"
   SET "default_vat_exemption_code" = 'USLUGA-VAN-RS'
 WHERE "code" = 'IZVUS'
   AND coalesce(btrim("default_vat_exemption_code"), '') = '';

-- ⚠️ ZATEČENI RAČUNI SE NAMERNO NE POPUNJAVAJU (nema `UPDATE invoices`). Upisati osnov na
-- dokument koji ga nije birao značilo bi dopisati pravnu tvrdnju u tuđe ime, na poreskom
-- dokumentu koji je već izdat. Njihov papir se ne menja: `resolveExemption` za dokument
-- bez osnova pada na zatečeno izvođenje, pa štampa isti tekst kao juče (osim SEF šifre za
-- izvoz robe, koja je bila pogrešna i ispravljena je na 24-1-2). Na produkciji je to
-- ionako prazan skup — `invoices = 0`.
