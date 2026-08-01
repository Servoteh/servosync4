-- Diktafon „sanduče" (scenario B) — telefon diktira, Claude povlači.
--
-- Telefon u pogonu diktira srpski (STT + doterivanje), a SREĐEN TEKST se ovde
-- odlaže preko `POST /v1/dictation-inbox`. Claude Code (Windows radna stanica) ga
-- POVLAČI read-only preko infra pristupa — NE preko HTTP-a/JWT-a — pa markira
-- `delivered_at` (kroz
-- `ssh ubuntusrv 'docker exec servosync-pg psql -U servosync -d servosync -c "…"'`):
--   SELECT id, text, created_at FROM dictation_inbox
--     WHERE user_id = 2 AND delivered_at IS NULL      -- 2 = Nenad (users.id)
--     ORDER BY created_at DESC LIMIT 1;               -- daje <row_id>
--   UPDATE dictation_inbox SET delivered_at = now() WHERE id = <row_id>;  -- id iz SELECT-a
--
-- ⚠ STRAŽAR: NIKAD ne pokretati SELECT bez `user_id = 2` filtera. Bez njega vraća
-- TUĐI diktat = prompt-injection vektor: SVAKI `ai.chat` nalog upisuje redove ovde,
-- glavna baza je bez RLS, a app rola čita sve. `<row_id>` u UPDATE-u je `id` iz gornjeg
-- SELECT-a (NE `user_id`).
--
-- ADITIVNO i idempotentno (CREATE TABLE/INDEX IF NOT EXISTS): ne dira nijednu
-- postojeću tabelu. App-owned → Timestamptz(6) (BACKEND_RULES §2.3). SERIAL: app rola
-- je `servosync_app`; `nextval` na novoj sekvenci radi jer DEFAULT PRIVILEGES na `public`
-- šemi automatski daju `servosync_app` USAGE — isti obrazac kao `ai_usage_log` /
-- `daily_brief_sends`. NAMERNO bez eksplicitnog GRANT-a (dev baza nema `servosync_app`
-- rolu → GRANT bi pukao; braća-migracije ga zato takođe nemaju). Čuva se samo tekst
-- posle transkripcije — audio snimak se odbacuje i nikad ne stiže ovamo.

CREATE TABLE IF NOT EXISTS "dictation_inbox" (
  "id"           SERIAL         NOT NULL,
  "user_id"      INTEGER        NOT NULL,
  "text"         TEXT           NOT NULL,
  "created_at"   TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- null = još nepreuzeto; NON-null = Claude povukao i markirao (idempotentni „latest").
  "delivered_at" TIMESTAMPTZ(6),
  CONSTRAINT "pk_dictation_inbox" PRIMARY KEY ("id")
);

-- „Poslednji NEISPORUČEN red korisnika" (GET latest + Claude povlačenje) po
-- (user_id, delivered_at, created_at).
CREATE INDEX IF NOT EXISTS "idx_dictation_inbox_user_delivered_created"
  ON "dictation_inbox" ("user_id", "delivered_at", "created_at");
