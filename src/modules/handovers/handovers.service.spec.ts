import { Test, TestingModule } from "@nestjs/testing";
import {
  ConflictException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { HandoversService } from "./handovers.service";
import type { AuthUser } from "../auth/jwt.strategy";

/** Radnik iz JWT-a koji izvodi akcije u testovima (users.worker_id = 77). */
const actor: AuthUser = {
  userId: 1,
  email: "sef@servoteh",
  role: "sef",
  workerId: 77,
};

/**
 * Mock PrismaService: `$transaction(cb)` prosleđuje ISTI mock kao `tx`
 * (obrazac dovoljno dobar za servis koji unutar transakcije koristi iste
 * delegate); array forma = Promise.all.
 */
function prismaMock() {
  const m = {
    drawingHandover: {
      findUnique: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      update: jest.fn().mockResolvedValue({}),
    },
    workOrder: {
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn(),
      update: jest.fn(),
    },
    workOrderLaunch: { create: jest.fn().mockResolvedValue({}) },
    worker: {
      findUnique: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
    },
    drawing: {
      findUnique: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
    },
    project: { findUnique: jest.fn() },
    handoverDraft: { findMany: jest.fn().mockResolvedValue([]) },
    handoverDraftItem: { findMany: jest.fn().mockResolvedValue([]) },
    handoverStatus: { findMany: jest.fn().mockResolvedValue([]) },
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

/** Odobrena primopredaja (SAGLASAN) sa dodeljenim tehnologom 9. */
const approvedHandover = {
  id: 5,
  drawingId: 10,
  statusId: 1,
  isLocked: false,
  handoverWorkerId: 8,
  technologistId: 9,
};

describe("HandoversService", () => {
  let service: HandoversService;
  let prisma: ReturnType<typeof prismaMock>;

  beforeEach(async () => {
    prisma = prismaMock();
    const mod: TestingModule = await Test.createTestingModule({
      providers: [
        HandoversService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    service = mod.get(HandoversService);
    // Završni read-back (enrich) nije predmet ovih testova — mock-uje se.
    jest
      .spyOn(service, "findOne")
      .mockResolvedValue({ data: { id: 5 } } as never);
  });

  // ------------------------------------------------------------- APPROVE

  describe("approve", () => {
    it("zahteva technologistId (pozitivan ceo broj) — 422 bez upisa", async () => {
      await expect(
        service.approve(5, { technologistId: undefined as never }, actor),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
      await expect(
        service.approve(5, { technologistId: 0 }, actor),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
      expect(prisma.worker.findUnique).not.toHaveBeenCalled();
      expect(prisma.drawingHandover.update).not.toHaveBeenCalled();
    });

    it("odbija nepostojećeg tehnologa — 422", async () => {
      prisma.worker.findUnique.mockResolvedValue(null);
      await expect(
        service.approve(5, { technologistId: 999 }, actor),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
      expect(prisma.drawingHandover.update).not.toHaveBeenCalled();
    });

    it("odbija radnika bez defines_approval — 422", async () => {
      prisma.worker.findUnique.mockResolvedValue({
        id: 9,
        definesApproval: false,
        active: true,
      });
      await expect(
        service.approve(5, { technologistId: 9 }, actor),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
    });

    it("upisuje technologistId + statusId=1 + statusChangedById iz JWT-a", async () => {
      prisma.worker.findUnique.mockResolvedValue({
        id: 9,
        definesApproval: true,
        active: true,
      });
      prisma.drawingHandover.findUnique.mockResolvedValue({
        id: 5,
        statusId: 0,
        isLocked: false,
      });

      await service.approve(5, { technologistId: 9, comment: "ok" }, actor);

      expect(prisma.drawingHandover.update).toHaveBeenCalledWith({
        where: { id: 5 },
        data: containing({
          statusId: 1,
          technologistId: 9,
          statusChangedById: 77,
          statusChangeComment: "ok",
        }),
      });
    });

    it("409 kad primopredaja nije U OBRADI", async () => {
      prisma.worker.findUnique.mockResolvedValue({
        id: 9,
        definesApproval: true,
        active: true,
      });
      prisma.drawingHandover.findUnique.mockResolvedValue({
        id: 5,
        statusId: 1,
        isLocked: false,
      });
      await expect(
        service.approve(5, { technologistId: 9 }, actor),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it("422 za komentar duži od 250 karaktera (VarChar(250)) — bez upisa", async () => {
      await expect(
        service.approve(
          5,
          { technologistId: 9, comment: "x".repeat(251) },
          actor,
        ),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
      expect(prisma.drawingHandover.update).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------- RETURN-TO-PENDING

  describe("returnToPending", () => {
    it("blokira (409) kad za primopredaju već postoji RN", async () => {
      prisma.drawingHandover.findUnique.mockResolvedValue({
        id: 5,
        statusId: 1,
        isLocked: false,
      });
      prisma.workOrder.findFirst.mockResolvedValue({
        id: 42,
        identNumber: "P100/7",
      });

      await expect(
        service.returnToPending(5, { reason: "greška" }, actor),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.drawingHandover.update).not.toHaveBeenCalled();
    });

    it("vraća na 0 i čisti tehnologa kad RN ne postoji", async () => {
      prisma.drawingHandover.findUnique.mockResolvedValue({
        id: 5,
        statusId: 1,
        isLocked: false,
      });
      prisma.workOrder.findFirst.mockResolvedValue(null);

      await service.returnToPending(5, { reason: "pogrešan tehnolog" }, actor);

      expect(prisma.drawingHandover.update).toHaveBeenCalledWith({
        where: { id: 5 },
        data: containing({
          statusId: 0,
          technologistId: 0,
          statusChangedById: 77,
          statusChangeComment: "pogrešan tehnolog",
        }),
      });
    });

    it("409 kad primopredaja nije SAGLASAN", async () => {
      prisma.drawingHandover.findUnique.mockResolvedValue({
        id: 5,
        statusId: 0,
        isLocked: false,
      });
      await expect(
        service.returnToPending(5, {}, actor),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  // -------------------------------------------------- PREPARE-WORK-ORDER

  describe("prepareWorkOrder", () => {
    /** Podesi kompletan kontekst za kreiranje RN-a (crtež + nacrt + predmet). */
    function mockWorkOrderContext() {
      prisma.handoverDraftItem.findMany.mockResolvedValue([
        { id: 1, drawingId: 10, quantityToProduce: 4, draftId: 2 },
      ]);
      prisma.handoverDraft.findMany.mockResolvedValue([
        { id: 2, draftNumber: "N-1", projectId: 3 },
      ]);
      prisma.drawing.findUnique.mockResolvedValue({
        id: 10,
        drawingNumber: "D-10",
        revision: "B",
        name: "Ploča",
        material: "S355",
        dimensions: "10x10",
      });
      prisma.project.findUnique.mockResolvedValue({
        id: 3,
        projectNumber: "P100",
        customerId: 55,
      });
    }

    it("idempotentno: postojeći RN → existing:true, bez novog reda", async () => {
      prisma.drawingHandover.findUnique.mockResolvedValue(approvedHandover);
      prisma.workOrder.findFirst.mockResolvedValue({
        id: 42,
        identNumber: "P100/7",
      });

      const result = await service.prepareWorkOrder(5, actor);

      expect(result).toEqual({
        data: { workOrderId: 42, identNumber: "P100/7", existing: true },
      });
      expect(prisma.workOrder.create).not.toHaveBeenCalled();
      expect(prisma.workOrderLaunch.create).not.toHaveBeenCalled();
    });

    it("kreira RN sa handoverStatusId=1, BEZ launch reda; primopredaja ostaje SAGLASAN", async () => {
      prisma.drawingHandover.findUnique.mockResolvedValue(approvedHandover);
      prisma.workOrder.findFirst.mockResolvedValue(null);
      mockWorkOrderContext();
      prisma.workOrder.create.mockResolvedValue({
        id: 100,
        identNumber: "P100/1",
        variant: 0,
        projectId: 3,
        drawingNumber: "D-10",
        revision: "B",
        pieceCount: 4,
        handoverStatusId: 1,
      });

      const result = await service.prepareWorkOrder(5, actor);

      expect(result).toEqual({
        data: { workOrderId: 100, identNumber: "P100/1", existing: false },
      });
      expect(prisma.workOrder.create).toHaveBeenCalledWith(
        containing({
          data: containing({
            drawingHandoverId: 5,
            handoverStatusId: 1, // SAGLASAN — NE lansiran
            workerId: 9, // tehnolog iz primopredaje, ne kreator
            pieceCount: 4,
          }),
        }),
      );
      expect(prisma.workOrderLaunch.create).not.toHaveBeenCalled();
      expect(prisma.drawingHandover.update).not.toHaveBeenCalled();
    });

    it("workerId RN-a = JWT radnik kad tehnolog nije dodeljen (technologistId=0)", async () => {
      prisma.drawingHandover.findUnique.mockResolvedValue({
        ...approvedHandover,
        technologistId: 0,
      });
      prisma.workOrder.findFirst.mockResolvedValue(null);
      mockWorkOrderContext();
      prisma.workOrder.create.mockResolvedValue({
        id: 101,
        identNumber: "P100/2",
        variant: 0,
        projectId: 3,
        drawingNumber: "D-10",
        revision: "B",
        pieceCount: 4,
        handoverStatusId: 1,
      });

      await service.prepareWorkOrder(5, actor);

      expect(prisma.workOrder.create).toHaveBeenCalledWith(
        containing({
          data: containing({ workerId: 77 }),
        }),
      );
    });

    it("409 kad primopredaja nije SAGLASAN (i nema postojećeg RN-a)", async () => {
      prisma.drawingHandover.findUnique.mockResolvedValue({
        ...approvedHandover,
        statusId: 0,
      });
      prisma.workOrder.findFirst.mockResolvedValue(null);
      await expect(service.prepareWorkOrder(5, actor)).rejects.toBeInstanceOf(
        ConflictException,
      );
    });
  });

  // ---------------------------------------------------------------- LAUNCH

  describe("launch", () => {
    it("koristi postojeći RN (prepare tok) umesto kreiranja duplog", async () => {
      prisma.drawingHandover.findUnique.mockResolvedValue(approvedHandover);
      prisma.workOrder.findFirst.mockResolvedValue({
        id: 42,
        identNumber: "P100/7",
        handoverStatusId: 1, // SAGLASAN
        isLocked: false,
      });
      prisma.workOrder.update.mockResolvedValue({
        id: 42,
        identNumber: "P100/7",
        variant: 0,
        projectId: 3,
        drawingNumber: "D-10",
        revision: "B",
        pieceCount: 4,
        handoverStatusId: 3,
      });

      const result = await service.launch(
        5,
        { dueDate: "2026-08-01", comment: "hitno" },
        actor,
      );

      expect(prisma.workOrder.create).not.toHaveBeenCalled();
      expect(prisma.workOrder.update).toHaveBeenCalledWith(
        containing({
          where: { id: 42 },
          data: containing({
            handoverStatusId: 3,
            productionDeadline: expect.any(Date),
            note: "hitno",
          }),
        }),
      );
      expect(prisma.workOrderLaunch.create).toHaveBeenCalledWith({
        data: containing({
          workOrderId: 42,
          isLaunched: true,
          createdByWorkerId: 77,
          updatedByWorkerId: 77,
        }),
      });
      expect(prisma.drawingHandover.update).toHaveBeenCalledWith({
        where: { id: 5 },
        data: containing({
          statusId: 3,
          isLocked: true,
          launchedById: 77,
          statusChangedById: 77,
        }),
      });
      expect(result.data.workOrder.id).toBe(42);
    });

    it("409 kad primopredaja nije SAGLASAN", async () => {
      prisma.drawingHandover.findUnique.mockResolvedValue({
        ...approvedHandover,
        statusId: 3,
      });
      await expect(service.launch(5, {}, actor)).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it("409 kad je postojeći RN ODBIJEN — ne zaobilazi RN-level guard", async () => {
      prisma.drawingHandover.findUnique.mockResolvedValue(approvedHandover);
      prisma.workOrder.findFirst.mockResolvedValue({
        id: 42,
        identNumber: "P100/7",
        handoverStatusId: 2, // ODBIJENO (RN-level reject ne dira primopredaju)
        isLocked: false,
      });

      await expect(service.launch(5, {}, actor)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(prisma.workOrder.update).not.toHaveBeenCalled();
      expect(prisma.workOrderLaunch.create).not.toHaveBeenCalled();
      expect(prisma.drawingHandover.update).not.toHaveBeenCalled();
    });

    it("409 kad je postojeći RN zaključan", async () => {
      prisma.drawingHandover.findUnique.mockResolvedValue(approvedHandover);
      prisma.workOrder.findFirst.mockResolvedValue({
        id: 42,
        identNumber: "P100/7",
        handoverStatusId: 1,
        isLocked: true,
      });

      await expect(service.launch(5, {}, actor)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(prisma.workOrderLaunch.create).not.toHaveBeenCalled();
    });

    it("422 za komentar duži od 250 karaktera — pre bilo kakvog upisa", async () => {
      await expect(
        service.launch(5, { comment: "x".repeat(251) }, actor),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
      expect(prisma.workOrderLaunch.create).not.toHaveBeenCalled();
      expect(prisma.drawingHandover.update).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------- LEGACY GUARD (tranzicija)

  describe("legacy guard (HANDOVER_LEGACY_GUARD)", () => {
    /** Derivirani red iz tRN sync-a (legacyRnId != null) — mutacije blokirane. */
    const derivedPending = {
      id: 5,
      statusId: 0,
      isLocked: false,
      legacyRnId: 1126,
    };
    const derivedApproved = { ...approvedHandover, legacyRnId: 1126 };

    const originalGuard = process.env.HANDOVER_LEGACY_GUARD;
    beforeEach(() => {
      delete process.env.HANDOVER_LEGACY_GUARD; // default = guard aktivan
    });
    afterAll(() => {
      if (originalGuard === undefined) delete process.env.HANDOVER_LEGACY_GUARD;
      else process.env.HANDOVER_LEGACY_GUARD = originalGuard;
    });

    /** Validan tehnolog za approve tok (validacija ide PRE tranzicije). */
    function mockValidTechnologist() {
      prisma.worker.findUnique.mockResolvedValue({
        id: 9,
        definesApproval: true,
        active: true,
      });
    }

    it("409 na approve za derivirani red — bez upisa", async () => {
      mockValidTechnologist();
      prisma.drawingHandover.findUnique.mockResolvedValue(derivedPending);

      await expect(
        service.approve(5, { technologistId: 9 }, actor),
      ).rejects.toBeInstanceOf(ConflictException);
      await expect(
        service.approve(5, { technologistId: 9 }, actor),
      ).rejects.toThrow(/QBigTehn/);
      expect(prisma.drawingHandover.update).not.toHaveBeenCalled();
    });

    it("409 na reject za derivirani red — bez upisa", async () => {
      prisma.drawingHandover.findUnique.mockResolvedValue(derivedPending);

      await expect(service.reject(5, "razlog", actor)).rejects.toThrow(
        /QBigTehn/,
      );
      expect(prisma.drawingHandover.update).not.toHaveBeenCalled();
    });

    it("409 na returnToPending za derivirani red — bez upisa", async () => {
      prisma.drawingHandover.findUnique.mockResolvedValue({
        id: 5,
        statusId: 1,
        isLocked: false,
        legacyRnId: 1126,
      });
      prisma.workOrder.findFirst.mockResolvedValue(null);

      await expect(
        service.returnToPending(5, { reason: "x" }, actor),
      ).rejects.toThrow(/QBigTehn/);
      expect(prisma.drawingHandover.update).not.toHaveBeenCalled();
    });

    it("409 na prepareWorkOrder za derivirani red — i pre idempotentnog izlaza", async () => {
      prisma.drawingHandover.findUnique.mockResolvedValue(derivedApproved);

      await expect(service.prepareWorkOrder(5, actor)).rejects.toThrow(
        /QBigTehn/,
      );
      expect(prisma.workOrder.create).not.toHaveBeenCalled();
    });

    it("409 na launch za derivirani red — bez launch reda i bez upisa", async () => {
      prisma.drawingHandover.findUnique.mockResolvedValue(derivedApproved);

      await expect(service.launch(5, {}, actor)).rejects.toThrow(/QBigTehn/);
      expect(prisma.workOrderLaunch.create).not.toHaveBeenCalled();
      expect(prisma.drawingHandover.update).not.toHaveBeenCalled();
    });

    it("HANDOVER_LEGACY_GUARD='false' → approve deriviranog reda prolazi (cutover)", async () => {
      process.env.HANDOVER_LEGACY_GUARD = "false";
      mockValidTechnologist();
      prisma.drawingHandover.findUnique.mockResolvedValue(derivedPending);

      await service.approve(5, { technologistId: 9 }, actor);

      expect(prisma.drawingHandover.update).toHaveBeenCalledWith({
        where: { id: 5 },
        data: containing({ statusId: 1, technologistId: 9 }),
      });
    });

    it("nativni red (legacyRnId=null) nije blokiran", async () => {
      mockValidTechnologist();
      prisma.drawingHandover.findUnique.mockResolvedValue({
        id: 5,
        statusId: 0,
        isLocked: false,
        legacyRnId: null,
      });

      await service.approve(5, { technologistId: 9 }, actor);

      expect(prisma.drawingHandover.update).toHaveBeenCalledWith({
        where: { id: 5 },
        data: containing({ statusId: 1 }),
      });
    });
  });
});
