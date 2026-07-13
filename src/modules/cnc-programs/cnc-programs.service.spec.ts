import { Test, TestingModule } from "@nestjs/testing";
import {
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { CncProgramsService } from "./cnc-programs.service";
import type { AuthUser } from "../auth/jwt.strategy";

const actor: AuthUser = {
  userId: 1,
  email: "cnc@servoteh",
  role: "cnc_programer",
  workerId: 55,
};

/** Audit polja koja setDone piše u cnc_programs.upsert (create/update grane). */
interface UpsertAuditArg {
  create: { completedByWorkerId: number | null; completedAt: Date | null };
  update: { completedByWorkerId: number | null; completedAt: Date | null };
}

function prismaMock() {
  return {
    operation: { findMany: jest.fn().mockResolvedValue([]) },
    workOrder: { findMany: jest.fn(), count: jest.fn(), findUnique: jest.fn() },
    cncProgram: {
      findMany: jest.fn().mockResolvedValue([]),
      upsert: jest.fn(),
    },
    worker: { findMany: jest.fn().mockResolvedValue([]) },
    // Skup RN id-jeva sa otkucanim CAM-done (CNC/kontrola) — prazan u testu.
    $queryRaw: jest.fn().mockResolvedValue([]),
    $transaction: jest.fn((arg: unknown) =>
      Array.isArray(arg) ? Promise.all(arg) : (arg as () => unknown)(),
    ),
  };
}

describe("CncProgramsService", () => {
  let service: CncProgramsService;
  let prisma: ReturnType<typeof prismaMock>;

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

    it("spaja CAM status i onlyPending filtrira nečekirane", async () => {
      prisma.operation.findMany.mockResolvedValue([{ workCenterCode: "5.4" }]);
      prisma.workOrder.findMany.mockResolvedValue([
        { id: 1, identNumber: "9400/1", partName: "A", drawingNumber: "D1" },
        { id: 2, identNumber: "9400/2", partName: "B", drawingNumber: "D2" },
      ]);
      prisma.workOrder.count.mockResolvedValue(2);
      prisma.cncProgram.findMany.mockResolvedValue([
        {
          workOrderId: 1,
          isDone: true,
          completedByWorkerId: 55,
          completedAt: new Date(),
          note: null,
        },
      ]);
      prisma.worker.findMany.mockResolvedValue([
        { id: 55, fullName: "Programer", username: "prog" },
      ]);

      const all = await service.list({});
      expect(all.data).toHaveLength(2);
      expect(all.data.find((r) => r.id === 1)?.cam.isDone).toBe(true);
      expect(all.data.find((r) => r.id === 1)?.cam.completedBy?.fullName).toBe(
        "Programer",
      );
      expect(all.data.find((r) => r.id === 2)?.cam.isDone).toBe(false);

      const pending = await service.list({ onlyPending: "true" });
      expect(pending.data.map((r) => r.id)).toEqual([2]);
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
});
