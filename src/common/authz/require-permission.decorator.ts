import { SetMetadata } from "@nestjs/common";
import type { PermissionKey } from "./permissions";

export const PERMISSION_KEY_METADATA = "required_permission";

/**
 * Deklariše permisiju endpointa (katalog: `permissions.ts`).
 * V1: `PermissionsGuard` je no-op — dekorator samo obeležava; V2 aktivacija
 * = uključivanje logike u guardu, bez izmene kontrolera (RBAC_RLS_PREDLOG §5).
 */
export const RequirePermission = (permission: PermissionKey) =>
  SetMetadata(PERMISSION_KEY_METADATA, permission);
