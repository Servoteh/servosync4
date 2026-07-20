-- Plan proizvodnje — 2.0-native app-owned tabele (F5b-1a).
-- Gasi sy15 (1.0) most za Plan proizvodnje: overlay / urgency / auto-koop / skice / reassign-audit
-- koje 1.0 drži u `production_*` tabelama sele u glavnu bazu (BACKEND_RULES §3 vlasništvo).
-- Ovaj korak uvodi SAMO app-owned tabele + migracioni skript — read sloj (view lanac → native)
-- čeka F5b-0 izviđanje. Plan + odluke M1/M3/M8: docs/PLAN_F5_GASENJE_MOSTA.md §4 / §8.
--
-- Reference ka work_orders / work_order_operations (2.0) su MEKI ref-ovi (BEZ DB FK) — kućni obrazac
-- praćenja. `line_id` == work_order_operations.id deli ISTI id prostor kao sy15 `line` → migracija je
-- COPY bez remape. Legacy audit kolone (created_by/updated_by/…) su sy15 tekst (email/uid) i prenose
-- se VERBATIM (bez remape na users.id). Timestamptz(6) (BACKEND_RULES §11.5).

-- ── 1. Overlay Plana proizvodnje po operaciji (zamena za sy15 production_overlays) ──
CREATE TABLE "plan_proizvodnje_overlays" (
  "id"                          SERIAL         NOT NULL,
  "legacy_sy15_id"              BIGINT,                             -- sy15 provenance (production_overlays.id, bigint); NULL = native 2.0
  "work_order_id"               INTEGER        NOT NULL,            -- meki ref → work_orders
  "line_id"                     INTEGER        NOT NULL,            -- meki ref → work_order_operations (ISTI id prostor kao sy15 line)
  "shift_sort_order"            INTEGER,
  "local_status"                VARCHAR(20),                        -- 'waiting'|'in_progress'|'blocked'; NULL=auto
  "shift_note"                  TEXT,
  "assigned_machine_code"       VARCHAR(50),
  "cam_ready"                   BOOLEAN        NOT NULL DEFAULT false,
  "cam_ready_at"                TIMESTAMPTZ(6),
  "cam_ready_by"                TEXT,
  "ready_override"              BOOLEAN        NOT NULL DEFAULT false,
  "ready_override_at"           TIMESTAMPTZ(6),
  "ready_override_by"           TEXT,
  "cooperation_status"          VARCHAR(30),                        -- 'none'|'external'|'external_in_progress'|'external_done'
  "cooperation_partner"         TEXT,
  "cooperation_set_by"          TEXT,
  "cooperation_set_at"          TIMESTAMPTZ(6),
  "cooperation_expected_return" DATE,
  "archived_at"                 TIMESTAMPTZ(6),
  "archived_reason"             TEXT,
  "created_by"                  TEXT,                               -- legacy audit (sy15 tekst, verbatim)
  "updated_by"                  TEXT,
  "created_at"                  TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at"                  TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "pk_plan_proizvodnje_overlays" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "uq_plan_proizvodnje_overlays_legacy_sy15" ON "plan_proizvodnje_overlays" ("legacy_sy15_id");
CREATE UNIQUE INDEX "uq_plan_proizvodnje_overlays_wo_line" ON "plan_proizvodnje_overlays" ("work_order_id", "line_id");

-- ── 2. HITNO flag po RN-u (zamena za sy15 production_urgency_overrides; DELETE nikad) ──
CREATE TABLE "plan_proizvodnje_urgency_overrides" (
  "id"            SERIAL         NOT NULL,
  "work_order_id" INTEGER        NOT NULL,                          -- meki ref → work_orders
  "is_urgent"     BOOLEAN        NOT NULL DEFAULT true,
  "reason"        TEXT,
  "set_by"        TEXT,
  "set_at"        TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "cleared_at"    TIMESTAMPTZ(6),
  "cleared_by"    TEXT,
  CONSTRAINT "pk_plan_proizvodnje_urgency_overrides" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "uq_plan_proizvodnje_urgency_work_order" ON "plan_proizvodnje_urgency_overrides" ("work_order_id");

-- ── 3. Auto-kooperacija: RJ grupa (zamena za sy15 production_auto_cooperation_groups; soft-delete) ──
CREATE TABLE "plan_proizvodnje_auto_cooperation_groups" (
  "id"            SERIAL         NOT NULL,
  "rj_group_code" VARCHAR(50)    NOT NULL,
  "group_label"   TEXT,
  "notes"         TEXT,
  "added_by"      TEXT,                                             -- legacy audit (sy15 email, verbatim)
  "added_at"      TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "removed_at"    TIMESTAMPTZ(6),
  "removed_by"    TEXT,
  CONSTRAINT "pk_plan_proizvodnje_auto_cooperation_groups" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "uq_plan_proizvodnje_auto_koop_rj_group_code" ON "plan_proizvodnje_auto_cooperation_groups" ("rj_group_code");

-- ── 4. Skice planera — PDF u bazi (bytea, M1; zamena za sy15 production_drawings storage) ──
CREATE TABLE "plan_proizvodnje_drawings" (
  "id"             SERIAL         NOT NULL,
  "legacy_sy15_id" BIGINT,                                          -- sy15 provenance (production_drawings.id, bigint); NULL = native 2.0
  "work_order_id"  INTEGER        NOT NULL,                         -- meki ref → work_orders
  "line_id"        INTEGER,                                         -- meki ref → work_order_operations; NULL = skica na nivou RN-a
  "file_name"      VARCHAR(255)   NOT NULL,
  "content_type"   VARCHAR(100),
  "pdf_binary"     BYTEA,                                           -- M1: bytea (glavna baza nema object storage)
  "size_bytes"     BIGINT,
  "uploaded_by"    TEXT,
  "uploaded_at"    TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "deleted_at"     TIMESTAMPTZ(6),                                  -- soft-delete
  "deleted_by"     TEXT,
  CONSTRAINT "pk_plan_proizvodnje_drawings" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "uq_plan_proizvodnje_drawings_legacy_sy15" ON "plan_proizvodnje_drawings" ("legacy_sy15_id");
CREATE INDEX "idx_plan_proizvodnje_drawings_work_order" ON "plan_proizvodnje_drawings" ("work_order_id");

-- ── 5. Audit premeštaja (forsirani reassign; zamena za sy15 production_reassign_audit) ──
-- Idempotencija po (client_event_uuid, line_id) — ISTA semantika kao sy15
-- `ON CONFLICT (client_event_uuid, line_id) DO NOTHING`. NULL uuid → PG tretira kao različit (kao sy15).
CREATE TABLE "plan_proizvodnje_reassign_audit" (
  "id"                SERIAL         NOT NULL,
  "work_order_id"     INTEGER        NOT NULL,                      -- meki ref → work_orders
  "line_id"           INTEGER        NOT NULL,                      -- meki ref → work_order_operations
  "actor_email"       TEXT,                                         -- sy15 actor_email = current_user_email() (verbatim)
  "from_machine_code" VARCHAR(50),                                  -- sy15 source_machine
  "to_machine_code"   VARCHAR(50),                                  -- sy15 target_machine
  "source_group"      VARCHAR(50),
  "target_group"      VARCHAR(50),
  "forced"            BOOLEAN        NOT NULL DEFAULT true,         -- sy15 audit red postoji SAMO za forsirane
  "force_reason"      TEXT,
  "client_event_uuid" UUID,                                         -- NULL dozvoljen (stariji sy15 poziv bez uuid-a)
  "created_at"        TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "pk_plan_proizvodnje_reassign_audit" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "uq_plan_proizvodnje_reassign_client_event_line" ON "plan_proizvodnje_reassign_audit" ("client_event_uuid", "line_id");
CREATE INDEX "idx_plan_proizvodnje_reassign_work_order" ON "plan_proizvodnje_reassign_audit" ("work_order_id");
