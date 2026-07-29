-- DobavljaciZaArtikal -> item_suppliers. UPSERT key = id (BigBit AutoNumber PK);
-- id space == BigBit ID -> explicit-id insert + setval (obrazac iz warehouses.sql).
--
-- Stage column order MUST match DobavljaciZaArtikal storage order (BB_T_26_schema.sql
-- :243-250; \copy is positional). Kolona `[Sifra dobavljaca]` ima RAZMAK u imenu -- to je
-- ovde nebitno: mdb-export ispisuje originalna imena u header redu, a `HEADER true` taj
-- red PRESKACE, pa se ucitava iskljucivo po poziciji. Stage imena su nasa.
--
-- !!! item_id NIJE items.id !!! IDArtikal je BIGBIT sifra artikla = items.external_item_id
-- (BIGBIT_ARTIKLI.md 5.1). Upisuje se sirova; masters API razresava artikal preko
-- external_item_id.
--
-- supplier_id je MEKI ref -> customers.id (dobavljac je komitent; komitentov PK se pri
-- transferu NE remapira, BIGBIT_KOMITENTI.md 5.1, pa se vrednost poklapa direktno).
-- Nula = BigBit-ovo „nije zadato" na NOT NULL koloni -> red se odbacuje: dobavljac bez
-- sifre nije podatak (za razliku od npr. rute, gde 0 samo znaci „nema rute").
BEGIN;
CREATE TEMP TABLE bb_stage (
  id int, idartikal int, sifra_dobavljaca int, primarni boolean, vremeisporuke int
) ON COMMIT DROP;
\copy bb_stage FROM '/tmp/bb/item_suppliers.csv' WITH (FORMAT csv, HEADER true, ENCODING 'UTF8')
WITH src AS (
  SELECT id, idartikal AS item_id, sifra_dobavljaca AS supplier_id,
         COALESCE(primarni, false)        AS is_primary,
         GREATEST(COALESCE(vremeisporuke, 0), 0) AS lead_time_days
  FROM bb_stage
  WHERE id IS NOT NULL AND idartikal IS NOT NULL AND COALESCE(sifra_dobavljaca, 0) <> 0
), upserted AS (
  INSERT INTO item_suppliers (id, item_id, supplier_id, is_primary, lead_time_days)
  SELECT id, item_id, supplier_id, is_primary, lead_time_days FROM src
  ON CONFLICT (id) DO UPDATE SET
    item_id = EXCLUDED.item_id, supplier_id = EXCLUDED.supplier_id,
    is_primary = EXCLUDED.is_primary, lead_time_days = EXCLUDED.lead_time_days
    WHERE (item_suppliers.item_id, item_suppliers.supplier_id, item_suppliers.is_primary,
           item_suppliers.lead_time_days)
      IS DISTINCT FROM (EXCLUDED.item_id, EXCLUDED.supplier_id, EXCLUDED.is_primary,
                        EXCLUDED.lead_time_days)
  RETURNING (xmax = 0) AS was_insert
)
SELECT (SELECT count(*) FROM src) || '|' ||
       count(*) FILTER (WHERE was_insert) || '|' ||
       count(*) FILTER (WHERE NOT was_insert) || '|' ||
       (SELECT count(*) FROM item_suppliers t
          WHERE NOT EXISTS (SELECT 1 FROM bb_stage s WHERE s.id = t.id))
FROM upserted;
-- keep the autoincrement sequence past the explicit ids we just inserted
SELECT setval(pg_get_serial_sequence('item_suppliers','id'),
              GREATEST((SELECT COALESCE(max(id),1) FROM item_suppliers), 1),
              EXISTS(SELECT 1 FROM item_suppliers));
COMMIT;
