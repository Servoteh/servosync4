import { PodesavanjaUsersService } from "./podesavanja-users.service";
import { OVERRIDE_KEYS } from "../../common/authz/permissions";
import type { PrismaService } from "../../prisma/prisma.service";
import type { Sy15Service } from "../../common/sy15/sy15.service";
import type { Sy15AuthAdminService } from "../../common/sy15/sy15-auth-admin.service";

jest.mock("bcrypt", () => ({ hash: jest.fn(() => Promise.resolve("hashed")) }));

const ADMIN = "admin@servoteh.com";

/**
 * P13 (#44) — override backfill: DOKAZ da (1) mapiranje kroz D2_OVERRIDE_MAP je tačno
 * (planMontazeReadonly→montaza.edit/deny, kadrovskaAccess→kadrovska.read/grant,
 * kadrovskaHideContracts→kadrovska.contracts_read/deny); (2) bool=false BRIŠE override (idempotencija —
 * pada na rolu); (3) agregacija po email-u (OR preko aktivnih redova); (4) scope managed_sub_department_ids
 * → global UserRole; (5) bez 2.0 naloga → skippedNoUser; (6) ponovljeno pokretanje KONVERGIRA (upsert/delete,
 * bez duplikata).
 */
interface OvUpsertCall {
  where: { userId_key: { userId: number; key: string } };
  create: { userId: number; key: string; allow: boolean };
  update: { allow: boolean };
}
interface OvDeleteCall {
  where: { userId: number; key: string };
}
interface RoleUpdCall {
  where: { userId: number; scopeType: string };
  data: { managedSubDepartmentIds: number[] };
}

function makeSvc(opts: {
  sy15Rows: unknown[];
  userByEmail: Record<string, { id: number } | null>;
}) {
  const ovUpsert = jest.fn((_arg: OvUpsertCall) => Promise.resolve({}));
  const ovDeleteMany = jest.fn((_arg: OvDeleteCall) =>
    Promise.resolve({ count: 0 }),
  );
  const userFindUnique = jest.fn((arg: { where: { email: string } }) =>
    Promise.resolve(opts.userByEmail[arg.where.email] ?? null),
  );
  const roleUpdateMany = jest.fn((_arg: RoleUpdCall) =>
    Promise.resolve({ count: 1 }),
  );

  const tx2 = {
    user: { findUnique: userFindUnique },
    userPermissionOverride: { upsert: ovUpsert, deleteMany: ovDeleteMany },
    userRole: { updateMany: roleUpdateMany },
  };
  const prisma = {
    $transaction: jest.fn((cb: (tx: unknown) => unknown) => cb(tx2)),
  };

  const sy15QueryRaw = jest.fn(() => Promise.resolve(opts.sy15Rows));
  const withUserRls = jest.fn((_e: string, fn: (tx: unknown) => unknown) =>
    fn({ $queryRaw: sy15QueryRaw, $executeRaw: jest.fn(() => Promise.resolve(1)) }),
  );
  const sy15 = { withUserRls };
  const authAdmin = {
    isConfigured: () => true,
    randomPassword: () => "rnd",
  };

  const svc = new PodesavanjaUsersService(
    prisma as unknown as PrismaService,
    sy15 as unknown as Sy15Service,
    authAdmin as Sy15AuthAdminService,
  );
  return { svc, ovUpsert, ovDeleteMany, roleUpdateMany, userFindUnique };
}

describe("PodesavanjaUsersService.backfillOverrides (#44)", () => {
  it("mapiranje: 3 flag=true → montaza.edit/deny + kadrovska.read/grant + contracts/deny", async () => {
    const { svc, ovUpsert } = makeSvc({
      sy15Rows: [
        {
          email: "Sef@X",
          is_active: true,
          plan_montaze_readonly: true,
          kadrovska_access: true,
          kadrovska_hide_contracts: true,
          managed_sub_department_ids: null,
        },
      ],
      userByEmail: { "sef@x": { id: 7 } },
    });
    const out = await svc.backfillOverrides(ADMIN);
    const calls = ovUpsert.mock.calls.map((c) => c[0] as OvUpsertCall);
    const byKey = new Map(calls.map((c) => [c.create.key, c.create.allow]));
    expect(byKey.get(OVERRIDE_KEYS.MONTAZA_EDIT)).toBe(false); // deny edit
    expect(byKey.get(OVERRIDE_KEYS.KADROVSKA_READ)).toBe(true); // grant
    expect(byKey.get(OVERRIDE_KEYS.KADROVSKA_CONTRACTS_READ)).toBe(false); // deny
    expect((out.data as { overridesUpserted: number }).overridesUpserted).toBe(3);
    // svaki upsert nišani (userId,key) — idempotentno
    for (const c of calls)
      expect(c.where.userId_key).toEqual({ userId: 7, key: c.create.key });
  });

  it("flag=false → BRIŠE override (idempotencija — pada na rolu)", async () => {
    const { svc, ovUpsert, ovDeleteMany } = makeSvc({
      sy15Rows: [
        {
          email: "a@x",
          is_active: true,
          plan_montaze_readonly: false,
          kadrovska_access: false,
          kadrovska_hide_contracts: false,
          managed_sub_department_ids: null,
        },
      ],
      userByEmail: { "a@x": { id: 3 } },
    });
    const out = await svc.backfillOverrides(ADMIN);
    expect(ovUpsert).not.toHaveBeenCalled();
    // sva 3 ključa se brišu (forceAll)
    const deleted = ovDeleteMany.mock.calls.map(
      (c) => (c[0] as OvDeleteCall).where.key,
    );
    expect(deleted).toContain(OVERRIDE_KEYS.MONTAZA_EDIT);
    expect(deleted).toContain(OVERRIDE_KEYS.KADROVSKA_READ);
    expect(deleted).toContain(OVERRIDE_KEYS.KADROVSKA_CONTRACTS_READ);
    expect((out.data as { overridesUpserted: number }).overridesUpserted).toBe(0);
  });

  it("agregacija: OR preko aktivnih redova istog email-a (jedan red true)", async () => {
    const { svc, ovUpsert } = makeSvc({
      sy15Rows: [
        {
          email: "a@x",
          is_active: true,
          plan_montaze_readonly: false,
          kadrovska_access: false,
          kadrovska_hide_contracts: false,
          managed_sub_department_ids: null,
        },
        {
          email: "A@X",
          is_active: true,
          plan_montaze_readonly: true, // drugi red daje true
          kadrovska_access: false,
          kadrovska_hide_contracts: false,
          managed_sub_department_ids: null,
        },
      ],
      userByEmail: { "a@x": { id: 3 } },
    });
    await svc.backfillOverrides(ADMIN);
    const upserted = ovUpsert.mock.calls.map(
      (c) => (c[0] as OvUpsertCall).create.key,
    );
    expect(upserted).toContain(OVERRIDE_KEYS.MONTAZA_EDIT); // OR → true
  });

  it("neaktivan red se ignoriše (flag se ne primenjuje iz is_active=false)", async () => {
    const { svc, ovUpsert, ovDeleteMany } = makeSvc({
      sy15Rows: [
        {
          email: "a@x",
          is_active: false,
          plan_montaze_readonly: true, // ignorisan
          kadrovska_access: false,
          kadrovska_hide_contracts: false,
          managed_sub_department_ids: null,
        },
      ],
      userByEmail: { "a@x": { id: 3 } },
    });
    const out = await svc.backfillOverrides(ADMIN);
    // Nijedan aktivan red → email se ni ne obrađuje
    expect(ovUpsert).not.toHaveBeenCalled();
    expect(ovDeleteMany).not.toHaveBeenCalled();
    expect((out.data as { processed: number }).processed).toBe(0);
  });

  it("scope: managed_sub_department_ids → global UserRole.updateMany", async () => {
    const { svc, roleUpdateMany } = makeSvc({
      sy15Rows: [
        {
          email: "m@x",
          is_active: true,
          plan_montaze_readonly: false,
          kadrovska_access: false,
          kadrovska_hide_contracts: false,
          managed_sub_department_ids: [4, 7],
        },
      ],
      userByEmail: { "m@x": { id: 9 } },
    });
    const out = await svc.backfillOverrides(ADMIN);
    const call = roleUpdateMany.mock.calls[0][0] as RoleUpdCall;
    expect(call.where).toEqual({ userId: 9, scopeType: "global" });
    expect(call.data.managedSubDepartmentIds).toEqual([4, 7]);
    expect((out.data as { scopesUpdated: number }).scopesUpdated).toBe(1);
  });

  it("bez 2.0 naloga → skippedNoUser (bez override upserta)", async () => {
    const { svc, ovUpsert } = makeSvc({
      sy15Rows: [
        {
          email: "ghost@x",
          is_active: true,
          plan_montaze_readonly: true,
          kadrovska_access: false,
          kadrovska_hide_contracts: false,
          managed_sub_department_ids: null,
        },
      ],
      userByEmail: { "ghost@x": null }, // nema 2.0 naloga
    });
    const out = await svc.backfillOverrides(ADMIN);
    expect(ovUpsert).not.toHaveBeenCalled();
    expect(out.data).toEqual({
      processed: 1,
      overridesUpserted: 0,
      scopesUpdated: 0,
      skippedNoUser: 1,
    });
  });
});
