-- Jedinstvenost trojke (project_id, ident_number, variant) na work_orders.
-- Trojka je poslovni identitet RN-a: na nju se vezuju tech_processes (kucanja)
-- i RNZ barkod. D5 clone-variant (MAX(variant)+1) je do sada čuvao samo advisory
-- lock + MAX račun — bez DB mreže bi izmena crteža/revizije kroz updateHeader
-- mogla da dovede do dva RN-a sa istom trojkom (mešanje kartica, nerazlučivi
-- barkodovi). Prod proveren 2026-07-11: 40.614 redova, 0 duplikata trojke.
-- Eventualni budući legacy red sa dupliranom trojkom pada na syncer-ovom
-- skip-ne-abort pravilu (red se preskače i loguje), ne obara ceo sync run.
CREATE UNIQUE INDEX uq_work_orders_project_ident_variant
  ON work_orders (project_id, ident_number, variant);
