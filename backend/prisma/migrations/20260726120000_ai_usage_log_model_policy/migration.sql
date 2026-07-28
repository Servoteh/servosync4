-- Talas AI-0 — merenje AI poziva (`ai_usage_log`) + minimalni registar modela
-- (`ai_model_policy`). ADITIVNO i idempotentno: ne dira nijednu postojeću tabelu.
--
-- `ai_usage_log` piše isključivo gateway (src/common/ai/ai-usage.service.ts);
-- ujedno je izvor za dnevne token-limite (chat/STT/refine).
--
-- `ai_model_policy` se NAMERNO ne seed-uje: prazan registar znači „fallback na
-- postojeći izvor" (sy15 sastanci_ai_settings / montaza_ai_settings, env za
-- zahteve i chat), pa migracija ne menja nijedan model u pogonu. Red nastaje tek
-- kad ga admin postavi kroz Podešavanja → Sistem → AI modeli.

CREATE TABLE IF NOT EXISTS "ai_usage_log" (
  "id" SERIAL NOT NULL,
  "user_id" INTEGER,
  "module" VARCHAR(40) NOT NULL,
  "provider" VARCHAR(20) NOT NULL,
  "model" VARCHAR(80) NOT NULL,
  -- PUN ulaz (svež + keširan); za STT nosi AUDIO tokene iz odgovora, iz kojih se
  -- izvodi stvarno trajanje snimka za dnevni budžet.
  "tokens_in" INTEGER,
  "tokens_out" INTEGER,
  -- Razlaganje keširanog ulaza radi tačne procene cene: keš-čitanje ~0,1× ulazne
  -- cene, keš-upis 1,25× (5-minutni TTL). Deo su `tokens_in`, ne dodatak na njega.
  "tokens_cache_read" INTEGER,
  "tokens_cache_write" INTEGER,
  "duration_ms" INTEGER NOT NULL,
  "outcome" VARCHAR(10) NOT NULL,
  "est_cost_usd" DECIMAL(10,6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pk_ai_usage_log" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "idx_ai_usage_log_user_module_created"
  ON "ai_usage_log" ("user_id", "module", "created_at");
CREATE INDEX IF NOT EXISTS "idx_ai_usage_log_created"
  ON "ai_usage_log" ("created_at");
CREATE INDEX IF NOT EXISTS "idx_ai_usage_log_module_created"
  ON "ai_usage_log" ("module", "created_at");

CREATE TABLE IF NOT EXISTS "ai_model_policy" (
  "task" VARCHAR(40) NOT NULL,
  "model" VARCHAR(80) NOT NULL,
  "effort" VARCHAR(10),
  "updated_by" VARCHAR(200),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pk_ai_model_policy" PRIMARY KEY ("task")
);

-- Kolone za razloženi keširan ulaz dodajemo i posebno: ako je tabela nastala iz
-- ranije verzije ove (još nepush-ovane) migracije, CREATE TABLE iznad je preskočen.
ALTER TABLE "ai_usage_log" ADD COLUMN IF NOT EXISTS "tokens_cache_read" INTEGER;
ALTER TABLE "ai_usage_log" ADD COLUMN IF NOT EXISTS "tokens_cache_write" INTEGER;
