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
