-- Zahtev 053/26 (paket 2): RUČNO KREIRANJE SKLOPA u tabeli praćenja predmeta —
-- uključujući sklop koji NEMA radni nalog ni tehnologiju u sistemu.
--
-- ODLUKA VLASNIKA: virtuelni sklop je OVERLAY nad stablom praćenja, a NE red u
-- `work_orders`. RN registar, numeracija RN-ova i MRP ostaju netaknuti — ništa se ne
-- lansira, ne planira, ne kalkuliše. Sklop postoji SAMO kao čvor grupisanja u praćenju.
--
-- U API-ju se čvor pojavljuje sa NEGATIVNIM id-jem (`id = 7` → `node_id = -7`), pa ceo
-- postojeći lanac (path_idrn int[], reparentNodes, FE stablo, `pracenje_structure_overrides`
-- čije su obe kolone goli Int BEZ FK-a) radi nad jednim numeričkim prostorom ključeva.
-- Deca se kače postojećim mehanizmom „Premesti u sklop"
-- (`pracenje_structure_overrides.parent_work_order_id = -7`).
--
-- `project_id` je MEKI ref → projects.id (bez DB FK-a) — isti obrazac kao ostatak modula
-- (`pracenje_notes`, `pracenje_overrides`, `pracenje_structure_overrides`).
-- ADITIVNO i idempotentno (CREATE TABLE/INDEX IF NOT EXISTS): ne dira nijednu postojeću
-- tabelu. App-owned → TIMESTAMPTZ(6) (BACKEND_RULES §2.3).

CREATE TABLE IF NOT EXISTS "pracenje_virtuelni_sklopovi" (
  "id"         SERIAL         NOT NULL,
  "project_id" INTEGER        NOT NULL,                        -- meki ref → projects.id
  "naziv"      VARCHAR(200)   NOT NULL,
  "tip"        VARCHAR(10)    NOT NULL DEFAULT 'pod',           -- 'glavni' | 'pod' | 'zav' (bedževi ekrana)
  "created_by" TEXT,                                            -- e-mail iz JWT-a (isti obrazac kao work_order_drawing_pdfs.uploaded_by)
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "deleted_at" TIMESTAMPTZ(6),                                  -- soft-delete (brisanje čisti i structure-override-e dece)
  CONSTRAINT "pk_pracenje_virtuelni_sklopovi" PRIMARY KEY ("id")
);

-- Čitanje je uvek „svi ne-obrisani sklopovi jednog predmeta" (izvestaj/podsklopovi).
CREATE INDEX IF NOT EXISTS "idx_pracenje_virtuelni_sklopovi_project"
  ON "pracenje_virtuelni_sklopovi" ("project_id");
