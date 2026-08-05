-- ─────────────────────────────────────────────────────────────────────────────
-- MATIČNI PODACI FIRME (SERVOTEH) — memorandum, podnožje i potpisni blok fakture
-- Primenjeno na produkciju 03.08.2026.
-- ─────────────────────────────────────────────────────────────────────────────
--
-- POVOD: izmereno 03.08.2026. da je produkcijski zapis firme gotovo PRAZAN —
-- `company_name = 'SERVOTEH'`, a `address`, `city`, `bank_account`, `phone`, `fax`,
-- `email`, `web_address`, `registration_number`, `registry_number`,
-- `business_activity_code`, `tax_id`, `apr_text`, `iban`, `swift` svi `NULL`.
-- Posledica: svaka faktura odštampana sa produkcije izlazi BEZ adrese, BEZ PIB-a i
-- BEZ matičnog broja — u zaglavlju, u podnožju i u bloku „Preuzeo za prevoz" —
-- bez obzira koliko je kod tačan. Isto važi i za ino obrasce (blok banke).
--
-- IZVOR PODATAKA: doneti BigBit papiri (`docs/zahtevi/fakture-obrasci-2026-08/`),
-- odnosno memorandum i podnožje sa `IFR 657/25`, `IFUSL 653/25` i `InoFaktura GP 228-25`.
-- Ništa nije pretpostavljeno — svaki red se vidi na bar jednom od tih papira.
--
-- ⚠️ `city` NAMERNO nosi `'11272 Dobanovci'`, a ne goli grad:
--    migracija `20260803090000_companies_postal_code` (odluka O-F10) uvodi kolonu
--    `postal_code` i pri primeni prenosi baš oblik `^\d{5}\s+\S` — dakle posle
--    deploy-a ovaj red se sam razdvoji na `postal_code = '11272'` i `city = 'Dobanovci'`.
--    Do tada memorandum štampa pun oblik, kao na papiru. Da je ovde upisan goli grad,
--    poštanski broj bi nedostajao sve do deploy-a, a niko ga posle ne bi ni tražio.
--
-- ⚠️ `company_name` je GOLI naziv (odluka O-F9, „jedno ime svuda"): mesto uz ime
--    memorandum dopisuje sam iz `city`, pa upisivanje „Servoteh d.o.o. Dobanovci"
--    ovde dalo bi „…Dobanovci Dobanovci".
--
-- IDEMPOTENTNO: čist `UPDATE` po `id = 0` (jedini red). Ponovno pokretanje ne menja
-- ništa. NE dira polja koja nisu na papiru (podešavanja knjiženja, POS, fiskalni).

UPDATE companies
SET company_name           = 'Servoteh d.o.o.',
    address                = 'Ugrinovačka 163',
    city                   = '11272 Dobanovci',
    phone                  = '+381 11 31 41 564; 373 29 59',
    fax                    = '+381 11 2399 265',
    email                  = 'office@servoteh.rs',
    web_address            = 'www.servoteh.rs',
    bank_account           = '160-110610-83',
    registration_number    = '17400169',      -- matični broj (O-F8: UVEK naš, nikad kupčev)
    registry_number        = '01117400169',
    business_activity_code = '3320',
    tax_id                 = '101017443',     -- PIB
    invoice_issuing_place  = 'Beograd',
    apr_text               = '"Servoteh" d.o.o. je jednočlano privredno društvo upisano u Agenciji za privredne registre pod brojem BD. 222785/2006',
    -- Devizni podaci sa `InoFaktura GP 228-25` (blok „Beneficiary Customer").
    -- Ovo je REZERVA; račun po valuti se vodi u `payment_accounts` (ekran Firma →
    -- „Devizni računi"), pa se ovde drži samo da ino obrazac ne ostane bez broja.
    iban                   = 'RS35160005010003501186',
    swift                  = 'DBDBRSBG'
WHERE id = 0;
