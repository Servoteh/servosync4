-- „Odgovoran" na izveštajima o neusaglašenosti (plan izmena korisnika, jul 2026, K1).
-- KO/ŠTA je odgovorno za neusaglašenost — različito od Izvršioca (radnik na operaciji).
-- Fiksna lista, jedan izbor; String kolona a NE Postgres/Prisma enum (BACKEND_RULES §2),
-- dozvoljene vrednosti se drže u `///` komentaru šeme + DTO whitelist-u:
-- izvrsilac | kontrolor | masina | materijal | tehnologija | ostalo. NULL = neizjašnjeno.
-- Bez CHECK constrainta (isti obrazac kao ostali status/rola String-ovi u 2.0 šemi) —
-- lista se menja bez migracije. App-owned 2.0 tabela.
-- Migracija pisana ručno po `prisma migrate diff` obrascu — dev Docker baza (port 5435)
-- nije dostupna u ovom okruženju; presedan 20260717120000_nonconformity_material_kg.

-- AlterTable
ALTER TABLE "nonconformity_reports" ADD COLUMN     "responsible_party" VARCHAR(50);
