import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { PERMISSION_KEY_METADATA } from "./require-permission.decorator";

/**
 * V1: NO-OP guard — pušta sve autentikovane korisnike (BACKEND_RULES §7: svi su ADMIN).
 * V2 aktivacija: user→role→permisije lookup (RBAC_RLS_PREDLOG §5) umesto `return true`.
 * Registruje se uz `JwtAuthGuard` na kontrolerima koji nose `@RequirePermission`.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  private readonly logger = new Logger(PermissionsGuard.name);

  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<string | undefined>(
      PERMISSION_KEY_METADATA,
      [context.getHandler(), context.getClass()],
    );
    if (required) {
      // V1: samo debug trag da je ključ deklarisan; nema odbijanja.
      this.logger.debug(`Permission "${required}" declared (V1 no-op, allow).`);
    }
    return true;
  }
}
