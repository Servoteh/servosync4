-- DATUM PROMETA — razrešenje dvoznačnosti imena `delivery_date` (02.08.2026).
-- Povod: backend/docs/FAKTURE_ZAKONSKA_USKLADJENOST.md, nalaz N1 / mera M1.
--
-- ZATEČENO STANJE: ime `delivery_date` je u bazi značilo DVE različite stvari:
--   • invoices.delivery_date              = „datum prometa dobara i usluga"
--       (obavezan element računa po Zakonu o PDV; čita ga štampa, treba ga i SEF
--        kao cac:Delivery/cbc:ActualDeliveryDate),
--   • sef_incoming_invoices.delivery_date = „datum PRIJEMA fakture na SEF"
--       (osnov zakonskog roka od 15 dana; suprotan pojam — nema veze sa prometom).
-- Isto ime za dva pojma je već jednom proizvelo pogrešan rok na ulaznim fakturama
-- (v. komentar o izboru osnova roka u sef-incoming.service.ts), a na izlaznim bi
-- otvorilo mogućnost da neko „popuni datum prometa" pogrešnim podatkom.
--
-- PRESUDA (dopunjena 02.08.2026. pri spajanju sa `main`):
--   • datum prometa se zove `invoices.supply_date` — kolona koju je uvela migracija
--     20260727140000 i koja je već vezana end-to-end (SefService → UBL buildDelivery).
--     Kolona `invoices.delivery_date`, koju je grana za štampu dodala paralelno za
--     ISTI podatak, uklanja se: dve kolone za jedan obavezan element računa znače da
--     polovina koda čita praznu.
--   • ulazni SEF dobija SVOJE ime: sef_incoming_invoices.sef_received_at.
-- Alternativa (da ulazni zadrži ime `delivery_date`) je odbačena: to ime ne opisuje
-- „prijem na SEF" ni na jednom jeziku.
--
-- BEZBEDNOST: preimenovanje čuva podatke; brisanje `invoices.delivery_date` ide samo
-- ako je kolona PRAZNA (DO-blok proverava). Produkcijska tabela `invoices` je prazna,
-- a kolona je i tamo gde je stigla bila bez ijedne vrednosti.

-- ── 1) sef_incoming_invoices: delivery_date → sef_received_at ────────────────
-- PostgreSQL nema `RENAME COLUMN IF EXISTS`, pa ide DO-blok (migracija mora da može
-- da se primeni i na bazu koja je već preimenovana, i na svežu bazu).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'sef_incoming_invoices' AND column_name = 'delivery_date'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'sef_incoming_invoices' AND column_name = 'sef_received_at'
  ) THEN
    ALTER TABLE "sef_incoming_invoices"
      RENAME COLUMN "delivery_date" TO "sef_received_at";
  END IF;
END
$$;

-- Svež/prazan slog (tabela nastala bez ijedne od dve kolone) — dopuni.
ALTER TABLE "sef_incoming_invoices"
  ADD COLUMN IF NOT EXISTS "sef_received_at" TIMESTAMPTZ(6);

-- ── 2) invoices: ukloni dvojnika datuma prometa (`delivery_date`) ────────────
-- Kolonu je 01.08.2026. dodala migracija 20260801100000 za podatak koji već ima svoju
-- kolonu `supply_date`. Briše se SAMO ako je prazna — ako se ikad nađe baza u kojoj
-- je neko u nju upisao datum, migracija je NE dira, nego pusti da se to reši ručno
-- (bolje zaostala kolona nego tiho izgubljen poreski podatak).
-- ⚠️ DVE UGNJEŽDENE PROVERE, NE JEDAN `AND` — inače migracija OBORI DEPLOY.
-- PL/pgSQL ceo uslov `IF` sprema kao JEDAN upit, pre nego što ijedan njegov deo
-- izvrši: nema kratkog spoja kao u aplikativnim jezicima. Zato bi `... AND NOT
-- EXISTS (SELECT 1 FROM "invoices" WHERE "delivery_date" IS NOT NULL)` puklo sa
-- `42703 column "delivery_date" does not exist` na SVAKOJ bazi koja tu kolonu nema
-- — a produkcija je nema (kolonu je dodavala grana 20260801100000, koja je pri
-- spajanju prestala to da radi). Izmereno 03.08.2026. nad produkcijskom šemom.
--
-- Cena greške je bila daleko veća od ove migracije: `deploy-backend.yml` vrti
-- `prisma migrate deploy` pod `set -euo pipefail` PRE dizanja backenda, pa bi pao
-- svaki backend deploy — i za module koji sa fakturama nemaju veze — dok se ovo
-- ručno ne raspetlja (`resolve --rolled-back` NE pomaže; greška se ponavlja).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'invoices' AND column_name = 'delivery_date'
  ) THEN
    -- Tek sada sme da se pomene sama kolona: postojanje je već dokazano.
    IF NOT EXISTS (SELECT 1 FROM "invoices" WHERE "delivery_date" IS NOT NULL) THEN
      ALTER TABLE "invoices" DROP COLUMN "delivery_date";
    ELSE
      RAISE NOTICE 'invoices.delivery_date nije prazna — kolona OSTAJE, reši ručno (v. zaglavlje migracije).';
    END IF;
  END IF;
END
$$;

-- ── 3) Zakucaj značenje u SAMU bazu (COMMENT ON COLUMN) ──────────────────────
-- Komentar u kodu vidi samo ko čita kod; ovaj vidi i onaj ko gleda bazu alatom.
-- Cilj: sledeći put kad neko traži „gde je datum prometa", nađe jedno mesto.
COMMENT ON COLUMN "invoices"."supply_date" IS
  'Datum prometa dobara i usluga (obavezan element računa, Zakon o PDV). Štampa se na obrascima, ide u UBL cac:Delivery/cbc:ActualDeliveryDate. NIJE datum otpreme, prijema ni dospeća.';

COMMENT ON COLUMN "sef_incoming_invoices"."sef_received_at" IS
  'Datum prijema ULAZNE fakture na SEF — osnov zakonskog roka od 15 dana (accept_deadline). NIJE datum prometa; datum prometa ulazne fakture stoji u raw_xml (cbc:ActualDeliveryDate) i nema svoju kolonu.';
