-- R_Artikli_Ino -> item_translations. UPSERT key = COMPOSITE (item_id, language_id):
-- izvor NEMA surogat id kolonu, PK je poslovni par (IDArtikal, IDJezik). Nema sekvence
-- pa nema ni setval-a.
--
-- Stage column order MUST match R_Artikli_Ino storage order (BB_T_26_schema.sql
-- :1009-1015; \copy is positional, header se preskace).
--
-- !!! item_id NIJE items.id !!! IDArtikal je BIGBIT sifra artikla = items.external_item_id
-- (BIGBIT_ARTIKLI.md 5.1). Upisuje se sirova; masters API razresava artikal preko
-- external_item_id.
--
-- IDJezik: sifarnik jezika nije pronadjen u BigBit izvozu (BIGBIT_ARTIKLI.md 8, pitanje 4)
-- -> prenosi se kao broj, bez pokusaja mapiranja u ISO oznaku.
--
-- Red bez naziva (InoNazivArt prazan) je bezvredan prevod i NE ulazi -- cilj je NOT NULL,
-- a prazan strani naziv bi u kartonu izgledao kao postojeci prevod.
BEGIN;
CREATE TEMP TABLE bb_stage (
  idartikal int, idjezik int, inonazivart varchar(50), inojmart varchar(5)
) ON COMMIT DROP;
\copy bb_stage FROM '/tmp/bb/item_translations.csv' WITH (FORMAT csv, HEADER true, ENCODING 'UTF8')
WITH src AS (
  SELECT idartikal AS item_id, idjezik AS language_id,
         btrim(inonazivart)          AS foreign_name,
         NULLIF(btrim(inojmart), '') AS foreign_unit
  FROM bb_stage
  WHERE idartikal IS NOT NULL AND idjezik IS NOT NULL
    AND NULLIF(btrim(inonazivart), '') IS NOT NULL
), upserted AS (
  INSERT INTO item_translations (item_id, language_id, foreign_name, foreign_unit)
  SELECT item_id, language_id, foreign_name, foreign_unit FROM src
  ON CONFLICT (item_id, language_id) DO UPDATE SET
    foreign_name = EXCLUDED.foreign_name, foreign_unit = EXCLUDED.foreign_unit
    WHERE (item_translations.foreign_name, item_translations.foreign_unit)
      IS DISTINCT FROM (EXCLUDED.foreign_name, EXCLUDED.foreign_unit)
  RETURNING (xmax = 0) AS was_insert
)
SELECT (SELECT count(*) FROM src) || '|' ||
       count(*) FILTER (WHERE was_insert) || '|' ||
       count(*) FILTER (WHERE NOT was_insert) || '|' ||
       (SELECT count(*) FROM item_translations t
          WHERE NOT EXISTS (SELECT 1 FROM bb_stage s
                            WHERE s.idartikal = t.item_id AND s.idjezik = t.language_id))
FROM upserted;
COMMIT;
