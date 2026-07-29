-- KomitentiKontaktOsobe -> customer_contacts. UPSERT key = id (IDKontaktOsobe, BigBit
-- AutoNumber PK); customer_contacts.id space == BigBit IDKontaktOsobe -> explicit-id
-- insert + setval (isti obrazac kao warehouses.sql).
--
-- Stage column order MUST match KomitentiKontaktOsobe storage order (BB_T_26_schema.sql
-- :429-440; \copy is positional). Kolona `[Datum rodjenja]` ima RAZMAK u imenu -- to je
-- ovde nebitno: mdb-export ispisuje originalna imena u header redu, a `HEADER true`
-- taj red PRESKACE, pa se ucitava iskljucivo po poziciji. Stage imena su nasa.
--
-- customer_id je MEKI ref -> customers.id (= BigBit Sifra 1:1, BIGBIT_KOMITENTI.md 5.1).
-- Sirocad se NE odbacuje: kontakt komitenta koga (jos) nema u `customers` se svejedno
-- upisuje -- bridge nema FK-resolve korak, a red je validan podatak.
--
-- NULL normalizacija: prazan tekst -> NULL (Access cuva "" i NULL kao dve razlicite
-- "praznine"; karton bi inace prikazivao prazan string kao popunjeno polje).
BEGIN;
CREATE TEMP TABLE bb_stage (
  idkontaktosobe int, sifra int, kontaktosoba varchar(50), kontakttelefon varchar(20),
  kontaktfax varchar(20), kontaktmobilni varchar(20), kontaktemail varchar(50),
  datumrodjenja timestamp, kontaktdefault boolean
) ON COMMIT DROP;
\copy bb_stage FROM '/tmp/bb/customer_contacts.csv' WITH (FORMAT csv, HEADER true, ENCODING 'UTF8')
WITH upserted AS (
  INSERT INTO customer_contacts (id, customer_id, contact_person, phone, fax, mobile,
                                 email, birth_date, is_default)
  SELECT idkontaktosobe, sifra,
         NULLIF(btrim(kontaktosoba), ''), NULLIF(btrim(kontakttelefon), ''),
         NULLIF(btrim(kontaktfax), ''), NULLIF(btrim(kontaktmobilni), ''),
         NULLIF(btrim(kontaktemail), ''), datumrodjenja,
         COALESCE(kontaktdefault, false)
  FROM bb_stage WHERE idkontaktosobe IS NOT NULL AND sifra IS NOT NULL
  ON CONFLICT (id) DO UPDATE SET
    customer_id = EXCLUDED.customer_id, contact_person = EXCLUDED.contact_person,
    phone = EXCLUDED.phone, fax = EXCLUDED.fax, mobile = EXCLUDED.mobile,
    email = EXCLUDED.email, birth_date = EXCLUDED.birth_date,
    is_default = EXCLUDED.is_default
    WHERE (customer_contacts.customer_id, customer_contacts.contact_person,
           customer_contacts.phone, customer_contacts.fax, customer_contacts.mobile,
           customer_contacts.email, customer_contacts.birth_date,
           customer_contacts.is_default)
      IS DISTINCT FROM
          (EXCLUDED.customer_id, EXCLUDED.contact_person, EXCLUDED.phone, EXCLUDED.fax,
           EXCLUDED.mobile, EXCLUDED.email, EXCLUDED.birth_date, EXCLUDED.is_default)
  RETURNING (xmax = 0) AS was_insert
)
SELECT (SELECT count(*) FROM bb_stage WHERE idkontaktosobe IS NOT NULL AND sifra IS NOT NULL) || '|' ||
       count(*) FILTER (WHERE was_insert) || '|' ||
       count(*) FILTER (WHERE NOT was_insert) || '|' ||
       (SELECT count(*) FROM customer_contacts t
          WHERE NOT EXISTS (SELECT 1 FROM bb_stage s WHERE s.idkontaktosobe = t.id))
FROM upserted;
-- keep the autoincrement sequence past the explicit ids we just inserted
SELECT setval(pg_get_serial_sequence('customer_contacts','id'),
              GREATEST((SELECT COALESCE(max(id),1) FROM customer_contacts), 1),
              EXISTS(SELECT 1 FROM customer_contacts));
COMMIT;
