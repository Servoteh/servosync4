-- P4b (spec §6.4 + §6.5.1): tri APP-ONLY kolone na drawing_handovers (nema
-- legacy izvora — isti dokumentovani presedan kao technologist_id/legacy_rn_id;
-- tabela na cutover-u prelazi u ServoSync vlasništvo). Migracija je pisana
-- RUČNO po obrascu 20260710090000_technologist_and_status_seeds — dev baza
-- nije dostupna pa `prisma migrate dev` nije bio moguć; `prisma format` +
-- `validate` + `generate` su izvršeni nad šemom.
--
-- TIMESTAMP(6) namerno prati sestrinske kolone tabele (handover_date,
-- status_changed_at...) — BACKEND_RULES Timestamptz pravilo važi za NOVE
-- tabele, unutar postojeće se tip ne meša (spec §6.4 audit napomena).

-- 1) technologist_assigned_at — kada je TEKUĆI tehnolog dodeljen/preuzeo.
--    Pišu je i approve() (šef bira tehnologa) i POST /handovers/:id/take-over
--    („Preuzmi izradu"); return-to-pending je prazni uz undo tehnologa.
ALTER TABLE drawing_handovers ADD COLUMN technologist_assigned_at TIMESTAMP(6) NULL;

-- 2) technologist_assigned_by_id — radnik koji je izveo dodelu (kod approve =
--    šef tehnologije; kod take-over = sam preuzimalac). NULL kad nalog nema
--    vezanog radnika (users.worker_id). Meki FK ka workers (bez constraint-a,
--    kao technologist_id).
ALTER TABLE drawing_handovers ADD COLUMN technologist_assigned_by_id INTEGER NULL;

-- 3) production_deadline — rok izrade unet pri ODOBRAVANJU (legacy: rok unosi
--    inženjer koji odobrava, ne tek pri lansiranju). Propagira se u
--    work_orders.production_deadline pri kreiranju RN-a iz primopredaje;
--    eksplicitni launch dueDate ima prednost (override). Nullable dok Miljan
--    ne potvrdi obaveznost (spec §8 #8); return-to-pending je prazni.
ALTER TABLE drawing_handovers ADD COLUMN production_deadline TIMESTAMP(6) NULL;
