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
  // Kadrovska (HR) — 3.0 TALAS G (MODULE_SPEC_kadrovska_30.md §2.4 / presuda §7).
  // `kadrovska.read` = KANON vidljivosti modula (paritet 1.0 canAccessKadrovska).
  // Stroža prava po ekranu/akciji: pii (admin∨poslovni_admin — HR NEMA PII!),
  // salary (SAMO admin), contracts_read, grid_edit, vacation_edit, vacreq_manage/admin,
  // attendance (view-only), attendance_shadow, dev_manage. `profile.self` = svaki zaposleni
  // (samo-podnošenje GO/korekcija/„upoznat sam"/samoprocena). Backend guard presuđuje;
  // FE ovim SAMO krije afordanse (zarade/PII se NE prikazuju ulozi bez ključa).
  KADROVSKA_READ: 'kadrovska.read',
  KADROVSKA_EDIT: 'kadrovska.edit',
  KADROVSKA_MANAGE: 'kadrovska.manage',
  KADROVSKA_ADMIN: 'kadrovska.admin',
  KADROVSKA_PII: 'kadrovska.pii',
  KADROVSKA_SALARY: 'kadrovska.salary',
  KADROVSKA_CONTRACTS_READ: 'kadrovska.contracts_read',
  KADROVSKA_GRID_EDIT: 'kadrovska.grid_edit',
  KADROVSKA_VACATION_EDIT: 'kadrovska.vacation_edit',
  KADROVSKA_VACREQ_MANAGE: 'kadrovska.vacreq_manage',
  KADROVSKA_VACREQ_ADMIN: 'kadrovska.vacreq_admin',
  KADROVSKA_ATTENDANCE: 'kadrovska.attendance',
  KADROVSKA_ATTENDANCE_SHADOW: 'kadrovska.attendance_shadow',
  KADROVSKA_DEV_MANAGE: 'kadrovska.dev_manage',
  PROFILE_SELF: 'profile.self',
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];
