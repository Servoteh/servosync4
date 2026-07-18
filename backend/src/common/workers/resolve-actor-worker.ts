import { Prisma } from "@prisma/client";

/**
 * Single source of truth for "which production worker is the caller?".
 *
 * The JWT carries `workerId` (`users.worker_id`) frozen at token-issue time.
 * When a user's worker link is created or changed AFTER their token was issued
 * — the common case for SSO-JIT accounts that get a worker linked later — the
 * token still says `workerId: null`, so any code that trusts the claim either
 * hard-rejects the action ("Nalog nije vezan za radnika") or silently records
 * the author as worker 0, until the user re-logs in. (Proba 13.07, Igor Voštić:
 * `handover-drafts.create()` hit exactly this.)
 *
 * This helper resolves the EFFECTIVE worker id: the JWT claim when present,
 * otherwise a fresh `users.worker_id` read by `userId`. So a link added after
 * the token was minted takes effect on the next request — no re-login needed.
 *
 * Returns a POSITIVE worker id, or `null` when the actor has no worker anywhere
 * (no actor, no userId, or `users.worker_id` still NULL). Callers decide what
 * `null` means: a hard 422 (identity required, e.g. take-over / designer) or a
 * `?? 0` fallback (audit author). It never returns 0 — `users.worker_id` is
 * `Int?` (positive-or-null), so a falsy claim cleanly means "no worker".
 */
export type ResolveActorWorkerDb = Pick<Prisma.TransactionClient, "user">;

/** Just the auth fields this resolver reads (structural — full `AuthUser` fits). */
export interface ActorWorkerRef {
  userId?: number;
  workerId?: number | null;
}

export async function resolveActorWorkerId(
  db: ResolveActorWorkerDb,
  actor: ActorWorkerRef | undefined,
): Promise<number | null> {
  // Trust the token when it already carries a worker — no DB round-trip.
  const claim = actor?.workerId ?? null;
  if (claim && claim > 0) return claim;

  // Stale/office token: fall back to the current users.worker_id.
  if (!actor?.userId) return null;
  const fresh = await db.user.findUnique({
    where: { id: actor.userId },
    select: { workerId: true },
  });
  const workerId = fresh?.workerId ?? null;
  return workerId && workerId > 0 ? workerId : null;
}
