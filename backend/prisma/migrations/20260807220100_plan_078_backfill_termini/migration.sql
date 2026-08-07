-- ════════════════════════════════════════════════════════════════════════════
-- 078/26 — FAZA A, korak 2: preseljenje ZATEČENIH termina u novu tabelu.
-- ZASEBAN fajl od kreiranja tabele — namerno, da se može poništiti sam za sebe
-- (`TRUNCATE plan_proizvodnje_termini;`) bez rušenja tabele i bez diranja
-- `_prisma_migrations` reda za strukturu.
-- ════════════════════════════════════════════════════════════════════════════
--
-- IZMERENO NA PRODU 07.08.2026 (SELECT-only, neposredno pre pisanja):
--   244 overlay reda ukupno
--    31 sa `planned_start_at`  ← tačno ovoliko redova nastaje
--     0 sa krajem bez početka (nema nekonzistentnih)
--     0 orfana sa terminom (operacija obrisana a termin ostao)
--     0 sa terminom kojima RN više ne postoji
--   Brojke su SNIMAK. Migracija je idempotentna i ne zavisi od njih.
--
-- 🔴 LEFT JOIN, NIKAD INNER: orfan overlay (operacija ili RN obrisani) NE SME
-- da izgubi termin bez traga. Danas ih je nula, ali INNER JOIN bi ih tiho
-- preskočio — a promašen termin je najskuplja greška ove seobe: pozicija koja
-- je završena ili zatvorena stoji na gantu ISKLJUČIVO preko
-- `planned_start_at IS NOT NULL` (v. `effectiveOpsInner`), pa bi joj promašaj
-- obrisao ceo red sa ose, ne samo bar.
--
-- `kolicina` = puna količina operacije = `work_orders.piece_count`. Danas svaka
-- operacija ima TAČNO JEDAN termin, pa je pun plan ispravna vrednost; deljenje
-- na više termina („5 pa 3 pa 2") dolazi tek u Fazi B, kroz UI.
-- Kolona je NULL-dozvoljena pa orfan prolazi sa NULL umesto da obori migraciju.
--
-- `assigned_machine_code` ostaje NULL = „nasledi sa overlay-a". Namerno se NE
-- prepisuje sa overlay-a: dok termin nema sopstvenu mašinu, jedan izvor istine
-- je bolji od dve kopije koje se mogu razići.
--
-- IDEMPOTENTNO: `WHERE NOT EXISTS` po `overlay_id`. Ponovno puštanje ne pravi
-- duplikate (a i ne bi moglo — `uq_..._termini_overlay_faza_a` to zabranjuje).
-- ════════════════════════════════════════════════════════════════════════════

INSERT INTO "plan_proizvodnje_termini" (
  "overlay_id", "work_order_id", "line_id",
  "planned_start_at", "planned_end_at", "planned_duration_minutes",
  "kolicina", "assigned_machine_code",
  "planned_done", "planned_done_at", "planned_done_by",
  "created_by", "updated_by", "created_at", "updated_at")
SELECT o."id", o."work_order_id", o."line_id",
       o."planned_start_at", o."planned_end_at", o."planned_duration_minutes",
       wo."piece_count", NULL,
       o."planned_done", o."planned_done_at", o."planned_done_by",
       o."created_by", o."updated_by", o."created_at", o."updated_at"
  FROM "plan_proizvodnje_overlays" o
  LEFT JOIN "work_orders" wo ON wo."id" = o."work_order_id"
 WHERE o."planned_start_at" IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM "plan_proizvodnje_termini" t WHERE t."overlay_id" = o."id");
