/**
 * Mapa uloga → permisije (RBAC_RLS_PREDLOG §3 matrica, AUTHZ_UNIFIED.md).
 * IZVOR ISTINE za V2 aktivaciju: `PermissionsGuard` će (kad se aktivira) proveriti da li
 * bar jedna korisnikova uloga sadrži deklarisanu permisiju. Frontend isti izvor dobija preko
 * `GET /api/v1/me/permissions`. Analogija: 1.0 `erpRbacMatrix.js`.
 *
 * V1: guard je NO-OP → ova mapa se JOŠ ne enforce-uje; postoji da aktivacija bude konfiguracija.
 *
 * VAŽNO (dvoslojna autorizacija, kao 1.0 „rola × flag"): neke akcije NISU pokrivene samo ulogom —
 * traže i `Worker` flag proveren u servisu, ne ovde:
 *   - `rn.launch`  ⇒ uloga ∈ {sef, tehnolog, admin} I `Worker.definesLaunch = true`
 *   - `rn.approve` ⇒ `Worker.definesApproval = true`
 * Zato tehnolog/menadzment ovde NEMAJU `rn.approve`/`rn.launch` po difoltu — flag ih dodaje.
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
    P.TEHNOLOGIJA_APPROVE, // finalna kontrola: validira završen TP (uz audit)
    P.RN_READ,
    P.PDM_READ,
    P.PRIMOPREDAJE_READ, P.PRIMOPREDAJE_WRITE, P.PRIMOPREDAJE_APPROVE,
    P.DIRECTORY_READ,
  ],

  [ROLES.MAGACIONER]: [
    P.LOKACIJE_READ, P.LOKACIJE_WRITE,
    P.TEHNOLOGIJA_READ, P.RN_READ, P.PDM_READ, P.STRUKTURE_READ,
    P.PRIMOPREDAJE_READ, P.MRP_READ, P.DIRECTORY_READ,
  ],

  [ROLES.PROIZVODNI_RADNIK]: [
    // Row-scope (samo svoje operacije po machine_access) sprovodi ScopeService.
    P.TEHNOLOGIJA_READ,
    P.TEHNOLOGIJA_REPORT_WORK, // unos rada (barkod)
    P.RN_READ,
    P.LOKACIJE_READ, P.DIRECTORY_READ,
  ],

  [ROLES.NABAVKA_VIEW]: [
    P.MRP_READ, P.DIRECTORY_READ, P.PDM_READ,
  ],

  [ROLES.MENADZMENT]: [
    // Uvid + write u operativi (paritet 1.0); može validirati završen TP (audit).
    P.TEHNOLOGIJA_READ, P.TEHNOLOGIJA_APPROVE,
    P.RN_READ, P.RN_WRITE,
    P.PDM_READ,
    P.STRUKTURE_READ, P.STRUKTURE_WRITE,
    P.PRIMOPREDAJE_READ, P.PRIMOPREDAJE_WRITE, P.PRIMOPREDAJE_APPROVE,
    P.LOKACIJE_READ, P.LOKACIJE_WRITE,
    P.MRP_READ, P.DIRECTORY_READ, P.SYNC_READ,
  ],

  // 3.0-rezervisane i deferred uloge nemaju 2.0 permisije (njihovi moduli još ne postoje).
  // Baseline uvid dobija samo `viewer` (read gde ima smisla u 2.0 pilotu).
  [ROLES.VIEWER]: [
    P.TEHNOLOGIJA_READ, P.RN_READ, P.PDM_READ, P.DIRECTORY_READ,
  ],
};

/** Da li uloga ima permisiju (za V2 guard aktivaciju). */
export function roleHasPermission(role: string, permission: PermissionKey): boolean {
  const perms = ROLE_PERMISSIONS[role as RoleKey];
  return perms ? perms.includes(permission) : false;
}

/** Objedinjene permisije za skup korisnikovih uloga (za `/me/permissions`). */
export function permissionsForRoles(roles: string[]): PermissionKey[] {
  const set = new Set<PermissionKey>();
  for (const r of roles) for (const p of ROLE_PERMISSIONS[r as RoleKey] ?? []) set.add(p);
  return [...set];
}
