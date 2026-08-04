-- Sastanci 024/26 (Zoran, komentar 29.07 + tri predloga potvrđena 28.07) — KORAK 0:
-- PREFLIGHT (READ-ONLY). Ništa ne menja — sačuvati izlaz pre koraka 10/20.
--
-- KONTEKST: sy15 je ŽIVA produkcija. Paket dodaje na `sastanci`:
--   * tip 'periodicni' u CHECK `sastanci_tip_check`,
--   * 'otkazan' u CHECK `sastanci_status_check` (⚠️ LATENTNI KVAR: 3.0
--     `SastanciService.cancel()` od fix-a 021/26 radi UPDATE status='otkazan',
--     a živi CHECK ga NE dozvoljava → svaki „Otkaži sastanak" pada na 23514 → 422;
--     izmereno na živoj bazi 04.08.2026: CHECK bez 'otkazan', nijedan red otkazan),
--   * kolone `interval_days` + `prethodni_sastanak_id` (serija periodičnih),
-- i sužava prozor podsetnika u `sastanci_enqueue_meeting_reminders` na 25–35 min
-- (korak 20; spregnuto sa 3.0 scheduler kadencom 5 min — vidi zaglavlje koraka 20).
--
-- KO PRIMENJUJE: vlasnik (Nenad), ručno, kao `supabase_admin` (sy15 `postgres`
-- NIJE superuser). Agenti/kod NE izvršavaju ove skripte.
-- POSLE PRIMENE: restart 3.0 backenda — servis kešira (procesno) da li kolone
-- postoje; bez restarta periodični tip ostaje isključen sa porukom.
-- REDOSLED: 00 (ovaj) → 10 (kolone+CHECK) → 20 (podsetnik prozor).
-- Kod (grana fix/sastanci-dopune-024) sme na prod i PRE primene: bez kolona se
-- periodični tip uredno odbija porukom, a podsetnik samo stiže koji minut ranije.
-- ============================================================================

-- (A) Postojeći CHECK-ovi na sastanci (očekivano: tip BEZ 'periodicni',
--     status BEZ 'otkazan' — to je i dokaz latentnog kvara otkazivanja).
SELECT conname, pg_get_constraintdef(oid)
FROM   pg_constraint
WHERE  conrelid = 'public.sastanci'::regclass
ORDER  BY conname;

-- (B) Kolone koje korak 10 dodaje (očekivano: 0 redova).
SELECT column_name, data_type
FROM   information_schema.columns
WHERE  table_schema = 'public' AND table_name = 'sastanci'
  AND  column_name IN ('interval_days', 'prethodni_sastanak_id');

-- (C) Grantovi na tabeli (novi stubovi nasleđuju TABLE-level grantove; ako je
--     ovde išta column-level, korak 10 mora dodati eksplicitan GRANT).
SELECT grantee, privilege_type
FROM   information_schema.role_table_grants
WHERE  table_schema = 'public' AND table_name = 'sastanci'
ORDER  BY grantee, privilege_type;

-- (D) Živa definicija podsetnika (korak 20 je menja): očekivano prozor
--     „BETWEEN (now() + interval '15 minutes') AND (now() + interval '45 minutes')".
SELECT pg_get_functiondef('public.sastanci_enqueue_meeting_reminders()'::regprocedure);

-- (E) Statusi u tabeli (očekivano: nijedan 'otkazan' — CHECK ga do sada nije puštao).
SELECT status, count(*) FROM public.sastanci GROUP BY status ORDER BY status;
