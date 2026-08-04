-- ============================================================================
-- tech_processes: NAJVIŠE JEDAN OTVOREN RED PO OPERACIJI
-- ============================================================================
--
-- ZAŠTO
-- `findOrOpenRoutingTp` čita postojeći red po petorci
-- (project_id, ident_number, variant, operation_number, work_center_code) pa ga, ako ga
-- nema, kreira. Ključ nosi samo `@@index` (`idx_tp_trojka_op`), NE unique — pa dva
-- istovremena PRVA skena iste operacije oba prođu čitanje i oba upišu red. Od tada dve
-- prijave žive paralelno, a agregati koji broje urađene komade i odlučuju o gotovosti
-- gledaju dva reda kao da su dva različita posla.
--
-- ZAŠTO PARCIJALNI, A NE PUN UNIQUE
-- Pun unique nad petorkom bio bi POGREŠAN: kad se operacija završi, nova serija na istoj
-- operaciji legitimno traži NOV red. Zaključava se samo ono što stvarno mora biti jedinstveno:
-- **najviše jedan OTVOREN red** (`is_process_finished` nije TRUE). Isti obrazac i isto
-- obrazloženje kao `uq_work_time_entries_open` (migracija 20260709120000): „najviše jedna
-- otvorena sesija po (radnik, postupak)", parcijalni unique jer ga Prisma ne ume da izrazi.
--
-- `is_process_finished` je `Boolean?` sa default-om FALSE, pa uslov mora da pokrije i NULL:
-- `IS NOT TRUE` hvata i FALSE i NULL. Da piše `= FALSE`, redovi sa NULL bi ostali van brave.
--
-- ŠTO OVA BRAVA NE REŠAVA (zabeleženo, ne prećutano)
-- Trka i dalje postoji u KODU — dva poziva mogu oba proći čitanje. Baza sada drugom vraća
-- P2002 umesto da upiše drugi red, i pozivalac to hvata i ponovo čita (`catch P2002 → re-find`).
-- Isto tako, ovo NE rešava TOCTOU u guardu „preko plana" (`assertPieceCountWithinPlan`) — to je
-- zaseban nalaz koji traži `SELECT … FOR UPDATE` ili advisory lock po petorci.
--
-- 🔴 PRED-POLETNA PROVERA JE OBAVEZNA, PRE DEPLOY-A
-- `CREATE UNIQUE INDEX` nad tabelom koja VEĆ ima duplikate PADA i time obara CEO deploy.
-- Dev baza je prazna šema i ne dokazuje ništa o produkciji, a produkcija u trenutku pisanja
-- ove migracije NIJE bila dohvatljiva (ssh reset), pa broj duplikata NIJE izmeren.
-- Pre deploy-a pokrenuti:
--   ssh ubuntusrv 'bash -s' < backend/scripts/preflight-unique-migrations.sh
-- Nula duplikata = sme na deploy. Bilo šta drugo = razrešiti pa ponoviti proveru.
--
-- ⚠️ AKO OVA MIGRACIJA PADNE
-- Znači da na toj bazi VEĆ postoje dva otvorena reda za istu operaciju — i to nije stvar za
-- tiho čišćenje, jer se ne zna koji red nosi tačan broj komada. Blok ispod prijavi TAČNE
-- operacije umesto golog „could not create unique index". Pregled:
--   SELECT project_id, ident_number, variant, operation_number, work_center_code,
--          COUNT(*) AS otvorenih, array_agg(id ORDER BY id) AS ids
--   FROM tech_processes WHERE is_process_finished IS NOT TRUE
--   GROUP BY 1,2,3,4,5 HAVING COUNT(*) > 1;
-- ============================================================================

DO $$
DECLARE
  dup RECORD;
  msg TEXT := '';
  n   INT  := 0;
BEGIN
  FOR dup IN
    SELECT project_id, ident_number, variant, operation_number, work_center_code,
           COUNT(*) AS c, array_agg(id ORDER BY id) AS ids
    FROM tech_processes
    WHERE is_process_finished IS NOT TRUE
    GROUP BY project_id, ident_number, variant, operation_number, work_center_code
    HAVING COUNT(*) > 1
  LOOP
    n := n + 1;
    IF n <= 20 THEN
      msg := msg || format(
        'predmet %s / ident %s / var %s / op %s / RC %s: %s otvorenih (id: %s); ',
        dup.project_id, dup.ident_number, dup.variant,
        dup.operation_number, dup.work_center_code, dup.c, dup.ids);
    END IF;
  END LOOP;

  IF n > 0 THEN
    RAISE EXCEPTION
      'Ne mogu da postavim uq_tech_processes_open: % operacija ima više otvorenih redova. %  Zatvori ili obriši suvišne (koji nose 0 komada) pa ponovi migraciju.',
      n, msg;
  END IF;
END $$;

CREATE UNIQUE INDEX "uq_tech_processes_open"
  ON "tech_processes" ("project_id", "ident_number", "variant", "operation_number", "work_center_code")
  WHERE "is_process_finished" IS NOT TRUE;

COMMENT ON INDEX "uq_tech_processes_open" IS
  'Najvise jedan OTVOREN red po (predmet, ident, varijanta, operacija, radni centar). '
  'Parcijalni jer zavrsena operacija sme da dobije nov red za novu seriju. '
  'Isti obrazac kao uq_work_time_entries_open. Kod hvata P2002 i ponovo cita red.';
