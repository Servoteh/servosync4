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
} as const;

export type PermissionKey = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];
