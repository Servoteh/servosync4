-- ════════════════════════════════════════════════════════════════════════════
-- 078/26 — FAZA A: tabela termina nastaje, ali NIŠTA je još ne čita.
-- Odluka Nenad 07.08.2026. Baza: GLAVNA (servosync-pg).
-- ════════════════════════════════════════════════════════════════════════════
--
-- ZAŠTO: zahtev traži da ista operacija sme da stoji u planu VIŠE PUTA, svaki put
-- sa svojom količinom i eventualno na drugoj mašini („5 pa 3 pa 2 od ukupno 10").
-- Danas to zabranjuje `uq_plan_proizvodnje_overlays_wo_line` — jedna operacija =
-- jedan overlay red. Taj isti red pri tom meša DVE stvari: STANJE operacije
-- (local_status, ručni redosled, cam_ready, kooperacija, arhiva) i TERMIN sa
-- ganta. Zato se razdvajaju: stanje ostaje na overlay-u, termin seli ovamo.
--
-- 🔴 ŠTA OVA MIGRACIJA NAMERNO **NE** RADI:
--
--   • NE dozvoljava više termina po operaciji. `uq_..._termini_overlay_faza_a`
--     drži 1:1 i to je JEDINA tvrda garancija da se nijedan postojeći
--     `LEFT JOIN` nad overlay-om ne može pomnožiti dok kod za N termina ne
--     postoji. Posebno: 080/26 („Po mašini prati gant") u
--     `plan-proizvodnje-read.service.ts` radi `JOIN poredak p ON p.line_id =
--     f.line_id` — taj spoj je bezbedan SAMO dok po `line_id` postoji tačno
--     jedan red. Skidanje ovog indeksa je početak Faze B i TAČKA BEZ POVRATKA;
--     ide zasebnom migracijom, ne ovde.
--
--   • NE seli `predecessor_work_order_id` / `predecessor_line`. Rekurzija
--     `collectChain` (plan-proizvodnje.service.ts) namerno prolazi KROZ čvor BEZ
--     termina — u kodu stoji upozorenje da bi se lanac inače „tiho pucao na 4
--     mesta i planer to nigde ne bi video". Čvor bez termina ovde nema red, pa
--     bi rekurzija na njemu stala. Uslov ostaje na overlay-u; prelazak je Faza C
--     sa zasebnom odlukom (šta „uslov" znači kad prethodnik nema termin).
--
--   • NE nosi `legacy_sy15_id` — nema živog pisca (jedina referenca je
--     jednokratna skripta `backend/scripts/migrate-plan-proizvodnje-sy15.ts`).
--
--   • NE stavlja CHECK ograničenja. Prisma ih ne modeluje pa bi se šema i baza
--     razilazile na svakom `migrate diff` (isti argument kao u migraciji
--     20260806160000_plan_gantt_075_predecessor_idx za parcijalne indekse).
--     Pravila (`kolicina > 0`, `end >= start`) idu u servis, uz `assertPlanConsistent`.
--
--   • 🔴 NE stavlja STRANI KLJUČ, a pogotovo ne `ON DELETE CASCADE`.
--     Izmereno 07.08.2026: nad `plan_proizvodnje_overlays` danas postoji NULA
--     stranih ključeva, NULA trigera, RLS je isključen, a NIJEDAN kod ne briše
--     overlay redove (nema `DELETE FROM`, nema `.delete/.deleteMany`; retention
--     posao dira samo audit/notifikacije/idempotenciju). Dakle jedini realan
--     brisač je čovek na psql-u — a to je tačno slučaj u kome bi CASCADE tiho i
--     nepovratno odneo i ceo plan. Bez FK, takav `DELETE` ostavlja termine kao
--     ZAPIS iz kog se plan može rekonstruisati. Uz to je meki ref kućni obrazac
--     ovog modula (v. 20260720120000_plan_proizvodnje_native_f5b: „Reference ka
--     work_orders / work_order_operations su MEKI ref-ovi (BEZ DB FK)"), a FK bi
--     na svaki INSERT uzimao `FOR KEY SHARE` nad overlay redom i sudarao se sa
--     `FOR UPDATE` koji kaskada drži — u modulu koji već dokumentuje živ 40P01.
--
-- POVRATAK ove migracije (dok je Faza A):
--   DROP TABLE plan_proizvodnje_termini;
--   DELETE FROM _prisma_migrations WHERE migration_name = '20260807220000_plan_078_termini_faza_a';
-- Bezbedno jer tabelu u Fazi A NIŠTA ne čita.
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS "plan_proizvodnje_termini" (
  "id"                       SERIAL         NOT NULL,
  -- Meki ref → plan_proizvodnje_overlays.id (bez DB FK — v. obrazloženje gore).
  "overlay_id"               INTEGER        NOT NULL,
  -- Denormalizovano iz overlay-a: čitanja se spajaju po (work_order_id, line_id),
  -- isto kao kaskada danas, pa nema dodatnog skoka kroz overlay.
  "work_order_id"            INTEGER        NOT NULL,
  "line_id"                  INTEGER        NOT NULL,
  -- Tipovi su NAMERNO isti kao na overlay-u (timestamptz(6), ne timestamp):
  -- razilaženje tipa bi tiho pomerilo vreme za dva sata.
  "planned_start_at"         TIMESTAMPTZ(6) NOT NULL,
  "planned_end_at"           TIMESTAMPTZ(6),
  "planned_duration_minutes" INTEGER,
  -- 🔴 NULL-dozvoljena: orfan overlay (operacija obrisana) je modelovana klasa u
  -- ovom modulu, a NOT NULL uz LEFT JOIN u backfill-u bi oborio migraciju USRED
  -- deploy-a. Danas je orfana sa terminom nula, ali brana ne sme da zavisi od toga.
  "kolicina"                 INTEGER,
  -- Sopstvena mašina termina. NULL = „nasledi sa overlay-a". NIKAD prazan string —
  -- COALESCE u čitanju uzima i '' kao vrednost, pa bi '' značilo „bez mašine".
  "assigned_machine_code"    VARCHAR(50),
  "planned_done"             BOOLEAN,
  "planned_done_at"          TIMESTAMPTZ(6),
  "planned_done_by"          TEXT,
  "created_by"               TEXT,
  "updated_by"               TEXT,
  "created_at"               TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at"               TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "pk_plan_proizvodnje_termini" PRIMARY KEY ("id")
);

-- 🔴 FAZA A ONLY — briše se zasebnom migracijom na početku Faze B.
CREATE UNIQUE INDEX IF NOT EXISTS "uq_plan_proizvodnje_termini_overlay_faza_a"
  ON "plan_proizvodnje_termini" ("overlay_id");

-- Osa ganta (blizanac idx_plan_proizvodnje_overlays_planned_start).
CREATE INDEX IF NOT EXISTS "idx_plan_proizvodnje_termini_start"
  ON "plan_proizvodnje_termini" ("planned_start_at");

-- Oblik `(work_order_id, line_id) IN (…)` koji kaskada već koristi.
CREATE INDEX IF NOT EXISTS "idx_plan_proizvodnje_termini_wo_line"
  ON "plan_proizvodnje_termini" ("work_order_id", "line_id");
