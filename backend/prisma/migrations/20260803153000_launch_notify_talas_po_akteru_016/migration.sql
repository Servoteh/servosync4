-- 016/26 treći krug (Strahinja Petrović, 03.08): „Ne želimo da stižu obaveštenja za
-- pojedinačne pozicije… Samo za nacrt kad se lansira, ništa više."
--
-- PROBLEM: lansiranje NEMA bulk poziv — i ekran „Primopredaje" i ekran „Radni nalozi"
-- šalju JEDAN HTTP poziv po poziciji, a `LaunchNotifyService.notifyLaunch` je slao mejl
-- + zvonce ODMAH po svakom pozivu. Izmereno na produ (work_order_launch_notifications,
-- 27.07–03.08): talasi do 11 lansiranja za ~11 min od ISTOG radnika, medijan razmaka
-- između uzastopnih lansiranja 96 s → nacrt od 30 pozicija = 30 mejlova po planeru.
--
-- REŠENJE: postojeći claim red (idempotencija po primopredaji — OSTAJE netaknuta)
-- postaje i RED ČEKANJA: `notified_at IS NULL` = obaveštenje na čekanju u agregacionom
-- prozoru. Sweeper (in-process tik na 30 s, obrazac SchedulerService — bez novih
-- zavisnosti, BACKEND_RULES §10) grupiše pending redove PO AKTERU i šalje JEDAN zbirni
-- mejl/zvonce kad talas utihne (3 min tišine) ili kad najstariji red čeka 15 min.
-- Restart usred prozora ništa ne gubi: redovi su u bazi, sweeper posle boot-a nastavlja.
--
-- ADITIVNO i idempotentno (ADD COLUMN / CREATE INDEX IF NOT EXISTS); ne dira postojeće
-- redove — svi imaju notified_at upisan, pa deploy ne okida naknadna slanja.

-- Ključ agregacije + „lansirao X" u zbirnom mejlu; mora preživeti restart, zato kolona
-- a ne memorija procesa. Soft ref → workers.id, BEZ FK — isti razlog kao ostale kolone
-- ove tabele (batch-resolve obrazac; brisanje radnika ne sme da obori claim upis).
-- NULL = nalog bez vezanog radnika (grupišu se zajedno) ili red od pre ove kolone.
ALTER TABLE "work_order_launch_notifications"
  ADD COLUMN IF NOT EXISTS "actor_worker_id" INTEGER;

COMMENT ON COLUMN "work_order_launch_notifications"."actor_worker_id" IS
  'workers.id radnika koji je lansirao — ključ agregacije zbirnog obaveštenja (016/26 treći krug); NULL = bez vezanog radnika ili red od pre kolone.';

-- Sweeper na svakih 30 s čita SAMO pending redove (notified_at IS NULL) — partial
-- indeks drži taj skup mali i odvojen od istorije (koja samo raste). Prisma šema ne
-- ume WHERE indekse, zato SQL-only (dokumentovano u schema.prisma).
CREATE INDEX IF NOT EXISTS "idx_work_order_launch_notifications_pending"
  ON "work_order_launch_notifications" ("actor_worker_id", "created_at")
  WHERE "notified_at" IS NULL;
