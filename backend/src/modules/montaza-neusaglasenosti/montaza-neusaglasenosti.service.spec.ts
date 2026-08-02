import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
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
import { MontazaNmKarticaService } from "./montaza-nm-kartica.service";
import { PdmService } from "../pdm/pdm.service";
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
    partName: null,
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
  // 034/26 — kartica lookup (work_orders/projects) + razrešavanje crteža.
  workOrder: { findMany: jest.Mock };
  project: { findUnique: jest.Mock };
  drawing: { findFirst: jest.Mock };
  drawingPdf: { findFirst: jest.Mock };
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
    workOrder: { findMany: jest.fn().mockResolvedValue([]) },
    project: { findUnique: jest.fn().mockResolvedValue(null) },
    drawing: { findFirst: jest.fn().mockResolvedValue(null) },
    drawingPdf: { findFirst: jest.fn().mockResolvedValue(null) },
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
  const kartica = new MontazaNmKarticaService(
    prisma as unknown as PrismaService,
  );
  const pdm = { getPdfContent: jest.fn() };
  const service = new MontazaNeusaglasenostiService(
    prisma as unknown as PrismaService,
    new MontazaNmNumberingService(),
    notifications as unknown as NotificationsService,
    mail as unknown as MontazaNmMailService,
    kartica,
    pdm as unknown as PdmService,
  );
  return { service, notifications, mail, kartica, pdm };
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

    /**
     * 🔴 Dokaz sa montaže se gubio tiho: HEIC sa telefona → 422 bez imena fajla, a
     * prijava je već bila snimljena. Poruka sada imenuje fajl, kaže šta da se uradi,
     * i kaže GDE je posao ostao (prijava sačuvana — fotke iz njene kartice).
     */
    const heic = (name = "IMG_4021.HEIC"): UploadedPhotoFile => ({
      originalname: name,
      mimetype: "image/jpeg", // telefon/birač zna da laže etiketu
      size: 12,
      buffer: Buffer.concat([
        Buffer.from([0x00, 0x00, 0x00, 0x18]),
        Buffer.from("ftypheic", "latin1"),
      ]),
    });

    it("🔴 HEIC → 422; poruka imenuje fajl, kaže šta da se uradi i da je prijava sačuvana", async () => {
      prisma.montageNonconformity.findUnique.mockResolvedValue({
        id: 1,
        reportedByUserId: 7,
        status: "CEKA_ANALIZU",
      });
      const { service } = makeService(prisma);
      let msg = "";
      try {
        await service.addPhotos(1, [heic()], REPORTER);
      } catch (e) {
        expect(e).toBeInstanceOf(UnprocessableEntityException);
        msg = (e as Error).message;
      }
      expect(msg).toContain("IMG_4021.HEIC");
      expect(msg).toContain("HEIC");
      expect(msg).toContain("Prijava je sačuvana");
      expect(prisma.montageNonconformityPhoto.create).not.toHaveBeenCalled();
    });

    it("🔴 lažiran mimetype ne pomaže — presuđuje sadržaj, ne zaglavlje zahteva", async () => {
      prisma.montageNonconformity.findUnique.mockResolvedValue({
        id: 1,
        reportedByUserId: 7,
        status: "CEKA_ANALIZU",
      });
      const { service } = makeService(prisma);
      // Ispravan PNG etiketiran kao `application/octet-stream` PROLAZI…
      const png: UploadedPhotoFile = {
        originalname: "skica.png",
        mimetype: "application/octet-stream",
        size: 9,
        buffer: Buffer.from([
          0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00,
        ]),
      };
      const out = await service.addPhotos(1, [png], REPORTER);
      expect(out.data).toHaveLength(1);
      expect(
        firstCallData(prisma.montageNonconformityPhoto.create).contentType,
      ).toBe("image/png");
    });

    it("poruka imenuje SVE problematične fajlove (ispravka u jednom prolazu)", async () => {
      prisma.montageNonconformity.findUnique.mockResolvedValue({
        id: 1,
        reportedByUserId: 7,
        status: "CEKA_ANALIZU",
      });
      const { service } = makeService(prisma);
      let msg = "";
      try {
        await service.addPhotos(
          1,
          [jpeg(), heic("a.heic"), heic("b.heic")],
          REPORTER,
        );
      } catch (e) {
        msg = (e as Error).message;
      }
      expect(msg).toContain("a.heic");
      expect(msg).toContain("b.heic");
      expect(msg).toContain("2 od 3");
      expect(msg).toContain("ništa nije sačuvano");
    });

    it("prazna fotografija (0 bajtova) → 400 sa imenom fajla", async () => {
      prisma.montageNonconformity.findUnique.mockResolvedValue({
        id: 1,
        reportedByUserId: 7,
        status: "CEKA_ANALIZU",
      });
      const { service } = makeService(prisma);
      let msg = "";
      try {
        await service.addPhotos(
          1,
          [
            {
              originalname: "prazna.jpg",
              mimetype: "image/jpeg",
              size: 0,
              buffer: Buffer.alloc(0),
            },
          ],
          REPORTER,
        );
      } catch (e) {
        expect(e).toBeInstanceOf(BadRequestException);
        msg = (e as Error).message;
      }
      expect(msg).toContain("prazna.jpg");
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

  // ------------------------------------------------------------ 034/26 kartica + crtež

  describe("skeniranje kartice dela (034/26)", () => {
    const WO = {
      id: 5,
      identNumber: "9400/236",
      drawingNumber: "123-45-06",
      partName: "Nosač ležaja",
      projectId: 11,
    };

    it("kratka nalepnica RNZ:0:{ident}:0:0 → RN + crtež + naziv + predmet", async () => {
      prisma.workOrder.findMany.mockResolvedValue([WO]);
      prisma.project.findUnique.mockResolvedValue({ projectNumber: "9400" });
      const { service } = makeService(prisma);

      const res = await service.lookupKartica("RNZ:0:9400/236:0:0");

      expect(res.data).toMatchObject({
        identNumber: "9400/236",
        workOrderCode: "9400/236",
        drawingNumber: "123-45-06",
        partName: "Nosač ležaja",
        projectNumber: "9400",
        matchCount: 1,
      });
      // projectId=0 sa nalepnice se NE koristi kao filter (samo ident).
      const where = (
        prisma.workOrder.findMany.mock.calls[0] as [{ where: object }]
      )[0].where;
      expect(where).toEqual({ identNumber: "9400/236" });
    });

    it("pun oblik sa RN papira filtrira i po predmetu", async () => {
      prisma.workOrder.findMany.mockResolvedValue([WO]);
      prisma.project.findUnique.mockResolvedValue({ projectNumber: "9400" });
      const { service } = makeService(prisma);

      await service.lookupKartica("RNZ:11:9400/236:0:A");

      const where = (
        prisma.workOrder.findMany.mock.calls[0] as [{ where: object }]
      )[0].where;
      expect(where).toEqual({ identNumber: "9400/236", projectId: 11 });
    });

    it("SR raspored tastature se toleriše (postojeći parseBarcode)", async () => {
      prisma.workOrder.findMany.mockResolvedValue([WO]);
      prisma.project.findUnique.mockResolvedValue({ projectNumber: "9400" });
      const { service } = makeService(prisma);

      // „RNYČ…" = skener na US, OS na SR latinici (incident pogona 2026-07-17).
      const res = await service.lookupKartica("RNYČ0Č9400/236Č0Č0");
      expect(res.data.identNumber).toBe("9400/236");
    });

    it("ident u više predmeta → popunjava se samo ono u čemu su svi saglasni", async () => {
      prisma.workOrder.findMany.mockResolvedValue([
        WO,
        { ...WO, id: 6, projectId: 12, drawingNumber: "999-99-99" },
      ]);
      const { service } = makeService(prisma);

      const res = await service.lookupKartica("RNZ:0:9400/236:0:0");

      expect(res.data.matchCount).toBe(2);
      expect(res.data.partName).toBe("Nosač ležaja"); // isti kod oba
      expect(res.data.drawingNumber).toBeNull(); // razlikuje se → radije prazno
      expect(res.data.projectNumber).toBeNull(); // dva predmeta → bez pogađanja
    });

    it("barkod operacije (S:…) → 422, ident bez naloga → 404, smeće → 400", async () => {
      const { service } = makeService(prisma);
      await expect(
        service.lookupKartica("S:10:BR1:0:A"),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
      prisma.workOrder.findMany.mockResolvedValue([]);
      await expect(
        service.lookupKartica("RNZ:0:NEMA:0:0"),
      ).rejects.toBeInstanceOf(NotFoundException);
      // Manje od 4 separatora (npr. skeniran barkod crteža) — poruka iz parseBarcode.
      await expect(service.lookupKartica("123-45-06")).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });

  describe("otvaranje crteža iz prijave (034/26)", () => {
    it("detalj nosi drawing={id,hasPdf} kad crtež i PDF postoje", async () => {
      prisma.montageNonconformity.findUnique.mockResolvedValue(
        baseNc({ drawingNumber: "123-45-06" }),
      );
      prisma.drawing.findFirst.mockResolvedValue({
        id: 77,
        drawingNumber: "123-45-06",
        revision: "B",
      });
      prisma.drawingPdf.findFirst.mockResolvedValue({
        drawingNumber: "123-45-06",
      });
      const { service } = makeService(prisma);

      const res = await service.getOne(1);
      expect(res.data.drawing).toEqual({ id: 77, revision: "B", hasPdf: true });
    });

    it("bez broja crteža → drawing=null (dugme ostaje ugašeno)", async () => {
      prisma.montageNonconformity.findUnique.mockResolvedValue(baseNc());
      const { service } = makeService(prisma);

      const res = await service.getOne(1);
      expect(res.data.drawing).toBeNull();
      expect(prisma.drawing.findFirst).not.toHaveBeenCalled();
    });

    it("PDF ruta traži crtež iz TE prijave; bez broja crteža → 404", async () => {
      prisma.montageNonconformity.findUnique.mockResolvedValue(
        baseNc({ drawingNumber: null }),
      );
      const { service, pdm } = makeService(prisma);

      await expect(service.getDrawingPdf(1)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(pdm.getPdfContent).not.toHaveBeenCalled();
    });

    it("PDF ruta streamuje razrešeni crtež kroz PdmService", async () => {
      prisma.montageNonconformity.findUnique.mockResolvedValue(
        baseNc({ drawingNumber: "123-45-06" }),
      );
      prisma.drawing.findFirst.mockResolvedValue({
        id: 77,
        drawingNumber: "123-45-06",
        revision: "B",
      });
      prisma.drawingPdf.findFirst.mockResolvedValue({
        drawingNumber: "123-45-06",
      });
      const { service, pdm } = makeService(prisma);
      pdm.getPdfContent.mockResolvedValue({
        buffer: Buffer.from("%PDF-"),
        fileName: "123-45-06-B.pdf",
      });

      const out = await service.getDrawingPdf(1);
      expect(pdm.getPdfContent).toHaveBeenCalledWith(77);
      expect(out.fileName).toBe("123-45-06-B.pdf");
    });
  });

  describe("naziv dela (034/26)", () => {
    it("create upisuje partName (klipovan na 250)", async () => {
      prisma.montageNonconformity.create.mockResolvedValue(baseNc());
      const { service } = makeService(prisma);

      await service.create(
        {
          projectNumber: "P-123",
          description: "Deo ne ulazi",
          severity: "SREDNJA",
          locationKind: "SERVOTEH",
          partName: `  ${"N".repeat(300)}  `,
        },
        REPORTER,
      );

      const data = firstCallData(prisma.montageNonconformity.create);
      expect((data.partName as string).length).toBe(250);
    });
  });
});
