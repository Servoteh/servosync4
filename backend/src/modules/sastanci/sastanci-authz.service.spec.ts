import { SastanciAuthzService } from "./sastanci-authz.service";
import type { PrismaService } from "../../prisma/prisma.service";

/**
 * Paritet sy15 gejtova prava nad 3.0 `users` / `user_roles`.
 *
 * 🔴 ZAŠTO OVI TESTOVI POSTOJE: u sy15 su ova prava sprovodile RLS politike, pa
 * ih kod NIJE duplirao. Pod `3.0` RLS-a nema — ako se ovde nešto olabavi, prava
 * TIHO nestaju (svi vide/menjaju sve), a to se ne vidi ni u jednom drugom testu.
 */

function prismaStub(opts: {
  user?: { id: number; role: string } | null;
  extraRoles?: string[];
  ucesnikCount?: number;
  moverCount?: number;
}) {
  return {
    user: {
      findFirst: jest.fn().mockResolvedValue(opts.user ?? null),
      findMany: jest.fn().mockResolvedValue([]),
    },
    userRole: {
      findMany: jest
        .fn()
        .mockResolvedValue((opts.extraRoles ?? []).map((role) => ({ role }))),
    },
    sastanakUcesnik: {
      count: jest.fn().mockResolvedValue(opts.ucesnikCount ?? 0),
    },
    sastWeeklyMover: {
      count: jest.fn().mockResolvedValue(opts.moverCount ?? 0),
    },
  } as unknown as PrismaService;
}

const svc = (p: PrismaService) => new SastanciAuthzService(p);

describe("isManagement — paritet current_user_is_management()", () => {
  it("admin i menadzment prolaze", async () => {
    for (const role of ["admin", "menadzment"]) {
      const s = svc(prismaStub({ user: { id: 1, role } }));
      expect(await s.isManagement("a@servoteh.com")).toBe(true);
    }
  });

  it("sef/tehnolog/proizvodni_radnik NE prolaze", async () => {
    for (const role of ["sef", "tehnolog", "proizvodni_radnik", "pm"]) {
      const s = svc(prismaStub({ user: { id: 1, role } }));
      expect(await s.isManagement("a@servoteh.com")).toBe(false);
    }
  });

  it("🔴 gleda I dodatne globalne role, ne samo primarnu users.role", async () => {
    // sy15 je imao JEDNU tabelu `user_roles`; 3.0 ima `users.role` + `user_roles`.
    // Bez unije bi korisnik sa menadžmentskom rolom u `user_roles` izgubio pravo
    // koje je u sy15 imao.
    const s = svc(
      prismaStub({ user: { id: 1, role: "sef" }, extraRoles: ["menadzment"] }),
    );
    expect(await s.isManagement("a@servoteh.com")).toBe(true);
  });

  it("neaktivan/nepostojeći korisnik i prazan mejl → false", async () => {
    expect(await svc(prismaStub({ user: null })).isManagement("x@y.com")).toBe(false);
    expect(await svc(prismaStub({})).isManagement("")).toBe(false);
    expect(await svc(prismaStub({})).isManagement(null)).toBe(false);
  });

  it("prazan mejl ne dira bazu (ne curi upit po praznom ključu)", async () => {
    const p = prismaStub({});
    await svc(p).isManagement("   ");
    expect(p.user.findFirst).not.toHaveBeenCalled();
  });
});

describe("hasEditRole — paritet has_edit_role()", () => {
  it("skup je ŠIRI od menadžmenta: admin/hr/menadzment/pm/leadpm/poslovni_admin", async () => {
    for (const role of [
      "admin",
      "hr",
      "menadzment",
      "pm",
      "leadpm",
      "poslovni_admin",
    ]) {
      const s = svc(prismaStub({ user: { id: 1, role } }));
      expect(await s.hasEditRole("a@servoteh.com")).toBe(true);
    }
  });

  it("sef i proizvodni_radnik nemaju edit pravo nad sastancima", async () => {
    for (const role of ["sef", "proizvodni_radnik", "magacioner", "kontrolor"]) {
      const s = svc(prismaStub({ user: { id: 1, role } }));
      expect(await s.hasEditRole("a@servoteh.com")).toBe(false);
    }
  });
});

describe("isAdmin — paritet current_user_is_admin()", () => {
  it("SAMO admin (menadzment nije admin)", async () => {
    expect(
      await svc(prismaStub({ user: { id: 1, role: "admin" } })).isAdmin("a@b.com"),
    ).toBe(true);
    expect(
      await svc(prismaStub({ user: { id: 1, role: "menadzment" } })).isAdmin("a@b.com"),
    ).toBe(false);
  });
});

describe("isUcesnik — paritet is_sastanak_ucesnik(uuid)", () => {
  it("poklapanje po lower(email) unutar jednog sastanka", async () => {
    const p = prismaStub({ ucesnikCount: 1 });
    expect(await svc(p).isUcesnik("A@Servoteh.com", "s-1")).toBe(true);
    expect(p.sastanakUcesnik.count).toHaveBeenCalledWith({
      where: {
        sastanakId: "s-1",
        email: { equals: "a@servoteh.com", mode: "insensitive" },
      },
    });
  });

  it("bez sastanka ili bez mejla → false, bez upita", async () => {
    const p = prismaStub({ ucesnikCount: 1 });
    expect(await svc(p).isUcesnik("a@b.com", null)).toBe(false);
    expect(await svc(p).isUcesnik("", "s-1")).toBe(false);
    expect(p.sastanakUcesnik.count).not.toHaveBeenCalled();
  });
});

describe("canMoveWeekly — paritet sast_user_can_move_weekly()", () => {
  it("🔴 gejt je ALLOWLIST tabela, NE rola — admin bez reda ne prolazi", async () => {
    const s = svc(prismaStub({ user: { id: 1, role: "admin" }, moverCount: 0 }));
    expect(await s.canMoveWeekly("admin@servoteh.com")).toBe(false);
  });

  it("red u sast_weekly_movers prolazi i bez ijedne role", async () => {
    const s = svc(prismaStub({ user: null, moverCount: 1 }));
    expect(await s.canMoveWeekly("bilo.ko@servoteh.com")).toBe(true);
  });
});
