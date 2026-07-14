import {
  CallHandler,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  NestInterceptor,
} from "@nestjs/common";
import { Observable } from "rxjs";

interface RequestLike {
  method: string;
  originalUrl?: string;
  url: string;
  user?: { userId: number };
}

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** POST routes that are pure reads (parse only) — allowed for read-only accounts. */
const READ_POST_SUFFIXES = ["/barcode/decode"];

export const READ_ONLY_MESSAGE =
  "Test nalog je samo za pregled — izmene nisu dozvoljene.";

/**
 * CSV of user ids from `AUTHZ_READONLY_USER_IDS` (same pattern as
 * AUTHZ_TEST_WORKER_IDS, ODLUKE #32). Read per call so a container restart with
 * an edited env applies immediately — existing tokens included, no re-login.
 */
export function isReadOnlyUserId(userId: number | null | undefined): boolean {
  if (!userId) return false;
  return (process.env.AUTHZ_READONLY_USER_IDS ?? "")
    .split(",")
    .map((s) => Number.parseInt(s.trim(), 10))
    .filter(Number.isFinite)
    .includes(userId);
}

/**
 * Read-only (test) accounts: every mutating request (POST/PUT/PATCH/DELETE)
 * gets 403 with a message the frontend surfaces as-is. Registered as a global
 * interceptor, so it runs AFTER the per-controller JwtAuthGuard populated
 * `req.user`; public routes (login/sso) have no `req.user` and pass through.
 */
@Injectable()
export class ReadOnlyInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<RequestLike>();
    if (!MUTATING.has(req.method) || !isReadOnlyUserId(req.user?.userId))
      return next.handle();

    const path = (req.originalUrl ?? req.url).split("?")[0];
    if (READ_POST_SUFFIXES.some((s) => path.endsWith(s)))
      return next.handle();

    throw new ForbiddenException(READ_ONLY_MESSAGE);
  }
}
