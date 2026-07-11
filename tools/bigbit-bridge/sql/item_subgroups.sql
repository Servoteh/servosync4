-- R_Podgrupa(Podgrupa, Opis, GrupaVeza) -> item_subgroups(code, description, parent_group).
BEGIN;
CREATE TEMP TABLE bb_stage (podgrupa varchar(10), opis varchar(50), grupaveza varchar(10)) ON COMMIT DROP;
\copy bb_stage FROM '/tmp/bb/item_subgroups.csv' WITH (FORMAT csv, HEADER true, ENCODING 'UTF8')
WITH upserted AS (
  INSERT INTO item_subgroups (code, description, parent_group)
  SELECT podgrupa, COALESCE(opis, ''), COALESCE(grupaveza, '0') FROM bb_stage
  ON CONFLICT (code) DO UPDATE SET description = EXCLUDED.description, parent_group = EXCLUDED.parent_group
    WHERE (item_subgroups.description, item_subgroups.parent_group)
          IS DISTINCT FROM (EXCLUDED.description, EXCLUDED.parent_group)
  RETURNING (xmax = 0) AS was_insert
)
SELECT (SELECT count(*) FROM bb_stage) || '|' ||
       count(*) FILTER (WHERE was_insert) || '|' ||
       count(*) FILTER (WHERE NOT was_insert) || '|' ||
       (SELECT count(*) FROM item_subgroups t WHERE NOT EXISTS (SELECT 1 FROM bb_stage s WHERE s.podgrupa = t.code))
FROM upserted;
COMMIT;
