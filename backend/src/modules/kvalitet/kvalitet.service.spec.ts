import { Test, TestingModule } from "@nestjs/testing";
import {
  BadRequestException,
  ConflictException,
  PayloadTooLargeException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { QualityService } from "./kvalitet.service";
import type { UploadedMultipartFile } from "./kvalitet.service";
import type { AuthUser } from "../auth/jwt.strategy";
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
    responsibleParty: null,
    materialCostNote: null,
    coopCostNote: null,
    spentHoursText: null,
    spentHours: null,
    materialKg: null,
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
  qualityDocument: {
    findMany: jest.Mock;
    findUnique: jest.Mock;
    create: jest.Mock;
    delete: jest.Mock;
    count: jest.Mock;
  };
  techProcess: { findUnique: jest.Mock };
  workOrder: { findUnique: jest.Mock };
  workOrderOperation: { findMany: jest.Mock };
  drawing: { findFirst: jest.Mock };
  worker: { findMany: jest.Mock };
  user: { findUnique: jest.Mock; findMany: jest.Mock };
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
    qualityDocument: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn(),
      create: jest.fn(),
      delete: jest.fn().mockResolvedValue({}),
      count: jest.fn().mockResolvedValue(0),
    },
    techProcess: { findUnique: jest.fn().mockResolvedValue(null) },
    workOrder: { findUnique: jest.fn().mockResolvedValue(null) },
    workOrderOperation: { findMany: jest.fn().mockResolvedValue([]) },
    drawing: { findFirst: jest.fn().mockResolvedValue(null) },
    worker: { findMany: jest.fn().mockResolvedValue([]) },
    user: {
      findUnique: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
    },
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

    it("škart: auto-popunjava spentHours + materialKg iz routinga/crteža", async () => {
      prisma.techProcess.findUnique.mockResolvedValue({ operationNumber: 20 });
      prisma.workOrder.findUnique.mockResolvedValue({
        drawingNumber: "9000-1",
        revision: "A",
        unprocessedPartWeight: 0,
      });
      prisma.drawing.findFirst.mockResolvedValue({ weight: 2.5 });
      prisma.workOrderOperation.findMany.mockResolvedValue([
        { operationNumber: 10, setupTime: 1, cycleTime: 0.5 },
        { operationNumber: 20, setupTime: 2, cycleTime: 0.25 },
        { operationNumber: 30, setupTime: 4, cycleTime: 1 },
      ]);
      prisma.nonconformityReport.create.mockResolvedValue(
        baseReport({ id: 7, type: 2 }),
      );

      const res = await service.createDraftFromControl({
        qualityTypeId: 2,
        quantity: 3,
        workOrderId: 100,
        sourceTechProcessId: 50,
      });

      expect(res).toEqual({ id: 7 });
      const arg = prisma.nonconformityReport.create.mock.calls[0][0] as {
        data: { spentHours: number | null; materialKg: number | null };
      };
      // Σ do op 20 (uključivo): (1 + 0.5*3) + (2 + 0.25*3) = 5.25
      expect(arg.data.spentHours).toBe(5.25);
      // 3 kom × 2.5 kg = 7.5
      expect(arg.data.materialKg).toBe(7.5);
    });

    it("škart bez mase/operacije: draft nastaje, spentHours i materialKg null", async () => {
      prisma.workOrder.findUnique.mockResolvedValue({
        drawingNumber: "NEMA",
        revision: "A",
        unprocessedPartWeight: 0,
      });
      prisma.drawing.findFirst.mockResolvedValue(null); // crtež nepoznat
      prisma.nonconformityReport.create.mockResolvedValue(
        baseReport({ id: 8, type: 2 }),
      );

      const res = await service.createDraftFromControl({
        qualityTypeId: 2,
        quantity: 5,
        workOrderId: 100,
        sourceTechProcessId: null, // nema operacije → sati se ne računaju
      });

      expect(res).toEqual({ id: 8 });
      const arg = prisma.nonconformityReport.create.mock.calls[0][0] as {
        data: { spentHours: number | null; materialKg: number | null };
      };
      expect(arg.data.spentHours).toBeNull();
      expect(arg.data.materialKg).toBeNull();
    });
  });

  describe("responsibleParty — Odgovoran (K1)", () => {
    it("createReport upisuje vrednost iz whitelist-e i mapReport je vraća", async () => {
      prisma.nonconformityReport.create.mockResolvedValue(
        baseReport({ id: 20, responsibleParty: "masina" }),
      );

      const res = await service.createReport({
        type: 2,
        quantity: 1,
        defectDescription: "Prekoračena tolerancija",
        responsibleParty: "masina",
      });

      const arg = prisma.nonconformityReport.create.mock.calls[0][0] as {
        data: { responsibleParty?: string | null };
      };
      expect(arg.data.responsibleParty).toBe("masina");
      expect(res.data.responsibleParty).toBe("masina");
    });

    it("createReport bez polja upisuje null", async () => {
      prisma.nonconformityReport.create.mockResolvedValue(
        baseReport({ id: 21 }),
      );

      const res = await service.createReport({
        type: 2,
        quantity: 1,
        defectDescription: "Bez odgovornog",
      });

      const arg = prisma.nonconformityReport.create.mock.calls[0][0] as {
        data: { responsibleParty?: string | null };
      };
      expect(arg.data.responsibleParty).toBeNull();
      expect(res.data.responsibleParty).toBeNull();
    });

    it("createReport odbija vrednost van whitelist-e (400)", async () => {
      await expect(
        service.createReport({
          type: 2,
          quantity: 1,
          defectDescription: "Loša vrednost",
          responsibleParty: "sef_smene",
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.nonconformityReport.create).not.toHaveBeenCalled();
    });

    it("updateReport upisuje vrednost; null briše, undefined ne dira polje", async () => {
      prisma.nonconformityReport.findUnique.mockResolvedValue(
        baseReport({ id: 22, responsibleParty: "masina" }),
      );
      prisma.nonconformityReport.update.mockResolvedValue(
        baseReport({ id: 22, responsibleParty: "tehnologija" }),
      );

      await service.updateReport(22, { responsibleParty: "tehnologija" });
      await service.updateReport(22, { responsibleParty: null });
      await service.updateReport(22, { quantity: 3 });

      const data = (
        prisma.nonconformityReport.update.mock.calls as {
          data: { responsibleParty?: string | null };
        }[][]
      ).map((c) => c[0].data);
      expect(data[0].responsibleParty).toBe("tehnologija");
      expect(data[1].responsibleParty).toBeNull();
      expect(data[2]).not.toHaveProperty("responsibleParty");
    });

    it("updateReport odbija vrednost van whitelist-e (400), bez upisa", async () => {
      prisma.nonconformityReport.findUnique.mockResolvedValue(
        baseReport({ id: 23 }),
      );
      await expect(
        service.updateReport(23, { responsibleParty: "IZVRSILAC" }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.nonconformityReport.update).not.toHaveBeenCalled();
    });
  });

  describe("recomputeReport (auto sati + kg)", () => {
    it("škart: prepisuje spentHours + materialKg, meta nosi izvore", async () => {
      prisma.nonconformityReport.findUnique.mockResolvedValue(
        baseReport({
          id: 10,
          type: 2,
          workOrderId: 100,
          sourceTechProcessId: 50,
          quantity: 4,
        }),
      );
      prisma.techProcess.findUnique.mockResolvedValue({ operationNumber: 20 });
      prisma.workOrder.findUnique.mockResolvedValue({
        drawingNumber: "9000-1",
        revision: "A",
        unprocessedPartWeight: 0,
      });
      prisma.drawing.findFirst.mockResolvedValue({ weight: 2 });
      prisma.workOrderOperation.findMany.mockResolvedValue([
        { operationNumber: 10, setupTime: 1, cycleTime: 0.5 },
        { operationNumber: 20, setupTime: 2, cycleTime: 0.25 },
        { operationNumber: 30, setupTime: 4, cycleTime: 1 },
      ]);
      prisma.nonconformityReport.update.mockResolvedValue(
        baseReport({ id: 10, type: 2, spentHours: "6", materialKg: "8" }),
      );

      const res = await service.recomputeReport(10);

      const arg = prisma.nonconformityReport.update.mock.calls[0][0] as {
        data: { spentHours?: number | null; materialKg?: number | null };
      };
      // Σ do op 20: (1 + 0.5*4) + (2 + 0.25*4) = 3 + 3 = 6
      expect(arg.data.spentHours).toBe(6);
      // 4 × 2 = 8
      expect(arg.data.materialKg).toBe(8);
      expect(res.meta.massSource).toBe("drawing");
      expect(res.meta.unitWeightKg).toBe(2);
      expect(res.meta.hoursOps).toBe(2); // op 10 i 20
      expect(res.meta.hoursComputed).toBe(true);
    });

    it("dorada (type=1) → 400, bez izmene", async () => {
      prisma.nonconformityReport.findUnique.mockResolvedValue(
        baseReport({ id: 11, type: 1 }),
      );
      await expect(service.recomputeReport(11)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(prisma.nonconformityReport.update).not.toHaveBeenCalled();
    });

    it("škart bez operacije: spentHours netaknut, materialKg iz fallbacka pripremka", async () => {
      prisma.nonconformityReport.findUnique.mockResolvedValue(
        baseReport({
          id: 12,
          type: 2,
          workOrderId: 100,
          sourceTechProcessId: null, // operacija se ne može odrediti
          quantity: 2,
        }),
      );
      prisma.workOrder.findUnique.mockResolvedValue({
        drawingNumber: "9000-2",
        revision: "A",
        unprocessedPartWeight: 3, // fallback masa pripremka
      });
      prisma.drawing.findFirst.mockResolvedValue(null);
      prisma.nonconformityReport.update.mockResolvedValue(
        baseReport({ id: 12, type: 2 }),
      );

      const res = await service.recomputeReport(12);

      const arg = prisma.nonconformityReport.update.mock.calls[0][0] as {
        data: { spentHours?: number | null; materialKg?: number | null };
      };
      // spentHours se NE dira (nema operacije)
      expect(arg.data.spentHours).toBeUndefined();
      // 2 × 3 = 6 iz unprocessed_part_weight
      expect(arg.data.materialKg).toBe(6);
      expect(res.meta.massSource).toBe("workOrder");
      expect(res.meta.hoursComputed).toBe(false);
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

  describe("summary (K3.1)", () => {
    it("month grupisanje agregira preko $queryRaw + draftCount u meta", async () => {
      prisma.nonconformityReport.count.mockResolvedValue(3); // draftCount
      prisma.$queryRaw.mockResolvedValue([
        { key: "2026-06", count: 2, pieces: 10, hours: 4.5 },
        { key: "2026-07", count: 1, pieces: 3, hours: 0 },
      ]);

      const res = await service.summary({ groupBy: "month" });

      expect(res.data).toEqual([
        { key: "2026-06", label: "2026-06", count: 2, pieces: 10, hours: 4.5 },
        { key: "2026-07", label: "2026-07", count: 1, pieces: 3, hours: 0 },
      ]);
      expect(res.meta.groupBy).toBe("month");
      expect(res.meta.draftCount).toBe(3);
      // draftCount se broji SAMO nad status=0.
      const countArg = prisma.nonconformityReport.count.mock
        .calls[0][0] as { where: { status: number } };
      expect(countArg.where.status).toBe(0);
    });

    it("nevalidan groupBy → 400", async () => {
      await expect(service.summary({ groupBy: "hour" })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it("meta.totals = negrupisan ukupan zbir (ne sabira grupe krivaca)", async () => {
      prisma.nonconformityReport.count.mockResolvedValue(0);
      // 1. poziv: grupisani redovi po radniku (isti izveštaj pripisan svakom
      // krivcu → 20 kom u zbiru redova). 2. poziv: negrupisan totals = 10 kom.
      prisma.$queryRaw
        .mockResolvedValueOnce([
          { worker_id: 1, count: 1, pieces: 10, hours: 5 },
          { worker_id: 2, count: 1, pieces: 10, hours: 5 },
        ])
        .mockResolvedValueOnce([{ count: 1, pieces: 10, hours: 5 }]);
      prisma.worker.findMany.mockResolvedValue([
        { id: 1, fullName: "Radnik A" },
        { id: 2, fullName: "Radnik B" },
      ]);

      const res = await service.summary({ groupBy: "worker" });

      // Redovi bi klijentski dali 20 komada; meta.totals nosi stvarnih 10.
      expect(res.meta.totals).toEqual({ count: 1, pieces: 10, hours: 5 });
    });
  });

  describe("mine (K3.2)", () => {
    it("bez worker veze → linked:false, prazne liste", async () => {
      prisma.user.findUnique.mockResolvedValue({ workerId: null });
      const actor: AuthUser = {
        userId: 1,
        email: "radnik@servoteh.com",
        role: "proizvodni_radnik",
        workerId: null,
      };

      const res = await service.mine(actor);

      expect(res.data).toEqual({ linked: false, reports: [], monthly: [] });
      expect(prisma.nonconformityWorker.findMany).not.toHaveBeenCalled();
    });
  });

  describe("uploadDocument (K4-UPLOAD)", () => {
    function upload(buffer: Buffer, name = "dok"): UploadedMultipartFile {
      return {
        originalname: name,
        mimetype: "application/octet-stream",
        size: buffer.length,
        buffer,
      };
    }

    it("odbija txt (magic bytes ne poklapaju) → 422, bez upisa", async () => {
      await expect(
        service.uploadDocument(upload(Buffer.from("obican tekst")), {}),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
      expect(prisma.qualityDocument.create).not.toHaveBeenCalled();
    });

    it("> 25 MB → 413", async () => {
      const big = Buffer.alloc(25 * 1024 * 1024 + 1);
      await expect(
        service.uploadDocument(upload(big, "veliki.pdf"), {}),
      ).rejects.toBeInstanceOf(PayloadTooLargeException);
      expect(prisma.qualityDocument.create).not.toHaveBeenCalled();
    });

    it("PDF magic → upis; content_type iz sadržaja, uploadedBy iz JWT; nevezan dozvoljen", async () => {
      prisma.qualityDocument.create.mockResolvedValue({
        id: 7,
        fileName: "nalog.pdf",
        sizeKb: 1,
      });
      const actor: AuthUser = {
        userId: 9,
        email: "kontrolor@servoteh.com",
        role: "kontrolor",
        workerId: null,
      };

      const res = await service.uploadDocument(
        upload(Buffer.from("%PDF-1.7 sadrzaj"), "nalog.pdf"),
        {},
        actor,
      );

      expect(res.data).toEqual({
        id: 7,
        fileName: "nalog.pdf",
        sizeKb: expect.any(Number),
      });
      const arg = prisma.qualityDocument.create.mock.calls[0][0] as {
        data: {
          contentType: string;
          uploadedByUserId: number | null;
          reportId: number | null;
        };
      };
      expect(arg.data.contentType).toBe("application/pdf");
      expect(arg.data.uploadedByUserId).toBe(9);
      expect(arg.data.reportId).toBeNull(); // nevezan arhivski dokument
    });
  });

  describe("listDocuments (K4-UPLOAD)", () => {
    it("lista BEZ content polja + batch-resolve uploadedBy preko users", async () => {
      prisma.qualityDocument.findMany.mockResolvedValue([
        {
          id: 1,
          fileName: "scan.pdf",
          contentType: "application/pdf",
          sizeKb: 12,
          identNumber: "9400-1/442",
          reportId: 5,
          techProcessId: null,
          workOrderId: null,
          createdAt: new Date(),
          uploadedByUserId: 9,
        },
      ]);
      prisma.qualityDocument.count.mockResolvedValue(1);
      prisma.user.findMany.mockResolvedValue([
        { id: 9, fullName: "Kontrolor K" },
      ]);

      const res = await service.listDocuments({});

      expect(res.data).toHaveLength(1);
      expect(res.data[0]).not.toHaveProperty("content");
      expect(res.data[0].uploadedBy).toEqual({ fullName: "Kontrolor K" });
      // select NE sme tražiti content (lista je bez blob-a).
      const arg = prisma.qualityDocument.findMany.mock.calls[0][0] as {
        select: Record<string, unknown>;
      };
      expect(arg.select.content).toBeUndefined();
      expect(res.meta.pagination.total).toBe(1);
    });
  });

  describe("getReport documents (K4 veza)", () => {
    it("detalj izveštaja nosi documents (bez content-a)", async () => {
      prisma.nonconformityReport.findUnique.mockResolvedValue(
        baseReport({ id: 3 }),
      );
      prisma.qualityDocument.findMany.mockResolvedValue([
        { id: 1, fileName: "scan.pdf", sizeKb: 20, createdAt: new Date() },
      ]);

      const res = await service.getReport(3);

      expect(res.data.documents).toHaveLength(1);
      expect(res.data.documents[0].fileName).toBe("scan.pdf");
    });
  });

  it("PERMISSIONS sadrži kvalitet ključeve", () => {
    expect(PERMISSIONS.KVALITET_READ).toBe("kvalitet.read");
    expect(PERMISSIONS.KVALITET_WRITE).toBe("kvalitet.write");
  });
});
