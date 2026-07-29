-- MestaIsporuke -> customer_delivery_locations. UPSERT key = id (BigBit AutoNumber PK);
-- id space == BigBit ID -> explicit-id insert + setval (obrazac iz warehouses.sql).
--
-- Stage column order MUST match MestaIsporuke storage order (BB_T_26_schema.sql
-- :2499-2521, 20 kolona; \copy is positional, header se preskace).
--
-- customer_id je MEKI ref -> customers.id (= BigBit Sifra 1:1). Isto vazi za
-- salesperson_id / route_id / driver_id / payment_account_id -- prolaze SIROVI, bez
-- FK-a i bez null-ovanja (isti tretman kao customers.route_id/driver_id u customers.sql).
--
-- NULL normalizacija: prazan tekst -> NULL, i za NOT NULL izvorne kolone koje BigBit u
-- praksi puni praznim stringom (Podrucje/AdresaIsporuke/MestoIsporuke). Izuzetak je
-- `name`: cilj je NOT NULL, pa prazan naziv pada na '-' (isti obrazac kao
-- items.catalog_number u items.sql) -- red se NE odbacuje, lokacija je i tada podatak.
--
-- Nula u SifraProdavcaMestaIsporuke/IDRuta/IDVozac/IDUplatniRacun je BigBit-ovo „nije
-- zadato" (kolone su NOT NULL bez pravog prazan-stanja) -> mapira se u NULL da karton
-- ne prikazuje lazan „prodavac 0".
BEGIN;
CREATE TEMP TABLE bb_stage (
  id int, idkomitent int, nazivmestaisporuke varchar(50), mestoisporuke varchar(30),
  adresaisporuke varchar(50), telefon varchar(20), podrucje varchar(30), fax varchar(20),
  sifraprodavcamestaisporuke int, kategorijaugovora varchar(30),
  opstakategorizacija varchar(30), kanalprodaje varchar(30), idrutamestaisporuke int,
  idvozacmestaisporuke int, iduplatniracunmestaisporuke int, gln varchar(30),
  regionmestaisporuke int, aktivnomisp boolean, postbrojmestaisporuke varchar(20),
  brojmestaisporuke varchar(20)
) ON COMMIT DROP;
\copy bb_stage FROM '/tmp/bb/customer_delivery_locations.csv' WITH (FORMAT csv, HEADER true, ENCODING 'UTF8')
WITH src AS (
  SELECT id, idkomitent AS customer_id,
         COALESCE(NULLIF(btrim(nazivmestaisporuke), ''), '-') AS name,
         NULLIF(btrim(mestoisporuke), '')     AS city,
         NULLIF(btrim(adresaisporuke), '')    AS address,
         NULLIF(btrim(telefon), '')           AS phone,
         NULLIF(btrim(podrucje), '')          AS area,
         NULLIF(btrim(fax), '')               AS fax,
         NULLIF(sifraprodavcamestaisporuke, 0)  AS salesperson_id,
         NULLIF(btrim(kategorijaugovora), '')   AS contract_category,
         NULLIF(btrim(opstakategorizacija), '') AS general_category,
         NULLIF(btrim(kanalprodaje), '')        AS sales_channel,
         NULLIF(idrutamestaisporuke, 0)         AS route_id,
         NULLIF(idvozacmestaisporuke, 0)        AS driver_id,
         NULLIF(iduplatniracunmestaisporuke, 0) AS payment_account_id,
         NULLIF(btrim(gln), '')                 AS gln,
         NULLIF(regionmestaisporuke, 0)         AS region,
         COALESCE(aktivnomisp, true)            AS active,
         NULLIF(btrim(postbrojmestaisporuke), '') AS postal_code,
         NULLIF(btrim(brojmestaisporuke), '')     AS location_number
  FROM bb_stage WHERE id IS NOT NULL AND idkomitent IS NOT NULL
), upserted AS (
  INSERT INTO customer_delivery_locations (id, customer_id, name, city, address, phone,
                                           area, fax, salesperson_id, contract_category,
                                           general_category, sales_channel, route_id,
                                           driver_id, payment_account_id, gln, region,
                                           active, postal_code, location_number)
  SELECT id, customer_id, name, city, address, phone, area, fax, salesperson_id,
         contract_category, general_category, sales_channel, route_id, driver_id,
         payment_account_id, gln, region, active, postal_code, location_number
  FROM src
  ON CONFLICT (id) DO UPDATE SET
    customer_id = EXCLUDED.customer_id, name = EXCLUDED.name, city = EXCLUDED.city,
    address = EXCLUDED.address, phone = EXCLUDED.phone, area = EXCLUDED.area,
    fax = EXCLUDED.fax, salesperson_id = EXCLUDED.salesperson_id,
    contract_category = EXCLUDED.contract_category,
    general_category = EXCLUDED.general_category, sales_channel = EXCLUDED.sales_channel,
    route_id = EXCLUDED.route_id, driver_id = EXCLUDED.driver_id,
    payment_account_id = EXCLUDED.payment_account_id, gln = EXCLUDED.gln,
    region = EXCLUDED.region, active = EXCLUDED.active,
    postal_code = EXCLUDED.postal_code, location_number = EXCLUDED.location_number
    WHERE (customer_delivery_locations.customer_id, customer_delivery_locations.name,
           customer_delivery_locations.city, customer_delivery_locations.address,
           customer_delivery_locations.phone, customer_delivery_locations.area,
           customer_delivery_locations.fax, customer_delivery_locations.salesperson_id,
           customer_delivery_locations.contract_category,
           customer_delivery_locations.general_category,
           customer_delivery_locations.sales_channel, customer_delivery_locations.route_id,
           customer_delivery_locations.driver_id,
           customer_delivery_locations.payment_account_id, customer_delivery_locations.gln,
           customer_delivery_locations.region, customer_delivery_locations.active,
           customer_delivery_locations.postal_code,
           customer_delivery_locations.location_number)
      IS DISTINCT FROM
          (EXCLUDED.customer_id, EXCLUDED.name, EXCLUDED.city, EXCLUDED.address,
           EXCLUDED.phone, EXCLUDED.area, EXCLUDED.fax, EXCLUDED.salesperson_id,
           EXCLUDED.contract_category, EXCLUDED.general_category, EXCLUDED.sales_channel,
           EXCLUDED.route_id, EXCLUDED.driver_id, EXCLUDED.payment_account_id,
           EXCLUDED.gln, EXCLUDED.region, EXCLUDED.active, EXCLUDED.postal_code,
           EXCLUDED.location_number)
  RETURNING (xmax = 0) AS was_insert
)
SELECT (SELECT count(*) FROM src) || '|' ||
       count(*) FILTER (WHERE was_insert) || '|' ||
       count(*) FILTER (WHERE NOT was_insert) || '|' ||
       (SELECT count(*) FROM customer_delivery_locations t
          WHERE NOT EXISTS (SELECT 1 FROM bb_stage s WHERE s.id = t.id))
FROM upserted;
-- keep the autoincrement sequence past the explicit ids we just inserted
SELECT setval(pg_get_serial_sequence('customer_delivery_locations','id'),
              GREATEST((SELECT COALESCE(max(id),1) FROM customer_delivery_locations), 1),
              EXISTS(SELECT 1 FROM customer_delivery_locations));
COMMIT;
