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
    /**
     * Materijalizovani redosled iz batch `$executeRaw` poziva (unnest):
     * values = [workerId, order[], ranks[]] — vraćamo order (prvi niz).
     */
    function materializedOrder(): number[] | null {
      const calls = prisma.$executeRaw.mock.calls as unknown[][];
      for (const call of calls) {
        const arrays = call.filter(Array.isArray) as number[][];
        // Tagged-template poziv: [strings, ...values]; strings je niz stringova,
        // pa tražimo poziv sa DVA numerička niza (order + ranks).
        const numeric = arrays.filter(
          (a) => a.length === 0 || typeof a[0] === "number",
        );
        if (numeric.length === 2) return numeric[0];
      }
      return null;
    }

    /** Audit workerId iz batch poziva (prvi ne-niz value posle strings-a). */
    function materializedWorkerId(): number | null {
      const calls = prisma.$executeRaw.mock.calls as unknown[][];
      for (const call of calls) {
        const arrays = call.filter(Array.isArray) as number[][];
        const numeric = arrays.filter(
          (a) => a.length === 0 || typeof a[0] === "number",
        );
        if (numeric.length === 2) {
          const vals = call.slice(1).filter((v) => !Array.isArray(v));
          return (vals[0] as number) ?? null;
        }
      }
      return null;
    }

    /** Kandidati CAM reda + trenutni rangovi (mock celog lanca). */
    function mockQueue(
      candidates: { id: number; deadline?: string }[],
      ranks: Record<number, number> = {},
    ) {
      prisma.operation.findMany.mockResolvedValue([{ workCenterCode: "17.0" }]);
      prisma.$queryRaw.mockResolvedValue([]); // camDoneIds prazan
      prisma.workOrder.findMany.mockResolvedValue(
        candidates.map((c) => ({
          id: c.id,
          productionDeadline: c.deadline ? new Date(c.deadline) : null,
        })),
      );
      prisma.cncProgram.findMany.mockResolvedValue(
        Object.entries(ranks).map(([id, q]) => ({
          workOrderId: Number(id),
          queueOrder: q,
        })),
      );
    }

    it("HIGH fix: SVI nerangirani — potez 'iza nerangiranog suseda' USPEVA i materijalizuje ceo red", async () => {
      // Početno stanje CAM reda: niko nije rangiran; prikaz po roku: 10, 20, 30.
      mockQueue([
        { id: 10, deadline: "2026-07-20" },
        { id: 20, deadline: "2026-07-25" },
        { id: 30, deadline: "2026-08-01" },
      ]);
      // Prevuci 30 odmah ispod 10 (meta 20 → afterWorkOrderId=10, NErangiran!).
      const res = await service.moveInQueue(
        30,
        { afterWorkOrderId: 10 },
        actor,
      );
      expect(res.data).toEqual({ workOrderId: 30, queueOrder: 2 });
      // Ceo prikazni red materijalizovan 1..3: [10, 30, 20].
      expect(materializedOrder()).toEqual([10, 30, 20]);
    });

    it("na vrh (afterWorkOrderId=null) — nerangiran ulazi ispred svih, svi dobijaju rang", async () => {
      mockQueue(
        [
          { id: 20, deadline: "2026-07-20" },
          { id: 30, deadline: "2026-07-25" },
          { id: 99, deadline: "2026-08-01" },
        ],
        { 20: 1, 30: 2 },
      );
      const res = await service.moveInQueue(
        99,
        { afterWorkOrderId: null },
        actor,
      );
      expect(res.data).toEqual({ workOrderId: 99, queueOrder: 1 });
      expect(materializedOrder()).toEqual([99, 20, 30]);
    });

    it("iza rangiranog reda u mešanom stanju (rangirani pre nerangiranih)", async () => {
      // Prikaz: 20(r1), 30(r2), 40(nerangiran).
      mockQueue(
        [
          { id: 40, deadline: "2026-07-10" },
          { id: 20, deadline: "2026-07-20" },
          { id: 30, deadline: "2026-07-25" },
        ],
        { 20: 1, 30: 2 },
      );
      const res = await service.moveInQueue(
        40,
        { afterWorkOrderId: 20 },
        actor,
      );
      expect(res.data).toEqual({ workOrderId: 40, queueOrder: 2 });
      expect(materializedOrder()).toEqual([20, 40, 30]);
    });

    it("drop na samog sebe = no-op (bez materijalizacije), vraća trenutni rang", async () => {
      mockQueue([{ id: 20 }, { id: 30 }], { 20: 1 });
      const res = await service.moveInQueue(
        20,
        { afterWorkOrderId: 20 },
        actor,
      );
      expect(res.data).toEqual({ workOrderId: 20, queueOrder: 1 });
      expect(materializedOrder()).toBeNull();
    });

    it("remove skida rang i kompaktuje PREOSTALE rangirane (nerangirani netaknuti)", async () => {
      mockQueue([{ id: 20 }, { id: 30 }, { id: 40 }, { id: 50 }], {
        20: 1,
        30: 2,
        40: 3,
      });
      const res = await service.moveInQueue(30, { remove: true }, actor);
      expect(res.data).toEqual({ workOrderId: 30, queueOrder: null });
      expect(prisma.cncProgram.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { workOrderId: 30 },
          data: expect.objectContaining({ queueOrder: null }) as unknown,
        }),
      );
      // Kompaktovani samo preostali RANGIRANI [20, 40] → 1..2 (50 ostaje nerangiran).
      expect(materializedOrder()).toEqual([20, 40]);
    });

    it("pozicija van CAM reda (završena/bez CAM operacije) → 422, RN nepostojeći → 404", async () => {
      mockQueue([{ id: 20 }]);
      // 99 nije kandidat, ali RN postoji → 422.
      prisma.workOrder.findUnique.mockResolvedValue({ id: 99 });
      await expect(
        service.moveInQueue(99, { afterWorkOrderId: null }, actor),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
      // 77 nije kandidat i RN NE postoji → 404.
      prisma.workOrder.findUnique.mockResolvedValue(null);
      await expect(
        service.moveInQueue(77, { afterWorkOrderId: null }, actor),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it("meta (afterWorkOrderId) van CAM reda → 422", async () => {
      mockQueue([{ id: 20 }, { id: 30 }]);
      await expect(
        service.moveInQueue(20, { afterWorkOrderId: 555 }, actor),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
      expect(materializedOrder()).toBeNull();
    });

    it("DTO: oba polja ili nijedno → 422 pre transakcije", async () => {
      await expect(service.moveInQueue(20, {}, actor)).rejects.toBeInstanceOf(
        UnprocessableEntityException,
      );
      await expect(
        service.moveInQueue(20, { afterWorkOrderId: 5, remove: true }, actor),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it("audit queueSetByWorkerId iz SVEŽEG lookup-a za stale JWT (workerId=null u tokenu)", async () => {
      mockQueue([{ id: 20 }, { id: 30 }]);
      prisma.user.findUnique.mockResolvedValue({ workerId: 74 });
      await service.moveInQueue(30, { afterWorkOrderId: null }, staleActor);
      expect(prisma.user.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 9 } }),
      );
      expect(materializedWorkerId()).toBe(74);
    });
  });

  it("PERMISSIONS sadrži CAM_PRIORITET ključ", () => {
    expect(PERMISSIONS.CAM_PRIORITET).toBe("tehnologija.cam_prioritet");
  });
});
