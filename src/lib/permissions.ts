// Permission keys — MIRROR of backend `src/common/authz/permissions.ts`.
// Single source of the string values; the backend `GET /auth/me/permissions`
// returns the subset the logged-in user's role grants (AUTHZ_UNIFIED.md §8 Faza 2).
// Keep in sync with the backend catalog; a key here that the backend doesn't emit
// simply never matches (fail-closed).

export const PERMISSIONS = {
  TEHNOLOGIJA_READ: 'tehnologija.read',
  TEHNOLOGIJA_WRITE: 'tehnologija.write',
  TEHNOLOGIJA_APPROVE: 'tehnologija.approve',
  TEHNOLOGIJA_REPORT_WORK: 'tehnologija.report_work',
  // CAM redosled (per-user grant) — samo tehnolozi kojima je dodeljen
  // ređaju CAM listu prevlačenjem; CNC programeri vide redosled read-only.
  CAM_PRIORITET: 'tehnologija.cam_prioritet',
  RN_READ: 'rn.read',
  RN_WRITE: 'rn.write',
  RN_APPROVE: 'rn.approve',
  RN_LAUNCH: 'rn.launch',
  // Prinudno brisanje RN-a sa evidentiranim radom (admin/šef) — DELETE /:id/force.
  RN_DELETE_FORCE: 'rn.delete.force',
  PDM_READ: 'pdm.read',
  PDM_IMPORT: 'pdm.import',
  STRUKTURE_READ: 'strukture.read',
  STRUKTURE_WRITE: 'strukture.write',
  PRIMOPREDAJE_READ: 'primopredaje.read',
  PRIMOPREDAJE_WRITE: 'primopredaje.write',
  PRIMOPREDAJE_APPROVE: 'primopredaje.approve',
  LOKACIJE_READ: 'lokacije.read',
  LOKACIJE_WRITE: 'lokacije.write',
  MRP_READ: 'mrp.read',
  DIRECTORY_READ: 'directory.read',
  SYNC_RUN: 'sync.run',
  SYNC_READ: 'sync.read',
  // Reversi — 3.0 pilot (2.0 backend docs/design/MODULE_SPEC_reversi.md §3)
  REVERSI_READ: 'reversi.read',
  REVERSI_MANAGE: 'reversi.manage',
  // Rezervisano za „Moj tim" pogled (TL/šef) — UI još nije priključen; vidi TODO u api/reversi.ts.
  REVERSI_TEAM_READ: 'reversi.team_read',
  // Talas C — Proizvodnja (Plan montaže + Plan proizvodnje + Praćenje).
  // MODULE_SPEC_planovi_pracenje_30.md §2; mirror BE common/authz/permissions.ts.
  MONTAZA_READ: 'montaza.read',
  MONTAZA_EDIT: 'montaza.edit',
  MONTAZA_IZVESTAJI: 'montaza.izvestaji',
  MONTAZA_AI_ADMIN: 'montaza.ai_admin',
  PLAN_PROIZVODNJE_READ: 'plan_proizvodnje.read',
  PLAN_PROIZVODNJE_EDIT: 'plan_proizvodnje.edit',
  PLAN_PROIZVODNJE_FORCE: 'plan_proizvodnje.force',
  PLAN_PROIZVODNJE_KOOP_ADMIN: 'plan_proizvodnje.koop_admin',
  PRACENJE_READ: 'pracenje.read',
  PRACENJE_EDIT: 'pracenje.edit',
  PRACENJE_MANAGE: 'pracenje.manage',
  PRACENJE_PRIORITET: 'pracenje.prioritet',
  // Projektni biro — 3.0 TALAS D (MODULE_SPEC_pb_profil_podesavanja_30.md §2.5).
  // read = svi prijavljeni; comment = edit-krug ∪ inzenjer; edit = admin/hr/menadzment/pm/
  // leadpm/poslovni_admin/projektant_vodja; progress = inzenjer restriktovani edit (+edit);
  // reports_all = admin/leadpm/pm/menadzment; reports_own = svako svoje (row u DB);
  // tips_write = edit-krug ∪ inzenjer/projektant_vodja; admin = notif config + kategorije.
  PB_READ: 'pb.read',
  PB_COMMENT: 'pb.comment',
  PB_EDIT: 'pb.edit',
  PB_PROGRESS: 'pb.progress',
  PB_REPORTS_ALL: 'pb.reports_all',
  PB_REPORTS_OWN: 'pb.reports_own',
  PB_TIPS_WRITE: 'pb.tips_write',
  PB_ADMIN: 'pb.admin',
  // Moj profil — self-service za sve (agregator). self = svaki prijavljen; team = menadžerske sekcije.
  PROFILE_SELF: 'profile.self',
  PROFILE_TEAM: 'profile.team',
  // Podešavanja (RBAC admin konzola + matični + sistem) — TALAS D §3.3.
  // users = admin (korisnici/uloge-dozvole/grid urednici/struktura); org_profile = admin/
  // menadzment/pm/leadpm (vrednosti firme/opisi/očekivanja/kompetence); predmet_aktivacija =
  // admin/menadzment; audit + system = admin.
  SETTINGS_USERS: 'settings.users',
  SETTINGS_ORG_PROFILE: 'settings.org_profile',
  SETTINGS_PREDMET_AKTIVACIJA: 'settings.predmet_aktivacija',
  SETTINGS_AUDIT: 'settings.audit',
  SETTINGS_SYSTEM: 'settings.system',
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];
