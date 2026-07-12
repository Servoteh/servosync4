# Module Spec: Projektni biro + Moj profil + Podešavanja (RBAC admin) — 3.0 TALAS D

| | |
|---|---|
| **Moduli (grupa)** | 1.0 „Projektni biro" (`pb_*`) + 1.0 „Moj profil" (self-service) + 1.0 „Podešavanja" (RBAC admin konzola + matični + sistem) — sele se ZAJEDNO (doktrina §E: PB override-i ↔ RBAC admin ↔ profil) |
| **Verzija spec** | 1.0 (2026-07-12) |
| **Faza** | 3.0 — Talas D (izvršava se posle B i C) |
| **Izvor** | 1.0 ŽIVI kod (`src/ui/pb/` 18 fajlova ~5.9k + `src/services/pb.js` 790 + `pbEngTips.js` 351; `src/ui/mojProfil/` 6 fajlova ~4.3k + ~20 servisa; `src/ui/podesavanja/` 20 fajlova ~5.3k + edge `admin-invite-user` 347) + **živa baza kroz Management API (snimljeno 12.07)** |
| **Authz snapshot** | [`authz-snapshots/talasD-fn-defs-2026-07-12.sql`](authz-snapshots/talasD-fn-defs-2026-07-12.sql) (71 def: 38 PB + 10 RBAC/Podešavanja + 11 authz predikata + 12 Moj-profil RPC deljenih sa G) |
| **Doktrina** | [`MIGRACIONA_DOKTRINA_3.0.md`](MIGRACIONA_DOKTRINA_3.0.md) — VAŽI U CELOSTI |
| **Status** | 📝 NACRT — čeka R0 review (Nenad); otvorena pitanja §7 |

> ⚠️ **Ispravka poznate činjenice iz trackera:** per-user override **`finalni_potpisnik` NE POSTOJI u 1.0 kodu ni bazi**
> (grep celog `src/` = 0; pominje se samo u 3.0 docs). To je 2.0 koncept (primopredaje.approve, Milorad Jerotić) koji
> VEĆ živi u 2.0 `UserPermissionOverride` dizajnu. Stvarni 1.0 per-user override-i su **3 boolean kolone + scope niz
> na `user_roles`** (§2.3). PB nema nijedan per-user override — sve ide kroz uloge (`inzenjer` vs `projektant_vodja` vs editori).

## 0. Obim — šta se SELI, šta NE (FRONT vs POZADINA)

### 0.1 Projektni biro (domen 📐 PROJEKTOVANJE)

**SELI SE (front površina):** 19 front RPC-ova + 8 REST tabela + 2 storage bucketa:
- Read: taskovi (embed projects/employees), komentari, zavisnosti, fajlovi, work reports, eng tips (RPC listing sa
  tsv pretragom), kategorije, notif config, `pb_list_projects`, `pb_get_mechanical_projecting_engineers` (dropdown),
  `pb_get_load_stats`/`pb_get_team_load_stats` (opterećenost), `pb_get_work_report_summary` (obračun).
- Mutacije: task CRUD (REST + optimistic lock `updated_at=eq`), `pb_update_task_progress` (restriktovani edit),
  `pb_soft_delete_task(s)`, komentari/deps/fajlovi CRUD, work report insert/delete, eng tips
  (`pb_save_eng_tip`, like, soft-delete, kategorije admin, fajl meta), `pb_notification_config` PATCH (admin).
- Storage: `pb-task-files` + `pb-eng-tip-files` (upload/sign/delete — presigned obrazac kao Reversi §7).

**NE SELI SE (pozadina — ostaje u sy15):**
- pg_cron job 7 (`pb-enqueue-notifications`, 07:00 UTC dnevno) → `pb_enqueue_notifications()` (rokovi/preopterećenje → `pb_notification_log` outbox).
- Edge `pb-notify-dispatch` (service_role; `pb_dispatch_dequeue/mark_sent/mark_failed`, Resend mejl, digest mode) — netaknut.
- DB helperi pozadine: `pb_in_quiet_hours`, `pb_engineering_lead_by_subdept` (koristi ga i front-politika!), trigeri
  `pb_task_deps_check_cycle_trg` (+`pb_check_dep_cycle`), `pb_eng_tip_likes_count_sync`, `pb_eng_tips_search_tsv_sync`,
  `pb_normalize_project_code`, `pb_predmet_project_uuid`, audit trigeri — ostaju u bazi.
- **Nema realtime-a, nema PDF-a** u PB (jedini export = CSV plana, klijentski).

### 0.2 Moj profil (👤 top-level, self-service za sve ~157)

**Ključni nalaz: Moj profil NEMA NIJEDNU SVOJU TABELU** — čist agregator nad tuđim domenima. Sav pristup ide
kroz `v_employees_safe` mapiranje **email → employees red** (bez reda → prazan profil, poruka „Nismo pronašli…").
Doktrina A1/A2 ⇒ tehnički CEO profil može u Talas D kroz GUC most (postojeći DEFINER RPC + RLS rade netaknuti);
vlasništvo HR logike ostaje Talasu G. Podela:

| Sekcija profila | Objekti (vlasnik) | Može PRE G? |
|---|---|---|
| Profil header, kolege na odsustvu | `v_employees_safe` (G), `absences` read (G) | ✅ read-only kroz GUC |
| Zaduženja (revers) | `v_rev_my_issued_tools`, `v_rev_my_consumed` (Reversi ✅ u 2.0) | ✅ **reuse `/reversi/reports/my-*`** |
| Moj tim (menadžeri) | `v_employees_safe`+`v_vacation_balance`+`absences` (G) + `get_team_issued_tools` (Reversi API već ima) | ✅ kroz GUC |
| Kompanijske vrednosti + Pravilnik GO | **statični HTML u kodu** + print-iframe PDF; ack → `kadr_document_ack` (G) | ✅ (statika + 1 insert kroz GUC) |
| Vrednosti firme (baza), opis pozicije + PDF | `company_profile`, `job_positions` (Podešavanja/D!) | ✅ (D poseduje) |
| GO saldo + zahtevi (submit/revise/cancel/delete) | `v_vacation_balance`, `vacation_requests`, `vacation_history` + RPC `hr_revise/cancel/delete_vacation_request`, `kadr_queue_vacation_submission_notification` (G) | ✅ kroz GUC — **RPC tela se NE diraju** |
| Nadoknada sati / plaćeno odsustvo | `makeup_requests`, `paid_leave_requests` + `kadr_delete_makeup`, `kadr_queue_*_notification` (G) | ✅ kroz GUC |
| Mesečni sati + primedba + karnet PDF | `work_hours` read, `work_hours_remarks` upsert (G); karnet = klijentski PDF | ✅ kroz GUC (PDF port u R3) |
| Moje prisustvo + korekcija | `v_attendance_daily`, `attendance_events/corrections` + `attendance_submit_correction` (G) | ✅ kroz GUC |
| Onboarding, razgovori (`talk_acknowledge`), 360 (`assessment_open_self/self_submit`), dev plan/očekivanja | kadr_onboarding_*, employee_talks, corrective_*, assessments*, development_* (G) | ✅ kroz GUC |
| Bezbednost (passkeys) | Supabase Auth WebAuthn — **mrtvi posle 1.5 cutover-a** | ❌ NE SELITI (→ §7 P5) |
| Mejl posle submit-a | edge `hr-notify-dispatch` + `kadr_notification_log` outbox (G) | pozadina — front samo poziva queue RPC + pulse |

**NE SELI SE:** hr-notify-dispatch edge, kadr pg_cron poslovi, approve tokovi GO/nadoknade (to je Kadrovska —
profil samo LINKUJE; mobilna `/m/odobravanja` ostaje 1.0 do G).

### 0.3 Podešavanja (⚙️ SISTEM) — 4 grupe, 16 tabova; NE seli se sve u D

| Grupa | Tab | Talas D? |
|---|---|---|
| Korisnici i pristup | **Korisnici** (usersTab 834), **Uloge i dozvole** (statička matrica), **Grid urednici** (`kadr_grid_editor_allowlist`) | ✅ D — jezgro talasa (RBAC konzola) |
| Organizacija | **Organizacija** (departments/sub_departments/job_positions + opisi pozicija), **Vrednosti firme** (`company_profile`), **Očekivanja zaposlenih**, **Okvir kompetencija** (editor) | ✅ D (admin ekrani žive ovde; PODACI su G-domen — G ih ne prepakuje) |
| Podaci | **Matični podaci** (hub-linkovi), **Mašine** (wrapper CMMS kataloga), **Održ. profili** (`maint_user_profiles`), **Podeš. predmeta** (`predmet_aktivacija` RPC) | Mašine+Održ.profili → **Talas F** (§7 P4); Podeš. predmeta ✅ D; Matični = linkovi |
| Sistem | **Notifikacije** (hub-linkovi ka PB/Sastanci/Održavanje/Kadrovska), **Integracije** (health prikaz), **Audit log** (`v_settings_audit_log`), **Sistem** (dijagnostika + AI model izbor) | ✅ D (Notifikacije/Integracije = tanki; 2.0 već ima sync-status ekrane → spojiti) |

**NE SELI SE:** edge `admin-invite-user` se NE poziva iz 2.0 — njegova logika (GoTrue admin API + user_roles insert
+ welcome mejl u `kadr_notification_log`) se **portuje u 2.0 BE endpoint** (jedino mesto talasa gde se telo logike
piše u TS — jer 2.0 ima SVOJ auth/users; §3.3, §7 P1). 1.0 edge ostaje živ za 1.0 fallback do cutover-a taba.

## 1. Živi podaci i model (12.07)

| Tabela | Redova | Prisma model (sy15.prisma)? | Napomena |
|---|---:|---|---|
| `pb_tasks` | 72 | ✅ `PbTask` | soft-delete `deleted_at`; FK projects+employees; optimistic lock po `updated_at` |
| `pb_work_reports` | 1 | ✅ `PbWorkReport` | van-planski sati; self-scope RLS |
| `pb_task_comments` / `pb_task_deps` / `pb_task_files` | 4/1/0 | ✅ | komentar edit-prozor 1h; deps anti-ciklus trigger; files soft-delete |
| `pb_eng_tips` (+`_categories`/`_likes`/`_files`) | 2/9/2/1 | ✅ | tsv pretraga (trigger), likes count (trigger), draft/published |
| `pb_notification_config` / `pb_notification_log` | 1/0 | config ✅ / log — ($queryRaw, admin) | log = outbox pozadine |
| `user_roles` | 54 | — (čita se $queryRaw/servis; 2.0 IMA svoj `UserRole`) | **email-based**; kolone-override: `plan_montaze_readonly`, `kadrovska_access`, `kadrovska_hide_contracts`, `managed_sub_department_ids int[]`, `managed_departments`, `must_change_password`, `project_id` (per-projekat pm/leadpm!) |
| `audit_log` | 10.483 | — ($queryRaw read) | piše SAMO DB (`audit_row_change` trigeri: pb_tasks, pb_work_reports, pb_eng_tips(+cat), user_roles, employees, absences, work_hours, employee_children, loc_locations); klijent ALL=false |
| `departments` / `sub_departments` / `job_positions` | 13/32/78 | ✅ (D poseduje ekran; G čita) | job_positions nosi opise pozicija (4 md sekcije) + PDF |
| `company_profile` | 1 | ✅ | single-row id=1 (misija/vizija/vrednosti md) |
| `competences`+`competence_groups/levels/profiles/questions`, `profile_positions` | 78 poz. | ✅ (CRUD admin) | okvir kompetencija (koristi i 360 u G) |
| `employee_expectations` | 0 | ✅ | + view `v_employee_expectations`; self-update status RLS |
| `kadr_grid_editor_allowlist` / `kadr_holidays` | –/36 | ✅ / ✅ | allowlist ko sme grid; praznici (read svi, write admin) |
| `predmet_aktivacija` | 7.602 | — (RPC-only: `list_predmet_aktivacija_admin`/`set_predmet_aktivacija`) | audit piše RPC (nema trigera!); gate `can_manage_predmet_aktivacija` = admin+menadzment |
| `maint_user_profiles` | 8 | ❌ Talas F | RLS po `auth.uid()` + `maint_is_erp_admin()` — poseban sistem |
| Moj profil | — | **nema svojih tabela** | sve tuđe (G/Reversi/D) — §0.2 |

PK = uuid, zadržava se. Modeli se DODAJU u postojeći `prisma/sy15.prisma`. PB embed čita `projects` (23) i
`employees` (157, PII! samo `full_name` se embeduje) → grants za `servosync2_app` moraju pokriti SELECT
(v_employees_safe za profil; employees.full_name za PB join — RLS paritet kroz GUC).

## 2. Žive politike + authz mapa (snimljeno 12.07; RE-VERIFIKOVATI na sy15 pre R1)

### 2.1 PB: 37 politika na 11 tabela + 8 storage politika (2 bucketa)

| DB gate | Definicija (živa) | Ko prolazi | → 2.0 permisija |
|---|---|---|---|
| SELECT `true`/`deleted_at IS NULL` | tasks, comments, deps, files, likes, categories, notif_config | svi prijavljeni | `pb.read` |
| `pb_can_edit_tasks()` | `current_user_is_admin() OR has_edit_role(NULL) OR role='projektant_vodja'` | **admin, hr, menadzment, pm, leadpm, poslovni_admin** (globalni red, `project_id IS NULL`) + projektant_vodja | `pb.edit` |
| `pb_can_comment()` | edit ∪ `inzenjer` | editori + inzenjer | `pb.comment` |
| `pb_update_task_progress` (RPC) | unutra: `pb_can_comment()` + dozvoljena SAMO status/procenat | inzenjer restriktovani edit | `pb.progress` |
| `pb_current_user_can_see_all_reports()` | admin ∪ globalne leadpm/pm/menadzment ∪ **član pododeljenja „Rukovodstvo inženjeringa"** | menadžeri + eng. lead | `pb.reports_all` |
| work_reports self-scope | `employee_id = pb_current_employee_id()` (insert/select/update/delete) ∪ reports_all | svako svoje | `pb.reports_own` (row u DB) |
| `can_write_pb_eng_tips()` | edit ∪ role inzenjer/projektant_vodja ∪ **član `pb_get_mechanical_projecting_engineers()`** | + inženjeri po ORG pripadnosti (bez uloge!) | `pb.tips_write` |
| eng tips draft/manage | draft vidi samo autor (`author_id = pb_current_employee_id()`) + admin; update autor/admin; DELETE kategorija/tips = admin | autor-scope | ostaje u bazi (GUC) |
| `current_user_is_admin()` | user_roles admin aktivan po email-u | admin | `pb.admin` (notif config, kategorije) |
| storage `pb-task-files` | read=`pb_can_comment()`, insert=`pb_can_edit_tasks()`, update/delete=admin∪owner (24h logika na meta tabeli) | | prati `pb.comment`/`pb.edit` |
| storage `pb-eng-tip-files` | read=svi auth, insert/delete=`pb_eng_tip_can_manage(tip)` | | prati `pb.tips_write` |

### 2.2 Podešavanja: žive politike

| Tabela | Obrazac |
|---|---|
| `user_roles` | ALL=`current_user_is_admin()`; SELECT admin-all + **self** (`lower(email)=jwt email`) |
| `audit_log` | write `false` za klijente (samo trigeri); SELECT admin |
| `departments`/`sub_departments`/`job_positions`/`kadr_grid_editor_allowlist`/`kadr_holidays`/`competence_*` | SELECT `true` svima; write admin (`current_user_is_admin()`) |
| `company_profile` | SELECT svi; UPDATE `current_user_can_manage_org_profile()` = **admin/menadzment/pm/leadpm**; INSERT admin |
| `job_positions` dopunski | UPDATE i za `current_user_can_manage_org_profile()` (opisi pozicija) uz admin-ALL |
| `employee_expectations` | SELECT self ∪ `current_user_manages_dev_plan()`; INSERT/UPDATE mgr; **self-UPDATE samo `status∈(u_toku,ispunjeno)`**; DELETE admin |
| `predmet_aktivacija` | SELECT `true`; write kroz RPC `set_predmet_aktivacija` (`can_manage_predmet_aktivacija` = admin ∪ menadzment) |
| `maint_user_profiles` | (F) select self ∪ `maint_is_erp_admin()`; write erp-admin |

### 2.3 RBAC admin konzola — tačke usklađivanja 1.0 ⇄ 2.0 kataloga (traženo zadatkom)

1. **Uloge:** 1.0 whitelist = **14 uloga** (`src/lib/constants.js` ROLE_LABELS) — SVE već postoje u 2.0
   `roles.ts` katalogu (admin/menadzment v1-v2; pm/leadpm AKTIVIRANE 10.07; hr/poslovni_admin/projektant_vodja/
   inzenjer/tim_lider/monter/cnc_operater/viewer/magacioner/proizvodni_radnik tier 3.0/v2). Talas D = **aktivacija
   preostalih 3.0-tier uloga u `role-permissions.ts`** (nikad nova imena). ⚠️ whitelist je u 1.0 na 4 mesta
   (constants.js + edge allowedRoles + `admin_invite_user_role` DB CHECK-lista + erpRbacMatrix) — u 2.0 SAMO roles.ts.
2. **Per-user override-i:** 1.0 kolone na `user_roles` → 2.0 `user_permission_overrides` (userId+key+allow):
   `plan_montaze_readonly` → **deny** `plan_montaze.write`; `kadrovska_access` → **grant** `kadrovska.access`;
   `kadrovska_hide_contracts` → **deny** `kadrovska.contracts_read` (ključevi = §7 P2). Guard VEĆ predviđa
   deny>grant>rola. `finalni_potpisnik` ostaje 2.0-native flag (primopredaje) — nije deo 1.0 migracije podataka.
3. **Scope:** `managed_sub_department_ids int[]` → 2.0 `UserRole.managedSubDepartmentIds` (kolona VEĆ postoji,
   migracija 20260709); role-agnostic (lekcija 05.07 — čuva se za SVAKU ulogu). `project_id` na user_roles
   (per-projekat pm/leadpm u `has_edit_role(proj_id)`) → 2.0 `UserRole.scopeType='project'`+`scopeId`.
4. **`must_change_password`:** 2.0 `users` NEMA ekvivalent → dodati flag + force-change tok (§7 P3).
5. **Identitet:** 1.0 = GoTrue `auth.users` + email-join na user_roles; 2.0 = svoj `users` (bcrypt+refresh
   tokeni) + SSO most po email-u (`/auth/sso`). Tokom paralelnog rada nalozi MORAJU postojati na obe strane →
   invite tok piše u OBA (§7 P1 — ključna odluka talasa).
6. **Uloge i dozvole tab:** 1.0 statička `erpRbacMatrix.js` → 2.0 renderovati ŽIVO iz `ROLE_PERMISSIONS`
   (`GET /me/permissions` + admin katalog endpoint) — jedan izvor istine, matrica se ne prepisuje.
7. **Audit:** 2.0 ima svoj `AuditLog` (Prisma). 1.0 `audit_log` NE migrira — 2.0 Audit tab čita
   `v_settings_audit_log` (user_roles+predmet_aktivacija) iz sy15 ($queryRaw) + svoj AuditLog za 2.0 akcije.

### 2.4 Skrivena pravila firme (doktrina §C — POPIS, ne sme se izgubiti)

1. **PB edit imaju i `hr` i `poslovni_admin`** (kroz `has_edit_role`) — neočekivano ali živo pravilo.
2. **Eng tips piše i zaposleni BEZ uloge** ako je aktivan član org jedinica hardkodovanih u
   `pb_get_mechanical_projecting_engineers()`: „Mašinsko projektovanje", „Hidraulika i algoritmi",
   „Rukovodstvo inženjeringa", „PM tim", pozicije „LEAD PM"/„Projekt menadžer" (+legacy fallback po tekstu
   department/position kolona). Ista fn puni dropdown inženjera — **org-imena su AUTHZ podatak!**
3. **`pb_current_user_can_see_all_reports()` uključuje članove pododeljenja „Rukovodstvo inženjeringa"** po
   `employees.sub_department_id` (ne po ulozi); takođe može INSERT tuđeg work report-a.
4. Komentar: autor sme edit/delete samo **1h** od nastanka; task fajl meta: uploader **24h**; admin uvek.
5. `inzenjer` mutira ISKLJUČIVO kroz `pb_update_task_progress` (RLS bi PATCH odbio) — 2.0 endpoint `/progress`
   mora ostati odvojen od punog PATCH-a.
6. `current_user_role()` (DB) prioritet je `leadpm>pm>viewer>ELSE`, a FE `effectiveRoleFromMatches` ima drugi
   redosled (admin>leadpm>pm>menadzment>hr>…) — **asimetrija postoji na produ**; ne „popravljati" usput (§7 P8).
7. `admin_invite_user_role` (RPC) NE kreira auth nalog — vraća `auth_user_missing`; jedini pun tok je edge
   (GoTrue admin API). UI INSERT u user_roles je namerno blokiran u servisu.
8. Welcome/reset mejl ide kroz **`kadr_notification_log`** outbox (tip `account_invite`) — Kadrovska infra.
9. `kadr_document_ack` politike koriste **`rev_current_employee_id()`** (Reversi helper u HR tabeli!) — ne čistiti.
10. Moj profil: ceo scope visi na `lower(email)` → `employees` aktivan red; menadžerske sekcije na
    `canSubmitVacationRequestForOthers` (admin/hr/menadzment/leadpm/pm/poslovni_admin) × `managed_sub_department_ids`
    (prazan scope = nema tima). GO zahtev: klijentski guard `REQUEST_MIN_DATE='2026-05-01'` + provera salda i
    preklapanja PRE inserta; status tok pending→sef_approved→approved.
11. `predmet_aktivacija` audit upisuje sam RPC (tabela nema triger) — pri portu ekrana zadržati RPC put.
12. `attendance_submit_correction`: obavezno obrazloženje, važenje 3 dana, mejl šefu — telo je G-vlasništvo,
    profil samo poziva.
13. Statika u kodu: Pravilnik GO i Kompanijske vrednosti su **HTML stringovi u JS** + print-iframe PDF (puna
    ćirilica/latinica) — paritet = preneti sadržaj doslovno, ne „lepše".

### 2.5 Dodele u `role-permissions.ts` (predlog)

- `pb.read` → sve aktivne uloge (SELECT true paritet). `pb.comment` → edit-krug + `inzenjer`.
- `pb.edit` → `admin, hr, menadzment, pm, leadpm, poslovni_admin, projektant_vodja` (⚠️ hr/poslovni_admin ostaju — pravilo 2.4.1).
- `pb.progress` → `inzenjer` (+ svi sa `pb.edit`). `pb.tips_write` → edit-krug + `inzenjer`, `projektant_vodja`
  (org-članstvo iz 2.4.2 ostaje u DB fn kroz GUC — se NE prepisuje u katalog).
- `pb.reports_all` → `admin, leadpm, pm, menadzment` (+ „Rukovodstvo inženjeringa" row-pravilo u DB).
- `pb.admin`, `settings.users`, `settings.audit`, `settings.system` → `admin`.
- `settings.org_profile` → `admin, menadzment, pm, leadpm` (company_profile/opisi/očekivanja/kompetence — paritet `current_user_can_manage_org_profile`).
- `settings.predmet_aktivacija` → `admin, menadzment`. `profile.self` → SVE uloge (svaki prijavljen).
- `profile.team` → `admin, hr, menadzment, leadpm, pm, poslovni_admin` (row-scope kroz managedSubDepartmentIds/DB).
- GUC most: SVAKI poziv sa `email` **I `sub`** claim-om (pb_eng_tip_likes i storage owner koriste `auth.uid()`).

## 3. API (predlog)

### 3.1 `/api/v1/pb/*` (Projektni biro)

| Endpoint | Metod | Permisija | 1.0 poreklo |
|---|---|---|---|
| `/pb/projects` · `/pb/engineers` | GET | read | `pb_list_projects` · `pb_get_mechanical_projecting_engineers` |
| `/pb/tasks` (+`/:id`) | GET | read | REST select + embed (filteri projekat/inženjer/status/search) |
| `/pb/tasks` / `/:id` | POST / PATCH | edit | create/update; PATCH nosi `expectedUpdatedAt` (optimistic lock 409) |
| `/pb/tasks/bulk` | PATCH | edit | bulk status/prioritet/inženjer (`id=in`) |
| `/pb/tasks/:id/soft-delete` · `/pb/tasks/soft-delete` | POST | edit | `pb_soft_delete_task(s)` |
| **`/pb/tasks/:id/progress`** | **POST** | **progress** | `pb_update_task_progress` (jedini write za inzenjera) |
| `/pb/tasks/:id/comments` (+PATCH/DELETE `/:cid`) | GET/POST/… | comment | 1h prozor ostaje u RLS (GUC) → 403 mapiranje |
| `/pb/tasks/:id/deps` (+DELETE) | GET/POST | edit | anti-ciklus trigger → 409 |
| `/pb/tasks/:id/files` (+meta, presigned up/down, soft-delete) | GET/POST/DELETE | comment read / edit write | bucket `pb-task-files` |
| `/pb/load-stats` · `/pb/team-load-stats` | GET | read | `pb_get_load_stats(20)` · `pb_get_team_load_stats(20)` |
| `/pb/work-reports` (+POST/DELETE) | GET/… | reports_own (row u DB) | REST; insert i za tuđe ako reports_all |
| `/pb/work-reports/summary` | GET | reports_own/all (row u DB) | `pb_get_work_report_summary` |
| `/pb/tips` (+`/:id`) | GET | read | `pb_list_eng_tips(p_filter)` · `pb_get_eng_tip` |
| `/pb/tips` / `/:id/like` / `/:id/soft-delete` | POST | tips_write / read / autor-admin | `pb_save_eng_tip` · toggle like · soft delete |
| `/pb/tips/categories` CRUD | GET/POST/DELETE | read / **pb.admin** | list/upsert/delete kategorija |
| `/pb/tips/:id/files` (+presigned, delete) | POST/DELETE | tips_write | `pb_add_eng_tip_file`/`pb_delete_eng_tip_file` + bucket |
| `/pb/notification-config` | GET / PATCH | read / **pb.admin** | id=1 config (dispatch OSTAJE 1.0 pozadina) |

Idempotencija: PB nema svoj mehanizam → `rev_api_idempotency` obrazac (`clientEventId`) na svim POST mutacijama
(task, comment, work-report, tip, progress). CSV plana = FE (kao 1.0).

### 3.2 `/api/v1/profile/*` (Moj profil — sve kroz GUC, tela RPC-ova NETAKNUTA)

| Endpoint | 1.0 poreklo |
|---|---|
| GET `/profile/me` | `v_employees_safe?email=eq` + user_roles self (rola/override za prikaz) |
| GET `/profile/vacation` · POST `/vacation-requests` · POST `/:id/revise` · `/:id/cancel` · DELETE `/:id` | `v_vacation_balance`, `vacation_requests` insert (uz server-side re-check salda/preklapanja/min-datuma), `hr_revise/cancel/delete_vacation_request`, pa `kadr_queue_vacation_submission_notification` + pulse dispatch |
| GET `/profile/vacation-history` | `vacation_history` |
| GET/POST `/profile/makeup` (+DELETE) · GET/POST `/profile/paid-leave` | makeup_requests / paid_leave_requests + `kadr_delete_makeup` + queue RPC-ovi |
| GET `/profile/hours?month=` · PUT/DELETE `/profile/hours/remark` | `work_hours` (RLS row), `work_hours_remarks` upsert |
| GET `/profile/hours/karnet.pdf` | port klijentskog karnet PDF-a (podaci isti) |
| GET `/profile/attendance?range=` · POST `/profile/attendance/corrections` | `v_attendance_daily`+events+corrections, `attendance_submit_correction` |
| GET `/profile/onboarding` · GET `/profile/absences` · GET `/profile/colleagues-on-leave` | kadr_onboarding_*, absences |
| GET `/profile/talks` · POST `/profile/talks/:id/acknowledge` | employee_talks+corrective_*, `talk_acknowledge` |
| GET/POST `/profile/assessment/self` (+scores/answers/submit) | `assessment_open_self`, upserts, `assessment_self_submit` |
| GET `/profile/dev-plan` (+self-update, check-in) · GET/PATCH `/profile/expectations` | development_*, employee_expectations (self-RLS) |
| GET `/profile/position` (+`/pdf`) · GET `/profile/company-values` · `/profile/pravilnik-go` (+POST ack) | job_positions, company_profile, statika + `kadr_document_ack` |
| GET `/profile/team` (+member drill: balance/absences/tools/karnet, POST correction-for) | v_employees_safe scope + `get_team_issued_tools` (**reuse Reversi endpointa**) |
| GET `/profile/reversi` | **reuse `/reversi/reports/my-issued` + `/my-consumed`** — bez novog koda |

### 3.3 `/api/v1/admin/*` (Podešavanja)

| Endpoint | Metod | Permisija | Napomena |
|---|---|---|---|
| `/admin/users` (+`/:id`) | GET | settings.users | union prikaz: 2.0 `users`+`user_roles`+overrides **i** sy15 `user_roles` (paralelni rad) |
| `/admin/users/invite` | POST | settings.users | **port edge logike**: GoTrue admin create (sy15) + sy15 user_roles insert + 2.0 users/UserRole/overrides upsert + welcome mejl (outbox) — atomarno-idempotentno (§7 P1) |
| `/admin/users/:id` | PATCH | settings.users | rola/scope/override/tim/aktivnost/must_change_password → piše u OBA sveta |
| `/admin/users/:id/reset-password` · `/deactivate` · `/activate` · DELETE | POST/DELETE | settings.users | reset = GoTrue admin PUT + must_change flag (1.0) / 2.0 reset tok; delete uz email-potvrdu (paritet) |
| `/admin/roles/catalog` · `/admin/permissions/matrix` | GET | settings.users | roles.ts + ROLE_PERMISSIONS živo (zamena erpRbacMatrix) |
| `/admin/grid-editors` CRUD | GET/POST/DELETE | settings.users | `kadr_grid_editor_allowlist` |
| `/admin/org/departments` · `/sub-departments` · `/job-positions` CRUD (+opisi, bulk import) | … | settings.users (struktura) / settings.org_profile (opisi) | paritet RLS podele admin vs org_profile |
| `/admin/company-profile` | GET/PUT | read svi / settings.org_profile | id=1 |
| `/admin/expectations` CRUD (+bulk) | … | settings.org_profile (delete admin) | v_employee_expectations |
| `/admin/competence-framework` (framework/groups/competences/levels/questions CRUD) | … | read svi / settings.users (admin edit) | v_competence_framework, v_profile_groups |
| `/admin/predmet-aktivacija` | GET/POST | settings.predmet_aktivacija | `list_predmet_aktivacija_admin` / `set_predmet_aktivacija` (audit u RPC-u!) |
| `/admin/audit-log` | GET | settings.audit | `v_settings_audit_log` (sy15) + 2.0 AuditLog (dva izvora, jedan ekran) |
| `/admin/system/ai-models` | GET/PUT | settings.system | sastanci/montaza AI settings tabele (read svi, write admin — 42501 paritet) |

## 4. FE (Next)

- **`/pb`** — nav domen **📐 PROJEKTOVANJE** (nova sekcija; PDM/primopredaje već tamo). 7 tabova (paritet):
  1. **Plan** (alarmi, opterećenost 20 r.d. po inženjeru+timu, filteri, tabela grupisana po projektu / kartice,
     bulk-bar, saved views→localStorage, CSV) · 2. **Kanban** (5 statusa, brze akcije, +10 dana done)
  3. **Gantt** (po inženjeru, plan+ostvareno, zoom D/N/M/Q, drag datuma desktop) · 4. **Izveštaji** (kalendar
  meseca, unos sati 0.5–12 + **STT sr-RS**, obračun po periodu) · 5. **Analiza** (po projektu, problemi)
  6. **Saveti** (pretraga/kategorije/like, detalj modal, punostrani editor, markdown, prilozi) · 7. **Podešavanja**
  (admin: notif config + kategorije). Modali: task editor (restriktovani mod za inzenjera!), textarea
  (Opis/Problem), deps picker, prilozi. Mobilno: paritet `/m/projektovanje` = „Moji zadaci" (status/%/komentari) —
  u 2.0 responsive to je isti `/pb` sa self-filterom.
- **`/profil`** — **top-level kartica** (obrazac O9 — NE u domen). Sekcije §0.2 redom kao 1.0. Mobilno: 2.0
  responsive pokriva i 1.0 `/m/profil` hub (linkove ka odsustva/sati/odobravanja zadržati kao ankere sekcija;
  Odobravanja ostaju 1.0 link do G).
- **`/podesavanja`** — nav domen **⚙️ SISTEM**. 4 grupe kao 1.0; tabovi Mašine + Održ. profili se u D NE sele
  (kartica-link na 1.0 do Talasa F). „Uloge i dozvole" = živ prikaz kataloga. „Integracije" spojiti sa postojećim
  2.0 sync-status ekranima (ne duplirati).
- Skener/print: nema u talasu. Teme/ikonografija: 2.0 ui-kit (1.0 je već „UI 2.0" stilizovan — tokovi isti).

## 5. Parity matrica (doktrina B — puni se TOKOM rada; bez nje nema implementacije)

| # | Funkcija | Status |
|---|---|---|
| **PB** | | |
| 1 | Plan: tabela+kartice, filteri, sort, grupisanje po projektu | NOT_STARTED |
| 2 | Plan: alarmi (rok/bez inženjera/prekoračenje kapaciteta) + opterećenost (load+team stats) | NOT_STARTED |
| 3 | Plan: bulk akcije + saved views + CSV | NOT_STARTED |
| 4 | Task editor modal (pun edit, optimistic lock 409) + Opis/Problem | NOT_STARTED |
| 5 | **Restriktovani edit inzenjera (`/progress` RPC put)** | NOT_STARTED |
| 6 | Soft delete (pojedinačno + bulk) | NOT_STARTED |
| 7 | Komentari CRUD (1h prozor → 403 UX) | NOT_STARTED |
| 8 | Zavisnosti + anti-ciklus 409 | NOT_STARTED |
| 9 | Prilozi taska (presigned, soft-delete, 24h prozor) | NOT_STARTED |
| 10 | Kanban (5 kolona, brze akcije, done 10d) | NOT_STARTED |
| 11 | Gantt (zoom, drag datuma, tooltip, plan vs ostvareno) | NOT_STARTED |
| 12 | Work reports: kalendar + unos (STT) + brisanje + obračun po periodu | NOT_STARTED |
| 13 | Analiza po projektu + aktivni problemi | NOT_STARTED |
| 14 | Saveti: lista/pretraga/filteri/like/detalj/editor/prilozi/draft-scope | NOT_STARTED |
| 15 | Kategorije saveta CRUD (admin) + PB notif config (admin) | NOT_STARTED |
| 16 | PB mobilni tok („Moji zadaci" self-filter, responsive) | NOT_STARTED |
| **Moj profil** | | |
| 17 | Profil header + mapiranje email→employee (+prazan profil poruka) | NOT_STARTED |
| 18 | GO: saldo + zahtevi + submit (provere) + revise/cancel/delete + mejl queue | NOT_STARTED |
| 19 | GO istorija + Evidencija GO PDF | NOT_STARTED |
| 20 | Nadoknada sati (lista+podnošenje+brisanje) + Plaćeno odsustvo | NOT_STARTED |
| 21 | Mesečni sati iz grida + primedba (upsert/delete) + Karnet PDF | NOT_STARTED |
| 22 | Prisustvo (dnevni pregled, eventi, korekcija — i za člana tima) | NOT_STARTED |
| 23 | Moj tim (scope, saldo/odsustva/alati po članu, karnet tima, PDF pozicije člana) | NOT_STARTED |
| 24 | Onboarding pregled + Dokumenti i rokovi (lekarski/ugovori) | NOT_STARTED |
| 25 | Razgovori + „Upoznat sam" + korektivne mere pregled | NOT_STARTED |
| 26 | 360 samoprocena (open/save/submit) + rezultati | NOT_STARTED |
| 27 | Dev plan (samoprocena, check-in) + Očekivanja (self status) | NOT_STARTED |
| 28 | Opis pozicije + PDF; Vrednosti firme (baza); Kompanijske vrednosti + Pravilnik GO (statika+print PDF+ack) | NOT_STARTED |
| 29 | Zaduženja (revers) — reuse Reversi API | NOT_STARTED |
| 30 | Kolege na odsustvu | NOT_STARTED |
| **Podešavanja** | | |
| 31 | Korisnici: lista + stat kartice + chipovi prava + filteri | NOT_STARTED |
| 32 | **Invite tok (dvostrani: GoTrue+sy15 user_roles+2.0 users/roles/overrides + welcome mejl)** | NOT_STARTED |
| 33 | Edit korisnika (rola/scope/override/must_change) — piše u OBA sveta | NOT_STARTED |
| 34 | Kopiranje prava (form-fill, ne snima) | NOT_STARTED |
| 35 | Reset lozinke + deaktivacija/aktivacija + brisanje uz potvrdu | NOT_STARTED |
| 36 | Uloge i dozvole — živ prikaz kataloga (roles.ts + ROLE_PERMISSIONS) | NOT_STARTED |
| 37 | Grid urednici CRUD | NOT_STARTED |
| 38 | Organizacija: struktura CRUD + opisi pozicija + bulk import | NOT_STARTED |
| 39 | Vrednosti firme edit; Očekivanja CRUD+bulk; Okvir kompetencija (pregled+admin editor) | NOT_STARTED |
| 40 | Podešavanje predmeta (list/set RPC, audit u RPC) | NOT_STARTED |
| 41 | Audit log tab (sy15 view + 2.0 AuditLog) | NOT_STARTED |
| 42 | Sistem tab (dijagnostika + AI model izbor) + Integracije/Notifikacije hub | NOT_STARTED |
| **Presek** | | |
| 43 | e2e permission matrica (pb.read/comment/edit/progress/tips_write/reports_all/admin × settings.* × profile self/team; override deny/grant) | NOT_STARTED |
| 44 | Overrides data-migracija: user_roles kolone → user_permission_overrides + UserRole scope (54 reda) | NOT_STARTED |
| 45 | GUC sub+email na SVIM profil/PB mutacijama (auth.uid() potrošači: likes, storage owner, ack) | NOT_STARTED |

## 6. Redosled izvođenja (R-faze za CEO talas)

| Faza | Šta | Gate |
|---|---|---|
| R0 | Nenadov review spec-a (presuda §7) + re-verifikacija snapshot-a na živoj sy15 + grants za `servosync2_app` (pb_* tabele+bucketi, execute na front fn iz snapshota, SELECT na deljene G tabele profila — migracija u 1.0 repo) | odobreno |
| R1 | BE read: Prisma modeli (§1) + svi GET (PB/profile/admin) + `pb.*`/`settings.*`/`profile.*` permisije + **overrides data-migracija (matrica #44)** + e2e read | read paritet |
| R2 | BE mutacije: PB write put (REST paritet + RPC progress/tips + idempotency) + profil mutacije kroz GUC (submit GO/makeup/paid-leave/correction/ack/assessment) + **admin users dvostrani tok** + e2e full | write paritet |
| R3 | FE: `/pb` 7 tabova + modali; `/profil` sve sekcije + PDF portovi (karnet/pozicija/evidencija GO/print-statika); `/podesavanja` 4 grupe; responsive (pokriva /m/projektovanje + /m/profil) | UI paritet |
| R4 | Živi smoke (pun ciklus: invite korisnika → rola+override → PB task → inzenjer progress → GO zahtev sa profila → mejl u outbox) + Playwright happy-path + paralelni rad → hub preklop 3 kartice (1.0 fallback) | parity gate (doktrina D) |
| R5 | Retrospektiva tempa → PROCENA_SEOBE update | kalibracija |

Redosled unutar talasa: **Podešavanja/RBAC prvo** (kontrolna tabla prava — preduslov za enforce PB/profil
permisija), pa PB, pa Moj profil (najviše GUC reuse-a). Napomena za izvršioce: Moj profil endpointi NE smeju
duplirati Kadrovska tela — svaka „popravka" HR RPC-a je van obima (vlasnik G).

## 7. Otvorena pitanja (Nenad presuđuje; svako sa predlogom)

1. **Dvostrano upravljanje nalozima tokom paralelnog rada** — 2.0 admin konzola mora li da održava i 1.0 svet?
   **Predlog: DA — 2.0 postaje master**: invite/edit/reset piše u sy15 (GoTrue admin API + `user_roles`) I u 2.0
   (`users`/`user_roles`/`user_permission_overrides`); 1.0 usersTab ostaje read-fallback do cutover-a taba; smer
   sinhronizacije samo 2.0→1.0 (bez povratnog sync-a).
2. **Kanonski ključevi override-a** u `user_permission_overrides`. **Predlog:** `plan_montaze.write`=deny (za
   `plan_montaze_readonly`), `kadrovska.access`=grant, `kadrovska.contracts_read`=deny — semantika 1:1; potrošači
   (Plan montaže C, Kadrovska G) čitaju iste ključeve kad stignu; `finalni_potpisnik` ostaje zaseban named-flag.
3. **`must_change_password` u 2.0 users** ne postoji. **Predlog:** dodati boolean + force-change ekran u 2.0 auth
   (paritet 1.0 toka); do tada flag važi samo za 1.0 login (GoTrue), što je prihvatljivo jer se lozinke i dalje
   postavljaju kroz GoTrue.
4. **Tabovi Mašine + Održ. profili** (CMMS wrapper, `maint_user_profiles` po `auth.uid()`). **Predlog: NE u D** —
   ostaju u 1.0 Podešavanjima do Talasa F (u 2.0 Podešavanjima kartica-link na 1.0); D ne dira maint authz sistem.
5. **Passkeys sekcija profila** — WebAuthn upisi su mrtvi posle 1.5 cutover-a (RP origin). **Predlog: NE seliti**;
   sekciju izostaviti iz 2.0 profila, passkey priča ide uz 2.0 auth roadmap (poseban zadatak, ne talas D).
6. **Moj profil ceo u D** (uklj. GO/sati/prisustvo/360 kroz GUC) ili samo ne-G sekcije pa ostatak uz G?
   **Predlog: CEO u D** — paritet po konstrukciji (DB fn netaknute), G kasnije nasleđuje iste objekte bez izmene
   profila; uslov: G ne menja potpise deljenih RPC (popisani u snapshotu, sekcija „MOJ PROFIL").
7. **PB permisije za rane biro-role** — `inzenjer`/`projektant_vodja` već imaju primopredaje write u 2.0 katalogu.
   **Predlog:** uz R1 dodati `pb.*` dodele iz §2.5 (aktivacija tier-3.0 uloga = konfiguracija, ne nova uloga);
   `hr`/`poslovni_admin` dobijaju `pb.edit` (pravilo 2.4.1 — NE sužavati bez eksplicitne odluke).
8. **Asimetrija prioriteta rola DB (`current_user_role`: leadpm>pm>viewer>ELSE) vs FE (admin>leadpm>…)** — živa
   na produ; multi-role korisnici sa npr. admin+inzenjer mogu dobiti različit „efektivni" odgovor po sloju.
   **Predlog:** u 2.0 guard koristi UNION permisija svih uloga (postojeći `permissionsForRoles`) pa asimetrija
   nestaje po konstrukciji; DB fn se NE dira (1.0 paritet do gašenja).
9. **`predmet_aktivacija` ekran** je Podešavanja, a podatak je Proizvodnja (Talas C overlay nad bigtehn cache).
   **Predlog:** ekran + API u D (kako je i u 1.0), C samo konzumira flag — bez dupliranja; umire/repointuje se sa
   QBigTehn mostom (playbook §4.2).
10. **Audit konsolidacija** — sy15 `audit_log` (trigeri) vs 2.0 `AuditLog`. **Predlog: NE stapati u D** — jedan
    ekran, dva izvora ($queryRaw `v_settings_audit_log` + 2.0 AuditLog); konsolidacija tek u finalnom 3.0 cutover-u.
    2.0 admin mutacije nad sy15 `user_roles` i dalje pale postojeći triger (GUC daje `actor_email` paritet).
11. **„Uloge i dozvole" statička matrica** (erpRbacMatrix pokriva i module koji još nisu u 2.0). **Predlog:** živ
    prikaz kataloga za 2.0 module + statički „legacy" blok za još-neseljene module (označen), da admin zadrži
    potpunu sliku do kraja 3.0.

---

**Procena (MN, kalibracija Reversi=1):** PB **2–2.5** (bez per-user override-a i realtime-a; 19 RPC + 2 bucketa;
Gantt/Kanban su FE-teški ali BE tanak) · Podešavanja/RBAC **2.5–3.5** (dvostrani identitet + data-migracija
override-a + katalog usklađivanje; najveći rizik talasa) · Moj profil **1.5–2** (agregator kroz GUC + 4 PDF porta;
nula novih DB tela) → **ukupno Talas D: ~6–8 MN** (stara gruba procena 6–8.5 — potvrđena, sa pomerenim težištem
sa PB na RBAC konzolu).
