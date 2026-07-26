-- BigBit .mdb noćni uvoz — drop manifest + staging + oznaka porekla (stavka A, 26.07.2026)
-- =============================================================================
-- ZAŠTO: finansijsko jezgro BigBita (glavna knjiga, nalozi, kontni plan, PDV šeme)
-- NE POSTOJI u MSSQL izvoru koji vozi `sync-map.generated.ts` — živi isključivo u
-- Access .mdb fajlu koji se spušta u /srv/bigbit-incoming/. Bez njega nema tri
-- paralelna PDV obračuna (odluka vlasnika 26.07.2026).
--
-- Ova migracija dodaje:
--   1) `bb_mdb_drops`      — manifest jednog drop-a (ime+mtime+veličina = identitet).
--   2) `bb_mdb_stage_*`    — sirov staging (sve kolone TEXT; tipizacija je u koraku 2).
--   3) `imported_drop_id`  — OZNAKA POREKLA na accounts / order_types /
--      saldakonto_accounts / journal_entries / ledger_entries. NULL = 4.0-native red.
--   4) `bb_nalog_id` / `bb_stavka_id` UNIQUE — ključ idempotencije i traceback
--      stavka-po-stavku ka BigBitu (bez njih nema uporednog PDV obračuna).
--   5) relaksaciju `chk_ledger_entries_nonnegative` SAMO za uvezene redove.
--
-- Detalji i uputstvo: backend/docs/migration/BIGBIT_NOCNI_SYNC.md
-- =============================================================================

-- AlterTable
ALTER TABLE "accounts" ADD COLUMN     "imported_drop_id" INTEGER;

-- AlterTable
ALTER TABLE "journal_entries" ADD COLUMN     "bb_nalog_id" INTEGER,
ADD COLUMN     "description" VARCHAR(255),
ADD COLUMN     "imported_drop_id" INTEGER;

-- AlterTable
ALTER TABLE "ledger_entries" ADD COLUMN     "bb_stavka_id" INTEGER,
ADD COLUMN     "document_origin" VARCHAR(20),
ADD COLUMN     "imported_drop_id" INTEGER;

-- AlterTable
ALTER TABLE "order_types" ADD COLUMN     "imported_drop_id" INTEGER;

-- AlterTable
ALTER TABLE "saldakonto_accounts" ADD COLUMN     "imported_drop_id" INTEGER;

-- CreateTable
CREATE TABLE "bb_mdb_drops" (
    "id" SERIAL NOT NULL,
    "file_name" VARCHAR(255) NOT NULL,
    "file_mtime" TIMESTAMPTZ(6) NOT NULL,
    "file_size" BIGINT NOT NULL,
    "file_sha256" VARCHAR(64),
    "stage_status" VARCHAR(10) NOT NULL DEFAULT 'PENDING',
    "staged_at" TIMESTAMPTZ(6),
    "stage_duration_ms" INTEGER,
    "stage_row_counts" JSONB,
    "stage_error" TEXT,
    "import_status" VARCHAR(10) NOT NULL DEFAULT 'PENDING',
    "imported_at" TIMESTAMPTZ(6),
    "import_duration_ms" INTEGER,
    "import_row_counts" JSONB,
    "import_error" TEXT,
    "note" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pk_bb_mdb_drops" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bb_mdb_stage_gk" (
    "id" SERIAL NOT NULL,
    "drop_id" INTEGER NOT NULL,
    "stavka_id" TEXT,
    "konto" TEXT,
    "ino_konto" TEXT,
    "analiticka_sifra" TEXT,
    "broj_dokumenta" TEXT,
    "datum_dokumenta" TEXT,
    "valuta_dokumenta" TEXT,
    "datum_knjizenja" TEXT,
    "id_naloga" TEXT,
    "opis_dokumenta" TEXT,
    "duguje" TEXT,
    "potrazuje" TEXT,
    "povezan" TEXT,
    "id_dok_iz_robnog" TEXT,
    "temeljnica" TEXT,
    "dev_duguje" TEXT,
    "dev_potrazuje" TEXT,
    "dev_valuta" TEXT,
    "pozicija" TEXT,
    "id_dok_mp" TEXT,
    "id_prodavnica_mp" TEXT,
    "id_predmet" TEXT,
    "id_dok_iz_usluga" TEXT,
    "pg_id_dok_iz_robnog" TEXT,
    "oj" TEXT,
    "potpis" TEXT,
    "datum_i_vreme" TEXT,
    "od" TEXT,
    "id_radni_nalog" TEXT,
    "pnb_odob_broj_gk" TEXT,

    CONSTRAINT "pk_bb_mdb_stage_gk" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bb_mdb_stage_nalozi" (
    "id" SERIAL NOT NULL,
    "drop_id" INTEGER NOT NULL,
    "id_firma" TEXT,
    "id_naloga" TEXT,
    "broj_naloga" TEXT,
    "vrsta_naloga" TEXT,
    "datum_naloga" TEXT,
    "opis_naloga" TEXT,
    "datum_knjizenja" TEXT,
    "level" TEXT,
    "zakljucano" TEXT,
    "godina" TEXT,
    "potpis" TEXT,
    "datum_i_vreme" TEXT,
    "stari_id" TEXT,

    CONSTRAINT "pk_bb_mdb_stage_nalozi" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bb_mdb_stage_kontni_plan" (
    "id" SERIAL NOT NULL,
    "drop_id" INTEGER NOT NULL,
    "konto" TEXT,
    "opis" TEXT,
    "dugacki_opis" TEXT,
    "plan_duguje" TEXT,
    "plan_potrazuje" TEXT,
    "dozvoljen_unos_analitike" TEXT,
    "fajl_sifara" TEXT,
    "ino_konto" TEXT,

    CONSTRAINT "pk_bb_mdb_stage_kontni_plan" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bb_mdb_stage_vrsta_naloga" (
    "id" SERIAL NOT NULL,
    "drop_id" INTEGER NOT NULL,
    "vrsta_naloga" TEXT,
    "opis" TEXT,

    CONSTRAINT "pk_bb_mdb_stage_vrsta_naloga" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bb_mdb_stage_psf_konta" (
    "id" SERIAL NOT NULL,
    "drop_id" INTEGER NOT NULL,
    "konto" TEXT,
    "din_saldo" TEXT,
    "dev_saldo" TEXT,
    "otst" TEXT,

    CONSTRAINT "pk_bb_mdb_stage_psf_konta" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bb_mdb_stage_sema" (
    "id" SERIAL NOT NULL,
    "drop_id" INTEGER NOT NULL,
    "id_seme" TEXT,
    "vrsta_naloga" TEXT,
    "opis" TEXT,

    CONSTRAINT "pk_bb_mdb_stage_sema" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bb_mdb_stage_sema_stavke" (
    "id" SERIAL NOT NULL,
    "drop_id" INTEGER NOT NULL,
    "id_stavke_seme" TEXT,
    "id_seme" TEXT,
    "konto" TEXT,
    "opis" TEXT,
    "def_dug" TEXT,
    "def_pot" TEXT,
    "analitika" TEXT,
    "poreklo" TEXT,
    "kng_sifra_2" TEXT,

    CONSTRAINT "pk_bb_mdb_stage_sema_stavke" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bb_mdb_stage_pdv_gk" (
    "id" SERIAL NOT NULL,
    "drop_id" INTEGER NOT NULL,
    "src_id" TEXT,
    "stavka_id" TEXT,
    "dat_por_perioda" TEXT,
    "pdv_evidencija" TEXT,
    "pdv_stopa" TEXT,
    "pdv_osnovica" TEXT,
    "obracun_pdv_osnovica" TEXT,
    "pdv_iznos" TEXT,
    "obracun_pdv_iznos" TEXT,
    "pdv_grupa" TEXT,

    CONSTRAINT "pk_bb_mdb_stage_pdv_gk" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bb_mdb_stage_popdv_gk" (
    "id" SERIAL NOT NULL,
    "drop_id" INTEGER NOT NULL,
    "stavka_id" TEXT,
    "pdv_oznaka" TEXT,
    "dat_por_perioda" TEXT,
    "k1_iznos" TEXT,
    "k2_iznos" TEXT,
    "k3_iznos" TEXT,
    "k4_iznos" TEXT,

    CONSTRAINT "pk_bb_mdb_stage_popdv_gk" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idx_bb_mdb_drops_status" ON "bb_mdb_drops"("stage_status", "import_status");

-- CreateIndex
CREATE UNIQUE INDEX "uq_bb_mdb_drops_file" ON "bb_mdb_drops"("file_name", "file_mtime", "file_size");

-- CreateIndex
CREATE INDEX "idx_bb_mdb_stage_gk_drop" ON "bb_mdb_stage_gk"("drop_id");

-- CreateIndex
CREATE INDEX "idx_bb_mdb_stage_nalozi_drop" ON "bb_mdb_stage_nalozi"("drop_id");

-- CreateIndex
CREATE INDEX "idx_bb_mdb_stage_kontni_plan_drop" ON "bb_mdb_stage_kontni_plan"("drop_id");

-- CreateIndex
CREATE INDEX "idx_bb_mdb_stage_vrsta_naloga_drop" ON "bb_mdb_stage_vrsta_naloga"("drop_id");

-- CreateIndex
CREATE INDEX "idx_bb_mdb_stage_psf_konta_drop" ON "bb_mdb_stage_psf_konta"("drop_id");

-- CreateIndex
CREATE INDEX "idx_bb_mdb_stage_sema_drop" ON "bb_mdb_stage_sema"("drop_id");

-- CreateIndex
CREATE INDEX "idx_bb_mdb_stage_sema_stavke_drop" ON "bb_mdb_stage_sema_stavke"("drop_id");

-- CreateIndex
CREATE INDEX "idx_bb_mdb_stage_pdv_gk_drop" ON "bb_mdb_stage_pdv_gk"("drop_id");

-- CreateIndex
CREATE INDEX "idx_bb_mdb_stage_popdv_gk_drop" ON "bb_mdb_stage_popdv_gk"("drop_id");

-- CreateIndex
CREATE INDEX "idx_accounts_imported_drop" ON "accounts"("imported_drop_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_journal_entries_bb_nalog" ON "journal_entries"("bb_nalog_id");

-- CreateIndex
CREATE INDEX "idx_journal_entries_imported_drop" ON "journal_entries"("imported_drop_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_ledger_entries_bb_stavka" ON "ledger_entries"("bb_stavka_id");

-- CreateIndex
CREATE INDEX "idx_ledger_entries_imported_drop" ON "ledger_entries"("imported_drop_id");

-- CreateIndex
CREATE INDEX "idx_order_types_imported_drop" ON "order_types"("imported_drop_id");

-- CreateIndex
CREATE INDEX "idx_saldakonto_imported_drop" ON "saldakonto_accounts"("imported_drop_id");

-- AddForeignKey
ALTER TABLE "order_types" ADD CONSTRAINT "fk_order_types_imported_drop" FOREIGN KEY ("imported_drop_id") REFERENCES "bb_mdb_drops"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accounts" ADD CONSTRAINT "fk_accounts_imported_drop" FOREIGN KEY ("imported_drop_id") REFERENCES "bb_mdb_drops"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "saldakonto_accounts" ADD CONSTRAINT "fk_saldakonto_imported_drop" FOREIGN KEY ("imported_drop_id") REFERENCES "bb_mdb_drops"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_entries" ADD CONSTRAINT "fk_journal_entries_imported_drop" FOREIGN KEY ("imported_drop_id") REFERENCES "bb_mdb_drops"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "fk_ledger_entries_imported_drop" FOREIGN KEY ("imported_drop_id") REFERENCES "bb_mdb_drops"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bb_mdb_stage_gk" ADD CONSTRAINT "fk_bb_mdb_stage_gk_drop" FOREIGN KEY ("drop_id") REFERENCES "bb_mdb_drops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bb_mdb_stage_nalozi" ADD CONSTRAINT "fk_bb_mdb_stage_nalozi_drop" FOREIGN KEY ("drop_id") REFERENCES "bb_mdb_drops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bb_mdb_stage_kontni_plan" ADD CONSTRAINT "fk_bb_mdb_stage_kontni_plan_drop" FOREIGN KEY ("drop_id") REFERENCES "bb_mdb_drops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bb_mdb_stage_vrsta_naloga" ADD CONSTRAINT "fk_bb_mdb_stage_vrsta_naloga_drop" FOREIGN KEY ("drop_id") REFERENCES "bb_mdb_drops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bb_mdb_stage_psf_konta" ADD CONSTRAINT "fk_bb_mdb_stage_psf_konta_drop" FOREIGN KEY ("drop_id") REFERENCES "bb_mdb_drops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bb_mdb_stage_sema" ADD CONSTRAINT "fk_bb_mdb_stage_sema_drop" FOREIGN KEY ("drop_id") REFERENCES "bb_mdb_drops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bb_mdb_stage_sema_stavke" ADD CONSTRAINT "fk_bb_mdb_stage_sema_stavke_drop" FOREIGN KEY ("drop_id") REFERENCES "bb_mdb_drops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bb_mdb_stage_pdv_gk" ADD CONSTRAINT "fk_bb_mdb_stage_pdv_gk_drop" FOREIGN KEY ("drop_id") REFERENCES "bb_mdb_drops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bb_mdb_stage_popdv_gk" ADD CONSTRAINT "fk_bb_mdb_stage_popdv_gk_drop" FOREIGN KEY ("drop_id") REFERENCES "bb_mdb_drops"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ─────────────────────────────────────────────────────────────────────────────
-- BLOKADA 1: 592 od 20.366 GK stavki u BB_T_26_11-07-26.mdb ima NEGATIVNO
-- `Duguje` ili `Potrazuje` (npr. StavkaID 151523, konto 1520: Duguje -2283,1200 /
-- Potrazuje -380,5200). To je legitiman BigBit obrazac (storniranje unutar iste
-- stavke), ali `chk_ledger_entries_nonnegative` iz migracije
-- 20260725200000_faza2_constraint_mreza ga ODBIJA i uvoz istorije 1:1 puca.
--
-- ODLUKA: guard se NE UKIDA — sužava se na 4.0-native redove. Za redove koje je
-- doneo .mdb uvoz (`imported_drop_id IS NOT NULL`) istorija ulazi 1:1, jer je
-- svrha uvoza VERNA KOPIJA BigBita radi poređenja PDV obračuna; „ispravljanje"
-- znaka pri uvozu bi tiho razišlo dva sistema koja upravo treba da se poklope.
-- Za sve što 4.0 sam knjiži pravilo ostaje NEPROMENJENO (storno = protiv-nalog).
-- ─────────────────────────────────────────────────────────────────────────────
-- IF EXISTS: dev/sandbox baze mogu biti iza faza2 migracije koja je uvela ovaj
-- CHECK; bez toga `migrate deploy` na takvoj bazi pada na koraku koji nema šta da
-- ukloni. Na produkciji constraint POSTOJI i uredno se zamenjuje užom verzijom.
ALTER TABLE "ledger_entries" DROP CONSTRAINT IF EXISTS "chk_ledger_entries_nonnegative";
ALTER TABLE "ledger_entries" ADD CONSTRAINT "chk_ledger_entries_nonnegative"
  CHECK ("imported_drop_id" IS NOT NULL OR ("debit" >= 0 AND "credit" >= 0));

-- NAPOMENA O INDEKSIMA NA STAGING-u: namerno stoji SAMO `idx_bb_mdb_stage_*_drop`
-- (po `drop_id`), koji pokriva i FK i brisanje starog drop-a. Dodatni indeks po
-- `stavka_id` NE BI POMOGAO uvozu glavne knjige: keyset ide po `stavka_id::int`
-- (kolona je TEXT), a btree nad tekstom ne služi tom redosledu — trebao bi
-- ekspresioni indeks, koji Prisma ne ume da deklariše. Izmereno: 20.366 redova u
-- 11 serija = 3,9 s i bez njega, pa dodatni indeks samo usporava `\copy`.
