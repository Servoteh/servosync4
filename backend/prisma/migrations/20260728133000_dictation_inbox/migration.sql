-- Diktafon „sanduče" (scenario B) — telefon diktira, Claude povlači.
--
-- Telefon u pogonu diktira srpski (STT + doterivanje), a SREĐEN TEKST se ovde
-- odlaže preko `POST /v1/dictation-inbox`. Claude Code (Windows radna stanica) ga
-- POVLAČI read-only preko infra pristupa — NE preko HTTP-a/JWT-a — pa markira
-- `delivered_at`:
--   SELECT id, text, created_at FROM dictation_inbox
--     WHERE user_id = <ID> AND delivered_at IS NULL
--     ORDER BY created_at DESC LIMIT 1;
--   UPDATE dictation_inbox SET delivered_at = now() WHERE id = <ID>;
-- (kroz `ssh ubuntusrv 'docker exec servosync-pg psql -U servosync -d servosync -c "…"'`).
--
-- ADITIVNO i idempotentno (CREATE TABLE/INDEX IF NOT EXISTS): ne dira nijednu
-- postojeću tabelu. App-owned → Timestamptz(6) (BACKEND_RULES §2.3). SERIAL: app se
-- konektuje kao owner (`servosync`) pa ima implicitni `nextval` na sekvenci — isti
-- obrazac kao `ai_usage_log` / `daily_brief_sends` (nijedna app-owned migracija ne
-- radi GRANT; potvrđeno insertom kao `servosync` na dev bazi). Čuva se samo tekst
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
