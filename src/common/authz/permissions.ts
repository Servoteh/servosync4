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
  // Radni nalozi
  RN_READ: "rn.read",
  RN_WRITE: "rn.write",
  RN_APPROVE: "rn.approve",
  RN_LAUNCH: "rn.launch",
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
  // Kadrovska (HR) — 3.0 TALAS G (MODULE_SPEC_kadrovska_30.md §2.4, presuda §7 „VAŽE
  // SVI PREDLOZI"). Guard = VIDLJIVOST (paritet 1.0 auth.js/shared.js gate-ova); ROW/PII
  // maska OSTAJE u sy15 (RLS + v_employees_safe + DEFINER helperi kroz GUC most).
  //   read           = 1.0 canAccessKadrovska: admin/hr/menadzment/poslovni_admin/projektant_vodja
  //   edit           = 1.0 has_edit_role: admin/hr/menadzment/pm/leadpm/poslovni_admin
  //   manage         = 1.0 kadr_can_manage_hr (is_hr_or_admin ∨ pii): admin/hr/poslovni_admin
  //   admin          = 1.0 current_user_is_admin: SAMO admin (nop/praznici/audit/purge)
  //   pii            = 1.0 current_user_can_manage_employee_pii: admin ∨ poslovni_admin (HR NEMA!)
  //   salary         = 1.0 canAccessSalary: SAMO admin (HR namerno nema)
  //   contracts_read = 1.0 canViewContracts: read minus projektant_vodja (minus per-user hide)
  //   grid_edit      = 1.0 can_edit_kadrovska_grid: DB allowlist (kadr_grid_editor_allowlist) → per-user override
  //   vacation_edit  = 1.0 can_edit_vacation_balance: DB allowlist (kadr_vacation_editor_allowlist) → per-user override
  //   vacreq_manage  = 1.0 current_user_can_manage_vacreq: admin/hr/menadzment/pm/leadpm/poslovni_admin (+row-scope)
  //   vacreq_admin   = 1.0 current_user_is_vacreq_admin: SAMO Zoran (named per-user override; admin via ALL)
  //   attendance     = 1.0 canSeePrisustvo: admin/hr/menadzment (+gridEditor override)
  //   attendance_shadow = 1.0 canSeeShadow: admin/hr/menadzment
  //   dev_manage     = 1.0 manages_dev_plan/talk/assessment (row-scope): admin/menadzment/hr/pm/leadpm (niko o sebi = DB)
  // ⚠️ G1 (§7.1): `kadrovska.read` je KANON zajedno sa Talasom D (D-override
  // `kadrovska_access` mapira na ISTI ključ `kadrovska.read`) — ne uvoditi drugi ključ.
  KADROVSKA_READ: "kadrovska.read",
  KADROVSKA_EDIT: "kadrovska.edit",
  KADROVSKA_MANAGE: "kadrovska.manage",
  KADROVSKA_ADMIN: "kadrovska.admin",
  KADROVSKA_PII: "kadrovska.pii",
  KADROVSKA_SALARY: "kadrovska.salary",
  KADROVSKA_CONTRACTS_READ: "kadrovska.contracts_read",
  KADROVSKA_GRID_EDIT: "kadrovska.grid_edit",
  KADROVSKA_VACATION_EDIT: "kadrovska.vacation_edit",
  KADROVSKA_VACREQ_MANAGE: "kadrovska.vacreq_manage",
  KADROVSKA_VACREQ_ADMIN: "kadrovska.vacreq_admin",
  KADROVSKA_ATTENDANCE: "kadrovska.attendance",
  KADROVSKA_ATTENDANCE_SHADOW: "kadrovska.attendance_shadow",
  KADROVSKA_DEV_MANAGE: "kadrovska.dev_manage",
} as const;

export type PermissionKey = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];
