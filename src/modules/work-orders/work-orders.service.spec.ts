import { Test, TestingModule } from "@nestjs/testing";
import {
  ConflictException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { WorkOrdersService } from "./work-orders.service";
import { WorkOrderNumberingService } from "./work-order-numbering.service";
import type { AuthUser } from "../auth/jwt.strategy";

/** Radnik iz JWT-a koji izvodi akcije u testovima (users.worker_id = 77). */
const actor: AuthUser = {
  userId: 1,
  email: "tehnolog@servoteh",
  role: "tehnolog",
  workerId: 77,
};

/** Mock PrismaService — `$transaction(cb)` prosleđuje isti mock kao `tx`. */
function prismaMock() {
  const m = {
    workOrder: {
      findUnique: jest.fn(),
      findFirst: jest.fn().mockResolvedValue(null),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    workOrderOperation: { count: jest.fn().mockResolvedValue(1) },
    workOrderLaunch: { create: jest.fn().mockResolvedValue({}) },
    workOrderApproval: { create: jest.fn().mockResolvedValue({}) },
    drawingHandover: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    $transaction: jest.fn(),
    $executeRaw: jest.fn().mockResolvedValue(0),
    $executeRawUnsafe: jest.fn().mockResolvedValue(0),
  };
  m.$transaction.mockImplementation((arg: unknown) =>
    Array.isArray(arg)
      ? Promise.all(arg)
      : (arg as (tx: unknown) => unknown)(m),
  );
  return m;
}

/** `expect.objectContaining` tipizovan kao `unknown` (smiruje no-unsafe-assignment). */
const containing = (obj: Record<string, unknown>): unknown =>
  expect.objectContaining(obj) as unknown;

describe("WorkOrdersService (workflow)", () => {
  let service: WorkOrdersService;
  let prisma: ReturnType<typeof prismaMock>;

  // Determinizam legacy guard-a (isti obrazac kao handovers.service.spec.ts):
  // odsutna promenljiva = guard aktivan (default).
  const originalGuard = process.env.HANDOVER_LEGACY_GUARD;
  beforeAll(() => {
    delete process.env.HANDOVER_LEGACY_GUARD;
  });
  afterAll(() => {
    if (originalGuard === undefined) delete process.env.HANDOVER_LEGACY_GUARD;
    else process.env.HANDOVER_LEGACY_GUARD = originalGuard;
  });

  beforeEach(async () => {
    prisma = prismaMock();
    const mod: TestingModule = await Test.createTestingModule({
      providers: [
        WorkOrdersService,
        WorkOrderNumberingService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    service = mod.get(WorkOrdersService);
    // Završni read-back (enrich) nije predmet ovih testova — mock-uje se.
    jest
      .spyOn(service, "findOne")
      .mockResolvedValue({ data: { id: 7 } } as never);
  });

  describe("launch", () => {
    it("propagira LANSIRAN (3) + zaključavanje na primopredaju kad je RN vezan za nju", async () => {
      prisma.workOrder.findUnique.mockResolvedValue({
        id: 7,
        isLocked: false,
        handoverStatusId: 1,
        drawingHandoverId: 5,
      });
      // Ovaj RN je "original" za primopredaju (najmanji id po FK-u).
      prisma.workOrder.findFirst.mockResolvedValue({ id: 7 });

      await service.launch(7, actor);

      // Uslovni update — konkurentni launch gubi trku i dobija 409.
      expect(prisma.workOrder.updateMany).toHaveBeenCalledWith({
        where: { id: 7, handoverStatusId: 1, isLocked: false },
        data: { handoverStatusId: 3 },
      });
      expect(prisma.workOrderLaunch.create).toHaveBeenCalledWith({
        data: containing({
          workOrderId: 7,
          isLaunched: true,
          createdByWorkerId: 77,
          updatedByWorkerId: 77,
        }),
      });
      // updateMany (ne update): FK bez constraint-a može biti orphan;
      // `statusId != 3` čuva launch audit već lansirane primopredaje;
      // `legacyRnId: null` (guard aktivan po default-u) štiti derivirane
      // legacy redove od mutacije iz 2.0 do cutover-a.
      expect(prisma.drawingHandover.updateMany).toHaveBeenCalledWith({
        where: { id: 5, statusId: { not: 3 }, legacyRnId: null },
        data: containing({
          statusId: 3,
          isLocked: true,
          launchedById: 77,
          statusChangedById: 77,
        }),
      });
    });

    it("HANDOVER_LEGACY_GUARD='false' (cutover) → propagacija BEZ legacyRnId filtera", async () => {
      const original = process.env.HANDOVER_LEGACY_GUARD;
      process.env.HANDOVER_LEGACY_GUARD = "false";
      try {
        prisma.workOrder.findUnique.mockResolvedValue({
          id: 7,
          isLocked: false,
          handoverStatusId: 1,
          drawingHandoverId: 5,
        });
        prisma.workOrder.findFirst.mockResolvedValue({ id: 7 });

        await service.launch(7, actor);

        expect(prisma.drawingHandover.updateMany).toHaveBeenCalledWith({
          where: { id: 5, statusId: { not: 3 } },
          data: containing({ statusId: 3, isLocked: true }),
        });
      } finally {
        if (original === undefined) delete process.env.HANDOVER_LEGACY_GUARD;
        else process.env.HANDOVER_LEGACY_GUARD = original;
      }
    });

    it("ne dira primopredaju kad RN nije nastao iz nje (drawingHandoverId=0)", async () => {
      prisma.workOrder.findUnique.mockResolvedValue({
        id: 7,
        isLocked: false,
        handoverStatusId: 1,
        drawingHandoverId: 0,
      });

      await service.launch(7, actor);

      expect(prisma.drawingHandover.updateMany).not.toHaveBeenCalled();
    });

    it("ne dira primopredaju kad RN NIJE original (klon deli drawing_handover_id)", async () => {
      prisma.workOrder.findUnique.mockResolvedValue({
        id: 9, // škart/dorada klon
        isLocked: false,
        handoverStatusId: 1,
        drawingHandoverId: 5,
      });
      // Original primopredaje je RN 7 (najmanji id), ne 9.
      prisma.workOrder.findFirst.mockResolvedValue({ id: 7 });

      await service.launch(9, actor);

      expect(prisma.workOrderLaunch.create).toHaveBeenCalled();
      expect(prisma.drawingHandover.updateMany).not.toHaveBeenCalled();
    });

    it("409 kad konkurentni launch izgubi trku (uslovni update count=0)", async () => {
      prisma.workOrder.findUnique.mockResolvedValue({
        id: 7,
        isLocked: false,
        handoverStatusId: 1,
        drawingHandoverId: 0,
      });
      prisma.workOrder.updateMany.mockResolvedValue({ count: 0 });

      await expect(service.launch(7, actor)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(prisma.workOrderLaunch.create).not.toHaveBeenCalled();
    });

    it("422 kad RN nije SAGLASAN", async () => {
      prisma.workOrder.findUnique.mockResolvedValue({
        id: 7,
        isLocked: false,
        handoverStatusId: 0,
        drawingHandoverId: 0,
      });
      await expect(service.launch(7, actor)).rejects.toBeInstanceOf(
        UnprocessableEntityException,
      );
    });
  });

  describe("approve", () => {
    it("upisuje autora odobravanja iz JWT-a (created/updatedByWorkerId)", async () => {
      prisma.workOrder.findUnique.mockResolvedValue({ id: 7, isLocked: false });

      await service.approve(7, true, actor);

      expect(prisma.workOrderApproval.create).toHaveBeenCalledWith({
        data: containing({
          workOrderId: 7,
          isApproved: true,
          createdByWorkerId: 77,
          updatedByWorkerId: 77,
        }),
      });
    });
  });
});
