# Module Spec: Kadrovska (HR) — 3.0 TALAS G

| | |
|---|---|
| **Modul** | 1.0 „Kadrovska" (`kadr_*`/`hr_*`/`attendance_*`/`assessment_*`) — zaposleni, ugovori, godišnji odmor, odsustva, mesečni sati, prisustvo, zarade, razvoj, uvođenje/izlazak, notifikacije. **NAJVEĆI modul** (25.8k UI, 60 fajlova, 5 hub-grupa). |
| **Verzija spec** | 1.0 (2026-07-13) |
| **Faza** | 3.0 — Talas G (POSLEDNJI; PII + zarade + apsorbuje veze Moj profil iz Talasa D) |
| **Izvor** | 1.0 ŽIVI kod (`src/ui/kadrovska/` 60 fajlova ~25.8k LOC + `src/services/*.js` — kadrovska/employees/contracts/vacation/attendance/prisustvo/salaryPayroll/assessments/hrNotifications + `src/ui/mobile/` 5 ekrana + edge `hr-notify-dispatch`/`kiosk-punch`/`assessment-invite`/`push-dispatch`) + **živa baza kroz Management API (snimljeno 12–13.07)** |
| **Authz snapshot** | [`authz-snapshots/talasG-fn-defs-2026-07-12.sql`](authz-snapshots/talasG-fn-defs-2026-07-12.sql) — **119 fn** (kadr_*/hr_*/attendance_*/assessment_*/talk_*/makeup/paid_leave/nop + `current_user_*` helperi + kanonski view-ovi) · [`authz-snapshots/talasG-policies-2026-07-12.sql`](authz-snapshots/talasG-policies-2026-07-12.sql) — **141 RLS politike na 49 tabela + 4 storage politike** (bucket `employee-docs`) |
| **Doktrina** | [`MIGRACIONA_DOKTRINA_3.0.md`](MIGRACIONA_DOKTRINA_3.0.md) — VAŽI U CELOSTI |
| **Status** | 📝 NACRT — čeka R0 review (Nenad); otvorena pitanja §7 |

> ⚠️ **PII + ZARADE = najosetljiviji talas.** Dva sloja zaštite se PRESLIKAVAJU kroz GUC most bez prepisivanja:
> (1) **PII maska** — front NIKAD ne čita `employees` direktno za prikaz nego `v_employees_safe`; osetljiva polja
> i tabele (`employee_children`, `employee_bank_cards`, `employee_foreign_docs`, `employee_personal_docs`,
> `employee_documents`, storage `employee-docs`) idu kroz `current_user_can_manage_employee_pii()` = **admin ∨
> poslovni_admin** (HR NEMA PII!). (2) **Zarade** — `salary_terms`/`salary_payroll` su **admin-only** (sve 4 op
> `current_user_is_admin()`) + trigger `salary_payroll_immutability_check` (zaključan obračun se ne menja).
> HR (`hr`) rola NAMERNO nema ni zarade ni PII — to je pravilo firme, ne propust (§2.6).

> ⚠️ **Deljena površina sa Talasom D (Moj profil).** Moj profil je čist agregator nad HR objektima kroz GUC
> (D spec §0.2). **G NE menja potpise deljenih RPC-ova** koje D već koristi (`hr_revise/cancel/delete_vacation_request`,
> `attendance_submit_correction`, `kadr_delete_makeup`, `paid_leave_delete`, `talk_acknowledge`,
> `assessment_open_self/self_submit`, `kadr_queue_*_notification`). Ako D krene pre G, on nasleđuje ove objekte
> read-only/self-scope; G kasnije dodaje menadžersku stranu bez diranja profila.

---

## 0. Obim — šta se SELI, šta NE (FRONT vs POZADINA)

**Živi DB objekti (13.07):** ~49 G-tabela (public), 14 kanonskih view-ova (svi `security_invoker=true`),
119 funkcija, 141 RLS politike + 4 storage, ~20 trigera, 1 privatni storage bucket (`employee-docs`),
**9 pg_cron poslova** (od 22 ukupno na bazi), 4 edge funkcije.

### 0.1 SELI SE (korisnička površina → 2.0 UI + BE)

- **Sav desktop UI**: 15 tabova u 5 hub-grupa (§4) + HUB landing.
- **REST read/write paritet**: 1.0 front ide PostgREST-om na ~40 tabela + 14 view-ova; 2.0 BE zamenjuje to
  endpointima nad ISTIM sy15 tabelama kroz GUC (RLS odlučuje red-po-red). **OBAVEZAN `withUserRls`** (doktrina A2a):
  gotovo cela HR površina ima row-scoped SELECT/DML politike (svoje/tim/mgmt-scope) → BYPASSRLS put bi probio maske.
- **~60 front RPC-ova** (svi SECURITY DEFINER, interni guard-ovi) — razvrstani po hub-grupama u §3.
- **Storage**: bucket `employee-docs` (private) — dokumenta zaposlenih, ugovori PDF, evidencije GO PDF, prilozi
  za mejl knjigovođi. Sve op = `current_user_can_manage_employee_pii()`. Putanje 1.0-kompatibilne (paralelni rad).
- **Mobilno** (`/m/*` paritet, 2.0 responsive): `/m/kadrovska`, `/m/odsustva`, `/m/odobravanja`, `/m/sati`, `/m/profil`
  (§4) + **novi ekran „Moje prisustvo"** (gap iz 1.0 — vidi §4).
- **Kiosk ekran** `/kiosk` (front fetch ka edge `kiosk-punch` sa `x-kiosk-key`) — UI se seli; edge = pozadina.
- **HR generatori PDF** (jsPDF, puna ćirilica): Rešenje o GO, A4 Evidencija GO, Potvrda o zaposlenju/zaradi,
  Aneks ugovora, Porodiljsko, Sporazumni raskid, Ugovor o radu, Karnet meseca, payslip.

### 0.2 NE SELI SE (pozadina — ostaje u sy15 bazi/bridge, radi za oba UI-ja)

| Komponenta | Tip | Detalj |
|---|---|---|
| `hr-notify-dispatch` (edge, service_role) | worker | prazni `kadr_notification_log` outbox kroz `kadr_dispatch_dequeue/mark_sent/mark_failed`; mark-sent ODMAH (anti-dupli batch); backoff cap 6h, MAX_ATTEMPTS=8; bez env tokena → DRY-RUN markiran sent; WhatsApp = Meta Cloud API template `hr_alert_sr` (E.164) |
| `kiosk-punch` (edge, `--no-verify-jwt`+`x-kiosk-key`) | endpoint | `kiosk_record_punch` → `attendance_events` (source='kiosk', dedup <30s, auto-toggle smera) |
| `assessment-invite` (edge; gate admin/hr/menadzment) | worker | 360 pozivnice preko Resend; link `ocena.html?token=`; `assessment_token_context`/`assessment_submit_by_token` |
| `push-dispatch` (edge, `PUSH_DISPATCH_KEY`) | worker | trigger `kadr_notify_push_trg` (AFTER INSERT na log, pg_net) → `device_push_tokens` (čisti 404/410), deep-link po `notification_type` |
| bridge `syncKatze.js` (Node, node-cron ~10min) | worker | Katze MSSQL (192.168.64.10 `dbo.tblReg`) → UPSERT `attendance_events` (source,external_id; watermark `attendance_katze_max_idreg`); resolve preko `employee_badges`. **JEDINI upisivač events-a pored kioska** |
| pg_cron × 9 (§1.4) | scheduler | HR reminders, weekly risk, notify dispatch pulse (*/5), onboarding/corrective reminders, attendance alerts+digest (dupli UTC4/UTC5 zbog DST) → svi zovu `kadr_schedule_*`/`kadr_queue_*` DEFINER fn koji pune outbox |
| ~20 trigera | trigger | audit (`kadr_audit_log_trigger`, `kadr_work_hours_audit`), guard (`absences_archive_guard`, `employees_sensitive_guard`), sync (`employees_sync_full_name`, `kadr_medical_exams_sync_employee`, `attendance_fill_event_ts`), salary (`salary_payroll_compute_totals`, `salary_payroll_immutability_check`, `salary_payroll_set_created_by`, `salary_terms_close_previous`, `salary_terms_set_created_by`), `vacation_requests_no_overlap`, `kadr_notify_push_trg` — **2.0 ništa ne duplira** |
| `kadrOfflineQueue.js` (localStorage, MAX 200/8) | front-legacy | ⚠️ POST retry NIJE idempotentan (nema server dedup) → **NE prenosi se u 2.0 v1** (kao Reversi/Lokacije odluka); 2.0 mutacije nose `clientEventId` (doktrina A4) |
| interni helperi | fn | `kadr_oversight_recipients`, `kadr_makeup_actor_allowed`, `attendance_extra_recipients`, `paid_leave_reason_map`, `rev_current_employee_id` (Reversi helper reuse u HR) — ostaju u bazi, GUC ih poziva |

**Queue-okidači su granični** (`kadr_queue_document_email`, `kadr_queue_vacation_notification`,
`kadr_queue_vacation_submission_notification`, `kadr_queue_makeup_notification`, `kadr_queue_paidleave_notification`,
`kadr_queue_nop_notification`, `kadr_queue_payroll_notifications`, `kadr_trigger_schedule_hr_reminders`,
`kadr_trigger_weekly_risk_summary`): **FRONT ih okida** (posle akcije), ali su DEFINER i **jedini legalni upis u
`kadr_notification_log`** (INSERT politika = deny za sve druge). 2.0 ih poziva kroz GUC posle mutacije; isporuka
ostaje pozadinska (dispatch + push edge). ⚠️ `kadr_pulse_notify_dispatch` NE zvati iz fronta (cron radi */5).

## 1. Živi podaci i model (cloud snapshot 12–13.07 — brojevi indikativni, re-verifikovati na sy15)

**PK** = uuid (osim lookup tabela). Modeli se DODAJU u postojeći `prisma/sy15.prisma`. Za `attendance_events`
(**480.885 redova!**) BE čita ISKLJUČIVO kroz view-ove (`v_attendance_now/daily/shadow_monthly/vs_grid`) —
jednosmerni tok upisa ostaje u sy15 (bridge+kiosk); nema Prisma write modela za events. Za čiste izveštajne/lookup
tabele dozvoljen `$queryRaw`; predlog je pun model za sve sa CRUD-om iz fronta.

### 1.1 Tabele + redovi (izvor: `pg_stat_user_tables`, 13.07)

| Hub-grupa | Tabela | Redova | Prisma? | Napomena |
|---|---|---:|---|---|
| Jezgro | `employees` | 157 | ✅ | **izvor istine za CELU firmu**; PII; front čita kroz `v_employees_safe`; `worker_employee_map` most ka 2.0 (§1.5) |
| Jezgro | `contracts` | 3 | ✅ | soft-delete (arhiviraj/vrati); PDF ugovor/rešenje; netToGross RPC |
| Zaposleni | `employee_children` | 21 | ✅ | **PII** (`current_user_can_manage_employee_pii`) |
| Zaposleni | `employee_bank_cards` | 0 | ✅ | **PII** — ALL kroz jedan `bank_cards_pii_all` |
| Zaposleni | `employee_foreign_docs` | 2 | ✅ | **PII** (stranci); ALL `foreign_docs_pii_all` |
| Zaposleni | `employee_personal_docs` | 11 | ✅ | **PII** (LK/pasoš/vozačka/lekarski važenja); ALL `personal_docs_pii_all` |
| Zaposleni | `employee_documents` | 91 | ✅ | storage meta; `doc_type` CHECK drift (§2.6); INSERT `uploaded_by=auth.uid()` + PII |
| Zaposleni | `kadr_certificates` | 0 | ✅ | sertifikati/obuke; hr_or_admin ∨ poslovni_admin |
| Zaposleni | `kadr_medical_exams` | 0 | ✅ | lekarski pregledi; trigger sync na employees; +view status |
| Zaposleni | `employee_badges` | 192 | ✅ | Katze bedževi (QR nalepnice); hr_or_admin ∨ gridEditor read |
| Odmori | `vacation_requests` | 73 | ✅ | GO zahtevi; status pending→sef_approved→approved; `no_overlap` trigger |
| Odmori | `vacation_entitlements` | 132 | ✅ | akrual/uvoz salda; `can_edit_vacation_balance()` |
| Odmori | `vacation_history` | 447 | ✅ | Excel istorija (odvojeno od salda); SELECT-only |
| Odmori | `vacation_bonus_days` | 1 | ✅ | bonus GO (vikend); SELECT svi auth |
| Odmori | `absences` | 69 | ✅ | odsustva; upis i u grid; `neplaceno` samo admin; `archive_guard` |
| Odmori | `makeup_requests` | 4 | ✅ | nadoknada sati; storno vraća −1 GO |
| Odmori | `paid_leave_requests` | 0 | ✅ | plaćeno odsustvo; `paid_leave_reason_map` |
| Odmori | `nop_requests` | 0 | ✅ | neplaćeno — **samo admin** odobrava; upisuje `nop` u work_hours |
| Sati | `work_hours` | 5.414 | ✅ | mesečni grid; `can_edit_kadrovska_grid()`; `nop` code samo admin; audit trigger |
| Sati | `work_hours_remarks` | 0 | ✅ | primedbe (self ∨ manager) |
| Sati | `attendance_events` | 480.885 | ❌ (view read) | Katze+kiosk; jednosmerno; RLS hr_or_admin/gridEditor + own |
| Sati | `attendance_corrections` | 2 | ✅ | korekcije (own ∨ manager ∨ hr_or_admin); važenje 3 dana, mejl šefu |
| Sati | `attendance_notify_extra` | 6 | ✅ | dopunski primaoci mejla prisustva (pododeljenja bez šefa) |
| Zarade | `salary_terms` | 142 | ✅ | uslovi zarade; **admin-only**; `close_previous` versioning; comp modeli |
| Zarade | `salary_payroll` | 0 | ✅ | mesečni obračun; **admin-only** + `immutability_check` (zaključan se ne menja); V2 optimistic |
| Razvoj | `assessments` (+`_cycles`/`_raters`/`_scores`/`_answers`/`_targets`/`_results`) | 9/1/10/0/0/0/0 | ✅ | 360 procena; status collecting; visible_to_employee gejt |
| Razvoj | `development_plans` (+`_checkins`) | 0/0 | ✅ | IRP; self-update + manager; `current_user_manages_dev_plan` |
| Razvoj | `employee_expectations` | 0 | ✅ | (view `v_employee_expectations`); self-status `u_toku/ispunjeno` (D-domen ekran) |
| Razvoj | `employee_talks` (+`corrective_plans`/`_measures`) | 0/0/0 | ✅ | razgovori nacrt→podeljen→potvrdjen; `current_user_can_manage_talk`; mere |
| Uvođenje | `kadr_onboarding_runs`/`_tasks`/`_templates`/`_template_items` | 0/0/0/0 | ✅ | tokovi + šabloni; `kadr_can_manage_hr()` + own-read |
| Sistem | `kadr_notification_log` | 595 | — ($queryRaw, hr) | outbox; **INSERT deny** (samo DEFINER queue fn); `kadr_notif_type_chk` CHECK (§2.6) |
| Sistem | `kadr_notification_config` | 1 | ✅ | singleton; hr_or_admin |
| Sistem | `kadr_audit_log` | 1.048 | — ($queryRaw, admin) | audit; SELECT admin; +view `v_kadr_audit_log` |
| Sistem | `kadr_document_ack` | 4 | ✅ | ack Pravilnika GO; INSERT own (`rev_current_employee_id`!); read hr ∨ own |
| Sistem | `kadr_holidays` | 36 | ✅ | praznici; read svi, write admin |
| Sistem | `device_push_tokens` | 0 | ✅ | FCM tokeni; own (`user_id=auth.uid()`) |
| Allowlist | `kadr_grid_editor_allowlist` | 5 | ✅ (D ekran) | iza `can_edit_kadrovska_grid()`; „Grid urednici" tab je Talas D |
| Allowlist | `kadr_vacation_editor_allowlist` | 4 | ✅ (D ekran) | iza `can_edit_vacation_balance()`; **RLS OFF** (relrowsecurity=false, lookup) |

**Deljeno sa Talasom D (G čita, D poseduje ekran):** `departments`(13), `sub_departments`(32), `job_positions`(78),
`company_profile`(1), `competences`+`competence_*`(okvir kompetencija — koristi ga i 360), `user_roles`(54, email-based),
`predmet_aktivacija` (grid → veži predmet). Grants za `servosync2_app` moraju pokriti SELECT na njih (paritet kroz GUC).

### 1.2 View-ovi koje front ČITA (14; svi `security_invoker=true` → rola treba SELECT i na osnovnim tabelama, doktrina A6)

`v_employees_safe` (PII maska — kanon!), `v_vacation_balance` (**GO grid-kanon**, §2.6),
`v_attendance_now`, `v_attendance_daily`, `v_attendance_shadow_monthly`, `v_attendance_vs_grid`,
`v_salary_payroll_month`, `v_employee_current_salary`, `v_development_plans`, `v_employee_expectations`,
`v_assessment_scope`, `v_kadr_audit_log`, `v_kadr_certificate_status`, `v_kadr_medical_exam_status`.

### 1.3 Prisma odluka

Svi modeli u `prisma/sy15.prisma` (@prisma-sy15/client). `attendance_events` = **NO write model** (read kroz view
`$queryRawUnsafe`/view-mapiran read model); `kadr_notification_log`/`kadr_audit_log`/`predmet_aktivacija` = `$queryRaw`
read (outbox/audit se NE upisuju iz 2.0 direktno). Sve CRUD tabele = pun model. `employees` model NE izlaže PII polja
u default select-u — BE serijalizuje kroz `v_employees_safe` osim na PII endpointima (`kadrovska.pii`).

### 1.4 pg_cron (9 kadr poslova; POZADINA — ostaju u sy15)

| jobid | schedule (UTC) | job | fn |
|---:|---|---|---|
| 4 | `0 7 * * *` | kadr_schedule_hr_reminders_daily | `kadr_schedule_hr_reminders()` |
| 13 | `0 7 * * 1` | kadr-weekly-risk-summary-monday-07 | `kadr_queue_weekly_risk_summary()` |
| 16 | `*/5 * * * *` | kadr_notify_dispatch_every_5_min | `kadr_pulse_notify_dispatch()` (pg_net → hr-notify-dispatch) |
| 19 | `0 7 * * *` | kadr_onboarding_reminders_daily | `kadr_schedule_onboarding_reminders()` |
| 20 | `30 7 * * *` | kadr_corrective_reminders_daily | `kadr_schedule_corrective_reminders()` |
| 26 | `0 4 * * *` | kadr_attendance_alerts_utc4 | `kadr_schedule_attendance_alerts()` (DST guard) |
| 27 | `0 5 * * *` | kadr_attendance_alerts_utc5 | isto (drugi UTC ofset) |
| 28 | `30 4 * * 1` | kadr_attendance_digest_utc4 | `kadr_schedule_attendance_weekly_digest()` |
| 29 | `30 5 * * 1` | kadr_attendance_digest_utc5 | isto |

### 1.5 `worker_employee_map` — DRIFT nalaz

Tabela `worker_employee_map` (most `employees` ↔ 2.0 radnici, ~89 redova po memoriji) **NE postoji u ovom zamrznutom
cloud snapshotu** (`information_schema.tables` = 0). Živi na **self-host sy15** (ubuntusrv), ne na cloud restore-izvoru.
Re-verifikovati u R0 na živoj sy15; ako Reversi/2.0 već drži most, G ga NE duplira — samo čita `employees` kao izvor istine.

## 2. Žive politike + authz mapa (141 politika + 4 storage; snapshot 13.07 — RE-VERIFIKOVATI na sy15 pre R1)

### 2.1 Helper funkcije = rečnik authz-a (iz fn-defs snapshota)

| Helper | Ko prolazi | Sloj |
|---|---|---|
| `current_user_is_admin()` | `user_roles` global `admin` aktivan po **email-u** | rola |
| `current_user_is_hr()` | rola `hr` po email-u | rola |
| `current_user_is_hr_or_admin()` | hr ∨ admin | rola |
| `current_user_is_poslovni_admin()` | rola `poslovni_admin` | rola |
| `current_user_is_management()` | rola `menadzment` | rola |
| `has_edit_role(proj?)` | global {admin,hr,menadzment,pm,leadpm,poslovni_admin} ∨ per-projekat {pm,leadpm} | rola(+scope) |
| `current_user_manages_employee(emp)` | admin ∨ hr ∨ poslovni_admin ∨ {pm,leadpm,projektant_vodja} ∨ (menadzment ∧ emp.sub_dept ∈ `managed_sub_department_ids`) | rola+scope |
| `current_user_can_manage_employee_pii()` | **admin ∨ poslovni_admin** (⚠ HR NE!) | PII |
| `can_edit_kadrovska_grid()` | email ∈ **DB tabela `kadr_grid_editor_allowlist`** | allowlist |
| `can_edit_vacation_balance()` | email ∈ **DB tabela `kadr_vacation_editor_allowlist`** | allowlist |
| `current_user_can_manage_vacreq()` | `current_user_is_vacreq_admin()` ∨ role ∈ {admin,hr,menadzment,leadpm,pm,poslovni_admin} | rola |
| `current_user_is_vacreq_admin()` | **hardkodovano `zoran.jarakovic@servoteh.com`** (SAMO Zoran) | mejl-hardkod |
| `kadr_can_manage_hr()` | (onboarding krug) — hr/admin | rola |
| `current_user_manages_dev_plan(emp)` / `current_user_sees_all_dev_plans()` / `current_user_dev_managed_sub_depts()` | menadžer razvoja po scope-u | rola+scope |
| `current_user_can_manage_talk(emp)` | menadžer razgovora (dev-plan krug) | rola+scope |
| `current_user_can_manage_assessment(emp)` | (admin ∨ manages_dev_plan(emp)) ∧ **emp ≠ ja** (niko o sebi!) | rola+scope |
| `current_user_can_manage_org_profile()` | admin/menadzment/pm/leadpm (D-domen; 360 cycles) | rola |
| `rev_current_employee_id()` / `current_user_employee_id()` | email → `employees.id` (self-scope svugde) | identitet |

### 2.2 Politike po grupama (svaka od 141 pripada tačno jednoj grupi; pun dump u `talasG-policies-2026-07-12.sql`)

**READ (SELECT) obrasci:**
| Obrazac USING | Tabele |
|---|---|
| **self ∨ manages_employee** (`emp ∈ moji employees po email` ∨ `current_user_manages_employee`) | absences, contracts, vacation_entitlements, vacation_history, work_hours, work_hours_remarks, nop_requests, attendance_events(own+manages), attendance_corrections(+hr_or_admin) |
| **self ∨ manages ∨ vacreq/vacreq_admin** | vacation_requests, makeup_requests, paid_leave_requests |
| **hr_or_admin ∨ gridEditor** | attendance_events (glavna), employee_badges |
| **hr_or_admin** | attendance_notify_extra, kadr_notification_config, kadr_notification_log |
| **PII: can_manage_employee_pii** (ALL/SELECT) | employee_children, employee_bank_cards, employee_foreign_docs, employee_personal_docs, employee_documents |
| **hr_or_admin ∨ poslovni_admin** | kadr_certificates, kadr_medical_exams |
| **self(visible) ∨ manages_dev_plan/talk/assessment** | assessments(+scope), assessment_* (kroz parent EXISTS), development_plans/checkins, employee_expectations, employee_talks, corrective_plans/measures |
| **admin only** | salary_terms, salary_payroll (sve 4 op), kadr_audit_log, nop UPDATE/DELETE |
| **true (svi auth)** | kadr_holidays, kadr_grid_editor_allowlist, vacation_bonus_days |
| **own (auth.uid())** | device_push_tokens (dpt_*), kadr_document_ack INSERT (`rev_current_employee_id`), kadr_onboarding own-read |
| **kadr_can_manage_hr ∨ own-read** | kadr_onboarding_runs/tasks (+ templates ALL=manage) |

**WRITE obrasci (INSERT/UPDATE/DELETE):**
| Pravilo | Tabele/politike |
|---|---|
| admin ∨ hr ∨ (has_edit_role ∧ manages_employee) | absences, contracts (I/U/D); + `neplaceno` samo admin (absences) |
| admin ∨ hr ∨ poslovni_admin (+has_edit∧manages za UPDATE) | employees (INSERT admin/hr/poslovni_admin; UPDATE + edit-scope; DELETE admin/hr) |
| can_edit_kadrovska_grid() | work_hours I/U/D; +`nop` code samo admin |
| can_edit_vacation_balance() | vacation_entitlements I/U/D |
| submitter-self INSERT; manage UPDATE; hr_or_admin DELETE | vacation_requests (INSERT self ∨ admin/hr ∨ edit∧manages ∨ vacreq_admin; UPDATE manages_employee), makeup_requests / paid_leave_requests (INSERT self; UPDATE `can_manage_vacreq`; DELETE hr_or_admin) |
| has_edit_role ∧ manages_employee INSERT; **admin** UPDATE/DELETE | nop_requests (neplaćeno = admin odobrava) |
| PII (can_manage_employee_pii) | employee_children/documents (+`uploaded_by=auth.uid()`), bank_cards/foreign/personal (ALL) |
| hr_or_admin ∨ poslovni_admin | kadr_certificates, kadr_medical_exams (I/U/D) |
| **admin only** | salary_terms, salary_payroll (I/U/D) |
| dev/talk/assessment scope (EXISTS parent) | assessment_* (write kroz rater-self ∧ status='collecting'; targets/results kroz `can_manage_assessment`), development_* (self-update + mgr), employee_talks (`can_manage_talk`; DELETE admin ∨ (manage ∧ status='nacrt')), corrective_* |
| own (auth.uid()) | device_push_tokens |
| **INSERT deny (samo DEFINER)** | kadr_notification_log (INSERT nema politiku za klijente) |
| hr_or_admin | kadr_notification_config/log UPDATE/DELETE, employee_badges ALL |
| admin | kadr_holidays write, kadr_grid_editor_allowlist write, kadr_document_ack (read hr ∨ own; INSERT own), employee_expectations DELETE |
| kadr_can_manage_hr | kadr_onboarding_* (templates/runs/tasks ALL) |

### 2.3 Storage politike (bucket `employee-docs`, private)

Sve 4 op (SELECT/INSERT/UPDATE/DELETE) = `bucket_id='employee-docs' AND current_user_can_manage_employee_pii()`
(admin ∨ poslovni_admin). ⚠️ 2.0 BE nema supabase `auth.uid()` kontekst → **storage-proxy** (kao Talas F §7.4):
BE kroz GUC (`withUserRls`) proveri PII pravo, pa izvrši upload/sign/delete service kredencijalom na sy15 storage-api;
putanje 1.0-kompatibilne (paralelni rad). Isti obrazac koristi i za PDF evidencije GO / ugovore koji se kače na mejl.

### 2.4 Kanon permission ključeva (`role-permissions.ts` — predlog)

**Modul-nivo (coarse; row-scope odlučuje DB kroz GUC):**
- `kadrovska.read` — pristup modulu = `canAccessKadrovska` (hr, admin, menadzment, poslovni_admin, projektant_vodja).
  ⚠️ **USKLAĐIVANJE SA TALASOM D:** D je mapirao override `kadrovska_access → grant kadrovska.access`. Predlog:
  **kanon je `kadrovska.read`**, a D-override preimenovati u `kadrovska.read` (grant) — jedan ključ (§7.1).
- `kadrovska.edit` — opšti HR write baseline = `has_edit_role()` (admin/hr/menadzment/pm/leadpm/poslovni_admin) —
  odsustva/ugovori/employees write (stvarni red-scope kroz `manages_employee` u DB).
- `kadrovska.manage` — HR menadžment krug (`kadr_can_manage_hr`/`is_hr_or_admin`) — onboarding, notif config, medical/certs, badges.
- `kadrovska.admin` — `current_user_is_admin()` — neplaćeno (nop), praznici, grid allowlist, audit log, purge.

**Pod-ključevi po hub-grupama:**
- `kadrovska.contracts_read` — vidljivost ugovora = `canViewContracts` (kadrovska minus `kadrovska_hide_contracts`
  minus projektant_vodja). **USKLAĐENO SA D** (D deny-override `kadrovska_hide_contracts → deny kadrovska.contracts_read`).
- `kadrovska.pii` — PII/osetljivo = `current_user_can_manage_employee_pii()` (**admin ∨ poslovni_admin**): deca,
  bankovne kartice, strani/lični dokumenti, employee_documents, `employee-docs` storage, unos telefona, generisanje ugovora.
- `kadrovska.grid_edit` — mesečni grid = `can_edit_kadrovska_grid()` (DB allowlist `kadr_grid_editor_allowlist`).
- `kadrovska.vacation_edit` — saldo GO = `can_edit_vacation_balance()` (DB allowlist `kadr_vacation_editor_allowlist`).
- `kadrovska.vacreq_manage` — odobravanje GO/nadoknada/plaćeno = `current_user_can_manage_vacreq()` (role set); row-scope kroz `managed_sub_department_ids`.
- `kadrovska.vacreq_admin` — finalni vacreq admin = `current_user_is_vacreq_admin()` (**SAMO Zoran**).
- `kadrovska.attendance` — prisustvo Uživo = `canSeePrisustvo` (hr ∨ adminOrMenadzment ∨ gridEditor);
  `kadrovska.attendance_shadow` — poređenje sa gridom + QR nalepnice = `canSeeShadow` (hr ∨ adminOrMenadzment).
- `kadrovska.salary` — **SAMO admin** (`canAccessSalary`; HR namerno nema). Cela Zarade grupa.
- `kadrovska.dev_manage` — razvoj/razgovori/360 menadžer = `manages_dev_plan/can_manage_talk/can_manage_assessment`
  (row-scope u DB; **niko o sebi** — assessment guard).

### 2.5 Mapiranje 3 email allowliste → per-user override (traženo zadatkom)

| 1.0 konstanta (front) | DB backing | 2.0 predlog |
|---|---|---|
| `KADROVSKA_GRID_EDITOR_EMAILS` | **DB tabela `kadr_grid_editor_allowlist`** (5, iza `can_edit_kadrovska_grid`) | per-user override **`kadrovska.grid_edit`** (grant). Izvor istine ostaje DB allowlist (GUC čuva `can_edit_kadrovska_grid` besplatno); „Grid urednici" ekran (Talas D) piše OBA — sy15 allowlist + 2.0 override. **NE hardkodovati mejlove.** |
| `KADROVSKA_VACATION_EDITOR_EMAILS` | **DB tabela `kadr_vacation_editor_allowlist`** (4, iza `can_edit_vacation_balance`) | per-user override **`kadrovska.vacation_edit`** (grant); isti dvostrani obrazac; dodati „Urednici salda GO" ekran (paran „Grid urednicima") |
| `KADROVSKA_VACREQ_MANAGER_EMAILS` | **samo front konstanta** — DB koristi role-based `current_user_can_manage_vacreq` + Zoran hardkod | non-role menadžeri → per-user override **`kadrovska.vacreq_manage`** (grant); Zoran (`vacreq_admin`) → named override **`kadrovska.vacreq_admin`** (grant). DB fn `current_user_is_vacreq_admin` OSTAJE hardkod za 1.0 paritet dok se tab ne preklopi (§7.2) |

**Lekcija (doktrina §C):** grid/vacation editori su **VEĆ DB-tabela-vođeni** (ne puke konstante) — front konstante su
UI ogledalo. 2.0 ne sme da ih „pojednostavi" u statičku listu; migracija = kopiraj redove tabele u override + zadrži tabelu.

### 2.6 Skrivena pravila firme (doktrina §C — NE gubiti!)

1. **GO grid-kanon.** `v_vacation_balance` računa saldo **ISKLJUČIVO iz grida** (work_hours GO dani), NE iz zbira zahteva.
   `opening` sme samo NE-grid dane (inače duplo). Svi approve/reschedule/revise/rollover **pišu u grid** (`kadr_grid_set_go`/`unset_go`).
   „Preostalo" = zarađeno DO DANAS (srazmerno, akrual model — NE pun fond). 2.0 NE preračunava saldo — čita view.
2. **work_hours vs absences dualizam.** Grid (`work_hours`) i `absences` NISU auto-sinhronizovani; payroll čita **samo grid**.
   `applyAbsencePeriodToGrid` je jednosmerni upis odsustva u grid. Bolovanje živi na dva mesta — ne „ujednačavati" usput.
3. **Zarade immutability + admin-only.** `salary_terms`/`salary_payroll` = `current_user_is_admin()` na sve 4 op;
   `salary_payroll_immutability_check` blokira izmenu zaključanog obračuna (`kadr_payroll_unlock` da bi se otključalo);
   `salary_terms_close_previous` verzioniše uslove (zatvara prethodni period). Engine (`payrollCalc.js` BOLOVANJE 65%/100%,
   fond, payment windows + `salaryTax.js` grossToNet/netToGross po godinama) = **klijentski, port u BE R2**.
4. **PII maska.** Front NIKAD ne SELECT-uje `employees` za prikaz — samo `v_employees_safe`. PII tabele + osetljiva polja
   kroz `current_user_can_manage_employee_pii()` = **admin ∨ poslovni_admin** (HR ih ne vidi). `employees_sensitive_guard`
   trigger dodatno štiti osetljive kolone pri UPDATE-u.
5. **`kadr_notification_log` INSERT samo kroz DEFINER.** Nijedna klijentska INSERT politika ne postoji — upis ide
   ISKLJUČIVO kroz `kadr_queue_*`/`kadr_schedule_*` SECURITY DEFINER fn. 2.0 poziva iste fn kroz GUC.
6. **`kadr_notif_type_chk` CHECK.** `kadr_notification_log.notification_type` ima CHECK listu — **svaki nov tip mejla
   MORA prvo u CHECK** inače upis tiho pada. 2.0 ne uvodi nove tipove bez migracije CHECK-a.
7. **`employee_documents.doc_type` CHECK drift.** Nov `docType` mora i u CHECK — inače insert tiho pada. Zadržati listu.
8. **`employees` = izvor istine** za celu firmu; `worker_employee_map` je most ka 2.0 radnicima (§1.5, drift). Kadrovska
   je jedini vlasnik CRUD-a; ostali moduli čitaju.
9. **Neplaćeno (nop) = samo admin.** `nop_requests` UPDATE/DELETE admin; `approve_nop_request` upisuje `nop` u work_hours
   i nuluje sate; work_hours `nop` code sme samo admin (i kroz grid).
10. **Vacreq admin = SAMO Zoran** (hardkod u `current_user_is_vacreq_admin`); pun GO menadžer. Ne širiti bez odluke.
11. **Bonus GO** (`kadr_grant_bonus_go`) = vikend/prekovremeni → `vacation_bonus_days`; storno nadoknade vraća −1 GO.
12. **Attendance jednosmeran tok.** `attendance_events` puni SAMO bridge(Katze) + kiosk; front samo čita kroz view-ove;
    korekcije idu u `attendance_corrections` (obrazloženje obavezno, važenje 3 dana, mejl šefu). Kiosk barijera = deljena
    tajna uređaja (`x-kiosk-key`); anon key je javan i NIJE zaštita.
13. **Razgovori tok** nacrt→podeljen→potvrdjen: zaposleni vidi tek `podeljen/potvrdjen`; DELETE samo admin ∨ (manage ∧ `nacrt`).
    Korektivne mere sa eskalacijom (cron 07:30). Novi mejl tip → CHECK (pravilo 6).
14. **360: niko o sebi.** `current_user_can_manage_assessment` eksplicitno `emp ≠ ja`; rezultati vidljivi zaposlenom tek
    kad `visible_to_employee`. Rater piše samo dok je `status='collecting'`.
15. **Optimistic lock** na `hr_update_employee` (updated_at) i `hr_upsert_salary_payroll` (V2) — 2.0 mapira konflikt → 409.
16. **Praznici** (`kadr_holidays`, 36) čitaju svi (grid ih boji), piše admin; DST guard u attendance cron poslovima (dupli UTC4/UTC5).
17. **`safeupdate` zamka** (WHERE-less u DEFINER RPC) — `pg_safeupdate` obara WHERE-less UPDATE; postojeći RPC-ovi imaju
    `WHERE true` gde treba — NE dirati.
18. **`kadr_grid_set_go`/`unset_go` su DEFINER bez sopstvenog auth gejta** (oslanjaju se na pozivaoca) — 2.0 ih zove tek
    posle `kadrovska.grid_edit`/`vacreq_manage` provere na endpointu.

## 3. API (predlog, `/api/v1/kadrovska/*`) — po 5 hub-grupa

Sve mutacije kroz `Sy15Service.withUserRls` (GUC `sub`+`email` + `SET LOCAL ROLE authenticated`); **idempotencija**:
modul nema svoj mehanizam → `rev_api_idempotency` obrazac (`clientEventId`) na svim mutacijama (doktrina A4).
FE fine-gating kroz `GET /kadrovska/me` (server računa `{isHr, isAdmin, poslovniAdmin, canManageVacreq, vacreqAdmin,
gridEditor, vacationEditor, canPii, canSalary, managedSubDeptIds}` iz GUC upita) — paritet 1.0 `auth.js`/`shared.js` gejtova.

### 3.1 Pregled (dashboard + izveštaji + notifikacije) — `kadrovska.read`

| Endpoint | Metod | Permisija | 1.0 poreklo |
|---|---|---|---|
| `/kadrovska/me` | GET | read | efektivna prava (gore) |
| `/kadrovska/dashboard` | GET | read | `kadr_dashboard_kpis` + `mini_reports` + `action_stack` (1 poziv umesto 3) |
| `/kadrovska/reports/:kind` | GET | read (PII izveštaji `pii`, audit `admin`) | 11 izveštaja (sick/demo/org/vacation/overtime/field/medical/certs/children/risk/audit); XLSX/CSV u BE ili FE |
| `/kadrovska/reports/risk/run` | POST | manage | `kadr_trigger_weekly_risk_summary` (ručni okid) |
| `/kadrovska/notifications` (+`/:id/retry`,`/cancel`,`/delete`) | GET/POST/DELETE | manage | `kadr_notification_log` read + config; `kadr_trigger_schedule_hr_reminders`, `kadr_queue_payroll_notifications`; retarget priloga knjigovođi |
| `/kadrovska/notification-config` | GET/PATCH | manage | singleton |

### 3.2 Odmori (GO + zahtevi/odobravanja + odsustva/kalendar) — `kadrovska.read`/`.vacreq_manage`/`.vacation_edit`

| Endpoint | Metod | Permisija | 1.0 poreklo |
|---|---|---|---|
| `/kadrovska/vacation/balance` · `/history` | GET | read (row-scope) | `v_vacation_balance` (grid-kanon!), `vacation_history` |
| `/kadrovska/vacation/entitlements` (+akrual/korekcija/avans) | GET/POST/PATCH | vacation_edit | saveEntitlement, `hr_correct_vacation_balance`, `hr_set_advance_approval` |
| `/kadrovska/vacation/rollover` | POST | vacation_edit/admin | `hr_rollover_year` |
| `/kadrovska/vacation/bonus` | POST | vacreq_manage | `kadr_grant_bonus_go` |
| `/kadrovska/vacation/decision-pdf` · `/record-pdf` | GET | pii (rešenje admin/poslovni_admin) | Rešenje o GO PDF; A4 Evidencija GO (upload + `kadr_queue_document_email`) |
| `/kadrovska/requests` (jedinstveni inbox 4 izvora) | GET | vacreq_manage (row-scope) | vacation_requests + makeup + paid_leave + nop |
| `/kadrovska/requests/vacation/:id/{approve,vacreq-approve,reject,reschedule,revise,cancel,delete}` | POST | vacreq_manage (finalizacija hr/admin) | `hr_approve_vacation_request`, `hr_vacreq_approve`, `hr_reject/reschedule/revise/cancel/delete_vacation_request` + `kadr_queue_vacation_notification` |
| `/kadrovska/requests/makeup/:id/{approve,reject,complete,storno,delete}` | POST | vacreq_manage | `makeup_approve/reject/complete`, `kadr_storno_makeup` (↩−1 GO), `kadr_delete_makeup` + queue |
| `/kadrovska/requests/paid-leave/:id/{approve,reject,delete}` | POST | vacreq_manage | `paid_leave_approve/reject/delete` + queue |
| `/kadrovska/requests/nop/:id/{approve,reject}` | POST | **admin** | `approve_nop_request`/`reject_nop_request` (upis nop u grid) |
| `/kadrovska/absences` (+CRUD, apply-to-grid) | GET/POST/PATCH/DELETE | edit (grid) | odsustva + `applyAbsencePeriodToGrid`; `neplaceno` admin |
| `/kadrovska/absences/overview` · `/calendar` · `/absent-now` | GET | read (pregled) | pivot 15 kolona + Excel; mesečni kalendar; roster odsutnih |

### 3.3 Sati (mesečni grid + sati pojedinačno + prisustvo) — `kadrovska.grid_edit`/`.attendance`

| Endpoint | Metod | Permisija | 1.0 poreklo |
|---|---|---|---|
| `/kadrovska/grid?month=` | GET | read (row-scope) | work_hours + praznici + primedbe + audit |
| `/kadrovska/grid/batch` · `/confirm` · `/lock` | POST | grid_edit | `hr_upsert_work_hours_batch` + confirm + `gridMonthLock` |
| `/kadrovska/grid/go` (set/unset) | POST | grid_edit/vacreq | `kadr_grid_set_go`/`kadr_grid_unset_go` |
| `/kadrovska/grid/audit` (+revert „↩ Vrati") | GET/POST | grid_edit | `kadr_work_hours_audit` istorija |
| `/kadrovska/grid/link-predmet` | POST | grid_edit | desni klik → `searchBigtehnItems` (Talas C cache) |
| `/kadrovska/grid/karnet.pdf` · `/karnet/generate` | GET/POST | grid_edit | Karnet PDF + `generateAndStoreMonthKarnete` |
| `/kadrovska/work-hours` (+CRUD) | GET/POST/PATCH/DELETE | grid_edit | pojedinačni + `kadr_queue_payroll_notifications` |
| `/kadrovska/attendance/now` (auto 60s) | GET | attendance | `v_attendance_now` |
| `/kadrovska/attendance/shadow` · `/vs-grid` | GET | attendance_shadow | `v_attendance_shadow_monthly`, `v_attendance_vs_grid` |
| `/kadrovska/attendance/daily?emp=&range=` · `/events` | GET | read (own) / attendance | `v_attendance_daily`, `attendance_events` |
| `/kadrovska/attendance/corrections` (+cancel) | GET/POST | own/manage | `attendance_submit_correction`/`attendance_cancel_correction` |
| `/kadrovska/attendance/extra-recipients` | GET/POST | manage | `attendance_notify_extra` |
| `/kadrovska/badges/qr.pdf` | GET | attendance_shadow | employee_badges get-or-create + jsPDF/qrcode 2×5 A4 |
| `/kadrovska/kiosk/punch` | POST(edge) | **kiosk-key** | edge `kiosk-punch` (pozadina; UI se seli) |

### 3.4 Zaposleni (zaposleni + ugovori + imenik + uvođenje + razvoj) — `kadrovska.read`/`.pii`/`.manage`/`.dev_manage`

| Endpoint | Metod | Permisija | 1.0 poreklo |
|---|---|---|---|
| `/kadrovska/employees` (+`/:id`) | GET | read (v_employees_safe) | lista/karton; PII polja kroz `pii` |
| `/kadrovska/employees` (+`/:id`) | POST/PATCH | edit/pii | `hr_update_employee` (optimistic lock); insert admin/hr/poslovni_admin |
| `/kadrovska/employees/:id/{deactivate,purge}` | POST/DELETE | edit/admin | deaktivacija; admin purge |
| `/kadrovska/employees/bulk-import` | POST | pii | Excel/CSV (JMBG validacija) |
| `/kadrovska/employees/docs/generate-zip` | POST | pii | masovno generisanje dokumenata ZIP |
| `/kadrovska/employees/:id/pdf/:kind` | GET | pii | Potvrda zaposlenju/zaradi, Aneks, Porodiljsko, Sporazumni raskid (ćirilica) |
| `/kadrovska/employees/:id/{children,bank-cards,foreign-docs,personal-docs}` | GET/POST/PATCH/DELETE | pii | PII tabele |
| `/kadrovska/employees/:id/documents` (+storage proxy) | GET/POST/DELETE | pii | employee_documents + `employee-docs` bucket; `kadr_queue_document_email` |
| `/kadrovska/medical-exams` · `/certificates` (+CRUD) | GET/POST/PATCH/DELETE | manage/poslovni_admin | kadr_medical_exams/kadr_certificates + view statusi |
| `/kadrovska/contracts` (+CRUD, archive/restore) | GET/POST/PATCH | contracts_read/edit | contractsTab; `kadr_get_contract_bruto`/`kadr_get_contract_salary`/`kadr_set_contract_salary`; 📑 Ugovor PDF → upload |
| `/kadrovska/directory` | GET/PATCH | read (unos = pii) | imenik tel/WhatsApp/vCard; inline telefon → `hr_update_employee` |
| `/kadrovska/onboarding` (+templates, start) | GET/POST | manage | `kadr_onboarding_start`; REVERSI zaduženja panel pri izlasku |
| `/kadrovska/dev-plans` (+checkins) | GET/POST/PATCH | dev_manage/self | development_* (self + mgr) |
| `/kadrovska/expectations` | GET/POST/PATCH | dev_manage (D ekran) | employee_expectations (self status u_toku/ispunjeno) |
| `/kadrovska/talks` (+share/unshare/acknowledge, measures) | GET/POST | dev_manage/self | employee_talks, corrective_*; `talk_share/unshare/acknowledge`; STT+AI refine |
| `/kadrovska/assessments/360` (open/targets/compute/gap/share/unshare/close/reopen/state) | POST | dev_manage | `assessment_open_360/set_targets/compute_results/gap_to_goals/share/unshare/close/reopen/set_state` + PDF radar |
| `/kadrovska/assessments/campaign` | POST | manage (org_profile) | `assessment_open_campaign` |
| `/kadrovska/assessments/self` (open/submit) | GET/POST | self | `assessment_open_self`/`assessment_self_submit` (deljeno sa Moj profil/D) |
| `/kadrovska/assessments/token/:t` | GET/POST | token (edge) | `assessment_token_context`/`assessment_submit_by_token` (ocena.html; pozadina) |

### 3.5 Zarade (SAMO admin) — `kadrovska.salary`

| Endpoint | Metod | Permisija | 1.0 poreklo |
|---|---|---|---|
| `/kadrovska/salary/terms` (+CRUD) | GET/POST/PATCH/DELETE | **salary (admin)** | salary_terms; comp modeli (fiksno/dva_dela/satnica/jednokratno/praksa); `close_previous` versioning |
| `/kadrovska/salary/current` | GET | salary | `v_employee_current_salary` |
| `/kadrovska/salary/payroll/init` | POST | salary | `kadr_payroll_init_month` |
| `/kadrovska/salary/payroll?month=` | GET | salary | `v_salary_payroll_month`; recompute iz grida + karnete (engine u BE) |
| `/kadrovska/salary/payroll/upsert` | POST | salary | `hr_upsert_salary_payroll` (V2 optimistic) |
| `/kadrovska/salary/payroll/{lock,unlock}` | POST | salary | 🔒 zaključavanje / `kadr_payroll_unlock` (immutability guard) |
| `/kadrovska/salary/payslip/:empId.pdf` · `/bulk` | GET | salary | payslip PDF pojedinačno/bulk |
| `/kadrovska/salary/accountant-tables` | GET | salary | tabele za knjigovođu → PDF po grupama + email retarget |

## 4. FE (Next) — `/kadrovska` pod nav domenom **👥 LJUDI / KADROVSKA**

HUB landing (5 pločica) → 15 tabova (paritet 1.0 `KADR_TAB_DEFS`; 2.0 ui-kit; responsive):

**Grupa Pregled:** 1. **Pregled** (dashboard KPI + Chart.js 3 grafikona + deep-link akcije) · 2. **Izveštaji**
(11 izveštaja, XLSX/CSV, PII gate) · 3. **Notifikacije** (queue UI + config modal + retry/cancel/delete).

**Grupa Odmori:** 4. **Godišnji odmor** (stat kartice, Gantt po odeljenjima, Excel, akrual/avans/korekcija modal,
Rešenje o GO PDF + A4 Evidencija GO) · 5. **Zahtevi/Odobravanja** (jedinstveni inbox 4 izvora; scope + finalizacija) ·
6. **Odsustva/Kalendar** (CRUD + apply-to-grid, pivot 15 kolona, mesečni kalendar read-only, roster odsutnih).

**Grupa Sati:** 7. **Mesečni grid** (batch upsert + confirm + lock banner + primedbe + NOP + teren grupni unos +
istorija „↩ Vrati" + **realtime subscribe** + veži predmet + Karnet PDF) · 8. **Sati pojedinačno** · 9. **Prisustvo**
(Uživo auto 60s + Poređenje sa gridom shadow + QR nalepnice PDF + korekcije).

**Grupa Zaposleni:** 10. **Zaposleni** (CRUD + deaktivacija + admin purge + bulk import + ZIP dokumenata + PDF
generatori ćirilica + medical/certs) · 11. **Ugovori** (forma cela stranica + PDF rešenje + 📑 Ugovor o radu + netToGross)
· 12. **Imenik** (tel/WhatsApp/vCard) · 13. **Uvođenje/Izlazak** (šabloni + tokovi + REVERSI zaduženja) · 14. **Plan
razvoja** (IRP + check-ins; razgovori nacrt→podeli→„Upoznat sam" + mere; 360 + PDF radar).

**Grupa Zarade (SAMO admin):** 15. **Zarade** (uslovi zarade + comp modeli; mesečni obračun init/recompute/upsert/lock;
payslip PDF; knjigovođa tabele; engine payrollCalc + salaryTax).

**Mobilno** (`/m/*` paritet, 2.0 responsive):
- `/m/kadrovska` (read-only pregled: v_employees_safe/contracts/absences/grid) · `/m/odsustva` (GO zahtev, saldo re-provera) ·
  `/m/odobravanja` (odobravanja + scope) · `/m/sati` (grid + primedbe + očekivanja) · `/m/profil` (own-read).
- ⚠️ **GAP „Moje prisustvo"**: 1.0 nema mobilni ekran (samo desktop /moj-profil `prisustvoCard`) → **novi 2.0 ekran
  `/m/prisustvo`** (dnevni pregled `v_attendance_daily` + eventi + podnošenje korekcije) — kandidat za 2.0 v1 (§7.6).

Skener: QR nalepnice zaposlenih (kioskQrAdmin) = generisanje (jsPDF+qrcode), NE sken. Kiosk `/kiosk` je zaseban terminal ekran.

## 5. Parity matrica (doktrina B — status se ažurira TOKOM rada; puni se iz UI inventara 15 tabova)

| # | Funkcija | Status |
|---|---|---|
| 1 | `/kadrovska/me` (efektivna prava; FE gating paritet auth.js+shared.js) | NOT_STARTED |
| **Pregled** | | |
| 2 | Dashboard: KPI + 3 Chart.js grafikona + action stack + deep-link | NOT_STARTED |
| 3 | Izveštaji: 11 vrsta (sick/demo/org/vacation/overtime/field/medical/certs/children/risk/audit) + XLSX/CSV | NOT_STARTED |
| 4 | Izveštaji PII/audit gating (canViewEmployeePii / isAdmin) | NOT_STARTED |
| 5 | Notifikacije: queue UI + config + retry/cancel/delete + risk/hr-reminders ručni okid | NOT_STARTED |
| **Odmori** | | |
| 6 | GO: stat kartice + Gantt po odeljenjima + Excel | NOT_STARTED |
| 7 | GO akrual (saveEntitlement) + avans (`hr_set_advance_approval`) + korekcija (`hr_correct_vacation_balance`) | NOT_STARTED |
| 8 | GO grid-kanon: v_vacation_balance read-only paritet (saldo iz grida) | NOT_STARTED |
| 9 | Rešenje o GO PDF + A4 Evidencija GO (upload + queue mejl) | NOT_STARTED |
| 10 | `hr_rollover_year` (prenos godine) + bonus GO (`kadr_grant_bonus_go`) | NOT_STARTED |
| 11 | Jedinstveni inbox 4 izvora (vacation/makeup/paid_leave/nop) + scope | NOT_STARTED |
| 12 | GO zahtevi: approve/vacreq-approve/reject/reschedule/revise/cancel/delete + queue mejl | NOT_STARTED |
| 13 | Nadoknada: approve/reject/complete/storno(↩−1 GO)/delete | NOT_STARTED |
| 14 | Plaćeno odsustvo: approve/reject/delete | NOT_STARTED |
| 15 | Neplaćeno (nop): approve/reject — **samo admin** + upis nop u grid | NOT_STARTED |
| 16 | Odsustva CRUD + apply-to-grid + `neplaceno` admin guard | NOT_STARTED |
| 17 | Odsustva pregled (pivot 15 kolona + Excel) + kalendar + roster odsutnih | NOT_STARTED |
| **Sati** | | |
| 18 | Mesečni grid: batch upsert (`hr_upsert_work_hours_batch`) + confirm + lock banner | NOT_STARTED |
| 19 | Grid: primedbe resolve + NOP + teren grupni unos + veži predmet | NOT_STARTED |
| 20 | Grid: istorija audit + „↩ Vrati" + **realtime subscribe** | NOT_STARTED |
| 21 | Grid GO set/unset (`kadr_grid_set_go`/`unset_go`) | NOT_STARTED |
| 22 | Karnet PDF + `generateAndStoreMonthKarnete` | NOT_STARTED |
| 23 | Sati pojedinačno CRUD + `queuePayrollNotifications` | NOT_STARTED |
| 24 | Prisustvo Uživo (v_attendance_now, auto 60s) | NOT_STARTED |
| 25 | Prisustvo poređenje sa gridom (shadow) + vs-grid | NOT_STARTED |
| 26 | QR nalepnice PDF (employee_badges 2×5 A4) | NOT_STARTED |
| 27 | Korekcije prisustva (submit/cancel; obrazloženje, 3 dana, mejl šefu) + dopunski primaoci | NOT_STARTED |
| 28 | Kiosk ekran `/kiosk` (fetch ka edge kiosk-punch; x-kiosk-key) | NOT_STARTED |
| **Zaposleni** | | |
| 29 | Zaposleni lista/karton (v_employees_safe) + slojevito PII otkrivanje | NOT_STARTED |
| 30 | CRUD (`hr_update_employee` optimistic) + deaktivacija + admin purge | NOT_STARTED |
| 31 | Bulk import Excel/CSV (JMBG validacija) | NOT_STARTED |
| 32 | Masovno generisanje dokumenata ZIP | NOT_STARTED |
| 33 | PDF generatori ćirilica (Potvrda zaposlenju/zaradi, Aneks, Porodiljsko, Sporazumni raskid) | NOT_STARTED |
| 34 | PII tabele: deca/bank kartice/strani/lični dokumenti (can_manage_employee_pii) | NOT_STARTED |
| 35 | employee_documents + storage proxy (`employee-docs`) + `kadr_queue_document_email` | NOT_STARTED |
| 36 | Medical exams + certificates CRUD + view statusi + istek → mejl | NOT_STARTED |
| 37 | Ugovori CRUD + arhiva + PDF rešenje + 📑 Ugovor o radu (netToGross `kadr_get_contract_bruto`) | NOT_STARTED |
| 38 | Imenik (tel/WhatsApp/vCard + izvoz svih) + inline telefon (pii unos) | NOT_STARTED |
| 39 | Uvođenje/Izlazak (šabloni + `kadr_onboarding_start` + REVERSI zaduženja panel) | NOT_STARTED |
| 40 | Plan razvoja (IRP + check-ins; self + mgr scope) + očekivanja (self status) | NOT_STARTED |
| 41 | Razgovori (nacrt→podeli→„Upoznat sam" + mere + STT/AI refine + share/unshare) | NOT_STARTED |
| 42 | 360 (open/targets/compute/gap/share/close/reopen/state) + PDF radar; niko o sebi | NOT_STARTED |
| 43 | 360 samoprocena (self open/submit) + token flow (ocena.html — pozadina paritet) | NOT_STARTED |
| **Zarade (admin)** | | |
| 44 | Uslovi zarade (salary_terms CRUD, comp modeli, close_previous versioning) | NOT_STARTED |
| 45 | Payroll init/recompute iz grida+karnete (engine payrollCalc + salaryTax port) | NOT_STARTED |
| 46 | Payroll upsert V2 optimistic + lock/unlock + immutability guard | NOT_STARTED |
| 47 | Payslip PDF pojedinačno/bulk + knjigovođa tabele + email retarget | NOT_STARTED |
| **Presek** | | |
| 48 | GUC `withUserRls` (sub+email + SET ROLE) na CELOJ HR površini (row-scope maske) | NOT_STARTED |
| 49 | PII maska paritet (v_employees_safe, HR ne vidi PII/zarade) | NOT_STARTED |
| 50 | Queue-okidači kroz DEFINER (kadr_queue_*; INSERT log deny) + kadr_notif_type_chk CHECK | NOT_STARTED |
| 51 | Idempotencija mutacija (clientEventId / rev_api_idempotency) | NOT_STARTED |
| 52 | Email allowliste → per-user override (grid_edit/vacation_edit/vacreq_manage/vacreq_admin) migracija | NOT_STARTED |
| 53 | e2e permission matrica (rola × override × endpoint × 200/403; AUTHZ_ENFORCE=true) | NOT_STARTED |
| 54 | Mobilni 5 ekrana + NOVI „Moje prisustvo" (`/m/prisustvo`) | NOT_STARTED |
| 55 | Živi smoke: pun ciklus (zaposleni → grid unos → GO zahtev → odobravanje → saldo iz grida → payroll → payslip) | NOT_STARTED |

## 6. Redosled izvođenja (R-faze za CEO talas)

| Faza | Šta | Gate |
|---|---|---|
| R0 | Nenadov review + presuda §7; **re-verifikacija snapshota na živoj sy15** (fn dif, 141 politika, `worker_employee_map` postoji?, allowlist tabele, dispatch fns); grants za `servosync2_app` (SELECT+write na ~40 HR tabele po §2, SELECT na 14 view-ova + osnovne tabele, EXECUTE na ~60 front RPC, SELECT deljene D tabele + `bigtehn` cache za veži-predmet + `employees` za druge module; **kao `supabase_admin`**) | odobreno |
| R1 | BE read: Prisma modeli (§1) + `/me` + svi GET (5 hub-grupa) + `kadrovska.*` permisije + override data-migracija (matrica #52) + e2e read matrica (self/manages/PII maska/salary-admin) | read paritet |
| R2 | BE mutacije: REST-paritet upisi kroz `withUserRls` + ~60 RPC endpointa + storage proxy + queue-okidači + idempotencija; e2e write matrica + verifikacija trigera (audit, no_overlap, immutability, sync) | write paritet |
| R3a | FE: Pregled (dashboard/izveštaji/notifikacije) + Odmori (GO/zahtevi/odsustva) — najveća grupa + grid-kanon | Odmori UI |
| R3b | FE: Sati (grid realtime + prisustvo + kiosk) + Zaposleni (employees/PII/ugovori/imenik) | jezgro UI |
| R3c | FE: Uvođenje + Plan razvoja (360/razgovori) + **Zarade** (payroll engine port) + svi PDF generatori (ćirilica) | ostatak UI |
| R4 | Mobilni 5 ekrana + „Moje prisustvo" + živi smoke (pun ciklus #55) + Playwright happy-path + paralelni rad 1.0/2.0 → hub preklop | parity gate (doktrina D) |
| R5 | Retrospektiva tempa → ažurirati `PROCENA_SEOBE_MODULA_3.0.md` | kalibracija |

**Procena (MN, kalibracija Reversi=1):** gruba planska bila je **6–9 MN**; posle merenja predlažem **8.5–11 MN**
(najveći modul: 25.8k UI, 60 fajlova, PII+zarade+PDF ćirilica). Podela po 5 hub-grupa:

| Hub-grupa | MN | Nosioci obima |
|---|---:|---|
| Pregled | ~1 | 11 izveštaja XLSX/CSV, 3 dashboard RPC, notif queue |
| Odmori | ~2–2.5 | GO grid-kanon, 4-izvorni inbox, Gantt, akrual/avans/korekcija, Rešenje+Evidencija PDF, rollover |
| Sati | ~1.5–2 | grid batch+realtime+lock+audit undo+teren, karnet PDF, prisustvo live/shadow/QR/korekcije, kiosk |
| Zaposleni | ~2–2.5 | PII slojevi, bulk import, ZIP+PDF generatori ćirilica, medical/certs, ugovori netToGross, onboarding, 360/razgovori |
| Zarade | ~1.5–2 | payroll engine (payrollCalc+salaryTax) port, immutability, payslip PDF, comp modeli, knjigovođa |
| Presek (GUC/e2e/override/mobilni) | ~0.5–1 | withUserRls cela površina, override migracija, mobilni 5+1 |

Authz rizik **srednji** (GUC most čuva 141 politiku po konstrukciji, ALI cela površina traži `withUserRls` — BYPASSRLS
put probija PII maske; row-scope je gust). Najveći tehnički rizici: (1) `withUserRls` disciplina na SVAKOJ ruti,
(2) payroll engine port (finansijski tačan), (3) PDF ćirilica generatori, (4) storage proxy za PII, (5) GO grid-kanon
(saldo se NE preračunava — samo čita view; svaka „optimizacija" lomi kanon).

## 7. Otvorena pitanja (Nenad presuđuje; svako sa konkretnim predlogom)

1. **Usklađivanje ključa pristupa modulu sa Talasom D.** D je uveo per-user override `kadrovska.access` (grant,
   za 1.0 `kadrovska_access`), a ovaj spec kao kanon predlaže `kadrovska.read`. **Predlog:** kanon je **`kadrovska.read`**
   (bazni pristup = `canAccessKadrovska`); D-override preimenovati/aliasovati u `kadrovska.read` (grant) da postoji JEDAN
   ključ. `kadrovska.contracts_read` ostaje kako ga je D već uveo (deny za `kadrovska_hide_contracts`). Uskladiti u
   `role-permissions.ts` pre nego što oba talasa krenu.
2. **Vacreq admin = hardkodovan Zoran u DB fn.** `current_user_is_vacreq_admin()` ima literal
   `zoran.jarakovic@servoteh.com`. **Predlog:** DB fn OSTAJE (1.0 paritet, ne dirati do gašenja 1.0); u 2.0 dodati named
   per-user override `kadrovska.vacreq_admin` (grant) za Zorana i gejtovati UI po njemu; kad se tab preklopi, 2.0 je izvor.
   Isto važi za grid/vacation editor allowliste — **migrirati redove DB tabela u override, NE hardkodovati mejlove**.
3. **Payroll engine (payrollCalc.js + salaryTax.js) — gde živi u 2.0?** Klijentski JS računa BOLOVANJE 65%/100%, fond,
   payment windows, grossToNet/netToGross po godinama. **Predlog:** portovati u **BE servis** (`salary/*` endpointi ga
   pozivaju) — finansijska logika ne sme ostati u pretraživaču; zadržati identične formule i granice po godinama (bez
   „modernizacije"); dodati zlatne testove (poznati ulaz→izlaz) pre porta. Rizik: godišnje tablice poreza — proveriti da su sve u kodu.
4. **`worker_employee_map` drift.** Most `employees`↔2.0 radnici ne postoji u cloud snapshotu (postoji na self-host sy15).
   **Predlog:** R0 re-verifikacija na živoj sy15; ako Reversi/2.0 već drži most (bedževi 89+68 iz memorije), G ga NE duplira —
   samo čita `employees` kao izvor istine; ako ne postoji, dodati ga kao 2.0-side tabelu van G obima.
5. **Storage proxy za PII (`employee-docs`).** RLS zavisi od `current_user_can_manage_employee_pii()` kroz GUC, ali
   upload/sign/delete traže service kontekst koji 2.0 BE nema kao supabase klijent. **Predlog:** isti obrazac kao Talas F §7.4
   — BE kroz `withUserRls` proveri PII pravo nad meta-redom (`employee_documents`), pa izvrši storage op service kredencijalom
   na sy15 storage-api; putanje 1.0-kompatibilne. Isto za PDF evidencije/ugovore koji idu na mejl.
6. **„Moje prisustvo" mobilni gap.** 1.0 nema mobilni ekran (samo desktop profil kartica). **Predlog:** dodati novi
   `/m/prisustvo` u 2.0 v1 (dnevni pregled + eventi + podnošenje korekcije) — svesno proširenje (bolje od 1.0), ne menja RLS;
   koristi postojeći `attendance_submit_correction`. Alternativa: izostaviti iz v1 i pratiti desktop paritet — Nenad bira.
7. **Deljeni objekti sa Talasom D (Moj profil).** D preuzima ceo profil kroz GUC (D §7 P6 usvojeno). **Predlog:** G se
   obavezuje da **NE menja potpise** deljenih RPC (`hr_revise/cancel/delete_vacation_request`, `attendance_submit_correction`,
   `kadr_delete_makeup`, `paid_leave_delete`, `talk_acknowledge`, `assessment_open_self/self_submit`, `kadr_queue_*`) —
   svaka „popravka" HR RPC-a van je obima G dok se profil ne migrira; G dodaje samo menadžersku stranu (approve/manage).
8. **Grid/vacation editor ekrani — D ili G?** „Grid urednici" allowlist ekran je Talas D (Podešavanja). „Urednici salda GO"
   (`kadr_vacation_editor_allowlist`) nema ekran u 1.0 (uređuje se DB-om). **Predlog:** oba allowlist ekrana u 2.0 **Podešavanja
   (Talas D)** radi konzistentnosti RBAC konzole; G ih samo KONZUMIRA kroz `kadrovska.grid_edit`/`vacation_edit`. Dodati „Urednici
   salda GO" kao paran ekran „Grid urednicima".
9. **Notifikacije: oživljavanje dispatcha nije deo parity gate-a.** `hr-notify-dispatch` radi (za razliku od maint) — ali
   je pozadina. **Predlog:** seliti SAMO paritet (čitanje log-a + config + retry/cancel + ručni okidači `kadr_trigger_*`);
   dispatch/push/WhatsApp isporuka OSTAJE 1.0 pozadina (edge + cron */5) do finalnog 3.0 cutover-a; 2.0 ne duplira slanje.
10. **`kadr_notif_type_chk` i `employee_documents.doc_type` CHECK-ovi.** Oba tiho obaraju upis novog tipa. **Predlog:**
    2.0 NE uvodi nove tipove mejla/dokumenta tokom seobe (doktrina §C); ako zatreba, prvo migracija CHECK-a u 1.0 repo,
    pa upotreba — dokumentovati kao odstupanje, ne tiha izmena.
11. **Attendance events volumen (480k redova, raste ~10min).** Čitanje kroz view-ove je OK, ali izveštaji nad sirovim
    events-ima mogu biti spori kroz GUC. **Predlog:** zadržati view-only pristup; ako izveštaj traži agregat, dodati
    materijalizovani view ili BE keš U DOGOVORU (ne tokom seobe); jednosmerni upis (bridge+kiosk) se NE dira.

---

**Sažetak procene:** Talas G je najveći i poslednji — **8.5–11 MN** (iznad grube 6–9 zbog obima UI-ja, PII, zarada i
PDF ćirilice), ali authz rizik je srednji jer GUC most + `withUserRls` čuvaju svih 141 politiku i obe maske
(PII, zarade) po konstrukciji. Ključna disciplina izvršilaca: `withUserRls` na SVAKOJ ruti, GO grid-kanon netaknut,
payroll engine port sa zlatnim testovima, i NE diranje deljenih Moj-profil RPC-ova.
