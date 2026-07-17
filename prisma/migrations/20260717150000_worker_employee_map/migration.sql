-- Q11 (Nenad 17.07): veza 2.0 radnik → 1.0 osoba (employee_id, sy15/Katze employees.id UUID).
-- Temelj za auto-close visećih sesija: 2.0 worker → employee_id → attendance_events (kapija).
--
-- HIKVISION-READY: ključ je employee_id (identitet OSOBE), NE kartica ni metod. Kad se
-- uključe Hikvision terminali (Face ID / otisak / QR / kartica), njihovi događaji ulaze u
-- attendance_events sa istim employee_id → auto-close ih nalazi bez izmene koda. Kartica je
-- samo JEDAN način da se veza uspostavi (match_method='card'); može i 'name'/'manual'.
--
-- employee_id je STRANI (1.0 sy15-db) UUID — soft-link (bez FK preko baza), kao katze_employee_map.
CREATE TABLE IF NOT EXISTS "worker_employee_map" (
  "worker_id"     INTEGER      NOT NULL,
  "employee_id"   UUID         NOT NULL,
  "match_method"  VARCHAR(20)  NOT NULL DEFAULT 'card',  -- card | name | manual
  "confirmed_by"  INTEGER,
  "confirmed_at"  TIMESTAMP(6),
  "created_at"    TIMESTAMP(6) NOT NULL DEFAULT now(),
  "updated_at"    TIMESTAMP(6) NOT NULL DEFAULT now(),
  CONSTRAINT "pk_worker_employee_map" PRIMARY KEY ("worker_id")
);

-- Pretraga po osobi (auto-close ide worker → employee_id; obrnuto retko, ali korisno za reviziju).
CREATE INDEX IF NOT EXISTS "idx_worker_employee_map_employee"
  ON "worker_employee_map" ("employee_id");
