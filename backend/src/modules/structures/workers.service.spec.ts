import { Test, TestingModule } from "@nestjs/testing";
import { ConflictException, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { WorkersService } from "./workers.service";

/**
 * Mock PrismaService — pokriva SVE tabele koje `remove()` pre-check broji.
 * `$transaction(cb)` prosleđuje isti mock kao `tx`.
 */
function prismaMock() {
  const m = {
    worker: {
      findUnique: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn().mockResolvedValue({}),
      update: jest.fn().mockResolvedValue({}),
      delete: jest.fn().mockResolvedValue({}),
    },
    techProcess: { count: jest.fn().mockResolvedValue(0) },
    workTimeEntry: { count: jest.fn().mockResolvedValue(0) },
    workOrderOperation: { count: jest.fn().mockResolvedValue(0) },
    workOrder: { count: jest.fn().mockResolvedValue(0) },
    machineAccess: { count: jest.fn().mockResolvedValue(0) },
    partLocation: { count: jest.fn().mockResolvedValue(0) },
    workOrderMachinedPart: { count: jest.fn().mockResolvedValue(0) },
    workOrderBlank: { count: jest.fn().mockResolvedValue(0) },
    workOrderNonstandardPart: { count: jest.fn().mockResolvedValue(0) },
    handoverDraft: { count: jest.fn().mockResolvedValue(0) },
    user: { count: jest.fn().mockResolvedValue(0) },
    // No-FK reference (radnik kao izvršilac/učesnik) + inbox notifikacija.
    drawingHandover: { count: jest.fn().mockResolvedValue(0) },
    workOrderLaunch: { count: jest.fn().mockResolvedValue(0) },
    workOrderApproval: { count: jest.fn().mockResolvedValue(0) },
    drawingPlan: { count: jest.fn().mockResolvedValue(0) },
    mrpDemand: { count: jest.fn().mockResolvedValue(0) },
    appNotification: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
    workerType: { findUnique: jest.fn(), findMany: jest.fn() },
    workUnit: { findMany: jest.fn().mockResolvedValue([]) },
    operation: { findMany: jest.fn().mockResolvedValue([]) },
    $transaction: jest.fn(),
    $executeRawUnsafe: jest.fn().mockResolvedValue(0),
  };
  m.$transaction.mockImplementation((arg: unknown) =>
    Array.isArray(arg)
      ? Promise.all(arg)
      : (arg as (tx: unknown) => unknown)(m),
  );
  return m;
}

describe("WorkersService (delete guard)", () => {
  let service: WorkersService;
  let prisma: ReturnType<typeof prismaMock>;

  beforeEach(async () => {
    prisma = prismaMock();
    const mod: TestingModule = await Test.createTestingModule({
      providers: [WorkersService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = mod.get(WorkersService);
  });

  describe("remove", () => {
    it("404 kad radnik ne postoji", async () => {
      prisma.worker.findUnique.mockResolvedValue(null);
      await expect(service.remove(99)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(prisma.worker.delete).not.toHaveBeenCalled();
    });

    it("409 kad radnik ima kucanja (tech_processes)", async () => {
      prisma.worker.findUnique.mockResolvedValue({ id: 7 });
      prisma.techProcess.count.mockResolvedValue(15);

      await expect(service.remove(7)).rejects.toThrow(
        "Radnik ima istoriju — deaktiviraj umesto brisanja.",
      );
      expect(prisma.worker.delete).not.toHaveBeenCalled();
    });

    it("409 kad je radnik vezan za app nalog (users.worker_id)", async () => {
      prisma.worker.findUnique.mockResolvedValue({ id: 7 });
      prisma.user.count.mockResolvedValue(1);

      await expect(service.remove(7)).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.worker.delete).not.toHaveBeenCalled();
    });

    it("409 kad je radnik na RN-u kroz BILO KOJU od dve relacije", async () => {
      prisma.worker.findUnique.mockResolvedValue({ id: 7 });
      prisma.workOrder.count.mockResolvedValue(2);

      await expect(service.remove(7)).rejects.toBeInstanceOf(ConflictException);
      // Obe relacije u jednom count-u: autor RN-a + radnik primopredaje.
      expect(prisma.workOrder.count).toHaveBeenCalledWith({
        where: { OR: [{ workerId: 7 }, { handoverWorkerId: 7 }] },
      });
      expect(prisma.worker.delete).not.toHaveBeenCalled();
    });

    it("pre-check pokriva sve tabele istorije (uklj. no-FK reference novih modela)", async () => {
      prisma.worker.findUnique.mockResolvedValue({ id: 7 });

      await service.remove(7);

      for (const model of [
        prisma.techProcess,
        prisma.workTimeEntry,
        prisma.workOrderOperation,
        prisma.workOrder,
        prisma.machineAccess,
        prisma.partLocation,
        prisma.workOrderMachinedPart,
        prisma.workOrderBlank,
        prisma.workOrderNonstandardPart,
        prisma.handoverDraft,
        prisma.user,
        prisma.drawingHandover,
        prisma.workOrderLaunch,
        prisma.workOrderApproval,
        prisma.drawingPlan,
        prisma.mrpDemand,
      ])
        expect(model.count).toHaveBeenCalledTimes(1);
    });

    it("409 kad je radnik učesnik primopredaje (bilo koja od 4 kolone)", async () => {
      prisma.worker.findUnique.mockResolvedValue({ id: 7 });
      prisma.drawingHandover.count.mockResolvedValue(1);

      await expect(service.remove(7)).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.drawingHandover.count).toHaveBeenCalledWith({
        where: {
          OR: [
            { handoverWorkerId: 7 },
            { technologistId: 7 },
            { statusChangedById: 7 },
            { launchedById: 7 },
          ],
        },
      });
      expect(prisma.worker.delete).not.toHaveBeenCalled();
    });

    it("briše radnika bez ijedne reference (typo unos) i vraća {id, deleted}", async () => {
      prisma.worker.findUnique.mockResolvedValue({ id: 7 });

      const res = await service.remove(7);

      expect(prisma.worker.delete).toHaveBeenCalledWith({ where: { id: 7 } });
      expect(res).toEqual({ data: { id: 7, deleted: true } });
    });

    it("notifikacije radnika (app_notifications, bez FK-a) se brišu u istoj transakciji", async () => {
      prisma.worker.findUnique.mockResolvedValue({ id: 7 });

      await service.remove(7);

      // Nisu poslovna istorija — čiste se da sledeći nosilac istog id-a
      // (create poravnava sekvencu na MAX) ne nasledi tuđ inbox.
      expect(prisma.appNotification.deleteMany).toHaveBeenCalledWith({
        where: { recipientWorkerId: 7 },
      });
      expect(prisma.$transaction).toHaveBeenCalled();
    });

    it("P2003 na delete (trka) se mapira u isti 409", async () => {
      prisma.worker.findUnique.mockResolvedValue({ id: 7 });
      prisma.worker.delete.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError("FK violation", {
          code: "P2003",
          clientVersion: "6.19.3",
        }),
      );

      await expect(service.remove(7)).rejects.toThrow(
        "Radnik ima istoriju — deaktiviraj umesto brisanja.",
      );
    });
  });
});
