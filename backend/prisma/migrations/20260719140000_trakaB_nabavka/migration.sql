-- CreateTable
CREATE TABLE "purchase_requests" (
    "id" SERIAL NOT NULL,
    "request_number" VARCHAR(20) NOT NULL,
    "project_id" INTEGER NOT NULL,
    "work_order_id" INTEGER,
    "initiator_user_id" INTEGER,
    "status" VARCHAR(20) NOT NULL DEFAULT 'DRAFT',
    "note" TEXT,
    "created_by_user_id" INTEGER,
    "updated_by_user_id" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pk_purchase_requests" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_request_items" (
    "id" SERIAL NOT NULL,
    "request_id" INTEGER NOT NULL,
    "article_id" INTEGER,
    "description" VARCHAR(255),
    "quantity" DECIMAL(18,4) NOT NULL,
    "unit" VARCHAR(10),
    "create_rfq" BOOLEAN NOT NULL DEFAULT false,
    "suggested_supplier_id" INTEGER,
    "line_no" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "pk_purchase_request_items" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supplier_rfqs" (
    "id" SERIAL NOT NULL,
    "rfq_number" VARCHAR(30) NOT NULL,
    "request_id" INTEGER,
    "supplier_id" INTEGER NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'DRAFT',
    "sent_at" TIMESTAMPTZ(6),
    "email_message_id" VARCHAR(128),
    "note" TEXT,
    "created_by_user_id" INTEGER,
    "updated_by_user_id" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pk_supplier_rfqs" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supplier_rfq_items" (
    "id" SERIAL NOT NULL,
    "rfq_id" INTEGER NOT NULL,
    "request_item_id" INTEGER,
    "article_id" INTEGER,
    "description" VARCHAR(255),
    "quantity" DECIMAL(18,4) NOT NULL,
    "unit" VARCHAR(10),
    "offered_lead_time_days" INTEGER,
    "is_accepted" BOOLEAN NOT NULL DEFAULT false,
    "line_no" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "pk_supplier_rfq_items" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_orders" (
    "id" SERIAL NOT NULL,
    "order_number" VARCHAR(20) NOT NULL,
    "rfq_id" INTEGER,
    "supplier_id" INTEGER NOT NULL,
    "project_id" INTEGER,
    "status" VARCHAR(20) NOT NULL DEFAULT 'DRAFT',
    "ordered_at" TIMESTAMPTZ(6),
    "currency" VARCHAR(3) NOT NULL DEFAULT 'RSD',
    "note" TEXT,
    "created_by_user_id" INTEGER,
    "updated_by_user_id" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pk_purchase_orders" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_order_items" (
    "id" SERIAL NOT NULL,
    "order_id" INTEGER NOT NULL,
    "rfq_item_id" INTEGER,
    "request_item_id" INTEGER,
    "article_id" INTEGER,
    "description" VARCHAR(255),
    "ordered_quantity" DECIMAL(18,4) NOT NULL,
    "received_quantity" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "unit_price" DECIMAL(18,4),
    "unit" VARCHAR(10),
    "line_no" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "pk_purchase_order_items" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idx_purchase_requests_project" ON "purchase_requests"("project_id");

-- CreateIndex
CREATE INDEX "idx_purchase_requests_status" ON "purchase_requests"("status");

-- CreateIndex
CREATE UNIQUE INDEX "uq_purchase_requests_number" ON "purchase_requests"("request_number");

-- CreateIndex
CREATE INDEX "idx_pr_items_request" ON "purchase_request_items"("request_id");

-- CreateIndex
CREATE INDEX "idx_supplier_rfqs_supplier" ON "supplier_rfqs"("supplier_id");

-- CreateIndex
CREATE INDEX "idx_supplier_rfqs_request" ON "supplier_rfqs"("request_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_supplier_rfqs_number" ON "supplier_rfqs"("rfq_number");

-- CreateIndex
CREATE INDEX "idx_rfq_items_rfq" ON "supplier_rfq_items"("rfq_id");

-- CreateIndex
CREATE INDEX "idx_purchase_orders_supplier" ON "purchase_orders"("supplier_id");

-- CreateIndex
CREATE INDEX "idx_purchase_orders_rfq" ON "purchase_orders"("rfq_id");

-- CreateIndex
CREATE INDEX "idx_purchase_orders_status" ON "purchase_orders"("status");

-- CreateIndex
CREATE UNIQUE INDEX "uq_purchase_orders_number" ON "purchase_orders"("order_number");

-- CreateIndex
CREATE INDEX "idx_po_items_order" ON "purchase_order_items"("order_id");

-- AddForeignKey
ALTER TABLE "purchase_request_items" ADD CONSTRAINT "fk_pr_items_request" FOREIGN KEY ("request_id") REFERENCES "purchase_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_rfq_items" ADD CONSTRAINT "fk_rfq_items_rfq" FOREIGN KEY ("rfq_id") REFERENCES "supplier_rfqs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_order_items" ADD CONSTRAINT "fk_po_items_order" FOREIGN KEY ("order_id") REFERENCES "purchase_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

