/**
 * Katalog permisija (RBAC_RLS_PREDLOG §3/§5). Ključ = `modul.akcija`.
 * V1: guard je NO-OP (svi ulogovani prolaze) — ključevi se SAMO deklarišu na
 * endpointima da V2 aktivacija bude konfiguracija, ne prepravka kontrolera.
 * Napomena 3.0: ceo 2.0 postaje modul „Tehnologija" — ključevi to već prate.
 */
export const PERMISSIONS = {
  // Tehnologija (TP)
  TEHNOLOGIJA_READ: "tehnologija.read",
  TEHNOLOGIJA_WRITE: "tehnologija.write",
  TEHNOLOGIJA_APPROVE: "tehnologija.approve",
  /** Unos rada (barkod prijava/zatvaranje operacije) — uža mutacija za proizvodnog radnika,
   *  bez punog `tehnologija.write`. Endpointi: /barcode/scan, /tech-processes/:id/finish. */
  TEHNOLOGIJA_REPORT_WORK: "tehnologija.report_work",
  /** CAM red — redosled CAM pozicija (prevlačenje). Određuju ga IMENOVANI tehnolozi
   *  (miljan/nikola/jovica) preko `user_permission_overrides` grant-ova; NE dodaje se
   *  nijednoj roli u role-permissions.ts (admin nasleđuje kroz ALL). Endpoint:
   *  PATCH /v1/cnc-programs/:workOrderId/queue. */
  CAM_PRIORITET: "tehnologija.cam_prioritet",
  // Radni nalozi
  RN_READ: "rn.read",
  RN_WRITE: "rn.write",
  RN_APPROVE: "rn.approve",
  RN_LAUNCH: "rn.launch",
  /** Prinudno brisanje RN-a — briše RN I evidenciju rada (tech_processes,
   *  prijave/kucanja, work_time_entries) i zaobilazi lock guard. Samo ADMIN
   *  (kroz ALL) i SEF; NE tehnolog/menadzment/kontrolor. Endpoint:
   *  DELETE /v1/work-orders/:id/force. */
  RN_DELETE_FORCE: "rn.delete.force",
  // PDM / Crteži / BOM
  PDM_READ: "pdm.read",
  PDM_IMPORT: "pdm.import",
  // Strukture (radnici/mašine/šifarnici)
  STRUKTURE_READ: "strukture.read",
  STRUKTURE_WRITE: "strukture.write",
  // Primopredaje / Nacrti
  PRIMOPREDAJE_READ: "primopredaje.read",
  PRIMOPREDAJE_WRITE: "primopredaje.write",
  PRIMOPREDAJE_APPROVE: "primopredaje.approve",
  // Lokacije delova
  LOKACIJE_READ: "lokacije.read",
  LOKACIJE_WRITE: "lokacije.write",
  // MRP / Nabavka
  MRP_READ: "mrp.read",
  // Šifarnici / pregledi (komitenti, predmeti)
  DIRECTORY_READ: "directory.read",
  // Sync administracija
  SYNC_RUN: "sync.run",
  SYNC_READ: "sync.read",
  // Reversi — 3.0 PILOT (zaduženja alata/LZO/rezni; MODULE_SPEC_reversi.md §3).
  // Paritet žive 1.0 politike: read = svi prijavljeni; manage = rev_can_manage()
  // (admin/menadzment/pm/leadpm/magacioner); team_read = get_team_issued_tools scope.
  REVERSI_READ: "reversi.read",
  REVERSI_MANAGE: "reversi.manage",
  REVERSI_TEAM_READ: "reversi.team_read",
  // Sastanci + AI asistent — 3.0 TALAS B (MODULE_SPEC_sastanci_ai_30.md §2/§3).
  // Guard = VIDLJIVOST (paritet 1.0 front gate-a); ROW-odluka OSTAJE u sy15 bazi
  // (RLS + DEFINER RPC kroz GUC most). Zato je „read" širina 1.0 `canAccessSastanci`,
  // a ne DB SELECT (`true` za sve authenticated).
  //   read        = 1.0 canAccessSastanci: admin/leadpm/pm/menadzment/hr/viewer (§7 P6)
  //   edit        = 1.0 has_edit_role paritet: admin/menadzment/hr/pm/leadpm/poslovni_admin
  //   manage      = 1.0 current_user_is_management: admin/menadzment (invites/remind/resend/reopen)
  //   weekly_move = VIDLJIVOST dugmadi; prava odluka je tabela `sast_weekly_movers` (§2, §7)
  //   ai_model    = set_sastanci_ai_model: samo admin (§3)
  SASTANCI_READ: "sastanci.read",
  SASTANCI_EDIT: "sastanci.edit",
  SASTANCI_MANAGE: "sastanci.manage",
  SASTANCI_WEEKLY_MOVE: "sastanci.weekly_move",
  SASTANCI_AI_MODEL: "sastanci.ai_model",
  // AI asistent chat — 1.0 „/ai za sve" → sve aktivne uloge; upis istorije je server-side.
  AI_CHAT: "ai.chat",

  // Plan montaže + izveštaji montera — 3.0 TALAS C (MODULE_SPEC_planovi_pracenje_30.md §2/§3).
  // Guard = VIDLJIVOST (paritet ŽIVIH 1.0 gate-ova); ROW-odluka (has_edit_role project-scope,
  // autor-scope izveštaja) OSTAJE u sy15 kroz GUC (withUserRls). Modul „Montaža" je UNGATED
  // u 1.0 (router.assertModuleAllowed nema montaza granu; hub kartica bez gate-a) →
  // read/izvestaji = svaka aktivna 2.0 rola.
  //   read       = svaki prijavljen (Montaža modul ungated)
  //   edit       = canEditPlanMontaze = canEdit()∪tim_lider (PRESUDA C1: tim_lider PRAVI edit)
  //   izvestaji  = create svima (autor-scope u DB); manage-tuđih = row-odluka (autor∨mgmt∨admin)
  //   ai_admin   = set_montaza_ai_model = current_user_is_admin
  MONTAZA_READ: "montaza.read",
  MONTAZA_EDIT: "montaza.edit",
  MONTAZA_IZVESTAJI: "montaza.izvestaji",
  MONTAZA_AI_ADMIN: "montaza.ai_admin",
  // Plan proizvodnje — TALAS C. Modul „proizvodnja" je ROUTER-gated u 1.0
  // (canAccessPlanProizvodnje) — nosi i Planiranje i Praćenje.
  //   read        = canAccessPlanProizvodnje (9 rola, v. role-permissions)
  //   edit        = can_edit_plan_proizvodnje = admin/pm/menadzment
  //   force       = can_force_plan_reassign = admin/menadzment (reassign p_force + SELECT audita)
  //   koop_admin  = current_user_is_admin (auto-koop grupe)
  PLAN_PROIZVODNJE_READ: "plan_proizvodnje.read",
  PLAN_PROIZVODNJE_EDIT: "plan_proizvodnje.edit",
  PLAN_PROIZVODNJE_FORCE: "plan_proizvodnje.force",
  PLAN_PROIZVODNJE_KOOP_ADMIN: "plan_proizvodnje.koop_admin",
  // Praćenje proizvodnje — TALAS C (isti router gate kao Plan proizvodnje).
  //   read      = canAccessPlanProizvodnje (isti gate)
  //   edit      = can_edit_pracenje = admin/pm/menadzment (+has_edit_role širina u DB kroz GUC)
  //   manage    = can_manage_predmet_aktivacija = admin/menadzment (napomene/override/aktivacija/⭐)
  //   prioritet = ↑↓ prioritet praćenja = SAMO admin
  PRACENJE_READ: "pracenje.read",
  PRACENJE_EDIT: "pracenje.edit",
  PRACENJE_MANAGE: "pracenje.manage",
  PRACENJE_PRIORITET: "pracenje.prioritet",
  // Projektni biro — 3.0 TALAS D (MODULE_SPEC_pb_profil_podesavanja_30.md §2.5).
  // Guard = paritet ŽIVIH 1.0 DB gate-ova; ROW-odluka (work_reports self-scope, eng
  // tips draft/org-clanstvo, komentar 1h prozor) OSTAJE u sy15 bazi (RLS + DEFINER RPC
  // kroz GUC most). Zato je „read" = DB SELECT `true` (svi prijavljeni), NE front meni.
  //   read        = pb_can_* SELECT `true`/`deleted_at IS NULL` = svi prijavljeni (§2.1)
  //   comment     = pb_can_comment() = edit-krug ∪ inzenjer
  //   edit        = pb_can_edit_tasks() = admin/hr/menadzment/pm/leadpm/poslovni_admin/projektant_vodja
  //   progress    = pb_update_task_progress (inzenjer restriktovani edit; + svi sa edit)
  //   reports_all = pb_current_user_can_see_all_reports() = admin/leadpm/pm/menadzment (+ DB row-pravilo „Rukovodstvo inženjeringa")
  //   reports_own = work_reports self-scope (row u DB) — svako svoje
  //   tips_write  = can_write_pb_eng_tips() = edit-krug ∪ inzenjer/projektant_vodja (+ org-clanstvo u DB fn)
  //   admin       = current_user_is_admin() (notif config, kategorije saveta)
  PB_READ: "pb.read",
  PB_COMMENT: "pb.comment",
  PB_EDIT: "pb.edit",
  PB_PROGRESS: "pb.progress",
  PB_REPORTS_ALL: "pb.reports_all",
  PB_REPORTS_OWN: "pb.reports_own",
  PB_TIPS_WRITE: "pb.tips_write",
  PB_ADMIN: "pb.admin",
  // Podešavanja — RBAC admin konzola + matični (§2.2/§3.3). R1 = READ sloj (lista
  // korisnika/rola/override/matični/audit-read); dvostrano upravljanje nalozima (D1) i
  // audit dvoizvor (D10) su R2. Guard = paritet 1.0 admin gate-ova:
  //   users               = current_user_is_admin() (usersTab, grid urednici, uloge&dozvole matrica)
  //   org_profile         = current_user_can_manage_org_profile() = admin/menadzment/pm/leadpm
  //                         (company_profile / opisi pozicija / očekivanja / kompetence)
  //   predmet_aktivacija  = can_manage_predmet_aktivacija() = admin/menadzment
  //   audit               = admin (v_settings_audit_log SELECT)
  //   system              = admin (dijagnostika + AI model izbor)
  SETTINGS_USERS: "settings.users",
  SETTINGS_ORG_PROFILE: "settings.org_profile",
  SETTINGS_PREDMET_AKTIVACIJA: "settings.predmet_aktivacija",
  SETTINGS_AUDIT: "settings.audit",
  SETTINGS_SYSTEM: "settings.system",
  // Moj profil (👤 self-service za sve ~157) — agregator kroz GUC (§0.2/§2.5).
  //   self = SVAKI prijavljen (scope visi na lower(email) → aktivan employees red;
  //          bez reda → prazan profil). Row-odluka je RLS/DEFINER u bazi.
  //   team = menadžerske sekcije (canSubmitVacationRequestForOthers × managed_sub_department_ids):
  //          admin/hr/menadzment/leadpm/pm/poslovni_admin (prazan scope = nema tima — DB odlučuje).
  PROFILE_SELF: "profile.self",
  PROFILE_TEAM: "profile.team",
  // Održavanje / CMMS — 3.0 TALAS F (MODULE_SPEC_odrzavanje_30.md §2/§3, presuda F8).
  // ⚠️ DVOSLOJNI authz: guard je SAMO gruba kapija (VIDLJIVOST). Stvarnu row-odluku
  // donosi 102 RLS politike kroz `Sy15Service.withUserRls` — maint_user_profiles po
  // **auth.uid()** (operator machine-scope/technician/chief/management/admin) + ERP
  // sloj po **email-u** (maint_is_erp_admin*, maint_has_floor_read_access). Guard NE
  // može izraziti maint profil; FE fino-gejtuje preko `GET /maintenance/me`.
  //   read      = prijava kvara + čitanje CMMS = OPŠTE pravo (F8) → sve aktivne uloge
  //   report    = prijava kvara (incidents INSERT reported_by=ja) → sve aktivne uloge
  //   write     = maint mutacije; gruba ERP-aproks. maint chief/admin sloja (RLS/RPC autoritativan)
  //   admin_ui  = prikaz admin UI-ja (admin/menadzment/magacioner) — NIJE bezbednosna granica
  ODRZAVANJE_READ: "odrzavanje.read",
  ODRZAVANJE_REPORT: "odrzavanje.report",
  ODRZAVANJE_WRITE: "odrzavanje.write",
  ODRZAVANJE_ADMIN_UI: "odrzavanje.admin_ui",
} as const;

export type PermissionKey = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];
