import { BadRequestException, NotFoundException } from "@nestjs/common";
import { Test, TestingModule } from "@nestjs/testing";
import { PrismaService } from "../../prisma/prisma.service";
import { DictationDelegatesService } from "./dictation-delegates.service";

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
      findUnique: jest.fn().mockResolvedValue(null),
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
    prisma.user.findFirst
      .mockResolvedValueOnce({ id: 2 }) // owner
      .mockResolvedValueOnce({ id: 9 }); // delegate
    prisma.dictationDelegate.create.mockResolvedValue({ id: 5 });

    const res = await service.add(ADMIN, {
      ownerEmail: "nenad@servoteh.com",
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

  it("add: IDEMPOTENTNO — postojeći par vraća isti red, bez duplikata", async () => {
    prisma.user.findUnique
      .mockResolvedValueOnce({ id: 2 })
      .mockResolvedValueOnce({ id: 9 });
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
    prisma.user.findUnique
      .mockResolvedValueOnce({ id: 2 })
      .mockResolvedValueOnce({ id: 2 });

    await expect(
      service.add(ADMIN, { ownerUserId: 2, delegateUserId: 2 }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.dictationDelegate.create).not.toHaveBeenCalled();
  });

  it("add: nepoznat nalog → 404 (admin ruta SME da kaže da nema takvog korisnika)", async () => {
    prisma.user.findFirst.mockResolvedValue(null);

    await expect(
      service.add(ADMIN, {
        ownerEmail: "nema@servoteh.com",
        delegateEmail: "agent@servoteh.com",
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
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
        ownerEmail: "nenad@servoteh.com",
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
