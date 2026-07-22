import { Test, TestingModule } from "@nestjs/testing";
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { Sy15StorageService } from "../../common/sy15/sy15-storage.service";
import { AiProviderService } from "../../common/ai/ai-provider.service";
import { ZahteviService, STATUS_TRANSITIONS } from "./zahtevi.service";
import { RequestNumberingService } from "./request-numbering.service";
import type { AuthUser } from "../auth/jwt.strategy";

/** Envelope tipovi za čitljive asertacije bez `any` (repo pattern: tanka test-projekcija). */
interface Row {
  id: number;
  reqNo: string;
  status: string;
  transcript?: string | null;
  [k: string]: unknown;
}
/** Izvuci `data` iz servisnog envelope-a kao tipiziran red. */
function row(res: { data: unknown }): Row {
  return res.data as Row;
}
/** Izvuci `data` kao listu tipiziranih redova. */
function rows(res: { data: unknown }): Row[] {
  return res.data as Row[];
}
interface CreateArg {
  data: { reqNo: string; [k: string]: unknown };
}
interface EventArg {
  data: { type: string; [k: string]: unknown };
}
/** Pozivi mock funkcije kao `unknown[][]` (jest ih tipira `any` — cast na unknown je bezbedan). */
function calls(mock: jest.Mock): unknown[][] {
  return mock.mock.calls as unknown[][];
}
/** Prvi argument N-tog poziva mock funkcije, tipiziran (jest inače tipira `any`). */
function firstArg<T>(mock: jest.Mock, callIndex = 0): T {
  return calls(mock)[callIndex][0] as T;
}
/** Tipovi svih upisanih event-ova (redosled poziva changeRequestEvent.create). */
function eventTypes(prisma: PrismaMock): string[] {
  return calls(prisma.changeRequestEvent.create).map(
    (c) => (c[0] as EventArg).data.type,
  );
}

const ADMIN: AuthUser = {
  userId: 1,
  email: "admin@servoteh.com",
  role: "admin",
  workerId: null,
};
const USER: AuthUser = {
  userId: 42,
  email: "u@servoteh.com",
  role: "viewer",
  workerId: null,
};
const OTHER: AuthUser = {
  userId: 99,
  email: "o@servoteh.com",
  role: "viewer",
  workerId: null,
};

/** Pun red change_requests za mockove. */
function baseReq(over: Record<string, unknown> = {}) {
  return {
    id: 10,
    reqNo: "001/26",
    title: "Naslov",
    description: "Opis",
    expectedBehavior: null,
    currentBehavior: null,
    kind: null,
    module: null,
    areas: [],
    priorityUser: null,
    priorityFinal: null,
    aiScore: null,
    aiScoreReason: null,
    finalScore: null,
    rewardAmount: null,
    rewardStatus: "NONE",
    rewardMonth: null,
    status: "DRAFT",
    createdByUserId: USER.userId,
    submittedAt: null,
    decidedAt: null,
    decidedByUserId: null,
    decisionNote: null,
    mergedIntoId: null,
    branchName: null,
    prUrl: null,
    commitSha: null,
    deliveredVersion: null,
    implementedBy: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

interface PrismaMock {
  changeRequest: {
    findMany: jest.Mock;
    findUnique: jest.Mock;
    count: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
    delete: jest.Mock;
    groupBy: jest.Mock;
  };
  changeRequestAttachment: {
    findFirst: jest.Mock;
    count: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
  };
  changeRequestComment: { create: jest.Mock };
  changeRequestEvent: { create: jest.Mock };
  $executeRaw: jest.Mock;
  $transaction: jest.Mock;
}

function prismaMock(): PrismaMock {
  const mock: PrismaMock = {
    changeRequest: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue(null),
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn().mockResolvedValue({}),
      groupBy: jest.fn().mockResolvedValue([]),
    },
    changeRequestAttachment: {
      findFirst: jest.fn().mockResolvedValue(null),
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
    },
    changeRequestComment: { create: jest.fn() },
    changeRequestEvent: { create: jest.fn().mockResolvedValue({}) },
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

function storageMock(): jest.Mocked<
  Pick<Sy15StorageService, "upload" | "signUrl" | "remove">
> {
  return {
    upload: jest.fn().mockResolvedValue(undefined),
    signUrl: jest
      .fn()
      .mockResolvedValue({ url: "https://x/y", expiresIn: 3600 }),
    remove: jest.fn().mockResolvedValue(undefined),
  };
}

function aiMock(): jest.Mocked<Pick<AiProviderService, "transcribe">> {
  return {
    transcribe: jest
      .fn()
      .mockResolvedValue({ text: "prepis", model: "gpt-4o-transcribe" }),
  };
}

function fakeFile(
  over: Partial<Express.Multer.File> = {},
): Express.Multer.File {
  const size = over.size ?? 1000;
  const buffer = over.buffer ?? Buffer.alloc(size, 1);
  return {
    fieldname: "files",
    originalname: "slika.png",
    encoding: "7bit",
    mimetype: "image/png",
    stream: undefined as unknown as Express.Multer.File["stream"],
    destination: "",
    filename: "",
    path: "",
    ...over,
    // size i buffer moraju biti dosledni: veličina iz `over.size`, buffer pun te dužine.
    size,
    buffer,
  };
}

describe("ZahteviService", () => {
  let service: ZahteviService;
  let prisma: PrismaMock;
  let storage: ReturnType<typeof storageMock>;
  let ai: ReturnType<typeof aiMock>;

  beforeEach(async () => {
    prisma = prismaMock();
    storage = storageMock();
    ai = aiMock();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ZahteviService,
        RequestNumberingService,
        { provide: PrismaService, useValue: prisma },
        { provide: Sy15StorageService, useValue: storage },
        { provide: AiProviderService, useValue: ai },
      ],
    }).compile();
    service = module.get(ZahteviService);
  });

  // ── NUMERACIJA ──────────────────────────────────────────────────────────────
  describe("numeracija (NNN/YY, advisory lock)", () => {
    it("prvi zahtev godine → 001/YY (uzima advisory lock)", async () => {
      const yy = String(new Date().getFullYear()).slice(-2);
      prisma.changeRequest.findMany.mockResolvedValue([]);
      prisma.changeRequest.create.mockImplementation((a: unknown) =>
        Promise.resolve(
          baseReq({ reqNo: (a as CreateArg).data.reqNo, status: "DRAFT" }),
        ),
      );
      const res = await service.create({ title: "T", description: "D" }, USER);
      expect(prisma.$executeRaw).toHaveBeenCalled(); // pg_advisory_xact_lock
      expect(row(res).reqNo).toBe(`001/${yy}`);
    });

    it("MAX numerički (099 → 100, ne string sort)", async () => {
      const yy = String(new Date().getFullYear()).slice(-2);
      prisma.changeRequest.findMany.mockResolvedValue([
        { reqNo: `099/${yy}` },
        { reqNo: `100/${yy}` },
        { reqNo: `007/${yy}` },
      ]);
      prisma.changeRequest.create.mockImplementation((a: unknown) =>
        Promise.resolve(baseReq({ reqNo: (a as CreateArg).data.reqNo })),
      );
      const res = await service.create({ title: "T", description: "D" }, USER);
      expect(row(res).reqNo).toBe(`101/${yy}`);
    });
  });

  // ── VALIDACIJA CREATE ─────────────────────────────────────────────────────
  describe("create validacija", () => {
    it("prazan naslov/opis → 400", async () => {
      await expect(
        service.create({ title: "", description: "" }, USER),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
    it("nevalidan kind → 400", async () => {
      await expect(
        service.create({ title: "T", description: "D", kind: "NENOŠTO" }, USER),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // ── ROW-SCOPE ────────────────────────────────────────────────────────────────
  describe("row-scope (ne-admin vidi SAMO svoje)", () => {
    it("tuđ zahtev → 404 za ne-admina (ne otkriva postojanje)", async () => {
      prisma.changeRequest.findUnique.mockResolvedValue(
        baseReq({ createdByUserId: OTHER.userId }),
      );
      await expect(service.getDetail(10, USER)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
    it("admin čita tuđ zahtev", async () => {
      prisma.changeRequest.findUnique.mockResolvedValue(
        baseReq({ createdByUserId: OTHER.userId }),
      );
      await expect(service.getDetail(10, ADMIN)).resolves.toBeDefined();
    });
    it("lista ne-admina filtrira po createdByUserId", async () => {
      await service.list(USER, {});
      const { where } = firstArg<{ where: { createdByUserId?: number } }>(
        prisma.changeRequest.findMany,
      );
      expect(where.createdByUserId).toBe(USER.userId);
    });
    it("lista admina NEMA createdByUserId filter (osim createdBy)", async () => {
      await service.list(ADMIN, {});
      const { where } = firstArg<{ where: { createdByUserId?: number } }>(
        prisma.changeRequest.findMany,
      );
      expect(where.createdByUserId).toBeUndefined();
    });
    it("signed URL tuđeg priloga → 404 za ne-admina", async () => {
      prisma.changeRequest.findUnique.mockResolvedValue(
        baseReq({ createdByUserId: OTHER.userId }),
      );
      await expect(
        service.getAttachmentUrl(10, 5, USER),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(storage.signUrl).not.toHaveBeenCalled();
    });
  });

  // ── STATUS MAŠINA ────────────────────────────────────────────────────────────
  describe("status mašina (§1.3)", () => {
    it("submit: DRAFT → SUBMITTED (event SUBMITTED)", async () => {
      prisma.changeRequest.findUnique.mockResolvedValue(
        baseReq({ status: "DRAFT" }),
      );
      prisma.changeRequest.update.mockResolvedValue(
        baseReq({ status: "SUBMITTED" }),
      );
      const res = await service.submit(10, USER);
      expect(row(res).status).toBe("SUBMITTED");
      expect(eventTypes(prisma)).toContain("SUBMITTED");
    });

    it("submit iz NEEDS_INFO → SUBMITTED (event RESUBMITTED)", async () => {
      prisma.changeRequest.findUnique.mockResolvedValue(
        baseReq({ status: "NEEDS_INFO", submittedAt: new Date() }),
      );
      prisma.changeRequest.update.mockResolvedValue(
        baseReq({ status: "SUBMITTED" }),
      );
      await service.submit(10, USER);
      expect(eventTypes(prisma)).toContain("RESUBMITTED");
    });

    it("submit iz APPROVED → 422 (nedozvoljen status)", async () => {
      prisma.changeRequest.findUnique.mockResolvedValue(
        baseReq({ status: "APPROVED" }),
      );
      await expect(service.submit(10, USER)).rejects.toBeInstanceOf(
        UnprocessableEntityException,
      );
    });

    it("mašina dozvoljava REJECTED → SUBMITTED (restore koji F3 auto-reject / F4 /restore koriste)", () => {
      // Restore endpoint je F4, ali sama status MAŠINA već mora dozvoljavati ovaj prelaz.
      expect(STATUS_TRANSITIONS.REJECTED).toContain("SUBMITTED");
      expect(STATUS_TRANSITIONS.ANALYSIS_APPROVED).toContain("ANALYZED"); // AI završi (F3)
      expect(STATUS_TRANSITIONS.DRAFT).toEqual(["SUBMITTED"]);
      expect(STATUS_TRANSITIONS.ARCHIVED).toEqual([]); // terminalan
    });

    describe("admin decision", () => {
      it("approve iz SUBMITTED → APPROVED (preskače analizu)", async () => {
        prisma.changeRequest.findUnique.mockResolvedValue(
          baseReq({ status: "SUBMITTED" }),
        );
        prisma.changeRequest.update.mockResolvedValue(
          baseReq({ status: "APPROVED" }),
        );
        const res = await service.decision(10, { action: "approve" }, ADMIN);
        expect(row(res).status).toBe("APPROVED");
        const arg = firstArg<{ data: { decidedByUserId?: number } }>(
          prisma.changeRequest.update,
        );
        expect(arg.data.decidedByUserId).toBe(ADMIN.userId);
      });

      it("approve iz DRAFT → 422 (nedozvoljen prelaz)", async () => {
        prisma.changeRequest.findUnique.mockResolvedValue(
          baseReq({ status: "DRAFT" }),
        );
        await expect(
          service.decision(10, { action: "approve" }, ADMIN),
        ).rejects.toBeInstanceOf(UnprocessableEntityException);
      });

      it("merge bez mergeIntoId → 400", async () => {
        await expect(
          service.decision(10, { action: "merge" }, ADMIN),
        ).rejects.toBeInstanceOf(BadRequestException);
      });

      it("merge na nepostojeći kanonski zahtev → 404", async () => {
        prisma.changeRequest.findUnique
          .mockResolvedValueOnce(baseReq({ status: "SUBMITTED" })) // sam zahtev
          .mockResolvedValueOnce(null); // meta target
        await expect(
          service.decision(10, { action: "merge", mergeIntoId: 77 }, ADMIN),
        ).rejects.toBeInstanceOf(NotFoundException);
      });
    });

    describe("realizacioni status", () => {
      it("in-progress iz APPROVED → IN_PROGRESS + link polja", async () => {
        prisma.changeRequest.findUnique.mockResolvedValue(
          baseReq({ status: "APPROVED" }),
        );
        prisma.changeRequest.update.mockResolvedValue(
          baseReq({ status: "IN_PROGRESS" }),
        );
        await service.setStatus(
          10,
          { action: "in-progress", branchName: "feat/x" },
          ADMIN,
        );
        const arg = firstArg<{
          data: { status?: string; branchName?: string };
        }>(prisma.changeRequest.update);
        expect(arg.data.status).toBe("IN_PROGRESS");
        expect(arg.data.branchName).toBe("feat/x");
      });
      it("done iz DRAFT → 422", async () => {
        prisma.changeRequest.findUnique.mockResolvedValue(
          baseReq({ status: "DRAFT" }),
        );
        await expect(
          service.setStatus(10, { action: "done" }, ADMIN),
        ).rejects.toBeInstanceOf(UnprocessableEntityException);
      });
    });
  });

  // ── WITHDRAW ────────────────────────────────────────────────────────────────
  describe("withdraw", () => {
    it("owner povlači SUBMITTED → ARCHIVED (event WITHDRAWN)", async () => {
      prisma.changeRequest.findUnique.mockResolvedValue(
        baseReq({ status: "SUBMITTED" }),
      );
      prisma.changeRequest.update.mockResolvedValue(
        baseReq({ status: "ARCHIVED" }),
      );
      const res = await service.withdraw(10, USER);
      expect(row(res).status).toBe("ARCHIVED");
      expect(eventTypes(prisma)).toContain("WITHDRAWN");
    });
    it("withdraw iz APPROVED → 422 (posle odobrenja samo admin path)", async () => {
      prisma.changeRequest.findUnique.mockResolvedValue(
        baseReq({ status: "APPROVED" }),
      );
      await expect(service.withdraw(10, USER)).rejects.toBeInstanceOf(
        UnprocessableEntityException,
      );
    });
  });

  // ── IMMUTABILITY POSLE SUBMIT-A ───────────────────────────────────────────────
  describe("nepromenjivost originala (§1.3 / §10.3)", () => {
    it("owner PATCH sadržaja u SUBMITTED → 422", async () => {
      prisma.changeRequest.findUnique.mockResolvedValue(
        baseReq({ status: "SUBMITTED" }),
      );
      await expect(
        service.update(10, { description: "nov opis" }, USER),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
    });
    it("owner PATCH sadržaja u DRAFT prolazi", async () => {
      prisma.changeRequest.findUnique.mockResolvedValue(
        baseReq({ status: "DRAFT" }),
      );
      prisma.changeRequest.update.mockResolvedValue(
        baseReq({ description: "nov opis" }),
      );
      await expect(
        service.update(10, { description: "nov opis" }, USER),
      ).resolves.toBeDefined();
    });
    it("ne-admin ne sme priorityFinal → 403", async () => {
      prisma.changeRequest.findUnique.mockResolvedValue(
        baseReq({ status: "DRAFT" }),
      );
      await expect(
        service.update(10, { priorityFinal: "HIGH" }, USER),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
    it("admin meta izmena posle submit-a → event META_CHANGED", async () => {
      prisma.changeRequest.findUnique.mockResolvedValue(
        baseReq({ status: "SUBMITTED", module: null }),
      );
      prisma.changeRequest.update.mockResolvedValue(
        baseReq({ status: "SUBMITTED", module: "nabavka" }),
      );
      await service.update(10, { module: "nabavka" }, ADMIN);
      expect(eventTypes(prisma)).toContain("META_CHANGED");
    });
  });

  // ── DELETE ────────────────────────────────────────────────────────────────
  describe("delete (hard, samo owner + DRAFT)", () => {
    it("owner briše DRAFT", async () => {
      prisma.changeRequest.findUnique.mockResolvedValue(
        baseReq({ status: "DRAFT" }),
      );
      await expect(service.remove(10, USER)).resolves.toEqual({
        data: { id: 10, deleted: true },
      });
    });
    it("brisanje SUBMITTED → 422", async () => {
      prisma.changeRequest.findUnique.mockResolvedValue(
        baseReq({ status: "SUBMITTED" }),
      );
      await expect(service.remove(10, USER)).rejects.toBeInstanceOf(
        UnprocessableEntityException,
      );
    });
  });

  // ── PRILOZI ────────────────────────────────────────────────────────────────
  describe("prilozi (§5)", () => {
    beforeEach(() => {
      prisma.changeRequest.findUnique.mockResolvedValue(
        baseReq({ status: "DRAFT" }),
      );
      prisma.changeRequestAttachment.create.mockImplementation((a: unknown) =>
        Promise.resolve({ id: 1, ...(a as CreateArg).data }),
      );
    });

    it("upload slike → upload u bucket zahtevi-prilozi, putanja req/<id>/<uuid>.png", async () => {
      const res = await service.addAttachments(10, [fakeFile()], USER);
      expect(storage.upload).toHaveBeenCalledTimes(1);
      const [bucket, path] = storage.upload.mock.calls[0];
      expect(bucket).toBe("zahtevi-prilozi");
      expect(path).toMatch(/^req\/10\/[0-9a-f-]+\.png$/);
      expect(rows(res).length).toBe(1);
    });

    it("AUDIO → auto STT upisan transcript (best-effort)", async () => {
      const res = await service.addAttachments(
        10,
        [fakeFile({ mimetype: "audio/webm", originalname: "d.webm" })],
        USER,
      );
      expect(ai.transcribe).toHaveBeenCalled();
      expect(rows(res)[0].transcript).toBe("prepis");
    });

    it("STT pad NE obara upload (transcript null)", async () => {
      ai.transcribe.mockRejectedValue(new Error("upstream"));
      const res = await service.addAttachments(
        10,
        [fakeFile({ mimetype: "audio/webm", originalname: "d.webm" })],
        USER,
      );
      expect(rows(res)[0].transcript).toBeNull();
    });

    it("nepodržan mime → 422", async () => {
      await expect(
        service.addAttachments(
          10,
          [fakeFile({ mimetype: "application/x-msdownload" })],
          USER,
        ),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
    });

    it("audio > 15MB → 422", async () => {
      await expect(
        service.addAttachments(
          10,
          [fakeFile({ mimetype: "audio/webm", size: 16 * 1024 * 1024 })],
          USER,
        ),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
    });

    it("prazan/premali fajl → 400", async () => {
      await expect(
        service.addAttachments(10, [fakeFile({ size: 50 })], USER),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("prekoračenje 10 priloga → 422", async () => {
      prisma.changeRequestAttachment.count.mockResolvedValue(10);
      await expect(
        service.addAttachments(10, [fakeFile()], USER),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
    });

    it("upload na tuđ zahtev → 404 (row-scope)", async () => {
      prisma.changeRequest.findUnique.mockResolvedValue(
        baseReq({ createdByUserId: OTHER.userId }),
      );
      await expect(
        service.addAttachments(10, [fakeFile()], USER),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it("upload posle submit-a (owner, SUBMITTED) je dozvoljen", async () => {
      prisma.changeRequest.findUnique.mockResolvedValue(
        baseReq({ status: "SUBMITTED" }),
      );
      await expect(
        service.addAttachments(10, [fakeFile()], USER),
      ).resolves.toBeDefined();
    });

    it("upload u APPROVED (owner) → 422 (van editable statusa)", async () => {
      prisma.changeRequest.findUnique.mockResolvedValue(
        baseReq({ status: "APPROVED" }),
      );
      await expect(
        service.addAttachments(10, [fakeFile()], USER),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
    });

    it("soft-delete priloga → deletedAt + best-effort remove", async () => {
      prisma.changeRequestAttachment.findFirst.mockResolvedValue({
        id: 5,
        requestId: 10,
        bucket: "zahtevi-prilozi",
        storagePath: "req/10/x.png",
        deletedAt: null,
      });
      const res = await service.removeAttachment(10, 5, USER);
      const anyDate: unknown = expect.any(Date);
      expect(prisma.changeRequestAttachment.update).toHaveBeenCalledWith({
        where: { id: 5 },
        data: { deletedAt: anyDate },
      });
      expect(storage.remove).toHaveBeenCalledWith(
        "zahtevi-prilozi",
        "req/10/x.png",
      );
      expect(res.data).toEqual({ id: 5, deleted: true });
    });
  });

  // ── KOMENTARI ────────────────────────────────────────────────────────────
  describe("komentari", () => {
    it("prazan komentar → 400", async () => {
      prisma.changeRequest.findUnique.mockResolvedValue(baseReq());
      await expect(
        service.addComment(10, { body: "  " }, USER),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
    it("admin isQuestion na SUBMITTED → NEEDS_INFO", async () => {
      prisma.changeRequest.findUnique.mockResolvedValue(
        baseReq({ status: "SUBMITTED" }),
      );
      prisma.changeRequestComment.create.mockResolvedValue({ id: 1 });
      prisma.changeRequest.update.mockResolvedValue(
        baseReq({ status: "NEEDS_INFO" }),
      );
      await service.addComment(
        10,
        { body: "pitanje?", isQuestion: true },
        ADMIN,
      );
      expect(eventTypes(prisma)).toContain("NEEDS_INFO");
    });
    it("ne-admin isQuestion se ignoriše (obican komentar)", async () => {
      prisma.changeRequest.findUnique.mockResolvedValue(
        baseReq({ status: "SUBMITTED" }),
      );
      prisma.changeRequestComment.create.mockResolvedValue({ id: 1 });
      await service.addComment(10, { body: "ok", isQuestion: true }, USER);
      const arg = firstArg<{ data: { isQuestion: boolean } }>(
        prisma.changeRequestComment.create,
      );
      expect(arg.data.isQuestion).toBe(false);
    });
  });

  // ── SLICNI ────────────────────────────────────────────────────────────────
  describe("slicni (bez AI)", () => {
    it("kratak upit (<3) → prazno bez upita bazi", async () => {
      const res = await service.slicni("ab");
      expect(res.data).toEqual([]);
      expect(prisma.changeRequest.findMany).not.toHaveBeenCalled();
    });
    it("ILIKE nad title+description, isključuje ARCHIVED", async () => {
      prisma.changeRequest.findMany.mockResolvedValue([{ id: 1 }]);
      await service.slicni("izvod");
      const { where } = firstArg<{
        where: {
          status: { notIn: string[] };
          OR: Array<{ title: { mode: string } }>;
        };
      }>(prisma.changeRequest.findMany);
      expect(where.status.notIn).toContain("ARCHIVED");
      expect(where.OR[0].title.mode).toBe("insensitive");
    });
  });

  // ── INBOX META ────────────────────────────────────────────────────────────
  describe("inbox-meta", () => {
    it("broji SUBMITTED/ANALYZED/TESTING", async () => {
      prisma.changeRequest.groupBy.mockResolvedValue([
        { status: "SUBMITTED", _count: { _all: 3 } },
        { status: "TESTING", _count: { _all: 1 } },
      ]);
      const res = await service.inboxMeta();
      expect(res.data.byStatus.SUBMITTED).toBe(3);
      expect(res.data.byStatus.ANALYZED).toBe(0);
      expect(res.data.total).toBe(4);
    });
  });
});
