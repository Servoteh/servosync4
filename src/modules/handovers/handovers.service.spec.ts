import { Test, TestingModule } from "@nestjs/testing";
import {
  BadRequestException,
  ConflictException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { NotificationsService } from "../notifications/notifications.service";
import { HandoversService } from "./handovers.service";
import type { AuthUser } from "../auth/jwt.strategy";

/** Radnik iz JWT-a koji izvodi akcije u testovima (users.worker_id = 77). */
const actor: AuthUser = {
  userId: 1,
  email: "sef@servoteh",
  role: "sef",
  workerId: 77,
};

/** Nalog bez vezanog radnika (kancelarijski / stari token). */
const actorNoWorker: AuthUser = { ...actor, workerId: null };

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
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    workOrder: {
      findFirst: jest.fn().mockResolvedValue(null),
      findUnique: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    workOrderLaunch: { create: jest.fn().mockResolvedValue({}) },
    worker: {
      findUnique: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
    },
    // `resolveActorWorkerId` svež lookup (JWT bez workerId): default = nema veze
    // (workerId null) → actor sa workerId=null i dalje pada na 422 gde treba.
    user: { findUnique: jest.fn().mockResolvedValue({ workerId: null }) },
    // Kriterijum tehnologa (§6.3 helper): default = vrsta 'Tehnolog' postoji (id 1).
    workerType: { findMany: jest.fn().mockResolvedValue([{ id: 1 }]) },
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

/** Odobrena primopredaja (SAGLASAN) sa dodeljenim tehnologom 9, bez roka. */
const approvedHandover = {
  id: 5,
  drawingId: 10,
  statusId: 1,
  isLocked: false,
  handoverWorkerId: 8,
  technologistId: 9,
  productionDeadline: null,
};

describe("HandoversService", () => {
  let service: HandoversService;
  let prisma: ReturnType<typeof prismaMock>;
  let notifications: { notifyWorkers: jest.Mock };

  beforeEach(async () => {
    prisma = prismaMock();
    notifications = { notifyWorkers: jest.fn().mockResolvedValue(1) };
    const mod: TestingModule = await Test.createTestingModule({
      providers: [
        HandoversService,
        { provide: PrismaService, useValue: prisma },
        { provide: NotificationsService, useValue: notifications },
      ],
    }).compile();
    service = mod.get(HandoversService);
    // Završni read-back (enrich) nije predmet ovih testova — mock-uje se.
    jest
      .spyOn(service, "findOne")
      .mockResolvedValue({ data: { id: 5 } } as never);
  });

  /** Validan tehnolog 9 (aktivan, vrsta 'Tehnolog') za approve tok. */
  function mockValidTechnologist() {
    prisma.worker.findUnique.mockResolvedValue({
      id: 9,
      active: true,
      workerTypeId: 1,
    });
  }

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

  // -------------------------------------------------------- TECHNOLOGISTS

  describe("technologists", () => {
    it("lista = aktivni radnici vrste 'Tehnolog' (helper kriterijum, ne defines_approval)", async () => {
      prisma.worker.findMany.mockResolvedValue([
        { id: 9, fullName: "Tehnolog Devet", username: "t9" },
      ]);

      const result = await service.technologists();

      expect(result.data).toHaveLength(1);
      expect(prisma.workerType.findMany).toHaveBeenCalledWith({
        where: { name: { equals: "Tehnolog", mode: "insensitive" } },
        select: { id: true },
      });
      expect(prisma.worker.findMany).toHaveBeenCalledWith({
        where: { active: true, workerTypeId: { in: [1] } },
        select: { id: true, fullName: true, username: true },
        orderBy: { fullName: "asc" },
      });
    });

    it("nema vrste 'Tehnolog' u lookup-u → prazna lista, radnici se ne traže", async () => {
      prisma.workerType.findMany.mockResolvedValue([]);
      await expect(service.technologists()).resolves.toEqual({ data: [] });
      expect(prisma.worker.findMany).not.toHaveBeenCalled();
    });
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
      expect(prisma.drawingHandover.updateMany).not.toHaveBeenCalled();
    });

    it("odbija nepostojećeg tehnologa — 422", async () => {
      prisma.worker.findUnique.mockResolvedValue(null);
      await expect(
        service.approve(5, { technologistId: 999 }, actor),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
      expect(prisma.drawingHandover.updateMany).not.toHaveBeenCalled();
    });

    it("odbija radnika koji nije vrste 'Tehnolog' — 422 (kriterijum §6.3, ne defines_approval)", async () => {
      prisma.worker.findUnique.mockResolvedValue({
        id: 9,
        active: true,
        workerTypeId: 2, // npr. Kontrolor
      });
      await expect(
        service.approve(5, { technologistId: 9 }, actor),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
    });

    it("odbija NEAKTIVNOG radnika vrste 'Tehnolog' — 422", async () => {
      prisma.worker.findUnique.mockResolvedValue({
        id: 9,
        active: false,
        workerTypeId: 1,
      });
      await expect(
        service.approve(5, { technologistId: 9 }, actor),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
    });

    it("upisuje technologistId + statusId=1 + statusChangedById + audit dodele; bez roka → production_deadline null", async () => {
      mockValidTechnologist();
      prisma.drawingHandover.findUnique.mockResolvedValue({
        id: 5,
        statusId: 0,
        isLocked: false,
      });

      await service.approve(5, { technologistId: 9, comment: "ok" }, actor);

      // Uslovni updateMany (guard protiv konkurentnog approve/reject):
      // where nosi i from-status i isLocked, ne samo id.
      expect(prisma.drawingHandover.updateMany).toHaveBeenCalledWith({
        where: { id: 5, statusId: 0, isLocked: false },
        data: containing({
          statusId: 1,
          technologistId: 9,
          statusChangedById: 77,
          statusChangeComment: "ok",
          technologistAssignedAt: expect.any(Date) as Date,
          technologistAssignedById: 77,
          productionDeadline: null,
        }),
      });
    });

    it("upisuje rok (dueDate) u production_deadline (§6.5.1)", async () => {
      mockValidTechnologist();
      prisma.drawingHandover.findUnique.mockResolvedValue({
        id: 5,
        statusId: 0,
        isLocked: false,
      });

      await service.approve(
        5,
        { technologistId: 9, dueDate: "2026-09-01" },
        actor,
      );

      expect(prisma.drawingHandover.updateMany).toHaveBeenCalledWith({
        where: { id: 5, statusId: 0, isLocked: false },
        data: containing({
          statusId: 1,
          productionDeadline: new Date("2026-09-01"),
        }),
      });
    });

    it("400 za nevalidan dueDate — pre bilo kakvog upisa", async () => {
      await expect(
        service.approve(5, { technologistId: 9, dueDate: "nije-datum" }, actor),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.drawingHandover.updateMany).not.toHaveBeenCalled();
    });

    it("409 kad konkurentni prelaz pobedi (updateMany count=0)", async () => {
      mockValidTechnologist();
      prisma.drawingHandover.findUnique.mockResolvedValue({
        id: 5,
        statusId: 0,
        isLocked: false,
      });
      prisma.drawingHandover.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        service.approve(5, { technologistId: 9 }, actor),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it("409 kad primopredaja nije U OBRADI", async () => {
      mockValidTechnologist();
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
      expect(prisma.drawingHandover.updateMany).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------- GRUPNO (batch) approve

  describe("approveBatch", () => {
    it("422 za praznu listu id-jeva", async () => {
      await expect(
        service.approveBatch({ handoverIds: [], technologistId: 9 }, actor),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
    });

    it("odobri PENDING redove, preskoči zaključan/legacy/pogrešan status uz razlog", async () => {
      mockValidTechnologist();
      // 4 tražena: 1 PENDING (ok), 2 zaključan, 3 legacy, 4 već SAGLASAN.
      prisma.drawingHandover.findMany.mockResolvedValue([
        { id: 1, statusId: 0, isLocked: false, legacyRnId: null },
        { id: 2, statusId: 0, isLocked: true, legacyRnId: null },
        { id: 3, statusId: 0, isLocked: false, legacyRnId: 500 },
        { id: 4, statusId: 1, isLocked: false, legacyRnId: null },
      ]);
      prisma.drawingHandover.updateMany.mockResolvedValue({ count: 1 });

      const res = await service.approveBatch(
        { handoverIds: [1, 2, 3, 4], technologistId: 9, isUrgent: true },
        actor,
      );

      // Samo id=1 je eligible → updateMany po tom skupu, sa istim guardom.
      expect(prisma.drawingHandover.updateMany).toHaveBeenCalledWith({
        where: { id: { in: [1] }, statusId: 0, isLocked: false },
        data: containing({
          statusId: 1,
          technologistId: 9,
          isUrgent: true,
          statusChangedById: 77,
        }),
      });
      expect(res.data.approved).toBe(1);
      expect(res.data.skipped.map((s) => s.id).sort()).toEqual([2, 3, 4]);
    });

    it("422 za neaktivnog/nepostojećeg tehnologa — bez ikakvog upisa", async () => {
      prisma.worker.findUnique.mockResolvedValue(null);
      await expect(
        service.approveBatch({ handoverIds: [1], technologistId: 999 }, actor),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
      expect(prisma.drawingHandover.updateMany).not.toHaveBeenCalled();
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

    it("vraća na 0 i čisti tehnologa + audit dodele + rok (§6.5.1)", async () => {
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
          technologistAssignedAt: null,
          technologistAssignedById: null,
          productionDeadline: null,
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

  // --------------------------------------------------------- TAKE-OVER (§6.4)

  describe("takeOver", () => {
    /** Akter 77 = aktivan radnik vrste 'Tehnolog'. */
    function mockTechnologistActor() {
      prisma.worker.findUnique.mockResolvedValue({
        id: 77,
        active: true,
        workerTypeId: 1,
      });
    }

    /** SAGLASNA primopredaja tehnologa 9 (nije akterova). */
    function mockApprovedHandover(over: Record<string, unknown> = {}) {
      prisma.drawingHandover.findUnique.mockResolvedValue({
        id: 5,
        statusId: 1,
        isLocked: false,
        legacyRnId: null,
        technologistId: 9,
        ...over,
      });
    }

    it("422 kad nalog nije vezan ni u tokenu ni u bazi (svež lookup takođe null)", async () => {
      // JWT bez workerId → resolveActorWorkerId proba svež users.worker_id; kad
      // je i tamo null, i dalje 422 (ali JESTE pokušan svež lookup, ne slepo iz tokena).
      prisma.user.findUnique.mockResolvedValue({ workerId: null });
      await expect(service.takeOver(5, actorNoWorker)).rejects.toBeInstanceOf(
        UnprocessableEntityException,
      );
      expect(prisma.user.findUnique).toHaveBeenCalledWith({
        where: { id: actorNoWorker.userId },
        select: { workerId: true },
      });
      expect(prisma.worker.findUnique).not.toHaveBeenCalled();
      expect(prisma.drawingHandover.updateMany).not.toHaveBeenCalled();
    });

    it("STALE token (workerId null), ali users.worker_id vezan naknadno → preuzima (svež lookup)", async () => {
      // Igor-scenario na take-over: token nema worker, baza ga ima → NE 422.
      prisma.user.findUnique.mockResolvedValue({ workerId: 77 });
      mockTechnologistActor(); // worker 77 = aktivan Tehnolog
      mockApprovedHandover();
      await service.takeOver(5, actorNoWorker);
      // worker check je tekao nad SVEŽE razrešenim id-em 77, ne nad tokenom
      expect(prisma.worker.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 77 } }),
      );
      expect(prisma.drawingHandover.updateMany).toHaveBeenCalled();
    });

    it("422 kad akter nije radnik vrste 'Tehnolog'", async () => {
      prisma.worker.findUnique.mockResolvedValue({
        id: 77,
        active: true,
        workerTypeId: 3, // šef/kontrolor — ima primopredaje.write, ali nije Tehnolog
      });
      await expect(service.takeOver(5, actor)).rejects.toBeInstanceOf(
        UnprocessableEntityException,
      );
      expect(prisma.drawingHandover.updateMany).not.toHaveBeenCalled();
    });

    it("422 kad je akter neaktivan radnik vrste 'Tehnolog'", async () => {
      prisma.worker.findUnique.mockResolvedValue({
        id: 77,
        active: false,
        workerTypeId: 1,
      });
      await expect(service.takeOver(5, actor)).rejects.toBeInstanceOf(
        UnprocessableEntityException,
      );
    });

    it("preuzima: uslovni updateMany (where ponavlja preduslove) + audit kolone; RN worker_id prati tehnologa", async () => {
      mockTechnologistActor();
      mockApprovedHandover();
      prisma.workOrder.findFirst.mockResolvedValue({
        id: 42,
        identNumber: "P100/7",
        handoverStatusId: 1, // pripremljen, NE lansiran
        isLocked: false,
      });

      const result = await service.takeOver(5, actor);

      expect(prisma.drawingHandover.updateMany).toHaveBeenCalledWith({
        where: { id: 5, statusId: 1, isLocked: false },
        data: containing({
          technologistId: 77,
          technologistAssignedAt: expect.any(Date) as Date,
          technologistAssignedById: 77, // preuzimalac = sam sebi
        }),
      });
      // Pripremljen (nelansiran/nezaključan) RN prati tehnologa — uslovno.
      // OR hvata i is_locked NULL (legacy sync ostavlja NULL; `isLocked: false`
      // ga NE matchuje → worker_id se tiho ne bi prepisao).
      expect(prisma.workOrder.updateMany).toHaveBeenCalledWith({
        where: {
          id: 42,
          OR: [{ isLocked: false }, { isLocked: null }],
          handoverStatusId: { not: 3 },
        },
        data: { workerId: 77 },
      });
      expect(result).toEqual({ data: { id: 5 } });
      expect(result).not.toHaveProperty("alreadyOwner");
    });

    it("notifikacija prethodnom tehnologu — best-effort, posle upisa", async () => {
      mockTechnologistActor();
      mockApprovedHandover();

      await service.takeOver(5, actor);

      expect(notifications.notifyWorkers).toHaveBeenCalledWith(
        [9],
        containing({
          type: "primopredaja.preuzeta",
          refTable: "drawing_handovers",
          refId: 5,
        }),
      );
    });

    it("pad notifikacije NE obara preuzimanje", async () => {
      mockTechnologistActor();
      mockApprovedHandover();
      notifications.notifyWorkers.mockRejectedValue(new Error("smtp down"));

      await expect(service.takeOver(5, actor)).resolves.toEqual({
        data: { id: 5 },
      });
    });

    it("bez notifikacije kad tehnolog nije bio dodeljen (technologistId=0)", async () => {
      mockTechnologistActor();
      mockApprovedHandover({ technologistId: 0 });

      await service.takeOver(5, actor);

      expect(prisma.drawingHandover.updateMany).toHaveBeenCalled();
      expect(notifications.notifyWorkers).not.toHaveBeenCalled();
    });

    it("idempotentno: već moj → alreadyOwner:true, BEZ upisa i BEZ notifikacije", async () => {
      mockTechnologistActor();
      mockApprovedHandover({ technologistId: 77 });

      const result = await service.takeOver(5, actor);

      expect(result).toEqual({ data: { id: 5 }, alreadyOwner: true });
      expect(prisma.drawingHandover.updateMany).not.toHaveBeenCalled();
      expect(prisma.workOrder.updateMany).not.toHaveBeenCalled();
      expect(notifications.notifyWorkers).not.toHaveBeenCalled();
    });

    it("ne dira LANSIRAN/zaključan RN (worker_id ostaje)", async () => {
      mockTechnologistActor();
      mockApprovedHandover();
      prisma.workOrder.findFirst.mockResolvedValue({
        id: 42,
        identNumber: "P100/7",
        handoverStatusId: 3, // lansiran RN — vlasnik se ne menja
        isLocked: false,
      });

      await service.takeOver(5, actor);

      expect(prisma.drawingHandover.updateMany).toHaveBeenCalled();
      expect(prisma.workOrder.updateMany).not.toHaveBeenCalled();
    });

    it("409 za legacy (derivirani) red — bez upisa", async () => {
      mockTechnologistActor();
      mockApprovedHandover({ legacyRnId: 1126 });

      await expect(service.takeOver(5, actor)).rejects.toThrow(/QBigTehn/);
      expect(prisma.drawingHandover.updateMany).not.toHaveBeenCalled();
    });

    it("409 kad je primopredaja LANSIRANA (statusId=3)", async () => {
      mockTechnologistActor();
      mockApprovedHandover({ statusId: 3 });

      await expect(service.takeOver(5, actor)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(prisma.drawingHandover.updateMany).not.toHaveBeenCalled();
    });

    it("409 kad je primopredaja zaključana", async () => {
      mockTechnologistActor();
      mockApprovedHandover({ isLocked: true });

      await expect(service.takeOver(5, actor)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(prisma.drawingHandover.updateMany).not.toHaveBeenCalled();
    });

    it("409 za konkurentnog gubitnika (updateMany count=0) — bez RN update-a i notifikacije", async () => {
      mockTechnologistActor();
      mockApprovedHandover();
      prisma.drawingHandover.updateMany.mockResolvedValue({ count: 0 });

      await expect(service.takeOver(5, actor)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(prisma.workOrder.updateMany).not.toHaveBeenCalled();
      expect(notifications.notifyWorkers).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------- PREPARE-WORK-ORDER

  describe("prepareWorkOrder", () => {
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

    it("propagira rok primopredaje (production_deadline iz approve-a) u RN (§6.5.1)", async () => {
      const deadline = new Date("2026-09-01");
      prisma.drawingHandover.findUnique.mockResolvedValue({
        ...approvedHandover,
        productionDeadline: deadline,
      });
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

      await service.prepareWorkOrder(5, actor);

      expect(prisma.workOrder.create).toHaveBeenCalledWith(
        containing({
          data: containing({ productionDeadline: deadline }),
        }),
      );
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
      prisma.workOrder.findUnique.mockResolvedValue({
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
      // Uslovni updateMany (guard protiv konkurentnog RN-level prelaza).
      // OR hvata i is_locked NULL (legacy sync ostavlja NULL — inače lažni 409).
      expect(prisma.workOrder.updateMany).toHaveBeenCalledWith(
        containing({
          where: {
            id: 42,
            handoverStatusId: 1,
            OR: [{ isLocked: false }, { isLocked: null }],
          },
          data: containing({
            handoverStatusId: 3,
            productionDeadline: expect.any(Date),
          }),
        }),
      );
      // `note` postojećeg RN-a se NE prepisuje launch komentarom (komentar ide
      // u drawing_handovers.statusChangeComment).
      const updateManyData = (
        prisma.workOrder.updateMany.mock.calls[0] as [
          { data: Record<string, unknown> },
        ]
      )[0].data;
      expect(updateManyData).not.toHaveProperty("note");
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

    it("eksplicitni launch dueDate ima prednost nad rokom primopredaje (override §6.5.1)", async () => {
      prisma.drawingHandover.findUnique.mockResolvedValue({
        ...approvedHandover,
        productionDeadline: new Date("2026-09-01"), // rok iz approve-a
      });
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
        handoverStatusId: 3,
      });

      await service.launch(5, { dueDate: "2026-08-01" }, actor);

      expect(prisma.workOrder.create).toHaveBeenCalledWith(
        containing({
          data: containing({
            productionDeadline: new Date("2026-08-01"), // launch, ne approve rok
          }),
        }),
      );
    });

    it("bez launch dueDate-a novi RN nasleđuje rok primopredaje (§6.5.1)", async () => {
      const deadline = new Date("2026-09-01");
      prisma.drawingHandover.findUnique.mockResolvedValue({
        ...approvedHandover,
        productionDeadline: deadline,
      });
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
        handoverStatusId: 3,
      });

      await service.launch(5, {}, actor);

      expect(prisma.workOrder.create).toHaveBeenCalledWith(
        containing({
          data: containing({ productionDeadline: deadline }),
        }),
      );
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

    it("409 na approve za derivirani red — bez upisa", async () => {
      mockValidTechnologist();
      prisma.drawingHandover.findUnique.mockResolvedValue(derivedPending);

      await expect(
        service.approve(5, { technologistId: 9 }, actor),
      ).rejects.toBeInstanceOf(ConflictException);
      await expect(
        service.approve(5, { technologistId: 9 }, actor),
      ).rejects.toThrow(/QBigTehn/);
      expect(prisma.drawingHandover.updateMany).not.toHaveBeenCalled();
    });

    it("409 na reject za derivirani red — bez upisa", async () => {
      prisma.drawingHandover.findUnique.mockResolvedValue(derivedPending);

      await expect(service.reject(5, "razlog", actor)).rejects.toThrow(
        /QBigTehn/,
      );
      expect(prisma.drawingHandover.updateMany).not.toHaveBeenCalled();
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

      expect(prisma.drawingHandover.updateMany).toHaveBeenCalledWith({
        where: { id: 5, statusId: 0, isLocked: false },
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

      expect(prisma.drawingHandover.updateMany).toHaveBeenCalledWith({
        where: { id: 5, statusId: 0, isLocked: false },
        data: containing({ statusId: 1 }),
      });
    });
  });
});
