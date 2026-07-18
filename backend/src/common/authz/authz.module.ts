import { Global, Module } from "@nestjs/common";
import { ScopeService } from "./scope.service";

/**
 * Global authz helpers (row-scope). `PermissionsGuard`/`RequirePermission` stay per-controller
 * (Reflector-based), but `ScopeService` is injectable anywhere a domain service needs to filter.
 */
@Global()
@Module({
  providers: [ScopeService],
  exports: [ScopeService],
})
export class AuthzModule {}
