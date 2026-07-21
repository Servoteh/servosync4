import { Prisma } from "@prisma/client";
import { roleHasPermission } from "./role-permissions";
import { PERMISSIONS, type PermissionKey } from "./permissions";

/**
 * TVRDA BRAVA NA ZARADE (odluka vlasnika 21.07): vidljivost/izmena plata
 * (`kadrovska.salary`) sme ISKLJUČIVO na eksplicitnu email-allowlistu —
 * NEZAVISNO od role i override-a. Ovo je pojas-i-tregeri iznad sy15 RLS
 * (`current_user_is_admin` = 1.0 admin) i iznad 3.0 role: čak i da neko dobije
 * `admin` rolu (rola-sync ili ručno) ili grant override, plate ostaju samo
 * allowlisti. Deny na `kadrovska.salary` za sve ostale nadjačava sve.
 *
 * Izvor allowliste: env `KADROVSKA_SALARY_ALLOWLIST` (zarezom razdvojeni
 * mejlovi, podesivo bez deploya — restart dovoljan); default = Nenad + Nevena.
 * Prazan/nepostavljen env → default (NIKAD prazna lista koja bi zaključala i njih).
 */
const SALARY_ALLOWLIST_DEFAULT = [
  "nenad.jarakovic@servoteh.com",
  "nevena.knezevic@servoteh.com",
];

function salaryAllowlist(): Set<string> {
  const raw = (process.env.KADROVSKA_SALARY_ALLOWLIST ?? "").trim();
  const parsed = raw
    ? raw
        .split(",")
        .map((e) => e.trim().toLowerCase())
        .filter(Boolean)
    : [];
  const list = parsed.length ? parsed : SALARY_ALLOWLIST_DEFAULT;
  return new Set(list.map((e) => e.toLowerCase()));
}

/**
 * Sme li `email` da vidi/menja zarade? True SAMO ako je na allowlisti.
 * Poziva se u SVAKOJ tački odluke o `kadrovska.salary` (guard + /me/permissions).
 */
export function salaryEmailAllowed(email: string | undefined | null): boolean {
  if (!email) return false;
  return salaryAllowlist().has(email.trim().toLowerCase());
}

/**
 * Effective permission decision for one (user, permission): combines the role
 * map with per-user overrides in the documented precedence **deny > grant >
 * rola** (AUTHZ_UNIFIED; `role-permissions.ts` header).
 *
 * The override is read FRESH from `user_permission_overrides` on each call —
 * NOT baked into the JWT — so a grant/deny added after the token was issued
 * takes effect on the next request without a re-login. (Same reasoning as
 * `resolveActorWorkerId`: a stale token must not freeze authorization.)
 *
 * Cost: one indexed point-select (`uq_user_permission_overrides` on
 * `(user_id, key)`). The guard calls this only on guarded routes; the deny
 * branch is why we cannot skip the read even when the role already grants —
 * an explicit deny must be able to revoke a role grant.
 */
export type EffectivePermissionDb = Pick<
  Prisma.TransactionClient,
  "userPermissionOverride"
>;

export type PermissionDecision = "allow" | "deny";

/**
 * Apply ALL of a user's overrides to the role-derived permission list — the
 * bulk sibling of `resolvePermissionDecision` for `GET /auth/me/permissions`.
 * Same precedence (deny > grant > rola): a deny row removes a role grant, a
 * grant row adds a key the role lacks. One row per key (`uq` on (userId,key))
 * so iteration order cannot flip a decision. Keeping this next to the guard's
 * resolver guarantees the FE `can()` and the backend 403 can never disagree.
 */
export function applyOverrides(
  rolePermissions: readonly string[],
  overrides: readonly { key: string; allow: boolean }[],
  email?: string,
): string[] {
  const set = new Set<string>(rolePermissions);
  for (const o of overrides) {
    if (o.allow) set.add(o.key);
    else set.delete(o.key);
  }
  // Tvrda brava na zarade: nezavisno od role/override, `kadrovska.salary` ostaje
  // SAMO allowlisti (Nenad+Nevena). Poslednji korak → nadjačava sve prethodno.
  if (!salaryEmailAllowed(email)) set.delete(PERMISSIONS.KADROVSKA_SALARY);
  return [...set];
}

export async function resolvePermissionDecision(
  db: EffectivePermissionDb,
  userId: number,
  role: string,
  key: PermissionKey,
  email?: string,
): Promise<PermissionDecision> {
  // Tvrda brava na zarade: `kadrovska.salary` sme SAMO allowlisti — presuđuje PRE
  // role/override, tako da ni `admin` rola ni grant override ne otvaraju plate.
  if (key === PERMISSIONS.KADROVSKA_SALARY && !salaryEmailAllowed(email)) {
    return "deny";
  }

  const override = await db.userPermissionOverride.findUnique({
    where: { userId_key: { userId, key } },
    select: { allow: true },
  });

  // deny (allow=false) beats everything, including a role grant.
  if (override?.allow === false) return "deny";
  // role grant, or an explicit grant (allow=true) for a role that lacks it.
  if (roleHasPermission(role, key)) return "allow";
  if (override?.allow === true) return "allow";
  return "deny";
}
