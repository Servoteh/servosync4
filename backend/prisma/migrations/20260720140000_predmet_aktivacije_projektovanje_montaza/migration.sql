-- M7 gap (Nenad 20.07.2026): the second Podešavanja-predmeta checkbox
-- (PROJEKTOVANJE I MONTAŽA, sy15 je_projektovanje_montaza) was not carried over by the
-- F1 import — only PB/Plan montaže tracking is created for flagged predmeti.
ALTER TABLE "predmet_aktivacije"
  ADD COLUMN "is_projektovanje_montaza" BOOLEAN NOT NULL DEFAULT false;
