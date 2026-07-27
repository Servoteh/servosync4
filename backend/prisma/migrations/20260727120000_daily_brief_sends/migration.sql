-- Talas AI-3 — dnevni brief direktoru (docs/PLAN_AI_OS_2026-07.md §5 TALAS AI-3).
--
-- `daily_brief_sends` je REGISTAR IDEMPOTENCIJE + trag slanja: jedan red po
-- (dan, primalac). Scheduler posao `daily-brief` PRE slanja radi atomski claim
-- (INSERT ... ON CONFLICT DO UPDATE ... WHERE status IN ('pending','dry_run')):
--   • red vraćen  → ovaj proces je vlasnik slanja za tog primaoca danas → šalje;
--   • nema reda   → već POSLATO ('sent') danas → PRESKAČE (nema duplog mejla),
--     i to i uz catch-up/retry scheduler-a i uz više instanci.
-- Red se upisuje kao 'pending' i tek posle uspeha prelazi u 'sent'/'dry_run'.
-- 'pending' (prekinut prethodni pokušaj/crash) i 'dry_run' (RESEND je bio ugašen,
-- pa upaljen isti dan) su RE-CLAIM-abilni; 'sent' NIJE (jak dup-guard za prave mejlove).
-- Na TVRDI pad slanja red se BRIŠE, pa sledeći prolaz (isti dan) sme ponovo.
--
-- ADITIVNO i idempotentno: ne dira nijednu postojeću tabelu. App-owned →
-- Timestamptz(6) (BACKEND_RULES §2.3). SERIAL: app se konektuje kao owner
-- (`servosync`) pa ima implicitni `nextval` na sekvenci — isti obrazac kao
-- `ai_usage_log`/`scheduled_job_runs` (nijedna app-owned migracija ne radi GRANT).

CREATE TABLE IF NOT EXISTS "daily_brief_sends" (
  "id"              SERIAL       NOT NULL,
  "for_date"        DATE         NOT NULL,
  "recipient_email" VARCHAR(255) NOT NULL,
  "sent_at"         TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- 'pending' (claim, još nije poslato) | 'sent' (poslato) | 'dry_run' (RESEND
  -- nekonfigurisan — nije stvarno poslato). Claim upisuje 'pending'; terminalni
  -- status postavlja app posle slanja.
  "status"          VARCHAR(10)  NOT NULL DEFAULT 'pending',
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
