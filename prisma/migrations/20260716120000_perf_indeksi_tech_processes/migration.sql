-- PERF (Faza 6 analize modula Tehnologija): sekundarni indeksi na dve najveće/najvruće
-- proizvodne tabele. Ranije SAMO PK → svaki kiosk sken (scan/control/kumulativ/
-- markComplete) i pregled radio Seq Scan preko 98k / 215k redova.
--
-- Hand-authored. Na PRODUKCIJI su indeksi već kreirani CREATE INDEX CONCURRENTLY
-- 2026-07-16 (van transakcije, bez zastoja pogona); ova migracija je zato IDEMPOTENTNA
-- (IF NOT EXISTS) i na prod-u je NO-OP. Na svežoj/rebuild bazi kreira ih normalno
-- (tabele prazne → lock trivijalan, CONCURRENTLY nije potreban i ne radi u migrate deploy tx).

CREATE INDEX IF NOT EXISTS "idx_tp_trojka_op"
  ON "tech_processes" ("project_id", "ident_number", "variant", "operation_number", "work_center_code");

CREATE INDEX IF NOT EXISTS "idx_tp_work_order"
  ON "tech_processes" ("work_order_id");

CREATE INDEX IF NOT EXISTS "idx_tp_entered_at"
  ON "tech_processes" ("entered_at");

CREATE INDEX IF NOT EXISTS "idx_woo_routing"
  ON "work_order_operations" ("work_order_id", "operation_number", "work_center_code");

CREATE INDEX IF NOT EXISTS "idx_woo_work_order"
  ON "work_order_operations" ("work_order_id");
