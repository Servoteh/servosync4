-- KEP knjiga — princip vrednovanja podesiv: MALOPRODAJNA ili VELEPRODAJNA cena.
--
-- Odluka vlasnika 27.07.2026: „obe opcije moraju da se podešavaju za KEP knjigu,
-- i po maloprodajnoj i po VP ceni". Do sada je vrednovanje bilo tvrdo maloprodajno.
--
-- ZAŠTO SE UPISUJU OBA IZNOSA, a ne samo izabrani:
-- red KEP knjige nosi VEĆ OBRAČUNATU vrednost (upisuje se pri knjiženju dokumenta).
-- Da čuvamo samo jedan iznos, preklop principa menjao bi isključivo BUDUĆE redove, a
-- knjiga bi postala mešavina dva principa — što je gore od pogrešnog principa, jer se
-- ne vidi. Uz oba iznosa izbor je RETROAKTIVAN: ista knjiga se može ponovo odštampati
-- po drugom principu bez ijednog ponovnog knjiženja.

-- ── 1) KEP red nosi i veleprodajnu vrednost ─────────────────────────────────
ALTER TABLE "kepu_book_entries"
  ADD COLUMN IF NOT EXISTS "charge_vp"    DECIMAL(19,4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "discharge_vp" DECIMAL(19,4) NOT NULL DEFAULT 0;

-- Zatečeni redovi nemaju VP vrednost (upisani su pre ove izmene). Ostaju na nuli i
-- prepisuju se prvim ponovnim knjiženjem dokumenta (writeKepuEntries je idempotentan:
-- briše po document_id pa upisuje sveže). Dok se to ne desi, VP knjiga za te dokumente
-- pokazuje nulu — zato štampa mora da UPOZORI kad su svi VP iznosi nula a MP nisu.

-- ── 2) Podešavanje koje nije DA/NE nosi vrednost ────────────────────────────
ALTER TABLE "app_switches"
  ADD COLUMN IF NOT EXISTS "value" VARCHAR(64);

-- ── 3) Podrazumevani princip = MP (zatečeno ponašanje, bez promene za korisnika) ──
INSERT INTO "app_switches" ("key", "enabled", "value", "note")
VALUES (
  'kep-vrednovanje',
  TRUE,
  'MP',
  'Princip vrednovanja KEP knjige: MP = maloprodajna cena, VP = veleprodajna. Podrazumevano MP (zatečeno ponašanje).'
)
ON CONFLICT ("key") DO NOTHING;
