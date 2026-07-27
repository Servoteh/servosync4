-- TALAS AI-5 (review nalaz [10]): statistička procena vremena po radnom mestu
-- (estimateByWorkCenter / wcQuantiles, 2× po pozivu work-center endpointa)
-- filtrira `tech_processes` po `work_center_code`. Bez indeksa = Seq Scan preko
-- 99k redova (mereno ~114 ms na produ). Postojeći `idx_tp_trojka_op` vodi
-- `project_id` kao prvi stolbac, pa NE služi ovaj samostalni predikat.
--
-- Plain CREATE INDEX (NE CONCURRENTLY): Prisma migracija teče u transakciji, a
-- CONCURRENTLY tamo nije dozvoljen. Na 99k redova ACCESS EXCLUSIVE lock traje
-- pod sekunde (btree build); prihvatljivo za deploy prozor.
CREATE INDEX "idx_tech_processes_work_center_code"
  ON "tech_processes" ("work_center_code");
