-- BigBit noćni uvoz — remedijacija posle recenzije (26.07.2026)
-- =============================================================================
-- Tri nalaza iz recenzije stavke A koji se ne mogu popraviti kodom:
--
-- 1) MUTEX ZA UVOZ (`import_started_at`). Scheduler blokira paralelno pokretanje
--    samo ako postoji RUNNING red MLAĐI OD 10 MINUTA; uvoz pune glavne knjige
--    lako pređe 10 min, pa su dva uvoza istog drop-a mogla da rade jedan preko
--    drugog. Sada je claim atomski CAS nad ovom kolonom (vidi
--    bigbit-mdb-import.service.ts → claimDrop).
--
-- 2) FK POREKLA: `ON DELETE SET NULL` → `ON DELETE RESTRICT`. Stari FK je značio
--    da `DELETE FROM bb_mdb_drops` radi `UPDATE ... SET imported_drop_id = NULL`
--    nad svim uvezenim redovima — tj. rutinsko čišćenje starih drop-ova TIHO
--    briše jedinu informaciju o tome iz kog je fajla red došao. (Na
--    `ledger_entries` to je i praktično pucalo: CHECK je zavisio od te iste
--    kolone, pa je brisanje drop-a vraćalo nerazumljivu grešku o negativnim
--    iznosima.) Drop koji je nešto uvezao je ZAPISNIK i ne sme da se briše;
--    staging se čisti ciljano po `bb_mdb_stage_*` (vidi retention posao).
--
-- 3) CHECK `chk_ledger_entries_nonnegative` se vezuje za `bb_stavka_id` umesto za
--    `imported_drop_id`. `bb_stavka_id` je STABILAN marker porekla (nikad ne
--    postaje NULL), pa pravilo ostaje tačno bez obzira na to šta se dešava sa
--    FK-om na drop. Semantika je nepromenjena: negativan iznos je dozvoljen SAMO
--    na redu koji je došao iz BigBita (tamošnji obrazac storniranja unutar
--    stavke), a za sve što 4.0 sam knjiži važi staro pravilo (storno = protivnalog).
-- =============================================================================

-- ── 1) Mutex/heartbeat uvoza ────────────────────────────────────────────────
ALTER TABLE "bb_mdb_drops" ADD COLUMN IF NOT EXISTS "import_started_at" TIMESTAMPTZ(6);

-- ── 2) Oznaka porekla se ne sme izgubiti brisanjem drop-a ───────────────────
ALTER TABLE "order_types" DROP CONSTRAINT IF EXISTS "fk_order_types_imported_drop";
ALTER TABLE "order_types" ADD CONSTRAINT "fk_order_types_imported_drop"
  FOREIGN KEY ("imported_drop_id") REFERENCES "bb_mdb_drops"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "accounts" DROP CONSTRAINT IF EXISTS "fk_accounts_imported_drop";
ALTER TABLE "accounts" ADD CONSTRAINT "fk_accounts_imported_drop"
  FOREIGN KEY ("imported_drop_id") REFERENCES "bb_mdb_drops"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "saldakonto_accounts" DROP CONSTRAINT IF EXISTS "fk_saldakonto_imported_drop";
ALTER TABLE "saldakonto_accounts" ADD CONSTRAINT "fk_saldakonto_imported_drop"
  FOREIGN KEY ("imported_drop_id") REFERENCES "bb_mdb_drops"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "journal_entries" DROP CONSTRAINT IF EXISTS "fk_journal_entries_imported_drop";
ALTER TABLE "journal_entries" ADD CONSTRAINT "fk_journal_entries_imported_drop"
  FOREIGN KEY ("imported_drop_id") REFERENCES "bb_mdb_drops"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ledger_entries" DROP CONSTRAINT IF EXISTS "fk_ledger_entries_imported_drop";
ALTER TABLE "ledger_entries" ADD CONSTRAINT "fk_ledger_entries_imported_drop"
  FOREIGN KEY ("imported_drop_id") REFERENCES "bb_mdb_drops"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── 3) CHECK na stabilnom markeru porekla ───────────────────────────────────
ALTER TABLE "ledger_entries" DROP CONSTRAINT IF EXISTS "chk_ledger_entries_nonnegative";
ALTER TABLE "ledger_entries" ADD CONSTRAINT "chk_ledger_entries_nonnegative"
  CHECK ("bb_stavka_id" IS NOT NULL OR ("debit" >= 0 AND "credit" >= 0));
