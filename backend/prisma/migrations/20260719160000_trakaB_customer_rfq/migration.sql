-- CreateTable
CREATE TABLE "customer_rfqs" (
    "id" SERIAL NOT NULL,
    "request_date" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "quote_deadline" TIMESTAMPTZ(6),
    "customer_id" INTEGER NOT NULL,
    "project_id" INTEGER,
    "origin" VARCHAR(30),
    "salesperson_id" INTEGER,
    "proforma_doc_id" INTEGER,
    "description" VARCHAR(255),
    "status" VARCHAR(20) NOT NULL DEFAULT 'DRAFT',
    "note" TEXT,
    "created_by_user_id" INTEGER,
    "updated_by_user_id" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pk_customer_rfqs" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idx_customer_rfqs_customer" ON "customer_rfqs"("customer_id");

-- CreateIndex
CREATE INDEX "idx_customer_rfqs_status" ON "customer_rfqs"("status");

-- CreateIndex
CREATE INDEX "idx_customer_rfqs_deadline" ON "customer_rfqs"("quote_deadline");

-- CreateIndex
CREATE UNIQUE INDEX "uq_customer_rfqs_project" ON "customer_rfqs"("project_id");

