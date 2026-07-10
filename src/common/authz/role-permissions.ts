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

export const ROLE_PERMISSIONS: Partial<Record<RoleKey, readonly PermissionKey[]>> = {
  [ROLES.ADMIN]: ALL,

  [ROLES.SEF]: [
    P.TEHNOLOGIJA_READ, P.TEHNOLOGIJA_WRITE, P.TEHNOLOGIJA_APPROVE, P.TEHNOLOGIJA_REPORT_WORK,
    P.RN_READ, P.RN_WRITE, P.RN_APPROVE, P.RN_LAUNCH,
    P.PDM_READ,
    P.STRUKTURE_READ, P.STRUKTURE_WRITE,
    P.PRIMOPREDAJE_READ, P.PRIMOPREDAJE_WRITE, P.PRIMOPREDAJE_APPROVE,
    P.LOKACIJE_READ, P.LOKACIJE_WRITE,
    P.MRP_READ, P.DIRECTORY_READ, P.SYNC_READ,
  ],

  [ROLES.TEHNOLOG]: [
    P.TEHNOLOGIJA_READ, P.TEHNOLOGIJA_WRITE, P.TEHNOLOGIJA_APPROVE, P.TEHNOLOGIJA_REPORT_WORK,
    P.RN_READ, P.RN_WRITE,
    // Capability po RBAC §3.2 (launch role = {sef, tehnolog, admin}); Worker.definesLaunch/
    // definesApproval je OBAVEZAN drugi gate u servisu — bez flaga akcija pada i sa permisijom.
    P.RN_APPROVE, P.RN_LAUNCH,
    P.PDM_READ,
    P.STRUKTURE_READ,
    P.PRIMOPREDAJE_READ, P.PRIMOPREDAJE_WRITE,
    P.LOKACIJE_READ, P.MRP_READ, P.DIRECTORY_READ,
  ],

  [ROLES.CNC_PROGRAMER]: [
    P.TEHNOLOGIJA_READ, P.TEHNOLOGIJA_WRITE, P.TEHNOLOGIJA_APPROVE, P.TEHNOLOGIJA_REPORT_WORK,
    P.RN_READ,
    P.PDM_READ,
    P.STRUKTURE_READ,
    P.PRIMOPREDAJE_READ,
    P.LOKACIJE_READ, P.MRP_READ, P.DIRECTORY_READ,
  ],

  [ROLES.KONTROLOR]: [
    P.TEHNOLOGIJA_READ,
    P.TEHNOLOGIJA_APPROVE, // finalna kontrola: validira završen TP (uz OBAVEZAN audit zapis)
    // Kontrolori i KUCAJU (prijem kooperacije/cinkovanja — 90d prod podataka) + kiosk scan/
    // start/stop rute traže report_work; bez ovoga enforce blokira kontrolora na kiosku.
    P.TEHNOLOGIJA_REPORT_WORK,
    P.RN_READ,
    P.PDM_READ,
    // Matrica §3: KONTROLOR = W (prijem/kvalitet), approve primopredaje je SEF-ov (W+A).
    P.PRIMOPREDAJE_READ, P.PRIMOPREDAJE_WRITE,
    P.STRUKTURE_READ, P.LOKACIJE_READ, // matrica §3: R
    P.DIRECTORY_READ,
  ],

  [ROLES.MAGACIONER]: [
    P.LOKACIJE_READ, P.LOKACIJE_WRITE,
    P.TEHNOLOGIJA_READ, P.RN_READ, P.PDM_READ, P.STRUKTURE_READ,
    P.PRIMOPREDAJE_READ, P.MRP_READ, P.DIRECTORY_READ,
  ],

  [ROLES.PROIZVODNI_RADNIK]: [
    // Row-scope (samo svoje operacije po machine_access; strukture = samo svoj red) sprovodi ScopeService.
    P.TEHNOLOGIJA_READ,
    P.TEHNOLOGIJA_REPORT_WORK, // unos rada (barkod)
    P.RN_READ,
    P.STRUKTURE_READ, // matrica §3: R (own) — svoj radnik-zapis / svoj machine_access
    P.LOKACIJE_READ,
    // BEZ directory.read — matrica §3: RADNIK nema komitente/predmete.
  ],

  [ROLES.NABAVKA_VIEW]: [
    P.MRP_READ, P.DIRECTORY_READ, P.PDM_READ,
    P.TEHNOLOGIJA_READ, P.RN_READ, // matrica §3: R (kontekst za MRP uvid)
  ],

  [ROLES.MENADZMENT]: [
    // Uvid + write u operativi (paritet 1.0, ODLUKE #9); validira završen TP (audit, Negovan 8.7).
    P.TEHNOLOGIJA_READ, P.TEHNOLOGIJA_APPROVE,
    P.RN_READ, P.RN_WRITE,
    P.PDM_READ,
    // Strukture: samo R (matrica §3; write struktura je SEF-ov — 1.0 nema strukture pa nema pariteta).
    P.STRUKTURE_READ,
    // Primopredaje: W po paritetu; APPROVE namerno NE — finalno odobrenje ide per-user
    // (`finalni_potpisnik` override — Milorad Jerotić) ili SEF/ADMIN, ne blanket menadžmentu.
    P.PRIMOPREDAJE_READ, P.PRIMOPREDAJE_WRITE,
    P.LOKACIJE_READ, P.LOKACIJE_WRITE, // 1.0 obrazac 10: menadzment piše lokacije
    P.MRP_READ, P.DIRECTORY_READ, P.SYNC_READ,
  ],

  // 3.0-rezervisane i deferred uloge nemaju 2.0 permisije (njihovi moduli još ne postoje).
  // Baseline uvid dobija samo `viewer` (read gde ima smisla u 2.0 pilotu).
  [ROLES.VIEWER]: [
    P.TEHNOLOGIJA_READ, P.RN_READ, P.PDM_READ, P.DIRECTORY_READ,
  ],
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
export function roleHasPermission(role: string, permission: PermissionKey): boolean {
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
  for (const r of roles) for (const p of ROLE_PERMISSIONS[normaliseRole(r) as RoleKey] ?? []) set.add(p);
  return [...set];
}
