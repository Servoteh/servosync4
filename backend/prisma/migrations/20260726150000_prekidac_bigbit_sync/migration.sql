-- Stavka B (26.07.2026) — korisnički prekidač za noćni BigBit (.mdb) uvoz.
-- Vlasnik je tražio check polje u Podešavanjima kojim ručno gasi/pali sinhronizaciju.
-- Stanje MORA da živi u bazi (menja se bez restarta), i NE sme u `system_config` /
-- `global_config` — te dve tabele su BigBit ogledala i full_refresh sync ih briše.
--
-- Semantika: OFF-prekidač. Red koji ne postoji = UKLJUČENO (nedostatak reda ne sme tiho
-- da ugasi noćni uvoz i napravi „sync je ugašen mesec dana, a niko ne zna").

CREATE TABLE IF NOT EXISTS "app_switches" (
  "key"                 VARCHAR(64)  NOT NULL,
  "enabled"             BOOLEAN      NOT NULL DEFAULT TRUE,
  "note"                TEXT,
  "updated_by_user_id"  INTEGER,
  "updated_by_email"    VARCHAR(200),
  "updated_at"          TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at"          TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pk_app_switches" PRIMARY KEY ("key")
);

-- Seed prekidača za noćni BigBit uvoz — UKLJUČEN po difoltu (posao se ionako ne izvršava
-- dok ga stavka A ne registruje; kad se registruje, radi bez dodatne radnje admina).
INSERT INTO "app_switches" ("key", "enabled", "note")
VALUES ('bigbit_mdb_sync', TRUE, 'Noćni uvoz iz BigBita (.mdb) — uključeno pri uvođenju prekidača.')
ON CONFLICT ("key") DO NOTHING;
