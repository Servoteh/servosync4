-- CreateTable
CREATE TABLE "invoices" (
    "id" SERIAL NOT NULL,
    "document_type" VARCHAR(10) NOT NULL,
    "document_number" VARCHAR(30) NOT NULL,
    "level" INTEGER NOT NULL DEFAULT 250,
    "company_id" INTEGER NOT NULL DEFAULT 0,
    "customer_id" INTEGER,
    "document_date" TIMESTAMPTZ(6) NOT NULL,
    "due_date" TIMESTAMPTZ(6),
    "currency" VARCHAR(3) NOT NULL DEFAULT 'RSD',
    "exchange_rate" DECIMAL(19,6) NOT NULL DEFAULT 1,
    "accounting_exchange_rate" DECIMAL(19,6) NOT NULL DEFAULT 1,
    "fx_invoice_value" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "net_total" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "vat_total" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "gross_total" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "linked_invoice_doc_id" INTEGER,
    "copied_from_doc_id" INTEGER,
    "status" VARCHAR(20) NOT NULL DEFAULT 'DRAFT',
    "is_export" BOOLEAN NOT NULL DEFAULT false,
    "journal_entry_id" INTEGER,
    "stock_document_id" INTEGER,
    "salesperson_id" INTEGER,
    "work_order_id" INTEGER,
    "note" TEXT,
    "created_by_user_id" INTEGER,
    "updated_by_user_id" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pk_invoices" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_items" (
    "id" SERIAL NOT NULL,
    "invoice_id" INTEGER NOT NULL,
    "line_no" INTEGER NOT NULL DEFAULT 0,
    "item_id" INTEGER,
    "description" VARCHAR(255),
    "quantity" DECIMAL(19,6) NOT NULL,
    "unit_price" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "discount_percent" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "cash_discount_percent" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "vat_rate_code" VARCHAR(5) NOT NULL DEFAULT '3',
    "vat_base" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "vat_amount" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "line_total" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "copied_from_item_id" INTEGER,

    CONSTRAINT "pk_invoice_items" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_number_sequences" (
    "id" SERIAL NOT NULL,
    "document_type" VARCHAR(10) NOT NULL,
    "year" INTEGER NOT NULL,
    "company_id" INTEGER NOT NULL DEFAULT 0,
    "last_number" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pk_document_number_sequences" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_discounts" (
    "id" SERIAL NOT NULL,
    "customer_id" INTEGER NOT NULL,
    "item_group_code" VARCHAR(20),
    "discount_percent" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "valid_from" TIMESTAMPTZ(6) NOT NULL,
    "valid_to" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pk_customer_discounts" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sef_outbox" (
    "id" SERIAL NOT NULL,
    "invoice_id" INTEGER NOT NULL,
    "request_id" VARCHAR(64) NOT NULL,
    "ubl_xml" TEXT,
    "status" VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    "sef_invoice_id" VARCHAR(64),
    "pdf_attachment_base64" TEXT,
    "error_message" TEXT,
    "sent_at" TIMESTAMPTZ(6),
    "status_polled_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pk_sef_outbox" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idx_invoices_customer" ON "invoices"("customer_id");

-- CreateIndex
CREATE INDEX "idx_invoices_type_level_status" ON "invoices"("document_type", "level", "status");

-- CreateIndex
CREATE INDEX "idx_invoices_date" ON "invoices"("document_date");

-- CreateIndex
CREATE INDEX "idx_invoices_linked" ON "invoices"("linked_invoice_doc_id");

-- CreateIndex
CREATE INDEX "idx_invoices_journal" ON "invoices"("journal_entry_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_invoices_type_number" ON "invoices"("document_type", "document_number");

-- CreateIndex
CREATE INDEX "idx_invoice_items_invoice" ON "invoice_items"("invoice_id");

-- CreateIndex
CREATE INDEX "idx_invoice_items_item" ON "invoice_items"("item_id");

-- CreateIndex
CREATE INDEX "idx_invoice_items_copied_from" ON "invoice_items"("copied_from_item_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_document_number_sequences_key" ON "document_number_sequences"("document_type", "year", "company_id");

-- CreateIndex
CREATE INDEX "idx_customer_discounts_customer_group" ON "customer_discounts"("customer_id", "item_group_code");

-- CreateIndex
CREATE INDEX "idx_sef_outbox_invoice" ON "sef_outbox"("invoice_id");

-- CreateIndex
CREATE INDEX "idx_sef_outbox_status" ON "sef_outbox"("status");

-- CreateIndex
CREATE UNIQUE INDEX "uq_sef_outbox_request_id" ON "sef_outbox"("request_id");

-- AddForeignKey
ALTER TABLE "invoice_items" ADD CONSTRAINT "fk_invoice_items_invoice" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

