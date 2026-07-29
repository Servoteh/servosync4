-- R_Artikli_BarKod -> item_barcodes. UPSERT key = id (BigBit AutoNumber PK);
-- id space == BigBit ID -> explicit-id insert + setval (obrazac iz warehouses.sql).
--
-- Stage column order MUST match R_Artikli_BarKod storage order (BB_T_26_schema.sql
-- :1001-1007; \copy is positional, header se preskace).
--
-- !!! item_id NIJE items.id !!! IDArtikal je BIGBIT sifra artikla i odgovara
-- items.external_item_id (items.id je QBigTehn-lokalni IDENTITY iz kopije,
-- BIGBIT_ARTIKLI.md 5.1). Vrednost se ovde upisuje SIROVA, bez remapiranja: masters API
-- razresava artikal preko external_item_id. Zato ni „missing" brojac ne gleda `items` --
-- meri se samo sta u PG postoji a nema ga vise u BigBit izvoru (odluka plana 7.3).
--
-- MultiFaktor = Access Currency (mdb-export emituje "1.0000") -> numeric(19,4).
-- Nula/NULL bi bila besmislena za mnozilac kolicine, pa pada na 1 (= jedan komad).
BEGIN;
CREATE TEMP TABLE bb_stage (
  id int, idartikal int, barkod varchar(20), multifaktor numeric(19,4)
) ON COMMIT DROP;
\copy bb_stage FROM '/tmp/bb/item_barcodes.csv' WITH (FORMAT csv, HEADER true, ENCODING 'UTF8')
WITH src AS (
  SELECT id, idartikal AS item_id,
         btrim(barkod) AS bar_code,
         COALESCE(NULLIF(multifaktor, 0), 1) AS multi_factor
  FROM bb_stage
  WHERE id IS NOT NULL AND idartikal IS NOT NULL AND NULLIF(btrim(barkod), '') IS NOT NULL
), upserted AS (
  INSERT INTO item_barcodes (id, item_id, bar_code, multi_factor)
  SELECT id, item_id, bar_code, multi_factor FROM src
  ON CONFLICT (id) DO UPDATE SET
    item_id = EXCLUDED.item_id, bar_code = EXCLUDED.bar_code,
    multi_factor = EXCLUDED.multi_factor
    WHERE (item_barcodes.item_id, item_barcodes.bar_code, item_barcodes.multi_factor)
      IS DISTINCT FROM (EXCLUDED.item_id, EXCLUDED.bar_code, EXCLUDED.multi_factor)
  RETURNING (xmax = 0) AS was_insert
)
SELECT (SELECT count(*) FROM src) || '|' ||
       count(*) FILTER (WHERE was_insert) || '|' ||
       count(*) FILTER (WHERE NOT was_insert) || '|' ||
       (SELECT count(*) FROM item_barcodes t
          WHERE NOT EXISTS (SELECT 1 FROM bb_stage s WHERE s.id = t.id))
FROM upserted;
-- keep the autoincrement sequence past the explicit ids we just inserted
SELECT setval(pg_get_serial_sequence('item_barcodes','id'),
              GREATEST((SELECT COALESCE(max(id),1) FROM item_barcodes), 1),
              EXISTS(SELECT 1 FROM item_barcodes));
COMMIT;
