-- Talas AI-1, tačka 1 — pretraga bez kvačica nad proizvodnim jezgrom glavne baze.
--
-- Problem (mereno, plan §2.1): pretraga artikala/nacrta/naloga je goli `ILIKE
-- '%pojam%'` nad tabelama do 92k redova → Seq Scan i, još gore, promašaj na
-- dijakritici („zaptivac" nađe 6, „zaptivač" 44). Rešenje bez nove zavisnosti i
-- bez zamene Postgres image-a: `unaccent` + `pg_trgm` (oba u stock `postgres:18`
-- image-u — provereno na dev bazi 26.07: pg_trgm 1.6, unaccent 1.1; `vector`
-- NIJE dostupan, zato RAG i dalje čeka image swap iz Talasa AI-2).
--
-- IMMUTABLE omotač: `unaccent(text)` je STABLE (zavisi od `search_path`-a za
-- rečnik) pa se NE sme direktno indeksirati. Standardni recept je dvoargumentni
-- oblik sa eksplicitnim `regdictionary`, koji JESTE immutable, umotan u
-- sopstvenu IMMUTABLE funkciju. Indeks i upit MORAJU koristiti IDENTIČAN izraz
-- (`public.immutable_unaccent(lower(kolona))`), inače planer ne prepoznaje
-- indeks — zato ovaj izraz živi na jednom mestu i u kodu (`core-tools.ts`).
--
-- CREATE INDEX (bez CONCURRENTLY): `prisma migrate deploy` vrti migraciju u
-- transakciji, a CONCURRENTLY u transakciji ne radi. Tabele su do ~92k redova
-- (items), pa je ShareLock kratak (mereno na privremenoj bazi sa 30k redova:
-- GIN trgm indeks < 1 s). Ako se ikad pravi na tabeli u punom pogonu, važi
-- presedan migracije 20260716120000: indeks se prvo napravi CONCURRENTLY ručno,
-- a migracija zbog `IF NOT EXISTS` postane NO-OP.

CREATE EXTENSION IF NOT EXISTS unaccent WITH SCHEMA public;
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;

-- IMMUTABLE + PARALLEL SAFE + STRICT: uslov da izraz sme u indeks.
CREATE OR REPLACE FUNCTION public.immutable_unaccent(text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
STRICT
AS $$ SELECT public.unaccent('public.unaccent'::regdictionary, $1) $$;

-- items (92k na produkciji) — naziv + kataloški broj (alat `nadji_artikal`).
CREATE INDEX IF NOT EXISTS "idx_items_name_trgm"
  ON "items" USING gin (public.immutable_unaccent(lower("name")) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "idx_items_catalog_number_trgm"
  ON "items" USING gin (public.immutable_unaccent(lower("catalog_number")) gin_trgm_ops);

-- drawings — naziv + broj crteža (alat `istorija_crteza`, kasnije pretraga nacrta).
CREATE INDEX IF NOT EXISTS "idx_drawings_name_trgm"
  ON "drawings" USING gin (public.immutable_unaccent(lower("name")) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "idx_drawings_drawing_number_trgm"
  ON "drawings" USING gin (public.immutable_unaccent(lower("drawing_number")) gin_trgm_ops);

-- work_orders (40.860) — ident broj + naziv dela; alat `nadji_radni_nalog` traži
-- po oba, pa oba moraju imati indeks (inače je „po nazivu" i dalje Seq Scan).
CREATE INDEX IF NOT EXISTS "idx_work_orders_ident_number_trgm"
  ON "work_orders" USING gin (public.immutable_unaccent(lower("ident_number")) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "idx_work_orders_part_name_trgm"
  ON "work_orders" USING gin (public.immutable_unaccent(lower("part_name")) gin_trgm_ops);

-- projects — opis predmeta (alat `stanje_predmeta`; broj predmeta ide preko
-- parcijalnog unique indeksa iz 20260725200000, njemu trigram ne treba).
CREATE INDEX IF NOT EXISTS "idx_projects_description_trgm"
  ON "projects" USING gin (public.immutable_unaccent(lower("description")) gin_trgm_ops);
