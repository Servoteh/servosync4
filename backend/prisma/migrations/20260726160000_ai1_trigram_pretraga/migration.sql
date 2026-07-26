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

COMMENT ON FUNCTION public.immutable_unaccent(text) IS
  'IMMUTABLE omotač za unaccent (dvoargumentni regdictionary oblik). Nosi ga migracija 20260726160000. '
  'UPOZORENJE: telo funkcije zavisi od rečnika iz ekstenzije `unaccent`, ali PostgreSQL tu zavisnost NE '
  'zapisuje u pg_depend (referenca je tekst u telu SQL funkcije). DROP EXTENSION unaccent zato PROLAZI '
  'bez greške, a svi trigram indeksi koji koriste ovu funkciju u tom trenutku postaju NEUPOTREBLJIVI '
  '(svaki SELECT nad njima puca sa „text search dictionary unaccent does not exist"). '
  'Ekstenzija unaccent se ne skida bez prethodnog uklanjanja idx_*_trgm indeksa i ove funkcije.';

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

-- work_time_entries (99k prijava rada) — SVE dosadašnje putanje su išle preko
-- `tech_process_id`, pa tabela nema indeks po nalogu. Alat
-- `tehnoloski_postupak_naloga` filtrira po (work_order_id, operation_number) u
-- LATERAL-u — dakle JEDNOM PO OPERACIJI naloga → do 40 Seq Scan-ova preko 99k
-- redova u jednom pozivu. Isti indeks koristi i agregat `istorija_crteza`.
CREATE INDEX IF NOT EXISTS "idx_work_time_entries_work_order"
  ON "work_time_entries" ("work_order_id", "operation_number");
