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

-- ---------------------------------------------------------------------------
-- OPORAVAK: ko je POVUKAO koji red (`GET /v1/dictation-inbox/last-claimed`).
--
-- `claim` je destruktivan i neidempotentan: `UPDATE … SET delivered_at = now()`
-- potroši red i drugog pokušaja nema. Ako mreža pukne POSLE tog UPDATE-a a PRE
-- nego što odgovor stigne agentu, diktat je izgubljen — a sanduče je komandni
-- kanal, pa je izgubljen diktat izgubljena instrukcija.
--
-- `delivered_at` sam po sebi ne može da posluži za oporavak: kaže SAMO da je red
-- preuzet, ne i KO ga je preuzeo. Bez toga bi `last-claimed` u deljenom sandučetu
-- (vlasnik + delegat) vraćao i tuđi plen — što ruši pravilo vlasnika. Zato zasebna
-- kolona: ruta filtrira po `claimed_by_user_id = pozivalac` i svako vidi isključivo
-- ono što je već njegovo, i to samo u kratkom prozoru (15 min).
--
-- NULL ostaje kod redova preuzetih STARIM putem (ručni psql `UPDATE … delivered_at`)
-- i kod još nepreuzetih — oba tačna: njih preko HTTP-a niko nije ni uzeo.
-- BEZ FK na `users` — paritet sa ostatkom tabele (`user_id` je takođe bez FK).

ALTER TABLE "dictation_inbox"
  ADD COLUMN IF NOT EXISTS "claimed_by_user_id" INTEGER;

COMMENT ON COLUMN "dictation_inbox"."claimed_by_user_id" IS
  'users.id naloga koji je red povukao kroz POST /v1/dictation-inbox/claim; NULL = nepreuzeto ili preuzeto ručnim SQL-om.';

-- Jedini upit nad ovom kolonom je `last-claimed`: „moji preuzeti redovi, najskoriji
-- prvi". `delivered_at` je u indeksu jer se po njemu i filtrira (prozor) i sortira.
CREATE INDEX IF NOT EXISTS "idx_dictation_inbox_claimed_by_delivered"
  ON "dictation_inbox" ("claimed_by_user_id", "delivered_at");
