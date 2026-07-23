import { Test, TestingModule } from "@nestjs/testing";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { Sy15StorageService } from "../../common/sy15/sy15-storage.service";
import { AiProviderService } from "../../common/ai/ai-provider.service";
import { ZahteviService, STATUS_TRANSITIONS } from "./zahtevi.service";
import { ZahteviAiService } from "./zahtevi-ai.service";
import { ZahteviDecisionsService } from "./zahtevi-decisions.service";
import { ZahteviMailService } from "./zahtevi-mail.service";
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
    updateMany: jest.Mock;
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
  user: { findMany: jest.Mock; findUnique: jest.Mock };
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
      // F1 (TOCTOU): status-prelazi rade compare-and-set kroz updateMany({where:{id,status}}).
      // Default count:1 (prelaz uspeva). Test konkurentnog prelaza: mockResolvedValue({count:0}) → 409.
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
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
    // getDetail obogaćuje komentare/events imenima (users meki ref) — default prazno.
    user: {
      findMany: jest.fn().mockResolvedValue([]),
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

/**
 * Mock ZahteviAiService (F3) — ZahteviService injektuje ga, ali njegov puni AI put
 * ima svoj spec. Ovde su bitne samo grane koje ZahteviService okida:
 *  - scheduleTriage (fire-and-forget na submit; ne sme obarati submit),
 *  - retryTranscribe (delegacija transcribeAttachment).
 */
function zahteviAiMock(): jest.Mocked<
  Pick<ZahteviAiService, "scheduleTriage" | "retryTranscribe">
> {
  return {
    scheduleTriage: jest.fn(),
    retryTranscribe: jest
      .fn()
      .mockResolvedValue({ data: { id: 5, transcript: "prepis" } }),
  };
}

/** Decision Log servis — u decision-toku se zove SAMO createFromRequest (logDecision prečica). */
function decisionsMock(): jest.Mocked<
  Pick<ZahteviDecisionsService, "createFromRequest">
> {
  return { createFromRequest: jest.fn().mockResolvedValue(undefined) };
}

/** Mail servis — decision/DONE + novi-submit fire-and-forget; nikad ne baca (boolean). */
function mailMock(): jest.Mocked<
  Pick<ZahteviMailService, "notifySubmitter" | "notifyAdminsNewRequest">
> {
  return {
    notifySubmitter: jest.fn().mockResolvedValue(true),
    notifyAdminsNewRequest: jest.fn().mockResolvedValue(true),
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
  let zahteviAi: ReturnType<typeof zahteviAiMock>;
  let decisions: ReturnType<typeof decisionsMock>;
  let mail: ReturnType<typeof mailMock>;

  beforeEach(async () => {
    prisma = prismaMock();
    storage = storageMock();
    ai = aiMock();
    zahteviAi = zahteviAiMock();
    decisions = decisionsMock();
    mail = mailMock();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ZahteviService,
        RequestNumberingService,
        { provide: PrismaService, useValue: prisma },
        { provide: Sy15StorageService, useValue: storage },
        { provide: AiProviderService, useValue: ai },
        { provide: ZahteviAiService, useValue: zahteviAi },
        { provide: ZahteviDecisionsService, useValue: decisions },
        { provide: ZahteviMailService, useValue: mail },
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

    it("F7: admin createdBy validan broj → filter po createdByUserId", async () => {
      await service.list(ADMIN, { createdBy: "42" });
      const { where } = firstArg<{ where: { createdByUserId?: number } }>(
        prisma.changeRequest.findMany,
      );
      expect(where.createdByUserId).toBe(42);
    });

    it("F7: admin createdBy nevalidan (NaN/abc) → 400, ne 500 (ne stiže do baze)", async () => {
      await expect(
        service.list(ADMIN, { createdBy: "abc" }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.changeRequest.findMany).not.toHaveBeenCalled();
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
      // Fire-and-forget: trijaža + mejl administratorima o novoj ideji (§9).
      expect(zahteviAi.scheduleTriage).toHaveBeenCalledWith(10, null);
      expect(mail.notifyAdminsNewRequest).toHaveBeenCalledWith(10);
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
        // F1: status-prelaz ide kroz uslovni updateMany({where:{id,status}}).
        const arg = firstArg<{
          where: { status?: string };
          data: { decidedByUserId?: number };
        }>(prisma.changeRequest.updateMany);
        expect(arg.where.status).toBe("SUBMITTED");
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

      it("F6: merge na ARHIVIRAN kanonski cilj → 422 (nema lanaca)", async () => {
        prisma.changeRequest.findUnique
          .mockResolvedValueOnce(baseReq({ status: "SUBMITTED" })) // sam zahtev
          .mockResolvedValueOnce({
            id: 77,
            status: "ARCHIVED",
            mergedIntoId: null,
          }); // cilj
        await expect(
          service.decision(10, { action: "merge", mergeIntoId: 77 }, ADMIN),
        ).rejects.toBeInstanceOf(UnprocessableEntityException);
      });

      it("F6: merge na cilj koji je i sam SPOJEN (mergedIntoId set) → 422 (nema ciklusa)", async () => {
        prisma.changeRequest.findUnique
          .mockResolvedValueOnce(baseReq({ status: "SUBMITTED" })) // sam zahtev
          .mockResolvedValueOnce({
            id: 77,
            status: "SUBMITTED",
            mergedIntoId: 5,
          }); // cilj već spojen
        await expect(
          service.decision(10, { action: "merge", mergeIntoId: 77 }, ADMIN),
        ).rejects.toBeInstanceOf(UnprocessableEntityException);
      });

      it("F6: merge na MERGED cilj → 422", async () => {
        prisma.changeRequest.findUnique
          .mockResolvedValueOnce(baseReq({ status: "SUBMITTED" })) // sam zahtev
          .mockResolvedValueOnce({
            id: 77,
            status: "MERGED",
            mergedIntoId: null,
          }); // cilj već MERGED
        await expect(
          service.decision(10, { action: "merge", mergeIntoId: 77 }, ADMIN),
        ).rejects.toBeInstanceOf(UnprocessableEntityException);
      });

      it("F6: merge na aktivan cilj → prolazi (MERGED status, event MERGED)", async () => {
        prisma.changeRequest.findUnique
          .mockResolvedValueOnce(baseReq({ status: "SUBMITTED" })) // sam zahtev
          .mockResolvedValueOnce({
            id: 77,
            status: "APPROVED",
            mergedIntoId: null,
          }); // aktivan cilj
        const res = await service.decision(
          10,
          { action: "merge", mergeIntoId: 77 },
          ADMIN,
        );
        expect(row(res).status).toBe("MERGED");
        expect(eventTypes(prisma)).toContain("MERGED");
      });

      it("logDecision:true uz approve → prečica u Decision Log (§6)", async () => {
        prisma.changeRequest.findUnique.mockResolvedValue(
          baseReq({ status: "ANALYZED" }),
        );
        prisma.changeRequest.update.mockResolvedValue(
          baseReq({ status: "APPROVED" }),
        );
        await service.decision(
          10,
          { action: "approve", logDecision: true },
          ADMIN,
        );
        expect(decisions.createFromRequest).toHaveBeenCalledTimes(1);
        const arg = calls(
          decisions.createFromRequest as unknown as jest.Mock,
        )[0][1] as {
          action: string;
          requestId: number;
        };
        expect(arg.action).toBe("approve");
        expect(arg.requestId).toBe(10);
      });

      it("bez logDecision → NEMA prečice u Decision Log", async () => {
        prisma.changeRequest.findUnique.mockResolvedValue(
          baseReq({ status: "ANALYZED" }),
        );
        prisma.changeRequest.update.mockResolvedValue(
          baseReq({ status: "APPROVED" }),
        );
        await service.decision(10, { action: "approve" }, ADMIN);
        expect(decisions.createFromRequest).not.toHaveBeenCalled();
      });

      it("pad Decision Log prečice NE obara odluku (best-effort §6)", async () => {
        prisma.changeRequest.findUnique.mockResolvedValue(
          baseReq({ status: "ANALYZED" }),
        );
        prisma.changeRequest.update.mockResolvedValue(
          baseReq({ status: "APPROVED" }),
        );
        decisions.createFromRequest.mockRejectedValue(new Error("db"));
        const res = await service.decision(
          10,
          { action: "approve", logDecision: true },
          ADMIN,
        );
        expect(row(res).status).toBe("APPROVED");
      });

      it("mejl podnosiocu na reject (§9) — poziv sa outcome reject + note", async () => {
        prisma.changeRequest.findUnique.mockResolvedValue(
          baseReq({ status: "ANALYZED" }),
        );
        prisma.changeRequest.update.mockResolvedValue(
          baseReq({ status: "REJECTED" }),
        );
        await service.decision(
          10,
          { action: "reject", note: "nije jasno" },
          ADMIN,
        );
        expect(mail.notifySubmitter).toHaveBeenCalledWith({
          requestId: 10,
          outcome: "reject",
          note: "nije jasno",
        });
      });

      it("mejl NE ide na defer/archive/merge (samo approve/reject/needs-info)", async () => {
        prisma.changeRequest.findUnique.mockResolvedValue(
          baseReq({ status: "ANALYZED" }),
        );
        prisma.changeRequest.update.mockResolvedValue(
          baseReq({ status: "DEFERRED" }),
        );
        await service.decision(10, { action: "defer" }, ADMIN);
        expect(mail.notifySubmitter).not.toHaveBeenCalled();
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
        // F1: status-prelaz ide kroz uslovni updateMany({where:{id,status}}).
        const arg = firstArg<{
          where: { status?: string };
          data: { status?: string; branchName?: string };
        }>(prisma.changeRequest.updateMany);
        expect(arg.where.status).toBe("APPROVED");
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

      it("done iz TESTING → mejl podnosiocu outcome=done (§9)", async () => {
        prisma.changeRequest.findUnique.mockResolvedValue(
          baseReq({ status: "TESTING" }),
        );
        prisma.changeRequest.update.mockResolvedValue(
          baseReq({ status: "DONE" }),
        );
        await service.setStatus(10, { action: "done" }, ADMIN);
        expect(mail.notifySubmitter).toHaveBeenCalledWith({
          requestId: 10,
          outcome: "done",
        });
      });

      it("in-progress NE šalje mejl (samo DONE)", async () => {
        prisma.changeRequest.findUnique.mockResolvedValue(
          baseReq({ status: "APPROVED" }),
        );
        prisma.changeRequest.update.mockResolvedValue(
          baseReq({ status: "IN_PROGRESS" }),
        );
        await service.setStatus(10, { action: "in-progress" }, ADMIN);
        expect(mail.notifySubmitter).not.toHaveBeenCalled();
      });
    });

    // ── F1: TOCTOU (compare-and-set) ────────────────────────────────────────────
    describe("TOCTOU guard (F1) — konkurentni prelaz → 409, bez duplih efekata", () => {
      it("decision: red promenio status između čitanja i upisa (updateMany count 0) → 409, bez eventa/mejla", async () => {
        prisma.changeRequest.findUnique.mockResolvedValue(
          baseReq({ status: "ANALYZED" }),
        );
        // Drugi klik: kad stigne updateMany, red više nije ANALYZED → count 0.
        prisma.changeRequest.updateMany.mockResolvedValue({ count: 0 });
        await expect(
          service.decision(10, { action: "approve" }, ADMIN),
        ).rejects.toBeInstanceOf(ConflictException);
        expect(eventTypes(prisma)).not.toContain("APPROVED");
        expect(mail.notifySubmitter).not.toHaveBeenCalled();
      });

      it("submit: dupli klik (updateMany count 0) → 409, bez SUBMITTED eventa i bez trijaže", async () => {
        prisma.changeRequest.findUnique.mockResolvedValue(
          baseReq({ status: "DRAFT" }),
        );
        prisma.changeRequest.updateMany.mockResolvedValue({ count: 0 });
        await expect(service.submit(10, USER)).rejects.toBeInstanceOf(
          ConflictException,
        );
        expect(eventTypes(prisma)).not.toContain("SUBMITTED");
        expect(zahteviAi.scheduleTriage).not.toHaveBeenCalled();
      });

      it("setStatus: konkurentni prelaz (updateMany count 0) → 409, bez eventa i mejla", async () => {
        prisma.changeRequest.findUnique.mockResolvedValue(
          baseReq({ status: "TESTING" }),
        );
        prisma.changeRequest.updateMany.mockResolvedValue({ count: 0 });
        await expect(
          service.setStatus(10, { action: "done" }, ADMIN),
        ).rejects.toBeInstanceOf(ConflictException);
        expect(eventTypes(prisma)).not.toContain("STATUS_CHANGED");
        expect(mail.notifySubmitter).not.toHaveBeenCalled();
      });

      it("withdraw: konkurentno arhiviranje (updateMany count 0) → 409, bez WITHDRAWN eventa", async () => {
        prisma.changeRequest.findUnique.mockResolvedValue(
          baseReq({ status: "SUBMITTED" }),
        );
        prisma.changeRequest.updateMany.mockResolvedValue({ count: 0 });
        await expect(service.withdraw(10, USER)).rejects.toBeInstanceOf(
          ConflictException,
        );
        expect(eventTypes(prisma)).not.toContain("WITHDRAWN");
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
    it("admin isQuestion → komentar isQuestion:true BEZ auto-prelaza statusa (23.07 revizija)", async () => {
      prisma.changeRequest.findUnique.mockResolvedValue(
        baseReq({ status: "SUBMITTED" }),
      );
      prisma.changeRequestComment.create.mockResolvedValue({ id: 1 });
      await service.addComment(
        10,
        { body: "pitanje?", isQuestion: true },
        ADMIN,
      );
      // Komentar je označen kao pitanje…
      const arg = firstArg<{ data: { isQuestion: boolean } }>(
        prisma.changeRequestComment.create,
      );
      expect(arg.data.isQuestion).toBe(true);
      // …ali status ostaje netaknut — NEEDS_INFO prelaz radi ISKLJUČIVO decision.
      expect(eventTypes(prisma)).not.toContain("NEEDS_INFO");
      expect(prisma.changeRequest.update).not.toHaveBeenCalled();
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
