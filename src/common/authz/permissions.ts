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
} as const;

export type PermissionKey = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

/**
 * Kanonski ključevi per-user override-a (Talas D / D2, MODULE_SPEC §7 P2) za
 * `user_permission_overrides.key`. NISU (još) u `PERMISSIONS` katalogu jer im moduli (Plan
 * montaže C / Kadrovska G) nisu u 2.0 — ali potrošači čitaju baš ove ključeve kad stignu.
 * Semantika guarda: deny (allow=false) > grant (allow=true) > rola.
 *
 * Mapiranje 1.0 `user_roles` bool kolona → (key, allow):
 *   plan_montaze_readonly=true   → (plan_montaze.write, allow=false)   // deny write
 *   kadrovska_access=true        → (kadrovska.access, allow=true)      // grant
 *   kadrovska_hide_contracts=true→ (kadrovska.contracts_read, allow=false) // deny
 * Kad je bool false → odgovarajući override red se BRIŠE (pada na rolu).
 */
export const OVERRIDE_KEYS = {
  PLAN_MONTAZE_WRITE: "plan_montaze.write",
  KADROVSKA_ACCESS: "kadrovska.access",
  KADROVSKA_CONTRACTS_READ: "kadrovska.contracts_read",
} as const;

/** Jedan D2 override: 1.0 bool kolona → 2.0 (key, allow) kad je bool true (false = brisanje reda). */
export interface OverrideMapping {
  key: string;
  allowWhenSet: boolean;
}

/** 1.0 bool ime → 2.0 override mapiranje (D2). Izvor istine za invite/edit i buduću #44 migraciju. */
export const D2_OVERRIDE_MAP = {
  planMontazeReadonly: {
    key: OVERRIDE_KEYS.PLAN_MONTAZE_WRITE,
    allowWhenSet: false,
  },
  kadrovskaAccess: {
    key: OVERRIDE_KEYS.KADROVSKA_ACCESS,
    allowWhenSet: true,
  },
  kadrovskaHideContracts: {
    key: OVERRIDE_KEYS.KADROVSKA_CONTRACTS_READ,
    allowWhenSet: false,
  },
} as const satisfies Record<string, OverrideMapping>;
