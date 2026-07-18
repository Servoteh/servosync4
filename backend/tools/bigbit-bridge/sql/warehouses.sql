-- Magacini -> warehouses. UPSERT key = id (IDMagacin, BigBit AutoNumber PK).
-- Stage column order MUST match Magacini storage order (\copy is positional).
-- warehouses.id space == BigBit IDMagacin (1:1, plan 7.6); explicit-id insert.
BEGIN;
CREATE TEMP TABLE bb_stage (
  idfirma int, idmagacin int, magacin varchar(50), ulicaibroj varchar(50), mesto varchar(30),
  prosecnecene boolean, vrstamag varchar(5), kontomag varchar(10), imemagacionera varchar(30),
  brlkmagacionera varchar(20), potpisslika varchar(250)
) ON COMMIT DROP;
\copy bb_stage FROM '/tmp/bb/warehouses.csv' WITH (FORMAT csv, HEADER true, ENCODING 'UTF8')
WITH upserted AS (
  INSERT INTO warehouses (company_id, id, name, street, city, average_prices, warehouse_type,
                          account, manager_name, manager_id_number, signature_image_path)
  SELECT idfirma, idmagacin, COALESCE(magacin, ''), ulicaibroj, mesto, COALESCE(prosecnecene, false),
         vrstamag, kontomag, imemagacionera, brlkmagacionera, potpisslika
  FROM bb_stage WHERE idmagacin IS NOT NULL
  ON CONFLICT (id) DO UPDATE SET
    company_id = EXCLUDED.company_id, name = EXCLUDED.name, street = EXCLUDED.street,
    city = EXCLUDED.city, average_prices = EXCLUDED.average_prices, warehouse_type = EXCLUDED.warehouse_type,
    account = EXCLUDED.account, manager_name = EXCLUDED.manager_name,
    manager_id_number = EXCLUDED.manager_id_number, signature_image_path = EXCLUDED.signature_image_path
    WHERE (warehouses.company_id, warehouses.name, warehouses.street, warehouses.city,
           warehouses.average_prices, warehouses.warehouse_type, warehouses.account,
           warehouses.manager_name, warehouses.manager_id_number, warehouses.signature_image_path)
      IS DISTINCT FROM
          (EXCLUDED.company_id, EXCLUDED.name, EXCLUDED.street, EXCLUDED.city,
           EXCLUDED.average_prices, EXCLUDED.warehouse_type, EXCLUDED.account,
           EXCLUDED.manager_name, EXCLUDED.manager_id_number, EXCLUDED.signature_image_path)
  RETURNING (xmax = 0) AS was_insert
)
SELECT (SELECT count(*) FROM bb_stage WHERE idmagacin IS NOT NULL) || '|' ||
       count(*) FILTER (WHERE was_insert) || '|' ||
       count(*) FILTER (WHERE NOT was_insert) || '|' ||
       (SELECT count(*) FROM warehouses t WHERE NOT EXISTS (SELECT 1 FROM bb_stage s WHERE s.idmagacin = t.id))
FROM upserted;
-- keep the autoincrement sequence past the explicit ids we just inserted
SELECT setval(pg_get_serial_sequence('warehouses','id'),
              GREATEST((SELECT COALESCE(max(id),1) FROM warehouses), 1),
              EXISTS(SELECT 1 FROM warehouses));
COMMIT;
