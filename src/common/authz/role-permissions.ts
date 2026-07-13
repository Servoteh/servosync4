/**
 * Mapa uloga → permisije (RBAC_RLS_PREDLOG §3 matrica, AUTHZ_UNIFIED.md).
 * IZVOR ISTINE za V2 aktivaciju: `PermissionsGuard` će (kad se aktivira) proveriti da li
 * bar jedna korisnikova uloga sadrži deklarisanu permisiju. Frontend isti izvor dobija preko
 * `GET /api/v1/me/permissions`. Analogija: 1.0 `erpRbacMatrix.js`.
 *
 * V1: guard je NO-OP → ova mapa se JOŠ ne enforce-uje; postoji da aktivacija bude konfiguracija.
 *
 * VAŽNO (dvoslojna autorizacija, kao 1.0 „rola × flag" — RBAC §3.2: rola daje MOGUĆNOST,
 * `Worker` flag daje OVLAŠĆENJE; OBA sloja se proveravaju):
 *   - `rn.launch`  ⇒ mapa daje ulogama {sef, tehnolog} I servis proverava `Worker.definesLaunch = true`
 *   - `rn.approve` ⇒ mapa daje ulogama {sef, tehnolog} I servis proverava `Worker.definesApproval = true`
 * Dakle capability JESTE u mapi (bez nje guard odbija pre servisa), a flag je drugi gate u servisu.
 * Per-user izuzeci (npr. `finalni_potpisnik` za primopredaje.approve) idu kroz
 * `UserPermissionOverride` (deny > grant > rola) — guard ih MORA konsultovati posle ove mape.
 * Row-scope (RADNIK→machine_access, owner-na-TP, TP-lock) ide kroz `ScopeService`, ne kroz ovu mapu.
 */
import { PERMISSIONS, type PermissionKey } from "./permissions";
import { ROLES, type RoleKey } from "./roles";

const P = PERMISSIONS;

/** Sve permisije (za `admin`). */
const ALL: PermissionKey[] = Object.values(P);

/**
 * Read-only „pod" za 2.0 pilot module — isto što dobija `viewer`.
 * Svaka 1.0 rola koja preko SSO-a (iframe „Tehnologija", auth.service.ts
 * SY15_ROLE_PRIORITY) uđe u 2.0, a nema svoje kurirane permisije, dobija BAR
 * ovaj uvid — inače bi uz AUTHZ_ENFORCE=true dobila 403 na ceo modul (manje od
 * viewer-a). Write/approve i dalje traži kuriranu rolu.
 */
const VIEWER_READ_BASELINE: readonly PermissionKey[] = [
  P.TEHNOLOGIJA_READ,
  P.RN_READ,
  P.PDM_READ,
  P.DIRECTORY_READ,
  P.REVERSI_READ,
];

/**
 * Sastanci + AI TALAS B (MODULE_SPEC_sastanci_ai_30.md §2/§7 P6, presuda 12.07):
 *   - `sastanci.read`  = 1.0 `canAccessSastanci` front gate = admin/leadpm/pm/menadzment/hr/viewer.
 *     (DB SELECT je `true` za sve authenticated, ali guard = VIDLJIVOST menija;
 *     operativne role monter/tim_lider/proizvodni_radnik/magacioner/cnc_operater/sef/…
 *     NE vide modul. Širenje = svesna odluka kasnije.)
 *   - `sastanci.edit`  = 1.0 `has_edit_role` paritet = admin/menadzment/hr/pm/leadpm/poslovni_admin
 *     (poslovni_admin ima edit ali NE read — front ga ne prikazuje, ali DB/edit-scope ga pušta;
 *      viewer ima read ali NE edit). Row-odluka (učesnik-scope/organizator-trio) OSTAJE u bazi.
 *   - `sastanci.manage` = admin/menadzment (pozivnice/podsetnici/resend/reopen).
 *   - `sastanci.weekly_move` = VIDLJIVOST dugmadi; prava odluka = tabela `sast_weekly_movers`
 *      (danas Nenad+Zoran, NIJE rola) kroz GUC. Dajemo je mgmt-u da guard ne blokira movere.
 * `ai.chat` = SVE aktivne uloge (1.0 „/ai za sve"); upis istorije je server-side.
 */
export const ROLE_PERMISSIONS: Partial<
  Record<RoleKey, readonly PermissionKey[]>
> = {
  [ROLES.ADMIN]: ALL,

  [ROLES.SEF]: [
    P.TEHNOLOGIJA_READ,
    P.TEHNOLOGIJA_WRITE,
    P.TEHNOLOGIJA_APPROVE,
    P.TEHNOLOGIJA_REPORT_WORK,
    P.RN_READ,
    P.RN_WRITE,
    P.RN_APPROVE,
    P.RN_LAUNCH,
    P.PDM_READ,
    // Nativni XML/PDF intake (P4 cutover): AUTHZ_ENFORCE=true je ŽIV na
    // prod-u — bez ovoga bi pdm.import imao samo admin (ALL).
    P.PDM_IMPORT,
    P.STRUKTURE_READ,
    P.STRUKTURE_WRITE,
    P.PRIMOPREDAJE_READ,
    P.PRIMOPREDAJE_WRITE,
    P.PRIMOPREDAJE_APPROVE,
    P.LOKACIJE_READ,
    P.LOKACIJE_WRITE,
    P.MRP_READ,
    P.DIRECTORY_READ,
    P.SYNC_READ,
    // Reversi paritet 1.0: sef NIJE u rev_can_manage() → read + team scope, BEZ manage.
    P.REVERSI_READ,
    P.REVERSI_TEAM_READ,
    // Sastanci: sef NIJE u canAccessSastanci (§7 P6) → BEZ sastanci.*. AI: /ai za sve.
    P.AI_CHAT,
  ],

  [ROLES.TEHNOLOG]: [
    P.REVERSI_READ, // paritet 1.0: SELECT za sve prijavljene
    P.TEHNOLOGIJA_READ,
    P.TEHNOLOGIJA_WRITE,
    P.TEHNOLOGIJA_APPROVE,
    P.TEHNOLOGIJA_REPORT_WORK,
    P.RN_READ,
    P.RN_WRITE,
    // Capability po RBAC §3.2 (launch role = {sef, tehnolog, admin}); Worker.definesLaunch/
    // definesApproval je OBAVEZAN drugi gate u servisu — bez flaga akcija pada i sa permisijom.
    P.RN_APPROVE,
    P.RN_LAUNCH,
    P.PDM_READ,
    P.STRUKTURE_READ,
    // Strukture write (vrste poslova, RJ, operacije, radnici): odluka Nenad
    // 10.07.2026 (PLAN_dorade_2026-07-10 D1) — dodavanje/izmena struktura
    // dozvoljena i TEHNOLOG/MENADZMENT rolama uz ADMIN/SEF.
    P.STRUKTURE_WRITE,
    P.PRIMOPREDAJE_READ,
    P.PRIMOPREDAJE_WRITE,
    P.LOKACIJE_READ,
    P.MRP_READ,
    P.DIRECTORY_READ,
    P.AI_CHAT, // 1.0 /ai za sve (Sastanci: nije u canAccessSastanci)
  ],

  [ROLES.CNC_PROGRAMER]: [
    P.REVERSI_READ, // paritet 1.0: SELECT za sve prijavljene
    P.TEHNOLOGIJA_READ,
    P.TEHNOLOGIJA_WRITE,
    P.TEHNOLOGIJA_APPROVE,
    P.TEHNOLOGIJA_REPORT_WORK,
    P.RN_READ,
    P.PDM_READ,
    P.STRUKTURE_READ,
    P.PRIMOPREDAJE_READ,
    P.LOKACIJE_READ,
    P.MRP_READ,
    P.DIRECTORY_READ,
    P.AI_CHAT, // 1.0 /ai za sve
  ],

  [ROLES.KONTROLOR]: [
    P.REVERSI_READ, // paritet 1.0: SELECT za sve prijavljene
    P.TEHNOLOGIJA_READ,
    P.TEHNOLOGIJA_APPROVE, // finalna kontrola: validira završen TP (uz OBAVEZAN audit zapis)
    // Kontrolori i KUCAJU (prijem kooperacije/cinkovanja — 90d prod podataka) + kiosk scan/
    // start/stop rute traže report_work; bez ovoga enforce blokira kontrolora na kiosku.
    P.TEHNOLOGIJA_REPORT_WORK,
    P.RN_READ,
    P.PDM_READ,
    // Matrica §3: KONTROLOR = W (prijem/kvalitet), approve primopredaje je SEF-ov (W+A).
    P.PRIMOPREDAJE_READ,
    P.PRIMOPREDAJE_WRITE,
    P.STRUKTURE_READ,
    P.LOKACIJE_READ, // matrica §3: R
    P.DIRECTORY_READ,
    P.AI_CHAT, // 1.0 /ai za sve
  ],

  [ROLES.MAGACIONER]: [
    P.LOKACIJE_READ,
    P.LOKACIJE_WRITE,
    P.TEHNOLOGIJA_READ,
    P.RN_READ,
    P.PDM_READ,
    P.STRUKTURE_READ,
    P.PRIMOPREDAJE_READ,
    P.MRP_READ,
    P.DIRECTORY_READ,
    // Reversi (3.0 pilot): magacioner je nosilac modula — rev_can_manage() paritet.
    P.REVERSI_READ,
    P.REVERSI_MANAGE,
    // Sastanci: magacioner NE dobija sastanci.* (§7 P6). AI: /ai za sve.
    P.AI_CHAT,
  ],

  [ROLES.PROIZVODNI_RADNIK]: [
    // Row-scope (samo svoje operacije po machine_access; strukture = samo svoj red) sprovodi ScopeService.
    P.TEHNOLOGIJA_READ,
    P.TEHNOLOGIJA_REPORT_WORK, // unos rada (barkod)
    P.RN_READ,
    P.STRUKTURE_READ, // matrica §3: R (own) — svoj radnik-zapis / svoj machine_access
    P.LOKACIJE_READ,
    P.REVERSI_READ, // paritet 1.0: SELECT za sve prijavljene („Moji alati")
    // BEZ directory.read — matrica §3: RADNIK nema komitente/predmete.
    // Sastanci: proizvodni_radnik NE dobija sastanci.* (§7 P6). AI: /ai za sve.
    P.AI_CHAT,
  ],

  [ROLES.NABAVKA_VIEW]: [
    P.MRP_READ,
    P.DIRECTORY_READ,
    P.PDM_READ,
    P.TEHNOLOGIJA_READ,
    P.RN_READ, // matrica §3: R (kontekst za MRP uvid)
    P.REVERSI_READ, // paritet 1.0: SELECT za sve prijavljene
    P.AI_CHAT, // 1.0 /ai za sve
  ],

  [ROLES.MENADZMENT]: [
    // Uvid + write u operativi (paritet 1.0, ODLUKE #9); validira završen TP (audit, Negovan 8.7).
    P.TEHNOLOGIJA_READ,
    P.TEHNOLOGIJA_APPROVE,
    P.RN_READ,
    P.RN_WRITE,
    P.PDM_READ,
    // Strukture: R + W — odluka Nenad 10.07.2026 (PLAN_dorade_2026-07-10 D1)
    // prevazilazi „samo R" iz matrice §3: dodavanje/izmena struktura dozvoljena
    // i MENADZMENT/TEHNOLOG rolama uz ADMIN/SEF.
    P.STRUKTURE_READ,
    P.STRUKTURE_WRITE,
    // Primopredaje: W po paritetu; APPROVE namerno NE — finalno odobrenje ide per-user
    // (`finalni_potpisnik` override — Milorad Jerotić) ili SEF/ADMIN, ne blanket menadžmentu.
    P.PRIMOPREDAJE_READ,
    P.PRIMOPREDAJE_WRITE,
    P.LOKACIJE_READ,
    P.LOKACIJE_WRITE, // 1.0 obrazac 10: menadzment piše lokacije
    P.MRP_READ,
    P.DIRECTORY_READ,
    P.SYNC_READ,
    // Reversi paritet 1.0: menadzment JESTE u rev_can_manage().
    P.REVERSI_READ,
    P.REVERSI_MANAGE,
    P.REVERSI_TEAM_READ,
    // Sastanci: mgmt = read+edit+manage+weekly_move (current_user_is_management paritet).
    P.SASTANCI_READ,
    P.SASTANCI_EDIT,
    P.SASTANCI_MANAGE,
    P.SASTANCI_WEEKLY_MOVE,
    P.AI_CHAT,
  ],

  // AKTIVIRANE 10.07.2026 uz 3.0-pilot Reversi (Nenad) — paritet rev_can_manage().
  // Ostale permisije dobijaju kad njihovi moduli (PB/Plan montaže) stignu u 3.0;
  // per-projekat scope (scopeType='project') sprovodi ScopeService tada.
  [ROLES.PM]: [
    P.REVERSI_READ,
    P.REVERSI_MANAGE,
    P.TEHNOLOGIJA_READ,
    P.RN_READ,
    P.PDM_READ,
    P.DIRECTORY_READ, // baseline uvid (kao viewer)
    // Sastanci: pm je u canAccessSastanci + has_edit_role → read + edit.
    P.SASTANCI_READ,
    P.SASTANCI_EDIT,
    P.AI_CHAT,
  ],
  [ROLES.LEADPM]: [
    P.REVERSI_READ,
    P.REVERSI_MANAGE,
    P.TEHNOLOGIJA_READ,
    P.RN_READ,
    P.PDM_READ,
    P.DIRECTORY_READ, // baseline uvid (kao viewer)
    // Sastanci: leadpm je u canAccessSastanci + has_edit_role → read + edit.
    P.SASTANCI_READ,
    P.SASTANCI_EDIT,
    P.AI_CHAT,
  ],

  // tim_lider: read-baseline (SSO uvid) + zaduženja svog tima; write čeka 3.0.
  // Sastanci: tim_lider NE dobija sastanci.* (§7 P6). AI: /ai za sve.
  [ROLES.TIM_LIDER]: [...VIEWER_READ_BASELINE, P.REVERSI_TEAM_READ, P.AI_CHAT],

  // Biro role (P4_SPEC_pdm_intake_PREDLOG §6.5.3, odluka Nenad 11.07 — §0 t.3):
  // projektanti biroa MORAJU raditi u 2.0 pre cutover-a (kreiranje/uređivanje
  // nacrta primopredaje) — read-baseline (SSO uvid) + primopredaje write.
  // Role u katalogu ostaju tier "3.0" — rana aktivacija permisija, ne nova uloga.
  [ROLES.PROJEKTANT_VODJA]: [
    ...VIEWER_READ_BASELINE,
    P.PRIMOPREDAJE_READ,
    P.PRIMOPREDAJE_WRITE, // kreiranje/uređivanje nacrta primopredaje (§6.5.3)
    P.AI_CHAT, // 1.0 /ai za sve (nije u canAccessSastanci)
  ],
  [ROLES.INZENJER]: [
    ...VIEWER_READ_BASELINE,
    P.PRIMOPREDAJE_READ,
    P.PRIMOPREDAJE_WRITE, // kreiranje/uređivanje nacrta primopredaje (§6.5.3)
    P.AI_CHAT, // 1.0 /ai za sve (nije u canAccessSastanci)
  ],

  // 1.0 kancelarijske role bez 2.0-modula (tier 3.0/reservisano): preko SSO-a
  // ulaze u „Tehnologiju" pa MORAJU imati read-baseline (bez ovoga ih
  // AUTHZ_ENFORCE=true zaključa na 403). Kuriranje write-a stiže sa modulima.
  // HR: u canAccessSastanci + has_edit_role → sastanci.read + edit. /ai svima.
  [ROLES.HR]: [
    ...VIEWER_READ_BASELINE,
    P.SASTANCI_READ,
    P.SASTANCI_EDIT,
    P.AI_CHAT,
  ],
  // poslovni_admin: has_edit_role (edit) ali NIJE u canAccessSastanci (bez read) — §2 paritet.
  [ROLES.POSLOVNI_ADMIN]: [...VIEWER_READ_BASELINE, P.SASTANCI_EDIT, P.AI_CHAT],
  [ROLES.CNC_OPERATER]: [...VIEWER_READ_BASELINE, P.AI_CHAT],
  [ROLES.MONTER]: [...VIEWER_READ_BASELINE, P.AI_CHAT],

  // Baseline uvid dobija i `viewer` (read gde ima smisla u 2.0 pilotu).
  // Sastanci: viewer je u canAccessSastanci → SAMO read (bez edit). /ai svima.
  [ROLES.VIEWER]: [...VIEWER_READ_BASELINE, P.SASTANCI_READ, P.AI_CHAT],
};

/**
 * TALAS D — Projektni biro + Moj profil + Podešavanja (MODULE_SPEC_pb_profil_podesavanja_30.md
 * §2.5, presuda D6/D7/D8, 13.07). Dodela se LAYER-uje nad mapom iznad (admin već ima ALL, pa
 * ga merge ne menja). Zašto post-merge a ne inline u svaku ulogu: `pb.read`, `pb.reports_own` i
 * `profile.self` idu na SVE aktivne uloge (DB SELECT `true`/self-scope paritet, §2.1/§0.2) — sloj
 * to čini očiglednim i sprečava propust nove uloge. Kurirani PB/settings podskupovi = paritet
 * ŽIVIH DB gate-ova (§2.1/§2.2). Row-odluke (work_reports self-scope, eng-tips draft/org-članstvo
 * iz `pb_get_mechanical_projecting_engineers`, reports „Rukovodstvo inženjeringa", komentar 1h)
 * OSTAJU u sy15 (RLS/DEFINER kroz GUC most) — NE prepisuju se u katalog (§2.4).
 *
 * D7: `hr`/`poslovni_admin` dobijaju `pb.edit` (živo pravilo firme `has_edit_role`, §2.4.1 — NE
 * sužavati); `inzenjer`/`projektant_vodja` = rana aktivacija PB permisija (konfiguracija, ne nova
 * uloga). D8: guard koristi UNION permisija svih uloga (`permissionsForRoles`) — asimetrija
 * prioriteta rola (DB vs FE) nestaje po konstrukciji; DB fn se NE dira.
 */
// pb.edit „krug" = pb_can_edit_tasks() paritet (admin ide kroz ALL). comment/progress/tips_write
// = isti krug ∪ inzenjer (§2.5: comment→edit∪inzenjer; progress→inzenjer∪edit; tips→edit∪inzenjer).
const D_EDIT_KRUG: readonly RoleKey[] = [
  ROLES.HR,
  ROLES.MENADZMENT,
  ROLES.PM,
  ROLES.LEADPM,
  ROLES.POSLOVNI_ADMIN,
  ROLES.PROJEKTANT_VODJA,
];
const D_EDIT_PERMS: readonly PermissionKey[] = [
  P.PB_EDIT,
  P.PB_COMMENT,
  P.PB_PROGRESS,
  P.PB_TIPS_WRITE,
];
// inzenjer: restriktovani edit — comment/progress/tips_write ALI NE pun pb.edit (§2.5, §2.4.5).
const D_INZENJER_PERMS: readonly PermissionKey[] = [
  P.PB_COMMENT,
  P.PB_PROGRESS,
  P.PB_TIPS_WRITE,
];
const D_REPORTS_ALL: readonly RoleKey[] = [
  ROLES.LEADPM,
  ROLES.PM,
  ROLES.MENADZMENT,
];
const D_ORG_PROFILE: readonly RoleKey[] = [
  ROLES.MENADZMENT,
  ROLES.PM,
  ROLES.LEADPM,
];
const D_PREDMET_AKTIVACIJA: readonly RoleKey[] = [ROLES.MENADZMENT];
const D_PROFILE_TEAM: readonly RoleKey[] = [
  ROLES.HR,
  ROLES.MENADZMENT,
  ROLES.LEADPM,
  ROLES.PM,
  ROLES.POSLOVNI_ADMIN,
];

function addPerms(role: RoleKey, perms: readonly PermissionKey[]): void {
  const base = ROLE_PERMISSIONS[role] ?? [];
  ROLE_PERMISSIONS[role] = [...new Set([...base, ...perms])];
}

// Univerzalno: SVE uloge koje se loguju u 2.0 (svi ključevi u mapi) → pb.read/reports_own/
// profile.self (DB SELECT `true` + self-scope paritet). admin (ALL) je uključen — no-op merge.
for (const role of Object.keys(ROLE_PERMISSIONS) as RoleKey[]) {
  addPerms(role, [P.PB_READ, P.PB_REPORTS_OWN, P.PROFILE_SELF]);
}
for (const role of D_EDIT_KRUG) addPerms(role, D_EDIT_PERMS);
addPerms(ROLES.INZENJER, D_INZENJER_PERMS);
for (const role of D_REPORTS_ALL) addPerms(role, [P.PB_REPORTS_ALL]);
for (const role of D_ORG_PROFILE) addPerms(role, [P.SETTINGS_ORG_PROFILE]);
for (const role of D_PREDMET_AKTIVACIJA)
  addPerms(role, [P.SETTINGS_PREDMET_AKTIVACIJA]);
for (const role of D_PROFILE_TEAM) addPerms(role, [P.PROFILE_TEAM]);
// pb.admin / settings.users / settings.audit / settings.system = SAMO admin (već u ALL) — bez dodele.

/**
 * Normalise a stored role value to the catalog key.
 * Live `users.role` data predates the lowercase convention ("ADMIN"/"USER") — without this,
 * activating the guard on prod would deny EVERYONE including admin (lockout). The V2 activation
 * still ships a data migration (`UPDATE users SET role = lower(role)`); this is defence in depth.
 * Legacy "USER" maps to the transitional `user` role (→ viewer permissions once migrated).
 */
function normaliseRole(role: string): string {
  return role.trim().toLowerCase();
}

/** Da li uloga ima permisiju (za V2 guard aktivaciju). Default-deny za nepoznate uloge. */
export function roleHasPermission(
  role: string,
  permission: PermissionKey,
): boolean {
  const perms = ROLE_PERMISSIONS[normaliseRole(role) as RoleKey];
  return perms ? perms.includes(permission) : false;
}

/**
 * Objedinjene permisije za skup korisnikovih uloga (za `/me/permissions`).
 * NAPOMENA: ovo je samo rola-sloj — guard/endpoint mora posle uniona primeniti
 * `UserPermissionOverride` (deny > grant > rola) pre konačnog odgovora.
 */
export function permissionsForRoles(roles: string[]): PermissionKey[] {
  const set = new Set<PermissionKey>();
  for (const r of roles)
    for (const p of ROLE_PERMISSIONS[normaliseRole(r) as RoleKey] ?? [])
      set.add(p);
  return [...set];
}
