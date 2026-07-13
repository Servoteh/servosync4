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
  RN_READ: 'rn.read',
  RN_WRITE: 'rn.write',
  RN_APPROVE: 'rn.approve',
  RN_LAUNCH: 'rn.launch',
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
  // Sastanci + AI asistent — 3.0 TALAS B (backend docs/design/MODULE_SPEC_sastanci_ai_30.md §2).
  // Paritet backend role-permissions: read = canAccessSastanci (admin/leadpm/pm/menadzment/hr/viewer);
  // edit = has_edit_role (+poslovni_admin); manage/weekly_move = admin/menadzment; ai_model = admin.
  // sastanci.weekly_move je SAMO vidljivost dugmadi — pravu odluku presuđuje tabela sast_weekly_movers.
  SASTANCI_READ: 'sastanci.read',
  SASTANCI_EDIT: 'sastanci.edit',
  SASTANCI_MANAGE: 'sastanci.manage',
  SASTANCI_WEEKLY_MOVE: 'sastanci.weekly_move',
  SASTANCI_AI_MODEL: 'sastanci.ai_model',
  // AI asistent = SVE aktivne uloge (1.0 „/ai za sve").
  AI_CHAT: 'ai.chat',
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];
