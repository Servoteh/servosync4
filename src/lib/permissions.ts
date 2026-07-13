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
  // Energetika / SCADA — 3.0 TALAS E (backend docs/design/MODULE_SPEC_scada_30.md §2).
  // Paritet žive 1.0 politike: SAMO admin + menadzment (BEZ viewer baseline). U kodu su
  // read/control NAMERNO odvojeni ključevi (ista dodela u v1) — control gate-uje komandni
  // tok (POST /commands + cancel), read sve GET-ove. Presuda E5: `energetika.*`, ne `scada.*`.
  ENERGETIKA_READ: 'energetika.read',
  ENERGETIKA_CONTROL: 'energetika.control',
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];
