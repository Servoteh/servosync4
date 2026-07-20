-- Praćenje proizvodnje — 2.0-native app-owned tabele (F1).
-- Gasi sy15 (1.0) most: praćenje sedi direktno na 2.0 work_orders / projects / tech_processes
-- (BACKEND_RULES §3 vlasništvo). Ove tabele drže SAMO aplikativni podatak koga nema u izvornim
-- tabelama: ručni override-i, napomene, operativni plan, aktivacije predmeta, kooperacija.
-- Plan + presuđene odluke O1–O8: docs/PLAN_PRACENJE_PROIZVODNJE_2026-07.md §3.2 / §6.
--
-- Reference ka work_orders / projects (2.0) i customers (BigBit keš) su MEKI ref-ovi (BEZ DB FK) —
-- kućni obrazac šeme (CncProgram / NonconformityReport / WorkTimeEntry: „batch-resolve, legacy
-- orphan"; nema presedana hard-FK ka BigBit kešu). Pravi FK-ovi postoje SAMO među novim app-owned
-- tabelama (odeljenja / operativne_aktivnosti / koop_otpremnice). Timestamptz(6) (BACKEND_RULES §11.5).

-- ── 1. Ručni override praćenja po RN-u (zamena za sy15 pracenje_manual_overrides) ──
CREATE TABLE "pracenje_overrides" (
  "id"                 SERIAL         NOT NULL,
  "work_order_id"      INTEGER        NOT NULL,
  "manual_status"      VARCHAR(20),                        -- 'u_radu'|'kompletirano'|'nije_zapoceto'; NULL=auto
  "manual_machining"   BOOLEAN,
  "manual_surface"     BOOLEAN,
  "manual_qty"         INTEGER,
  "reason"             TEXT,
  "created_by_user_id" INTEGER,
  "updated_by_user_id" INTEGER,
  "created_at"         TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at"         TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "pk_pracenje_overrides" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "uq_pracenje_overrides_work_order" ON "pracenje_overrides" ("work_order_id");

-- ── 2. Ručni re-parent u stablu praćenja (zamena za sy15 pracenje_parent_override) ──
CREATE TABLE "pracenje_structure_overrides" (
  "id"                   SERIAL         NOT NULL,
  "work_order_id"        INTEGER        NOT NULL,
  "parent_work_order_id" INTEGER,                          -- NULL = koren / odlepi od auto-hijerarhije
  "created_by_user_id"   INTEGER,
  "updated_by_user_id"   INTEGER,
  "created_at"           TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at"           TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "pk_pracenje_structure_overrides" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "uq_pracenje_structure_overrides_work_order" ON "pracenje_structure_overrides" ("work_order_id");
CREATE INDEX "idx_pracenje_structure_overrides_parent" ON "pracenje_structure_overrides" ("parent_work_order_id");

-- ── 3. Napomene po predmetu/RN-u (zamena za sy15 pracenje_proizvodnje_napomene) ──
-- NAPOMENA: PG tretira NULL kao različit → jedinstvenost na nivou predmeta (work_order_id NULL)
-- nije garantovana ovim constraint-om; servis to dodatno enforce-uje.
CREATE TABLE "pracenje_notes" (
  "id"                 SERIAL         NOT NULL,
  "project_id"         INTEGER        NOT NULL,
  "work_order_id"      INTEGER,                            -- NULL = napomena na nivou predmeta
  "note"               TEXT           NOT NULL,
  "created_by_user_id" INTEGER,
  "updated_by_user_id" INTEGER,
  "created_at"         TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at"         TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "pk_pracenje_notes" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "uq_pracenje_notes_project_work_order" ON "pracenje_notes" ("project_id", "work_order_id");
CREATE INDEX "idx_pracenje_notes_project" ON "pracenje_notes" ("project_id");

-- ── 4. Aktivacija predmeta + redosled + ⭐ plan-prioritet (spaja 3 sy15 tabele, odluka O1) ──
CREATE TABLE "predmet_aktivacije" (
  "id"                 SERIAL         NOT NULL,
  "project_id"         INTEGER        NOT NULL,
  "is_active"          BOOLEAN        NOT NULL DEFAULT true,
  "sort_priority"      INTEGER,                            -- ↑↓ redosled liste; NULL = nerangiran
  "plan_priority"      INTEGER,                            -- ⭐ top-lista slot; NULL = van top-liste
  "created_by_user_id" INTEGER,
  "updated_by_user_id" INTEGER,
  "created_at"         TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at"         TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "pk_predmet_aktivacije" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "uq_predmet_aktivacije_project" ON "predmet_aktivacije" ("project_id");
CREATE INDEX "idx_predmet_aktivacije_plan_priority" ON "predmet_aktivacije" ("plan_priority");
CREATE INDEX "idx_predmet_aktivacije_sort_priority" ON "predmet_aktivacije" ("sort_priority");

-- ── 5. Šifarnik odeljenja (7 redova iz sy15 core.odeljenje, odluka O3) ──
CREATE TABLE "odeljenja" (
  "id"            SERIAL         NOT NULL,
  "code"          VARCHAR(20)    NOT NULL,
  "name"          VARCHAR(100)   NOT NULL,
  "color"         VARCHAR(20),                             -- hex ili token
  "sort_order"    INTEGER        NOT NULL DEFAULT 0,
  "active"        BOOLEAN        NOT NULL DEFAULT true,
  "lead_user_id"  INTEGER,                                 -- meki ref → users
  "lead_worker_id" INTEGER,                                -- meki ref → workers
  "created_at"    TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at"    TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "pk_odeljenja" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "uq_odeljenja_code" ON "odeljenja" ("code");
CREATE INDEX "idx_odeljenja_sort_order" ON "odeljenja" ("sort_order");

-- ── 6. Operativni plan Tab2 (aktivnosti po odeljenjima; migracija iz sy15, remap RN veza O4) ──
CREATE TABLE "operativne_aktivnosti" (
  "id"                    SERIAL         NOT NULL,
  "legacy_sy15_id"        UUID,                            -- sy15 provenance (EXACT import idempotency key); NULL = native 2.0
  "work_order_id"         INTEGER,                         -- meki ref → work_orders
  "project_id"            INTEGER,                         -- meki ref → projects
  "odeljenje_id"          INTEGER        NOT NULL,         -- pravi FK → odeljenja
  "naziv_aktivnosti"      VARCHAR(500)   NOT NULL,
  "planirani_pocetak"     DATE,
  "planirani_zavrsetak"   DATE,
  "odgovoran_user_id"     INTEGER,
  "odgovoran_worker_id"   INTEGER,
  "odgovoran_label"       VARCHAR(255),
  "status"                VARCHAR(20)    NOT NULL DEFAULT 'nije_krenulo', -- nije_krenulo|u_toku|zavrseno|blokirano
  "prioritet"             VARCHAR(20)    NOT NULL DEFAULT 'srednji',      -- nizak|srednji|visok
  "rb"                    INTEGER        NOT NULL DEFAULT 0,
  "opis"                  TEXT,
  "broj_tp"               VARCHAR(50),
  "kolicina_text"         VARCHAR(100),
  "zavisi_od_aktivnost_id" INTEGER,                        -- meki self-ref
  "zavisi_od_text"        VARCHAR(500),
  "status_mode"           VARCHAR(30)    NOT NULL DEFAULT 'manual',       -- manual|auto_from_pozicija|auto_from_operacije
  "rizik_napomena"        TEXT,
  "izvor"                 VARCHAR(30)    NOT NULL DEFAULT 'rucno',        -- rucno|iz_sastanka|akcioni_plan
  "izvor_akcioni_plan_id" INTEGER,
  "izvor_pozicija_id"     INTEGER,
  "izvor_tp_operacija_id" INTEGER,
  "created_by_user_id"    INTEGER,
  "updated_by_user_id"    INTEGER,
  "created_at"            TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at"            TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "pk_operativne_aktivnosti" PRIMARY KEY ("id"),
  CONSTRAINT "fk_operativne_aktivnosti_odeljenje" FOREIGN KEY ("odeljenje_id")
    REFERENCES "odeljenja" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION
);
CREATE UNIQUE INDEX "uq_operativne_aktivnosti_legacy_sy15" ON "operativne_aktivnosti" ("legacy_sy15_id");
CREATE INDEX "idx_operativne_aktivnosti_work_order" ON "operativne_aktivnosti" ("work_order_id");
CREATE INDEX "idx_operativne_aktivnosti_project" ON "operativne_aktivnosti" ("project_id");
CREATE INDEX "idx_operativne_aktivnosti_odeljenje" ON "operativne_aktivnosti" ("odeljenje_id");

-- ── 6b. Append-only istorija blokada aktivnosti ──
CREATE TABLE "operativne_aktivnosti_blokade" (
  "id"                   SERIAL         NOT NULL,
  "legacy_sy15_id"       UUID,                            -- sy15 provenance (EXACT import idempotency key); NULL = native 2.0
  "aktivnost_id"         INTEGER        NOT NULL,
  "razlog"               TEXT           NOT NULL,
  "blocked_at"           TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "blocked_by_user_id"   INTEGER,
  "unblocked_at"         TIMESTAMPTZ(6),
  "unblocked_by_user_id" INTEGER,
  "napomena"             TEXT,
  CONSTRAINT "pk_operativne_aktivnosti_blokade" PRIMARY KEY ("id"),
  CONSTRAINT "fk_operativne_aktivnosti_blokade_aktivnost" FOREIGN KEY ("aktivnost_id")
    REFERENCES "operativne_aktivnosti" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
);
CREATE UNIQUE INDEX "uq_operativne_aktivnosti_blokade_legacy_sy15" ON "operativne_aktivnosti_blokade" ("legacy_sy15_id");
CREATE INDEX "idx_operativne_aktivnosti_blokade_aktivnost" ON "operativne_aktivnosti_blokade" ("aktivnost_id");

-- ── 7. Kooperacija — otpremnica (docx §4.11, auto-„vraćeno" O6) ──
CREATE TABLE "koop_otpremnice" (
  "id"                 SERIAL         NOT NULL,
  "customer_id"        INTEGER        NOT NULL,            -- meki ref → customers (BigBit keš)
  "vrsta"              VARCHAR(20)    NOT NULL,            -- galvanska|termicka|masinska
  "broj"               VARCHAR(50)    NOT NULL,
  "datum_slanja"       DATE           NOT NULL,
  "kilaza_kg"          DECIMAL(12,3),
  "napomena"           TEXT,
  "status"             VARCHAR(20)    NOT NULL DEFAULT 'poslato', -- poslato|delimicno_vraceno|vraceno
  "created_by_user_id" INTEGER,
  "updated_by_user_id" INTEGER,
  "created_at"         TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at"         TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "pk_koop_otpremnice" PRIMARY KEY ("id")
);
CREATE INDEX "idx_koop_otpremnice_customer" ON "koop_otpremnice" ("customer_id");
CREATE INDEX "idx_koop_otpremnice_status" ON "koop_otpremnice" ("status");
CREATE INDEX "idx_koop_otpremnice_datum_slanja" ON "koop_otpremnice" ("datum_slanja");

-- ── 7b. Kooperacija — stavka otpremnice (RN/pozicija) ──
CREATE TABLE "koop_otpremnica_stavke" (
  "id"               SERIAL         NOT NULL,
  "otpremnica_id"    INTEGER        NOT NULL,             -- pravi FK → koop_otpremnice
  "work_order_id"    INTEGER        NOT NULL,             -- meki ref → work_orders
  "drawing_number"   VARCHAR(100),
  "naziv_pozicije"   VARCHAR(250),
  "kolicina"         INTEGER        NOT NULL,
  "vraceno_kolicina" INTEGER        NOT NULL DEFAULT 0,
  "tip_presvlake"    VARCHAR(100),
  "jedinstven_broj"  VARCHAR(100),
  "napomena"         TEXT,
  "returned_at"      TIMESTAMPTZ(6),
  CONSTRAINT "pk_koop_otpremnica_stavke" PRIMARY KEY ("id"),
  CONSTRAINT "fk_koop_otpremnica_stavke_otpremnica" FOREIGN KEY ("otpremnica_id")
    REFERENCES "koop_otpremnice" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
);
CREATE INDEX "idx_koop_otpremnica_stavke_otpremnica" ON "koop_otpremnica_stavke" ("otpremnica_id");
CREATE INDEX "idx_koop_otpremnica_stavke_work_order" ON "koop_otpremnica_stavke" ("work_order_id");
