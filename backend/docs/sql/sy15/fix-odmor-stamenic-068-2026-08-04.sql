-- ============================================================================
-- DATA-FIX 068/26: „Odmor Neđa" — Nedeljko Stamenić, dan za rad subotom 01.08.2026
-- Datum: 2026-08-04 · Baza: sy15 (ubuntusrv, docker sy15-db, user supabase_admin)
-- Grana: fix/odmor-nedjo-068
-- Izvršavanje: ssh ubuntusrv "docker exec -i sy15-db psql -U supabase_admin -d postgres" < ovaj_fajl
--   (ili korak po korak; KORAK 1 je čist SELECT — UVEK prvo njega)
-- ============================================================================
--
-- ZAHTEV (Duško Kostić, 04.08.2026 20:34): „treba da dodamo još dva dana odmora
-- Nedeljku Stameniću. Ta dva dana je slučajno obrisao Hal 9000 prilikom
-- prepravljanja unosa mesečnih sati."
--
-- ── ŠTA JE FORENZIKA POKAZALA (izmereno na produ 04.08.2026) ─────────────────
-- NIJEDAN dan odmora Nedeljku Stameniću NIJE obrisan ni pregažen. Dokaz:
--   • work_hours ima okidač `trg_audit_work_hours` (audit_row_change → audit_log)
--     od 21.04.2026; za employee_id 6641a729-… postoji 30 audit zapisa i među
--     njima NULA DELETE i NULA promene `absence_code` sa 'go' na bilo šta.
--     Svih 10 GO dana (13–17.07 i 20–24.07) su i dalje u gridu, netaknuti,
--     onako kako ih je HR upisala 02.07.2026 12:50:08 uz odobrenje zahteva.
--   • vacation_entitlements (kadr_audit_log, 12 zapisa) — days_total išao
--     17 → 20 → 17 → 20 → 21 → 22; NIKAD umanjenje za 2. Trenutna vrednost u
--     bazi (22) je identična `after_data` poslednjeg audit zapisa (31.07.2026
--     08:29:47) → nije bilo nijedne neaudirane izmene.
--
-- ŠTA JESTE ISTINA: „dva dana" su dva dana za rad subotom (zamena dana):
--   (1) subota 04.07.2026 — zahtev 5e301155…, odobren 02.07.2026 15:00, ali
--       tadašnji tok NIJE upisivao dan (FE je slao poseban POST posle odobrenja
--       i taj poziv je izostao) → dan je 29 dana falio. Nenad ga je sanirao
--       31.07.2026 08:29:47 (vacation_bonus_days 018dcc8c…, days_total 21→22).
--       DAKLE: taj dan je VEĆ UPISAN — ne sme se dodati drugi put.
--       Uzrok je zatvoren u kodu 31.07.2026 (commit 2a496583 „weekend-work day
--       swap is exclusive and atomic") — odobrenje sad upisuje dan u ISTOJ
--       transakciji; nema više tihog gubitka.
--   (2) subota 01.08.2026 — zahtev 20f99be3…, `dan_odmora`, podneo i kao šef
--       odobrio Duško Kostić 31.07.2026 20:20/20:23. Status je ostao
--       `sef_approved` → HR finalizacija nikad nije urađena → dan NIJE upisan
--       (vacation_bonus_days za 01.08.2026 ne postoji). To je JEDINI stvarno
--       nedostajući dan. Kucanje na kapiji tu subotu je potvrđeno
--       (07:23–13:07), a auto-predlog iz kapije je 02.08. upisao 5.50 h.
--
-- ── ŠTA OVAJ SKRIPT RADI ────────────────────────────────────────────────────
-- Upisuje +1 dan GO za subotu 01.08.2026 i finalizuje zahtev 20f99be3…, tačno
-- onako kako to radi živa funkcija `kadr_grant_bonus_go` (isti ključ dedupa,
-- isti tekst napomene, isto brisanje kucanih sati tog dana):
--   2.1 vacation_bonus_days + days_total (+1) na vacation_entitlements 2026;
--   2.2 zamena dana ⊕ sati (presuda vlasnika 31.07.2026: ili sati ili slobodan
--       dan, nikad oboje) → work_hours 01.08.2026 sa 5.50 h ide na 0;
--   2.3 makeup_requests: `sef_approved` → `approved` (dual control: finalizuje
--       HR/admin, NE Duško koji je dao prvi nivo).
-- Sve vrednosti (zaposleni, datum, razlog, godina) se ČITAJU iz zahteva
-- 20f99be3…; hardkodovan je samo id tog zahteva i e-mail izvršioca.
--
-- ⚠️ PREPORUČENI PUT NIJE OVAJ SKRIPT: od 31.07.2026 dovoljno je da HR/admin
-- u aplikaciji (Kadrovska → Nadoknade) klikne „Odobri" na zahtev 20f99be3 —
-- backend tada radi isto ovo atomično i uz audit/mejl. Ovaj skript je rezerva
-- ako se ide zaobilazno. Ne škodi ako se pokrene i posle UI puta (idempotentan
-- je: dedup po `uq_vacation_bonus_days_emp_workdate`, sati se ne nuluju dvaput,
-- status se menja samo iz `sef_approved`).
--
-- ── ŠTA OVAJ SKRIPT NE RADI ─────────────────────────────────────────────────
--   • NE dodaje drugi dan. „Dva dana" iz zahteva su 04.07 (već upisan 31.07)
--     i 01.08 (ovaj skript). Slepo +2 bi Nedeljku dalo jedan dan viška.
--   • NE dira subotu 07.02.2026 (radio 07:26–14:00). Excel istorija za 2026
--     kaže: „radio 7.2. subotu, a neće raditi 18.2., samo zamena by Dule
--     magacin" — dan je već iskompenzovan slobodnim 18.02.2026 i zato nije
--     ni knjižen kao potrošen GO. Ako vlasnik proceni drugačije, to je ODLUKA,
--     ne sanacija podataka, i ide istim putem (novi makeup zahtev).
--   • NE dira 10 GO dana 13–24.07.2026, `opening_used` (4), preneto (1), ni
--     bonus dane 13.06.2026 i 04.07.2026.
--   • NE dira nijednog drugog zaposlenog (posebno NE Mladena Anđića — kod njega
--     su 06.05. i 20.05.2026 dva GO dana zaista pregažena unosom mesečnih sati,
--     ali u SUPROTNOM smeru: saldo mu je 2 dana previsok; to je zaseban nalaz
--     i zaseban fix).
-- ============================================================================

-- Izvršilac finalizacije: MORA biti HR ili admin i NE SME biti dusko.kostic@…
-- (dual control — on je dao prvi nivo odobrenja 31.07.2026 20:23).
\set hr_actor 'nevena.knezevic@servoteh.com'

-- ── KORAK 1 — PREVIEW (čist SELECT, bez ijedne izmene) ──────────────────────

-- 1.1 Ko je čovek i kakav mu je saldo GO sada.
--     Očekivano: days_total 22, preneto 1, iskorišćeno 14, preostalo 9.
SELECT e.first_name || ' ' || e.last_name        AS zaposleni,
       e.department,
       b.year, b.days_total, b.days_carried_over,
       b.opening_used, b.dated_used, b.days_used, b.days_remaining
  FROM v_vacation_balance b
  JOIN employees e ON e.id = b.employee_id
 WHERE b.employee_id = '6641a729-55a6-4a2e-901c-b4b0ca788042'  -- Nedeljko Stamenić
   AND b.year = 2026;

-- 1.2 DOKAZ da nijedan GO dan nije obrisan/pregažen (očekivano: 0 redova).
SELECT a.id, a.action, a.actor_email, a.changed_at,
       COALESCE(a.old_data, a.new_data) ->> 'work_date'  AS dan,
       a.old_data ->> 'absence_code'                     AS bilo,
       a.new_data ->> 'absence_code'                     AS postalo
  FROM audit_log a
 WHERE a.table_name = 'work_hours'
   AND COALESCE(a.old_data, a.new_data) ->> 'employee_id'
       = '6641a729-55a6-4a2e-901c-b4b0ca788042'
   AND (   (a.action = 'DELETE' AND a.old_data ->> 'absence_code' = 'go')
        OR (a.action = 'UPDATE' AND a.old_data ->> 'absence_code' = 'go'
            AND COALESCE(a.new_data ->> 'absence_code', '') <> 'go'))
 ORDER BY a.changed_at;

-- 1.3 Svi zahtevi „zamena dana" i da li im je dan STVARNO upisan.
--     Očekivano: 13.06 → 1, 04.07 → 1 (saniran 31.07), 01.08 → 0 (ovaj fix).
SELECT m.id, m.weekend_work_date, m.status, m.level1_by, m.reviewed_by,
       (SELECT count(*) FROM vacation_bonus_days b
         WHERE b.makeup_request_id = m.id
            OR (b.employee_id = m.employee_id AND b.work_date = m.weekend_work_date)
       ) AS upisanih_bonus_dana
  FROM makeup_requests m
 WHERE m.employee_id = '6641a729-55a6-4a2e-901c-b4b0ca788042'
   AND m.compensation_type = 'dan_odmora'
 ORDER BY m.weekend_work_date;

-- 1.4 Tačno šta KORAK 2 menja (očekivano: 1 red; ako je 0 — dan je već upisan).
SELECT m.id                                       AS zahtev,
       m.employee_id,
       m.weekend_work_date                        AS dan_rada,
       EXTRACT(year FROM m.weekend_work_date)::int AS godina,
       m.reason,
       m.status                                   AS status_sada,
       e.days_total                               AS days_total_sada,
       e.days_total + 1                           AS days_total_posle,
       w.hours                                    AS sati_sada,
       0                                          AS sati_posle
  FROM makeup_requests m
  LEFT JOIN vacation_entitlements e
         ON e.employee_id = m.employee_id
        AND e.year = EXTRACT(year FROM m.weekend_work_date)::int
  LEFT JOIN work_hours w
         ON w.employee_id = m.employee_id
        AND w.work_date = m.weekend_work_date
 WHERE m.id = '20f99be3-0d32-46cd-9f84-8ae4745e18d7'::uuid
   AND m.compensation_type = 'dan_odmora'
   AND m.status IN ('sef_approved', 'approved')
   AND NOT EXISTS (SELECT 1 FROM vacation_bonus_days b
                    WHERE b.employee_id = m.employee_id
                      AND b.work_date = m.weekend_work_date);

-- ── KORAK 2 — UPIS (pokrenuti TEK po pregledanom KORAKU 1) ──────────────────
BEGIN;

-- 2.1 +1 dan GO: bonus red + uvećanje fonda. Dedup ide preko parcijalnog
--     unique indeksa uq_vacation_bonus_days_emp_workdate → drugi prolaz ne
--     upiše red, pa se ni days_total ne uveća (UPDATE se veže na RETURNING).
WITH req AS (
  SELECT m.id, m.employee_id, m.weekend_work_date AS work_date, m.reason,
         EXTRACT(year FROM m.weekend_work_date)::int AS yr
    FROM makeup_requests m
   WHERE m.id = '20f99be3-0d32-46cd-9f84-8ae4745e18d7'::uuid
     AND m.compensation_type = 'dan_odmora'
     AND m.status IN ('sef_approved', 'approved')
     AND m.weekend_work_date IS NOT NULL
), ins AS (
  INSERT INTO vacation_bonus_days
        (employee_id, year, days, work_date, reason, makeup_request_id, added_by)
  SELECT r.employee_id, r.yr, 1, r.work_date, COALESCE(r.reason, ''), r.id, :'hr_actor'
    FROM req r
  ON CONFLICT (employee_id, work_date) WHERE work_date IS NOT NULL DO NOTHING
  RETURNING employee_id, year, days, work_date, reason
)
UPDATE vacation_entitlements v
   SET days_total = v.days_total + i.days::int,
       note = COALESCE(v.note, '')
              || format(' | +%s dan GO za rad vikendom %s (%s; sanacija zahteva 068/26, dodao %s %s)',
                        i.days, to_char(i.work_date, 'DD.MM.YYYY'), NULLIF(i.reason, ''),
                        :'hr_actor', to_char(CURRENT_DATE, 'DD.MM.YYYY')),
       updated_at = now()
  FROM ins i
 WHERE v.employee_id = i.employee_id
   AND v.year = i.year;

-- 2.2 Zamena dana ⊕ sati (presuda vlasnika 31.07.2026): odrađena subota se
--     kompenzuje SLOBODNIM DANOM, ne satima → sati tog dana idu na 0.
--     Idempotentno: uslov „ima sati" drugi put ne pogađa nijedan red.
--     Redovi sa absence_code se NE diraju (odsustvo nije rad).
UPDATE work_hours w
   SET hours = 0, overtime_hours = 0, two_machine_hours = 0, field_hours = 0,
       note = CASE WHEN COALESCE(w.note, '') = ''
                   THEN 'zamena dana — sati kompenzovani slobodnim danom (+1 dan GO)'
                   ELSE w.note || ' | zamena dana — sati kompenzovani slobodnim danom (+1 dan GO)'
              END,
       last_edited_by = :'hr_actor',
       updated_at = now()
  FROM makeup_requests m
 WHERE m.id = '20f99be3-0d32-46cd-9f84-8ae4745e18d7'::uuid
   AND w.employee_id = m.employee_id
   AND w.work_date  = m.weekend_work_date
   AND w.absence_code IS NULL
   AND (w.hours > 0 OR w.overtime_hours > 0 OR w.two_machine_hours > 0 OR w.field_hours > 0);

-- 2.3 Finalizacija zahteva (dual control: izvršilac ≠ onaj ko je dao 1. nivo).
UPDATE makeup_requests m
   SET status      = 'approved',
       reviewed_by = :'hr_actor',
       reviewed_at = now(),
       updated_at  = now()
 WHERE m.id = '20f99be3-0d32-46cd-9f84-8ae4745e18d7'::uuid
   AND m.status = 'sef_approved'
   AND lower(COALESCE(m.level1_by, '')) <> lower(:'hr_actor');

COMMIT;

-- ── KORAK 3 — VERIFIKACIJA ──────────────────────────────────────────────────

-- 3.1 Saldo posle: days_total 23 (bilo 22), preostalo 10 (bilo 9).
SELECT e.first_name || ' ' || e.last_name AS zaposleni,
       b.days_total, b.days_carried_over, b.days_used, b.days_remaining
  FROM v_vacation_balance b
  JOIN employees e ON e.id = b.employee_id
 WHERE b.employee_id = '6641a729-55a6-4a2e-901c-b4b0ca788042'
   AND b.year = 2026;

-- 3.2 Bonus dani: očekivano 3 reda (13.06, 04.07, 01.08) i suma 3.
SELECT work_date, days, added_by, created_at, makeup_request_id
  FROM vacation_bonus_days
 WHERE employee_id = '6641a729-55a6-4a2e-901c-b4b0ca788042'
 ORDER BY work_date;

-- 3.3 Zahtev je finalizovan i sati subote su nulovani.
SELECT m.status, m.reviewed_by, m.reviewed_at,
       w.hours, w.overtime_hours, w.absence_code, w.note, w.last_edited_by
  FROM makeup_requests m
  LEFT JOIN work_hours w
         ON w.employee_id = m.employee_id AND w.work_date = m.weekend_work_date
 WHERE m.id = '20f99be3-0d32-46cd-9f84-8ae4745e18d7'::uuid;

-- 3.4 Kontrola da nema duplog dana (očekivano: 0 redova).
SELECT employee_id, work_date, count(*)
  FROM vacation_bonus_days
 WHERE employee_id = '6641a729-55a6-4a2e-901c-b4b0ca788042'
 GROUP BY 1, 2
HAVING count(*) > 1;
