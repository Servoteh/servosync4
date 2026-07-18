-- R_Grupa(Grupa, Opis) -> item_groups(code, description). One transaction.
-- Stage column order MUST match R_Grupa storage order (\copy is positional).
BEGIN;
CREATE TEMP TABLE bb_stage (grupa varchar(10), opis varchar(50)) ON COMMIT DROP;
\copy bb_stage FROM '/tmp/bb/item_groups.csv' WITH (FORMAT csv, HEADER true, ENCODING 'UTF8')
WITH upserted AS (
  INSERT INTO item_groups (code, description)
  SELECT grupa, COALESCE(opis, '') FROM bb_stage
  ON CONFLICT (code) DO UPDATE SET description = EXCLUDED.description
    WHERE (item_groups.description) IS DISTINCT FROM (EXCLUDED.description)
  RETURNING (xmax = 0) AS was_insert
)
SELECT (SELECT count(*) FROM bb_stage) || '|' ||
       count(*) FILTER (WHERE was_insert) || '|' ||
       count(*) FILTER (WHERE NOT was_insert) || '|' ||
       (SELECT count(*) FROM item_groups t WHERE NOT EXISTS (SELECT 1 FROM bb_stage s WHERE s.grupa = t.code))
FROM upserted;
COMMIT;
