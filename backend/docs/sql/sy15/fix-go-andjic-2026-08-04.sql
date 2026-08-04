-- ============================================================================
-- KONTROLA GO: Mladen Anđić — „vrati 2 dana" (nalog 04.08.2026 uz zahtev 068/26)
-- Datum: 2026-08-04 · Baza: sy15 (ubuntusrv, docker sy15-db, user supabase_admin)
-- Grana: fix/odmor-nedjo-068
-- Izvršavanje: ssh ubuntusrv "docker exec -i sy15-db psql -U supabase_admin -d postgres" < ovaj_fajl
-- ============================================================================
--
-- ⚠️ ISPRAVKA RANIJEG NALAZA — PROČITAJ PRE POKRETANJA.
-- U forenzici 068/26 je prijavljeno: „Anđiću su 06.05. i 20.05.2026 dva GO dana
-- pregažena unosom sati, saldo mu je 2 dana previsok." **TO NIJE TAČNO.** Nalaz
-- je nastao čitanjem POJEDINAČNIH audit UPDATE-ova, bez provere (a) da li je
-- izmena kasnije poništena i (b) šta kaže merodavni HR dokument. Provereno
-- 04.08.2026 na produ, dan po dan:
--
--   • 06.05.2026 — Nevena je 08.05. u 11:22:51 prepisala `go` → 8 h (audit_log
--     id 1758). Nikola je 20.05. u 10:11:29 taj dan VRATIO na `go` (audit_log
--     id 3226). Danas u gridu stoji `go`. Sam se sanirao pre 2,5 meseca.
--   • 20.05.2026 — dan je u gridu bio `go`, Nikola ga je 25.05. u 15:52:18
--     prepisao na 8 h rada (audit_log id 4420). Merodavni dokument
--     (`vacation_history` 2026 / `vacation_go_days`) taj datum NE zna kao GO —
--     dakle izmena je ISPRAVKA pogrešne oznake, ne gubitak dana.
--   • 10.04. i 13.04.2026 — grid redovi `go` koje dokument ne poznaje; obrisao
--     ih je reconcile skript 26.06.2026 06:39:54 (bez actor-a). Ispravno.
--   • 27.04.2026 — jeste u dokumentu; grid red je obrisan istim reconcile-om, ali
--     je taj dan prebrojan kroz `opening_used` (v. dole). Nije izgubljen.
--
-- IZMERENO STANJE (04.08.2026):
--   dokument (vacation_history 2026 → vacation_go_days): 6 dana —
--     17.04, 27.04, 06.05, 07.05, 15.06, 23.06
--   grid (work_hours absence_code='go', 2026):           4 dana —
--     06.05, 07.05, 15.06, 23.06
--   vacation_entitlements 2026: days_total 20, preneto 0, opening_used 2,
--     accrual_model=true, accrual_start 2026-01-19,
--     note „Reset 01.05.2026: … opening_used=iskorišćeno do 01.05 iz dokumenta"
--   → `opening_used` (2) = TAČNO ona dva dokumenta-dana pre reseta (17.04, 27.04)
--   → saldo: iskorišćeno 2 + 4 = 6 = dokument, preostalo 20 − 6 = 14.
--
-- ZAKLJUČAK: Anđićev saldo se poklapa sa HR dokumentom dan za dan. NEMA ŠTA DA
-- SE VRATI — dodavanje 2 dana bi mu dalo 2 dana viška, tj. napravilo grešku koju
-- ovaj nalog treba da ispravi. Zato ovaj fajl NIJE „vrati dva dana", nego
-- KONTROLA koja to dokazuje, plus sanacija koja se pali SAMO od podataka.
--
-- PLATA: nije dirnuta ni u jednom scenariju. (a) Registar odluka §0 (Nenad,
-- 30.07.2026): grid je izvor istine za zaradu tek OD JUNA 2026, maj i ranije nisu
-- merodavni; (b) izmereno — `v_salary_payroll_month` za Anđića nema NIJEDAN red
-- (ni maj, ni jun), pa nema obračuna koji bi se pomerio. GO dan u gridu utiče na
-- saldo odmora, ne na isplaćeno.
--
-- ŠTA KORAK 2 RADI: upisuje `go` red u grid SAMO za dan koji dokument zna kao
-- GO, a koji NIJE ni u gridu ni pokriven `opening_used`-om. Skup se računa iz
-- podataka; danas je PRAZAN (KORAK 1.4 mora vratiti 0 redova) pa je izvršavanje
-- no-op. Ostavljen je jer je idempotentan i jer bi uhvatio pravi gubitak ako se
-- pojavi. Ako KORAK 1.4 vrati bilo šta — STANI i javi, to je nov nalaz.
--
-- ŠTA NE RADI: ne dira `vacation_entitlements` (ni days_total ni opening_used),
-- ne dira dane koje dokument ne zna (20.05, 10.04, 13.04), ne dira nikog drugog,
-- ne dira platu ni jedan obračun.
-- ============================================================================

-- ── KORAK 1 — KONTROLA (čist SELECT, bez izmena) ────────────────────────────

-- 1.1 Merodavni dokument (Excel/HR evidencija) za 2026.
--     Očekivano: 6 dana — 17.04, 27.04, 06.05, 07.05, 15.06, 23.06.
SELECT g.used_date, g.source_year, COALESCE(g.comment, '') AS napomena
  FROM vacation_go_days g
 WHERE g.employee_id = '969970e9-c8a5-46ff-8d65-c7fcdb13e7ee'  -- Mladen Anđić
   AND g.source_year = 2026
 ORDER BY g.used_date;

-- 1.2 Grid danas + „normalan" GO red kao šablon (0 sati u SVAKOJ koloni,
--     absence_code='go', bez podtipa). Očekivano: 4 reda, svi po šablonu.
SELECT w.work_date, w.hours, w.overtime_hours, w.field_hours, w.two_machine_hours,
       w.absence_code, w.absence_subtype, COALESCE(w.note, '') AS note,
       w.last_edited_by, w.updated_at
  FROM work_hours w
 WHERE w.employee_id = '969970e9-c8a5-46ff-8d65-c7fcdb13e7ee'
   AND w.absence_code = 'go'
 ORDER BY w.work_date;

-- 1.3 Saldo i račun: opening_used + grid_go mora biti = broj dana iz dokumenta.
--     Očekivano: dokument 6, opening_used 2, grid 4, zbir 6, razlika 0,
--     preostalo 14 (nema manjka → nema šta da se vraća).
SELECT v.days_total, v.days_carried_over, v.opening_used, v.accrual_model, v.accrual_start,
       (SELECT count(*) FROM vacation_go_days g
         WHERE g.employee_id = v.employee_id AND g.source_year = 2026)          AS dokument_dana,
       (SELECT count(*) FROM work_hours w
         WHERE w.employee_id = v.employee_id AND w.absence_code = 'go'
           AND EXTRACT(year FROM w.work_date) = 2026)                           AS grid_go_dana,
       b.days_used, b.days_remaining,
       (SELECT count(*) FROM vacation_go_days g
         WHERE g.employee_id = v.employee_id AND g.source_year = 2026)
         - b.days_used                                                          AS razlika_dokument_minus_saldo
  FROM vacation_entitlements v
  JOIN v_vacation_balance b ON b.employee_id = v.employee_id AND b.year = v.year
 WHERE v.employee_id = '969970e9-c8a5-46ff-8d65-c7fcdb13e7ee' AND v.year = 2026;

-- 1.4 ⚠️ KAPIJA ZA KORAK 2: dani iz dokumenta koji nisu ni u gridu ni pokriveni
--     `opening_used`-om. OČEKIVANO: 0 REDOVA. Ako vrati red — stani i javi.
WITH doc AS (
  SELECT g.used_date
    FROM vacation_go_days g
   WHERE g.employee_id = '969970e9-c8a5-46ff-8d65-c7fcdb13e7ee'
     AND g.source_year = 2026
     AND NOT EXISTS (SELECT 1 FROM work_hours w
                      WHERE w.employee_id = g.employee_id
                        AND w.work_date = g.used_date
                        AND w.absence_code = 'go')
), ent AS (
  SELECT opening_used FROM vacation_entitlements
   WHERE employee_id = '969970e9-c8a5-46ff-8d65-c7fcdb13e7ee' AND year = 2026
)
SELECT d.used_date AS dan_koji_bi_se_vratio,
       (SELECT count(*) FROM doc)  AS dokument_van_grida,
       (SELECT opening_used FROM ent) AS pokriveno_opening_used
  FROM doc d
 WHERE (SELECT count(*) FROM doc) > (SELECT opening_used FROM ent)
 ORDER BY d.used_date;

-- ── KORAK 2 — SANACIJA (pokrenuti SAMO ako je KORAK 1.4 vratio redove) ──────
-- Danas je no-op po konstrukciji: isti WHERE kao 1.4. Idempotentno (ON CONFLICT
-- DO NOTHING + uslov „dokument_van_grida > opening_used"). NE dira entitlement:
-- dodavanje GO reda u grid samo prebacuje dan iz „nije evidentiran" u
-- „iskorišćen", što je i smisao vraćanja izgubljenog dana.
BEGIN;

WITH doc AS (
  SELECT g.employee_id, g.used_date
    FROM vacation_go_days g
   WHERE g.employee_id = '969970e9-c8a5-46ff-8d65-c7fcdb13e7ee'
     AND g.source_year = 2026
     AND NOT EXISTS (SELECT 1 FROM work_hours w
                      WHERE w.employee_id = g.employee_id
                        AND w.work_date = g.used_date
                        AND w.absence_code = 'go')
), ent AS (
  SELECT opening_used FROM vacation_entitlements
   WHERE employee_id = '969970e9-c8a5-46ff-8d65-c7fcdb13e7ee' AND year = 2026
)
INSERT INTO work_hours
      (employee_id, work_date, hours, overtime_hours, field_hours, two_machine_hours,
       absence_code, note, project_ref, last_edited_by, created_at, updated_at)
SELECT d.employee_id, d.used_date, 0, 0, 0, 0,
       'go',
       'vraćen GO dan po HR dokumentu (sanacija 068/26, 04.08.2026)',
       '', 'fix:068-go-restore', now(), now()
  FROM doc d
 WHERE (SELECT count(*) FROM doc) > (SELECT opening_used FROM ent)
ON CONFLICT (employee_id, work_date) DO UPDATE
   SET absence_code = 'go',
       hours = 0, overtime_hours = 0, field_hours = 0, two_machine_hours = 0,
       note = CASE WHEN COALESCE(work_hours.note, '') = ''
                   THEN 'vraćen GO dan po HR dokumentu (sanacija 068/26, 04.08.2026)'
                   ELSE work_hours.note || ' | vraćen GO dan po HR dokumentu (sanacija 068/26)' END,
       last_edited_by = 'fix:068-go-restore',
       updated_at = now()
 WHERE work_hours.absence_code IS DISTINCT FROM 'go';

COMMIT;

-- ── KORAK 3 — VERIFIKACIJA ──────────────────────────────────────────────────

-- 3.1 Saldo posle (ako je KORAK 2 bio no-op, brojke su iste kao u 1.3:
--     iskorišćeno 6, preostalo 14, razlika 0).
SELECT b.days_total, b.days_carried_over, b.opening_used, b.dated_used,
       b.days_used, b.days_remaining
  FROM v_vacation_balance b
 WHERE b.employee_id = '969970e9-c8a5-46ff-8d65-c7fcdb13e7ee' AND b.year = 2026;

-- 3.2 Grid GO dani posle (očekivano i dalje 4: 06.05, 07.05, 15.06, 23.06).
SELECT work_date, hours, absence_code, last_edited_by
  FROM work_hours
 WHERE employee_id = '969970e9-c8a5-46ff-8d65-c7fcdb13e7ee' AND absence_code = 'go'
 ORDER BY work_date;

-- 3.3 Kontrola da nije nastao višak: dokument ≥ saldo iskorišćenog.
--     Očekivano: razlika = 0 (ne sme postati negativna).
SELECT (SELECT count(*) FROM vacation_go_days
         WHERE employee_id = '969970e9-c8a5-46ff-8d65-c7fcdb13e7ee' AND source_year = 2026)
       - (SELECT days_used FROM v_vacation_balance
           WHERE employee_id = '969970e9-c8a5-46ff-8d65-c7fcdb13e7ee' AND year = 2026)
       AS razlika_dokument_minus_saldo;
