-- Zahtev 037/26 (dopuna, presuda Nenada 28.07) — IMENOVANI primaoci obaveštenja o
-- OTPISU MAŠINE. Do sada su se primaoci izvodili iz role `users.role = 'sef'`; ta rola
-- na produ nema nijednog ČOVEKA (jedini nosilac je servisni nalog `pdm-bridge@servoteh.com`,
-- bez `worker_id`), pa obaveštenje nije imalo kome da ode — samo warn u logu.
--
-- Presuda: primaoci su imenovani ljudi, ne rola. Interpretativno pravilo Nenada: kad u
-- zahtevu piše „šef proizvodnje", misli se na ove ljude.
--
-- KAKO SE LISTA MENJA UBUDUĆE (bez izmene koda i bez deploy-a) — običan SQL nad glavnom bazom:
--   dodaj:    INSERT INTO masina_otpis_primaoci (email, full_name)
--               VALUES ('ime.prezime@servoteh.com', 'Ime Prezime');
--   ugasi:    UPDATE masina_otpis_primaoci SET active = FALSE, updated_at = now()
--               WHERE email = 'ime.prezime@servoteh.com';
--   vrati:    UPDATE masina_otpis_primaoci SET active = TRUE,  updated_at = now()
--               WHERE email = 'ime.prezime@servoteh.com';
-- Promena važi od SLEDEĆEG otpisa — nema keša, servis čita tabelu pri svakom slanju.
-- NAPOMENA: `email` mora biti malim slovima i bez razmaka (CHECK ispod) — namerno, da
-- ručni unos ne napravi „duplog" primaoca koji se razlikuje samo po velikom slovu.

CREATE TABLE IF NOT EXISTS "masina_otpis_primaoci" (
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
  CONSTRAINT "pk_masina_otpis_primaoci" PRIMARY KEY ("id")
);

-- Jedan red po mejlu. Uz CHECK-ove ispod (malim slovima, bez razmaka, sadrži @) unique
-- je stvaran, a ne samo formalan — nema „istog" primaoca u dve varijante zapisa.
CREATE UNIQUE INDEX IF NOT EXISTS "uq_masina_otpis_primaoci_email"
  ON "masina_otpis_primaoci" ("email");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ck_masina_otpis_primaoci_email_lower'
  ) THEN
    ALTER TABLE "masina_otpis_primaoci"
      ADD CONSTRAINT "ck_masina_otpis_primaoci_email_lower"
      CHECK ("email" = lower(btrim("email")));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ck_masina_otpis_primaoci_email_at'
  ) THEN
    ALTER TABLE "masina_otpis_primaoci"
      ADD CONSTRAINT "ck_masina_otpis_primaoci_email_at"
      CHECK (position('@' in "email") > 1);
  END IF;
END $$;

COMMENT ON TABLE "masina_otpis_primaoci" IS
  'Zahtev 037/26 (presuda 28.07): imenovani primaoci obaveštenja o otpisu mašine. Menja se '
  'običnim INSERT/UPDATE-om (active=FALSE gasi primaoca) — bez izmene koda. Mejl ide na svaki '
  'aktivan red; in-app zvonce samo onima koji imaju povezan users.worker_id.';

-- Seed = presuda Nenada 28.07. `ON CONFLICT DO NOTHING` — ponovljena primena migracije ne
-- vraća red koji je Nenad u međuvremenu ugasio (active=FALSE) niti pravi duplikat.
INSERT INTO "masina_otpis_primaoci" ("email", "full_name", "note") VALUES
  ('luka.petrovic@servoteh.com',      'Luka Petrović',      'Održavanje (presuda 28.07)'),
  ('ivan.umicevic@servoteh.com',      'Ivan Umičević',      'Održavanje (presuda 28.07)'),
  ('zoran.jarakovic@servoteh.com',    'Zoran Jaraković',    'v.d. šefa održavanja (presuda 28.07)'),
  ('nikola.ninkovic@servoteh.com',    'Nikola Ninković',    'Šef mašinske obrade (presuda 28.07)'),
  ('miljan.nikodijevic@servoteh.com', 'Miljan Nikodijević', 'Šef tehnologije i proizvodnih operacija (presuda 28.07)')
ON CONFLICT ("email") DO NOTHING;
