-- CreateTable
CREATE TABLE "stock_documents" (
    "id" SERIAL NOT NULL,
    "company_id" INTEGER NOT NULL DEFAULT 0,
    "kind" VARCHAR(10) NOT NULL,
    "document_type_code" VARCHAR(5) NOT NULL,
    "document_number" VARCHAR(20) NOT NULL,
    "year" INTEGER NOT NULL,
    "warehouse_id" INTEGER NOT NULL,
    "target_warehouse_id" INTEGER,
    "supplier_id" INTEGER,
    "customer_id" INTEGER,
    "document_date" TIMESTAMPTZ(6) NOT NULL,
    "posting_date" TIMESTAMPTZ(6) NOT NULL,
    "is_import" BOOLEAN NOT NULL DEFAULT false,
    "customs_exchange_rate" DECIMAL(19,6) NOT NULL DEFAULT 1,
    "accounting_exchange_rate" DECIMAL(19,6) NOT NULL DEFAULT 1,
    "fx_invoice_value" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "customs" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "forwarding" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "other_dependent_costs" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "customs_refund_base" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "purchase_order_id" INTEGER,
    "project_id" INTEGER,
    "work_order_id" INTEGER,
    "linked_inbound_doc_id" INTEGER,
    "inventory_count_id" INTEGER,
    "status" VARCHAR(20) NOT NULL DEFAULT 'DRAFT',
    "is_calculated" BOOLEAN NOT NULL DEFAULT false,
    "journal_entry_id" INTEGER,
    "created_by_user_id" INTEGER,
    "updated_by_user_id" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pk_stock_documents" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_document_items" (
    "id" SERIAL NOT NULL,
    "document_id" INTEGER NOT NULL,
    "item_id" INTEGER NOT NULL,
    "warehouse_id" INTEGER NOT NULL,
    "line_no" INTEGER NOT NULL DEFAULT 0,
    "quantity" DECIMAL(19,6) NOT NULL,
    "kg_quantity" DECIMAL(19,6) NOT NULL DEFAULT 0,
    "invoice_price" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "discount_percent" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "cash_discount_percent" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "purchase_price_net" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "dependent_cost_own" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "dependent_cost_supplier" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "calculated_wholesale_price" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "calculated_retail_price" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "actual_wholesale_price" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "actual_retail_price" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "markup_amount" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "excise" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "fee" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "fixed_tax" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "fx_purchase_price" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "customs_rate" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "goods_tax_rate_code" VARCHAR(5) NOT NULL DEFAULT '3',

    CONSTRAINT "pk_stock_document_items" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_levels" (
    "id" SERIAL NOT NULL,
    "item_id" INTEGER NOT NULL,
    "warehouse_id" INTEGER NOT NULL,
    "on_hand" DECIMAL(19,6) NOT NULL DEFAULT 0,
    "reserved" DECIMAL(19,6) NOT NULL DEFAULT 0,
    "avg_purchase_net" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "avg_wholesale_price" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "last_purchase_net" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "last_wholesale_price" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "as_of" TIMESTAMPTZ(6) NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pk_stock_levels" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_leveling_items" (
    "id" SERIAL NOT NULL,
    "document_id" INTEGER NOT NULL,
    "item_id" INTEGER NOT NULL,
    "warehouse_id" INTEGER NOT NULL,
    "quantity_revalued" DECIMAL(19,6) NOT NULL,
    "old_purchase_net" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "new_purchase_net" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "old_dependent_own" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "new_dependent_own" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "old_dependent_supplier" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "new_dependent_supplier" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "old_wholesale_price" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "new_wholesale_price" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "old_retail_price" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "new_retail_price" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "value_adjustment" DECIMAL(19,4) NOT NULL,
    "is_posted" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "pk_stock_leveling_items" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_counts" (
    "id" SERIAL NOT NULL,
    "company_id" INTEGER NOT NULL DEFAULT 0,
    "warehouse_id" INTEGER NOT NULL,
    "count_number" VARCHAR(20) NOT NULL,
    "year" INTEGER NOT NULL,
    "count_date" TIMESTAMPTZ(6) NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'DRAFT',
    "note" TEXT,
    "created_by_user_id" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pk_inventory_counts" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_count_items" (
    "id" SERIAL NOT NULL,
    "count_id" INTEGER NOT NULL,
    "item_id" INTEGER NOT NULL,
    "book_quantity" DECIMAL(19,6) NOT NULL DEFAULT 0,
    "counted_quantity" DECIMAL(19,6) NOT NULL DEFAULT 0,
    "price" DECIMAL(19,4) NOT NULL DEFAULT 0,

    CONSTRAINT "pk_inventory_count_items" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kepu_book_entries" (
    "id" SERIAL NOT NULL,
    "company_id" INTEGER NOT NULL DEFAULT 0,
    "warehouse_id" INTEGER NOT NULL,
    "document_id" INTEGER,
    "entry_date" TIMESTAMPTZ(6) NOT NULL,
    "charge" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "discharge" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "description" VARCHAR(255),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pk_kepu_book_entries" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "item_valuations" (
    "item_id" INTEGER NOT NULL,
    "valuation_purchase_net" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "valuation_dependent_own" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "valuation_dependent_supplier" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "valuation_wholesale_price" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "valuation_retail_price" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pk_item_valuations" PRIMARY KEY ("item_id")
);

-- CreateIndex
CREATE INDEX "idx_stock_documents_date_wh" ON "stock_documents"("document_date", "warehouse_id", "document_type_code");

-- CreateIndex
CREATE INDEX "idx_stock_documents_type" ON "stock_documents"("document_type_code");

-- CreateIndex
CREATE INDEX "idx_stock_documents_po" ON "stock_documents"("purchase_order_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_stock_documents_number" ON "stock_documents"("company_id", "document_type_code", "year", "document_number");

-- CreateIndex
CREATE INDEX "idx_stock_document_items_document" ON "stock_document_items"("document_id");

-- CreateIndex
CREATE INDEX "idx_stock_document_items_item_wh" ON "stock_document_items"("item_id", "warehouse_id");

-- CreateIndex
CREATE INDEX "idx_stock_levels_warehouse" ON "stock_levels"("warehouse_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_stock_levels_item_wh" ON "stock_levels"("item_id", "warehouse_id");

-- CreateIndex
CREATE INDEX "idx_stock_leveling_items_document" ON "stock_leveling_items"("document_id");

-- CreateIndex
CREATE INDEX "idx_stock_leveling_items_item_wh" ON "stock_leveling_items"("item_id", "warehouse_id");

-- CreateIndex
CREATE INDEX "idx_inventory_counts_warehouse" ON "inventory_counts"("warehouse_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_inventory_counts_number" ON "inventory_counts"("company_id", "year", "count_number");

-- CreateIndex
CREATE INDEX "idx_inventory_count_items_count" ON "inventory_count_items"("count_id");

-- CreateIndex
CREATE INDEX "idx_inventory_count_items_item" ON "inventory_count_items"("item_id");

-- CreateIndex
CREATE INDEX "idx_kepu_book_entries_wh_date" ON "kepu_book_entries"("warehouse_id", "entry_date");

-- CreateIndex
CREATE INDEX "idx_kepu_book_entries_document" ON "kepu_book_entries"("document_id");

-- AddForeignKey
ALTER TABLE "stock_document_items" ADD CONSTRAINT "fk_stock_document_items_document" FOREIGN KEY ("document_id") REFERENCES "stock_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_leveling_items" ADD CONSTRAINT "fk_stock_leveling_items_document" FOREIGN KEY ("document_id") REFERENCES "stock_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_count_items" ADD CONSTRAINT "fk_inventory_count_items_count" FOREIGN KEY ("count_id") REFERENCES "inventory_counts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

