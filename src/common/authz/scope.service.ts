import { Injectable, Logger } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import type { AuthUser } from "../../modules/auth/jwt.strategy";
import { ROLES } from "./roles";

/**
 * Row-scope layer (AUTHZ_UNIFIED §5/§6 Sloj 2; RBAC_RLS_PREDLOG §5). Domain services call
 * these builders to add a Prisma `where` for the current user — the SAME semantics that
 * 3.0 RLS policies will express via the `app_*` predicate functions (one source of truth).
 *
 * ALWAYS ON (unlike the permission guard's shadow mode): this filters actual query results.
 * Safe to deploy now because the only restricted role is `proizvodni_radnik`, and no such
 * account exists yet. `admin`/`sef`/`tehnolog`/`cnc_programer`/`kontrolor`/`menadzment`/
 * `magacioner` see the full module (RBAC §3.1: no row-scope within TEHNOLOGIJA for them).
 */
@Injectable()
export class ScopeService {
  private readonly logger = new Logger(ScopeService.name);

  constructor(private readonly prisma: PrismaService) {}

  private isRadnik(user: AuthUser): boolean {
    return user.role.trim().toLowerCase() === ROLES.PROIZVODNI_RADNIK;
  }

  /**
   * Work-center codes the user's linked Worker may operate (`machine_access`).
   * Empty if the user has no worker link or no assignments.
   */
  async machineAccessCodes(user: AuthUser): Promise<string[]> {
    if (!user.workerId) return [];
    const rows = await this.prisma.machineAccess.findMany({
      where: { workerId: user.workerId },
      select: { workCenterCode: true },
    });
    return rows.map((r) => r.workCenterCode);
  }

  /**
   * TechProcess visibility. `proizvodni_radnik` → only rows on their machines
   * (empty set = sees nothing, fail-closed); every other (already read-authorised) role → unrestricted.
   */
  async techProcessScope(user: AuthUser): Promise<Prisma.TechProcessWhereInput> {
    if (!this.isRadnik(user)) return {};
    const codes = await this.machineAccessCodes(user);
    if (codes.length === 0) {
      this.logger.warn(
        `proizvodni_radnik user=${user.userId} has no machine_access (workerId=${user.workerId ?? "null"}) → sees no tech processes`,
      );
    }
    return { workCenterCode: { in: codes } };
  }

  /**
   * Compose a base filter with the user's scope (AND). Use in services:
   *   where: await scope.withTechProcessScope(user, filterWhere)
   */
  async withTechProcessScope(
    user: AuthUser | undefined,
    base: Prisma.TechProcessWhereInput,
  ): Promise<Prisma.TechProcessWhereInput> {
    if (!user) return base;
    const scope = await this.techProcessScope(user);
    // Nothing to add for unrestricted roles.
    if (Object.keys(scope).length === 0) return base;
    return { AND: [base, scope] };
  }
}
