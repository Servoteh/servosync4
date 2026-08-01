-- =============================================================================
-- STAVKA D — brane koje sprečavaju da prvi deploy pokvari produkciju
-- (28.07.2026; nalazi V6, V7 i V8 nezavisnog pregleda docs/NEZAVISAN_PREGLED_27-07.md)
-- =============================================================================
-- Tri stvari koje se ne mogu rešiti kodom:
--
--   1) PREKIDAČ NOĆNOG UVOZA SE SEJE ISKLJUČEN. Migracija 20260726150000 ga je
--      posejala na TRUE uz obrazloženje „posao se ionako ne izvršava dok ga
--      stavka A ne registruje". Stavka A ga u međuvremenu JESTE registrovala, a
--      korak 1 (host skripta + systemd timer) se instalira RUČNO i nije u
--      `deploy-backend.yml`. Prva noć posle deploy-a bi zato: pala sa
--      `BigbitMdbDropStaleError`, upisala FAILED + 2 retry-a, posle 48 h obojila
--      ekran u `danger` i naterala jutarnjeg nadzornika da SVAKOM aktivnom
--      adminu šalje po jednu poruku dnevno — zauvek, jer uzrok nije u 4.0.
--      Dogovor je da se prvi uvoz radi RUČNO I DANJU, uz čoveka koji gleda
--      brojeve. Prekidač se pali rukom, u Podešavanjima → Integracije.
--      Migracija 20260726150000 se NE prepravlja (već je primenjena, prepravka
--      bi joj razbila checksum) — gasi se ovde, korak posle nje.
--
--   2) ODBIJENA IZMENA SE ZAPISUJE. Uvoz je `ON CONFLICT DO UPDATE` i do sada je
--      smeo da prepiše i nalog u statusu LOCKED — zaključan period, već predatu
--      PDV prijavu, već izračunat bilans. Od sada uvoz takav red NE dira, ali
--      ćutanje bi bilo isto tako loše: razlika prema BigBitu mora da se vidi i
--      da čeka ljudsku odluku. Zato tabela ispod čuva STARO i NOVO stanje.
--
--   3) BEZ PUTA NAZAD NEMA PRVOG UVOZA. `backend/scripts/bigbit-mdb-unimport.ts`
--      poništava jedan `drop_id` u celini; ovde mu se dodaje jedini DB oslonac
--      koji mu treba — status `REVERTED` u manifestu drop-a (kolona je
--      VARCHAR(10), pa vrednost staje) i tabela odbijenih izmena koju čisti.
--      Sam manifest se NIKAD ne briše: on je zapisnik (v. obrazloženje
--      ON DELETE RESTRICT u 20260726170000), pa poništen uvoz ostaje vidljiv.
--
-- NAPOMENA O `schema.prisma`: `bb_import_rejected_changes` je namerno SQL-only.
-- Na grani paralelno radi više ljudi nad istim `schema.prisma`, a uvoz i skripta
-- poništavanja tabelu čitaju sirovim SQL-om (kao i ceo `bigbit-mdb-import.service.ts`).
-- Model treba dodati u `schema.prisma` pri prvom sledećem mirnom prolazu kroz taj
-- fajl; do tada NE puštati `prisma migrate dev` (koje bi je videlo kao drift).
-- =============================================================================

-- ── 1) Noćni uvoz se seje ISKLJUČEN ─────────────────────────────────────────
-- Red mora da postoji: semantika prekidača je „nema reda = UKLJUČENO", pa bi
-- puko brisanje/izostanak reda značilo suprotno od namere.
INSERT INTO "app_switches" ("key", "enabled", "note")
VALUES ('bigbit_mdb_sync', FALSE,
        'Isključen pri uvođenju (28.07.2026). Prvi uvoz iz BigBita se radi RUČNO I DANJU; '
        'noćni se pali tek kad prvi ručni uvoz da tačne brojeve.')
ON CONFLICT ("key") DO NOTHING;

-- Ako je red već posejan (20260726150000 ga seje na TRUE), gasi se — ali SAMO
-- dok ga čovek nije dirao. `updated_by_user_id`/`updated_by_email` popunjava
-- ekran Podešavanja; ako je neko svesno upalio prekidač, migracija mu to ne
-- poništava iza leđa.
UPDATE "app_switches"
   SET "enabled" = FALSE,
       "note" = 'Isključen pri uvođenju (28.07.2026). Prvi uvoz iz BigBita se radi RUČNO I DANJU; '
                'noćni se pali tek kad prvi ručni uvoz da tačne brojeve.',
       "updated_at" = now()
 WHERE "key" = 'bigbit_mdb_sync'
   AND "enabled" = TRUE
   AND "updated_by_user_id" IS NULL
   AND "updated_by_email" IS NULL;

-- ── 2) Dnevnik odbijenih izmena iz uvoza ────────────────────────────────────
CREATE TABLE IF NOT EXISTS "bb_import_rejected_changes" (
  "id"                  BIGSERIAL      NOT NULL,
  "drop_id"             INTEGER        NOT NULL,
  -- 'journal_entries' | 'ledger_entries'
  "entity"              VARCHAR(32)    NOT NULL,
  -- ključ u BigBitu (uvek popunjen za svoj entitet) i id zaštićenog 4.0 reda
  "bb_nalog_id"         INTEGER,
  "bb_stavka_id"        INTEGER,
  "target_id"           INTEGER,
  -- zašto je izmena odbijena; danas samo 'LOCKED_ENTRY'
  "reason"              VARCHAR(64)    NOT NULL,
  -- staro (4.0, zaštićeno) i novo (BigBit, odbijeno) stanje reda
  "old_value"           JSONB,
  "new_value"           JSONB,
  "detected_at"         TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  -- popunjava čovek kad odluči šta sa razlikom (odjava iz reda za odluku)
  "resolved_at"         TIMESTAMPTZ(6),
  "resolved_by_user_id" INTEGER,
  "resolution_note"     TEXT,
  CONSTRAINT "pk_bb_import_rejected_changes" PRIMARY KEY ("id")
);

-- Isti odbijeni red se ponavlja SVAKE noći dok ga čovek ne reši — bez ovoga bi
-- dnevnik rastao u duplikatima i „šta je novo" se ne bi videlo. Uvoz sam ne
-- upisuje red za koji već postoji NEREŠEN (NOT EXISTS), pa je ovo mreža.
-- `coalesce` je OBAVEZAN: `bb_nalog_id` je NULL na stavkama, `bb_stavka_id` na
-- nalozima, a NULL-ovi su u unique indeksu međusobno RAZLIČITI — bez njega
-- indeks ne bi važio ni za jedan red.
CREATE UNIQUE INDEX IF NOT EXISTS "uq_bb_import_rejected_open"
  ON "bb_import_rejected_changes"
     ("reason", "entity", (coalesce("bb_nalog_id", 0)), (coalesce("bb_stavka_id", 0)))
  WHERE "resolved_at" IS NULL;

CREATE INDEX IF NOT EXISTS "idx_bb_import_rejected_drop"
  ON "bb_import_rejected_changes" ("drop_id");

CREATE INDEX IF NOT EXISTS "idx_bb_import_rejected_open"
  ON "bb_import_rejected_changes" ("resolved_at")
  WHERE "resolved_at" IS NULL;

-- Manifest drop-a je zapisnik i ostaje; RESTRICT bi ovde bio prepreka čišćenju
-- dnevnika, a dnevnik BEZ svog drop-a nema značenje — zato CASCADE.
ALTER TABLE "bb_import_rejected_changes"
  DROP CONSTRAINT IF EXISTS "fk_bb_import_rejected_drop";
ALTER TABLE "bb_import_rejected_changes"
  ADD CONSTRAINT "fk_bb_import_rejected_drop"
  FOREIGN KEY ("drop_id") REFERENCES "bb_mdb_drops"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
