-- R_Poreklo(Poreklo, Opis, PodgrupaVeza, PopustProc) -> item_origins(code, description,
-- subgroup_code, discount_percent). PopustProc = Access Currency (mdb-export emits "0.0000").
BEGIN;
CREATE TEMP TABLE bb_stage (poreklo varchar(5), opis varchar(50), podgrupaveza varchar(10), popustproc numeric(19,4)) ON COMMIT DROP;
\copy bb_stage FROM '/tmp/bb/item_origins.csv' WITH (FORMAT csv, HEADER true, ENCODING 'UTF8')
WITH upserted AS (
  INSERT INTO item_origins (code, description, subgroup_code, discount_percent)
  SELECT poreklo, COALESCE(opis, ''), COALESCE(podgrupaveza, '0'), COALESCE(popustproc, 0) FROM bb_stage
  ON CONFLICT (code) DO UPDATE SET description = EXCLUDED.description,
                                   subgroup_code = EXCLUDED.subgroup_code,
                                   discount_percent = EXCLUDED.discount_percent
    WHERE (item_origins.description, item_origins.subgroup_code, item_origins.discount_percent)
          IS DISTINCT FROM (EXCLUDED.description, EXCLUDED.subgroup_code, EXCLUDED.discount_percent)
  RETURNING (xmax = 0) AS was_insert
)
SELECT (SELECT count(*) FROM bb_stage) || '|' ||
       count(*) FILTER (WHERE was_insert) || '|' ||
       count(*) FILTER (WHERE NOT was_insert) || '|' ||
       (SELECT count(*) FROM item_origins t WHERE NOT EXISTS (SELECT 1 FROM bb_stage s WHERE s.poreklo = t.code))
FROM upserted;
COMMIT;
