-- drawing_handovers.legacy_rn_id — APP-ONLY provenance kolona 2.0 (nema direktnog
-- legacy izvora kao kolona; vrednost = tRN.IDRN izvornog legacy reda). Legacy
-- primopredaja živi kao atributi tRN reda (PrimopredajaCrteza je prazna i na živom
-- MSSQL-u), pa derivacioni syncer (handover-derivation.syncer.ts) izvodi redove iz
-- tRN i upsert-uje ih po ovoj koloni. NULL = nativni 2.0 red (handover-drafts
-- submit). Tabela je ServoSync-owned (isti presedan kao technologist_id, migracija
-- 20260710090000). Kolona ostaje i posle cutover-a kao provenance; guard mutacija
-- nad deriviranim redovima se gasi env prekidačem HANDOVER_LEGACY_GUARD=false.
ALTER TABLE drawing_handovers ADD COLUMN legacy_rn_id INTEGER NULL;

-- Derivacioni upsert ključ. PG unique index dozvoljava više NULL vrednosti, pa
-- nativni redovi (legacy_rn_id IS NULL) nisu ograničeni.
CREATE UNIQUE INDEX uq_drawing_handovers_legacy_rn_id ON drawing_handovers (legacy_rn_id);
