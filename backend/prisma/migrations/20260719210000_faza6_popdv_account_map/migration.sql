-- Faza 6 (PDV/POPDV): PopdvAccountMap — konto → POPDV AOP kolona mapiranje.
-- Rešava self-reference u popdv_definitions (formula = "[isti aop]"): taj AOP se
-- puni iz salda konta mapiranih na (popdv_mark, column_index), ne iz druge AOP formule.
-- Seed = POPDV_SemeKontaZaKnjizenje.csv (BB_T_26), razbijen po K1..K4 aktivnim kolonama.

-- CreateTable
CREATE TABLE "popdv_account_map" (
    "id" SERIAL NOT NULL,
    "account" VARCHAR(10) NOT NULL,
    "popdv_mark" VARCHAR(20) NOT NULL,
    "column_def" VARCHAR(20) NOT NULL,
    "column_index" INTEGER NOT NULL,

    CONSTRAINT "pk_popdv_account_map" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idx_popdv_account_map_mark_col" ON "popdv_account_map"("popdv_mark", "column_index");

-- CreateIndex
CREATE INDEX "idx_popdv_account_map_account" ON "popdv_account_map"("account");

-- CreateIndex
CREATE UNIQUE INDEX "uq_popdv_account_map_acc_mark_col" ON "popdv_account_map"("account", "popdv_mark", "column_index");
