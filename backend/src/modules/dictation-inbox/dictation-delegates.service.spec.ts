import { BadRequestException, NotFoundException } from "@nestjs/common";
import { Test, TestingModule } from "@nestjs/testing";
import { PrismaService } from "../../prisma/prisma.service";
import { DictationDelegatesService } from "./dictation-delegates.service";

/**
 * Nalozi „u bazi". `findUnique` ih traži TAČNO (po `id` ili po celom e-mailu),
 * kao Postgres nad `uq_users_email` — zato džoker („%@servoteh.com") ovde ne
 * pogađa nikoga, isto kao na produkciji.
 */
type MockUser = { id: number; email: string; active: boolean };
const USERS: MockUser[] = [
  { id: 1, email: "admin@servoteh.com", active: true },
  { id: 2, email: "nenad.jarakovic@servoteh.com", active: true },
  { id: 9, email: "agent@servoteh.com", active: true },
  { id: 3, email: "bivsi@servoteh.com", active: false },
];

function prismaMock() {
  return {
    dictationDelegate: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn(),
      delete: jest.fn().mockResolvedValue({ id: 1 }),
    },
    user: {
      findUnique: jest.fn(
        ({ where }: { where: { id?: number; email?: string } }) => {
          const row = USERS.find((u) =>
            where.id !== undefined
              ? u.id === where.id
              : u.email === where.email,
          );
          return Promise.resolve(row ? { ...row } : null);
        },
      ),
      // Postoji samo da bi test mogao da dokaže da se NE koristi (ILIKE put).
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
    },
  };
}

/** Admin koji dodeljuje dozvolu (iz JWT-a). */
const ADMIN = { userId: 1, email: "admin@servoteh.com" };

describe("DictationDelegatesService", () => {
  let service: DictationDelegatesService;
  let prisma: ReturnType<typeof prismaMock>;

  beforeEach(async () => {
    prisma = prismaMock();
    const mod: TestingModule = await Test.createTestingModule({
      providers: [
        DictationDelegatesService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    service = mod.get(DictationDelegatesService);
  });

  // -------------------------------------------------------------------- list

  it("list: vraća dozvole sa razrešenim e-mailovima obe strane", async () => {
    prisma.dictationDelegate.findMany.mockResolvedValue([
      {
        id: 1,
        ownerUserId: 2,
        delegateUserId: 9,
        createdByUserId: 1,
        note: "Cursor agent sa telefona",
        createdAt: new Date("2026-08-02T08:00:00Z"),
      },
    ]);
    prisma.user.findMany.mockResolvedValue([
      { id: 2, email: "nenad@servoteh.com", fullName: "Nenad" },
      { id: 9, email: "agent@servoteh.com", fullName: "Agent" },
      { id: 1, email: "admin@servoteh.com", fullName: "Admin" },
    ]);

    const res = await service.list();

    expect(res.meta.count).toBe(1);
    expect(res.data[0]).toMatchObject({
      ownerUserId: 2,
      ownerEmail: "nenad@servoteh.com",
      delegateUserId: 9,
      delegateEmail: "agent@servoteh.com",
      createdByEmail: "admin@servoteh.com",
      note: "Cursor agent sa telefona",
    });
  });

  // --------------------------------------------------------------------- add

  it("add: e-mailovi se razrešavaju u users.id; upisuje se ko je dodelio", async () => {
    prisma.dictationDelegate.create.mockResolvedValue({ id: 5 });

    const res = await service.add(ADMIN, {
      ownerEmail: "nenad.jarakovic@servoteh.com",
      delegateEmail: "agent@servoteh.com",
      note: "  Cursor agent  ",
    });

    expect(prisma.dictationDelegate.create).toHaveBeenCalledWith({
      data: {
        ownerUserId: 2,
        delegateUserId: 9,
        createdByUserId: 1,
        note: "Cursor agent",
      },
    });
    expect(res.meta.created).toBe(true);
  });

  it("add: e-mail se normalizuje (trim + mala slova) i traži TAČNO, bez ILIKE", async () => {
    prisma.dictationDelegate.create.mockResolvedValue({ id: 6 });

    await service.add(ADMIN, {
      ownerEmail: "  Nenad.Jarakovic@Servoteh.com ",
      delegateEmail: "AGENT@servoteh.com",
    });

    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { email: "nenad.jarakovic@servoteh.com" },
      select: { id: true, active: true },
    });
    expect(prisma.user.findFirst).not.toHaveBeenCalled();
    expect(JSON.stringify(prisma.user.findUnique.mock.calls)).not.toContain(
      "insensitive",
    );
  });

  it("🔴 DŽOKER: `%@servoteh.com` ne pogađa nikoga → 404, dozvola se NE upisuje", async () => {
    // `mode: "insensitive"` bi ovde bio `ILIKE`, gde su `%` i `_` džokeri — pa bi
    // admin ruta ćutke dodelila dozvolu PROIZVOLJNOM nalogu (mereno: 59 od 68).
    for (const wildcard of ["%@servoteh.com", "_enad.jarakovic@servoteh.com"]) {
      await expect(
        service.add(ADMIN, {
          ownerEmail: wildcard,
          delegateEmail: "agent@servoteh.com",
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    }
    expect(prisma.dictationDelegate.create).not.toHaveBeenCalled();
  });

  it("add: IDEMPOTENTNO — postojeći par vraća isti red, bez duplikata", async () => {
    prisma.dictationDelegate.findFirst.mockResolvedValue({
      id: 5,
      ownerUserId: 2,
      delegateUserId: 9,
    });

    const res = await service.add(ADMIN, {
      ownerUserId: 2,
      delegateUserId: 9,
    });

    expect(res.meta.created).toBe(false);
    expect(res.data.id).toBe(5);
    expect(prisma.dictationDelegate.create).not.toHaveBeenCalled();
  });

  it("add: vlasnik == delegat → 400 (svoje sanduče ide i bez dozvole)", async () => {
    await expect(
      service.add(ADMIN, { ownerUserId: 2, delegateUserId: 2 }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.dictationDelegate.create).not.toHaveBeenCalled();
  });

  it("add: nepoznat nalog → 404 (admin ruta SME da kaže da nema takvog korisnika)", async () => {
    await expect(
      service.add(ADMIN, {
        ownerEmail: "nema@servoteh.com",
        delegateEmail: "agent@servoteh.com",
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("add: DEAKTIVIRAN vlasnik → 400, dozvola se ne upisuje (bila bi mrtvo slovo)", async () => {
    // `claim` ionako proverava `active` na svakom pozivu, pa bi upisan red samo
    // lažno tešio administratora da je pristup dat.
    await expect(
      service.add(ADMIN, {
        ownerUserId: 3, // bivsi@servoteh.com, active: false
        delegateUserId: 9,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.dictationDelegate.create).not.toHaveBeenCalled();
  });

  it("add: DEAKTIVIRAN delegat → 400, dozvola se ne upisuje", async () => {
    await expect(
      service.add(ADMIN, {
        ownerUserId: 2,
        delegateEmail: "bivsi@servoteh.com",
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.dictationDelegate.create).not.toHaveBeenCalled();
  });

  it("add: nedostaje vlasnik → 400", async () => {
    await expect(
      service.add(ADMIN, { delegateUserId: 9 }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("add: i userId i email za istu stranu → 400", async () => {
    await expect(
      service.add(ADMIN, {
        ownerUserId: 2,
        ownerEmail: "nenad.jarakovic@servoteh.com",
        delegateUserId: 9,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  // ------------------------------------------------------------------ remove

  it("remove: postojeći id briše red", async () => {
    prisma.dictationDelegate.findUnique.mockResolvedValue({ id: 5 });
    const res = await service.remove(5);
    expect(prisma.dictationDelegate.delete).toHaveBeenCalledWith({
      where: { id: 5 },
    });
    expect(res.data).toEqual({ id: 5, removed: true });
  });

  it("remove: nepostojeći id → 404 (admin ne sme da misli da je obrisao)", async () => {
    prisma.dictationDelegate.findUnique.mockResolvedValue(null);
    await expect(service.remove(999)).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.dictationDelegate.delete).not.toHaveBeenCalled();
  });
});
