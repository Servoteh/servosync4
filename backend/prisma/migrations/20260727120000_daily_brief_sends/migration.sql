-- Talas AI-3 — dnevni brief direktoru (docs/PLAN_AI_OS_2026-07.md §5 TALAS AI-3).
--
-- `daily_brief_sends` je REGISTAR IDEMPOTENCIJE + trag slanja: jedan red po
-- (dan, primalac). Scheduler posao `daily-brief` PRE slanja radi atomski claim
-- `INSERT ... ON CONFLICT (for_date, recipient_email) DO NOTHING RETURNING id`:
--   • red vraćen  → ovaj proces je vlasnik slanja za tog primaoca danas → šalje;
--   • nema reda   → već poslato (ili u toku) danas → PRESKAČE (nema duplog mejla),
--     i to i uz catch-up/retry scheduler-a i uz više instanci.
-- Na TVRDI pad slanja (Resend vratio grešku) red se BRIŠE, pa sledeći prolaz
-- (isti dan, catch-up prozor) sme ponovo da pokuša. DRY-RUN (RESEND nekonfigurisan)
-- se NE briše — status='dry_run', tretira se kao uspeh (paritet sastanci dispatch).
--
-- ADITIVNO i idempotentno: ne dira nijednu postojeću tabelu. App-owned →
-- Timestamptz(6) (BACKEND_RULES §2.3).

CREATE TABLE IF NOT EXISTS "daily_brief_sends" (
  "id"              SERIAL       NOT NULL,
  "for_date"        DATE         NOT NULL,
  "recipient_email" VARCHAR(255) NOT NULL,
  "sent_at"         TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- 'sent' (poslato) | 'dry_run' (RESEND nekonfigurisan — nije stvarno poslato).
  "status"          VARCHAR(10)  NOT NULL DEFAULT 'sent',
  -- Trag mere uspeha: koliko sekcija/stavki je primalac dobio (vidljivo primalcu
  -- prema njegovim permisijama). Puni se posle uspešnog claim-a.
  "sections_count"  INTEGER      NOT NULL DEFAULT 0,
  "items_count"     INTEGER      NOT NULL DEFAULT 0,
  CONSTRAINT "pk_daily_brief_sends" PRIMARY KEY ("id"),
  -- Srce idempotencije: tačno jedan brief po primaocu po danu.
  CONSTRAINT "uq_daily_brief_sends_date_recipient" UNIQUE ("for_date", "recipient_email")
);

CREATE INDEX IF NOT EXISTS "idx_daily_brief_sends_for_date"
  ON "daily_brief_sends" ("for_date");
