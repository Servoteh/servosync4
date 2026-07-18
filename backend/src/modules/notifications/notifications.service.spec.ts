import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { Test, TestingModule } from "@nestjs/testing";
import { PrismaService } from "../../prisma/prisma.service";
import { NotificationsService } from "./notifications.service";
import type { AuthUser } from "../auth/jwt.strategy";

/** Mock PrismaService — samo modeli koje notifications modul dodiruje. */
function prismaMock() {
  const mock = {
    appNotification: {
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue(null),
      count: jest.fn().mockResolvedValue(0),
      update: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    workerType: { findMany: jest.fn().mockResolvedValue([]) },
    worker: { findMany: jest.fn().mockResolvedValue([]) },
    // Array-forma $transaction: prosledi promise-ove (već pokrenute upite).
    $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
  };
  return mock;
}

function authUser(workerId: number | null): AuthUser {
  return { userId: 1, email: "t@servoteh.com", role: "tehnolog", workerId };
}

function notifRow(over: Record<string, unknown> = {}) {
  return {
    id: 1,
    type: "kontrola.skart",
    message: "ŠKART na RN 06/93-4 op 60 (8.5) — kontrolor Pera, 3 kom",
    refTable: "work_orders",
    refId: 42,
    recipientWorkerId: 5,
    createdAt: new Date("2026-07-11T08:00:00Z"),
    readAt: null,
    ...over,
  };
}

describe("NotificationsService", () => {
  let service: NotificationsService;
  let prisma: ReturnType<typeof prismaMock>;

  beforeEach(async () => {
    prisma = prismaMock();
    const mod: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationsService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    service = mod.get(NotificationsService);
  });

  // ---------------------------------------------------------------- notifyWorkers

  it("notifyWorkers: dedup primalaca + izbacivanje 0/null; jedan red po primaocu", async () => {
    prisma.appNotification.createMany.mockResolvedValue({ count: 2 });

    const count = await service.notifyWorkers([7, 7, 0, 9, 7], {
      type: "primopredaja.nova",
      message:
        "Kreirana nova primopredaja D-2026-15 — 4 stavki (projektant Mika)",
      refTable: "handover_drafts",
      refId: 15,
    });

    expect(count).toBe(2);
    expect(prisma.appNotification.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({ recipientWorkerId: 7 }),
        expect.objectContaining({ recipientWorkerId: 9 }),
      ],
    });
    const [[firstCall]] = prisma.appNotification.createMany.mock
      .calls as unknown as [
      [{ data: { type: string; refTable: string | null }[] }],
    ];
    expect(firstCall.data[0]).toEqual({
      type: "primopredaja.nova",
      message:
        "Kreirana nova primopredaja D-2026-15 — 4 stavki (projektant Mika)",
      refTable: "handover_drafts",
      refId: 15,
      recipientWorkerId: 7,
    });
  });

  it("notifyWorkers: bez primalaca → 0, bez upisa", async () => {
    const count = await service.notifyWorkers([0, 0], {
      type: "x",
      message: "y",
    });
    expect(count).toBe(0);
    expect(prisma.appNotification.createMany).not.toHaveBeenCalled();
  });

  it("notifyWorkers: poruka se seče na 500 karaktera (VarChar(500))", async () => {
    prisma.appNotification.createMany.mockResolvedValue({ count: 1 });
    await service.notifyWorkers([5], { type: "x", message: "a".repeat(600) });
    const [[firstCall]] = prisma.appNotification.createMany.mock
      .calls as unknown as [[{ data: { message: string }[] }]];
    expect(firstCall.data[0].message).toHaveLength(500);
  });

  // ---------------------------------------------------------------- resolver tehnologa

  it("resolveTechnologistWorkerIds: aktivni radnici vrste 'Tehnolog' (batch, bez JOIN-a)", async () => {
    prisma.workerType.findMany.mockResolvedValue([{ id: 1 }]);
    prisma.worker.findMany.mockResolvedValue([{ id: 7 }, { id: 9 }]);

    const ids = await service.resolveTechnologistWorkerIds();

    expect(ids).toEqual([7, 9]);
    expect(prisma.workerType.findMany).toHaveBeenCalledWith({
      where: { name: { equals: "Tehnolog", mode: "insensitive" } },
      select: { id: true },
    });
    expect(prisma.worker.findMany).toHaveBeenCalledWith({
      where: { active: true, workerTypeId: { in: [1] } },
      select: { id: true },
    });
  });

  it("resolveTechnologistWorkerIds: nema vrste 'Tehnolog' → prazan spisak, radnici se ne traže", async () => {
    prisma.workerType.findMany.mockResolvedValue([]);
    const ids = await service.resolveTechnologistWorkerIds();
    expect(ids).toEqual([]);
    expect(prisma.worker.findMany).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------- list / unread

  it("list: filtrira po workerId iz JWT-a, najnovije prvo, unreadCount u meta", async () => {
    prisma.appNotification.findMany.mockResolvedValue([notifRow()]);
    prisma.appNotification.count.mockResolvedValue(3);

    const res = await service.list(authUser(5), {});

    expect(prisma.appNotification.findMany).toHaveBeenCalledWith({
      where: { recipientWorkerId: 5 },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 30,
    });
    expect(prisma.appNotification.count).toHaveBeenCalledWith({
      where: { recipientWorkerId: 5, readAt: null },
    });
    expect(res.meta).toEqual({ workerId: 5, limit: 30, unreadCount: 3 });
  });

  it("list: unreadOnly=true sužava i listu na nepročitane; limit se klampuje na 100", async () => {
    await service.list(authUser(5), { unreadOnly: "true", limit: "500" });
    expect(prisma.appNotification.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { recipientWorkerId: 5, readAt: null },
        take: 100,
      }),
    );
  });

  it("list: nalog bez vezanog radnika (workerId null) → prazan inbox, bez upita", async () => {
    const res = await service.list(authUser(null), {});
    expect(res.data).toEqual([]);
    expect(res.meta.unreadCount).toBe(0);
    expect(prisma.appNotification.findMany).not.toHaveBeenCalled();
  });

  it("unreadCount: broji samo nepročitane primaoca; bez radnika → 0", async () => {
    prisma.appNotification.count.mockResolvedValue(4);
    await expect(service.unreadCount(authUser(5))).resolves.toEqual({
      data: { unread: 4 },
    });
    await expect(service.unreadCount(authUser(null))).resolves.toEqual({
      data: { unread: 0 },
    });
  });

  // ---------------------------------------------------------------- mark read

  it("markRead: 403 na tuđu notifikaciju", async () => {
    prisma.appNotification.findUnique.mockResolvedValue(
      notifRow({ recipientWorkerId: 99 }),
    );
    await expect(service.markRead(authUser(5), 1)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(prisma.appNotification.update).not.toHaveBeenCalled();
  });

  it("markRead: 403 i kad nalog nema vezanog radnika", async () => {
    prisma.appNotification.findUnique.mockResolvedValue(notifRow());
    await expect(service.markRead(authUser(null), 1)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it("markRead: 404 na nepostojeću", async () => {
    await expect(service.markRead(authUser(5), 77)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("markRead: upisuje readAt svoju; već pročitana je idempotentna (bez update-a)", async () => {
    const unread = notifRow();
    prisma.appNotification.findUnique.mockResolvedValue(unread);
    prisma.appNotification.update.mockResolvedValue({
      ...unread,
      readAt: new Date(),
    });

    await service.markRead(authUser(5), 1);
    expect(prisma.appNotification.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { readAt: expect.any(Date) as Date },
    });

    prisma.appNotification.update.mockClear();
    prisma.appNotification.findUnique.mockResolvedValue(
      notifRow({ readAt: new Date("2026-07-11T09:00:00Z") }),
    );
    await service.markRead(authUser(5), 1);
    expect(prisma.appNotification.update).not.toHaveBeenCalled();
  });

  it("markAllRead: updateMany samo nad nepročitanim svog radnika", async () => {
    prisma.appNotification.updateMany.mockResolvedValue({ count: 3 });
    await expect(service.markAllRead(authUser(5))).resolves.toEqual({
      data: { updated: 3 },
    });
    expect(prisma.appNotification.updateMany).toHaveBeenCalledWith({
      where: { recipientWorkerId: 5, readAt: null },
      data: { readAt: expect.any(Date) as Date },
    });
  });
});
