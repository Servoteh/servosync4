-- Trošak materijala u kilogramima za izveštaje neusaglašenosti (škart).
-- AUTO za škart (type=2): quantity × masa jednog dela (kg). Izvor mase =
-- drawings.weight (PDM XML Weight; masa ≤ 0 = nepoznato po parseWeight paritetu),
-- fallback work_orders.unprocessed_part_weight (masa pripremka). Nepoznata masa → NULL.
-- Ručna korekcija dozvoljena kroz PATCH (obrazac kao spent_hours). App-owned 2.0 tabela.
-- Migracija generisana `prisma migrate diff` (datamodel→datamodel) — dev Docker baza
-- (port 5435) nije dostupna u ovom okruženju; presedan BACKEND_RULES §12 v0.7.

-- AlterTable
ALTER TABLE "nonconformity_reports" ADD COLUMN     "material_kg" DECIMAL(12,3);
