import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { NotificationsService } from "../notifications/notifications.service";
import { QualityEventsService } from "./quality-events.service";
import { QualityEventsMailService } from "./quality-events-mail.service";
import { ROLES } from "../../common/authz/roles";
import type { AuthUser } from "../auth/jwt.strategy";

/** Pun red `quality_events` (mapEvent čita sva polja). */
function baseEvent(over: Record<string, unknown> = {}) {
  return {
    id: 1,
    type: "SKART",
    status: "POTVRDJEN",
    workOrderId: 100,
    techProcessId: null,
    qty: new Prisma.Decimal(2),
    unit: "kom",
    reasonCodeId: 5,
    note: null,
    machineId: null,
    workUnitCode: "CNC1",
    reportedByWorkerId: 9,
    reportedAt: new Date("2026-07-26T08:00:00Z"),
    confirmedByUserId: 3,
    confirmedAt: new Date("2026-07-26T08:05:00Z"),
    rejectedByUserId: null,
    rejectedAt: null,
    rejectReason: null,
    photoPath: null,
    createdByUserId: 3,
    createdAt: new Date("2026-07-26T08:00:00Z"),
    updatedAt: new Date("2026-07-26T08:05:00Z"),
    ...over,
  };
}

interface PrismaMock {
  qualityEvent: {
    create: jest.Mock;
    findUnique: jest.Mock;
    findMany: jest.Mock;
    count: jest.Mock;
    updateMany: jest.Mock;
    groupBy: jest.Mock;
  };
  qualityReasonCode: { findUnique: jest.Mock; findMany: jest.Mock };
  worker: { findFirst: jest.Mock; findMany: jest.Mock };
  user: { findUnique: jest.Mock; findMany: jest.Mock };
  techProcess: { findUnique: jest.Mock };
  workOrder: { findUnique: jest.Mock; findMany: jest.Mock };
}

function prismaMock(): PrismaMock {
  return {
    qualityEvent: {
      create: jest.fn().mockResolvedValue(baseEvent()),
      findUnique: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      groupBy: jest.fn().mockResolvedValue([]),
    },
    qualityReasonCode: {
      findUnique: jest.fn().mockResolvedValue({ id: 5, active: true }),
      findMany: jest
        .fn()
        .mockResolvedValue([
          { id: 5, code: "OBRADA", label: "Greška u obradi" },
        ]),
    },
    worker: {
      findFirst: jest
        .fn()
        .mockResolvedValue({ id: 9, fullName: "Pera Perić", username: "pera" }),
      findMany: jest
        .fn()
        .mockResolvedValue([
          { id: 9, fullName: "Pera Perić", username: "pera" },
        ]),
    },
    user: {
      findUnique: jest.fn().mockResolvedValue({ workerId: 9 }),
      // resolveManagementWorkerIds selektuje {workerId}; resolveUsers selektuje {id,fullName}.
      findMany: jest
        .fn()
        .mockImplementation((args: { select?: { workerId?: boolean } }) =>
          args?.select?.workerId
            ? Promise.resolve([{ workerId: 9 }])
            : Promise.resolve([{ id: 3, fullName: "Kontrolor K" }]),
        ),
    },
    techProcess: {
      findUnique: jest
        .fn()
        .mockResolvedValue({ id: 7, workOrderId: 100, workCenterCode: "CNC1" }),
    },
    workOrder: {
      findUnique: jest.fn().mockResolvedValue({ id: 100, identNumber: "4698" }),
      findMany: jest.fn().mockResolvedValue([{ id: 100, identNumber: "4698" }]),
    },
  };
}

const CONTROLLER: AuthUser = {
  userId: 3,
  email: "kontrolor@servoteh.com",
  role: ROLES.KONTROLOR,
  workerId: 9,
};
const KIOSK: AuthUser = {
  userId: 50,
  email: "kiosk@servoteh.com",
  role: ROLES.PROIZVODNI_RADNIK,
  workerId: null,
};

function makeService(prisma: PrismaMock) {
  const notifications = { notifyWorkers: jest.fn().mockResolvedValue(1) };
  const mail = {
    notifyManagementThreshold: jest.fn().mockResolvedValue(true),
  };
  const service = new QualityEventsService(
    prisma as unknown as PrismaService,
    notifications as unknown as NotificationsService,
    mail as unknown as QualityEventsMailService,
  );
  return { service, notifications, mail };
}

function firstCallData(m: jest.Mock): Record<string, unknown> {
  const calls = m.mock.calls as Array<[{ data: Record<string, unknown> }]>;
  return calls[0][0].data;
}

describe("QualityEventsService", () => {
  let prisma: PrismaMock;

  beforeEach(() => {
    prisma = prismaMock();
    jest.clearAllMocks();
  });

  // ── KONTROLOR UNOS (POTVRDJEN) ───────────────────────────────────────────
  describe("createByController", () => {
    it("nastaje ODMAH kao POTVRDJEN, confirmedBy = actor, reason + RN validiran", async () => {
      prisma.qualityEvent.create.mockResolvedValue(baseEvent());
      const { service } = makeService(prisma);
      const out = await service.createByController(
        { type: "SKART", workOrderId: 100, qty: 2, reasonCodeId: 5 },
        CONTROLLER,
      );
      const data = firstCallData(prisma.qualityEvent.create);
      expect(data.status).toBe("POTVRDJEN");
      expect(data.confirmedByUserId).toBe(3);
      expect(data.reasonCodeId).toBe(5);
      expect(prisma.qualityReasonCode.findUnique).toHaveBeenCalled();
      expect(prisma.workOrder.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 100 } }),
      );
      // review [4]: odgovor nosi poslovni broj RN-a (ident), ne samo interni id.
      expect(out.data.workOrderIdent).toBe("4698");
      expect(out.data.status).toBe("POTVRDJEN");
    });

    it("reporter NIJE default kontrolor (review [7]): bez izbora → null", async () => {
      prisma.qualityEvent.create.mockResolvedValue(baseEvent());
      const { service } = makeService(prisma);
      await service.createByController(
        { type: "SKART", workOrderId: 100, qty: 2, reasonCodeId: 5 },
        CONTROLLER,
      );
      const data = firstCallData(prisma.qualityEvent.create);
      expect(data.reportedByWorkerId).toBeNull();
    });

    it("RN koji ne postoji → 422 (bez upisa) [review 0]", async () => {
      prisma.workOrder.findUnique.mockResolvedValue(null);
      const { service } = makeService(prisma);
      await expect(
        service.createByController(
          { type: "SKART", workOrderId: 77777, qty: 2, reasonCodeId: 5 },
          CONTROLLER,
        ),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
      expect(prisma.qualityEvent.create).not.toHaveBeenCalled();
    });

    it("operacija ne pripada RN-u → 422 [review 6]", async () => {
      prisma.techProcess.findUnique.mockResolvedValue({
        id: 7,
        workOrderId: 999, // drugi RN
        workCenterCode: "CNC1",
      });
      const { service } = makeService(prisma);
      await expect(
        service.createByController(
          {
            type: "SKART",
            workOrderId: 100,
            qty: 2,
            reasonCodeId: 5,
            techProcessId: 7,
          },
          CONTROLLER,
        ),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
      expect(prisma.qualityEvent.create).not.toHaveBeenCalled();
    });

    it("qty sub-granica (0.0004 → zaokruži na 0) → 400 [review 1]", async () => {
      const { service } = makeService(prisma);
      await expect(
        service.createByController(
          { type: "SKART", workOrderId: 100, qty: 0.0004, reasonCodeId: 5 },
          CONTROLLER,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("qty preko granice (1e12 → numeric overflow) → 400 [review 9]", async () => {
      const { service } = makeService(prisma);
      await expect(
        service.createByController(
          { type: "SKART", workOrderId: 100, qty: 1e12, reasonCodeId: 5 },
          CONTROLLER,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("razlog koji ne postoji → 422 (bez upisa)", async () => {
      prisma.qualityReasonCode.findUnique.mockResolvedValue(null);
      const { service } = makeService(prisma);
      await expect(
        service.createByController(
          { type: "SKART", workOrderId: 100, qty: 2, reasonCodeId: 999 },
          CONTROLLER,
        ),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
      expect(prisma.qualityEvent.create).not.toHaveBeenCalled();
    });

    it("ukinut (soft-delete) razlog → 422", async () => {
      prisma.qualityReasonCode.findUnique.mockResolvedValue({
        id: 5,
        active: false,
      });
      const { service } = makeService(prisma);
      await expect(
        service.createByController(
          { type: "DORADA", workOrderId: 100, qty: 1, reasonCodeId: 5 },
          CONTROLLER,
        ),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
    });

    it("nevalidan tip → 400", async () => {
      const { service } = makeService(prisma);
      await expect(
        service.createByController(
          { type: "NESTO", workOrderId: 100, qty: 1, reasonCodeId: 5 },
          CONTROLLER,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("qty ≤ 0 → 400", async () => {
      const { service } = makeService(prisma);
      await expect(
        service.createByController(
          { type: "SKART", workOrderId: 100, qty: 0, reasonCodeId: 5 },
          CONTROLLER,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // ── KIOSK PRIJAVA (PRIJAVLJEN) ───────────────────────────────────────────
  describe("prijava", () => {
    it("nastaje kao PRIJAVLJEN, radnik razrešen iz kartice", async () => {
      prisma.qualityEvent.create.mockResolvedValue(
        baseEvent({ status: "PRIJAVLJEN", reasonCodeId: null }),
      );
      const { service } = makeService(prisma);
      await service.prijava(
        { type: "SKART", workOrderId: 100, qty: 3, workerCard: "CARD-9" },
        KIOSK,
      );
      const data = firstCallData(prisma.qualityEvent.create);
      expect(data.status).toBe("PRIJAVLJEN");
      expect(data.reportedByWorkerId).toBe(9);
      // review [8]: kartica se traži samo za AKTIVNOG radnika (active: { not: false }).
      expect(prisma.worker.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { cardId: "CARD-9", active: { not: false } },
        }),
      );
    });

    it("nepoznata / neaktivna kartica → 422", async () => {
      prisma.worker.findFirst.mockResolvedValue(null);
      const { service } = makeService(prisma);
      await expect(
        service.prijava(
          { type: "SKART", workOrderId: 100, qty: 3, workerCard: "X" },
          KIOSK,
        ),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
    });

    it("RN koji ne postoji → 422 (i za kiosk put) [review 0]", async () => {
      prisma.workOrder.findUnique.mockResolvedValue(null);
      const { service } = makeService(prisma);
      await expect(
        service.prijava(
          { type: "SKART", workOrderId: 77777, qty: 3, workerCard: "CARD-9" },
          KIOSK,
        ),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
      expect(prisma.qualityEvent.create).not.toHaveBeenCalled();
    });

    it("bez kartice → 400", async () => {
      const { service } = makeService(prisma);
      await expect(
        service.prijava(
          { type: "SKART", workOrderId: 100, qty: 3, workerCard: "  " },
          KIOSK,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("prijava NE okida zvonce (PRIJAVLJEN ne ulazi u izveštaje)", async () => {
      prisma.qualityEvent.create.mockResolvedValue(
        baseEvent({ status: "PRIJAVLJEN", qty: new Prisma.Decimal(50) }),
      );
      const { service, notifications } = makeService(prisma);
      await service.prijava(
        { type: "SKART", workOrderId: 100, qty: 50, workerCard: "CARD-9" },
        KIOSK,
      );
      expect(notifications.notifyWorkers).not.toHaveBeenCalled();
    });
  });

  // ── POTVRDA (CAS) ────────────────────────────────────────────────────────
  describe("confirm (PRIJAVLJEN → POTVRDJEN)", () => {
    it("CAS na status PRIJAVLJEN, upisuje razlog + confirmedBy", async () => {
      prisma.qualityEvent.findUnique
        .mockResolvedValueOnce({
          id: 1,
          status: "PRIJAVLJEN",
          workOrderId: 100,
        })
        .mockResolvedValueOnce(baseEvent({ status: "POTVRDJEN" }));
      const { service } = makeService(prisma);
      const out = await service.confirm(1, { reasonCodeId: 5 }, CONTROLLER);
      const cas = prisma.qualityEvent.updateMany.mock.calls as Array<
        [
          {
            where: { id: number; status: string };
            data: Record<string, unknown>;
          },
        ]
      >;
      expect(cas[0][0].where).toEqual({ id: 1, status: "PRIJAVLJEN" });
      expect(cas[0][0].data.status).toBe("POTVRDJEN");
      expect(cas[0][0].data.reasonCodeId).toBe(5);
      expect(cas[0][0].data.confirmedByUserId).toBe(3);
      expect(out.data.status).toBe("POTVRDJEN");
    });

    it("događaj ne postoji → 404", async () => {
      prisma.qualityEvent.findUnique.mockResolvedValue(null);
      const { service } = makeService(prisma);
      await expect(
        service.confirm(1, { reasonCodeId: 5 }, CONTROLLER),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it("nije PRIJAVLJEN (već potvrđen) → 409", async () => {
      prisma.qualityEvent.findUnique.mockResolvedValue({
        id: 1,
        status: "POTVRDJEN",
      });
      const { service } = makeService(prisma);
      await expect(
        service.confirm(1, { reasonCodeId: 5 }, CONTROLLER),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.qualityEvent.updateMany).not.toHaveBeenCalled();
    });

    it("CAS promašaj (status se u međuvremenu promenio) → 409", async () => {
      prisma.qualityEvent.findUnique.mockResolvedValue({
        id: 1,
        status: "PRIJAVLJEN",
      });
      prisma.qualityEvent.updateMany.mockResolvedValue({ count: 0 });
      const { service } = makeService(prisma);
      await expect(
        service.confirm(1, { reasonCodeId: 5 }, CONTROLLER),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it("bez razloga → 400 (razlog obavezan za potvrdu)", async () => {
      const { service } = makeService(prisma);
      await expect(
        service.confirm(1, {} as { reasonCodeId: number }, CONTROLLER),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // ── ODBACIVANJE (CAS) ────────────────────────────────────────────────────
  describe("reject (PRIJAVLJEN → ODBACEN)", () => {
    it("upisuje ODBACEN + rejectReason + rejectedBy", async () => {
      prisma.qualityEvent.findUnique
        .mockResolvedValueOnce({
          id: 1,
          status: "PRIJAVLJEN",
          workOrderId: 100,
        })
        .mockResolvedValueOnce(
          baseEvent({ status: "ODBACEN", rejectReason: "Greška u prijavi" }),
        );
      const { service } = makeService(prisma);
      const out = await service.reject(
        1,
        { rejectReason: "Greška u prijavi" },
        CONTROLLER,
      );
      const data = firstCallData(prisma.qualityEvent.updateMany);
      expect(data.status).toBe("ODBACEN");
      expect(data.rejectReason).toBe("Greška u prijavi");
      expect(data.rejectedByUserId).toBe(3);
      expect(out.data.status).toBe("ODBACEN");
    });

    it("bez rejectReason → 400", async () => {
      const { service } = makeService(prisma);
      await expect(
        service.reject(1, { rejectReason: "  " }, CONTROLLER),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("nije PRIJAVLJEN → 409", async () => {
      prisma.qualityEvent.findUnique.mockResolvedValue({
        id: 1,
        status: "ODBACEN",
      });
      const { service } = makeService(prisma);
      await expect(
        service.reject(1, { rejectReason: "x" }, CONTROLLER),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  // ── ZVONCE / PRAG ────────────────────────────────────────────────────────
  describe("prag (zvonce menadžmentu, samo POTVRDJEN)", () => {
    it("velika qty (≥ 5) → notifyWorkers menadžmentu + mail", async () => {
      prisma.qualityEvent.create.mockResolvedValue(
        baseEvent({ qty: new Prisma.Decimal(6) }),
      );
      const { service, notifications, mail } = makeService(prisma);
      await service.createByController(
        { type: "SKART", workOrderId: 100, qty: 6, reasonCodeId: 5 },
        CONTROLLER,
      );
      expect(notifications.notifyWorkers).toHaveBeenCalledWith(
        [9],
        expect.objectContaining({
          type: "kvalitet.skart",
          refTable: "quality_events",
          refId: 1,
        }),
      );
      expect(mail.notifyManagementThreshold).toHaveBeenCalled();
    });

    it("≥ 3 potvrđena istog razloga u 7 dana → zvonce", async () => {
      prisma.qualityEvent.create.mockResolvedValue(
        baseEvent({ qty: new Prisma.Decimal(1) }),
      );
      prisma.qualityEvent.count.mockResolvedValue(3); // recent same-reason count
      const { service, notifications } = makeService(prisma);
      await service.createByController(
        { type: "SKART", workOrderId: 100, qty: 1, reasonCodeId: 5 },
        CONTROLLER,
      );
      expect(notifications.notifyWorkers).toHaveBeenCalled();
    });

    it("ispod praga → nema zvonca", async () => {
      prisma.qualityEvent.create.mockResolvedValue(
        baseEvent({ qty: new Prisma.Decimal(1) }),
      );
      prisma.qualityEvent.count.mockResolvedValue(1);
      const { service, notifications } = makeService(prisma);
      await service.createByController(
        { type: "SKART", workOrderId: 100, qty: 1, reasonCodeId: 5 },
        CONTROLLER,
      );
      expect(notifications.notifyWorkers).not.toHaveBeenCalled();
    });

    it("upis NE pada kad zvonce baci (best-effort)", async () => {
      prisma.qualityEvent.create.mockResolvedValue(
        baseEvent({ qty: new Prisma.Decimal(6) }),
      );
      const { service, notifications } = makeService(prisma);
      notifications.notifyWorkers.mockRejectedValue(new Error("db down"));
      const out = await service.createByController(
        { type: "SKART", workOrderId: 100, qty: 6, reasonCodeId: 5 },
        CONTROLLER,
      );
      expect(out.data.id).toBe(1);
    });
  });

  // ── PARETO (samo POTVRDJEN) ──────────────────────────────────────────────
  describe("pareto", () => {
    it("filtrira SAMO POTVRDJEN + računa procente po qty", async () => {
      prisma.qualityEvent.groupBy
        .mockResolvedValueOnce([
          {
            reasonCodeId: 5,
            _count: { _all: 2 },
            _sum: { qty: new Prisma.Decimal(30) },
          },
          {
            reasonCodeId: 6,
            _count: { _all: 1 },
            _sum: { qty: new Prisma.Decimal(10) },
          },
        ])
        .mockResolvedValueOnce([
          {
            workUnitCode: "CNC1",
            _count: { _all: 3 },
            _sum: { qty: new Prisma.Decimal(40) },
          },
        ]);
      prisma.qualityReasonCode.findMany.mockResolvedValue([
        { id: 5, label: "Greška u obradi" },
        { id: 6, label: "Loš materijal" },
      ]);
      const { service } = makeService(prisma);
      const out = await service.pareto({ type: "SKART" });

      const whereArg = (
        prisma.qualityEvent.groupBy.mock.calls[0] as Array<{
          where: { status: string; type?: string };
        }>
      )[0].where;
      expect(whereArg.status).toBe("POTVRDJEN");
      expect(whereArg.type).toBe("SKART");

      expect(out.data.byReason[0]).toMatchObject({
        reasonCodeId: 5,
        label: "Greška u obradi",
        qty: 30,
        percent: 75, // 30 / 40 total
      });
      expect(out.data.byMachine[0]).toMatchObject({
        workUnitCode: "CNC1",
        qty: 40,
        percent: 100,
      });
    });
  });

  // ── LISTA ────────────────────────────────────────────────────────────────
  describe("list", () => {
    it("vraća pendingCount (red čekanja PRIJAVLJEN) u meta", async () => {
      prisma.qualityEvent.findMany.mockResolvedValue([baseEvent()]);
      prisma.qualityEvent.count
        .mockResolvedValueOnce(1) // total
        .mockResolvedValueOnce(4); // pendingCount
      const { service } = makeService(prisma);
      const out = await service.list({ type: "SKART" });
      expect(out.meta.pendingCount).toBe(4);
      expect(out.data).toHaveLength(1);
    });
  });
});
