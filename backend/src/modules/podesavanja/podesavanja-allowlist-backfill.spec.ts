import { PodesavanjaUsersService } from "./podesavanja-users.service";
import { OVERRIDE_KEYS } from "../../common/authz/permissions";
import type { PrismaService } from "../../prisma/prisma.service";
import type { Sy15Service } from "../../common/sy15/sy15.service";
import type { Sy15AuthAdminService } from "../../common/sy15/sy15-auth-admin.service";

jest.mock("bcrypt", () => ({ hash: jest.fn(() => Promise.resolve("hashed")) }));

const ADMIN = "admin@servoteh.com";

/**
 * #52 — allowlist→override backfill (uzrok zaključanog grida za HR, incident Mrkajić
 * 20.07.2026): DOKAZ da (1) email sa `kadr_grid_editor_allowlist` → upsert grant
 * `kadrovska.grid_edit` (vacation lista → `kadrovska.vacation_edit`); (2) MIRROR:
 * nalozi VAN liste gube override (deleteMany notIn) — ponovljen poziv konvergira;
 * (3) email bez 2.0 naloga → skippedNoUser (bez upserta); (4) normalizacija trim+lower
 * + dedup pre matcha.
 */
interface UpsertCall {
  where: { userId_key: { userId: number; key: string } };
  create: { userId: number; key: string; allow: boolean };
  update: { allow: boolean };
}
interface DeleteManyCall {
  where: { key: string; userId: { notIn: number[] } };
}

function makeSvc(opts: {
  gridEmails: string[];
  vacationEmails: string[];
  users: { id: number; email: string }[];
  /** Ako je zadat: DRUGI sy15 read (vacation lista) pada ovim errorom. */
  vacationReadError?: unknown;
}) {
  const ovUpsert = jest.fn((_arg: UpsertCall) => Promise.resolve({}));
  const ovDeleteMany = jest.fn((_arg: DeleteManyCall) =>
    Promise.resolve({ count: 0 }),
  );
  const userFindMany = jest.fn((arg: { where: { email: { in: string[] } } }) =>
    Promise.resolve(
      opts.users.filter((u) => arg.where.email.in.includes(u.email)),
    ),
  );

  const tx2 = {
    user: { findMany: userFindMany },
    userPermissionOverride: { upsert: ovUpsert, deleteMany: ovDeleteMany },
  };
  const prisma = {
    $transaction: jest.fn((cb: (tx: unknown) => unknown) => cb(tx2)),
  };

  // Dva $queryRaw poziva (po jedan withUserRls po ključu): prvi = grid, drugi = vacation.
  const sy15QueryRaw = jest
    .fn()
    .mockResolvedValueOnce(opts.gridEmails.map((email) => ({ email })));
  if (opts.vacationReadError !== undefined) {
    sy15QueryRaw.mockRejectedValueOnce(opts.vacationReadError);
  } else {
    sy15QueryRaw.mockResolvedValueOnce(
      opts.vacationEmails.map((email) => ({ email })),
    );
  }
  const withUserRls = jest.fn((_e: string, fn: (tx: unknown) => unknown) =>
    fn({ $queryRaw: sy15QueryRaw }),
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
  return { svc, ovUpsert, ovDeleteMany, userFindMany };
}

describe("PodesavanjaUsersService.backfillAllowlistOverrides (#52)", () => {
  it("grid lista → grant grid_edit; vacation lista → grant vacation_edit (upsert po (userId,key))", async () => {
    const { svc, ovUpsert } = makeSvc({
      gridEmails: ["Nikola@X ", "nevena@x"],
      vacationEmails: ["nevena@x"],
      users: [
        { id: 1, email: "nikola@x" },
        { id: 2, email: "nevena@x" },
      ],
    });
    const out = await svc.backfillAllowlistOverrides(ADMIN);
    const calls = ovUpsert.mock.calls.map((c) => c[0]);
    expect(calls).toContainEqual({
      where: {
        userId_key: { userId: 1, key: OVERRIDE_KEYS.KADROVSKA_GRID_EDIT },
      },
      create: {
        userId: 1,
        key: OVERRIDE_KEYS.KADROVSKA_GRID_EDIT,
        allow: true,
      },
      update: { allow: true },
    });
    expect(calls).toContainEqual({
      where: {
        userId_key: { userId: 2, key: OVERRIDE_KEYS.KADROVSKA_VACATION_EDIT },
      },
      create: {
        userId: 2,
        key: OVERRIDE_KEYS.KADROVSKA_VACATION_EDIT,
        allow: true,
      },
      update: { allow: true },
    });
    const entries = (
      out.data as { entries: { key: string; granted: number }[] }
    ).entries;
    expect(
      entries.find((e) => e.key === OVERRIDE_KEYS.KADROVSKA_GRID_EDIT)?.granted,
    ).toBe(2);
    expect(
      entries.find((e) => e.key === OVERRIDE_KEYS.KADROVSKA_VACATION_EDIT)
        ?.granted,
    ).toBe(1);
  });

  it("MIRROR: nalozi van liste gube override (deleteMany notIn listiranih)", async () => {
    const { svc, ovDeleteMany } = makeSvc({
      gridEmails: ["nikola@x"],
      vacationEmails: [],
      users: [{ id: 1, email: "nikola@x" }],
    });
    await svc.backfillAllowlistOverrides(ADMIN);
    const byKey = new Map(
      ovDeleteMany.mock.calls.map((c) => {
        const a = c[0];
        return [a.where.key, a.where.userId.notIn];
      }),
    );
    expect(byKey.get(OVERRIDE_KEYS.KADROVSKA_GRID_EDIT)).toEqual([1]);
    // prazna vacation lista → briše SVE redove tog ključa (notIn [])
    expect(byKey.get(OVERRIDE_KEYS.KADROVSKA_VACATION_EDIT)).toEqual([]);
  });

  it("email bez 2.0 naloga → skippedNoUser, bez upserta za njega", async () => {
    const { svc, ovUpsert } = makeSvc({
      gridEmails: ["ghost@x", "nikola@x"],
      vacationEmails: [],
      users: [{ id: 1, email: "nikola@x" }],
    });
    const out = await svc.backfillAllowlistOverrides(ADMIN);
    expect(ovUpsert).toHaveBeenCalledTimes(1);
    const grid = (
      out.data as {
        entries: { key: string; skippedNoUser: number; listed: number }[];
      }
    ).entries.find((e) => e.key === OVERRIDE_KEYS.KADROVSKA_GRID_EDIT);
    expect(grid?.listed).toBe(2);
    expect(grid?.skippedNoUser).toBe(1);
  });

  it("per-key izolacija (CRITICAL 20.07): vacation SELECT 42501 → grid se IPAK ogleda; vacation entry nosi error, mirror NETAKNUT", async () => {
    const { svc, ovUpsert, ovDeleteMany } = makeSvc({
      gridEmails: ["nikola@x"],
      vacationEmails: [],
      users: [{ id: 1, email: "nikola@x" }],
      vacationReadError: { meta: { code: "42501" } }, // REVOKE iz 1.0 migracije 2026-06-21
    });
    const out = await svc.backfillAllowlistOverrides(ADMIN);
    // grid ključ ogledan uprkos padu vacation liste
    expect(ovUpsert).toHaveBeenCalledTimes(1);
    // vacation mirror NETAKNUT: nijedan delete za taj ključ (pad čitanja ≠ prazna lista)
    const delKeys = ovDeleteMany.mock.calls.map((c) => c[0].where.key);
    expect(delKeys).toEqual([OVERRIDE_KEYS.KADROVSKA_GRID_EDIT]);
    const entries = (
      out.data as {
        entries: { key: string; granted: number; error?: string }[];
      }
    ).entries;
    expect(
      entries.find((e) => e.key === OVERRIDE_KEYS.KADROVSKA_GRID_EDIT)?.granted,
    ).toBe(1);
    expect(
      entries.find((e) => e.key === OVERRIDE_KEYS.KADROVSKA_VACATION_EDIT)
        ?.error,
    ).toContain("42501");
  });

  it("normalizacija + dedup: ' A@X ' i 'a@x' su jedan email", async () => {
    const { svc, userFindMany } = makeSvc({
      gridEmails: [" A@X ", "a@x"],
      vacationEmails: [],
      users: [{ id: 5, email: "a@x" }],
    });
    const out = await svc.backfillAllowlistOverrides(ADMIN);
    expect(userFindMany.mock.calls[0][0].where.email.in).toEqual(["a@x"]);
    const grid = (
      out.data as { entries: { key: string; listed: number }[] }
    ).entries.find((e) => e.key === OVERRIDE_KEYS.KADROVSKA_GRID_EDIT);
    expect(grid?.listed).toBe(1);
  });
});
