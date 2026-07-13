import { Test, TestingModule } from "@nestjs/testing";
import {
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { CncProgramsService } from "./cnc-programs.service";
import { PERMISSIONS } from "../../common/authz/permissions";
import type { AuthUser } from "../auth/jwt.strategy";

const actor: AuthUser = {
  userId: 1,
  email: "cnc@servoteh",
  role: "cnc_programer",
  workerId: 55,
};

/** Aktor bez worker-a u JWT-u (stale token) — worker se dohvata svežim lookup-om. */
const staleActor: AuthUser = {
  userId: 9,
  email: "miljan@servoteh",
  role: "tehnolog",
  workerId: null,
};

/** Audit polja koja setDone piše u cnc_programs.upsert (create/update grane). */
interface UpsertAuditArg {
  create: { completedByWorkerId: number | null; completedAt: Date | null };
  update: { completedByWorkerId: number | null; completedAt: Date | null };
}

/** Argument queue upsert-a (renumeracija reda). */
interface QueueUpsertArg {
  where: { workOrderId: number };
  create: {
    workOrderId: number;
    queueOrder: number;
    queueSetByWorkerId: number | null;
  };
  update: { queueOrder: number; queueSetByWorkerId: number | null };
}

interface PrismaMock {
  operation: { findMany: jest.Mock };
  workOrder: { findMany: jest.Mock; count: jest.Mock; findUnique: jest.Mock };
  cncProgram: {
    findMany: jest.Mock;
    findUnique: jest.Mock;
    upsert: jest.Mock;
    update: jest.Mock;
  };
  worker: { findMany: jest.Mock };
  user: { findUnique: jest.Mock };
  $queryRaw: jest.Mock;
  $executeRaw: jest.Mock;
  $transaction: jest.Mock;
}

function prismaMock(): PrismaMock {
  const mock: PrismaMock = {
    operation: { findMany: jest.fn().mockResolvedValue([]) },
    workOrder: { findMany: jest.fn(), count: jest.fn(), findUnique: jest.fn() },
    cncProgram: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn(),
      upsert: jest.fn(),
      update: jest.fn(),
    },
    worker: { findMany: jest.fn().mockResolvedValue([]) },
    user: { findUnique: jest.fn() },
    // Skup RN id-jeva sa otkucanim CAM-done (CNC/kontrola) — prazan u testu.
    $queryRaw: jest.fn().mockResolvedValue([]),
    $executeRaw: jest.fn().mockResolvedValue(0),
    $transaction: jest.fn(),
  };
  // Interaktivna transakcija: callback dobija isti mock kao `tx` (in-place).
  mock.$transaction.mockImplementation((arg: unknown) =>
    Array.isArray(arg)
      ? Promise.all(arg)
      : (arg as (tx: PrismaMock) => unknown)(mock),
  );
  return mock;
}

describe("CncProgramsService", () => {
  let service: CncProgramsService;
  let prisma: PrismaMock;

  beforeEach(async () => {
    prisma = prismaMock();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CncProgramsService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    service = module.get(CncProgramsService);
  });

  describe("list", () => {
    it("vraća prazno bez CAM radnih centara (usesPriority nigde)", async () => {
      prisma.operation.findMany.mockResolvedValue([]);
      const res = await service.list({});
      expect(res.data).toEqual([]);
      // Ne sme ni da upita work_orders kad nema CAM radnih centara.
      expect(prisma.workOrder.findMany).not.toHaveBeenCalled();
    });

    it("spaja CAM status, izlaže drawingId + queueOrder", async () => {
      prisma.operation.findMany.mockResolvedValue([{ workCenterCode: "5.4" }]);
      prisma.workOrder.findMany.mockResolvedValue([
        {
          id: 1,
          identNumber: "9400/1",
          partName: "A",
          drawingNumber: "D1",
          drawingId: 111,
          productionDeadline: new Date("2026-08-01"),
        },
        {
          id: 2,
          identNumber: "9400/2",
          partName: "B",
          drawingNumber: "D2",
          drawingId: 0,
          productionDeadline: new Date("2026-07-20"),
        },
      ]);
      prisma.cncProgram.findMany.mockResolvedValue([
        {
          workOrderId: 1,
          isDone: true,
          completedByWorkerId: 55,
          completedAt: new Date(),
          note: null,
          queueOrder: null,
        },
      ]);
      prisma.worker.findMany.mockResolvedValue([
        { id: 55, fullName: "Programer", username: "prog" },
      ]);

      const all = await service.list({});
      expect(all.data).toHaveLength(2);
      const r1 = all.data.find((r) => r.id === 1);
      expect(r1?.cam.isDone).toBe(true);
      expect(r1?.cam.completedBy?.fullName).toBe("Programer");
      expect(r1?.drawingId).toBe(111);
      expect(r1?.cam.queueOrder).toBeNull();
      const r2 = all.data.find((r) => r.id === 2);
      expect(r2?.cam.isDone).toBe(false);
      expect(r2?.drawingId).toBe(0);
    });

    it("sortira rangirane pre nerangiranih, nerangirane po roku (id desc tie)", async () => {
      prisma.operation.findMany.mockResolvedValue([{ workCenterCode: "5.4" }]);
      prisma.workOrder.findMany.mockResolvedValue([
        // nerangiran, kasniji rok
        { id: 10, drawingId: 0, productionDeadline: new Date("2026-09-01") },
        // rangiran #2
        { id: 20, drawingId: 0, productionDeadline: new Date("2026-08-01") },
        // nerangiran, raniji rok
        { id: 30, drawingId: 0, productionDeadline: new Date("2026-07-01") },
        // rangiran #1
        { id: 40, drawingId: 0, productionDeadline: new Date("2026-12-01") },
        // nerangiran, bez roka → posle svih sa rokom
        { id: 50, drawingId: 0, productionDeadline: null },
      ]);
      prisma.cncProgram.findMany.mockResolvedValue([
        { workOrderId: 20, queueOrder: 2, isDone: false },
        { workOrderId: 40, queueOrder: 1, isDone: false },
      ]);

      const res = await service.list({});
      // Rangirani (40 pa 20) → pa nerangirani po roku (30, 10) → NULL rok (50).
      expect(res.data.map((r) => r.id)).toEqual([40, 20, 30, 10, 50]);
    });

    it("onlyPending filtrira PRE paginacije (otpali redovi ne prave rupu)", async () => {
      prisma.operation.findMany.mockResolvedValue([{ workCenterCode: "5.4" }]);
      // 3 pozicije; prva (rok najraniji) je DONE → sa onlyPending mora otpasti
      // PRE slice-a, pa strana od 2 vraća preostale 2, ne 1.
      prisma.workOrder.findMany.mockResolvedValue([
        { id: 1, drawingId: 0, productionDeadline: new Date("2026-07-01") },
        { id: 2, drawingId: 0, productionDeadline: new Date("2026-07-02") },
        { id: 3, drawingId: 0, productionDeadline: new Date("2026-07-03") },
      ]);
      prisma.cncProgram.findMany.mockResolvedValue([
        { workOrderId: 1, isDone: true, queueOrder: null },
      ]);

      const res = await service.list({ onlyPending: "true", pageSize: "2" });
      expect(res.data.map((r) => r.id)).toEqual([2, 3]);
      expect(res.meta.pagination.total).toBe(2);
    });

    it("dozvoljava pageSize do 500 za ovaj endpoint", async () => {
      prisma.operation.findMany.mockResolvedValue([{ workCenterCode: "5.4" }]);
      prisma.workOrder.findMany.mockResolvedValue([]);
      const res = await service.list({ pageSize: "500" });
      expect(res.meta.pagination.pageSize).toBe(500);
    });
  });

  describe("setDone", () => {
    it("upisuje audit ko/kada kad isDone=true", async () => {
      prisma.workOrder.findUnique.mockResolvedValue({ id: 7 });
      prisma.cncProgram.upsert.mockResolvedValue({});
      await service.setDone(7, { isDone: true }, actor);
      const calls = prisma.cncProgram.upsert.mock.calls as UpsertAuditArg[][];
      const arg = calls[0][0];
      expect(arg.create.completedByWorkerId).toBe(55);
      expect(arg.create.completedAt).toBeInstanceOf(Date);
      expect(arg.update.completedByWorkerId).toBe(55);
    });

    it("briše audit kad isDone=false", async () => {
      prisma.workOrder.findUnique.mockResolvedValue({ id: 7 });
      prisma.cncProgram.upsert.mockResolvedValue({});
      await service.setDone(7, { isDone: false }, actor);
      const calls = prisma.cncProgram.upsert.mock.calls as UpsertAuditArg[][];
      const arg = calls[0][0];
      expect(arg.update.completedByWorkerId).toBeNull();
      expect(arg.update.completedAt).toBeNull();
    });

    it("404 kad RN ne postoji", async () => {
      prisma.workOrder.findUnique.mockResolvedValue(null);
      await expect(
        service.setDone(999, { isDone: true }, actor),
      ).rejects.toThrow(NotFoundException);
    });

    it("422 kad isDone nije boolean", async () => {
      await expect(
        service.setDone(7, { isDone: "da" } as never, actor),
      ).rejects.toThrow(UnprocessableEntityException);
    });
  });

  describe("moveInQueue", () => {
    /** Vrati mapu workOrderId → queueOrder iz svih upsert poziva (poslednji pobeđuje). */
    function queueFromUpserts(): Map<number, number> {
      const calls = prisma.cncProgram.upsert.mock.calls as QueueUpsertArg[][];
      const m = new Map<number, number>();
      for (const [arg] of calls)
        m.set(arg.where.workOrderId, arg.update.queueOrder);
      return m;
    }

    it("na vrh (afterWorkOrderId=null) — nerangiran ulazi ispred svih", async () => {
      prisma.workOrder.findUnique.mockResolvedValue({ id: 99 });
      prisma.cncProgram.findMany.mockResolvedValue([
        { workOrderId: 20, queueOrder: 1 },
        { workOrderId: 30, queueOrder: 2 },
      ]);
      const res = await service.moveInQueue(
        99,
        { afterWorkOrderId: null },
        actor,
      );
      expect(res.data).toEqual({ workOrderId: 99, queueOrder: 1 });
      const q = queueFromUpserts();
      expect(q.get(99)).toBe(1);
      expect(q.get(20)).toBe(2);
      expect(q.get(30)).toBe(3);
    });

    it("iza rangiranog reda (afterWorkOrderId=20)", async () => {
      prisma.workOrder.findUnique.mockResolvedValue({ id: 99 });
      prisma.cncProgram.findMany.mockResolvedValue([
        { workOrderId: 20, queueOrder: 1 },
        { workOrderId: 30, queueOrder: 2 },
      ]);
      const res = await service.moveInQueue(
        99,
        { afterWorkOrderId: 20 },
        actor,
      );
      expect(res.data).toEqual({ workOrderId: 99, queueOrder: 2 });
      const q = queueFromUpserts();
      expect(q.get(20)).toBe(1);
      expect(q.get(99)).toBe(2);
      expect(q.get(30)).toBe(3);
    });

    it("premešta već rangiran red — renumeracija 1..N bez rupa", async () => {
      prisma.workOrder.findUnique.mockResolvedValue({ id: 30 });
      prisma.cncProgram.findMany.mockResolvedValue([
        { workOrderId: 10, queueOrder: 1 },
        { workOrderId: 20, queueOrder: 2 },
        { workOrderId: 30, queueOrder: 3 },
      ]);
      // Premesti 30 na vrh.
      const res = await service.moveInQueue(
        30,
        { afterWorkOrderId: null },
        actor,
      );
      expect(res.data).toEqual({ workOrderId: 30, queueOrder: 1 });
      const q = queueFromUpserts();
      expect(q.get(30)).toBe(1);
      expect(q.get(10)).toBe(2);
      expect(q.get(20)).toBe(3);
      // Bez rupa: rangovi su tačno {1,2,3}.
      expect([...q.values()].sort()).toEqual([1, 2, 3]);
    });

    it("remove skida iz rangiranja i renumeriše ostatak", async () => {
      prisma.workOrder.findUnique.mockResolvedValue({ id: 20 });
      prisma.cncProgram.findMany.mockResolvedValue([
        { workOrderId: 10, queueOrder: 1 },
        { workOrderId: 20, queueOrder: 2 },
        { workOrderId: 30, queueOrder: 3 },
      ]);
      prisma.cncProgram.findUnique.mockResolvedValue({ workOrderId: 20 });
      const res = await service.moveInQueue(20, { remove: true }, actor);
      expect(res.data).toEqual({ workOrderId: 20, queueOrder: null });
      // 20 postavljen na NULL.
      const updateCalls = prisma.cncProgram.update.mock.calls as {
        where: { workOrderId: number };
        data: { queueOrder: number | null };
      }[][];
      expect(updateCalls[0][0].where.workOrderId).toBe(20);
      expect(updateCalls[0][0].data.queueOrder).toBeNull();
      // Ostatak renumerisan 1..2.
      const q = queueFromUpserts();
      expect(q.get(10)).toBe(1);
      expect(q.get(30)).toBe(2);
      expect(q.has(20)).toBe(false);
    });

    it("422 kad afterWorkOrderId nije rangiran", async () => {
      prisma.workOrder.findUnique.mockResolvedValue({ id: 99 });
      prisma.cncProgram.findMany.mockResolvedValue([
        { workOrderId: 20, queueOrder: 1 },
      ]);
      await expect(
        service.moveInQueue(99, { afterWorkOrderId: 777 }, actor),
      ).rejects.toThrow(UnprocessableEntityException);
    });

    it("404 kad WO ne postoji", async () => {
      prisma.workOrder.findUnique.mockResolvedValue(null);
      await expect(
        service.moveInQueue(999, { afterWorkOrderId: null }, actor),
      ).rejects.toThrow(NotFoundException);
    });

    it("422 kad su i afterWorkOrderId i remove prisutni", async () => {
      prisma.workOrder.findUnique.mockResolvedValue({ id: 99 });
      await expect(
        service.moveInQueue(
          99,
          { afterWorkOrderId: null, remove: true },
          actor,
        ),
      ).rejects.toThrow(UnprocessableEntityException);
    });

    it("422 kad nema ni afterWorkOrderId ni remove", async () => {
      prisma.workOrder.findUnique.mockResolvedValue({ id: 99 });
      await expect(service.moveInQueue(99, {}, actor)).rejects.toThrow(
        UnprocessableEntityException,
      );
    });

    it("drop na samog sebe = no-op (vraća trenutni rang)", async () => {
      prisma.workOrder.findUnique.mockResolvedValue({ id: 20 });
      prisma.cncProgram.findMany.mockResolvedValue([
        { workOrderId: 10, queueOrder: 1 },
        { workOrderId: 20, queueOrder: 2 },
      ]);
      const res = await service.moveInQueue(
        20,
        { afterWorkOrderId: 20 },
        actor,
      );
      expect(res.data).toEqual({ workOrderId: 20, queueOrder: 2 });
      expect(prisma.cncProgram.upsert).not.toHaveBeenCalled();
    });

    it("audit queueSetByWorkerId iz svežeg lookup-a za stale JWT", async () => {
      prisma.workOrder.findUnique.mockResolvedValue({ id: 99 });
      prisma.cncProgram.findMany.mockResolvedValue([]);
      // JWT nema workerId → svež users.worker_id lookup vraća 13.
      prisma.user.findUnique.mockResolvedValue({ workerId: 13 });
      await service.moveInQueue(99, { afterWorkOrderId: null }, staleActor);
      const calls = prisma.cncProgram.upsert.mock.calls as QueueUpsertArg[][];
      expect(calls[0][0].create.queueSetByWorkerId).toBe(13);
      expect(prisma.user.findUnique).toHaveBeenCalledWith({
        where: { id: 9 },
        select: { workerId: true },
      });
    });
  });

  it("PERMISSIONS sadrži CAM_PRIORITET ključ", () => {
    expect(PERMISSIONS.CAM_PRIORITET).toBe("tehnologija.cam_prioritet");
  });
});
