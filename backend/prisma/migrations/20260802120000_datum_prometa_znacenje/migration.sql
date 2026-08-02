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
-- PRESUDA: ime prati ZNAČENJE koje je već upisano u šemu i u zakon.
--   • `delivery_date` OSTAJE datum prometa (invoices) — tako ga zove i UBL
--     (ActualDeliveryDate), tako ga zovu doneti obrasci („Datum prometa dobara"),
--     i tako je opisan u šemi od kad je uveden.
--   • ulazni SEF dobija SVOJE ime: sef_incoming_invoices.sef_received_at.
-- Alternativa (da ulazni zadrži ime, a promet dobije novo) je odbačena: ime
-- `delivery_date` ne opisuje „prijem na SEF" ni na jednom jeziku.
--
-- ADITIVNO/BEZBEDNO: kolona se samo preimenuje, podaci ostaju (danas su svi NULL —
-- servis je upisivao NULL uz komentar da pravo SEF polje prijema još nemamo).
-- Ništa se ne briše i nijedan tip se ne menja.

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

-- ── 2) Zakucaj značenje u SAMU bazu (COMMENT ON COLUMN) ──────────────────────
-- Komentar u kodu vidi samo ko čita kod; ovaj vidi i onaj ko gleda bazu alatom.
-- Cilj: sledeći put kad neko traži „gde je datum prometa", nađe jedno mesto.
COMMENT ON COLUMN "invoices"."delivery_date" IS
  'Datum prometa dobara i usluga (obavezan element računa, Zakon o PDV). Štampa se na obrascima, ide u UBL cac:Delivery/cbc:ActualDeliveryDate. NIJE datum otpreme, prijema ni dospeća.';

COMMENT ON COLUMN "sef_incoming_invoices"."sef_received_at" IS
  'Datum prijema ULAZNE fakture na SEF — osnov zakonskog roka od 15 dana (accept_deadline). NIJE datum prometa; datum prometa ulazne fakture stoji u raw_xml (cbc:ActualDeliveryDate) i nema svoju kolonu.';
