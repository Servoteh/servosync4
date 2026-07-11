-- app_notifications — D8 prva faza (PLAN_dorade_2026-07-10 §D8): in-app
-- notifikacije („zvonce"). APP-OWNED tabela 2.0, NEMA legacy izvora — legacy
-- `notifications` (Was: Info) se NE dira. Redovi se materijalizuju PO-PRIMAOCU
-- u trenutku emit-a (tech-processes control() za doradu/škart, handover-drafts
-- submit() za novu primopredaju); notifications modul ih lista i markira.
-- `recipient_worker_id` referiše workers.id NAMERNO BEZ FK-a: istorija
-- notifikacija ne sme da blokira održavanje radnika, a čitanje ionako
-- batch-razrešava radnike (src/common/relations.ts obrazac).
-- Timestamptz kao work_time_entries (druga 2.0 app-owned proizvodna tabela).
-- DDL 1:1 sa `prisma migrate diff --from-empty` izlazom za AppNotification model
-- (drift-check na migrate:prod mora ostati čist).
CREATE TABLE "app_notifications" (
    "id" SERIAL NOT NULL,
    "type" VARCHAR(40) NOT NULL,
    "message" VARCHAR(500) NOT NULL,
    "ref_table" VARCHAR(40),
    "ref_id" INTEGER,
    "recipient_worker_id" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "read_at" TIMESTAMPTZ(6),

    CONSTRAINT "pk_app_notifications" PRIMARY KEY ("id")
);

-- Pokriva sve read putanje modula: lista po primaocu (created_at DESC),
-- unread filter (read_at IS NULL) i unread-count.
CREATE INDEX "idx_app_notifications_recipient_read_created" ON "app_notifications"("recipient_worker_id", "read_at", "created_at" DESC);
