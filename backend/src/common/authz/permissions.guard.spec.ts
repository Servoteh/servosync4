import { ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { PermissionsGuard } from "./permissions.guard";
import { PrismaService } from "../../prisma/prisma.service";
import { PERMISSIONS as P } from "./permissions";
import { ROLES } from "./roles";

/** ExecutionContext koji vraća datog usera (traženu permisiju daje Reflector mock). */
function ctx(
  user: { userId: number; email: string; role: string } | undefined,
): ExecutionContext {
  return {
    getHandler: () => undefined,
    getClass: () => undefined,
    switchToHttp: () => ({
      getRequest: () => ({ user, method: "POST", url: "/x" }),
    }),
  } as unknown as ExecutionContext;
}

function makeGuard(
  required: string | undefined,
  override: { allow: boolean } | null,
) {
  const reflector = {
    getAllAndOverride: jest.fn().mockReturnValue(required),
  } as unknown as Reflector;
  const findUnique = jest.fn().mockResolvedValue(override);
  const prisma = {
    userPermissionOverride: { findUnique },
  } as unknown as PrismaService;
  const guard = new PermissionsGuard(reflector, prisma);
  return { guard, findUnique };
}

const USER = { userId: 1, email: "u@x", role: ROLES.INZENJER };
const APPROVE = P.PRIMOPREDAJE_APPROVE;

describe("PermissionsGuard (override-aware)", () => {
  const OLD = process.env.AUTHZ_ENFORCE;
  afterEach(() => {
    process.env.AUTHZ_ENFORCE = OLD;
  });

  it("bez @RequirePermission → prolaz (nema šta da se procenjuje)", async () => {
    const { guard } = makeGuard(undefined, null);
    expect(await guard.canActivate(ctx(USER))).toBe(true);
  });

  it("bez usera → prolaz (autentifikacija je tuđi posao)", async () => {
    const { guard } = makeGuard(APPROVE, null);
    expect(await guard.canActivate(ctx(undefined))).toBe(true);
  });

  it("ENFORCE: rola daje → allow", async () => {
    process.env.AUTHZ_ENFORCE = "true";
    const { guard } = makeGuard(APPROVE, null);
    const c = ctx({ ...USER, role: ROLES.MENADZMENT });
    expect(await guard.canActivate(c)).toBe(true);
  });

  it("ENFORCE: rola NE daje, GRANT override → allow", async () => {
    process.env.AUTHZ_ENFORCE = "true";
    const { guard, findUnique } = makeGuard(APPROVE, { allow: true });
    expect(await guard.canActivate(ctx(USER))).toBe(true);
    expect(findUnique).toHaveBeenCalled();
  });

  it("ENFORCE: rola NE daje, nema override → DENY (403)", async () => {
    process.env.AUTHZ_ENFORCE = "true";
    const { guard } = makeGuard(APPROVE, null);
    expect(await guard.canActivate(ctx(USER))).toBe(false);
  });

  it("ENFORCE: rola daje ali DENY override → DENY (deny beat rola)", async () => {
    process.env.AUTHZ_ENFORCE = "true";
    const { guard } = makeGuard(APPROVE, { allow: false });
    const c = ctx({ ...USER, role: ROLES.MENADZMENT });
    expect(await guard.canActivate(c)).toBe(false);
  });

  it("SHADOW (enforce=false): rola NE daje → ipak allow (samo loguje)", async () => {
    process.env.AUTHZ_ENFORCE = "false";
    const { guard } = makeGuard(APPROVE, null);
    expect(await guard.canActivate(ctx(USER))).toBe(true);
  });
});
