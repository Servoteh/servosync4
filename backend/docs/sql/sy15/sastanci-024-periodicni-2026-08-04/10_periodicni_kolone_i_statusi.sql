-- Sastanci 024/26 — KORAK 1: tip 'periodicni' + kolone serije + status 'otkazan'.
--
-- ODOBRENJE: zahtev 024/26 — Zoran predložio, tri predloga potvrdio komentarom
-- 28.07.2026 („Saglasan sam sa sva tri predloga"): (1) periodični tip sa
-- intervalom, (2) promena tipa postojećeg sastanka, (3) prenos otvorenih stavki
-- sa izborom izvornog sastanka. Aditivna izmena po obrascu
-- `sastanci-lifecycle-2026-07-18/40_sastanci_template_id.sql`.
--
-- ŠTA RADI (sve u JEDNOJ transakciji; tabela je mala pa je kratki ACCESS
-- EXCLUSIVE lock bezopasan):
--   1. `sastanci_tip_check` dobija 'periodicni'.
--   2. `sastanci_status_check` dobija 'otkazan' — POPRAVKA LATENTNOG KVARA:
--      3.0 `SastanciService.cancel()` (fix 021/26, 30.07) radi
--      `UPDATE ... SET status='otkazan'`, a živi CHECK to NE dozvoljava, pa
--      „Otkaži sastanak" od 30.07 svima pada na 23514 → 422. Isto bi palo i
--      `sast_weekly_odlozi` (UPDATE status='otkazan' za sedmični). Izmereno
--      na živoj bazi 04.08.2026 (00_preflight A/E).
--   3. `interval_days` — broj dana između dva termina periodičnog sastanka
--      (NULL za sve ostale tipove; opseg 1..365).
--   4. `prethodni_sastanak_id` — veza ka PRETHODNOM sastanku u seriji. Smer
--      dete→roditelj NAMERNO: automatika tako NIKAD ne radi UPDATE nad
--      zatvorenim/zaključanim prethodnikom (guard-triger `sast_check_not_locked`
--      bi ga odbio), nego samo INSERT novog reda. Veza je i idempotency ključ
--      automatike (novi termin se pravi samo za sastanak BEZ naslednika) i izvor
--      kolone „Sledeći" u tabeli sastanaka.
--
-- KO ČITA/PIŠE: 3.0 backend (grana fix/sastanci-dopune-024). Kolone NISU
-- mapirane u `prisma/sy15.prisma` (namerno — mapirana kolona koje još nema u
-- bazi bi oborila SVAKO čitanje sastanaka); pristup ide kroz raw SQL iza
-- provere `information_schema` koja se KEŠIRA po procesu → POSLE primene
-- restartovati backend.
--
-- RLS/GRANT: nove kolone nasleđuju TABLE-level grantove (preflight C potvrđuje
-- da nema column-level grantova); RLS politike na `sastanci` ostaju netaknute.
--
-- ROLLBACK (ako zatreba): vrati stare CHECK-ove (bez 'periodicni'/'otkazan' —
-- ali tek POŠTO se eventualni novi redovi obrišu) i `ALTER TABLE ... DROP COLUMN
-- interval_days, DROP COLUMN prethodni_sastanak_id`.
-- ============================================================================

BEGIN;

-- 1) tip: + 'periodicni'
ALTER TABLE public.sastanci DROP CONSTRAINT sastanci_tip_check;
ALTER TABLE public.sastanci ADD CONSTRAINT sastanci_tip_check
  CHECK (tip = ANY (ARRAY['sedmicni'::text, 'projektni'::text, 'tematski'::text,
                          'dnevni'::text, 'periodicni'::text]));

-- 2) status: + 'otkazan' (popravka 021/26 otkazivanja)
ALTER TABLE public.sastanci DROP CONSTRAINT sastanci_status_check;
ALTER TABLE public.sastanci ADD CONSTRAINT sastanci_status_check
  CHECK (status = ANY (ARRAY['planiran'::text, 'u_toku'::text, 'zavrsen'::text,
                             'zakljucan'::text, 'otkazan'::text]));

-- 3) interval serije (samo periodični; validaciju tip↔interval sprovodi 3.0
--    servis — kompozitni CHECK bi oborio dvokoračni upis tip pa interval).
ALTER TABLE public.sastanci ADD COLUMN IF NOT EXISTS interval_days integer
  CONSTRAINT sastanci_interval_days_check
  CHECK (interval_days IS NULL OR interval_days BETWEEN 1 AND 365);

-- 4) veza na prethodni termin serije (dete→roditelj; brisanje prethodnika ne
--    ruši naslednika). Parcijalni UNIQUE (review 024/26 Minor-1): jedan sastanak
--    sme imati NAJVIŠE JEDNOG naslednika — tvrda brana od duple automatike
--    (soft NOT EXISTS guard u automatici + ovaj indeks; 23505 automatika hvata
--    per-kandidat i samo preskoči). Ujedno služi i kao indeks za lookup.
ALTER TABLE public.sastanci ADD COLUMN IF NOT EXISTS prethodni_sastanak_id uuid
  REFERENCES public.sastanci(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS sastanci_prethodni_sastanak_uq
  ON public.sastanci (prethodni_sastanak_id)
  WHERE prethodni_sastanak_id IS NOT NULL;

COMMIT;

-- Provera posle primene (očekivano: oba CHECK-a sa novim vrednostima, 2 kolone):
SELECT conname, pg_get_constraintdef(oid)
FROM   pg_constraint WHERE conrelid = 'public.sastanci'::regclass ORDER BY conname;
SELECT column_name FROM information_schema.columns
WHERE  table_schema='public' AND table_name='sastanci'
  AND  column_name IN ('interval_days','prethodni_sastanak_id');
