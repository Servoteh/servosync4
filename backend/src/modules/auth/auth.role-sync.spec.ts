import { AuthService } from "./auth.service";
import type { PrismaService } from "../../prisma/prisma.service";
import type { JwtService } from "@nestjs/jwt";
import type { Sy15Service } from "../../common/sy15/sy15.service";
import type { Sy15AuthAdminService } from "../../common/sy15/sy15-auth-admin.service";

/**
 * ROLA-SYNC na SSO login (odluka vlasnika 21.07): postojeći nalog na svakom SSO
 * login-u dobija ŽIVU 1.0 rolu (izvor istine = sy15 user_roles). Pinuje:
 * (1) rola se promenila → users.update na novu rolu; (2) rola ista → NEMA update
 * (bez suvišnog pisanja); (3) pad čitanja 1.0 role → login NE pada, zadrži rolu
 * (fail-safe). Zarade su nezavisno zaključane (salaryEmailAllowed) — nije ovde.
 */
function makeSvc() {
  const update = jest.fn((arg: { data: { role: string } }) =>
    Promise.resolve({ id: 42, email: "x@y", role: arg.data.role }),
  );
  const prisma = { user: { update } } as unknown as PrismaService;
  const svc = new AuthService(
    prisma,
    {} as JwtService,
    {} as Sy15Service,
    {} as Sy15AuthAdminService,
  );
  return { svc, update };
}

// Pozovi privatnu syncRoleFromSy15 sa stub-ovanim fetchSy15EffectiveRole.
async function runSync(
  svc: AuthService,
  user: { id: number; email: string; role: string },
  live: string | Error,
) {
  const spy = jest
    .spyOn(
      svc as unknown as {
        fetchSy15EffectiveRole: (t: string) => Promise<string>;
      },
      "fetchSy15EffectiveRole",
    )
    .mockImplementation(() =>
      live instanceof Error ? Promise.reject(live) : Promise.resolve(live),
    );
  const out = await (
    svc as unknown as {
      syncRoleFromSy15: (t: string, u: unknown) => Promise<{ role: string }>;
    }
  ).syncRoleFromSy15("sso-token", user);
  spy.mockRestore();
  return out;
}

describe("AuthService rola-sync (SSO login → živa 1.0 rola)", () => {
  const USER = { id: 42, email: "zoran.jarakovic@servoteh.com", role: "admin" };

  it("rola se promenila (admin → menadzment) → users.update na novu rolu", async () => {
    const { svc, update } = makeSvc();
    const out = await runSync(svc, USER, "menadzment");
    expect(update).toHaveBeenCalledWith({
      where: { id: 42 },
      data: { role: "menadzment" },
    });
    expect(out.role).toBe("menadzment");
  });

  it("rola ista → NEMA update (bez suvišnog pisanja), vrati nalog netaknut", async () => {
    const { svc, update } = makeSvc();
    const out = await runSync(
      svc,
      { ...USER, role: "menadzment" },
      "menadzment",
    );
    expect(update).not.toHaveBeenCalled();
    expect(out.role).toBe("menadzment");
  });

  it("pad čitanja 1.0 role → login NE pada, zadrži zatečenu rolu (fail-safe)", async () => {
    const { svc, update } = makeSvc();
    const out = await runSync(svc, USER, new Error("sy15 down"));
    expect(update).not.toHaveBeenCalled();
    expect(out.role).toBe("admin"); // zatečena rola ostaje
  });
});
