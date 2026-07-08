-- Seed handover_statuses lookup (0-3).
-- Zahtevaju ga FK-ovi fk_work_orders_handover_status (work_orders.handover_status_id)
-- i drawing_handovers.status_id -> handover_statuses.id. Bez ovih redova svaki
-- write (submit/rework/approve/launch/"Novi RN") FK-puca.
-- handover_statuses NIJE sync-ovana tabela (nema syncer-a) -> app-owned reference
-- data; sync je ne dira. Kanonski QBigTehn statusi (vidi HANDOVER_STATUS /
-- WO_STATUS u kodu). Idempotentno: ON CONFLICT DO NOTHING (ne gazi postojeće).
INSERT INTO handover_statuses (id, name) VALUES
  (0, 'U OBRADI'),
  (1, 'SAGLASAN'),
  (2, 'ODBIJENO'),
  (3, 'LANSIRAN')
ON CONFLICT DO NOTHING;
