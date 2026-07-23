import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  PayloadTooLargeException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { NotificationsService } from "../notifications/notifications.service";
import {
  MontazaNeusaglasenostiService,
  NC_STATUS_TRANSITIONS,
  type UploadedPhotoFile,
} from "./montaza-neusaglasenosti.service";
import { MontazaNmNumberingService } from "./montaza-nm-numbering.service";
import { MontazaNmMailService } from "./montaza-nm-mail.service";
import { ROLES } from "../../common/authz/roles";
import type { AuthUser } from "../auth/jwt.strategy";

const YY = String(new Date().getFullYear()).slice(-2);

/** Pun red `montage_nonconformities` (mapRow čita sva polja). */
function baseNc(over: Record<string, unknown> = {}) {
  return {
    id: 1,
    reportNumber: `NM-001/${YY}`,
    projectNumber: "P-123",
    projectId: null,
    description: "Deo ne može da se ugradi",
    severity: "SREDNJA",
    locationKind: "SERVOTEH",
    locationNote: null,
    drawingNumber: null,
    workOrderCode: null,
    status: "CEKA_ANALIZU",
    reportedByUserId: 7,
    responsibleDepartment: null,
    responsibleWorkerId: null,
    investigationReport: null,
    preventiveMeasures: null,
    investigatedByUserId: null,
    closedAt: null,
    createdAt: new Date("2026-07-23T08:00:00Z"),
    updatedAt: new Date("2026-07-23T08:00:00Z"),
    ...over,
  };
}

interface PrismaMock {
  montageNonconformity: {
    findMany: jest.Mock;
    count: jest.Mock;
    findUnique: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
    updateMany: jest.Mock;
  };
  montageNonconformityPhoto: {
    findMany: jest.Mock;
    findFirst: jest.Mock;
    create: jest.Mock;
    count: jest.Mock;
  };
  montageNonconformityEvent: { findMany: jest.Mock; create: jest.Mock };
  worker: { findMany: jest.Mock };
  user: { findMany: jest.Mock; findUnique: jest.Mock };
  $executeRaw: jest.Mock;
  $transaction: jest.Mock;
}

function prismaMock(): PrismaMock {
  const mock: PrismaMock = {
    montageNonconformity: {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    montageNonconformityPhoto: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn(),
      create: jest.fn().mockResolvedValue({ id: 10, fileName: "f.jpg" }),
      count: jest.fn().mockResolvedValue(0),
    },
    montageNonconformityEvent: {
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue({}),
    },
    worker: { findMany: jest.fn().mockResolvedValue([]) },
    user: {
      // resolveManagementWorkerIds selektuje {workerId}; resolveUsers selektuje {id,fullName}.
      findMany: jest
        .fn()
        .mockImplementation((args: { select?: { workerId?: boolean } }) =>
          args?.select?.workerId
            ? Promise.resolve([{ workerId: 9 }])
            : Promise.resolve([]),
        ),
      findUnique: jest.fn().mockResolvedValue(null),
    },
    $executeRaw: jest.fn().mockResolvedValue(0),
    $transaction: jest.fn(),
  };
  mock.$transaction.mockImplementation((arg: unknown) =>
    Array.isArray(arg)
      ? Promise.all(arg)
      : (arg as (tx: PrismaMock) => unknown)(mock),
  );
  return mock;
}

const REPORTER: AuthUser = {
  userId: 7,
  role: ROLES.PROIZVODNI_RADNIK,
} as AuthUser;
const MANAGER: AuthUser = { userId: 3, role: ROLES.MENADZMENT } as AuthUser;
const OTHER: AuthUser = {
  userId: 99,
  role: ROLES.PROIZVODNI_RADNIK,
} as AuthUser;

function makeService(prisma: PrismaMock) {
  const notifications = { notifyWorkers: jest.fn().mockResolvedValue(1) };
  const mail = {
    notifyManagementNewReport: jest.fn().mockResolvedValue(true),
    notifyReporterClosed: jest.fn().mockResolvedValue(true),
  };
  const service = new MontazaNeusaglasenostiService(
    prisma as unknown as PrismaService,
    new MontazaNmNumberingService(),
    notifications as unknown as NotificationsService,
    mail as unknown as MontazaNmMailService,
  );
  return { service, notifications, mail };
}

/** `data` prvog poziva mocka (tipiziran → izbegava no-unsafe-any na jest.Mock.mock.calls). */
function firstCallData(m: jest.Mock): Record<string, unknown> {
  const calls = m.mock.calls as Array<[{ data: Record<string, unknown> }]>;
  return calls[0][0].data;
}

describe("MontazaNeusaglasenostiService", () => {
  let prisma: PrismaMock;

  beforeEach(() => {
    prisma = prismaMock();
    jest.clearAllMocks();
  });

  // ── CREATE ──────────────────────────────────────────────────────────────

  describe("create (prijava)", () => {
    it("dodeljuje broj NM-NNN/YY, upisuje CREATED event i obaveštava menadžment", async () => {
      prisma.montageNonconformity.create.mockResolvedValue(baseNc());
      const { service, notifications, mail } = makeService(prisma);

      const out = await service.create(
        {
          projectNumber: "P-123",
          description: "Deo ne može da se ugradi",
          severity: "SREDNJA",
          locationKind: "SERVOTEH",
        },
        REPORTER,
      );

      // Broj generisan (advisory lock + numerički MAX; prazna tabela → 001).
      const createData = firstCallData(prisma.montageNonconformity.create);
      expect(createData.reportNumber).toBe(`NM-001/${YY}`);
      expect(createData.status).toBe("CEKA_ANALIZU");
      expect(createData.reportedByUserId).toBe(7);
      // advisory lock pozvan sa ::int (kroz $executeRaw template).
      expect(prisma.$executeRaw).toHaveBeenCalled();
      // CREATED event.
      const createEvent = firstCallData(
        prisma.montageNonconformityEvent.create,
      );
      expect(createEvent.type).toBe("CREATED");
      expect(createEvent.actorUserId).toBe(7);
      // In-app zvonce menadžmentu (worker 9) + mail.
      expect(notifications.notifyWorkers).toHaveBeenCalledWith(
        [9],
        expect.objectContaining({
          type: "montaza.neusaglasenost.nova",
          refTable: "montage_nonconformities",
          refId: 1,
        }),
      );
      expect(mail.notifyManagementNewReport).toHaveBeenCalledWith(1);
      expect(out.data.reportNumber).toBe(`NM-001/${YY}`);
    });

    it("TEREN bez locationNote → 400", async () => {
      const { service } = makeService(prisma);
      await expect(
        service.create(
          {
            projectNumber: "P-1",
            description: "x",
            severity: "MALA",
            locationKind: "TEREN",
          },
          REPORTER,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("nepoznata ozbiljnost → 400", async () => {
      const { service } = makeService(prisma);
      await expect(
        service.create(
          {
            projectNumber: "P-1",
            description: "x",
            severity: "KATASTROFA",
            locationKind: "SERVOTEH",
          },
          REPORTER,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("prijava NE pada kad in-app obaveštenje baci (best-effort)", async () => {
      prisma.montageNonconformity.create.mockResolvedValue(baseNc());
      const { service, notifications } = makeService(prisma);
      notifications.notifyWorkers.mockRejectedValue(new Error("db down"));
      const out = await service.create(
        {
          projectNumber: "P-123",
          description: "opis",
          severity: "MALA",
          locationKind: "SERVOTEH",
        },
        REPORTER,
      );
      expect(out.data.id).toBe(1);
    });

    it("prijava NE pada kad MAIL grana baci (fire-and-forget best-effort)", async () => {
      prisma.montageNonconformity.create.mockResolvedValue(baseNc());
      const { service, mail } = makeService(prisma);
      mail.notifyManagementNewReport.mockRejectedValue(
        new Error("resend down"),
      );
      const out = await service.create(
        {
          projectNumber: "P-123",
          description: "opis",
          severity: "VISOKA",
          locationKind: "SERVOTEH",
        },
        REPORTER,
      );
      expect(out.data.id).toBe(1);
    });
  });

  // ── STATUS MAŠINA ───────────────────────────────────────────────────────

  describe("changeStatus", () => {
    it("CEKA_ANALIZU → U_TOKU dozvoljen (compare-and-set na pročitani status)", async () => {
      prisma.montageNonconformity.findUnique
        .mockResolvedValueOnce({ id: 1, status: "CEKA_ANALIZU" })
        .mockResolvedValueOnce(baseNc({ status: "U_TOKU" }));
      const { service } = makeService(prisma);
      const out = await service.changeStatus(1, { status: "U_TOKU" }, MANAGER);
      expect(out.data.status).toBe("U_TOKU");
      const casCalls = prisma.montageNonconformity.updateMany.mock
        .calls as Array<[{ where: { id: number; status: string } }]>;
      expect(casCalls[0][0].where).toEqual({ id: 1, status: "CEKA_ANALIZU" });
      expect(firstCallData(prisma.montageNonconformityEvent.create).type).toBe(
        "STATUS_CHANGED",
      );
    });

    it("U_TOKU → ZAVRSENO upisuje closedAt i šalje mail podnosiocu", async () => {
      prisma.montageNonconformity.findUnique
        .mockResolvedValueOnce({ id: 1, status: "U_TOKU" })
        .mockResolvedValueOnce(
          baseNc({ status: "ZAVRSENO", closedAt: new Date() }),
        );
      const { service, mail } = makeService(prisma);
      await service.changeStatus(1, { status: "ZAVRSENO" }, MANAGER);
      const updateData = firstCallData(prisma.montageNonconformity.updateMany);
      expect(updateData.closedAt).toBeInstanceOf(Date);
      expect(mail.notifyReporterClosed).toHaveBeenCalledWith(1);
    });

    it("CAS promašaj (status se u međuvremenu promenio) → 409, bez eventa/maila", async () => {
      prisma.montageNonconformity.findUnique.mockResolvedValue({
        id: 1,
        status: "U_TOKU",
      });
      prisma.montageNonconformity.updateMany.mockResolvedValue({ count: 0 });
      const { service, mail } = makeService(prisma);
      await expect(
        service.changeStatus(1, { status: "ZAVRSENO" }, MANAGER),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.montageNonconformityEvent.create).not.toHaveBeenCalled();
      expect(mail.notifyReporterClosed).not.toHaveBeenCalled();
    });

    it("CEKA_ANALIZU → ZAVRSENO (preskok) → 422", async () => {
      prisma.montageNonconformity.findUnique.mockResolvedValue({
        id: 1,
        status: "CEKA_ANALIZU",
      });
      const { service } = makeService(prisma);
      await expect(
        service.changeStatus(1, { status: "ZAVRSENO" }, MANAGER),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
    });

    it("ZAVRSENO je terminalan (nijedan prelaz)", () => {
      expect(NC_STATUS_TRANSITIONS.ZAVRSENO).toEqual([]);
    });

    it("isti status → 422", async () => {
      prisma.montageNonconformity.findUnique.mockResolvedValue({
        id: 1,
        status: "U_TOKU",
      });
      const { service } = makeService(prisma);
      await expect(
        service.changeStatus(1, { status: "U_TOKU" }, MANAGER),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
    });
  });

  // ── ISTRAGA ─────────────────────────────────────────────────────────────

  describe("updateInvestigation", () => {
    it("prazan PATCH → 400 (nijedno polje)", async () => {
      const { service } = makeService(prisma);
      await expect(
        service.updateInvestigation(1, {}, MANAGER),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("upisuje investigatedByUserId + INVESTIGATION_UPDATED event", async () => {
      prisma.montageNonconformity.findUnique.mockResolvedValue({ id: 1 });
      prisma.montageNonconformity.update.mockResolvedValue(
        baseNc({
          responsibleDepartment: "Zavarivanje",
          investigatedByUserId: 3,
        }),
      );
      const { service } = makeService(prisma);
      await service.updateInvestigation(
        1,
        { responsibleDepartment: "Zavarivanje" },
        MANAGER,
      );
      const updateData = firstCallData(prisma.montageNonconformity.update);
      expect(updateData.investigatedByUserId).toBe(3);
      expect(updateData.responsibleDepartment).toBe("Zavarivanje");
      expect(firstCallData(prisma.montageNonconformityEvent.create).type).toBe(
        "INVESTIGATION_UPDATED",
      );
    });
  });

  // ── FOTKE ───────────────────────────────────────────────────────────────

  describe("addPhotos", () => {
    const jpeg = (): UploadedPhotoFile => ({
      originalname: "slika.jpg",
      mimetype: "image/jpeg",
      size: 5,
      buffer: Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x11]),
    });

    it("podnosilac sme; validan JPEG kreira red + PHOTO_ADDED event", async () => {
      prisma.montageNonconformity.findUnique.mockResolvedValue({
        id: 1,
        reportedByUserId: 7,
      });
      const { service } = makeService(prisma);
      const out = await service.addPhotos(1, [jpeg()], REPORTER);
      expect(out.data).toHaveLength(1);
      expect(prisma.montageNonconformityPhoto.create).toHaveBeenCalled();
      expect(firstCallData(prisma.montageNonconformityEvent.create).type).toBe(
        "PHOTO_ADDED",
      );
    });

    it("tuđ (ne podnosilac, ne manage) → 403", async () => {
      prisma.montageNonconformity.findUnique.mockResolvedValue({
        id: 1,
        reportedByUserId: 7,
      });
      const { service } = makeService(prisma);
      await expect(
        service.addPhotos(1, [jpeg()], OTHER),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it("manage sme i na tuđu prijavu", async () => {
      prisma.montageNonconformity.findUnique.mockResolvedValue({
        id: 1,
        reportedByUserId: 7,
      });
      const { service } = makeService(prisma);
      const out = await service.addPhotos(1, [jpeg()], MANAGER);
      expect(out.data).toHaveLength(1);
    });

    it("ne-slika (magic bytes) → 422", async () => {
      prisma.montageNonconformity.findUnique.mockResolvedValue({
        id: 1,
        reportedByUserId: 7,
      });
      const { service } = makeService(prisma);
      const bogus: UploadedPhotoFile = {
        originalname: "x.txt",
        mimetype: "image/jpeg",
        size: 4,
        buffer: Buffer.from([0x00, 0x01, 0x02, 0x03]),
      };
      await expect(
        service.addPhotos(1, [bogus], REPORTER),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
    });

    it("preko 8 MB → 413", async () => {
      prisma.montageNonconformity.findUnique.mockResolvedValue({
        id: 1,
        reportedByUserId: 7,
      });
      const { service } = makeService(prisma);
      const big: UploadedPhotoFile = {
        originalname: "big.jpg",
        mimetype: "image/jpeg",
        size: 9 * 1024 * 1024,
        buffer: Buffer.concat([
          Buffer.from([0xff, 0xd8, 0xff]),
          Buffer.alloc(9 * 1024 * 1024),
        ]),
      };
      await expect(
        service.addPhotos(1, [big], REPORTER),
      ).rejects.toBeInstanceOf(PayloadTooLargeException);
    });

    it("bez fajlova → 400", async () => {
      prisma.montageNonconformity.findUnique.mockResolvedValue({
        id: 1,
        reportedByUserId: 7,
      });
      const { service } = makeService(prisma);
      await expect(service.addPhotos(1, [], REPORTER)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it("ZAVRSENA prijava → 422 (ne dopunjuje se)", async () => {
      prisma.montageNonconformity.findUnique.mockResolvedValue({
        id: 1,
        reportedByUserId: 7,
        status: "ZAVRSENO",
      });
      const { service } = makeService(prisma);
      await expect(
        service.addPhotos(1, [jpeg()], REPORTER),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
    });

    it("ukupan cap 24 po prijavi → 422", async () => {
      prisma.montageNonconformity.findUnique.mockResolvedValue({
        id: 1,
        reportedByUserId: 7,
        status: "U_TOKU",
      });
      prisma.montageNonconformityPhoto.count.mockResolvedValue(22);
      const { service } = makeService(prisma);
      await expect(
        service.addPhotos(1, [jpeg(), jpeg(), jpeg()], REPORTER),
      ).rejects.toBeInstanceOf(UnprocessableEntityException); // 22 + 3 > 24
    });

    it("atomsko: 1 nevalidan u seriji → NIŠTA se ne upiše (validacija pre transakcije)", async () => {
      prisma.montageNonconformity.findUnique.mockResolvedValue({
        id: 1,
        reportedByUserId: 7,
        status: "U_TOKU",
      });
      const bogus: UploadedPhotoFile = {
        originalname: "x.txt",
        mimetype: "image/jpeg",
        size: 4,
        buffer: Buffer.from([0x00, 0x01, 0x02, 0x03]),
      };
      const { service } = makeService(prisma);
      await expect(
        service.addPhotos(1, [jpeg(), bogus], REPORTER),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
      // Nijedna fotka ni event NISU upisani (validacija je PRE transakcije).
      expect(prisma.montageNonconformityPhoto.create).not.toHaveBeenCalled();
      expect(prisma.montageNonconformityEvent.create).not.toHaveBeenCalled();
    });
  });

  // ── NUMERACIJA ──────────────────────────────────────────────────────────

  describe("numeracija NM-NNN/YY", () => {
    it("prazna godina → 001; postojeći max → +1 (numerički, ne string)", async () => {
      const numbering = new MontazaNmNumberingService();
      const tx = {
        $executeRaw: jest.fn().mockResolvedValue(0),
        montageNonconformity: {
          findMany: jest
            .fn()
            .mockResolvedValue([
              { reportNumber: `NM-099/${YY}` },
              { reportNumber: `NM-100/${YY}` },
            ]),
        },
      };
      const next = await numbering.nextReportNumber(tx as never);
      expect(next).toBe(`NM-101/${YY}`); // 100 > 099 numerički
      expect(tx.$executeRaw).toHaveBeenCalled();
    });
  });
});
