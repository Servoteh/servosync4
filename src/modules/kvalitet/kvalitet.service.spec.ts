import { Test, TestingModule } from "@nestjs/testing";
import {
  ConflictException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { QualityService } from "./kvalitet.service";
import { PERMISSIONS } from "../../common/authz/permissions";

/** Pun red `nonconformity_reports` za mockove (mapReport čita sva polja). */
function baseReport(over: Record<string, unknown> = {}) {
  return {
    id: 1,
    type: 2,
    reportNumber: null,
    reportYear: 2026,
    reportDate: new Date("2026-07-15T00:00:00Z"),
    status: 0,
    workOrderId: null,
    identNumber: null,
    sourceTechProcessId: null,
    drawingNumber: null,
    partName: null,
    customerName: null,
    quantity: 1,
    defectDescription: "",
    cause: null,
    workUnit: null,
    culpritText: null,
    materialCostNote: null,
    coopCostNote: null,
    spentHoursText: null,
    spentHours: null,
    note: null,
    preventiveMeasures: null,
    extra: null,
    raisedByWorkerId: null,
    createdByUserId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

interface PrismaMock {
  nonconformityReport: {
    findMany: jest.Mock;
    count: jest.Mock;
    findUnique: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
    delete: jest.Mock;
    groupBy: jest.Mock;
  };
  nonconformityWorker: {
    findMany: jest.Mock;
    createMany: jest.Mock;
    deleteMany: jest.Mock;
  };
  worker: { findMany: jest.Mock };
  $queryRaw: jest.Mock;
  $executeRaw: jest.Mock;
  $transaction: jest.Mock;
}

/** Argument prosleđen `nonconformityReport.update` (grana dodele broja). */
interface UpdateArg {
  where: { id: number };
  data: { reportNumber?: string; status?: number };
}

function prismaMock(): PrismaMock {
  const mock: PrismaMock = {
    nonconformityReport: {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn().mockResolvedValue({}),
      groupBy: jest.fn().mockResolvedValue([]),
    },
    nonconformityWorker: {
      findMany: jest.fn().mockResolvedValue([]),
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    worker: { findMany: jest.fn().mockResolvedValue([]) },
    $queryRaw: jest.fn().mockResolvedValue([{ next: 1 }]),
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

describe("QualityService", () => {
  let service: QualityService;
  let prisma: PrismaMock;

  beforeEach(async () => {
    prisma = prismaMock();
    const module: TestingModule = await Test.createTestingModule({
      providers: [QualityService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = module.get(QualityService);
  });

  describe("confirmReport", () => {
    it("dodeljuje 028/26 kad MAX postoji 027/26 (tip škart, 2026)", async () => {
      prisma.nonconformityReport.findUnique.mockResolvedValue({
        id: 5,
        type: 2,
        status: 0,
        reportYear: 2026,
      });
      prisma.$queryRaw.mockResolvedValue([{ next: 28 }]);
      prisma.nonconformityReport.update.mockResolvedValue(
        baseReport({ id: 5, type: 2, status: 1, reportNumber: "028/26" }),
      );

      const res = await service.confirmReport(5);

      const arg = prisma.nonconformityReport.update.mock
        .calls[0][0] as UpdateArg;
      expect(arg.where).toEqual({ id: 5 });
      expect(arg.data.reportNumber).toBe("028/26");
      expect(arg.data.status).toBe(1);
      expect(res.data.reportNumber).toBe("028/26");
      // Advisory lock po (tip, godina) mora biti uzet pre dodele broja.
      expect(prisma.$executeRaw).toHaveBeenCalled();
    });

    it("prvi izveštaj u godini → 001/YY", async () => {
      prisma.nonconformityReport.findUnique.mockResolvedValue({
        id: 9,
        type: 1,
        status: 0,
        reportYear: 2026,
      });
      prisma.$queryRaw.mockResolvedValue([{ next: 1 }]);
      prisma.nonconformityReport.update.mockResolvedValue(
        baseReport({ id: 9, type: 1, status: 1, reportNumber: "001/26" }),
      );

      await service.confirmReport(9);

      const arg = prisma.nonconformityReport.update.mock
        .calls[0][0] as UpdateArg;
      expect(arg.data.reportNumber).toBe("001/26");
    });

    it("već potvrđen → 409, bez ponovne dodele broja", async () => {
      prisma.nonconformityReport.findUnique.mockResolvedValue({
        id: 3,
        type: 2,
        status: 1,
        reportYear: 2026,
      });
      await expect(service.confirmReport(3)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(prisma.nonconformityReport.update).not.toHaveBeenCalled();
    });
  });

  describe("deleteReport", () => {
    it("draft se briše (status=0)", async () => {
      prisma.nonconformityReport.findUnique.mockResolvedValue({
        id: 5,
        status: 0,
      });
      const res = await service.deleteReport(5);
      expect(res.data).toEqual({ id: 5, deleted: true });
      expect(prisma.nonconformityReport.delete).toHaveBeenCalledWith({
        where: { id: 5 },
      });
    });

    it("potvrđen se NE briše → 422", async () => {
      prisma.nonconformityReport.findUnique.mockResolvedValue({
        id: 6,
        status: 1,
      });
      await expect(service.deleteReport(6)).rejects.toBeInstanceOf(
        UnprocessableEntityException,
      );
      expect(prisma.nonconformityReport.delete).not.toHaveBeenCalled();
    });
  });

  describe("createDraftFromControl", () => {
    it("guta pad (create baci → null, ne propagira)", async () => {
      prisma.nonconformityReport.create.mockRejectedValue(new Error("boom"));
      await expect(
        service.createDraftFromControl({ qualityTypeId: 2, quantity: 3 }),
      ).resolves.toBeNull();
    });

    it("dobar kvalitet (0) → null, bez upisa", async () => {
      const res = await service.createDraftFromControl({
        qualityTypeId: 0,
        quantity: 5,
      });
      expect(res).toBeNull();
      expect(prisma.nonconformityReport.create).not.toHaveBeenCalled();
    });

    it("dorada/škart → kreira draft + M:N izvršioce", async () => {
      prisma.nonconformityReport.create.mockResolvedValue(
        baseReport({ id: 42, type: 1, status: 0 }),
      );
      const res = await service.createDraftFromControl({
        qualityTypeId: 1,
        quantity: 4,
        culpritWorkerIds: [77, 88],
      });
      expect(res).toEqual({ id: 42 });
      expect(prisma.nonconformityWorker.createMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: [
            { reportId: 42, workerId: 77 },
            { reportId: 42, workerId: 88 },
          ],
        }),
      );
    });
  });

  describe("listReports", () => {
    it("batch-resolve izvršilaca (M:N) i kontrolora", async () => {
      prisma.nonconformityReport.findMany.mockResolvedValue([
        baseReport({ id: 1, raisedByWorkerId: 55, reportNumber: "027/26", status: 1 }),
      ]);
      prisma.nonconformityReport.count.mockResolvedValue(1);
      prisma.nonconformityWorker.findMany.mockResolvedValue([
        { reportId: 1, workerId: 77 },
        { reportId: 1, workerId: 88 },
      ]);
      prisma.worker.findMany.mockResolvedValue([
        { id: 55, fullName: "Kontrolor K", username: "kk" },
        { id: 77, fullName: "Radnik A", username: "ra" },
        { id: 88, fullName: "Radnik B", username: "rb" },
      ]);

      const res = await service.listReports({});
      expect(res.data).toHaveLength(1);
      expect(res.data[0].raisedByWorker?.fullName).toBe("Kontrolor K");
      const names = res.data[0].culpritWorkers
        .map((c) => c.fullName)
        .sort();
      expect(names).toEqual(["Radnik A", "Radnik B"]);
      expect(res.meta.pagination.total).toBe(1);
    });
  });

  it("PERMISSIONS sadrži kvalitet ključeve", () => {
    expect(PERMISSIONS.KVALITET_READ).toBe("kvalitet.read");
    expect(PERMISSIONS.KVALITET_WRITE).toBe("kvalitet.write");
  });
});
