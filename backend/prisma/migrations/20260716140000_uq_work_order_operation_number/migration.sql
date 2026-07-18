-- Q12 (Nenad 16.07): redni broj operacije (operation_number) MORA biti jedinstven
-- unutar istog radnog naloga (work_order_id). Ranije SAMO PK po id → moglo je dva
-- puta isti (work_order_id, operation_number), što ruši routing/kucanje.
--
-- Hand-authored. IDEMPOTENTNA (IF NOT EXISTS). Na PRODUKCIJI je već provereno da
-- NEMA duplih grupa (work_order_id, operation_number) na 215k redova, pa unique
-- prolazi bez sanacije. work_order_operations je u OWNED_PRODUCTION_TABLES →
-- MSSQL sync ga ne upisuje, pa sync ne može oboriti constraint.

CREATE UNIQUE INDEX IF NOT EXISTS "uq_woo_work_order_operation_number"
  ON "work_order_operations" ("work_order_id", "operation_number");
