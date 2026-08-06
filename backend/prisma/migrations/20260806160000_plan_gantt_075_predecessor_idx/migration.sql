-- 075/26 (F2 iz 046/26): kaskadno pomeranje lanca. Rekurzivni CTE hoda ka
-- sledbenicima po (predecessor_work_order_id, predecessor_line) — bez indeksa je to
-- Seq Scan PO SVAKOM NIVOU rekurzije (potvrđeno EXPLAIN-om na produkciji 06.08.2026:
-- rekurzivni član radi `Seq Scan on plan_proizvodnje_overlays n`). Danas 242 reda /
-- ~4 ms, ali upit se izvršava DVA puta po upisu i DRUGI PUT DOK SE DRŽE BRAVE, a
-- tabela raste ka broju otvorenih operacija (178.553). Indeks nije kozmetika nego
-- uslov da korak pod bravom ostane jeftin.
--
-- Aditivno i idempotentno (isti stil kao `20260731110000_plan_gantt_046`).
-- BEZ parcijalnog `WHERE … IS NOT NULL`: Prisma ne modeluje parcijalne indekse, pa bi
-- se schema i baza razilazile na svakom `migrate diff`, a ušteda je ništavna (152 kB).
-- BEZ `CONCURRENTLY`: Prisma migracije idu u transakciji, gde `CONCURRENTLY` puca;
-- običan `CREATE INDEX` je na ovoj tabeli pitanje milisekundi.
CREATE INDEX IF NOT EXISTS "idx_plan_proizvodnje_overlays_predecessor"
  ON "plan_proizvodnje_overlays" ("predecessor_work_order_id", "predecessor_line");
