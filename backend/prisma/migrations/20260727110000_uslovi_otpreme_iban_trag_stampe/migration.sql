-- =============================================================================
-- GRUPA B — POLJA KOJA OBRASCI DANAS ŠTAMPAJU PRAZNA (27.07.2026)
-- =============================================================================
-- Tri celine, sve ADITIVNO i IDEMPOTENTNO (IF NOT EXISTS svuda), sve nove kolone
-- NULLABLE bez default-a, da nijedan postojeći red ne padne i da se ništa ne izmisli:
--
--   A) `stock_documents` — uslovi otpreme. Otpremnica je do danas štampala ČETIRI
--      TVRDE KONSTANTE kao da su podaci ("Roba je FCO: magacin isporučioca",
--      "Način otpreme: sopstveni prevoz", "Mesto prometa: magacin", "Datum otpreme"
--      = datum dokumenta). To je prateća isprava uz robu — papir je tvrdio činjenice
--      koje niko nije uneo. Kolone su nullable i BEZ default-a namerno: prazno polje
--      mora ostati prazna linija za ručni upis, nikad pretpostavka.
--      Uz njih ide i `note`, koju je FE tip `StockDocument` deklarisao od ranije a
--      kolone nije bilo (mrtvo polje, uvek undefined).
--
--   B) `companies` — `iban` / `swift`. `invoice-pdf.service.ts` ih ČITA
--      (IssuerInfo.iban/swift, ino faktura), a kolona nije postojala → izvozni račun
--      je izlazio bez podataka za plaćanje. Dužine su tačne granice standarda:
--      IBAN 34 (ISO 13616; srpski je 22), BIC 8 ili 11 (ISO 9362).
--      NAPOMENA ZA KASNIJE: ovo je ispravno DOK firma ima jedan račun. Kad zatreba
--      više računa, ova tri podatka (bank_account/iban/swift) sele se u zasebnu
--      `company_bank_accounts` — zato ovde NEMA `intermediary_bank`, da se ne gradi
--      polovina te tabele unapred.
--
--   C) `document_prints` — NOVA tabela, trag štampe. Do sada je trag postojao samo
--      kao tekst u nozi papira i nigde se nije pamtio. Sada svaka štampa upisuje red,
--      pa PONOVLJENA štampa nosi žig "KOPIJA" i broj primerka. BigBit ovo nema.
--
-- IDEMPOTENCIJA: ADD COLUMN IF NOT EXISTS / CREATE TABLE IF NOT EXISTS /
-- CREATE INDEX IF NOT EXISTS — migracija sme da se pusti dva puta bez greške.
-- =============================================================================

-- ─── A) stock_documents: uslovi otpreme + napomena ───────────────────────────

ALTER TABLE stock_documents ADD COLUMN IF NOT EXISTS fco                VARCHAR(100);
ALTER TABLE stock_documents ADD COLUMN IF NOT EXISTS shipping_method    VARCHAR(50);
ALTER TABLE stock_documents ADD COLUMN IF NOT EXISTS shipping_date      TIMESTAMPTZ(6);
ALTER TABLE stock_documents ADD COLUMN IF NOT EXISTS delivery_place     VARCHAR(150);
ALTER TABLE stock_documents ADD COLUMN IF NOT EXISTS route              VARCHAR(100);
ALTER TABLE stock_documents ADD COLUMN IF NOT EXISTS customer_order_ref VARCHAR(100);
ALTER TABLE stock_documents ADD COLUMN IF NOT EXISTS note               TEXT;

COMMENT ON COLUMN stock_documents.fco IS
  'Paritet isporuke (FCO magacin isporucioca / FCO kupac / Incoterms). NULL = prazna linija za rucni upis — nikad podrazumevana vrednost.';
COMMENT ON COLUMN stock_documents.shipping_method IS
  'Nacin otpreme (sopstveni prevoz / kurir / dobavljac / preuzimanje). NULL = prazna linija.';
COMMENT ON COLUMN stock_documents.shipping_date IS
  'Datum otpreme. NIKAD ne default-ovati na document_date — otprema ume da bude dan-dva kasnije.';
COMMENT ON COLUMN stock_documents.delivery_place IS
  'Mesto isporuke / mesto prometa. NULL = prazna linija.';
COMMENT ON COLUMN stock_documents.route IS
  'Ruta (relacija prevoza) na otpremnici.';
COMMENT ON COLUMN stock_documents.customer_order_ref IS
  'BigBit „Po porudzbini od" — broj i datum kupceve porudzbine. Tekst, ne FK: kupcev broj je njegov, ne nas.';
COMMENT ON COLUMN stock_documents.note IS
  'Napomena na dokumentu (slobodan tekst). FE tip StockDocument ju je deklarisao pre nego sto je kolona postojala.';

-- ─── B) companies: IBAN / SWIFT (ino faktura) ────────────────────────────────

ALTER TABLE companies ADD COLUMN IF NOT EXISTS iban  VARCHAR(34);
ALTER TABLE companies ADD COLUMN IF NOT EXISTS swift VARCHAR(11);

COMMENT ON COLUMN companies.iban IS
  'IBAN za ino placanje, bez razmaka. 34 = ISO 13616 maksimum (RS IBAN je 22). Cita ga invoice-pdf (ino faktura) i UBL.';
COMMENT ON COLUMN companies.swift IS
  'SWIFT/BIC, 8 ili 11 znakova (ISO 9362) — VarChar(11) je tacna granica standarda.';

-- ─── C) document_prints: trag štampe + brojač primeraka ──────────────────────

CREATE TABLE IF NOT EXISTS document_prints (
  id                 SERIAL       NOT NULL,
  document_kind      VARCHAR(30)  NOT NULL,
  document_id        INTEGER      NOT NULL,
  variant            VARCHAR(30)  NOT NULL DEFAULT '',
  copy_no            INTEGER      NOT NULL,
  printed_by_user_id INTEGER,
  printed_by_name    VARCHAR(100),
  printed_at         TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  company_id         INTEGER      NOT NULL DEFAULT 0,
  CONSTRAINT pk_document_prints PRIMARY KEY (id)
);

-- Kljuc primerka. `variant` je NOT NULL sa default '' NAMERNO: u Postgresu su NULL-ovi
-- u UNIQUE indeksu medjusobno RAZLICITI, pa bi nullable kolona propustila duplikate
-- copy_no za isti obrazac i znacka „KOPIJA" se ne bi nikad pojavila.
CREATE UNIQUE INDEX IF NOT EXISTS uq_document_prints_copy
  ON document_prints (document_kind, document_id, variant, copy_no);

-- „Koliko puta je stampan dokument N" — poziv sa SVAKE stampe, mora biti indeksiran.
CREATE INDEX IF NOT EXISTS idx_document_prints_document
  ON document_prints (document_kind, document_id);

-- Pretraga i eventualna retencija po datumu („ko je juce stampao", brisanje starijeg od N godina).
CREATE INDEX IF NOT EXISTS idx_document_prints_at
  ON document_prints (printed_at);

COMMENT ON TABLE document_prints IS
  'Trag stampe: jedan red = jedno izvadjenje jednog obrasca jednog dokumenta. copy_no=1 original, >=2 nosi zig KOPIJA. '
  'RETENCIJA: ne brisati nista — tabela je dokazni trag (~120 B po redu, ~10-20 MB godisnje). Ako ikad zatreba, '
  'arhivirati SAMO po starosti (printed_at), NIKAD po dokumentu: brisanje redova jednog dokumenta obara MAX(copy_no) '
  'i sledeca stampa bi se lazno predstavila kao original.';
COMMENT ON COLUMN document_prints.printed_by_name IS
  'Snimak imena u trenutku stampe — users je sync-kes, ime se sme promeniti, papir ne sme.';
