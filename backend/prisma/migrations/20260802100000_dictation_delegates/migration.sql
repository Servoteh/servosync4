-- Delegacija diktafon „sandučeta" — povlačenje diktata BEZ pristupa lokalnoj mreži.
--
-- PROBLEM: `dictation_inbox` se dosad praznio ručno, sa Windows radne stanice u
-- firmi: `ssh ubuntusrv → docker exec servosync-pg psql → SELECT … user_id = 2 …`
-- pa `UPDATE … SET delivered_at = now()`. Agent koji radi u OBLAKU (Cursor/Claude
-- pokrenut sa telefona) nema ni SSH ni 192.168.64.28 — za njega je sanduče nedostupno.
--
-- REŠENJE: `POST /api/v1/dictation-inbox/claim` (atomično uzmi+markiraj jednim
-- UPDATE-om) + OVA tabela kao dozvola. Diktate piše Nenadov telefon pod NJEGOVIM
-- nalogom, agent se prijavljuje pod SVOJIM — bez eksplicitnog reda (owner, delegate)
-- `claim` sa tuđim `ownerUserId` vraća 403. Default-deny: prazna tabela = niko ne
-- vidi tuđe sanduče, ponašanje ostaje identično dosadašnjem.
--
-- BEZBEDNOST vs stari put: identitet vlasnika više ne visi o ručno otkucanom
-- `user_id = 2` u psql komandi (greška u kucanju = tuđi diktat = prompt-injection
-- vektor), nego o JWT-u pozivaoca + redu u ovoj tabeli. Pravilo vlasnika ostaje:
-- sanduče je jedno, ko prvi povuče — njegov je; nema vraćanja na „neposlato".
--
-- ADITIVNO i idempotentno (CREATE TABLE/INDEX IF NOT EXISTS) — ne dira nijednu
-- postojeću tabelu. App-owned → Timestamptz(6) (BACKEND_RULES §3). SERIAL: app rola
-- je `servosync_app`; `nextval` na novoj sekvenci radi preko DEFAULT PRIVILEGES na
-- `public` šemi — isti obrazac kao `dictation_inbox` / `ai_usage_log`. NAMERNO bez
-- eksplicitnog GRANT-a (dev baza nema `servosync_app` rolu → GRANT bi pukao).
-- BEZ FK na `users`: paritet sa bratskom tabelom `dictation_inbox` (isti modul).

CREATE TABLE IF NOT EXISTS "dictation_delegates" (
  "id"                 SERIAL         NOT NULL,
  -- users.id vlasnika sandučeta (čiji se diktati povlače).
  "owner_user_id"      INTEGER        NOT NULL,
  -- users.id naloga kome je povlačenje dozvoljeno (agent u oblaku).
  "delegate_user_id"   INTEGER        NOT NULL,
  -- users.id admina koji je dodelio; null za redove upisane ručno SQL-om.
  "created_by_user_id" INTEGER,
  -- Slobodna beleška („Cursor agent sa telefona") — čisto za reviziju.
  "note"               VARCHAR(255),
  "created_at"         TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pk_dictation_delegates" PRIMARY KEY ("id")
);

-- Jedan par (vlasnik, delegat) = jedan red; ponovljeni „dodaj delegata" je idempotentan.
CREATE UNIQUE INDEX IF NOT EXISTS "uq_dictation_delegates_owner_delegate"
  ON "dictation_delegates" ("owner_user_id", "delegate_user_id");

-- „Čija sve sandučad smem da povučem" (izlistavanje za jednog delegata).
CREATE INDEX IF NOT EXISTS "idx_dictation_delegates_delegate"
  ON "dictation_delegates" ("delegate_user_id");
