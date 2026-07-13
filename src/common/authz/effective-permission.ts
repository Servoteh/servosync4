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
