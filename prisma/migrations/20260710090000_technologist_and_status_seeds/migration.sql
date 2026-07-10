-- 1) drawing_handovers.technologist_id — APP-ONLY kolona 2.0 (nema legacy izvora).
-- Šef tehnologije pri odobravanju primopredaje bira tehnologa koji piše
-- tehnološki postupak (TP). Legacy izvor PrimopredajaCrteza je prazan i tabela
-- na cutover-u prelazi u ServoSync vlasništvo, pa je odstupanje od pravila
-- "sync tabele su cache" svesno i dokumentovano (schema.prisma /// komentar +
-- schema-rename-map.md). 0 = tehnolog još nije dodeljen.
ALTER TABLE drawing_handovers ADD COLUMN technologist_id INTEGER NOT NULL DEFAULT 0;

-- 2) Seed handover_draft_statuses lookup (0-5).
-- Legacy StatusiNacrtaPrimopredaje u qbigtehn_sqlserver.sql dump-u NEMA INSERT
-- vrednosti (dump je schema-only), pa su nazivi IZVEDENI iz semantike:
-- MODULE_SPEC_nacrti_primopredaje.md §3.2 katalog, ukršteno sa upotrebom u kodu
-- (handover-drafts.service.ts: create() upisuje statusId=0, submit() postavlja
-- 2 = 'Predat') i legacy VBA DefinisiStatusNacrtaPrimopredaje (koristi 0 i 1;
-- forma posle kreiranja primopredaje diže nacrt na 1). Nazive potvrditi sa
-- Servoteh-om. handover_draft_statuses NIJE sync-ovana tabela (nema syncer-a)
-- -> app-owned reference data. Idempotentno: ON CONFLICT DO NOTHING.
INSERT INTO handover_draft_statuses (id, name) VALUES
  (0, 'Za kreiranje'),
  (1, 'Za primopredaju'),
  (2, 'Predat'),
  (3, 'Odbijen'),
  (4, 'Lansiran'),
  (5, 'Storniran')
ON CONFLICT DO NOTHING;

-- 3) Seed drawing_statuses lookup (0-2).
-- Legacy StatusiCrteza (PDMCrtezi.IDStatusCrteza -> StatusiCrteza) takođe NEMA
-- INSERT vrednosti u dump-u; nazivi IZVEDENI iz semantike u legacy VBA:
-- XML import upisuje IDStatusCrteza=0 (PDM_Common.bas), radni pregled filtrira
-- IDStatusCrteza Between 0 And 1 (Form_PDMSklop.STDWhere), a posle primopredaje
-- / kreiranja RN crtež ide na 2 (PromeniStatusCrtezaPriRaduSaNacrtom, guard
-- 0-2). Nazive potvrditi sa Servoteh-om. drawings.status_id ima default 0.
-- Idempotentno: ON CONFLICT DO NOTHING (ne gazi postojeće).
INSERT INTO drawing_statuses (id, name) VALUES
  (0, 'NOV'),
  (1, 'U OBRADI'),
  (2, 'PREDAT')
ON CONFLICT DO NOTHING;
