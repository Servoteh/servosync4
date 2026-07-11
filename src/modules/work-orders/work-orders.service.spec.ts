import "reflect-metadata";
import { Test, TestingModule } from "@nestjs/testing";
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { WorkOrdersService } from "./work-orders.service";
import { WorkOrdersController } from "./work-orders.controller";
import { WorkOrderNumberingService } from "./work-order-numbering.service";
import { PERMISSION_KEY_METADATA } from "../../common/authz/require-permission.decorator";
import { PERMISSIONS } from "../../common/authz/permissions";
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
      create: jest.fn().mockResolvedValue({ id: 101 }),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      aggregate: jest.fn().mockResolvedValue({ _max: { variant: null } }),
    },
    workOrderOperation: {
      count: jest.fn().mockResolvedValue(1),
      findUnique: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
      update: jest.fn().mockResolvedValue({}),
    },
    workOrderNonstandardPart: {
      findMany: jest.fn().mockResolvedValue([]),
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    workOrderMachinedPart: {
      findMany: jest.fn().mockResolvedValue([]),
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    workOrderBlank: {
      findMany: jest.fn().mockResolvedValue([]),
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    operation: { findMany: jest.fn().mockResolvedValue([]) },
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
      // OR hvata i is_locked NULL (legacy sync ostavlja NULL; `isLocked: false`
      // ga NE matchuje → trajni lažni 409 na legacy RN-u).
      expect(prisma.workOrder.updateMany).toHaveBeenCalledWith({
        where: {
          id: 7,
          handoverStatusId: 1,
          OR: [{ isLocked: false }, { isLocked: null }],
        },
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

  describe("cloneVariant (D5 klon kao sledeća varijanta)", () => {
    /** Izvorni RN (podskup polja koja klon čita; ostala su null-safe u mocku). */
    const source = {
      id: 7,
      projectId: 15,
      identNumber: "123/4",
      variant: 0,
      externalCustomerId: 9,
      drawingNumber: "CRT-55",
      revision: "A",
      pieceCount: 10,
      partName: "Vratilo",
      material: "Č4732",
      materialDimension: "Ø50x200",
      unit: "kom",
      qualityTypeId: 0,
      workerId: 3,
      drawingHandoverId: 42,
      drawingId: 5,
      handoverStatusId: 3, // LANSIRAN — launch stanje se NE prenosi
      isLocked: true,
      status: true,
      note: null,
    };

    it("MAX(variant)+1 po VEĆEM od dva ključa (trojka ∪ ident) uz advisory lock; status/lock reset; drawingHandoverId se NE kopira", async () => {
      prisma.workOrder.findUnique.mockResolvedValue(source);
      prisma.workOrder.aggregate.mockResolvedValue({ _max: { variant: 2 } });
      prisma.workOrder.create.mockResolvedValue({
        id: 101,
        identNumber: "123/4",
        variant: 3,
      });

      const res = await service.cloneVariant(7);

      // Advisory lock po predmetu (isti ključ kao numbering/rework).
      const rawCalls = prisma.$executeRaw.mock.calls as unknown[][];
      const lock = rawCalls.find(
        (c) =>
          Array.isArray(c[0]) &&
          (c[0] as string[]).join("?").includes("pg_advisory_xact_lock"),
      );
      expect(lock).toBeDefined();
      expect(lock?.[1]).toBe(15);

      // MAX se traži po OBA ključa: legacy trojka + (predmet, ident) — štiti od
      // kolizije trojke kad updateHeader promeni crtež/reviziju nekoj varijanti.
      expect(prisma.workOrder.aggregate).toHaveBeenCalledWith({
        where: { projectId: 15, drawingNumber: "CRT-55", revision: "A" },
        _max: { variant: true },
      });
      expect(prisma.workOrder.aggregate).toHaveBeenCalledWith({
        where: { projectId: 15, identNumber: "123/4" },
        _max: { variant: true },
      });
      expect(prisma.workOrder.create).toHaveBeenCalledWith(
        containing({
          data: containing({
            identNumber: "123/4", // ISTI ident
            variant: 3, // MAX(2)+1
            handoverStatusId: 0, // U OBRADI, ne launch stanje izvora
            status: false,
            isLocked: false,
            drawingHandoverId: 0, // nova varijanta nije vezana za staru primopredaju
          }),
        }),
      );
      expect(res).toEqual({
        data: { workOrderId: 101, identNumber: "123/4", variant: 3 },
      });
    });

    it("kopira stavke kroz cloneItems (operacije na novi RN, prioritet regen iz RC-a)", async () => {
      prisma.workOrder.findUnique.mockResolvedValue(source);
      prisma.workOrder.aggregate.mockResolvedValue({ _max: { variant: 0 } });
      prisma.workOrder.create.mockResolvedValue({
        id: 101,
        identNumber: "123/4",
        variant: 1,
      });
      prisma.workOrderOperation.findMany.mockResolvedValue([
        {
          id: 900,
          workOrderId: 7,
          operationNumber: 10,
          workCenterCode: "GL",
          workDescription: "Struganje",
          toolsFixtures: null,
          setupTime: 1,
          cycleTime: 0.5,
          toolWeight: 0,
          workerId: 3,
          priority: 17, // izvorna vrednost se NE prenosi (regen §3.4)
        },
      ]);
      prisma.operation.findMany.mockResolvedValue([
        { workCenterCode: "GL", usesPriority: true },
      ]);

      await service.cloneVariant(7);

      expect(prisma.workOrderOperation.createMany).toHaveBeenCalledWith({
        data: [
          containing({
            workOrderId: 101,
            operationNumber: 10,
            workCenterCode: "GL",
            priority: 100, // usesPriority → 100
          }),
        ],
      });
    });

    it("drugi klon iste trojke → variant +2 (MAX napreduje)", async () => {
      prisma.workOrder.findUnique.mockResolvedValue(source);
      prisma.workOrder.aggregate
        .mockResolvedValueOnce({ _max: { variant: 0 } }) // 1. klon: trojka
        .mockResolvedValueOnce({ _max: { variant: 0 } }) // 1. klon: ident
        .mockResolvedValueOnce({ _max: { variant: 1 } }) // 2. klon: trojka
        .mockResolvedValueOnce({ _max: { variant: 1 } }); // 2. klon: ident
      prisma.workOrder.create
        .mockResolvedValueOnce({ id: 101, identNumber: "123/4", variant: 1 })
        .mockResolvedValueOnce({ id: 102, identNumber: "123/4", variant: 2 });

      const first = await service.cloneVariant(7);
      const second = await service.cloneVariant(7);

      expect(first.data.variant).toBe(1);
      expect(second.data.variant).toBe(2);
      expect(prisma.workOrder.create).toHaveBeenNthCalledWith(
        2,
        containing({ data: containing({ variant: 2 }) }),
      );
    });

    it("posle izmene crteža na klonu (updateHeader) MAX po identu čuva trojku od kolizije", async () => {
      prisma.workOrder.findUnique.mockResolvedValue(source);
      // Trojka (predmet, crtež, revizija) vidi samo var. 0 (klonu var. 1 je
      // updateHeader promenio crtež), ali MAX po identu = 1 → nova varijanta 2,
      // ne već zauzeta 1 (na trojku se vezuju tech_processes/RNZ barkod).
      prisma.workOrder.aggregate
        .mockResolvedValueOnce({ _max: { variant: 0 } }) // po trojci
        .mockResolvedValueOnce({ _max: { variant: 1 } }); // po identu
      prisma.workOrder.create.mockResolvedValue({
        id: 103,
        identNumber: "123/4",
        variant: 2,
      });

      const res = await service.cloneVariant(7);

      expect(prisma.workOrder.create).toHaveBeenCalledWith(
        containing({ data: containing({ variant: 2 }) }),
      );
      expect(res.data.variant).toBe(2);
    });

    it("404 kad izvorni RN ne postoji", async () => {
      prisma.workOrder.findUnique.mockResolvedValue(null);
      await expect(service.cloneVariant(999)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(prisma.workOrder.create).not.toHaveBeenCalled();
    });
  });

  describe("setOperationPriority (D7 CAM prioritet)", () => {
    beforeEach(() => {
      prisma.workOrderOperation.findUnique.mockResolvedValue({
        id: 33,
        workOrderId: 7,
      });
    });

    it("menja prioritet i na LANSIRANOM RN-u (nije zaključan)", async () => {
      prisma.workOrder.findUnique.mockResolvedValue({ isLocked: false });
      prisma.workOrderOperation.update.mockResolvedValue({
        id: 33,
        workOrderId: 7,
        priority: 5,
      });

      const res = await service.setOperationPriority(33, 5);

      expect(prisma.workOrderOperation.update).toHaveBeenCalledWith({
        where: { id: 33 },
        data: { priority: 5 },
        select: { id: true, workOrderId: true, priority: true },
      });
      expect(res).toEqual({
        data: { id: 33, workOrderId: 7, priority: 5 },
      });
    });

    it("422 kad je RN zaključan", async () => {
      prisma.workOrder.findUnique.mockResolvedValue({ isLocked: true });
      await expect(service.setOperationPriority(33, 5)).rejects.toBeInstanceOf(
        UnprocessableEntityException,
      );
      expect(prisma.workOrderOperation.update).not.toHaveBeenCalled();
    });

    it("400 van opsega / ne-ceo broj (0–255)", async () => {
      for (const bad of [-1, 256, 1.5, Number.NaN]) {
        await expect(
          service.setOperationPriority(33, bad),
        ).rejects.toBeInstanceOf(BadRequestException);
      }
      expect(prisma.workOrderOperation.update).not.toHaveBeenCalled();
    });

    it("404 kad operacija ne postoji", async () => {
      prisma.workOrderOperation.findUnique.mockResolvedValue(null);
      await expect(
        service.setOperationPriority(999, 10),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it("endpoint je iza `tehnologija.write` (CNC programer nema rn.write), clone-variant iza `rn.write`", () => {
      // Permisija je metadata na handler-u — guard je čita; ovo čuva da refactor
      // ne vrati prioritet pod rn.write (poenta D7) niti skine RN_WRITE sa klona.
      const handler = (name: string): object =>
        Object.getOwnPropertyDescriptor(WorkOrdersController.prototype, name)
          ?.value as object;
      expect(
        Reflect.getMetadata(
          PERMISSION_KEY_METADATA,
          handler("setOperationPriority"),
        ),
      ).toBe(PERMISSIONS.TEHNOLOGIJA_WRITE);
      expect(
        Reflect.getMetadata(PERMISSION_KEY_METADATA, handler("cloneVariant")),
      ).toBe(PERMISSIONS.RN_WRITE);
    });
  });
});
