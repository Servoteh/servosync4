import {
  BadGatewayException,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { PodesavanjaUsersService } from "./podesavanja-users.service";
import { OVERRIDE_KEYS } from "../../common/authz/permissions";
import type { PrismaService } from "../../prisma/prisma.service";
import type { Sy15Service } from "../../common/sy15/sy15.service";
import type { Sy15AuthAdminService } from "../../common/sy15/sy15-auth-admin.service";

// bcrypt je spor (cost 10) i nebitan za logiku — mock ubrzava/determinizuje.
jest.mock("bcrypt", () => ({ hash: jest.fn(() => Promise.resolve("hashed")) }));

const ADMIN = "admin@servoteh.com";
const ROLE_ID = "3b241101-e2bb-4255-8caf-4136c566a962";

/** Tipovi mock-poziva (izbegava no-unsafe-* na jest `mock.calls`). */
interface UpsertCall {
  where: { email: string };
  create: Record<string, unknown>;
  update: Record<string, unknown>;
}
interface OvUpsertCall {
  create: { userId: number; key: string; allow: boolean };
}
interface OvDeleteCall {
  where: { userId: number; key: string };
}

/**
 * D1 dual-write: DOKAZ da (1) redosled je GoTrue→2.0→sy15, (2) 2.0 je master za edit, (3) delimičan
 * pad NE ostavlja zaključan nalog (roll-forward, sy15Synced:false), (4) self-lockout je odbijen,
 * (5) D2 override mapiranje je tačno, (6) idempotencija (GoTrue existing → created:false).
 */
describe("PodesavanjaUsersService (D1 dual-write)", () => {
  let svc: PodesavanjaUsersService;
  let order: string[];

  // ---- 2.0 (Prisma) mock ----
  let userUpsert: jest.Mock;
  let roleDeleteMany: jest.Mock;
  let roleCreate: jest.Mock;
  let ovUpsert: jest.Mock;
  let ovDeleteMany: jest.Mock;
  let tx2: unknown;
  let prisma: { $transaction: jest.Mock };

  // ---- sy15 mock ----
  let sy15QueryRaw: jest.Mock;
  let sy15ExecuteRaw: jest.Mock;
  let withUserRls: jest.Mock;
  let sy15: { withUserRls: jest.Mock };

  // ---- GoTrue mock ----
  let createUser: jest.Mock;
  let findUserIdByEmail: jest.Mock;
  let resetPassword: jest.Mock;
  let queueWelcomeEmail: jest.Mock;
  let authAdmin: unknown;

  beforeEach(() => {
    order = [];

    // Sync fn koje vraćaju Promise (izbegava require-await na mock-ovima bez await).
    userUpsert = jest.fn(() => Promise.resolve({ id: 42 }));
    roleDeleteMany = jest.fn(() => Promise.resolve({ count: 0 }));
    roleCreate = jest.fn(() => Promise.resolve({}));
    ovUpsert = jest.fn(() => Promise.resolve({}));
    ovDeleteMany = jest.fn(() => Promise.resolve({ count: 0 }));
    tx2 = {
      user: { upsert: userUpsert },
      userRole: { deleteMany: roleDeleteMany, create: roleCreate },
      userPermissionOverride: { upsert: ovUpsert, deleteMany: ovDeleteMany },
    };
    prisma = {
      $transaction: jest.fn((cb: (tx: unknown) => unknown) => {
        order.push("2.0");
        return cb(tx2);
      }),
    };

    // $queryRaw: default = jedan sy15 red (za resolveSy15Row); invite testovi ga override-uju na [{id}].
    sy15QueryRaw = jest.fn(() =>
      Promise.resolve([
        { email: "meta@servoteh.com", role: "viewer", is_active: true },
      ]),
    );
    sy15ExecuteRaw = jest.fn(() => Promise.resolve(1));
    withUserRls = jest.fn((_email: string, fn: (tx: unknown) => unknown) => {
      order.push("sy15");
      return fn({ $queryRaw: sy15QueryRaw, $executeRaw: sy15ExecuteRaw });
    });
    sy15 = { withUserRls };

    createUser = jest.fn(() => {
      order.push("gotrue");
      return Promise.resolve({ id: "auth-1", created: true });
    });
    findUserIdByEmail = jest.fn(() => Promise.resolve("auth-1"));
    resetPassword = jest.fn(() => Promise.resolve(undefined));
    queueWelcomeEmail = jest.fn(() => {
      order.push("welcome");
      return Promise.resolve();
    });
    authAdmin = {
      isConfigured: () => true,
      randomPassword: () => "rnd-pass",
      createUser,
      findUserIdByEmail,
      resetPassword,
      queueWelcomeEmail,
    };

    svc = new PodesavanjaUsersService(
      prisma as unknown as PrismaService,
      sy15 as unknown as Sy15Service,
      authAdmin as Sy15AuthAdminService,
    );
  });

  // ============ INVITE ============

  describe("invite", () => {
    const baseDto = {
      email: "New.User@Servoteh.com",
      role: "inzenjer",
      fullName: "Nova Osoba",
    };

    it("redosled = GoTrue → 2.0 → sy15 → welcome; email normalizovan; must_change=true", async () => {
      sy15QueryRaw.mockResolvedValueOnce([{ id: "role-1" }]);
      const res = await svc.invite(ADMIN, baseDto);

      expect(order).toEqual(["gotrue", "2.0", "sy15", "welcome"]);
      expect(res.data.authUserId).toBe("auth-1");
      expect(res.data.sy15Synced).toBe(true);
      // 2.0 upsert: email lowercase, create postavlja must_change_password=true.
      const arg = (userUpsert.mock.calls as Array<[UpsertCall]>)[0][0];
      expect(arg.where.email).toBe("new.user@servoteh.com");
      expect(arg.create.mustChangePassword).toBe(true);
      expect(roleCreate).toHaveBeenCalledTimes(1); // global rola postavljena
    });

    it("GoTrue pad → 2.0 i sy15 se NE pišu (abort, ništa grantovano)", async () => {
      createUser.mockRejectedValueOnce(new BadGatewayException("gotrue down"));
      await expect(svc.invite(ADMIN, baseDto)).rejects.toBeInstanceOf(
        BadGatewayException,
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(withUserRls).not.toHaveBeenCalled();
    });

    it("idempotencija: GoTrue već postoji → created:false, tok se dovrši", async () => {
      createUser.mockResolvedValueOnce({ id: "auth-1", created: false });
      sy15QueryRaw.mockResolvedValueOnce([{ id: "role-1" }]);
      const res = await svc.invite(ADMIN, baseDto);
      expect(res.data.authCreated).toBe(false);
      expect(res.data.sy15Synced).toBe(true);
    });

    it("sy15 insert pad → sy15Synced:false ALI 2.0+GoTrue prošli i welcome poslat (NEMA lockout)", async () => {
      sy15QueryRaw.mockRejectedValueOnce(new Error("sy15 insert failed"));
      const res = await svc.invite(ADMIN, baseDto);
      expect(res.data.authUserId).toBe("auth-1"); // GoTrue OK
      expect(prisma.$transaction).toHaveBeenCalledTimes(1); // 2.0 master OK
      expect(res.data.sy15Synced).toBe(false); // 1.0 nije sinhronizovan — retry
      expect(queueWelcomeEmail).toHaveBeenCalledTimes(1);
    });

    it("D2 override mapiranje: readonly→deny, access→grant, hide=false→brisanje", async () => {
      sy15QueryRaw.mockResolvedValueOnce([{ id: "role-1" }]);
      await svc.invite(ADMIN, {
        ...baseDto,
        planMontazeReadonly: true,
        kadrovskaAccess: true,
        kadrovskaHideContracts: false,
      });
      const upserts = (ovUpsert.mock.calls as Array<[OvUpsertCall]>).map(
        (c) => c[0].create,
      );
      // Kanonski ključevi (H2): montaza.edit / kadrovska.read (NE plan_montaze.write/kadrovska.access).
      expect(OVERRIDE_KEYS.MONTAZA_EDIT).toBe("montaza.edit");
      expect(OVERRIDE_KEYS.KADROVSKA_READ).toBe("kadrovska.read");
      expect(upserts).toEqual(
        expect.arrayContaining([
          { userId: 42, key: OVERRIDE_KEYS.MONTAZA_EDIT, allow: false },
          { userId: 42, key: OVERRIDE_KEYS.KADROVSKA_READ, allow: true },
        ]),
      );
      // hide_contracts=false → override red se BRIŠE (pada na rolu).
      const deleted = (ovDeleteMany.mock.calls as Array<[OvDeleteCall]>).map(
        (c) => c[0].where.key,
      );
      expect(deleted).toContain(OVERRIDE_KEYS.KADROVSKA_CONTRACTS_READ);
    });

    it("nepoznata uloga → 400 pre ijednog upisa", async () => {
      await expect(
        svc.invite(ADMIN, { ...baseDto, role: "izmisljena_rola" }),
      ).rejects.toMatchObject({ status: 400 });
      expect(createUser).not.toHaveBeenCalled();
    });
  });

  // ============ UPDATE (2.0 master) ============

  describe("update", () => {
    it("redosled: resolve(sy15 read) → 2.0 master → sy15 write", async () => {
      await svc.update(ADMIN, ROLE_ID, { role: "pm", fullName: "Ime" });
      // withUserRls #1 = resolve (read), zatim 2.0 master, zatim withUserRls #2 = write.
      expect(order).toEqual(["sy15", "2.0", "sy15"]);
      expect(userUpsert).toHaveBeenCalledTimes(1);
    });

    it("2.0 master pad → sy15 write se NE dešava (samo resolve), greška se propagira", async () => {
      prisma.$transaction.mockImplementationOnce(() => {
        order.push("2.0");
        return Promise.reject(new Error("2.0 down"));
      });
      await expect(
        svc.update(ADMIN, ROLE_ID, { fullName: "X" }),
      ).rejects.toThrow("2.0 down");
      // Samo resolve prošao kroz withUserRls; propagacija (write) nije ni pokušana.
      expect(withUserRls).toHaveBeenCalledTimes(1);
      expect(sy15ExecuteRaw).not.toHaveBeenCalled();
    });

    it("sy15 write pad → master primenjen, sy15Synced:false (NEMA lockout)", async () => {
      sy15ExecuteRaw.mockRejectedValueOnce(new Error("sy15 update failed"));
      const res = await svc.update(ADMIN, ROLE_ID, { role: "pm" });
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(res.data.sy15Synced).toBe(false);
    });

    it("42501 na sy15 write → sy15Synced:false sa jasnom porukom (ne 500)", async () => {
      sy15ExecuteRaw.mockRejectedValueOnce({ meta: { code: "42501" } });
      const res = await svc.update(ADMIN, ROLE_ID, { role: "pm" });
      expect(res.data.sy15Synced).toBe(false);
      expect(res.data.sy15Error).toMatch(/sy15/i);
    });

    it("nepostojeći red → 404", async () => {
      sy15QueryRaw.mockResolvedValueOnce([]);
      await expect(
        svc.update(ADMIN, ROLE_ID, { role: "pm" }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ============ SELF-LOCKOUT (bezbednosna provera) ============

  describe("self-lockout guard", () => {
    it("deaktivacija SEBE → 422 (ništa se ne piše)", async () => {
      sy15QueryRaw.mockResolvedValueOnce([
        { email: ADMIN, role: "admin", is_active: true },
      ]);
      await expect(svc.deactivate(ADMIN, ROLE_ID)).rejects.toBeInstanceOf(
        UnprocessableEntityException,
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it("skidanje admin uloge SEBI → 422", async () => {
      sy15QueryRaw.mockResolvedValueOnce([
        { email: ADMIN, role: "admin", is_active: true },
      ]);
      await expect(
        svc.update(ADMIN, ROLE_ID, { role: "viewer" }),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it("izmena TUĐEG naloga je dozvoljena", async () => {
      sy15QueryRaw.mockResolvedValueOnce([
        { email: "drugi@servoteh.com", role: "admin", is_active: true },
      ]);
      const res = await svc.update(ADMIN, ROLE_ID, { role: "viewer" });
      expect(res.data.email).toBe("drugi@servoteh.com");
    });
  });

  // ============ DEACTIVATE / DELETE (soft) ============

  describe("deactivate / soft-delete", () => {
    it("deactivate: 2.0 upsert active:false (zatvara JIT rupu) pa sy15 is_active", async () => {
      sy15QueryRaw.mockResolvedValueOnce([
        { email: "u@servoteh.com", role: "viewer", is_active: true },
      ]);
      const res = await svc.deactivate(ADMIN, ROLE_ID);
      expect(res.data.active).toBe(false);
      const upsertArg = (userUpsert.mock.calls as Array<[UpsertCall]>)[0][0];
      expect(upsertArg.update.active).toBe(false);
      expect(upsertArg.create.active).toBe(false); // create-grana (2.0 red fali) = active:false
    });

    it("soft-delete traži tačan confirmEmail; pogrešan → 422", async () => {
      sy15QueryRaw.mockResolvedValue([
        { email: "u@servoteh.com", role: "viewer", is_active: true },
      ]);
      await expect(
        svc.softDelete(ADMIN, ROLE_ID, { confirmEmail: "wrong@x.com" }),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
      // tačan email → soft (deactivate)
      const res = await svc.softDelete(ADMIN, ROLE_ID, {
        confirmEmail: "U@Servoteh.com",
      });
      expect(res.data.deleted).toBe("soft");
      expect(res.data.active).toBe(false);
    });
  });

  // ============ RESET / must_change ============

  describe("reset-password", () => {
    it("GoTrue reset (A) → flag oba sveta → reset mejl; bez GoTrue naloga → 404", async () => {
      sy15QueryRaw.mockResolvedValueOnce([
        { email: "u@servoteh.com", role: "viewer", is_active: true },
      ]);
      const res = await svc.resetPassword(ADMIN, ROLE_ID, {});
      expect(resetPassword).toHaveBeenCalledWith("auth-1", "rnd-pass");
      expect(res.data.reset).toBe(true);
      expect(queueWelcomeEmail).toHaveBeenCalledWith(
        "u@servoteh.com",
        "",
        true,
      );

      // GoTrue nalog ne postoji → 404, bez menjanja lozinke
      findUserIdByEmail.mockResolvedValueOnce(null);
      sy15QueryRaw.mockResolvedValueOnce([
        { email: "u@servoteh.com", role: "viewer", is_active: true },
      ]);
      await expect(
        svc.resetPassword(ADMIN, ROLE_ID, {}),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe("must-change-password", () => {
    it("postavlja flag u oba sveta", async () => {
      sy15QueryRaw.mockResolvedValueOnce([
        { email: "u@servoteh.com", role: "viewer", is_active: true },
      ]);
      const res = await svc.setMustChangePassword(ADMIN, ROLE_ID, {
        value: true,
      });
      expect(res.data.mustChangePassword).toBe(true);
      expect(
        (userUpsert.mock.calls as Array<[UpsertCall]>)[0][0].update
          .mustChangePassword,
      ).toBe(true);
      expect(sy15ExecuteRaw).toHaveBeenCalledTimes(1);
    });
  });

  // ============ ROLE-INVARIJANTA (adversarni review H1) ============
  // Flag-operacije (reset/deactivate/activate/must-change) NE smeju da prepišu KURIRANU 2.0
  // users.role sy15 rolom → nema eskalacije (viewer←menadzment) ni tihog spuštanja (leadpm→viewer).
  // Dokaz na mock sloju: `update` payload NEMA `role` ključ (Prisma tada ostavlja users.role netaknut),
  // i global UserRole se NE rekreira (roleCreate 0×).

  describe("role-invarijanta na flag-operacijama (H1)", () => {
    const upd = () =>
      (userUpsert.mock.calls as Array<[UpsertCall]>)[0][0].update;

    it("reset NE menja 2.0 users.role (kurirani leadpm ostaje leadpm)", async () => {
      // sy15 rola = viewer, a 2.0 kurirana = leadpm; reset ne sme da spusti 2.0 na viewer.
      sy15QueryRaw.mockResolvedValueOnce([
        { email: "u@servoteh.com", role: "viewer", is_active: true },
      ]);
      await svc.resetPassword(ADMIN, ROLE_ID, {});
      expect(upd()).not.toHaveProperty("role");
      expect(roleCreate).not.toHaveBeenCalled();
    });

    it("deactivate NE menja 2.0 users.role (kurirani viewer ne dobija menadzment)", async () => {
      // sy15 rola = menadzment; deaktivacija ne sme da eskalira 2.0 viewer→menadzment.
      sy15QueryRaw.mockResolvedValueOnce([
        { email: "u@servoteh.com", role: "menadzment", is_active: true },
      ]);
      await svc.deactivate(ADMIN, ROLE_ID);
      expect(upd()).not.toHaveProperty("role");
      expect(roleCreate).not.toHaveBeenCalled();
    });

    it("activate NE menja 2.0 users.role", async () => {
      sy15QueryRaw.mockResolvedValueOnce([
        { email: "u@servoteh.com", role: "menadzment", is_active: false },
      ]);
      await svc.activate(ADMIN, ROLE_ID);
      expect(upd()).not.toHaveProperty("role");
      expect(roleCreate).not.toHaveBeenCalled();
    });

    it("must-change NE menja 2.0 users.role", async () => {
      sy15QueryRaw.mockResolvedValueOnce([
        { email: "u@servoteh.com", role: "menadzment", is_active: true },
      ]);
      await svc.setMustChangePassword(ADMIN, ROLE_ID, { value: true });
      expect(upd()).not.toHaveProperty("role");
      expect(roleCreate).not.toHaveBeenCalled();
    });

    it("scope-only edit (bez dto.role) NE menja users.role, ali rekreira UserRole iz user.role", async () => {
      sy15QueryRaw.mockResolvedValueOnce([
        { email: "u@servoteh.com", role: "viewer", is_active: true },
      ]);
      // user.upsert vraća kurirani leadpm (post-upsert) → UserRole se rekreira sa leadpm, ne sy15 viewer.
      userUpsert.mockResolvedValueOnce({ id: 42, role: "leadpm" });
      await svc.update(ADMIN, ROLE_ID, { managedSubDepartmentIds: [3, 7] });
      expect(upd()).not.toHaveProperty("role"); // users.role NIJE dirana
      expect(roleCreate).toHaveBeenCalledTimes(1); // scope promena → UserRole rekreiran
      const roleArg = (
        roleCreate.mock.calls as Array<[{ data: { role: string } }]>
      )[0][0].data;
      expect(roleArg.role).toBe("leadpm"); // iz user.role, NE sy15 viewer
    });

    it("PATCH sa role DOZVOLJAVA promenu users.role (kontrola)", async () => {
      sy15QueryRaw.mockResolvedValueOnce([
        { email: "u@servoteh.com", role: "viewer", is_active: true },
      ]);
      await svc.update(ADMIN, ROLE_ID, { role: "pm" });
      expect(upd().role).toBe("pm");
    });
  });
});
