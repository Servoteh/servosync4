-- Komitenti -> customers. UPSERT key = id (Sifra, BigBit AutoNumber PK).
-- Stage column order MUST match Komitenti storage order (\copy is positional).
-- customers.id space == BigBit Sifra (1:1); explicit-id insert + setval.
-- 57 staged source columns; 56 mapped (KoristiPNBZadModel has no Prisma target,
-- same as sync-map.generated.ts). FK nulling mirrors customer.syncer.ts:
--   code_type_code  -> code_types.code   (empty/unknown -> NULL)
--   salesperson_id  -> salespeople.id    (0/NULL/unknown -> NULL)
--   driver_id       -> customers.id self-FK (0/NULL -> NULL; kept only when the
--                      target row already exists OR arrives in this same CSV --
--                      FK triggers fire at end of statement, so same-statement
--                      self references are valid)
-- payment_account_id / route_id / region have NO @relation in schema.prisma
-- (not DB FKs) and are passed through raw, exactly like customer.syncer.ts.
BEGIN;
CREATE TEMP TABLE bb_stage (
  sifra int, naziv varchar(50), poslovnica varchar(50), mesto varchar(30), adresa varchar(50),
  postanskibroj varchar(20), ziroracun1 varchar(30), ziroracun2 varchar(30), ziroracun3 varchar(30),
  telefon varchar(20), fax varchar(20), kontakt varchar(50), napomena text, drzava varchar(30),
  region int, vrstasifre varchar(10), email varchar(50), mobilni varchar(20), datumrodjenja timestamp,
  webadresa varchar(50), sifraprodavca int, rabatkomitenta double precision, zastkodkupca varchar(50),
  pib varchar(20), pdvstatus int, msifra varchar(10), odlozeno smallint, idruta int, idvozac int,
  iduplatniracun int, fakturisanjepomestimaisporuke boolean, cenovnik varchar(5), prviunos timestamp,
  poslednjaizmena timestamp, prviunosuser varchar(20), poslednjaizmenauser varchar(20),
  procenatprovizije double precision, fiktrabatkomitenta double precision,
  komitentinacinplacanja varchar(50), potpiskom varchar(50), skraceninaziv varchar(30),
  datumivremekom timestamp, proveraduga boolean, kreditlimit numeric(19,4), neproveravajpib boolean,
  idpantheon varchar(30), newsletter boolean, postanadruguadresu boolean, gln varchar(30),
  klrucproc numeric(19,4), napomenazasalda text, neprikazatiupregledu boolean, jbkjs varchar(10),
  maticnibroj varchar(20), erxmlsapopustompoartiklu boolean, crf boolean, koristipnbzadmodel boolean
) ON COMMIT DROP;
\copy bb_stage FROM '/tmp/bb/customers.csv' WITH (FORMAT csv, HEADER true, ENCODING 'UTF8')
WITH upserted AS (
  INSERT INTO customers (id, name, branch, city, address, postal_code,
                         bank_account_1, bank_account_2, bank_account_3,
                         phone, fax, contact, note, country, region, code_type_code,
                         email, mobile, birth_date, web_address, salesperson_id,
                         customer_discount, buyer_protection_code, tax_id, vat_status,
                         external_code, payment_term_days, route_id, driver_id,
                         payment_account_id, invoice_per_delivery_address, price_list_code,
                         created_at, updated_at, created_by, updated_by,
                         commission_percent, fictitious_discount, payment_method, signature,
                         short_name, record_created_at, check_debt, credit_limit,
                         skip_tax_id_validation, pantheon_id, newsletter, mail_to_different_address,
                         gln, manual_markup_percent, balance_note, hide_in_overview,
                         public_sector_id, registration_number, einvoice_xml_per_item_discount,
                         central_invoice_registry)
  SELECT sifra, COALESCE(naziv, ''), poslovnica, mesto, adresa, postanskibroj,
         ziroracun1, ziroracun2, ziroracun3,
         telefon, fax, kontakt, napomena, drzava, region,
         CASE WHEN vrstasifre IS NULL OR vrstasifre = '' THEN NULL
              WHEN EXISTS (SELECT 1 FROM code_types r WHERE r.code = vrstasifre) THEN vrstasifre
              ELSE NULL END,
         email, mobilni, datumrodjenja, webadresa,
         CASE WHEN sifraprodavca IS NULL OR sifraprodavca = 0 THEN NULL
              WHEN EXISTS (SELECT 1 FROM salespeople r WHERE r.id = sifraprodavca) THEN sifraprodavca
              ELSE NULL END,
         rabatkomitenta, zastkodkupca, COALESCE(pib, ''), pdvstatus,
         msifra, odlozeno, idruta,
         CASE WHEN idvozac IS NULL OR idvozac = 0 THEN NULL
              WHEN EXISTS (SELECT 1 FROM customers r WHERE r.id = idvozac)
                OR EXISTS (SELECT 1 FROM bb_stage s2 WHERE s2.sifra = idvozac) THEN idvozac
              ELSE NULL END,
         iduplatniracun, fakturisanjepomestimaisporuke, cenovnik,
         prviunos, poslednjaizmena, prviunosuser, poslednjaizmenauser,
         procenatprovizije, fiktrabatkomitenta, komitentinacinplacanja, potpiskom,
         skraceninaziv, datumivremekom, proveraduga, kreditlimit,
         neproveravajpib, idpantheon, newsletter, postanadruguadresu,
         gln, klrucproc, napomenazasalda, neprikazatiupregledu,
         jbkjs, maticnibroj, erxmlsapopustompoartiklu,
         crf
  FROM bb_stage WHERE sifra IS NOT NULL
  ON CONFLICT (id) DO UPDATE SET
    name = EXCLUDED.name, branch = EXCLUDED.branch, city = EXCLUDED.city,
    address = EXCLUDED.address, postal_code = EXCLUDED.postal_code,
    bank_account_1 = EXCLUDED.bank_account_1, bank_account_2 = EXCLUDED.bank_account_2,
    bank_account_3 = EXCLUDED.bank_account_3, phone = EXCLUDED.phone, fax = EXCLUDED.fax,
    contact = EXCLUDED.contact, note = EXCLUDED.note, country = EXCLUDED.country,
    region = EXCLUDED.region, code_type_code = EXCLUDED.code_type_code,
    email = EXCLUDED.email, mobile = EXCLUDED.mobile, birth_date = EXCLUDED.birth_date,
    web_address = EXCLUDED.web_address, salesperson_id = EXCLUDED.salesperson_id,
    customer_discount = EXCLUDED.customer_discount,
    buyer_protection_code = EXCLUDED.buyer_protection_code, tax_id = EXCLUDED.tax_id,
    vat_status = EXCLUDED.vat_status, external_code = EXCLUDED.external_code,
    payment_term_days = EXCLUDED.payment_term_days, route_id = EXCLUDED.route_id,
    driver_id = EXCLUDED.driver_id, payment_account_id = EXCLUDED.payment_account_id,
    invoice_per_delivery_address = EXCLUDED.invoice_per_delivery_address,
    price_list_code = EXCLUDED.price_list_code, created_at = EXCLUDED.created_at,
    updated_at = EXCLUDED.updated_at, created_by = EXCLUDED.created_by,
    updated_by = EXCLUDED.updated_by, commission_percent = EXCLUDED.commission_percent,
    fictitious_discount = EXCLUDED.fictitious_discount, payment_method = EXCLUDED.payment_method,
    signature = EXCLUDED.signature, short_name = EXCLUDED.short_name,
    record_created_at = EXCLUDED.record_created_at, check_debt = EXCLUDED.check_debt,
    credit_limit = EXCLUDED.credit_limit, skip_tax_id_validation = EXCLUDED.skip_tax_id_validation,
    pantheon_id = EXCLUDED.pantheon_id, newsletter = EXCLUDED.newsletter,
    mail_to_different_address = EXCLUDED.mail_to_different_address, gln = EXCLUDED.gln,
    manual_markup_percent = EXCLUDED.manual_markup_percent, balance_note = EXCLUDED.balance_note,
    hide_in_overview = EXCLUDED.hide_in_overview, public_sector_id = EXCLUDED.public_sector_id,
    registration_number = EXCLUDED.registration_number,
    einvoice_xml_per_item_discount = EXCLUDED.einvoice_xml_per_item_discount,
    central_invoice_registry = EXCLUDED.central_invoice_registry
    WHERE (customers.name, customers.branch, customers.city, customers.address,
           customers.postal_code, customers.bank_account_1, customers.bank_account_2,
           customers.bank_account_3, customers.phone, customers.fax, customers.contact,
           customers.note, customers.country, customers.region, customers.code_type_code,
           customers.email, customers.mobile, customers.birth_date, customers.web_address,
           customers.salesperson_id, customers.customer_discount, customers.buyer_protection_code,
           customers.tax_id, customers.vat_status, customers.external_code,
           customers.payment_term_days, customers.route_id, customers.driver_id,
           customers.payment_account_id, customers.invoice_per_delivery_address,
           customers.price_list_code, customers.created_at, customers.updated_at,
           customers.created_by, customers.updated_by, customers.commission_percent,
           customers.fictitious_discount, customers.payment_method, customers.signature,
           customers.short_name, customers.record_created_at, customers.check_debt,
           customers.credit_limit, customers.skip_tax_id_validation, customers.pantheon_id,
           customers.newsletter, customers.mail_to_different_address, customers.gln,
           customers.manual_markup_percent, customers.balance_note, customers.hide_in_overview,
           customers.public_sector_id, customers.registration_number,
           customers.einvoice_xml_per_item_discount, customers.central_invoice_registry)
      IS DISTINCT FROM
          (EXCLUDED.name, EXCLUDED.branch, EXCLUDED.city, EXCLUDED.address,
           EXCLUDED.postal_code, EXCLUDED.bank_account_1, EXCLUDED.bank_account_2,
           EXCLUDED.bank_account_3, EXCLUDED.phone, EXCLUDED.fax, EXCLUDED.contact,
           EXCLUDED.note, EXCLUDED.country, EXCLUDED.region, EXCLUDED.code_type_code,
           EXCLUDED.email, EXCLUDED.mobile, EXCLUDED.birth_date, EXCLUDED.web_address,
           EXCLUDED.salesperson_id, EXCLUDED.customer_discount, EXCLUDED.buyer_protection_code,
           EXCLUDED.tax_id, EXCLUDED.vat_status, EXCLUDED.external_code,
           EXCLUDED.payment_term_days, EXCLUDED.route_id, EXCLUDED.driver_id,
           EXCLUDED.payment_account_id, EXCLUDED.invoice_per_delivery_address,
           EXCLUDED.price_list_code, EXCLUDED.created_at, EXCLUDED.updated_at,
           EXCLUDED.created_by, EXCLUDED.updated_by, EXCLUDED.commission_percent,
           EXCLUDED.fictitious_discount, EXCLUDED.payment_method, EXCLUDED.signature,
           EXCLUDED.short_name, EXCLUDED.record_created_at, EXCLUDED.check_debt,
           EXCLUDED.credit_limit, EXCLUDED.skip_tax_id_validation, EXCLUDED.pantheon_id,
           EXCLUDED.newsletter, EXCLUDED.mail_to_different_address, EXCLUDED.gln,
           EXCLUDED.manual_markup_percent, EXCLUDED.balance_note, EXCLUDED.hide_in_overview,
           EXCLUDED.public_sector_id, EXCLUDED.registration_number,
           EXCLUDED.einvoice_xml_per_item_discount, EXCLUDED.central_invoice_registry)
  RETURNING (xmax = 0) AS was_insert
)
SELECT (SELECT count(*) FROM bb_stage WHERE sifra IS NOT NULL) || '|' ||
       count(*) FILTER (WHERE was_insert) || '|' ||
       count(*) FILTER (WHERE NOT was_insert) || '|' ||
       (SELECT count(*) FROM customers t WHERE NOT EXISTS (SELECT 1 FROM bb_stage s WHERE s.sifra = t.id))
FROM upserted;
-- keep the autoincrement sequence past the explicit ids we just inserted
SELECT setval(pg_get_serial_sequence('customers','id'),
              GREATEST((SELECT COALESCE(max(id),1) FROM customers), 1),
              EXISTS(SELECT 1 FROM customers));
COMMIT;
