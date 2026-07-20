import { Prisma } from "@prisma/client";
import { roleHasPermission } from "./role-permissions";
import type { PermissionKey } from "./permissions";

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
): string[] {
  const set = new Set<string>(rolePermissions);
  for (const o of overrides) {
    if (o.allow) set.add(o.key);
    else set.delete(o.key);
  }
  return [...set];
}

export async function resolvePermissionDecision(
  db: EffectivePermissionDb,
  userId: number,
  role: string,
  key: PermissionKey,
): Promise<PermissionDecision> {
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
