-- Škart i dorada — evidencija događaja kvaliteta (MODULE_SPEC_kvalitet_skart_dorada §2,
-- presuda 26.07). App-owned 2.0-native tabele. ODVOJENO od nonconformity_reports (starija
-- Excel-digitalizacija): čist događaj-tok sa TRI statusa (PRIJAVLJEN → POTVRDJEN/ODBACEN);
-- u izveštaje (Pareto) ulazi SAMO POTVRDJEN. Statusi/tipovi su String (BACKEND_RULES §2 —
-- validira DTO/servis, NE DB CHECK). Meki ref-ovi (work_order_id/tech_process_id/machine_id/
-- reported_by_worker_id) su BEZ constrainta (batch-resolve, legacy orphan); jedini pravi FK
-- je reason_code_id → quality_reason_codes. Timestamptz (§11.5); qty Decimal (§3, nikad Float).
-- Ručno pisana migracija (obrazac postojećih SQL fajlova); primenjuje se `migrate:dev`/
-- `migrate:prod`. Seed razloga je ADITIVAN + IDEMPOTENTAN (ON CONFLICT po KOLONI code).

-- CreateTable — šifarnik razloga (soft-delete kroz `active`).
CREATE TABLE "quality_reason_codes" (
    "id" SERIAL NOT NULL,
    "code" VARCHAR(30) NOT NULL,
    "label" VARCHAR(120) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "pk_quality_reason_codes" PRIMARY KEY ("id")
);

-- CreateTable — događaj kvaliteta (škart/dorada).
CREATE TABLE "quality_events" (
    "id" SERIAL NOT NULL,
    "type" VARCHAR(10) NOT NULL,                     -- SKART | DORADA
    "status" VARCHAR(12) NOT NULL DEFAULT 'PRIJAVLJEN', -- PRIJAVLJEN | POTVRDJEN | ODBACEN
    "work_order_id" INTEGER NOT NULL,                -- RN (meki ref work_orders.id)
    "tech_process_id" INTEGER,                       -- operacija (meki ref tech_processes.id)
    "qty" DECIMAL(12,3) NOT NULL,                    -- > 0 (servis validira)
    "unit" VARCHAR(10) NOT NULL DEFAULT 'kom',
    "reason_code_id" INTEGER,                        -- obavezan za POTVRDJEN (servis)
    "note" TEXT,
    "machine_id" INTEGER,                            -- meki ref
    "work_unit_code" VARCHAR(20),                    -- RC kod (iz operacije ili ručno)
    "reported_by_worker_id" INTEGER,                 -- meki ref workers.id (kiosk: iz kartice)
    "reported_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "confirmed_by_user_id" INTEGER,
    "confirmed_at" TIMESTAMPTZ(6),
    "rejected_by_user_id" INTEGER,
    "rejected_at" TIMESTAMPTZ(6),
    "reject_reason" TEXT,
    "photo_path" VARCHAR(500),
    "created_by_user_id" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "pk_quality_events" PRIMARY KEY ("id")
);

-- CreateIndex — šifarnik: stabilan ključ code.
CREATE UNIQUE INDEX "uq_quality_reason_codes_code" ON "quality_reason_codes"("code");

-- CreateIndex — izveštajni indeksi (§2: po datumu, RN, mašini, razlogu, status+type).
CREATE INDEX "idx_quality_events_reported_at" ON "quality_events"("reported_at");
CREATE INDEX "idx_quality_events_work_order" ON "quality_events"("work_order_id");
CREATE INDEX "idx_quality_events_work_unit" ON "quality_events"("work_unit_code");
CREATE INDEX "idx_quality_events_reason" ON "quality_events"("reason_code_id");
CREATE INDEX "idx_quality_events_status_type" ON "quality_events"("status", "type");

-- AddForeignKey — jedini pravi FK (obe tabele 2.0 native); razlog se ne briše (soft-delete),
-- pa NO ACTION (ekvivalent RESTRICT) štiti od brisanja referenciranog razloga.
ALTER TABLE "quality_events" ADD CONSTRAINT "fk_quality_events_reason_code" FOREIGN KEY ("reason_code_id") REFERENCES "quality_reason_codes"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- Seed razloga (ADITIVAN + IDEMPOTENTAN; ON CONFLICT po KOLONI code, ne po imenu constrainta).
-- NAPOMENA: kombinovani skup škart+dorada (razuman podrazumevani), TREBA DOPUNITI stvarnim
-- kategorijama iz 2 Excel fajla (Excel nije bio dostupan agentu pri gradnji V1).
INSERT INTO "quality_reason_codes" ("code", "label", "sort_order") VALUES
    ('OBRADA',        'Greška u obradi',                     10),
    ('MERE',          'Mere van tolerancije',                20),
    ('MATERIJAL',     'Loš / neodgovarajući materijal',      30),
    ('DOKUMENTACIJA', 'Greška u dokumentaciji / crtežu',     40),
    ('MASINA',        'Otkaz / neispravnost mašine',         50),
    ('ALAT',          'Greška alata / istrošen alat',        60),
    ('OSTECENJE',     'Oštećenje (transport / rukovanje)',   70),
    ('ZAVARIVANJE',   'Greška u zavarivanju',                80),
    ('POVRSINSKA',    'Greška površinske zaštite',           90),
    ('LJUDSKI',       'Ljudska greška / nepažnja',          100),
    ('KOOPERACIJA',   'Greška kooperanta',                  110),
    ('OSTALO',        'Ostalo',                             900)
ON CONFLICT ("code") DO NOTHING;
