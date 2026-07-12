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
    // APPROVE: odluka Nenad 12.07.2026 (ODLUKE #33) — tehnolozi (Miljan,
    // Jovica) odobravaju, dodeljuju tehnologa i lansiraju primopredaje;
    // paritet QBigTehn gde „Jovica i Miljan" odobravaju (frmIzborTehnologa).
    P.PRIMOPREDAJE_APPROVE,
    P.LOKACIJE_READ,
    P.MRP_READ,
    P.DIRECTORY_READ,
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
  ],

  [ROLES.NABAVKA_VIEW]: [
    P.MRP_READ,
    P.DIRECTORY_READ,
    P.PDM_READ,
    P.TEHNOLOGIJA_READ,
    P.RN_READ, // matrica §3: R (kontekst za MRP uvid)
    P.REVERSI_READ, // paritet 1.0: SELECT za sve prijavljene
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
    // Primopredaje: PRIVREMENO pun pristup (read/write/approve) — odluka Nenad
    // 12.07.2026 (ODLUKE #33): menadžment vidi i Nacrte i Primopredaje dok se
    // tok ne ustali; APPROVE UKINUTI kasnije (vraća se na per-user
    // `finalni_potpisnik` override ili SEF/ADMIN).
    P.PRIMOPREDAJE_READ,
    P.PRIMOPREDAJE_WRITE,
    P.PRIMOPREDAJE_APPROVE,
    P.LOKACIJE_READ,
    P.LOKACIJE_WRITE, // 1.0 obrazac 10: menadzment piše lokacije
    P.MRP_READ,
    P.DIRECTORY_READ,
    P.SYNC_READ,
    // Reversi paritet 1.0: menadzment JESTE u rev_can_manage().
    P.REVERSI_READ,
    P.REVERSI_MANAGE,
    P.REVERSI_TEAM_READ,
    // Energetika/SCADA (Talas E, MODULE_SPEC_scada_30 §2): paritet
    // `scada_is_admin_or_management()` — SAMO admin (ALL) + menadzment. SCADA nije
    // za sve → BEZ viewer read-baseline; nijedna druga rola (ni sef/tehnolog).
    P.ENERGETIKA_READ,
    P.ENERGETIKA_CONTROL,
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
  ],
  [ROLES.LEADPM]: [
    P.REVERSI_READ,
    P.REVERSI_MANAGE,
    P.TEHNOLOGIJA_READ,
    P.RN_READ,
    P.PDM_READ,
    P.DIRECTORY_READ, // baseline uvid (kao viewer)
  ],

  // tim_lider: read-baseline (SSO uvid) + zaduženja svog tima; write čeka 3.0.
  [ROLES.TIM_LIDER]: [...VIEWER_READ_BASELINE, P.REVERSI_TEAM_READ],

  // Biro role (P4_SPEC_pdm_intake_PREDLOG §6.5.3, odluka Nenad 11.07 — §0 t.3):
  // projektanti biroa MORAJU raditi u 2.0 pre cutover-a (kreiranje/uređivanje
  // nacrta primopredaje) — read-baseline (SSO uvid) + primopredaje write.
  // Role u katalogu ostaju tier "3.0" — rana aktivacija permisija, ne nova uloga.
  [ROLES.PROJEKTANT_VODJA]: [
    ...VIEWER_READ_BASELINE,
    P.PRIMOPREDAJE_READ,
    P.PRIMOPREDAJE_WRITE, // kreiranje/uređivanje nacrta primopredaje (§6.5.3)
  ],
  [ROLES.INZENJER]: [
    ...VIEWER_READ_BASELINE,
    P.PRIMOPREDAJE_READ,
    P.PRIMOPREDAJE_WRITE, // kreiranje/uređivanje nacrta primopredaje (§6.5.3)
  ],

  // 1.0 kancelarijske role bez 2.0-modula (tier 3.0/reservisano): preko SSO-a
  // ulaze u „Tehnologiju" pa MORAJU imati read-baseline (bez ovoga ih
  // AUTHZ_ENFORCE=true zaključa na 403). Kuriranje write-a stiže sa modulima.
  [ROLES.HR]: [...VIEWER_READ_BASELINE],
  [ROLES.POSLOVNI_ADMIN]: [...VIEWER_READ_BASELINE],
  [ROLES.CNC_OPERATER]: [...VIEWER_READ_BASELINE],
  [ROLES.MONTER]: [...VIEWER_READ_BASELINE],

  // Baseline uvid dobija i `viewer` (read gde ima smisla u 2.0 pilotu).
  [ROLES.VIEWER]: [...VIEWER_READ_BASELINE],
};

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
