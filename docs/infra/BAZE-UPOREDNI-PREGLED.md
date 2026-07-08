# ServoSync 1.0 ↔ 2.0 — uporedni pregled baza

> Snimljeno **2026-07-08** živim upitom u obe baze. Brojevi u zagradama su procena reda
> (`pg_stat_user_tables.n_live_tup`) — orijentacioni, ne tačan `COUNT(*)`.
> Izvori: 2.0 = on-prem PG (`192.168.64.28:5435`), 1.0 = Supabase (`fniruhsuotwsrjsbhrxd`).
> Puna infra slika: [INFRASTRUKTURA.md](INFRASTRUKTURA.md).

## Rezime

| | ServoSync 1.0 (Supabase) | ServoSync 2.0 (on-prem PG) |
|---|---|---|
| Tabela (public) | **198** | **88** |
| ~ redova ukupno | ~1.26 M | ~532 k |
| Priroda | Operativni MES/ERP moduli koje fabrika koristi svaki dan | QBigTehn proizvodni/tehnološki core, uredno modelovan |
| Najveće tabele | attendance_events (480k), scada_history (344k), bigtehn_work_order_lines_cache (186k) | work_order_operations (214k), tech_processes (98k), items (92k) |

**Glavni zaključak: baze se skoro ne preklapaju — komplementarne su.** 1.0 pokriva domene kojih u 2.0
nema (kadrovska, reversi, održavanje, SCADA, sastanci, projektni biro, montaža). 2.0 pokriva proizvodni
core (RN, TP, PDM/crteži, MRP, artikli) koji 1.0 drži samo kao **read-only keš** (`bigtehn_*_cache`).
To je tačno slika iz roadmap-a: 2.0 iznova gradi kao pravi sistem ono što 1.0 danas samo preslikava.

## Jedina prava dodirna tačka — BigTehn izvor

1.0 ima **23 `bigtehn_*_cache`** tabele (~328k redova) = ravan keš QBigTehn podataka. 2.0 iste te podatke
sinhronizuje u uredno modelovane tabele. Da je reč o istom izvoru, dokazuje poklapanje broja redova:

| Entitet | 1.0 keš tabela | 2.0 tabela | Poklapanje |
|---|---|---|---|
| Komitenti | bigtehn_customers_cache (6.244) | customers (6.244) | ✅ identično |
| Predmeti | bigtehn_items_cache (7.602) | projects (7.602) | ✅ identično |
| Radnici | bigtehn_workers_cache (169) | workers (169) | ✅ identično |
| Radni nalozi | bigtehn_work_orders_cache (40.676) | work_orders (40.610) | ≈ (razlika = vreme sync-a) |
| RN stavke/operacije | bigtehn_work_order_lines_cache (185.694) | work_order_operations (214.322) | ≈ (druga granularnost) |
| Mašine | bigtehn_machines_cache (90) | operations (90) | ✅ identično |

> **Razlika koja se vidi:** 2.0 ima pun katalog artikala — `items (92.357)`. 1.0 ga NE kešira
> (`bigtehn_artikli_cache` = 0; 1.0-ov „items_cache" su zapravo Predmeti). Znači 2.0 već sad ide dublje
> od 1.0 keša na master podacima.

---

## ServoSync 2.0 — 88 tabela po domenima

| Domen | # | ~redova | Tabele |
|---|---|---|---|
| App-owned / infra | 15 | 14,5k | users, default_users, refresh_tokens, access_rights, audit_log, app_access_log, app_revisions, notifications, journal, system_config, global_config, code_types, combo_values, tmp_form_controls, _prisma_migrations |
| Komitenti / predmeti / šifarnici | 11 | 14k | customers (6.244), projects (7.602), salespeople (79), positions (28), companies, departments, organizational_units, order_types, document_types, project_work_types, payment_accounts |
| PDM / crteži | 10 | 39k | drawings (11.286), drawing_components (12.426), drawing_import_log (9.979), drawing_pdfs (5.425), drawing_plans, drawing_assemblies, drawing_handovers, drawing_handover_pdfs, drawing_plan_items, drawing_statuses |
| Radni nalozi (RN) | 10 | 260k | work_order_operations (214.322), work_orders (40.610), work_order_launches (2.764), work_order_components (1.782), work_order_item_components (1.027), work_order_operation_images, work_order_approvals, work_order_blanks, work_order_machined_parts, work_order_nonstandard_parts |
| Artikli / cenovnik / magacin | 8 | 92k | items (92.357), production_item_groups, item_groups, item_subgroups, item_origins, tax_rates, warehouses, price_list_entries |
| Strukture (radnici/mašine/operacije) | 7 | 1,9k | machine_access (1.630), workers (169), operations (90), work_units (21), worker_types (6), part_quality_types, operations_fix |
| MRP / nabavka | 5 | 126 | mrp_demand_items (89), mrp_item_stock (36), mrp_sync_status, mrp_demands, mrp_item_stock_tmp |
| Primopredaje | 4 | 4k | handover_draft_items (3.659), handover_drafts (339), handover_statuses, handover_draft_statuses |
| Robna dokumenta | 4 | 0 | goods_documents, goods_document_items, goods_documents_mirror, goods_document_items_mirror (sve prazne) |
| Tehnološki postupci (TP) | 3 | 98k | tech_processes (97.686), tech_process_documents (333), tech_processes_backup |
| Sync (bb_sync) | 2 | 65 | bb_sync_state (64), bb_sync_log (1) |
| Lokacije delova | 1 | 7k | part_locations (7.003) |
| Ostalo / legacy | 8 | 460 | planner_entries (453), planner_user_groups, work_parameters, labels, registered_apps, registered_users, registered_app_files, registered_user_apps |

---

## ServoSync 1.0 — 198 tabela po domenima

| Domen | # | ~redova | Ključne tabele (izbor) |
|---|---|---|---|
| Kadrovska / HR | 56 | 490k | attendance_events (480.409), work_hours (5.316), kadr_audit_log (1.046), kadr_notification_log (577), competence_levels (570), vacation_history (447), employees (157), salary_terms (142), vacation_entitlements (132), + assessment_*, competence_*, employee_*, kadr_onboarding_*, vacation_* |
| Održavanje / CMMS | 34 | 629 | maint_assets (131), maint_work_orders (132), maint_machines (87), maint_vehicle_tires (76), maint_vehicle_details (43), maint_drivers (30), + maint_incident/part/wo/vehicle_* |
| BigTehn cache (izvor) | 23 | 328k | bigtehn_work_order_lines_cache (185.694), bigtehn_tech_routing_cache (76.234), bigtehn_work_orders_cache (40.676), bigtehn_items_cache (7.602), bigtehn_customers_cache (6.244), bigtehn_drawings_cache (5.421), bigtehn_work_order_approvals_cache (1.984), bigtehn_work_order_launches_cache (1.829), bigtehn_part_movements_cache (1.510) |
| Proizvodnja / Montaža | 16 | 10k | production_active_work_orders (9.412), production_overlays (740), production_overlays_history (110), work_packages, projekt_bigtehn_rn, montaza_izvestaji, presek_aktivnosti, production_urgency_overrides |
| Reversi (alat) | 14 | 192 | rev_tools (47), rev_document_lines (41), rev_recipient_locations (27), rev_documents (26), rev_inventory_subgroups (45), + rev_cutting_tool_*, rev_tool_* |
| Projektni biro (PB) | 11 | 93 | pb_tasks (72), pb_eng_tip_categories (9), pb_task_comments, pb_eng_tips, pb_work_reports, pb_notification_* |
| Sastanci | 11 | 129 | sastanak_ucesnici (49), sastanci_notification_log (58), sastanci (10), sastanak_arhiva, sastanci_templates |
| Core / deljeno | 10 | 65k | bridge_sync_log (54.369), audit_log (10.379), user_roles (54), sub_departments (32), projects (23), departments (13), assessments (7), company_profile, device_push_tokens, reminder_log |
| Lokacije delova | 7 | 4,8k | loc_locations (1.561), loc_sync_outbound_events (1.250), loc_location_movements (1.121), loc_item_placements (856), loc_bigtehn_ingest_state, loc_sync_* |
| SCADA / Energetika | 6 | 357k | scada_history (344.331), scada_alarms (12.732), scada_commands (15), scada_sites (5), scada_snapshots (5), scada_notify_prefs |
| AI asistenti | 5 | 312 | ai_uputstva (173), ai_chat_messages (113), ai_chat_conversations (24), ai_masina_docs, ai_project_notes |
| Akcioni plan / mere | 5 | 452 | akcioni_plan_istorija (405), akcioni_plan (47), corrective_measures, corrective_plans, pm_teme |

---

## Preklapanja imena — pažnja za 3.0

Nekoliko imena postoji u obe baze, ali **ne znače isto** i u 3.0 traže usaglašavanje:

| Ime | U 2.0 | U 1.0 | Napomena za 3.0 |
|---|---|---|---|
| `audit_log` | app audit 2.0 (prazan) | 1.0 app audit (10.379) | dve različite tabele → objediniti šemu |
| `departments` | QBigTehn odeljenja (1) | 1.0 odeljenja (13) | uskladiti izvor istine |
| `projects` | Predmeti iz QBigTehn (7.602) | 1.0 projekti (23) | 2.0 = predmeti, 1.0 = interni projekti → različit pojam! |
| `user_roles` | — | 1.0 role (54) | 2.0 nema još auth; RBAC predlog cilja upravo ovo |

## Kako je pregled napravljen (za ponavljanje)

- **2.0:** `SELECT relname, n_live_tup FROM pg_stat_user_tables WHERE schemaname='public'` preko Prisma-e na prod URL.
- **1.0:** isti upit preko Supabase Management API (`POST /v1/projects/<ref>/database/query`, `SUPABASE_ACCESS_TOKEN`).
- Grupisanje po prefiksu/domenu; brojevi su `n_live_tup` procene. Za tačan broj: `COUNT(*)` po tabeli.
