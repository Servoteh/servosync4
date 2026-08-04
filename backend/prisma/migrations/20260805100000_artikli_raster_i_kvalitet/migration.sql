-- =============================================================================
-- ARTIKLI — ŠIFARNICI „DIMENZIJA (mm)" I „KVALITET ARTIKLA" + INDEKS ZA BIGBIT SORT
-- (05.08.2026 — paritet pregleda i forme artikala sa BigBitom)
-- =============================================================================
-- ── ZAŠTO ───────────────────────────────────────────────────────────────────
-- Ove dve tabele NISU nova ideja — backend ih sam vodi kao poznat nedostatak, u
-- `src/modules/masters/items.write-policy.ts`, u listi
-- `ITEM_FIELDS_REQUIRING_MIGRATION`:
--
--   • „`RasterDef*` (dimenzije table za `IDRaster`)" — „…bez tih tabela
--     `Item.rasterId` visi u prazno i obračun kg/kom (§4.10) nema odakle da
--     povuče širinu/dužinu — forma ih danas šalje kao prelazna polja koja se
--     NE PAMTE."
--   • „`R_KvalitetArtikla`" — „`Item.qualityTypeId` postoji, šifarnik ne —
--     vrednost se ne može ponuditi ni proveriti (§2.1)."
--
-- Praktična posledica na koju se ovaj paket odnosi: BigBit forma unosa artikla
-- (`Unos artikala`, y=12.54 i y=13.19 cm) ima dva padajuća spiska —
-- „Dimenzija (mm)" (`ComboRaster` → `RasterDefZag`) i „Kvalitet artikla"
-- (`R_KvalitetArtikla`). U 4.0 ta dva polja postoje na `items`
-- (`raster_id`, `quality_type_id`), ali nemaju šifarnik iza sebe, pa forma
-- korisniku NEMA ŠTA da ponudi — a `rasterWidthMm` / `rasterLengthMm` (koje
-- traži obračun kilograma po komadu lima, BIGBIT_ARTIKLI.md §4.10:
-- `Kutija = Debljina * VrstaRastera * KolonaRastera * 7850 / 1000000000`)
-- danas se nigde ne pamte.
--
-- `width_mm` / `length_mm` su `double precision`, a ne `Decimal`: to su
-- DIMENZIJE u milimetrima, ne novac — isti tip koji `items` već koristi za
-- `thickness`, `weight` i `weight_kg` (BACKEND_RULES §3 „Tipovi" traži Decimal
-- za novac/količine/procente).
--
-- ── ŠTA OVA MIGRACIJA NAMERNO NE RADI ───────────────────────────────────────
--   • NE otvara unos artikala — `ITEMS_WRITE_OPEN` ostaje `false` i
--     `items.write-policy.ts` se ne dira. Isporučuje se samo PREGLED i IZGLED.
--   • NEMA `setval` / `ALTER SEQUENCE` nad `items_id_seq`. Sekvenca je na
--     899.999.999, a `chk_items_native_id_range` vezuje `source = 'NATIVE'` za
--     `id >= 900000000` (migracija 20260728170000) — svako pomeranje lomi unos.
--   • NE upisuje nijedan red u `item_groups` / `item_subgroups` / `item_origins`.
--     Njih puni noćni .mdb uvoz (`bigbit-mdb-import.service.ts`) sa
--     `ON CONFLICT DO UPDATE`; već su puni (19 / 86 / 128 redova) i ručan INSERT
--     bi se sudario sa uvozom.
--   • NE dodaje btree indeks na `items(name)` ni `items(catalog_number)` — za
--     pretragu već postoje trigram GIN indeksi (20260726160000) i
--     `idx_items_catalog_lower`.
-- =============================================================================


-- ─────────────────────────────────────────────────────────────────────────────
-- 1) ŠIFARNIK KVALITETA ARTIKLA  (BigBit: R_KvalitetArtikla)
-- ─────────────────────────────────────────────────────────────────────────────
-- `id` je BigBit `IDKvalitetArtikla` i prenosi se doslovno (0 je važeća, aktivno
-- korišćena vrednost — default na `items.quality_type_id`), pa PK NIJE serial.
CREATE TABLE IF NOT EXISTS "item_quality_types" (
    "id" INTEGER NOT NULL,
    "code" VARCHAR(20) NOT NULL,
    "description" VARCHAR(50) NOT NULL,

    CONSTRAINT "pk_item_quality_types" PRIMARY KEY ("id")
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2) ŠIFARNIK RASTERA = DIMENZIJE TABLE/LIMA  (BigBit: RasterDefZag)
-- ─────────────────────────────────────────────────────────────────────────────
-- `id` je BigBit `IDRaster` (0 = „NEMA", default na `items.raster_id`).
-- `width_mm` / `length_mm` su `VrstaRastera` / `KolonaRastera` iz §4.10 — bez
-- njih obračun kg/kom nema ulaz.
CREATE TABLE IF NOT EXISTS "item_rasters" (
    "id" INTEGER NOT NULL,
    "name" VARCHAR(50) NOT NULL,
    "description" VARCHAR(50),
    "width_mm" DOUBLE PRECISION,
    "length_mm" DOUBLE PRECISION,

    CONSTRAINT "pk_item_rasters" PRIMARY KEY ("id")
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 3) SEED — DOSLOVNE BIGBIT VREDNOSTI
-- ─────────────────────────────────────────────────────────────────────────────
-- `ON CONFLICT (id) DO NOTHING`: seed je samo početno punjenje. Ako neki kasniji
-- uvoz iz .mdb-a donese iste šifre, on je merodavan — migracija mu ne gazi red.

-- NAPOMENA O „KVAKITET": opis reda id=0 u BigBitu doslovno glasi
-- „NE TREBA KVAKITET" (tipfeler POSTOJI U IZVORU, nije naša greška). Prenosi se
-- VERNO da bi 4.0 prikazivao istu vrednost koju korisnik vidi u BigBitu —
-- ispravka se, ako se ikada radi, radi u BigBitu pa dolazi kroz uvoz.
INSERT INTO "item_quality_types" ("id", "code", "description") VALUES
    (0, 'NE TREBA KVALITET', 'NE TREBA KVAKITET'),
    (1, 'S235JR', 'S235JR')
ON CONFLICT ("id") DO NOTHING;

-- `id = 1` U BIGBITU NE POSTOJI (rupa u nizu) — namerno se ne izmišlja.
INSERT INTO "item_rasters" ("id", "name", "description", "width_mm", "length_mm") VALUES
    (0, 'NEMA',      'NEMA',      NULL, NULL),
    (2, '1500x3000', '1500x3000', 1500, 3000),
    (3, '1250x2500', '1250x2500', 1250, 2500),
    (4, '2000x3000', '2000x3000', 2000, 3000),
    (5, '1500x6000', '1500x6000', 1500, 6000)
ON CONFLICT ("id") DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4) INDEKS ZA BIGBIT REDOSLED PREGLEDA ARTIKALA
-- ─────────────────────────────────────────────────────────────────────────────
-- BigBit „Pregled artikala" sortira `ORDER BY Grupa, Kataloski broj, Naziv`, a
-- filter po grupi je najčešći ulaz u listu.
--
-- Kolone indeksa moraju da prate `orderBy` iz `masters/items.service.ts`
-- DOSLOVNO — tamo stoji `groupCode, catalogNumber, name, id`. Raniji nacrt je
-- izostavljao `name`, pa je planer nad tri vodeće kolone i dalje morao da
-- dosortira po `name` (incremental sort) — indeks je tada bio pola posla.
-- `id` je na kraju kao tie-breaker za stabilnu paginaciju (`skip` + `take`).
--
-- ŠTA SE OD OVOGA STVARNO DOBIJA (bez uveličavanja): sort nestaje samo kad upit
-- ne nosi uslov koji planera odvuče na drugi indeks — dakle za pregled bez
-- filtera i za filter po grupi/podgrupi (najčešći ulaz). Pretraga po nazivu ili
-- kataloškom broju ide na trigram GIN / `idx_items_catalog_lower`, tamo se
-- sortira posle filtriranja i ovaj indeks ne učestvuje. Nad 92.511 redova to je
-- razlika reda „pun sort svake strane" → „čitanje u redosledu indeksa" na
-- nefiltriranom pregledu, ne ubrzanje svih upita nad artiklima.
--
-- Bez `CONCURRENTLY` — Prisma svaku migraciju vozi u transakciji, a
-- `CREATE INDEX CONCURRENTLY` u transakciji ne sme; nad 92k redova gradnja je
-- kratka i zaključavanje je zanemarljivo.
CREATE INDEX IF NOT EXISTS "idx_items_group_catalog" ON "items" ("group_code", "catalog_number", "name", "id");
