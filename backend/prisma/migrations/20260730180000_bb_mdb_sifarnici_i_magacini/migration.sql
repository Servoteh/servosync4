-- =============================================================================
-- BigBit .mdb staging — ŠIFARNICI ARTIKALA I MAGACINI (30.07.2026)
-- -----------------------------------------------------------------------------
-- `R_Grupa`, `R_Podgrupa`, `R_Poreklo`, `Magacini` — četiri tabele koje je stariji
-- `bigbit-bridge` mehanizam vukao iz .mdb-a od 11.07.2026, ali mu `install-timer.sh`
-- nikad nije pokrenut: `bigbit-bridge.timer` ne postoji na sistemu, a
-- `journalctl -u bigbit-bridge.service` javlja „No entries". Dakle nijedan prolaz.
--
-- ZAŠTO SU HITNE: 4.0 za ta tri šifarnika ima syncere (`syncers/item-group.syncer.ts`,
-- `item-subgroup`, `item-origin`) koji čitaju kroz `MssqlClient` — dakle iz QBigTehna,
-- koji je ugašen (poslednji uspešan prolaz 22.07.2026 07:14). Ti synceri su MRTVI
-- ROĐENI: registrovani su u `SyncService` i izgledaju živi, a ne mogu doneti nijedan
-- red. Posledica koja se ne vidi: provera grupe/podgrupe artikla radi po pravilu
-- „prazan šifarnik se preskače", pa se u praksi ne proverava ništa.
--
-- Kolone su `text` i nose BIGBIT imena, kao i ostale staging tabele.
-- =============================================================================

-- CreateTable
CREATE TABLE "bb_mdb_stage_grupe" (
    "id" SERIAL NOT NULL,
    "drop_id" INTEGER NOT NULL,
    "grupa" TEXT,
    "opis" TEXT,

    CONSTRAINT "pk_bb_mdb_stage_grupe" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bb_mdb_stage_podgrupe" (
    "id" SERIAL NOT NULL,
    "drop_id" INTEGER NOT NULL,
    "podgrupa" TEXT,
    "opis" TEXT,
    "grupa_veza" TEXT,

    CONSTRAINT "pk_bb_mdb_stage_podgrupe" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bb_mdb_stage_poreklo" (
    "id" SERIAL NOT NULL,
    "drop_id" INTEGER NOT NULL,
    "poreklo" TEXT,
    "opis" TEXT,
    "podgrupa_veza" TEXT,
    "popust_proc" TEXT,

    CONSTRAINT "pk_bb_mdb_stage_poreklo" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bb_mdb_stage_magacini" (
    "id" SERIAL NOT NULL,
    "drop_id" INTEGER NOT NULL,
    "id_firma" TEXT,
    "id_magacin" TEXT,
    "magacin" TEXT,
    "ulica_i_broj" TEXT,
    "mesto" TEXT,
    "prosecne_cene" TEXT,
    "vrsta_mag" TEXT,
    "konto_mag" TEXT,
    "ime_magacionera" TEXT,
    "br_lk_magacionera" TEXT,

    CONSTRAINT "pk_bb_mdb_stage_magacini" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idx_bb_mdb_stage_grupe_drop" ON "bb_mdb_stage_grupe"("drop_id");

-- CreateIndex
CREATE INDEX "idx_bb_mdb_stage_podgrupe_drop" ON "bb_mdb_stage_podgrupe"("drop_id");

-- CreateIndex
CREATE INDEX "idx_bb_mdb_stage_poreklo_drop" ON "bb_mdb_stage_poreklo"("drop_id");

-- CreateIndex
CREATE INDEX "idx_bb_mdb_stage_magacini_drop" ON "bb_mdb_stage_magacini"("drop_id");

-- AddForeignKey
ALTER TABLE "bb_mdb_stage_grupe" ADD CONSTRAINT "fk_bb_mdb_stage_grupe_drop" FOREIGN KEY ("drop_id") REFERENCES "bb_mdb_drops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bb_mdb_stage_podgrupe" ADD CONSTRAINT "fk_bb_mdb_stage_podgrupe_drop" FOREIGN KEY ("drop_id") REFERENCES "bb_mdb_drops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bb_mdb_stage_poreklo" ADD CONSTRAINT "fk_bb_mdb_stage_poreklo_drop" FOREIGN KEY ("drop_id") REFERENCES "bb_mdb_drops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bb_mdb_stage_magacini" ADD CONSTRAINT "fk_bb_mdb_stage_magacini_drop" FOREIGN KEY ("drop_id") REFERENCES "bb_mdb_drops"("id") ON DELETE CASCADE ON UPDATE CASCADE;