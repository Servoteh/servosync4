-- R_KvalitetArtikla -> item_quality_types. UPSERT key = id (IDKvalitetArtikla).
-- Kolona `id` je obican INTEGER, NE SERIAL: vrednost je legacy dodela iz BigBit-a i
-- nikad se ne generise ovde -> nema sekvence, pa NEMA ni setval-a (za razliku od
-- warehouses.sql / item_barcodes.sql).
--
-- Stage column order MUST match R_KvalitetArtikla storage order (BB_T_26_schema.sql
-- :1023-1028; \copy is positional, header se preskace).
--
-- Ovo je ciljna tabela za items.quality_type_id, koji je do sada visio u prazno --
-- tabele nema ni u QBigTehn MSSQL kopiji (BIGBIT_ARTIKLI.md 2.1).
--
-- Obe tekstualne kolone su NOT NULL u izvoru I u cilju, pa prazna vrednost pada na ''
-- (COALESCE), a ne na NULL -- red se ne odbacuje jer sam id nosi vezu sa artiklom.
BEGIN;
CREATE TEMP TABLE bb_stage (
  idkvalitetartikla int, kvalitetartikal varchar(20), opis varchar(20)
) ON COMMIT DROP;
\copy bb_stage FROM '/tmp/bb/item_quality_types.csv' WITH (FORMAT csv, HEADER true, ENCODING 'UTF8')
WITH upserted AS (
  INSERT INTO item_quality_types (id, quality_code, description)
  SELECT idkvalitetartikla, COALESCE(btrim(kvalitetartikal), ''), COALESCE(btrim(opis), '')
  FROM bb_stage WHERE idkvalitetartikla IS NOT NULL
  ON CONFLICT (id) DO UPDATE SET
    quality_code = EXCLUDED.quality_code, description = EXCLUDED.description
    WHERE (item_quality_types.quality_code, item_quality_types.description)
      IS DISTINCT FROM (EXCLUDED.quality_code, EXCLUDED.description)
  RETURNING (xmax = 0) AS was_insert
)
SELECT (SELECT count(*) FROM bb_stage WHERE idkvalitetartikla IS NOT NULL) || '|' ||
       count(*) FILTER (WHERE was_insert) || '|' ||
       count(*) FILTER (WHERE NOT was_insert) || '|' ||
       (SELECT count(*) FROM item_quality_types t
          WHERE NOT EXISTS (SELECT 1 FROM bb_stage s WHERE s.idkvalitetartikla = t.id))
FROM upserted;
COMMIT;
