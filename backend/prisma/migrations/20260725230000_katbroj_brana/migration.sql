-- ============================================================================
-- BRANA za kataloški broj artikla (DB audit DB-081; zahtev Nenada 25.07.2026:
-- „kataloški broj mora biti jedinstven — dalje kreiranje zabraniti na svaki način")
-- ============================================================================
-- STANJE: `items` je BigBit sync-keš sa 1.980 istorijskih duplikat-grupa
-- (4.298 artikala, izmereno 25.07). BigBit je unos novih duplikata već zabranio;
-- postojeći se čiste ručno (radni dokument KATBROJ_ciscenje_*.csv).
--
-- TRI SLOJA ODBRANE (ovaj fajl uvodi 1 i 2; 3 ide po čišćenju izvora):
--   1. RATCHET TRIGGER (ovde): odbija SVAKI nov duplikat i svaku promenu šifre
--      u već zauzetu vrednost, ali TOLERIŠE postojeće duplikate (da sync i
--      ažuriranja zatečenih redova rade). Case-insensitive, trimovano.
--   2. Sync guard (kod, `SOURCE_UNIQUE_FIELDS`): duplikat iz izvora se preskače
--      PRE upisa i beleži u sync log — 3.0 ga nikad ne dobije, sync ne pada.
--   3. TVRD UNIQUE INDEKS (posle čišćenja BigBit-a — komanda na dnu fajla):
--      poslednja reč; važi i pod `session_replication_role='replica'`.
--
-- ⚠️ Trigger NAMERNO nije `ENABLE ALWAYS`: full-refresh sync radi u replica
-- režimu (trigeri isključeni) i jedan duplikat iz izvora bi oborio ceo chunk →
-- šifarnik artikala bi ostao prazan. Sloj 2 (kod) pokriva baš taj put.
-- ============================================================================

-- Funkcionalni indeks (i priprema za budući UNIQUE) — bez njega je provera u
-- trigeru seq scan nad 92k artikala pri svakom upisu.
CREATE INDEX IF NOT EXISTS "idx_items_catalog_lower"
  ON "items" (lower(btrim(coalesce(catalog_number, ''))));

CREATE OR REPLACE FUNCTION trg_items_catalog_unique() RETURNS trigger AS $$
DECLARE
  v_key   text;
  v_other integer;
BEGIN
  v_key := lower(btrim(coalesce(NEW.catalog_number, '')));
  IF v_key = '' THEN
    RETURN NEW; -- prazan broj nije predmet jedinstvenosti (istorijski legacy)
  END IF;

  -- Ažuriranje reda koje NE dira šifru je uvek dozvoljeno (postojeći duplikati
  -- se smeju održavati: naziv, cena, JM… — čisti se u BigBit-u, ne ovde).
  IF TG_OP = 'UPDATE'
     AND lower(btrim(coalesce(OLD.catalog_number, ''))) = v_key THEN
    RETURN NEW;
  END IF;

  SELECT id INTO v_other
  FROM items
  WHERE lower(btrim(coalesce(catalog_number, ''))) = v_key
    AND id <> NEW.id
  LIMIT 1;

  IF v_other IS NOT NULL THEN
    RAISE EXCEPTION
      'CATALOG_NUMBER_DUPLICATE: kataloški broj "%" već postoji (artikal id=%). Duplikati nisu dozvoljeni — koristi postojeći artikal ili dodeli novu šifru.',
      NEW.catalog_number, v_other
      USING ERRCODE = 'unique_violation';
  END IF;

  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS guard_catalog_unique ON items;
CREATE TRIGGER guard_catalog_unique
  BEFORE INSERT OR UPDATE OF catalog_number ON items
  FOR EACH ROW EXECUTE FUNCTION trg_items_catalog_unique();

-- ── SLOJ 3 — pustiti TEK kad je izvor očišćen (provera mora vratiti 0) ───────
--   SELECT count(*) FROM (SELECT lower(btrim(catalog_number)) FROM items
--     WHERE btrim(coalesce(catalog_number,'')) <> ''
--     GROUP BY 1 HAVING count(*) > 1) d;
--
--   CREATE UNIQUE INDEX CONCURRENTLY uq_items_catalog_lower
--     ON items (lower(btrim(catalog_number)))
--     WHERE btrim(coalesce(catalog_number, '')) <> '';
--   DROP TRIGGER guard_catalog_unique ON items;   -- indeks preuzima posao
-- ─────────────────────────────────────────────────────────────────────────────
