-- =============================================================================
-- MATIČNI PODACI (KOMITENTI + ARTIKLI): ODVOJEN OPSEG KLJUČEVA, MARKER POREKLA,
-- FALEĆE KOLONE I PRATEĆE TABELE
-- (28.07.2026 — adversarni pregled BigBit remedijacije, nalazi 1–4)
-- =============================================================================
-- Cilj: skloniti SVE prepreke iz šeme koje danas drže unos komitenata i artikala
-- zatvorenim, tako da se unos posle otvara PREKLAPANJEM JEDNOG PREKIDAČA
-- (`CUSTOMERS_WRITE_OPEN`, `assertItemWritesAllowed()`), bez ijednog novog
-- otkrića u tom trenutku. Migracija NE OTVARA nijedan prekidač.
--
-- ── ZAŠTO (nalazi pregleda) ─────────────────────────────────────────────────
-- [1] SUDAR KLJUČEVA. `customers.id` JESTE BigBit `Sifra` (PK se ne remapira,
--     BIGBIT_KOMITENTI.md §5.1), a `alignIdSequence` poravnava sekvencu sa
--     `MAX(id)`. Izmereno na produkciji 28.07.2026:
--         customers: 6.251 red, MAX(id) = 1.006.067, customers_id_seq = 1.006.063
--     Prvi 4.0-native unos bi uzeo 1.006.064 (rupa u BigBit prostoru), a već
--     sledeći 1.006.068 — TAČNO broj koji BigBit dodeljuje sledećem komitentu.
--     `CustomerSyncer.upsert({where:{id}, update:data})` bi tada prepisao svih 56
--     polja tuđom firmom, bez greške i bez traga.
--         items: 92.511 redova, MAX(id) = 93.513, items_id_seq = 1 (is_called=t)
--     → `nextval` danas vraća 2, a to je ŽIV artikal (23505 ili squatter).
--
-- [2] `items` sync radi `deleteMany({})` + `createMany` (watermark: null) → red
--     nastao u 4.0 bi bio OBRISAN. Ovo migracija NE rešava (to je odluka u
--     `sync/table-ownership.ts`, tuđa granica) — ali odvojen opseg ključeva +
--     marker porekla su preduslov da se ta odluka uopšte može doneti bezbedno.
--
-- [4] `customers.update()` nema proveru porekla reda (artikli imaju
--     `assertItemIsNative` preko opsega id-a). Bez kolone koja se može UPITATI,
--     provera porekla je konvencija, ne činjenica. Ova migracija daje kolonu.
--
-- ── ŠTA OVA MIGRACIJA NAMERNO NE RADI ───────────────────────────────────────
--   • NE otvara `CUSTOMERS_WRITE_OPEN` niti `assertItemWritesAllowed()`;
--   • NE dira `sync/table-ownership.ts` skupove (tuđa granica) — `items` i dalje
--     prolazi kroz destruktivan full refresh i upis ostaje zatvoren;
--   • NE dodaje `RasterDef*` / `R_Artikli_BarKod` / `R_Artikli_Ino` /
--     `ArtikliSlike` / `R_KvalitetArtikla` / `MestaIzdavanja` /
--     `DobavljaciZaArtikal` / `Rabati*` / `Akcije*` (zaseban talas);
--   • NE upisuje nijedan `customer_contacts` / `customer_delivery_locations` red
--     i NE dodaje te tabele ni u kakav sync — BigBit ih ne šalje kroz našu kopiju.
-- =============================================================================


-- ─────────────────────────────────────────────────────────────────────────────
-- 1) MARKER POREKLA NA `customers` (nalaz [4])
-- ─────────────────────────────────────────────────────────────────────────────
-- Dve kolone koje se međusobno kontrolišu:
--
--   `source`   — FAIL-SAFE marker. NOT NULL DEFAULT 'BIGBIT' je namerno: svaki
--                pisac koji za kolonu NE ZNA (danas `CustomerSyncer.mapRow`, koji
--                mapira 56 kolona i ovu ne pominje) upisuje red kao BigBit-origin,
--                tj. kao READ-ONLY. Smer greške je jedini bezbedan: native red
--                pogrešno označen kao BIGBIT se ne da menjati (nezgodno, ali
--                bezopasno), dok bi BigBit red pogrešno označen kao NATIVE bio
--                izmenjiv, a izmena bi nestala na sledećem delta prolazu — tačno
--                bag zbog kog ovaj paket postoji.
--
--   `bb_sifra` — TRACEBACK do BigBit ključa + priprema za razdvajanje prostora.
--                Danas je `id` == `Sifra`, pa je backfill trivijalan i tačan.
--                Kad 4.0 jednom bude čitao BigBit direktno (Sync B), upsert sme
--                da ključa na `bb_sifra`, a ne više na `id` — i tek tada su dva
--                prostora ključeva stvarno razdvojena.
--                NULL = red nastao u 4.0. Upit `WHERE bb_sifra IS NULL` je
--                nezavisna provera porekla (isti obrazac kao `imported_drop_id`
--                u noćnom .mdb uvozu: „NULL = nastalo u 4.0").

ALTER TABLE "customers"
  ADD COLUMN IF NOT EXISTS "source"   VARCHAR(10) NOT NULL DEFAULT 'BIGBIT',
  ADD COLUMN IF NOT EXISTS "bb_sifra" INTEGER;

COMMENT ON COLUMN "customers"."source" IS
  'Poreklo reda: BIGBIT (matični podatak koji vlada BigBit — READ-ONLY u 4.0) | NATIVE (nastao u 4.0). DEFAULT je namerno BIGBIT: pisac koji za kolonu ne zna ne sme da proizvede izmenjiv red.';
COMMENT ON COLUMN "customers"."bb_sifra" IS
  'BigBit `Komitenti.Sifra` ovog reda. NULL = red nastao u 4.0. Za BigBit redove jednako `id` (PK se ne remapira, BIGBIT_KOMITENTI.md §5.1); popunjava ga trigger `trg_customers_bb_sifra`.';

-- BACKFILL: svaki ZATEČEN red je BigBit-origin (do danas je jedini pisac tabele
-- `CustomerSyncer`; `CUSTOMERS_WRITE_OPEN=false` od 26.07.2026).
UPDATE "customers" SET "bb_sifra" = "id" WHERE "bb_sifra" IS NULL AND "source" = 'BIGBIT';

-- Jedan BigBit `Sifra` sme pripadati najviše jednom redu. Kolona je NULL-abilna,
-- a PG unique indeks tretira NULL-ove kao različite → 4.0-native redovi (svi sa
-- NULL) se ne sudaraju međusobno.
CREATE UNIQUE INDEX IF NOT EXISTS "uq_customers_bb_sifra" ON "customers" ("bb_sifra");

-- Trigger koji drži `bb_sifra` tačnim BEZ IZMENE `customer.syncer.ts` (tuđa
-- granica): syncer i dalje radi `upsert({where:{id}, create:data, update:data})`
-- i ne zna za kolonu — trigger je popuni iz `id`, jer za BigBit redove to JESTE
-- ista vrednost.
-- `ENABLE ALWAYS` je obavezno: generički full refresh radi pod
-- `session_replication_role='replica'`, gde obični (ORIGIN) trigeri NE RADE.
CREATE OR REPLACE FUNCTION "customers_set_bb_sifra"() RETURNS trigger AS $fn$
BEGIN
  IF NEW."source" = 'NATIVE' THEN
    -- 4.0-native red nema BigBit šifru, ma šta pisac poslao.
    NEW."bb_sifra" := NULL;
  ELSIF NEW."bb_sifra" IS NULL THEN
    -- BigBit red: `id` JESTE `Sifra`.
    NEW."bb_sifra" := NEW."id";
  END IF;
  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "trg_customers_bb_sifra" ON "customers";
CREATE TRIGGER "trg_customers_bb_sifra"
  BEFORE INSERT OR UPDATE OF "source", "bb_sifra", "id" ON "customers"
  FOR EACH ROW EXECUTE FUNCTION "customers_set_bb_sifra"();
ALTER TABLE "customers" ENABLE ALWAYS TRIGGER "trg_customers_bb_sifra";


-- ─────────────────────────────────────────────────────────────────────────────
-- 2) MARKER POREKLA NA `items` — isti odgovor na isto pitanje (nalaz [3])
-- ─────────────────────────────────────────────────────────────────────────────
-- Artikli danas poreklo zaključuju ISKLJUČIVO iz opsega id-a
-- (`isNativeItemId`, `items.write-policy.ts`). `external_item_id` (= BigBit
-- `Sifra artikla`) postoji, ali NIJE upotrebljiv kao jedini kriterijum: izmereno
-- na produkciji 28.07.2026 — 1.417 od 92.511 artikala ima `external_item_id = 0`
-- iako su svi BigBit-origin. Zato i artikli dobijaju eksplicitan `source`, sa
-- istim fail-safe default-om kao komitenti. Dva paketa, JEDAN odgovor.
ALTER TABLE "items"
  ADD COLUMN IF NOT EXISTS "source" VARCHAR(10) NOT NULL DEFAULT 'BIGBIT';

COMMENT ON COLUMN "items"."source" IS
  'Poreklo reda: BIGBIT (vlada BigBit — READ-ONLY u 4.0) | NATIVE (nastao u 4.0). Nezavisno od `external_item_id`, koji je 0 na 1.417 BigBit redova pa sam za sebe ne razlikuje poreklo.';


-- ─────────────────────────────────────────────────────────────────────────────
-- 3) REZERVISAN OPSEG KLJUČEVA ZA 4.0-NATIVE REDOVE (nalaz [1] — najvažnije)
-- ─────────────────────────────────────────────────────────────────────────────
-- GRANICA = 900.000.000 za OBE tabele. Obrazloženje brojevima:
--
--   • Tip kolone je `integer` (int4) u obe tabele → tvrd plafon 2.147.483.647.
--   • ARTIKLI: BigBit `Sifra artikla` danas ide do 127.584 (MAX
--     `items.external_item_id`), QBigTehn IDENTITY do 93.513 (MAX `items.id`).
--     900.000.000 ostavlja BigBit-u ~899,87 miliona ključeva (≈7.000× današnja
--     potrošnja), a 4.0-native prostoru 1.247.483.647 ključeva. Izbor koji je
--     paket artikala već napravio je BEZBEDAN — ostaje.
--   • KOMITENTI: BigBit `Sifra` danas ide do 1.006.067. Raspored je bimodalan:
--     770 redova < 100.000, NIJEDAN u [100.000, 1.000.000), 5.481 red ≥ 1.000.000.
--     Taj skok je dokaz da je BigBit prostor ključeva JEDNOM VEĆ REBAZIRAN
--     naviše — granica mora preživeti i sledeći takav skok. 900.000.000 ga
--     preživljava i pri rebazi na 10 ili 100 miliona; da bi ga BigBit dostigao
--     prirodnim rastom trebalo bi ~900 miliona novih komitenata (danas ih ima
--     6.251 ukupno).
--   • Ista vrednost za obe tabele je namerna: jedno pravilo, jedna konstanta,
--     jedan test — umesto „dva paketa, dva odgovora" iz pregleda.
--
-- Sekvenca se pomera IZNAD BigBit prostora: `setval(seq, 899.999.999, true)` →
-- prvi `nextval` vraća tačno 900.000.000, što se poklapa sa `MAX(id)+1` računicom
-- iz `items.service.ts` (`COALESCE(MAX(id), BASE-1) + 1 WHERE id >= BASE`).
--
-- ⚠️ IDEMPOTENTNOST: u `GREATEST` ulazi i TRENUTNA pozicija sekvence, pa drugi
--    (i svaki sledeći) prolaz NE MOŽE da je pomeri unazad ni kad su native redovi
--    u međuvremenu potrošili deo opsega.
DO $$
DECLARE
  base    bigint := 900000000;
  t       text;
  seq     text;
  cur     bigint;
  max_nat bigint;
  target  bigint;
BEGIN
  FOREACH t IN ARRAY ARRAY['customers', 'items'] LOOP
    seq := pg_get_serial_sequence(t, 'id');
    IF seq IS NULL THEN
      RAISE EXCEPTION 'Tabela % nema identity sekvencu za kolonu id', t;
    END IF;

    -- Trenutna pozicija sekvence, bez trošenja vrednosti. `is_called=false`
    -- znači da `last_value` još nije izdat, pa je stvarna pozicija za 1 manja.
    EXECUTE format(
      'SELECT last_value - (CASE WHEN is_called THEN 0 ELSE 1 END) FROM %s', seq
    ) INTO cur;

    -- Najveći VEĆ ZAUZET native id (0 ako ih još nema).
    EXECUTE format(
      'SELECT COALESCE(MAX(id), 0) FROM %I WHERE id >= $1', t
    ) INTO max_nat USING base;

    target := GREATEST(base - 1, max_nat, cur);
    PERFORM setval(seq, target, true);

    RAISE NOTICE 'Sekvenca % : % -> % (sledeći nextval = %)', seq, cur, target, target + 1;
  END LOOP;
END $$;

-- ── BRANE OPSEGA: CHECK, ne konvencija ──────────────────────────────────────
-- CHECK constraint VAŽI I U `replica` REŽIMU (nije trigger), pa ga ne može
-- zaobići ni destruktivan full refresh. Tri male, imenovane brane umesto jedne
-- velike — poruka o grešci odmah kaže ŠTA je prekršeno.
--
-- Efekat: native red FIZIČKI NE MOŽE da sedne u BigBit prostor ključeva. Time
-- `CustomerSyncer.upsert({where:{id}})` više nikad ne može da pogodi 4.0-native
-- red — nalaz [1] je zatvoren na nivou baze, ne dogovorom.
--
-- Provereno pre dodavanja (produkcija 28.07.2026): 0 redova u native opsegu u
-- obe tabele, pa nijedna brana ne pada na zatečenim podacima.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_customers_source') THEN
    ALTER TABLE "customers" ADD CONSTRAINT "chk_customers_source"
      CHECK ("source" IN ('BIGBIT', 'NATIVE'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_customers_native_id_range') THEN
    ALTER TABLE "customers" ADD CONSTRAINT "chk_customers_native_id_range"
      CHECK (("source" = 'NATIVE') = ("id" >= 900000000));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_customers_bb_sifra_origin') THEN
    ALTER TABLE "customers" ADD CONSTRAINT "chk_customers_bb_sifra_origin"
      CHECK (("bb_sifra" IS NULL) = ("source" = 'NATIVE'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_items_source') THEN
    ALTER TABLE "items" ADD CONSTRAINT "chk_items_source"
      CHECK ("source" IN ('BIGBIT', 'NATIVE'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_items_native_id_range') THEN
    ALTER TABLE "items" ADD CONSTRAINT "chk_items_native_id_range"
      CHECK (("source" = 'NATIVE') = ("id" >= 900000000));
  END IF;
END $$;


-- ─────────────────────────────────────────────────────────────────────────────
-- 4) FALEĆE KOLONE
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 4a) `customers.KoristiPNBZadModel` — jedina od 57 BigBit kolona koje nemamo
-- (BIGBIT_KOMITENTI.md §1, F1 „56/57"). Boolean NOT NULL u originalu.
-- ⚠️ `CustomerSyncer.mapRow` je NE ČITA (mapira 56 kolona) — dok se ne doda u
--    syncer, vrednost ostaje na default-u. To je granica sync tima, ne ova.
ALTER TABLE "customers"
  ADD COLUMN IF NOT EXISTS "uses_payment_reference_model" BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN "customers"."uses_payment_reference_model" IS
  'BigBit `Komitenti.KoristiPNBZadModel` — komitent koristi zadati model poziva na broj. NAPOMENA: `customer.syncer.ts` ovu kolonu još ne čita iz izvora.';

-- ── 4b) `items.shelf` VARCHAR(10) → VARCHAR(20)
-- BigBit `R_Artikli.Polica` je Text(20); QBigTehn kopija ju je suzila na 10 i
-- naša šema je to nasledila. Izmereno na produkciji: 82 artikla imaju TAČNO 10
-- znakova, tj. skoro sigurno već ODSEČENU vrednost. Proširenje sprečava dalje
-- odsecanje; ODSEČENE VREDNOSTI SE OVIM NE VRAĆAJU — dopuni ih sledeći pun uvoz
-- ili ručna ispravka (v. izveštaj).
-- Sužavanje bi zahtevalo rewrite; proširenje `varchar(n)` je samo katalog. Guard
-- čini korak idempotentnim.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'items'
      AND column_name = 'shelf' AND character_maximum_length < 20
  ) THEN
    ALTER TABLE "items" ALTER COLUMN "shelf" TYPE VARCHAR(20);
  END IF;
END $$;

-- ── 4c) `items.updated_at` + ko je izmenio
-- Artikal danas ima samo `created_at` (`DatumIVremeArt`) i `signature`
-- (`PotpisArt` — ko), pa `PATCH` ne ostavlja NIKAKAV trag u vremenu. Komitent
-- oba polja već ima (`updated_at`/`updated_by`), artikal ih nema.
-- NULL-abilne su namerno: zatečenih 92.511 redova nikad nije menjano iz 4.0 i
-- lažni „izmenjeno danas" bio bi gori od praznog polja.
ALTER TABLE "items"
  ADD COLUMN IF NOT EXISTS "updated_at" TIMESTAMP(6),
  ADD COLUMN IF NOT EXISTS "updated_by" VARCHAR(50);

COMMENT ON COLUMN "items"."updated_at" IS
  'Vreme poslednje izmene IZ 4.0. NULL = nikad menjan iz 4.0 (BigBit izmene stižu kroz sync i ovo polje ne diraju).';
COMMENT ON COLUMN "items"."updated_by" IS
  'Ko je poslednji menjao artikal iz 4.0 (`auditName`). Razlikuje se od `signature` (BigBit `PotpisArt`).';

-- ── 4d) 9 cenovnih kolona artikla: `double precision` → `NUMERIC(19,4)`
-- BACKEND_RULES: novac je `Prisma.Decimal`, NIKAD `Float`. Kolone su nasleđene
-- iz BigBit `Double`.
--
-- BEZBEDNOST KONVERZIJE — izmereno na SVIH 92.511 produkcionih redova
-- (28.07.2026), po koloni: 0 vrednosti se menja pri `::numeric(19,4)`,
-- 0 vrednosti prelazi 10^15 (overflow), 0 NaN/Infinity. Najveća apsolutna
-- vrednost u celom skupu je 59.000 (`wholesale_price`) — daleko ispod precision
-- 19. Konverzija je dakle TAČNA, bez ijednog zaokruženog reda.
--
-- `ROUND(col::numeric, 4)` umesto golog `::numeric(19,4)`: `float8::numeric` u
-- PG ≥ 12 daje najkraću decimalnu reprezentaciju (0.1 → 0.1, ne
-- 0.1000000000000000055), pa je rezultat baš ono što je izmereno.
-- DROP DEFAULT pre promene tipa — inače PG odbija da prekastuje `DEFAULT 0`.
-- Sve u JEDNOM `ALTER TABLE` = jedan rewrite tabele, ne devet.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'items'
      AND column_name = 'wholesale_price' AND data_type = 'double precision'
  ) THEN
    EXECUTE $sql$
      ALTER TABLE "items"
        ALTER COLUMN "wholesale_price"           DROP DEFAULT,
        ALTER COLUMN "wholesale_price"           TYPE NUMERIC(19,4) USING ROUND("wholesale_price"::numeric, 4),
        ALTER COLUMN "wholesale_price"           SET DEFAULT 0,
        ALTER COLUMN "retail_price"              DROP DEFAULT,
        ALTER COLUMN "retail_price"              TYPE NUMERIC(19,4) USING ROUND("retail_price"::numeric, 4),
        ALTER COLUMN "retail_price"              SET DEFAULT 0,
        ALTER COLUMN "fx_purchase_price"         DROP DEFAULT,
        ALTER COLUMN "fx_purchase_price"         TYPE NUMERIC(19,4) USING ROUND("fx_purchase_price"::numeric, 4),
        ALTER COLUMN "fx_purchase_price"         SET DEFAULT 0,
        ALTER COLUMN "fx_sale_price"             DROP DEFAULT,
        ALTER COLUMN "fx_sale_price"             TYPE NUMERIC(19,4) USING ROUND("fx_sale_price"::numeric, 4),
        ALTER COLUMN "fx_sale_price"             SET DEFAULT 0,
        ALTER COLUMN "price_to_write_pricelist"  DROP DEFAULT,
        ALTER COLUMN "price_to_write_pricelist"  TYPE NUMERIC(19,4) USING ROUND("price_to_write_pricelist"::numeric, 4),
        ALTER COLUMN "price_to_write_pricelist"  SET DEFAULT 0,
        ALTER COLUMN "item_fee"                  DROP DEFAULT,
        ALTER COLUMN "item_fee"                  TYPE NUMERIC(19,4) USING ROUND("item_fee"::numeric, 4),
        ALTER COLUMN "item_fee"                  SET DEFAULT 0,
        ALTER COLUMN "item_excise"               DROP DEFAULT,
        ALTER COLUMN "item_excise"               TYPE NUMERIC(19,4) USING ROUND("item_excise"::numeric, 4),
        ALTER COLUMN "item_excise"               SET DEFAULT 0,
        ALTER COLUMN "non_taxable_part"          DROP DEFAULT,
        ALTER COLUMN "non_taxable_part"          TYPE NUMERIC(19,4) USING ROUND("non_taxable_part"::numeric, 4),
        ALTER COLUMN "non_taxable_part"          SET DEFAULT 0,
        ALTER COLUMN "final_processing_cost"     DROP DEFAULT,
        ALTER COLUMN "final_processing_cost"     TYPE NUMERIC(19,4) USING ROUND("final_processing_cost"::numeric, 4),
        ALTER COLUMN "final_processing_cost"     SET DEFAULT 0
    $sql$;
  END IF;
END $$;


-- ─────────────────────────────────────────────────────────────────────────────
-- 5) PRATEĆE TABELE KOMITENTA — 4.0-NATIVE, VAN SVAKOG SYNC-a
-- ─────────────────────────────────────────────────────────────────────────────
-- Obe postoje u BigBit originalu (`BB_T_26.MDB`), ali NE u QBigTehn kopiji kroz
-- koju danas ide sync — dakle ne stižu ni jednim postojećim putem i ne smeju se
-- dodavati ni u `sync-map.generated.ts` ni u dedicated syncer.
-- Zato NEMAJU kolonu `source`: svaki njihov red je po definiciji 4.0-native.
--
-- `id` im kreće od 1 (obična sekvenca) — rezervisan opseg 900.000.000 je potreban
-- SAMO tamo gde BigBit takođe dodeljuje ključeve. Ovde ne dodeljuje.

-- ── 5a) Kontakt osobe (BigBit `KomitentiKontaktOsobe`, 1:N) ─────────────────
-- `Customer.contact` je JEDAN string od 50 znakova — komitent sa više kontakata
-- (nabavka, knjigovodstvo, direktor) gubi sve sem jednog (BIGBIT_KOMITENTI.md §2.1).
CREATE TABLE IF NOT EXISTS "customer_contacts" (
  "id"           SERIAL      NOT NULL,
  "customer_id"  INTEGER     NOT NULL,
  "contact_name" VARCHAR(50) NOT NULL,
  "phone"        VARCHAR(20),
  "fax"          VARCHAR(20),
  "mobile"       VARCHAR(20),
  "email"        VARCHAR(50),
  "birth_date"   TIMESTAMP(6),
  "is_default"   BOOLEAN     NOT NULL DEFAULT FALSE,
  "created_at"   TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"   TIMESTAMP(6),
  "created_by"   VARCHAR(50),
  "updated_by"   VARCHAR(50),
  CONSTRAINT "pk_customer_contacts" PRIMARY KEY ("id")
);

-- ON DELETE RESTRICT je svesno (ne CASCADE): ceo ovaj paket postoji zbog TIHOG
-- gubitka podataka. Ako iko ikad obriše komitenta koji ima kontakte, bolje je da
-- brisanje GLASNO padne nego da kontakti nestanu bez traga. (4.0 danas i nema
-- rutu za brisanje komitenta, a `CustomerSyncer` nikad ne briše.)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_customer_contacts_customer') THEN
    ALTER TABLE "customer_contacts" ADD CONSTRAINT "fk_customer_contacts_customer"
      FOREIGN KEY ("customer_id") REFERENCES "customers" ("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "idx_customer_contacts_customer" ON "customer_contacts" ("customer_id");

-- Najviše JEDNA podrazumevana kontakt osoba po komitentu (BigBit `KontaktDefault`
-- to ne brani — u 4.0 se brani, inače „podrazumevani kontakt" nema značenje).
CREATE UNIQUE INDEX IF NOT EXISTS "uq_customer_contacts_default"
  ON "customer_contacts" ("customer_id") WHERE "is_default";

COMMENT ON TABLE "customer_contacts" IS
  'Kontakt osobe komitenta (BigBit `KomitentiKontaktOsobe`, 1:N). 4.0-NATIVE: BigBit ovu tabelu ne šalje kroz QBigTehn kopiju — NE dodavati je ni u kakav sync.';

-- ── 5b) Mesta isporuke (BigBit `MestaIsporuke`, 1:N) ────────────────────────
-- `Customer.invoicePerDeliveryAddress` je danas SAMO flag — „fakturiši po mestima
-- isporuke" bez ijednog modelovanog mesta (BIGBIT_KOMITENTI.md §2.2). Mesto nosi
-- SOPSTVENI GLN (SEF e-faktura po lokaciji), sopstveni uplatni račun, sopstvenog
-- prodavca/rutu/vozača — praktično je pod-komitent.
CREATE TABLE IF NOT EXISTS "customer_delivery_locations" (
  "id"                 SERIAL      NOT NULL,
  "customer_id"        INTEGER     NOT NULL,
  "name"               VARCHAR(50) NOT NULL,
  "city"               VARCHAR(30) NOT NULL,
  "address"            VARCHAR(50) NOT NULL,
  "postal_code"        VARCHAR(20),
  "phone"              VARCHAR(20),
  "fax"                VARCHAR(20),
  "area"               VARCHAR(30),
  "gln"                VARCHAR(30),
  "contract_category"  VARCHAR(30),
  "general_category"   VARCHAR(30),
  "sales_channel"      VARCHAR(30),
  "location_number"    VARCHAR(20),
  "salesperson_id"     INTEGER,
  "payment_account_id" INTEGER,
  "route_id"           INTEGER,
  "driver_id"          INTEGER,
  "region"             INTEGER,
  "active"             BOOLEAN     NOT NULL DEFAULT TRUE,
  "created_at"         TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"         TIMESTAMP(6),
  "created_by"         VARCHAR(50),
  "updated_by"         VARCHAR(50),
  CONSTRAINT "pk_customer_delivery_locations" PRIMARY KEY ("id")
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_customer_delivery_locations_customer') THEN
    ALTER TABLE "customer_delivery_locations" ADD CONSTRAINT "fk_customer_delivery_locations_customer"
      FOREIGN KEY ("customer_id") REFERENCES "customers" ("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "idx_customer_delivery_locations_customer"
  ON "customer_delivery_locations" ("customer_id");

-- GLN je jedinstven U OKVIRU komitenta. Globalna jedinstvenost GLN-a je otvorena
-- odluka (v. izveštaj) — ne uvodi se unapred, jer bi mogla odbiti legitiman
-- jednokratni uvoz iz BigBit originala.
CREATE UNIQUE INDEX IF NOT EXISTS "uq_customer_delivery_locations_gln"
  ON "customer_delivery_locations" ("customer_id", "gln") WHERE "gln" IS NOT NULL;

COMMENT ON TABLE "customer_delivery_locations" IS
  'Mesta isporuke komitenta (BigBit `MestaIsporuke`, 1:N) — svako sa SOPSTVENIM GLN-om za SEF. 4.0-NATIVE: BigBit ovu tabelu ne šalje kroz QBigTehn kopiju — NE dodavati je ni u kakav sync.';
COMMENT ON COLUMN "customer_delivery_locations"."gln" IS
  'Global Location Number ovog mesta isporuke — SEF e-faktura ide na GLN LOKACIJE, ne komitenta. Validacija (6–14 cifara, `DobarGLN`) je na granici sistema.';
COMMENT ON COLUMN "customer_delivery_locations"."salesperson_id" IS
  'MEKA referenca na `salespeople.id` (bez FK, kao `customers.payment_account_id`) — legacy vrednosti su 0-teške, a tvrd FK bi vezao ovu 4.0-native tabelu za tuđi sync.';
COMMENT ON COLUMN "customer_delivery_locations"."payment_account_id" IS
  'MEKA referenca na `payment_accounts.id` — mesto isporuke se može fakturisati na drugi uplatni račun.';
COMMENT ON COLUMN "customer_delivery_locations"."route_id" IS
  'BigBit `IDRutaMestaIsporuke`. Tabela ruta u 4.0 NE POSTOJI (rute se ne sinkuju) — čist broj, bez FK.';
COMMENT ON COLUMN "customer_delivery_locations"."driver_id" IS
  'BigBit `IDVozacMestaIsporuke` — vozač je i sam komitent. Meka referenca na `customers.id`, bez FK (legacy 0).';
