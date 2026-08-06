-- Registar idempotencije 3.0 aplikacije — 3.0 parnjak sy15 `rev_api_idempotency`.
-- Runbook: docs/SEOBA_SASTANCI_PB_2026-08-05.md §7c, blokada 1.
--
-- ZAŠTO GENERIČKO IME: sy15 tabela uprkos `rev_` prefiksu NIKAD nije bila samo za
-- reverse — izmereno 05.08.2026: 643 reda, 35 različitih `action` vrednosti iz
-- kadrovske (`kadr.grid.batch` 368), profila, sastanaka, projektnog biroa i
-- održavanja. Reversi su u njoj imali UKUPNO 2 reda. Ovu tabelu će zato koristiti
-- svi preostali koraci gašenja sy15, ne samo sastanci.
--
-- OFFLINE MIGRACIJA (BACKEND_RULES §12): nova prazna tabela, bez backfill-a, bez
-- ijedne izmene postojećih objekata → nema zaključavanja i nema tačke bez povratka.
-- Povratak je `DROP TABLE api_idempotency;` (tabela je nova i prazna).
--
-- 🔴 STARI ZAPISI SE NE MIGRIRAJU. Registar je po prirodi kratkotrajan: brani od
-- duplog klika i retry-a, a taj prozor su sekunde. Prenos 643 tuđa ključa ne bi
-- odbranio nijedan zahtev (klijent za svaki novi POST kuje NOV uuid) — samo bi
-- preneo smeće. Merenje raspona u sy15 (05.08.2026): najstariji red 10.07.2026,
-- najnoviji isti dan, 643 reda, a NIJEDAN nikad nije obrisan — sy15 nema ni
-- pg_cron posao ni triger za čišćenje. Ovde to radi `RetentionJobsService`.

CREATE TABLE "api_idempotency" (
    -- PK je SAM ključ (kao u sy15), namerno bez `action`: isti clientEventId
    -- upotrebljen za drugu akciju je greška klijenta i mora da vrati 409, a ne da
    -- tiho napravi drugi red. PK je i brava — konkurentan isti ključ čeka na
    -- speculative-insert bravi dok prva transakcija ne završi.
    "client_event_id" UUID         NOT NULL,
    "action"          VARCHAR(100) NOT NULL,
    -- Nema ga u sy15 izvoru. Bez njega ponovljen zahtev vraća sačuvan odgovor
    -- BILO KOME ko zna ključ, a odgovor ume da nosi tuđe podatke (npr. id i naslov
    -- tuđeg sastanka). Ključ je nasumičan uuid pa je u sy15 praktično neiskoristivo
    -- — ali provera ne košta ništa, pa se zatvara ovde.
    "actor_email"     VARCHAR(255) NOT NULL,
    -- Sačuvan odgovor prvog izvršenja. NULL = ključ zauzet a izvršenje još traje
    -- (upis rezultata je poslednji korak iste transakcije).
    "result"          JSONB,
    "created_at"      TIMESTAMPTZ  NOT NULL DEFAULT now(),

    CONSTRAINT "pk_api_idempotency" PRIMARY KEY ("client_event_id")
);

-- Za retention brisanje (`created_at < cutoff`) — sy15 ga nema jer tamo čišćenja
-- nema, pa bi noćni posao bez ovog indeksa radio pun scan.
CREATE INDEX "idx_api_idempotency_created" ON "api_idempotency" ("created_at");

COMMENT ON TABLE "api_idempotency" IS
  'Registar idempotencije cele 3.0 aplikacije (parnjak sy15 rev_api_idempotency). '
  'Ključ + akcija se upisuju u ISTOJ transakciji sa samom akcijom, pa rollback '
  'akcije oslobađa ključ i retry je dozvoljen. Čisti RetentionJobsService.';
