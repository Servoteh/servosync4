-- CreateTable
CREATE TABLE "accounts" (
    "code" VARCHAR(10) NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "long_description" TEXT,
    "account_class" INTEGER NOT NULL,
    "allows_analytics" BOOLEAN NOT NULL DEFAULT false,
    "codebook_file" VARCHAR(64),
    "foreign_account" VARCHAR(10),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "pk_accounts" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "accounting_schemes" (
    "id" SERIAL NOT NULL,
    "order_type" VARCHAR(5) NOT NULL,
    "description" VARCHAR(255),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pk_accounting_schemes" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "accounting_scheme_lines" (
    "id" SERIAL NOT NULL,
    "scheme_id" INTEGER NOT NULL,
    "account_code" VARCHAR(10) NOT NULL,
    "description" VARCHAR(255),
    "def_debit" VARCHAR(255),
    "def_credit" VARCHAR(255),
    "posts_analytics" BOOLEAN NOT NULL DEFAULT false,
    "origin" VARCHAR(5),
    "item_codebook" VARCHAR(10),
    "line_no" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "pk_accounting_scheme_lines" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "saldakonto_accounts" (
    "account" VARCHAR(10) NOT NULL,
    "side" VARCHAR(10) NOT NULL,
    "control_account" VARCHAR(10) NOT NULL,
    "tracks_open_items" BOOLEAN NOT NULL DEFAULT true,
    "holds_din_balance" BOOLEAN NOT NULL DEFAULT true,
    "holds_fx_balance" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pk_saldakonto_accounts" PRIMARY KEY ("account")
);

-- CreateIndex
CREATE INDEX "idx_accounts_class" ON "accounts"("account_class");

-- CreateIndex
CREATE INDEX "idx_scheme_lines_scheme" ON "accounting_scheme_lines"("scheme_id");

-- CreateIndex
CREATE INDEX "idx_scheme_lines_account" ON "accounting_scheme_lines"("account_code");

-- CreateIndex
CREATE INDEX "idx_saldakonto_control" ON "saldakonto_accounts"("control_account");

-- AddForeignKey
ALTER TABLE "accounting_scheme_lines" ADD CONSTRAINT "fk_scheme_lines_scheme" FOREIGN KEY ("scheme_id") REFERENCES "accounting_schemes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accounting_scheme_lines" ADD CONSTRAINT "fk_scheme_lines_account" FOREIGN KEY ("account_code") REFERENCES "accounts"("code") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "saldakonto_accounts" ADD CONSTRAINT "fk_saldakonto_account" FOREIGN KEY ("account") REFERENCES "accounts"("code") ON DELETE CASCADE ON UPDATE CASCADE;

