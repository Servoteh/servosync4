import { AuthService } from "./auth.service";
import type { PrismaService } from "../../prisma/prisma.service";
import type { JwtService } from "@nestjs/jwt";
import type { Sy15Service } from "../../common/sy15/sy15.service";
import type { Sy15AuthAdminService } from "../../common/sy15/sy15-auth-admin.service";

/**
 * ROLA-SYNC: 3.0 `users.role` prati ŽIVU 1.0 rolu (izvor istine = sy15 `user_roles`).
 *
 * Istorijat: SSO grana živi od 21.07 (odluka vlasnika). 27.07 (odluka Nenada)
 * proširena je na DIREKTAN login (email+lozinka) — dotad su nalozi koji ne ulaze
 * kroz 1.0 shell zadržavali zamrznutu rolu i role su odlutale (12 raskoraka).
 *
 * Pinovana pravila (`applyRoleSync`, zajednička za obe putanje):
 *  1. nema reda u 1.0 (`null`) → 3.0 rola se NE dira;
 *  2. ista rola → NEMA update (bez suvišnog pisanja);
 *  3. 3.0 `admin` se NE degradira (Zoran/Luka su namerno admini iako 1.0 kaže
 *     `menadzment`); podizanje NA admin prolazi normalno;
 *  4. inače → upiši živu 1.0 rolu (i naviše i naniže);
 *  5. pad čitanja 1.0 role → login NE pada, zadrži zatečenu rolu (fail-safe).
 *
 * Zarade su nezavisno zaključane (`salaryEmailAllowed`) — nije predmet ovog fajla.
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

/** Pozovi privatnu SSO granu sa stub-ovanim čitanjem žive 1.0 role. */
async function runSsoSync(
  svc: AuthService,
  user: { id: number; email: string; role: string },
  live: string | null | Error,
) {
  const spy = jest
    .spyOn(
      svc as unknown as {
        fetchSy15LiveRole: (t: string) => Promise<string | null>;
      },
      "fetchSy15LiveRole",
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

/** Pozovi privatnu granu DIREKTNOG login-a (čitanje 1.0 role po email-u). */
async function runLoginSync(
  svc: AuthService,
  user: { id: number; email: string; role: string },
  live: string | null | Error,
) {
  const spy = jest
    .spyOn(
      svc as unknown as {
        fetchSy15RoleByEmail: (e: string) => Promise<string | null>;
      },
      "fetchSy15RoleByEmail",
    )
    .mockImplementation(() =>
      live instanceof Error ? Promise.reject(live) : Promise.resolve(live),
    );
  const out = await (
    svc as unknown as {
      syncRoleByEmail: (u: unknown) => Promise<{ role: string }>;
    }
  ).syncRoleByEmail(user);
  spy.mockRestore();
  return out;
}

const USER = { id: 42, email: "zoran.jarakovic@servoteh.com", role: "admin" };

describe.each([
  ["SSO login", runSsoSync],
  ["direktan login (email+lozinka)", runLoginSync],
] as const)("AuthService rola-sync — %s", (_label, run) => {
  it("viša 1.0 rola (viewer → menadzment) → users.update na novu rolu", async () => {
    const { svc, update } = makeSvc();
    const out = await run(svc, { ...USER, role: "viewer" }, "menadzment");
    expect(update).toHaveBeenCalledWith({
      where: { id: 42 },
      data: { role: "menadzment" },
    });
    expect(out.role).toBe("menadzment");
  });

  it("niža 1.0 rola (menadzment → viewer) → spušta se", async () => {
    const { svc, update } = makeSvc();
    const out = await run(svc, { ...USER, role: "menadzment" }, "viewer");
    expect(update).toHaveBeenCalledWith({
      where: { id: 42 },
      data: { role: "viewer" },
    });
    expect(out.role).toBe("viewer");
  });

  it("3.0 admin se NE degradira (1.0 kaže menadzment) — odluka 27.07", async () => {
    const { svc, update } = makeSvc();
    const out = await run(svc, USER, "menadzment");
    expect(update).not.toHaveBeenCalled();
    expect(out.role).toBe("admin");
  });

  it("podizanje NA admin prolazi (pravilo je jednosmerno)", async () => {
    const { svc, update } = makeSvc();
    const out = await run(svc, { ...USER, role: "menadzment" }, "admin");
    expect(update).toHaveBeenCalledWith({
      where: { id: 42 },
      data: { role: "admin" },
    });
    expect(out.role).toBe("admin");
  });

  it("rola ista → NEMA update (bez suvišnog pisanja), vrati nalog netaknut", async () => {
    const { svc, update } = makeSvc();
    const out = await run(svc, { ...USER, role: "menadzment" }, "menadzment");
    expect(update).not.toHaveBeenCalled();
    expect(out.role).toBe("menadzment");
  });

  it("bez reda u 1.0 (null) → 3.0 rola netaknuta (ne pada na viewer)", async () => {
    const { svc, update } = makeSvc();
    const out = await run(svc, { ...USER, role: "poslovni_admin" }, null);
    expect(update).not.toHaveBeenCalled();
    expect(out.role).toBe("poslovni_admin");
  });

  it("pad čitanja 1.0 role → login NE pada, zadrži zatečenu rolu (fail-safe)", async () => {
    const { svc, update } = makeSvc();
    const out = await run(
      svc,
      { ...USER, role: "menadzment" },
      new Error("sy15 down"),
    );
    expect(update).not.toHaveBeenCalled();
    expect(out.role).toBe("menadzment"); // zatečena rola ostaje
  });
});

describe("AuthService rola-sync — dodatna polja naloga", () => {
  it("sync ne gubi polja koja Prisma `User` red nema (npr. readOnly)", async () => {
    const { svc } = makeSvc();
    const out = (await runLoginSync(
      svc,
      { ...USER, role: "viewer", readOnly: true, workerId: 7 } as never,
      "menadzment",
    )) as unknown as Record<string, unknown>;
    expect(out.role).toBe("menadzment");
    expect(out.readOnly).toBe(true);
    expect(out.workerId).toBe(7);
  });
});
