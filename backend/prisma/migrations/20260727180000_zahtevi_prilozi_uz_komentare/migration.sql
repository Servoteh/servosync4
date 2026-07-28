-- Zahtev 029/26 (Zoran Jaraković): „Kada odgovaramo ili postavljamo pitanje u vezi
-- podnetog zahteva, nema mogućnosti za dodavanje attachmenta a trebalo bi da postoji."
--
-- Najmanja moguća izmena šeme: prilog dobija OPCIONI `comment_id`. Semantika:
--   comment_id IS NULL  → prilog SAMOG zahteva (postojeće ponašanje, §5 — nepromenjeno)
--   comment_id NOT NULL → prilog uz komentar/pitanje (nova mogućnost)
-- `request_id` OSTAJE popunjen i za priloge komentara — postojeći row-scope i signed-URL
-- put (`GET /zahtevi/:id/attachments/:attId/url`) rade bez ikakve izmene.
--
-- FK ON DELETE CASCADE prati postojeći obrazac (fk_cr_attachments_request). Komentari se
-- u modulu ne brišu (insert-only tok), pa je kaskada ovde samo higijena referencijalnog
-- integriteta — praktično se nikad ne okida.
--
-- Postojeći redovi dobijaju NULL = prilog zahteva → nema data-migracije, nema backfill-a.

ALTER TABLE "change_request_attachments" ADD COLUMN "comment_id" INTEGER;

ALTER TABLE "change_request_attachments"
  ADD CONSTRAINT "fk_cr_attachments_comment"
  FOREIGN KEY ("comment_id") REFERENCES "change_request_comments"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Indeks je nosilac upita „prilozi ovog komentara" (getDetail include) i pretpostavka
-- brzog FK provere pri (teoretskom) brisanju komentara.
CREATE INDEX "idx_cr_attachments_comment"
  ON "change_request_attachments" ("comment_id");
