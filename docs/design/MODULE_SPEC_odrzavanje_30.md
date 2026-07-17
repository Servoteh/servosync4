# Module Spec: Održavanje (CMMS) — 3.0 TALAS F

| | |
|---|---|
| **Modul** | 1.0 „Održavanje" (`maint_*`) — mašine, vozila (+vozači), objekti, IT oprema; preventiva, radni nalozi, zalihe, dokumenta, izveštaji, notifikacije |
| **Verzija spec** | 1.0 (2026-07-12) |
| **Faza** | 3.0 — Talas F (poslednji pred Kadrovsku; **najteži authz**) |
| **Izvor** | 1.0 ŽIVI kod (`src/services/maintenance.js` 3.050 LOC + `src/ui/odrzavanjeMasina/` 30 fajlova 14.882 LOC + `src/ui/mobile/myMaintenance.js` 366 + edge `maint-notify-dispatch`) + živa baza (snimljeno 12.07) |
| **Authz snapshot** | [`authz-snapshots/talasF-fn-defs-2026-07-12.sql`](authz-snapshots/talasF-fn-defs-2026-07-12.sql) — 51 fn + **kompletan dump 102 RLS politike** + 4 storage politike + 34 trigera + cron |
| **Doktrina** | [`MIGRACIONA_DOKTRINA_3.0.md`](MIGRACIONA_DOKTRINA_3.0.md) — VAŽI U CELOSTI |
| **Status** | PRESUĐEN 12.07 („važe predlozi") · R1+R2 (BE) + R3 (FE skelet) IZVEDENI i ŽIVI · **zero-loss AUDIT 17.07: 104 gapa (24 HIGH) → plan F2 u [`AUDIT_odrzavanje_talasF_2026-07-17.md`](AUDIT_odrzavanje_talasF_2026-07-17.md)** |

> ⚠️ **ODVOJEN role sistem.** CMMS ima SOPSTVENI sloj uloga: `maint_user_profiles`
> (`operator/technician/chief/management/admin`) vezan za **`auth.uid()`** — NE za email!
> Preko toga stoji drugi sloj: globalne ERP role iz `user_roles` **po email-u**
> (`maint_is_erp_admin`, `maint_is_erp_admin_or_management`, `maint_has_floor_read_access`).
> Politike mešaju OBA sloja → GUC most mora slati **i `sub` (sy15 `auth.users.id` po email-u)
> i `email`** claim (doktrina A2). Auto-RBAC_MATRIX ovaj modul preskače — sve politike su
> popisane sa žive baze u snapshotu i u §2 ovde.

## 0. Obim — šta se SELI, šta NE (front vs pozadina)

**Živi DB objekti:** 34 tabele (+1 u migracijama koja NE postoji na živoj bazi, §7.5), 16 view-ova
(svi `security_invoker=true`), 51 funkcija, 102 RLS politike, 34 trigera, 1 storage bucket, 1 pg_cron job.

**SELI SE (korisnička površina):**
- **Sav UI** (23 desktop sekcije + karton mašine sa 6 tabova + kartoni vozila/IT/objekta/vozača) — §4.
- **REST read/write paritet**: 1.0 front ide PostgREST-om direktno na ~30 tabela + 13 view-ova;
  2.0 BE zamenjuje to endpointima nad istim sy15 tabelama kroz GUC (RLS odlučuje red-po-red).
- **16 front RPC-ova** (svi SECURITY DEFINER, sa internim guard-ovima):
  `maint_assignable_users`, `maint_create_preventive_work_order`, `maint_machine_rename`,
  `maint_machine_delete_hard`, `maint_machines_import_from_cache`, `maint_notification_retry`,
  `maint_check_vehicle_deadlines` (ručni run), `create_maint_vehicle`, `archive_maint_vehicle`,
  `restore_maint_vehicle`, `create_maint_it_asset`, `create_maint_facility`, `archive_maint_asset`,
  `restore_maint_asset`, `ensure_vehicle_service_wos`, `ensure_asset_service_wos`.
  (+ `maint_attach_incident_files` — postoji u bazi, 1.0 ga NE zove; predlog da ga 2.0 koristi, §7.3)
- **Storage**: bucket `maint-machine-files` (private) — upload/sign/soft-delete za dokumenta mašina,
  CMMS dokumenta (`documents/<entity>/<id>/…`), foto vozila, foto incidenata. Putanje 1.0-kompatibilne.
- **Mobilni** `/m/odrzavanje`: hub 4 kategorije → lista → karton sredstva → prijava kvara
  (+ foto, + native QR sken `asset_code`).
- **QR kartica sredstva** (canvas QR sa URL-om kartona; `maint_assets.qr_token` postoji, ne koristi se u URL-u).

**NE SELI SE (pozadina — ostaje u sy15 bazi, radi za oba UI-ja):**
- **pg_cron job 15** `maint-deadline-check-daily` (07:00 UTC): `maint_check_all_deadlines(30)` →
  enqueue rokova (registracija/osiguranje/prva pomoć/servis vozila; IT licence/garancije; inspekcija/PP objekata).
- **Svi trigeri** (34): auto-WO iz incidenta, outbox enqueue, audit events, WO broj (counter),
  ensure-asset, **`maint_machines_sync_to_loc`** (most ka `loc_locations` MACHINE redovima — veza sa Talasom A!),
  guardovi detalja, SoD guard profila, stock ledger delta, service-plan completion.
- **Notifikacioni outbox** `maint_notification_log` + `maint_enqueue_notification`/`maint_dispatch_fanout`.
  ⚠️ ~~**Dispatch pipeline je MRTAV na produ**~~ **(ISPRAVKA 17.07: ŽIV — v. §2.6 napomenu)**: edge `maint-notify-dispatch` očekuje RPC-ove
  `maint_dispatch_dequeue/mark_sent/mark_failed` koji **ne postoje na živoj bazi** i nijedan
  scheduler ga ne zove → outbox se ne prazni (30 `queued` / 2 `sent`, poslednji sent april).
  Seli se samo ČITANJE log-a + retry (paritet); oživljavanje dispatcha = zasebna odluka (§7.1).
- **Nekorišćeni view-ovi** (front ih ne čita): `v_maint_documents_with_status`,
  `v_maint_machines_with_responsible`, `v_maint_machine_last_check` — ne prave se endpointi (§7.8).

## 1. Živi podaci i model (cloud snapshot 12.07 — brojevi redova indikativni, re-verifikovati na sy15)

**PK**: mešano — `maint_machines.machine_code` je **TEXT PK bez FK-ova** (zato postoji rename RPC!),
ostalo uuid. Modeli se DODAJU u postojeći `prisma/sy15.prisma`; za tabele koje BE samo prosleđuje
(bez relacione logike) dozvoljen `$queryRaw`, ali predlog je pun model za sve sa CRUD-om.

| Podmodul | Tabela | Redova | Prisma model? | Napomena |
|---|---|---:|---|---|
| Jezgro | `maint_assets` | 131 | ✅ | supertabela sva 4 tipa; `qr_token`; archive_at/reason |
| Jezgro | `maint_user_profiles` | 8 (6 chief, 2 mgmt) | ✅ | **po `auth.uid()`**; `assigned_machine_codes[]`, phone, telegram_chat_id; SoD trigger |
| Jezgro | `maint_settings` | 1 (id=1) | ✅ | singleton: auto-WO pravila, due hours, kanali, labels |
| Mašine | `maint_machines` | 87 | ✅ | TEXT PK `machine_code`; `source` bigtehn/manual; `responsible_user_id`; trigeri ensure_asset + sync_to_loc |
| Mašine | `maint_machine_files` | 16 | ✅ | dokumenta mašine (storage meta, soft-delete, 24h pravilo) |
| Mašine | `maint_machine_notes` | 0 | ✅ | napomene, pinned, soft-delete, 24h pravilo |
| Mašine | `maint_machine_status_override` | 2 | ✅ | ručni status (running/degraded/down/maintenance) + valid_until |
| Mašine | `maint_machines_deletion_log` | 1 | ✅ | audit hard-delete; INSERT/UPDATE/DELETE zaključani (`false`) — upis SAMO kroz RPC |
| Preventiva | `maint_tasks` | 0 | ✅ | šabloni kontrola (interval, severity, grace); FK checks CASCADE |
| Preventiva | `maint_checks` | 0 | ✅ | urađene kontrole (`performed_by = auth.uid()` enforced) |
| Kvarovi | `maint_incidents` | 12 | ✅ | severity/status/safety_marker/attachment_urls[]; 4 trigera |
| Kvarovi | `maint_incident_events` | 27 | ✅ | audit timeline (insert-only) |
| RN | `maint_work_orders` | 132 | ✅ | 10 statusa, 4 prioriteta, tip, due_at, `wo_number` iz countera |
| RN | `maint_wo_events` | 9 | ✅ | insert-only audit |
| RN | `maint_wo_parts` / `maint_wo_labor` | 0/0 | ✅ | trošak: delovi + minuti rada |
| RN | `maint_wo_number_counter` | 1 | — ($queryRaw nikad; deny-all RLS) | dodela SAMO kroz trigger |
| Vozila | `maint_vehicle_details` | 43 | ✅ | registracija/osiguranje/servis rokovi, TAG (ENP), GPS, shelf, primary_photo |
| Vozila | `maint_vehicle_owners` | 14 | ✅ | vlasnici (firma/leasing/zaposleni/spoljni) |
| Vozila | `maint_vehicle_tires` | 76 | ✅ | setovi guma (sezona, stanje, lokacija) |
| Vozila | `maint_vehicle_service_plan` | 2 | ✅ | intervalni servisi (km/meseci) + WO veza |
| Vozila | `maint_vehicle_bookings` | 0 | ✅ | carpool rezervacije (overlap check u migraciji) |
| Vozači | `maint_drivers` | 30 | ✅ | **PII (JMBG!)**; `auth_user_id` opciono; NISU auto-sync sa employees (jednokratni seed) |
| IT/Objekti | `maint_it_asset_details` / `maint_facility_details` | 0/0 | ✅ | licence/garancije/backup; inspekcija/PP/katastar |
| IT/Objekti | `maint_asset_service_plan` | 0 | ✅ | intervalni planovi (guard: samo it/facility) |
| Zalihe | `maint_parts` / `maint_suppliers` | 0/0 | ✅ | min_stock, current_stock (održava trigger) |
| Zalihe | `maint_part_stock_movements` | 0 | ✅ | insert-only ledger (in/out/adjustment/return) |
| Zalihe | `maint_part_vehicles` | 0 | ✅ | veza deo↔vozilo + qty_min |
| Dokumenta | `maint_documents` | 3 | ✅ | 5 entiteta (asset/WO/incident/preventiva/vozač) + valid_until |
| Lokacije | `maint_locations` | 0 | ✅ | interna CMMS hijerarhija (≠ `loc_locations`!) |
| Notif | `maint_notification_log` | 32 | ✅ | outbox (30 queued — pipeline mrtav, §0) |
| Notif | `maint_notification_rules` | 3 | ✅ | pravila (event/severity/kanal/eskalacija) |

**View-ovi koje front ČITA (13):** `v_maint_machine_current_status`, `v_maint_task_due_dates`,
`v_maint_cmms_daily_summary`, `v_maint_vehicle_overview`, `v_maint_drivers_overview`,
`v_maint_it_overview`, `v_maint_facility_overview`, `v_maint_vehicle_service_plan_due`,
`v_maint_asset_service_plan_due`, `v_maint_vehicle_parts`, `v_maint_parts_with_vehicles`,
`v_maint_vehicle_bookings`, `v_maint_machines_importable`. Svi `security_invoker` →
`servosync2_app` rola mora SELECT i na osnovnim tabelama (doktrina A6).

**Cross-module čitanja:** `bigtehn_machines_cache` (nazivi + import kandidati),
`employees` (auto-detect u driver modalu, best-effort). Grants potrebni u R0.

## 2. Žive politike + authz mapa (102 politike; snapshot 12.07 — RE-VERIFIKOVATI na sy15 pre R1)

### 2.1 Helper funkcije = rečnik authz-a

| Helper | Ko prolazi | Sloj |
|---|---|---|
| `maint_profile_role()` | rola iz `maint_user_profiles` za `auth.uid()` + `active=true` | **maint profil (sub!)** |
| `maint_is_erp_admin()` | `user_roles` global `admin` po **email-u** | ERP |
| `maint_is_erp_admin_or_management()` | `admin, menadzment, `**`magacioner`** po email-u (širi od ERP `isAdminOrMenadzment`!) | ERP |
| `maint_has_floor_read_access()` | `admin, pm, leadpm, menadzment, magacioner, monter, tim_lider` po email-u | ERP |
| `maint_assigned_machine_codes()` | `assigned_machine_codes[]` profila | maint profil |
| `maint_machine_visible(code)` | floor-read ∨ profil ∈ {chief,technician,management,admin} ∨ (operator ∧ code ∈ assigned, **prazan niz = ništa**) | oba |
| `maint_asset_visible(id)` | machine → `maint_machine_visible`; ne-machine → floor-read ∨ erp-admin ∨ profil ∈ {chief,management,admin} (⚠ technician NE vidi ne-machine sredstva!) | oba |
| `maint_wo_row_visible(asset,assigned,reported)` | **dodeljeni ILI prijavilac vidi svoj red i bez asset vidljivosti** ∨ asset_visible | oba |
| `maint_incident_row_visible(code,asset)` | asset_id? asset_visible : machine_visible | oba |
| `maint_document_visible(...)` | po entitetu (asset/WO/incident/preventiva); vozač-dokumenta: širok krug + **sam vozač po `auth_user_id`** | oba |
| `maint_can_close_incident()` | erp admin/mgmt ∨ chief/admin profil | oba |

### 2.2 Politike po grupama (svaka od 102 pripada tačno jednoj grupi; pun dump u snapshotu)

**READ (SELECT):**
| Grupa | Tabele | USING |
|---|---|---|
| asset-scope ×9 | asset_service_plan, assets, facility_details, it_asset_details, part_vehicles, vehicle_bookings, vehicle_details, vehicle_service_plan, vehicle_tires | `maint_asset_visible(asset_id)` |
| machine-scope ×5 | checks, machine_files, machine_status_override, machines, tasks | `maint_machine_visible(machine_code)` |
| inventar ×4 | locations, part_stock_movements, parts, suppliers | floor-read ∨ profil ∈ {technician,chief,management,admin} |
| WO ×1 + child ×3 | work_orders; wo_events/wo_labor/wo_parts (EXISTS parent) | `maint_wo_row_visible(…)` |
| incidenti ×2 | incidents; incident_events (EXISTS parent) | `maint_incident_row_visible(…)` |
| dokumenta ×1 | documents | `maint_document_visible(…)` |
| napomene ×1 | machine_notes | `deleted_at IS NULL AND maint_machine_visible` |
| vozači ×1 | drivers | floor-read ∨ erp adm/mgmt ∨ bilo koji profil ∨ **`auth_user_id = auth.uid()`** |
| settings ×1 | settings | erp adm/mgmt ∨ profil ∈ {operator,technician,chief,admin} (⚠ čist floor-read NE vidi settings) |
| notif ×2 | notification_log (erp-admin ∨ chief/management/admin); notification_rules (erp adm/mgmt ∨ chief/management/admin) | |
| profili ×1 | user_profiles | `auth.uid() = user_id` ∨ erp-admin |
| audit ×1 | machines_deletion_log | erp-admin ∨ erp adm/mgmt ∨ chief/admin/management |
| owners ×1 | vehicle_owners | `true` (svi authenticated) |

**WRITE:**
| Grupa | Tabele/politike | Pravilo |
|---|---|---|
| katalog-write ×15 | assets/locations/machine_status_override/machines/tasks (I/U/D) | erp-admin ∨ chief/admin |
| šifarnici-write ×12 | drivers/notification_rules/parts/settings/suppliers/vehicle_service_plan (I/U) | erp adm/mgmt ∨ chief/admin |
| details-write ×6 | facility/it/vehicle details (I/U) | asset_visible ∧ (erp adm/mgmt ∨ chief/admin) |
| ALL ×2 | asset_service_plan, vehicle_owners | erp adm/mgmt ∨ chief/admin |
| tires ALL ×1 | vehicle_tires | asset_visible ∧ (erp adm/mgmt ∨ chief/admin) |
| delete-restrikcije ×5 | pv/booking/vsp/wo DELETE (erp adm/mgmt ∨ chief/admin); drivers DELETE (erp adm/mgmt ∨ **samo admin profil** — chief NE briše vozače) |
| checks | INSERT: `performed_by = auth.uid()` ∧ machine_visible; UPDATE: svoja ∨ technician/chief/admin/erp-admin |
| incidents | **INSERT (`authenticated`): SAMO `reported_by = auth.uid()`** → svaki prijavljeni korisnik sme prijaviti kvar!; UPDATE: technician/chief/admin ∨ erp adm/mgmt, uz CHECK: u `closed` samo `maint_can_close_incident()` ∨ chief/admin/erp adm/mgmt |
| incident_events | INSERT: parent vidljiv ∧ (`actor` NULL ili moj) |
| WO | INSERT: `reported_by = auth.uid()` ∧ asset_visible ∧ (bilo koji profil ∨ erp adm/mgmt); UPDATE: technician/chief/admin ∨ erp adm/mgmt |
| wo_events/labor/parts | write: parent vidljiv ∧ technician/chief/admin ∨ erp adm/mgmt |
| stock ledger | INSERT-only: `created_by = auth.uid()` ∧ technician/chief/admin ∨ erp adm/mgmt ∧ (wo_id NULL ∨ parent WO vidljiv); **nema UPDATE/DELETE politika** |
| part_vehicles I/U | erp adm/mgmt ∨ chief/admin/**technician** |
| bookings | INSERT: svi profili (uklj. operator) ∨ erp adm/mgmt; UPDATE: chief/admin/erp ∨ **kreator svoje** |
| machine_files | INSERT: `uploaded_by = auth.uid()` ∧ bilo koji profil ∨ erp; UPDATE/DELETE: chief/admin/erp-admin ∨ **svoj fajl unutar 24h (operator/technician)** |
| machine_notes | INSERT: autor + machine_visible + profil; UPDATE: chief/admin/erp-admin ∨ **svoja unutar 24h** |
| documents | I/U/D: `maint_document_visible` (+ INSERT `uploaded_by = auth.uid()`) |
| profili | I/D: SAMO erp-admin; UPDATE: erp-admin ∨ **sam svoj red** (ali trigger `maint_profiles_guard_role` blokira izmenu `role`/`active` svima sem erp-admina) |
| deny-all | wo_number_counter (ALL false); deletion_log INSERT/UPDATE/DELETE false (upis samo kroz DEFINER RPC) |
| notif log INSERT | `false` — upis samo kroz `maint_enqueue_notification` |

### 2.3 Storage politike (bucket `maint-machine-files`, private)

| Op | Pravilo |
|---|---|
| SELECT | `maint_has_floor_read_access()` (⚠ čist maint profil bez ERP role ne prolazi — signed URL tok ipak radi jer sign ide kroz RLS SELECT na objects… **proveriti na sy15 u R0**: operator/technician upload prolazi, read preko floor-read) |
| INSERT | erp adm/mgmt ∨ bilo koji profil (operator/technician/chief/admin) |
| UPDATE | erp-admin ∨ chief/admin |
| DELETE | erp-admin ∨ chief/admin ∨ `owner = auth.uid()` |

> ⚠️ **17.07:** 2.0 BE sign/download autorizuje preko RLS prava na META-redu (`maint_machine_files`/`maint_documents`),
> što je ŠIRE od 1.0 storage SELECT-a (floor-read) — maint-profil bez ERP role u 2.0 MOŽE da čita fajlove
> (u 1.0 ne može — anomalija). Predlog presude: zadržati kao svesno odstupanje (AUDIT §8.2).

### 2.4 FE gate-ovi (1.0 paritet — 2.0 FE gate-uje po `/maintenance/me`)

| 1.0 gate | Ko | Kontroliše |
|---|---|---|
| `canManageMaintCatalog` | erp adm/mgmt/magacioner ∨ chief/admin | katalog, vozila/IT/objekti/vozači CRUD, servisni planovi, settings, dokumenta-delete |
| `canManageMaintTasks` | chief/admin (⚠ BEZ erp kruga!) | šabloni kontrola |
| `canEditWorkOrder` | erp ∨ technician/chief/admin | WO kanban drag, dodela, statusi |
| `canManageMaintOverride` | erp ∨ chief/admin | ručni status mašine |
| `canAccessMaintNotifications` | erp ∨ chief/management/admin | tab Notifikacije |
| inventory: canManage / canMove | erp ∨ chief/admin / (+technician) | delovi CRUD / kretanje zaliha |
| preventiva `canCreateWo` | technician/chief/admin | dugme „Kreiraj WO" |
| carpool edit | canManageMaintCatalog ∨ technician ∨ operator | rezervacije |
| hard delete mašine | canManageMaintCatalog (uklj. menadzment) + RPC guard | trajno brisanje |
| hub kartica | **svi prijavljeni** (bez gate-a) | ulaz u modul |

### 2.5 Skrivena pravila firme (doktrina C — NE gubiti!)

1. **maint SELECT politike priznaju maint profil** (fix 07.07, `20260707_maint_select_profile_aware.sql`)
   — chief bez ijedne globalne role MORA da vidi mašine. Nove politike NIKAD samo floor_read.
2. **`magacioner` je u CMMS „ERP menadžment" krugu** (`maint_is_erp_admin_or_management`) — širi
   krug nego ERP `isAdminOrMenadzment`. Ne sužavati.
3. **`monter` i `tim_lider` imaju floor-read** (dodato uz operativne role 08.07).
4. **Prijava kvara je OPŠTE pravo**: incidents INSERT za role `authenticated` uz jedini uslov
   `reported_by = auth.uid()` — i korisnik bez profila i bez floor-read sme da prijavi kvar
   (ali potом svoj incident možda NE VIDI — vidi §7.6).
   > ✅ **VERIFIKOVANO na živoj sy15 2026-07-17 (F2-P0a, presuda §8.5 „baza je istina").**
   > `pg_policies` na `maint_incidents` daju TAČNO 3 politike: `maint_incidents_insert`
   > (cmd=INSERT, roles=`{authenticated}`, qual=`—`, **with_check=`(reported_by = uid())`**),
   > `maint_incidents_select` (USING `maint_incident_row_visible(machine_code, asset_id)`),
   > `maint_incidents_update` (technician/chief/admin ∨ erp adm/mgmt; close-gate u WITH CHECK).
   > INSERT je **stvarno opšte pravo** — NEMA floor-read/profil suženja. Audit §2.3.2/§8.5
   > sumnja na `fix_maint_incidents_insert_policy` (floor-read) je **OBORENA**: na produ ta
   > politika ne postoji; jedini INSERT uslov je `reported_by = auth.uid()`. Zaključak:
   > `odrzavanje.report` OSTAJE dodeljen SVIM aktivnim ulogama (role-permissions.ts), a
   > `POST /incidents` = `@RequirePermission(ODRZAVANJE_REPORT)` — bez ikakvog suženja.
   > Politika se NE dira (doktrina A5).
5. **Operator machine-scope**: operator vidi samo `assigned_machine_codes`; prazan niz = ne vidi ništa.
6. **Dodeljeni/prijavilac uvek vidi svoj WO** (i bez asset vidljivosti) — isto za dokumenta preko WO/incidenta.
7. **24h pravilo**: operator/technician menjaju/brišu SVOJE fajlove i napomene samo 24h od nastanka;
   chief/admin uvek.
8. **Zatvaranje incidenta** (`closed`) samo chief/admin/ERP — technician sme sve ostale statuse.
9. **Vozače briše samo maint `admin` profil ili ERP adm/mgmt** — chief NE.
10. **SoD na profilima**: `role`/`active` menja isključivo ERP admin (trigger; štiti od self-eskalacije
    — nalaz security audita 05.07).
11. **WO broj** `WO-YYYY-NNNNN` dodeljuje trigger iz counter tabele (deny-all RLS) — 2.0 NE generiše brojeve.
12. **Auto-WO iz incidenta**: major/critical/safety po `maint_settings` (critical → status `potvrden`,
    p1, due 8h; major → 48h; safety → p1). Radi trigger — 2.0 ništa ne duplira.
13. **Auto-notify** samo major/critical; bez pravila → fallback `in_app`; poštuje settings kill-switcheve.
14. **`maint_machine_rename`** kopira katalog red + seli reference u 6 tabela; **namerno NE dira
    `loc_locations`** (dokumentovano u migraciji). `maint_machines_sync_to_loc` trigger inače
    održava MACHINE lokacije (INSERT/UPDATE) — dodirna tačka sa Talasom A.
15. **Svaka mašina dobija `maint_assets` red** (trigger ensure_asset + `qr_token`); incidenti se
    denormalizuju (`asset_id`/`asset_type` popunjava trigger).
16. **Zaliha sme u minus?** — ledger je insert-only, delta ide trigerom bez donje granice (paritet Reversi potrošnog).
17. **`maint_drivers` NISU auto-sync sa `employees`** — jednokratni seed; novi vozači ručno
    (uz best-effort auto-detect iz employees u modalu).
18. **`maint_settings.updated_by`/`updated_by` kolone** front upisuje eksplicitno — zadržati u BE.
19. **Soft-delete konvencije**: mašine `archived_at + tracked=false`; vozila/IT/objekti kroz
    archive RPC sa obaveznim razlogom; fajlovi/dokumenta `deleted_at` + best-effort storage delete.
20. **`maint_check_vehicle_deadlines` je i cron i ručno dugme** — dedupe po
    `payload->deadline_kind+deadline_date` (idempotentan po konstrukciji).

### 2.6 Notifikacioni lanac (front vs pozadina — razvrstano)

> ⚠️ **AŽURIRANO 17.07 (živa sy15 provera):** tvrdnja „dispatch MRTAV" ispod je ZASTARELA — od cutover-a 1.5
> `maint_dispatch_dequeue/mark_sent/mark_failed` POSTOJE na živoj bazi i outbox se prazni (40/40 sent, 0 queued).
> Podela seli/ne-seli OSTAJE ista (2.0 = čitanje + retry + rules; isporuka = sy15 pozadina), ali 2.0 upis
> incidenta danas realno okida slanje — smoke test mora paziti na duple notifikacije.
> Dokazi: `AUDIT_odrzavanje_talasF_2026-07-17.md` §2.1.

```
trigger maint_incidents_enqueue_notify ─┐
pg_cron maint_check_all_deadlines(30) ──┼──► maint_notification_log (outbox, status=queued)
ručno dugme (check_vehicle_deadlines) ──┘          │
                                                   ▼
                        edge maint-notify-dispatch (worker; SERVICE ROLE)
                        ⚠ MRTAV: traži maint_dispatch_dequeue/mark_sent/mark_failed
                          koji NE POSTOJE na živoj bazi; nema schedulera koji ga zove
                                                   │
front (chief/mgmt/admin): tab Notifikacije ◄───────┘
  - čita log (RLS) - filteri status/mašina - retry RPC (failed→queued)
```
**Seli se:** čitanje log-a + retry + rules CRUD + settings. **Ne seli se:** enqueue (trigeri/cron).
**Ne oživljava se usput:** dispatch (odluka §7.1).

## 3. API (predlog, `/api/v1/maintenance/*`)

**Permisije (permissions.ts):** `odrzavanje.read` (sve aktivne uloge — row-scope odlučuje DB kroz GUC),
`odrzavanje.report` (sve aktivne uloge — prijava kvara, paritet §2.5.4), `odrzavanje.write`
(sve aktivne uloge sa maint operativom — coarse gate; stvarnu odluku donosi RLS/RPC guard),
`odrzavanje.admin_ui` (admin/menadzment/magacioner — SAMO za prikaz admin UI-ja; nije bezbednosna granica).
FE fine-gating ide preko **`GET /maintenance/me`** (vidi dole) — paritet 1.0 obrasca
(`fetchMaintUserProfile` + lokalni helperi), jer 2.0 role sloj NE može da izrazi maint profil.

⚠️ Sve mutacije idu kroz `Sy15Service.withUser` (GUC sa `sub`+`email`); **idempotencija**: modul
NEMA svoj mehanizam → `rev_api_idempotency` obrazac (`clientEventId`) na svim mutacijama (doktrina A4).

| Endpoint (skraćeno) | Metodi | Permisija | 1.0 poreklo |
|---|---|---|---|
| `/maintenance/me` | GET | read | profil + `{maintRole, floorRead, erpAdmin, erpAdminOrManagement}` (server računa preko GUC upita) |
| `/maintenance/dashboard` | GET | read | v_machine_current_status + v_cmms_daily_summary + due dates + brojevi kategorija (1 poziv umesto 9) |
| `/maintenance/machines` (+`/:code`) | GET | read | maint_machines + bigtehn nazivi + responsibles |
| `/maintenance/machines` `/:code` | POST/PATCH | write | insert/patch/archive/restore (RLS chief/admin) |
| `/maintenance/machines/import` | POST | write | RPC `maint_machines_import_from_cache` (+ GET `/importable` view) |
| `/maintenance/machines/:code/rename` | POST | write | RPC `maint_machine_rename` |
| `/maintenance/machines/:code` | DELETE | write | storage cleanup + RPC `maint_machine_delete_hard` (BE radi i storage brisanje — 1.0 to radi klijent!) |
| `/maintenance/machines/deletion-log` | GET | read | audit log (RLS) |
| `/maintenance/machines/:code/status-override` | GET/PUT/DELETE | write | upsert/clear override |
| `/maintenance/machines/:code/notes` (+`/:id`) | GET/POST/PATCH | write | napomene (24h pravilo u RLS) |
| `/maintenance/machines/:code/files` (+`/:id`) | GET/POST/PATCH/DELETE | write | meta + **storage proxy** (§7.4): upload/sign/soft-delete |
| `/maintenance/tasks` (+`/:id`) | GET/POST/PATCH/DELETE | write | šabloni (RLS chief/admin); `?machine=` filter |
| `/maintenance/tasks/due` | GET | read | v_maint_task_due_dates |
| `/maintenance/tasks/:id/work-order` | POST | write | RPC `maint_create_preventive_work_order` (+ GET open-WO anti-duplikat) |
| `/maintenance/checks` | GET/POST | write | kontrole (INSERT performed_by=ja) |
| `/maintenance/incidents` (+`/:id`) | GET/POST/PATCH | **report** (POST) / write (PATCH) | prijava + tok; nested WO join |
| `/maintenance/incidents/:id/events` | GET/POST | read/write | timeline + komentar |
| `/maintenance/incidents/:id/files` | POST | report | foto → storage + **RPC `maint_attach_incident_files`** (§7.3) |
| `/maintenance/work-orders` (+`/:id`) | GET/PATCH | read/write | kanban lista (status grupe), detalj, dodela (`/assignable` → RPC) |
| `/maintenance/work-orders/:id/events|parts|labor` | GET/POST | write | trošak + audit |
| `/maintenance/vehicles` (+`/:code`) | GET | read | v_vehicle_overview (+card) |
| `/maintenance/vehicles` | POST | write | RPC `create_maint_vehicle` |
| `/maintenance/vehicles/:id/archive|restore` | POST | write | RPC archive/restore |
| `/maintenance/vehicles/:id/details` | PUT/PATCH | write | upsert details + TAG + shelf + photo path |
| `/maintenance/vehicles/:id/tires` (+`/:tireId`) | GET/POST/PATCH/DELETE | write | gume |
| `/maintenance/vehicles/:id/service-plan` (+`/:planId`, `/generate-wos`) | GET/POST/PATCH/DELETE/POST | write | plan + RPC `ensure_vehicle_service_wos` |
| `/maintenance/vehicles/:id/parts` (+link/unlink/patch) | GET/POST/PATCH/DELETE | write | part_vehicles + v_vehicle_parts |
| `/maintenance/vehicles/:id/bookings` (+`/:bookingId`) | GET/POST/PATCH/DELETE | write | carpool (v_vehicle_bookings) |
| `/maintenance/vehicles/deadline-check` | POST | write | RPC `maint_check_vehicle_deadlines` (ručno) |
| `/maintenance/vehicle-owners` | GET/POST | read/write | šifarnik vlasnika |
| `/maintenance/drivers` (+`/:id`, archive/restore) | GET/POST/PATCH/DELETE | write | v_drivers_overview; **PII** — bez posebnog maskiranja (paritet; RLS krug §2.2) |
| `/maintenance/it-assets`, `/facilities` (+`/:code` card) | GET | read | v_it_overview / v_facility_overview |
| `/maintenance/it-assets`, `/facilities` | POST | write | RPC create_maint_it_asset / create_maint_facility |
| `/maintenance/assets/:id/archive|restore` | POST | write | RPC archive/restore_maint_asset |
| `/maintenance/assets/:id/details` | PUT | write | it/facility details upsert |
| `/maintenance/assets/:id/service-plan` (+`/generate-wos`) | GET/POST/PATCH/DELETE/POST | write | asset_service_plan + RPC `ensure_asset_service_wos` |
| `/maintenance/assets` | GET | read | picker + mobilni registar (maint_assets) |
| `/maintenance/facility-types` | GET | read | lookup — na živoj bazi tabela NE postoji → vraća `[]`, FE fallback (§7.5) |
| `/maintenance/calendar/deadlines` | GET | read | agregat IT/objekti/planovi (BE sklapa kao 1.0 klijent) |
| `/maintenance/parts`, `/suppliers` (+`/:id`) | GET/POST/PATCH | write | zalihe + dobavljači |
| `/maintenance/parts/:id/stock-movements` | GET/POST | write | insert-only ledger |
| `/maintenance/documents` (+`/:id`) | GET/POST/PATCH | write | svi entiteti; valid_until; storage proxy |
| `/maintenance/locations` (+`/:id`) | GET/POST/PATCH | write | CMMS hijerarhija |
| `/maintenance/settings` | GET/PATCH | write | singleton id=1 |
| `/maintenance/notification-rules` (+`/:id`) | GET/POST/PATCH | write | pravila |
| `/maintenance/notifications` (+`/:id/retry`) | GET/POST | write | log + RPC retry |
| `/maintenance/reports/*` | GET | read | agregati za izveštaje (incidenti/WO troškovi/pažnja) — BE računa što 1.0 računa klijentski |
| `/maintenance/lookups/employees` | GET | write | employees auto-detect (best-effort, uski select) |

## 4. FE (Next) — `/odrzavanje` pod nav sekcijom **„Oprema i energija"** (PLAN_MODULA_MES_3.0 §5)

Paritet 23 sekcije 1.0 (`/maintenance/*`), 2.0 ui-kit, responsive (bez zasebnog /m duplikata gde može):

1. **Pregled** (dashboard): KPI (statusi, otvoreni kvarovi, WO p1/p2, overdue), 4 kategorije-tile,
   lista mašina po prioritetu (Zastoj→Smetnje→Održavanje→Kasni→Danas→7 dana), filteri + „Moje"
   (responsible_user_id), profil-info banner (samo kad nema ni profila ni floor-read).
2. **Karton mašine** — 6 tabova: Pregled (status/override/zadaci due) · Zadaci (potvrda kontrole:
   ok/warning/fail/skipped + napomena) · Istorija (merged incidenti+kontrole) · Napomene (pin, 24h) ·
   Dokumenta (upload/sign/kategorije) · Šabloni (chief/admin CRUD). + „Uredi mašinu", QR kartica.
3. **Radni nalozi** — kanban 4 grupe (Novi/U toku/Čeka/Završeno; 10 statusa), drag&drop (write),
   detalj-modal: dodela (`assignable`), prioritet, due, events, delovi, rad, closure comment.
4. **Mašine (registar)** + **Katalog** (admin view): CRUD, arhiva, uvoz iz BigTehn (checkbox lista),
   rename, hard delete (razlog ≥5 kar.) + deletion log. **Lokacije** tab (maint_locations).
5. **Vozila**: lista (filteri vlasnik/namena/GPS/arhiva) + karton (detalji+rokovi+TAG+foto+shelf;
   pod-tabovi: Servisni plan (+Generiši WO), Gume, Delovi, Carpool, Dokumenta). **Vozači**: lista +
   karton (dozvole/lekarski/LK rokovi, dokumenta, auto-detect zaposlenog).
6. **Objekti** i **IT oprema**: lista + karton (details, servisni plan, dokumenta); facility-type
   select sa fallback listom.
7. **Preventiva** (due lista + kreiraj WO) + **Board** (kolone po statusu mašina) + **Kalendar**
   (rokovi IT/objekti/planovi, link na kartone).
8. **Zalihe i dobavljači**: delovi (min/current stock, status), kretanja (Zaliha dugme), dobavljači;
   filter „po vozilu".
9. **Dokumenta** (globalno, svi entiteti + valid_until status) + **Dokumenta vozila** (poseban ekran).
10. **Izveštaji**: periodi 30/90/365/sve — incidenti (severity/status/downtime), WO troškovi
    (delovi+rad), IT/objekti „zahteva pažnju", CSV izvozi.
11. **Podešavanja**: maint_settings forma + notification rules tabela + (predlog §7.2) admin
    „Profili održavanja".
12. **Notifikacije**: log outbox-a, filteri, retry (failed→queued).

**Mobilno** (`/m/odrzavanje` paritet, 2.0 responsive): hub 4 kategorije + pretraga + **QR sken**
(`asset_code` — proširenje Reversi `ScanOverlay` parsera) → karton sredstva (vozilo: rokovi/km/vozač)
→ otvoreni kvarovi → **Prijavi kvar** (naslov/ozbiljnost/opis/foto/bezbednosni rizik).

**Skener**: QR na kartici sredstva enkodira URL kartona; mobilni sken traži po `asset_code`.
`maint_assets.qr_token` postoji u bazi ali se NE koristi u 1.0 URL-ovima — ne uvoditi ga sada.

## 5. Parity matrica (doktrina B — status se ažurira TOKOM rada)

> ⚠️ **AUDIT 17.07:** stvarno stanje po stavci = `AUDIT_odrzavanje_talasF_2026-07-17.md` §3–§5
> (OK: #4,#12,#18,#43 · MISSING: #33,#36,#40 · UNKNOWN: #48 · ostalo PARTIAL). Statusi ispod se
> ažuriraju tokom F2 paketa; dopunska skrivena pravila (21–30+) su u audit dokumentu §5.1.
>
> **F2-P0b (BE temelji, 2026-07-17):** zatvoreni BE delovi stavki #2 (filteri mašina
> status/rok/lokacija), #13 (WO q/openOnly/overdue + sredstvo na redu), #14 (WO detalj asset
> join + `incidentId` link), #15 (deo→`maint_part_stock_movements` „out" u istoj tx + `user_note`
> audit event za deo/rad + WoLabor `notes`), #17 (importable `includeNoProcedure`), #24/#31
> (servisni planovi čitaju `v_maint_*_service_plan_due`), #28 (`UpdateDriverDto.authUserId` +
> spoljni→null), #30 (`cadastral_parcels` Prisma+DTO), #33 (`GET /maintenance/board`), #35
> (parts `lowStock`/`includeInactive`, suppliers `active` param), #39 (notif machine/incident
> filter), #47 (`clientEventId` na `incidents/:id/events` i `work-orders/:id/events`). **FE tih
> stavki ostaje P1–P4.**

| # | Funkcija | Status |
|---|---|---|
| 1 | `/maintenance/me` (profil + efektivna prava; FE gating paritet) | NOT_STARTED |
| 2 | Dashboard KPI + kategorije + prioritetna lista + filteri + „Moje" | NOT_STARTED (FE) · BE-filteri mašina status/rok(overdue/danas/7d)/lokacija F2-P0b 17.07 |
| 3 | Karton mašine: Pregled tab (status, override prikaz, due zadaci) | NOT_STARTED |
| 4 | Potvrda kontrole (insert maint_checks, result enum, napomena) | NOT_STARTED |
| 5 | Istorija mašine (merged incidenti + kontrole) | NOT_STARTED |
| 6 | Napomene (pin/izmena/soft-delete; 24h pravilo) | NOT_STARTED |
| 7 | Dokumenta mašine (upload/sign/kategorija/soft-delete; 24h pravilo) | NOT_STARTED |
| 8 | Šabloni kontrola CRUD (chief/admin) + deaktivacija umesto brisanja | NOT_STARTED |
| 9 | Ručni status override (set/clear, valid_until) | NOT_STARTED |
| 10 | Prijava kvara — desktop modal (+foto, safety marker) | NOT_STARTED |
| 11 | Incident detalj: status tok, dodela, events, close-gate (chief/admin) | NOT_STARTED |
| 12 | Verifikacija auto-WO + auto-notify trigera kroz 2.0 upis (paritet ponašanja) | NOT_STARTED |
| 13 | WO kanban (10 statusa / 4 grupe) + drag&drop + filteri | NOT_STARTED (FE) · BE q/openOnly/overdue + sredstvo (asset) na WO redu F2-P0b 17.07 |
| 14 | WO detalj: dodela (assignable RPC), prioritet, due, closure | NOT_STARTED (FE) · BE asset join + `incidentId` (link „Otvori incident") + pečat started/completed F2-P0b 17.07 |
| 15 | WO delovi + rad (labor) + events audit | NOT_STARTED (FE) · BE deo→zaliha „out" (ista tx) + `user_note` audit event za deo/rad + WoLabor notes F2-P0b 17.07 |
| 16 | Katalog mašina CRUD + arhiva/restore | NOT_STARTED |
| 17 | Uvoz mašina iz BigTehn cache (importable view + RPC) | NOT_STARTED (FE) · BE `includeNoProcedure` param (default sakriva no_procedure=true) F2-P0b 17.07 |
| 18 | Rename mašine (RPC, atomski kroz 6 tabela) | NOT_STARTED |
| 19 | Hard delete mašine (storage cleanup u BE + RPC + deletion log ekran) | NOT_STARTED |
| 20 | CMMS lokacije (maint_locations CRUD) | NOT_STARTED |
| 21 | Vozila lista + filteri + arhiva toggle | NOT_STARTED |
| 22 | Karton vozila (details upsert, rokovi, TAG/ENP, foto, parts shelf) | NOT_STARTED |
| 23 | Kreiranje vozila / arhiviranje / vraćanje (3 RPC-a, razlog obavezan) | NOT_STARTED |
| 24 | Servisni plan vozila + „Generiši WO" (`ensure_vehicle_service_wos`) | NOT_STARTED (FE) · BE čita `v_maint_vehicle_service_plan_due` (računat due) F2-P0b 17.07 |
| 25 | Gume (CRUD setova) | NOT_STARTED |
| 26 | Delovi po vozilu (link/unlink/qty_min + pregled) | NOT_STARTED |
| 27 | Carpool rezervacije (CRUD; kreator menja svoju; overlap poruka) | NOT_STARTED |
| 28 | Vozači: lista/karton/CRUD/arhiva + dokumenta + employees auto-detect | NOT_STARTED (FE) · BE `UpdateDriverDto.authUserId` (spoljni→null, DB CHECK) F2-P0b 17.07; `lookups/employees` F2-P0a |
| 29 | IT oprema: lista/karton/create RPC/details/arhiva | NOT_STARTED |
| 30 | Objekti: lista/karton/create RPC/details/arhiva + facility-type fallback | NOT_STARTED (FE) · BE `cadastral_parcels` (Prisma + upsertFacilityDetails) F2-P0b 17.07 |
| 31 | Servisni plan IT/objekti + „Generiši WO" (`ensure_asset_service_wos`) | NOT_STARTED (FE) · BE čita `v_maint_asset_service_plan_due` (računat due) F2-P0b 17.07 |
| 32 | Preventiva panel (due lista + kreiraj WO + anti-duplikat) | NOT_STARTED |
| 33 | Board (statusne kolone mašina) | NOT_STARTED (FE) · BE `GET /maintenance/board` (Prekoračeno/Danas/7d + override „PAUZA" + imena) F2-P0b 17.07 |
| 34 | Kalendar rokova (IT/objekti/planovi → linkovi na kartone) | NOT_STARTED |
| 35 | Zalihe: delovi + dobavljači CRUD + stock ledger (insert-only) | NOT_STARTED (FE) · BE parts `lowStock`/`includeInactive`, suppliers `active` param F2-P0b 17.07 |
| 36 | Dokumenta globalno (5 entiteta, valid_until, filteri) + Dokumenta vozila | NOT_STARTED |
| 37 | Izveštaji (4 perioda; incidenti/WO troškovi/pažnja) + CSV | NOT_STARTED |
| 38 | Podešavanja (settings singleton + notification rules) | NOT_STARTED |
| 39 | Notifikacije tab (log + filteri + retry RPC) | NOT_STARTED (FE) · BE machineCode + incidentId (related_entity_id) filter F2-P0b 17.07 |
| 40 | Profili održavanja admin (ERP-admin mutacije; SoD guard netaknut) | IMPLEMENTED (BE, 2026-07-17 F2-P0a): `GET/POST /maintenance/profiles`, `PATCH /profiles/:id` + `GET /lookups/employees`; mutacije guard = ERP admin (`assertErpAdmin`, NE admin_ui krug), POST eksplicitna duplikat-provera `userId`; DB trigger `maint_profiles_guard_role` netaknut. FE ekran = F2-P4. |
| 41 | QR kartica sredstva (render) + mobilni QR sken → karton | NOT_STARTED |
| 42 | Mobilni tok /m/odrzavanje (hub→lista→karton→prijava kvara+foto) | NOT_STARTED |
| 43 | Foto incidenta kroz `maint_attach_incident_files` RPC (§7.3) | NOT_STARTED |
| 44 | Storage proxy (upload/sign/delete; putanje 1.0-kompatibilne) | NOT_STARTED |
| 45 | GUC sub+email test: operator scope, chief-bez-globalne-role, magacioner krug | NOT_STARTED |
| 46 | e2e permission matrica (maint rola × ERP rola × endpoint × 200/403) | NOT_STARTED |
| 47 | Idempotencija mutacija (clientEventId / rev_api_idempotency obrazac) | PARTIAL · BE `clientEventId` dodat i na event rute (incidents/wo events) F2-P0b 17.07 |
| 48 | Živi smoke: pun ciklus (QR sken → prijava kvara → auto-WO → dodela → delovi/rad → završen → izveštaj) | NOT_STARTED |

## 6. Redosled izvođenja (R-faze za CEO talas)

| Faza | Šta | Gate |
|---|---|---|
| R0 | Nenadov review + presuda §7; **re-verifikacija snapshot-a na živoj sy15** (fn dif, politike, da li dispatch fns i dalje fale); grants za `servosync2_app` (SELECT+write na 34 maint tabele po §2, SELECT na 13 view-ova + osnovne tabele, EXECUTE na 16(+1) front RPC, SELECT `bigtehn_machines_cache` + uski `employees`; **kao `supabase_admin`**) | odobreno |
| R1 | BE read sloj: Prisma modeli u `sy15.prisma` + `/me` + svi GET + `odrzavanje.*` permisije + e2e read matrica (operator-scope, chief-bez-role, magacioner) | read paritet |
| R2 | BE mutacije: REST-paritet upisi kroz GUC + 16 RPC endpointa + storage proxy + idempotencija; e2e write matrica + verifikacija trigera (auto-WO, wo_number, audit) | write paritet |
| R3a | FE: Pregled + karton mašine (6 tabova) + Radni nalozi + Preventiva/Board/Kalendar + Katalog/Lokacije | jezgro UI |
| R3b | FE: Vozila (karton + 5 pod-tabova) + Vozači + IT + Objekti + servisni planovi | sredstva UI |
| R3c | FE: Zalihe + Dokumenta (×2) + Izveštaji + Podešavanja + Notifikacije + Profili | ostatak UI |
| R4 | Mobilni tok + QR sken + živi smoke (pun ciklus #48) + Playwright happy-path + paralelni rad 1.0/2.0 → hub preklop | parity gate (doktrina D) |
| R5 | Retrospektiva tempa → ažurirati `PROCENA_SEOBE_MODULA_3.0.md` | kalibracija |

**Procena:** gruba planska bila je **4–6 MN**; posle merenja predlažem **5–6,5 MN**
(R1 ≈ 1 · R2 ≈ 1,5 · R3a-c ≈ 2,5 · R4 ≈ 0,5–1 · rezerva 0,5). Authz rizik je nizak-srednji
(GUC most čuva svih 102 politike po konstrukciji); glavni obim je FE (23 sekcije, 14.9k LOC)
i širina REST površine (≈30 tabela). Najveći tehnički rizici: storage proxy tok i
dvoslojni `/me` gating.

## 7. Otvorena pitanja (Nenad presuđuje; svako sa konkretnim predlogom)

> ✅ **PRESUĐENO 12.07.2026 (Nenad): „VAŽE PREDLOZI" — sva pitanja + H1–H4 usvojeni bez izuzetaka.**

1. **Mrtav notifikacioni dispatch.** Edge `maint-notify-dispatch` ne može da radi (RPC-ovi
   `maint_dispatch_dequeue/mark_sent/mark_failed` nikad primenjeni na živu bazu; nema schedulera;
   30 poruka `queued`, poslednja isporuka aprila). **Predlog:** u Talasu F seliti SAMO paritet
   (čitanje log-a + retry + rules); oživljavanje isporuke (email preko postojećeg Resend outbox
   obrasca / WhatsApp) = zaseban post-seoba zadatak, NE deo parity gate-a.
2. **Gde se administriraju maint profili u 2.0?** 1.0 ih ima i u CMMS-u i u Podešavanjima
   (Talas D „Održ. profili"). **Predlog:** jedan ekran — u 2.0 CMMS Podešavanja (stavka #40);
   Talas D RBAC konzola ga linkuje, ne duplira. DB SoD guard ostaje jedina bezbednosna granica.
3. **Foto na incident za prijavioce bez WO/incident-UPDATE prava.** 1.0 (web i mobilni) kači foto
   direktnim `PATCH attachment_urls` — to TIHO PADA za korisnike koji nisu technician+/ERP
   (npr. monter koji je prijavio kvar). U bazi VEĆ postoji `maint_attach_incident_files`
   (`reported_by = auth.uid()` putanja), nepozivan iz 1.0. **Predlog:** 2.0 koristi taj RPC
   (stavka #43) — svesno, dokumentovano odstupanje koje popravlja gubitak fotografija; 1.0 se ne dira.
4. **Storage pristup iz 2.0.** Storage RLS na `maint-machine-files` zavisi od supabase `owner`/
   `auth.uid()` konteksta koji 2.0 BE nema. **Predlog:** BE storage-proxy — pre `upload/sign/delete`
   BE kroz GUC proveri RLS pravo nad meta-redom (`maint_machine_files`/`maint_documents`), pa izvrši
   operaciju service kredencijalom na sy15 storage-api; putanje ostaju 1.0-kompatibilne (paralelni rad).
5. **`maint_facility_type_lookup` ne postoji na živoj bazi** (migracija
   `add_maint_facility_type_lookup_and_inspection_trigger.sql` neprimenjena; front ćutke pada na
   ugrađenu listu). **Predlog:** paritet — endpoint vraća `[]`, FE koristi isti fallback; migraciju
   NE primenjivati tokom seobe (doktrina C).
6. **Prijava kvara korisnika bez ikakvog maint pristupa.** INSERT prolazi, ali korisnik potom svoj
   incident ne vidi (SELECT ga filtrira) — u 1.0 `return=representation` može vratiti prazno i UI
   prikaže grešku iako je red upisan. **Predlog:** 2.0 BE tretira INSERT-bez-representation kao uspeh
   (`201` + id iz RETURNING kroz GUC transakciju) — paritet ponašanja baze, bolja poruka; RLS se NE širi.
7. **Živi profili su samo chief(6)/management(2)** — operator/technician machine-scope logika nema
   žive korisnike. **Predlog:** preneti netaknuto (GUC je čuva besplatno) + e2e test sa sintetičkim
   operator nalogom (stavka #45,46); ne sužavati i ne „čistiti".
8. **Vidljivost modula u nav-u.** 1.0 hub kartica je vidljiva SVIM prijavljenima (prijava kvara =
   opšte pravo). **Predlog:** `odrzavanje.read` + `odrzavanje.report` za sve aktivne uloge u
   `role-permissions.ts`; kartica u sekciji „Oprema i energija"; admin UI elementi po `/maintenance/me`.
