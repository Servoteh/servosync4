import { AuthController } from "./auth.controller";
import { OVERRIDE_KEYS, PERMISSIONS } from "../../common/authz/permissions";
import type { AuthService } from "./auth.service";
import type { AuthUser } from "./jwt.strategy";
import type { PrismaService } from "../../prisma/prisma.service";
import type { Sy15Service } from "../../common/sy15/sy15.service";

/**
 * GET /auth/me/permissions — override merge + allowlist self-heal (adversarni
 * review 20.07). Pinuje: (1) override grant dodaje ključ koji rola nema
 * (kadrovska.grid_edit — incident Mrkajić), deny skida rola-ključ; (2) reconcile
 * ogledala per-user kroz DEFINER fns: true→upsert (create grant, PRAZAN update —
 * postojeći red uklj. deny se NE prepisuje), false→deleteMany SAMO allow=true;
 * (3) pad sy15 NE obara odgovor (best-effort — rola + zatečeni override važe).
 */
const USER = { userId: 7, email: "nikola@x", role: "hr" } as AuthUser;

function makeCtl(opts: {
  storedOverrides?: { key: string; allow: boolean }[];
  sy15?: { grid: boolean; vacation: boolean };
  sy15Error?: unknown;
}) {
  const findMany = jest.fn().mockResolvedValue(opts.storedOverrides ?? []);
  const upsert = jest.fn().mockResolvedValue({});
  const deleteMany = jest.fn().mockResolvedValue({ count: 0 });
  const prisma = { userPermissionOverride: { findMany, upsert, deleteMany } };

  const withUserRls =
    opts.sy15Error !== undefined
      ? jest.fn().mockRejectedValue(opts.sy15Error)
      : jest.fn(async (_e: string, fn: (tx: unknown) => Promise<unknown>) =>
          fn({
            $queryRaw: jest.fn().mockResolvedValue([
              {
                grid: opts.sy15?.grid ?? false,
                vacation: opts.sy15?.vacation ?? false,
              },
            ]),
          }),
        );
  const sy15 = { withUserRls };

  const ctl = new AuthController(
    {} as AuthService,
    prisma as unknown as PrismaService,
    sy15 as unknown as Sy15Service,
  );
  return { ctl, findMany, upsert, deleteMany, withUserRls };
}

describe("mePermissions — override merge + allowlist reconcile", () => {
  it("hr bez override-a: rola-set BEZ grid_edit; reconcile false → deleteMany SAMO allow=true", async () => {
    const { ctl, deleteMany, upsert } = makeCtl({
      sy15: { grid: false, vacation: false },
    });
    const out = await ctl.mePermissions({ user: USER });
    expect(out.permissions).toContain(PERMISSIONS.KADROVSKA_READ);
    expect(out.permissions).not.toContain(PERMISSIONS.KADROVSKA_GRID_EDIT);
    expect(upsert).not.toHaveBeenCalled();
    // skida se samo mirror grant — deny redovi netaknuti
    expect(deleteMany).toHaveBeenCalledWith({
      where: {
        userId: 7,
        key: OVERRIDE_KEYS.KADROVSKA_GRID_EDIT,
        allow: true,
      },
    });
    expect(deleteMany).toHaveBeenCalledWith({
      where: {
        userId: 7,
        key: OVERRIDE_KEYS.KADROVSKA_VACATION_EDIT,
        allow: true,
      },
    });
  });

  it("hr na allowlisti (grid=true): upsert grant sa PRAZNIM update + permissions sadrži grid_edit", async () => {
    const { ctl, upsert } = makeCtl({
      sy15: { grid: true, vacation: false },
      storedOverrides: [{ key: PERMISSIONS.KADROVSKA_GRID_EDIT, allow: true }],
    });
    const out = await ctl.mePermissions({ user: USER });
    expect(out.permissions).toContain(PERMISSIONS.KADROVSKA_GRID_EDIT);
    expect(upsert).toHaveBeenCalledWith({
      where: {
        userId_key: {
          userId: 7,
          key: OVERRIDE_KEYS.KADROVSKA_GRID_EDIT,
        },
      },
      create: {
        userId: 7,
        key: OVERRIDE_KEYS.KADROVSKA_GRID_EDIT,
        allow: true,
      },
      update: {}, // postojeći red (uklj. eksplicitni deny) se NE prepisuje
    });
  });

  it("DENY override skida ključ koji rola daje (deny > grant > rola)", async () => {
    const { ctl } = makeCtl({
      sy15: { grid: false, vacation: false },
      storedOverrides: [{ key: PERMISSIONS.KADROVSKA_EDIT, allow: false }],
    });
    const out = await ctl.mePermissions({ user: USER });
    expect(out.permissions).not.toContain(PERMISSIONS.KADROVSKA_EDIT);
    expect(out.permissions).toContain(PERMISSIONS.KADROVSKA_READ);
  });

  it("pad sy15 NE obara odgovor: rola + zatečeni override i dalje važe (best-effort)", async () => {
    const { ctl, upsert, deleteMany } = makeCtl({
      sy15Error: new Error("sy15 down"),
      storedOverrides: [{ key: PERMISSIONS.KADROVSKA_GRID_EDIT, allow: true }],
    });
    const out = await ctl.mePermissions({ user: USER });
    expect(out.role).toBe("hr");
    expect(out.permissions).toContain(PERMISSIONS.KADROVSKA_GRID_EDIT); // zatečen grant
    expect(upsert).not.toHaveBeenCalled();
    expect(deleteMany).not.toHaveBeenCalled();
  });
});
