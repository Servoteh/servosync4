# Talas G (Kadrovska) — RADNA BELEŠKA: pozadinska infrastruktura (delimična analiza, 12.07)

> Spec-agent za Talas G je zaustavljen pre završetka; ovo je sačuvan nalaz njegove
> pod-analize (edge fn + notifikacije + prisustvo). Ugraditi u budući
> `MODULE_SPEC_kadrovska_30.md` — NE počinjati tu analizu ispočetka.

## Sažeta tabela verdikta (FRONT se seli kao 2.0 UI; POZADINA ostaje u sy15/bridge)

| Komponenta | Okidač | Ključne tabele/RPC | Verdikt |
|---|---|---|---|
| `hr-notify-dispatch` (edge) | pg_cron `kadr_pulse_notify_dispatch` (pg_net, */5) + ručno iz fronta | `kadr_notification_log`, `kadr_dispatch_dequeue/mark_sent/mark_failed`, Storage `employee-docs` (prilozi) | POZADINA — ostaje (edge worker) |
| `kiosk-punch` (edge, `--no-verify-jwt` + `x-kiosk-key`) | kiosk ekran `/kiosk` (front fetch) | RPC `kiosk_record_punch` → `attendance_events` (source='kiosk'; dedup <30s, auto-toggle smera) | edge = POZADINA; kiosk UI = FRONT |
| `assessment-invite` (edge; gate admin/hr/menadzment) | ručno iz `services/assessments.js` | `assessments`, `assessment_cycles`, `assessment_raters` (invited_at PATCH), Resend; link `ocena.html?token=` | POZADINA |
| `push-dispatch` (edge, interni `PUSH_DISPATCH_KEY`) | AFTER INSERT trigger `kadr_notify_push_trg` na `kadr_notification_log` (pg_net, fire-and-forget) | `device_push_tokens` (čisti 404/410), `auth.users`, `private.app_config`; deep-link po `notification_type` | POZADINA |
| bridge `syncKatze.js` (Node worker, node-cron ~10min) | `ENABLE_JOB_KATZE` | `dbo.tblReg`(Katze MSSQL 192.168.64.10) → UPSERT `attendance_events` (source,external_id; watermark RPC `attendance_katze_max_idreg`); resolve preko `employee_badges` | POZADINA — JEDINI upisivač events-a pored kioska |
| `hrNotifications.js` | front | config/log CRUD + RPC okidači (`kadr_trigger_schedule_hr_reminders`, `kadr_trigger_weekly_risk_summary`, `kadr_queue_payroll_notifications`) + retarget priloga knjigovođi | FRONT |
| `prisustvo.js` | front (READ-ONLY!) | `v_attendance_now/shadow_monthly/vs_grid/daily`, `attendance_events` read, `attendance_corrections` + RPC submit/cancel correction | FRONT |
| `kadrovska.js`/`kadrovskaDashboard.js`/`employees.js`/`contracts.js` | front | dashboard RPC (`kadr_dashboard_kpis/mini_reports/action_stack`), `v_employees_safe`, `hr_update_employee` (optimistic lock), `kadr_queue_document_email`, `employee_documents`+bucket, `contracts` soft-delete | FRONT |
| `kadrOfflineQueue.js` | front (`online` event) | localStorage queue, MAX 200/8 pokušaja; ⚠️ POST retry NIJE idempotentan (nema server dedup tokena) | FRONT — u 2.0 v1 se NE prenosi (kao Reversi/Lokacije odluka) |

## Dopuna 2: auth gate-ovi (src/state/auth.js) — ekvivalenti za 2.0 permisije

- `canAccessKadrovska()`: hr | admin | menadzment | poslovni_admin | projektant_vodja | per-user override `kadrovskaAccess`.
- `canAccessSalary()`: **SAMO admin** (HR namerno NEMA). `canViewContracts()`: kadrovska minus `kadrovskaHideContracts` override minus projektant_vodja.
- `canEditKadrovska()` = ekvivalent DB `has_edit_role()`: admin/leadpm/pm/hr/menadzment/poslovni_admin.
- **Email allowliste (konstante, NE role!)**: `KADROVSKA_GRID_EDITOR_EMAILS` (edit grida), `KADROVSKA_VACATION_EDITOR_EMAILS` (saldo), `KADROVSKA_VACREQ_MANAGER_EMAILS` (vacreq manager; `current_user_is_vacreq_admin` = SAMO Zoran). U 2.0 → prevesti u per-user override permisije, NE hardkodovati mejlove.
- PII: `canEditEmployeeSensitiveFields()`/`canViewEmployeePii()` = admin | poslovni_admin. `canGenerateContract()` isto.
- Lokalni gate-ovi u `ui/kadrovska/shared.js` (NISU u auth.js): `canSeePrisustvo()` = hr|adminOrMenadzment|gridEditor; `canSeeShadow()` = hr|adminOrMenadzment.
- Tab→gate mapa u `shared.js KADR_TAB_DEFS`: salary→canAccessSalary, contracts→canViewContracts, imenik→canViewPhoneDirectory, approvals/vac-requests/makeup/paid-leave→canManageVacationRequests, onboarding→canManageOnboarding, prisustvo→canSeePrisustvo, ostalo→canAccessKadrovska.

## Dopuna 3: mobilna površina (za §4 spec-a)

- `/m/kadrovska` (gate canAccessKadrovska): read-only pregled zaposlenih (v_employees_safe, contracts, absences, work_hours grid).
- `/m/odsustva` (svi): GO zahtev — v_vacation_balance re-provera pre submita; RPC hr_revise/cancel/delete_vacation_request + kadr_queue_vacation_submission_notification + triggerHrDispatch.
- `/m/odobravanja` (canManageVacationRequests): hr_vacreq_approve, hr_reject_vacation_request, hr_reschedule_vacation_request + kadr_queue_vacation_notification; scope = getManagedSubDepartmentIds + canManageEmployee + isVacreqManagerEmail.
- `/m/sati`: work_hours grid + work_hours_remarks + employee_expectations. `/m/profil`, `/m/onboarding` (own-read RLS).
- ⚠️ GAP: „Moje prisustvo" NEMA mobilni ekran (samo desktop /moj-profil prisustvoCard) — kandidat za 2.0 v1.
- `/m/izvestaj` NIJE Kadrovska (Montaža AI izveštaji — Talas C).

## Dopuna 4: deljena površina Moj profil (Talas D) ↔ Kadrovska (Talas G)

Moj profil (gate = svaki ulogovan, RLS „svoje" + „Moj tim") koristi HR objekte:
- View: `v_employees_safe`, `v_vacation_balance`, `v_employee_expectations`, `v_development_plans`, `v_attendance_daily`.
- Tabele: absences, contracts, vacation_requests, vacation_entitlements/history, work_hours, work_hours_remarks, makeup_requests, paid_leave_requests, job_positions, company_profile, employee_expectations, development_plans/checkins, kadr_onboarding_runs/tasks, kadr_document_ack (ack Pravilnika!), employee_talks + corrective_plans/measures, attendance_events/corrections.
- RPC: hr_revise/cancel/delete_vacation_request, attendance_submit_correction, kadr_delete_makeup, paid_leave_delete, kadr_queue_*_notification + edge hr-notify-dispatch.
- Karnet PDF reuse iz `kadrovska/karnetMonth.js`. → Talas D spec mora označiti ove kao ZAVISNOST OD G (šta može pre G: read-only view sloj).

## Dopuna 5: UI inventar 15 tabova (gotov materijal za §5 parity matricu)

Arhitektura: tabovi NE zovu Supabase direktno (sve kroz `src/services/*`); izuzeci sa direktnim sbReq: vacationDecisionDoc (job_positions), vacationRecordDoc (v_vacation_balance/work_hours), kioskQrAdmin (employee_badges), contractsTab, vacationRequestsTab, approvalsTab, employeesTab, gridTab.

1. **Pregled** (dashboardTab+Charts): RPC `kadr_dashboard_kpis/mini_reports/action_stack`; Chart.js 3 grafikona; deep-link akcije. Gate canAccessKadrovska.
2. **Izveštaji** (reportsTab, 11 izveštaja): sick/demo/org/vacation/overtime/field/medical/certs/children/risk/audit; XLSX+CSV exporti; risk → RPC `kadr_trigger_weekly_risk_summary`; PII izveštaji gate canViewEmployeePii, audit isAdmin.
3. **Notifikacije** (hrNotificationsTab): queue UI + config modal; RPC `kadr_trigger_schedule_hr_reminders`, `kadr_queue_payroll_notifications`; retry/cancel/delete. Gate isHrOrAdmin.
4. **Godišnji odmor** (vacationTab+historyView+decisionDoc+recordDoc): stat kartice, Gantt po odeljenjima, Excel; akrual modal (saveEntitlementToDb), avans (`hr_set_advance_approval`), korekcija (`hr_correct_vacation_balance`); PDF Rešenje o GO + A4 Evidencija GO (upload+queueDocumentEmail). Gate edit canEditVacationBalance, rešenje admin|poslovni_admin.
5. **Zahtevi/Odobravanja** (vacationRequestsTab/approvalsTab/makeupTab/paidLeaveTab): jedinstveni inbox 4 izvora; RPC `hr_approve_vacation_request`, `hr_vacreq_approve`, `hr_reject/reschedule/revise/cancel/delete_vacation_request`, `makeup_approve/reject/complete`, `kadr_storno_makeup` (↩ vraća −1 GO), `kadr_delete_makeup`, `kadr_grant_bonus_go`, `paid_leave_approve/reject/delete`, `approve/reject_nop_request`, `kadr_queue_*_notification`. Gate canManageVacationRequests + scope; finalizacija isHR|isAdmin; neplaćeno samo admin.
6. **Odsustva/Kalendar** (absencesTab/odsustvaPregledTab/calendarTab/odsutniTab): CRUD odsustva + upis u grid (`applyAbsencePeriodToGrid`); pivot 15 kolona + Excel; mesečni kalendar read-only; roster odsutnih. Gate edit canEditKadrovska/Grid; pregled canAccessOdsustvaPregled.
7. **Mesečni grid** (gridTab + 8 helpera + karnetMonth): batch upsert `hr_upsert_work_hours_batch` + confirm; lock banner (gridMonthLock); primedbe resolve; NOP; teren grupni unos; istorija `kadr_work_hours_audit` + „↩ Vrati"; **realtime subscribe**; desni klik → veži predmet (searchBigtehnItems); Karnet PDF + `generateAndStoreMonthKarnete`; allowlist servis `kadr_grid_editor_allowlist`. Gate canEditKadrovskaGrid; NOP isAdmin.
8. **Sati pojedinačno** (workHoursTab): CRUD work_hours + `queuePayrollNotifications`. Gate canEditKadrovskaGrid.
9. **Prisustvo** (prisustvoTab+kioskQrAdmin): Uživo (v_attendance_now, auto 60s) + Poređenje sa gridom (shadow); QR nalepnice PDF (employee_badges get-or-create, jsPDF+qrcode 2×5 A4); korekcije `attendance_submit/cancel_correction`. Gate canSeePrisustvo; shadow+QR canSeeShadow.
10. **Zaposleni** (employeesTab + bulk/audit/medical/certs modali + printTemplates): CRUD + deaktivacija + admin purge; bulk import Excel/CSV (JMBG validacija); masovno generisanje dokumenata ZIP; PDF generatori (Potvrda o zaposlenju/zaradi, Aneks, Porodiljsko, Sporazumni raskid — ćirilica); RPC `hr_update_employee` (optimistic lock), `kadr_queue_document_email`, `current_user_can_manage_employee_pii`; medical_exams/certificates CRUD. Gate slojevit (PII/sensitive/admin).
11. **Ugovori** (contractsTab): forma = cela stranica; PDF rešenje + 📑 Ugovor o radu (contractPdf → upload); `kadr_get_contract_bruto` (netToGross); arhiviraj/vrati. Gate canManageContracts/canGenerateContract.
12. **Imenik** (imenikTab): tel/WhatsApp/vCard (pojedinačni + izvoz svih); inline unos telefona → `hr_update_employee`. Gate canViewPhoneDirectory; unos = PII gate.
13. **Uvođenje/Izlazak** (onboardingTab): šabloni + tokovi (`kadr_onboarding_start`), REVERSI zaduženja panel pri izlasku. Gate canManageOnboarding.
14. **Plan razvoja** (planRazvojaTab+talksSection+assessment360Modal+assessmentCampaign): IRP planovi + check-ins; razgovori (nacrt→podeli→„Upoznat sam", odluka o zaradi, mere; STT+AI refine); 360 RPC `assessment_open_360/set_targets/compute_results/gap_to_goals/self_submit/open_campaign` + PDF radar. Gate canManageDevPlanFor; niko o sebi (RLS).
15. **Zarade** (salaryTab+salaryPayrollTab) — **SAMO admin (canAccessSalary)**: uslovi zarade (salary_terms, comp modeli fiksno/dva_dela/satnica/jednokratno/praksa; tabele za knjigovođu → PDF po grupama + email retarget); mesečni obračun: `kadr_payroll_init_month`, recompute iz grida + karnete, `hr_upsert_salary_payroll` (V2 optimistic), `kadr_payroll_unlock`, 🔒 zaključavanje, payslip PDF pojedinačno/bulk; engine `payrollCalc.js` (BOLOVANJE 65%/100%, fond, payment windows) + `salaryTax.js` (grossToNet/netToGross po godinama).

## Skrivena pravila firme (obavezno u G spec)
- Insert u `kadr_notification_log` ide ISKLJUČIVO kroz SECURITY DEFINER queue/schedule fn — front nikad direktno.
- `hr-notify-dispatch`: mark-sent ODMAH po slanju (anti-dupli batch); backoff cap 6h, MAX_ATTEMPTS=8; bez env tokena → DRY-RUN koji se markira sent.
- WhatsApp = Meta Cloud API, approved template `hr_alert_sr`, E.164 normalizacija.
- `attendance_events` tok je JEDNOSMERAN: bridge(Katze) + kiosk → events → front samo čita kroz view-ove; korekcije idu u zasebnu tabelu.
- Kiosk barijera = deljena tajna uređaja (anon key je javan i NIJE zaštita).
