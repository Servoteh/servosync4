-- Zahtev 034/26 — komentar Zorana Jarakovića 29.07.2026: „Lista primalaca obaveštenja
-- o neusaglašenosti nije dobra." IMENOVANI primaoci obaveštenja o NEUSAGLAŠENOSTI NA
-- MONTAŽI umesto role `users.role = 'menadzment'` (004/26 COO krug). Rola je na produ
-- (izmereno 04.08.2026) slala na 19 naloga uključujući spoljne i test adrese
-- (bojana.trifunovic@hapfluid.rs, test@servoteh.com, jarakovic@gmail.com), a PRESKAKALA
-- je Zorana i Nenada (rola `admin`) i Milana Stojadinovića (rola `leadpm`).
--
-- Obrazac = `masina_otpis_primaoci` (037/26, presuda Nenada 28.07): imenovani ljudi,
-- ne rola. Role korisnika se NE diraju.
--
-- KAKO SE LISTA MENJA UBUDUĆE — Podešavanja → Notifikacije (admin ekran, zahtev
-- „Nenad Jaraković može da koriguje"), ili običan SQL nad glavnom bazom:
--   dodaj:    INSERT INTO montaza_nm_primaoci (email, full_name)
--               VALUES ('ime.prezime@servoteh.com', 'Ime Prezime');
--   ugasi:    UPDATE montaza_nm_primaoci SET active = FALSE, updated_at = now()
--               WHERE email = 'ime.prezime@servoteh.com';
--   vrati:    UPDATE montaza_nm_primaoci SET active = TRUE,  updated_at = now()
--               WHERE email = 'ime.prezime@servoteh.com';
-- Promena važi od SLEDEĆE prijave — nema keša, servis čita tabelu pri svakom slanju.
-- NAPOMENA: `email` mora biti malim slovima i bez razmaka (CHECK ispod) — namerno, da
-- ručni unos ne napravi „duplog" primaoca koji se razlikuje samo po velikom slovu.

CREATE TABLE IF NOT EXISTS "montaza_nm_primaoci" (
  "id" SERIAL NOT NULL,
  "email" VARCHAR(200) NOT NULL,
  -- Samo oznaka za čoveka koji čita tabelu; ime za mejl/zvonce se svejedno preuzima iz
  -- `users` kad nalog postoji (ovde ostaje zapisano i ako naloga nema).
  "full_name" VARCHAR(150),
  "active" BOOLEAN NOT NULL DEFAULT TRUE,
  "note" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_by_user_id" INTEGER,
  CONSTRAINT "pk_montaza_nm_primaoci" PRIMARY KEY ("id")
);

-- Jedan red po mejlu. Uz CHECK-ove ispod (malim slovima, bez razmaka, sadrži @) unique
-- je stvaran, a ne samo formalan — nema „istog" primaoca u dve varijante zapisa.
CREATE UNIQUE INDEX IF NOT EXISTS "uq_montaza_nm_primaoci_email"
  ON "montaza_nm_primaoci" ("email");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ck_montaza_nm_primaoci_email_lower'
  ) THEN
    ALTER TABLE "montaza_nm_primaoci"
      ADD CONSTRAINT "ck_montaza_nm_primaoci_email_lower"
      CHECK ("email" = lower(btrim("email")));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ck_montaza_nm_primaoci_email_at'
  ) THEN
    ALTER TABLE "montaza_nm_primaoci"
      ADD CONSTRAINT "ck_montaza_nm_primaoci_email_at"
      CHECK (position('@' in "email") > 1);
  END IF;
END $$;

COMMENT ON TABLE "montaza_nm_primaoci" IS
  'Zahtev 034/26 (Zoran 29.07): imenovani primaoci obaveštenja o neusaglašenosti na montaži. '
  'Uređuje se u Podešavanja → Notifikacije ili INSERT/UPDATE-om (active=FALSE gasi primaoca). '
  'Mejl ide na svaki aktivan red; in-app zvonce samo onima sa povezanim users.worker_id.';

-- Seed = Zoranova lista od 7 ljudi (komentar na zahtevu 034/26, 29.07.2026). Svi mejlovi
-- provereni na produ 04.08.2026 (svi imaju aktivan nalog; Nenad Jaraković nema worker_id
-- pa dobija samo mejl — to je očekivano). `ON CONFLICT DO NOTHING` — ponovljena primena
-- ne vraća red koji je admin u međuvremenu ugasio niti pravi duplikat.
INSERT INTO "montaza_nm_primaoci" ("email", "full_name", "note") VALUES
  ('zoran.jarakovic@servoteh.com',    'Zoran Jaraković',    'Zahtev 034/26 (29.07)'),
  ('nenad.jarakovic@servoteh.com',    'Nenad Jaraković',    'Zahtev 034/26 (29.07)'),
  ('nenad.nikolic@servoteh.com',      'Nenad Nikolić',      'Zahtev 034/26 (29.07)'),
  ('milorad.jerotic@servoteh.com',    'Milorad Jerotić',    'Zahtev 034/26 (29.07)'),
  ('milan.stojadinovic@servoteh.com', 'Milan Stojadinović', 'Zahtev 034/26 (29.07)'),
  ('strahinja.petrovic@servoteh.com', 'Strahinja Petrović', 'Zahtev 034/26 (29.07)'),
  ('miljan.nikodijevic@servoteh.com', 'Miljan Nikodijević', 'Zahtev 034/26 (29.07)')
ON CONFLICT ("email") DO NOTHING;
