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
import { AiLimitsService } from "../../common/ai/ai-limits.service";
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
  changeRequestComment: { create: jest.Mock; findFirst: jest.Mock };
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
    changeRequestComment: {
      // returnForInfo čita `id` upisanog pitanja (029/26 → questionCommentIds), pa red
      // mora biti realan i u default mock-u; findFirst služi RBAC-u priloga uz komentar.
      create: jest.fn().mockResolvedValue({ id: 1 }),
      findFirst: jest.fn().mockResolvedValue(null),
    },
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

/** Zaglavlja formata koje prilog sme da nosi (ostali mime-ovi → sirovi bajtovi). */
const MAGIC_BY_MIME: Record<string, number[]> = {
  "image/png": [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  "image/jpeg": [0xff, 0xd8, 0xff],
  "application/pdf": [...Buffer.from("%PDF-", "latin1")],
};

/** Buffer tačne dužine `size` sa magic bytes formata na početku. */
function magicBuffer(mimetype: string, size: number): Buffer {
  const magic = MAGIC_BY_MIME[mimetype.split(";")[0].toLowerCase()];
  if (!magic) return Buffer.alloc(size, 1);
  return Buffer.concat([
    Buffer.from(magic),
    Buffer.alloc(Math.max(0, size - magic.length), 1),
  ]);
}

/** HEIC sa telefona: ISO-BMFF `ftyp` + brend `heic` (nikad se ne prima). */
function heicBuffer(size = 1000): Buffer {
  return Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00, 0x18]),
    Buffer.from("ftypheic", "latin1"),
    Buffer.alloc(Math.max(0, size - 12), 1),
  ]);
}

function fakeFile(
  over: Partial<Express.Multer.File> = {},
): Express.Multer.File {
  const size = over.size ?? 1000;
  // Prilog se presuđuje po MAGIC BYTES (`common/attachments`), ne po `mimetype`-u —
  // pa fixture mora da nosi stvarno zaglavlje formata koji glumi.
  const buffer = over.buffer ?? magicBuffer(over.mimetype ?? "image/png", size);
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
        // Talas AI-0: diktiranje u Zahtevima troši isti dnevni STT budžet.
        // Ovde je uvek „ispod limita" — poseban spec pokriva 429.
        {
          provide: AiLimitsService,
          useValue: { assertStt: jest.fn().mockResolvedValue(undefined) },
        },
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

  // ── TIHI REŽIM NAGRADA (24.07) ───────────────────────────────────────────────
  describe("tihi režim nagrada (24.07 — ne-admin ne vidi ocene/iznose)", () => {
    /** Zahtev sa popunjenim reward poljima (za proveru stripovanja). */
    const rewarded = (over: Record<string, unknown> = {}) =>
      baseReq({
        status: "DONE",
        aiScore: 4,
        aiScoreReason: "dobra ideja",
        finalScore: 3,
        rewardAmount: "1500",
        rewardStatus: "CONFIRMED",
        rewardMonth: "2026-08",
        ...over,
      });

    it("getDetail: ne-admin (podnosilac) → ocene/iznosi uklonjeni (rewardStatus→NONE, aiScoreReason skriven)", async () => {
      prisma.changeRequest.findUnique.mockResolvedValue(rewarded());
      const d = row(await service.getDetail(10, USER));
      expect(d.aiScore).toBeNull();
      expect(d.finalScore).toBeNull();
      expect(d.rewardAmount).toBeNull();
      expect(d.rewardMonth).toBeNull();
      expect(d.rewardStatus).toBe("NONE");
      // Ne-REJECTED status → obrazloženje ocene se ne prikazuje.
      expect(d.aiScoreReason).toBeNull();
    });

    it("getDetail: ne-admin + REJECTED → aiScoreReason (obrazloženje odbijanja) OSTAJE, iznosi i dalje skriveni", async () => {
      prisma.changeRequest.findUnique.mockResolvedValue(
        rewarded({ status: "REJECTED", aiScoreReason: "duplikat zahteva 003/26" }),
      );
      const d = row(await service.getDetail(10, USER));
      expect(d.aiScoreReason).toBe("duplikat zahteva 003/26");
      expect(d.finalScore).toBeNull();
      expect(d.rewardStatus).toBe("NONE");
    });

    it("getDetail: ne-admin → reward-event tipovi filtrirani; TRIAGED/AI_REJECTED ostaju ali BEZ score u data", async () => {
      const now = new Date();
      prisma.changeRequest.findUnique.mockResolvedValue(
        rewarded({
          events: [
            { id: 1, type: "SUBMITTED", actorUserId: USER.userId, data: null, createdAt: now },
            { id: 2, type: "SCORE_CONFIRMED", actorUserId: ADMIN.userId, data: { amount: "1500" }, createdAt: now },
            { id: 3, type: "REWARD_PAID", actorUserId: ADMIN.userId, data: { amount: "1500" }, createdAt: now },
            { id: 4, type: "REWARD_EXCLUDED", actorUserId: ADMIN.userId, data: null, createdAt: now },
            { id: 5, type: "TRIAGED", actorUserId: null, data: { score: 4, duplicates: [] }, createdAt: now },
            { id: 6, type: "AI_REJECTED", actorUserId: null, data: { score: 0, reason: "duplikat", duplicates: [] }, createdAt: now },
          ],
        }),
      );
      const evs = row(await service.getDetail(10, USER)).events as { type: string; data: Record<string, unknown> | null }[];
      const types = evs.map((e) => e.type);
      expect(types).toContain("SUBMITTED");
      expect(types).toContain("TRIAGED");
      expect(types).toContain("AI_REJECTED");
      expect(types).not.toContain("SCORE_CONFIRMED");
      expect(types).not.toContain("REWARD_PAID");
      expect(types).not.toContain("REWARD_EXCLUDED");
      // Score sklonjen iz data preostalih eventa; ostalo (reason/duplicates) ostaje.
      const triaged = evs.find((e) => e.type === "TRIAGED")!;
      expect(triaged.data?.score).toBeUndefined();
      const aiRej = evs.find((e) => e.type === "AI_REJECTED")!;
      expect(aiRej.data?.score).toBeUndefined();
      expect(aiRej.data?.reason).toBe("duplikat");
    });

    it("getDetail: ne-admin → analyses[].result.score/scoreReason uklonjeni (summary/duplikati ostaju)", async () => {
      prisma.changeRequest.findUnique.mockResolvedValue(
        rewarded({
          analyses: [
            {
              id: 1,
              kind: "TRIAGE",
              status: "DONE",
              result: { summary: "sažetak", score: 4, scoreReason: "dobra", duplicates: [{ requestId: 3 }] },
              createdAt: new Date(),
            },
          ],
        }),
      );
      const analyses = row(await service.getDetail(10, USER)).analyses as {
        result: Record<string, unknown>;
      }[];
      expect(analyses[0].result.score).toBeUndefined();
      expect(analyses[0].result.scoreReason).toBeUndefined();
      expect(analyses[0].result.summary).toBe("sažetak");
      expect(analyses[0].result.duplicates).toEqual([{ requestId: 3 }]);
    });

    it("getDetail: admin → analyses.result.score i event data.score ostaju", async () => {
      const now = new Date();
      prisma.changeRequest.findUnique.mockResolvedValue(
        rewarded({
          createdByUserId: OTHER.userId,
          analyses: [{ id: 1, kind: "TRIAGE", status: "DONE", result: { score: 4, summary: "x" }, createdAt: now }],
          events: [{ id: 1, type: "TRIAGED", actorUserId: null, data: { score: 4 }, createdAt: now }],
        }),
      );
      const d = row(await service.getDetail(10, ADMIN));
      expect((d.analyses as { result: { score: number } }[])[0].result.score).toBe(4);
      expect((d.events as { data: { score: number } }[])[0].data.score).toBe(4);
    });

    it("getDetail: admin → sve ocene/iznosi i reward-eventi ostaju", async () => {
      const now = new Date();
      prisma.changeRequest.findUnique.mockResolvedValue(
        rewarded({
          createdByUserId: OTHER.userId,
          events: [
            { id: 1, type: "SCORE_CONFIRMED", actorUserId: ADMIN.userId, data: null, createdAt: now },
          ],
        }),
      );
      const d = row(await service.getDetail(10, ADMIN));
      expect(d.finalScore).toBe(3);
      expect(d.rewardStatus).toBe("CONFIRMED");
      expect((d.events as { type: string }[]).map((e) => e.type)).toContain("SCORE_CONFIRMED");
    });

    it("list: ne-admin → svaki red očišćen; admin → netaknut", async () => {
      prisma.changeRequest.findMany.mockResolvedValue([rewarded()]);
      prisma.changeRequest.count.mockResolvedValue(1);
      const uRow = rows(await service.list(USER, {}))[0];
      expect(uRow.finalScore).toBeNull();
      expect(uRow.rewardStatus).toBe("NONE");

      const aRow = rows(await service.list(ADMIN, {}))[0];
      expect(aRow.finalScore).toBe(3);
      expect(aRow.rewardStatus).toBe("CONFIRMED");
    });

    // Mutacioni odgovori (create/submit/withdraw/update) takođe moraju biti očišćeni.
    describe("mutacioni odgovori se čiste za ne-admina", () => {
      it("submit → bez ocena/iznosa", async () => {
        prisma.changeRequest.findUnique.mockResolvedValue(rewarded({ status: "DRAFT" }));
        prisma.changeRequest.update.mockResolvedValue(rewarded({ status: "SUBMITTED" }));
        const d = row(await service.submit(10, USER));
        expect(d.finalScore).toBeNull();
        expect(d.rewardStatus).toBe("NONE");
      });

      it("withdraw → bez ocena/iznosa", async () => {
        prisma.changeRequest.findUnique.mockResolvedValue(rewarded({ status: "SUBMITTED" }));
        prisma.changeRequest.update.mockResolvedValue(rewarded({ status: "ARCHIVED" }));
        const d = row(await service.withdraw(10, USER));
        expect(d.finalScore).toBeNull();
        expect(d.rewardStatus).toBe("NONE");
      });

      it("update (DRAFT) → bez ocena/iznosa", async () => {
        prisma.changeRequest.findUnique.mockResolvedValue(rewarded({ status: "DRAFT" }));
        prisma.changeRequest.update.mockResolvedValue(
          rewarded({ status: "DRAFT", description: "novo" }),
        );
        const d = row(await service.update(10, { description: "novo" }, USER));
        expect(d.finalScore).toBeNull();
        expect(d.rewardStatus).toBe("NONE");
      });

      it("create (DRAFT) → bez ocena/iznosa", async () => {
        prisma.changeRequest.create.mockResolvedValue(rewarded({ status: "DRAFT" }));
        const d = row(await service.create({ title: "T", description: "D" }, USER));
        expect(d.rewardStatus).toBe("NONE");
      });

      it("admin mutacija → ocene/iznosi ostaju", async () => {
        prisma.changeRequest.findUnique.mockResolvedValue(
          rewarded({ status: "DRAFT", createdByUserId: OTHER.userId }),
        );
        prisma.changeRequest.update.mockResolvedValue(
          rewarded({ status: "DRAFT", description: "novo", createdByUserId: OTHER.userId }),
        );
        const d = row(await service.update(10, { description: "novo" }, ADMIN));
        expect(d.finalScore).toBe(3);
        expect(d.rewardStatus).toBe("CONFIRMED");
      });

      it("prazan PATCH {} (nijedno polje) → 400", async () => {
        prisma.changeRequest.findUnique.mockResolvedValue(rewarded({ status: "DRAFT" }));
        await expect(service.update(10, {}, USER)).rejects.toBeInstanceOf(
          BadRequestException,
        );
      });
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
      // Fire-and-forget: trijaža + mejl administratorima o novoj ideji (§9, prvi submit).
      expect(zahteviAi.scheduleTriage).toHaveBeenCalledWith(10, null);
      expect(mail.notifyAdminsNewRequest).toHaveBeenCalledWith(10, false);
    });

    it("submit iz NEEDS_INFO → SUBMITTED (event RESUBMITTED, čisti decisionNote)", async () => {
      prisma.changeRequest.findUnique.mockResolvedValue(
        baseReq({
          status: "NEEDS_INFO",
          submittedAt: new Date(),
          decisionNote: "Pitanja iz prethodne runde",
        }),
      );
      prisma.changeRequest.update.mockResolvedValue(
        baseReq({ status: "SUBMITTED" }),
      );
      await service.submit(10, USER);
      expect(eventTypes(prisma)).toContain("RESUBMITTED");
      // §3a: resubmit briše zastareli razlog prethodnog vraćanja (CAS data).
      const arg = firstArg<{ data: { decisionNote?: string | null } }>(
        prisma.changeRequest.updateMany,
      );
      expect(arg.data.decisionNote).toBeNull();
      // Mejl adminima ide sa isResubmit=true (Dopunjen zahtev).
      expect(mail.notifyAdminsNewRequest).toHaveBeenCalledWith(10, true);
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

    it("🔴 HEIC sa telefona → 422, poruka imenuje fajl i kaže šta da se uradi", async () => {
      let msg = "";
      try {
        await service.addAttachments(
          10,
          [fakeFile({ originalname: "IMG_9001.HEIC", buffer: heicBuffer() })],
          USER,
        );
      } catch (e) {
        expect(e).toBeInstanceOf(UnprocessableEntityException);
        msg = (e as Error).message;
      }
      expect(msg).toContain("IMG_9001.HEIC");
      expect(msg).toContain("HEIC");
      expect(storage.upload).not.toHaveBeenCalled();
    });

    it("🔴 lažiran mimetype ne pomaže — HEIC etiketiran kao image/jpeg pada", async () => {
      await expect(
        service.addAttachments(
          10,
          [
            fakeFile({
              originalname: "foto.jpg",
              mimetype: "image/jpeg",
              buffer: heicBuffer(),
            }),
          ],
          USER,
        ),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
    });

    it("🔴 jedan loš fajl u seriji → NIŠTA se ne otpremi ni upiše (validacija pre petlje)", async () => {
      await expect(
        service.addAttachments(
          10,
          [
            fakeFile({ originalname: "dobra.png" }),
            fakeFile({ originalname: "losa.heic", buffer: heicBuffer() }),
          ],
          USER,
        ),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
      expect(storage.upload).not.toHaveBeenCalled();
      expect(prisma.changeRequestAttachment.create).not.toHaveBeenCalled();
    });

    it("content_type u redu je KANONSKI (iz sadržaja), ne ono što je klijent poslao", async () => {
      // Android/Files ume da preda PNG sa praznim/generičkim tipom — sadržaj presuđuje.
      const res = await service.addAttachments(
        10,
        [
          fakeFile({
            mimetype: "application/octet-stream",
            buffer: magicBuffer("image/png", 1000),
          }),
        ],
        USER,
      );
      expect(rows(res)[0].contentType).toBe("image/png");
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

  // ── PRILOZI UZ KOMENTAR/PITANJE (zahtev 029/26) ─────────────────────────────
  describe("prilozi uz komentar (029/26)", () => {
    /** Komentar #7 na zahtevu 10, autor = USER (podnosilac). */
    function ownComment(over: Record<string, unknown> = {}) {
      return { id: 7, authorUserId: USER.userId, ...over };
    }

    beforeEach(() => {
      prisma.changeRequest.findUnique.mockResolvedValue(
        baseReq({ status: "NEEDS_INFO" }),
      );
      prisma.changeRequestComment.findFirst.mockResolvedValue(ownComment());
      prisma.changeRequestAttachment.create.mockImplementation((a: unknown) =>
        Promise.resolve({ id: 1, ...(a as CreateArg).data }),
      );
    });

    it("upload sa commentId → red nosi commentId + putanja req/<id>/comment/<commentId>/", async () => {
      const res = await service.addAttachments(10, [fakeFile()], USER, "7");
      const [, path] = storage.upload.mock.calls[0];
      expect(path).toMatch(/^req\/10\/comment\/7\/[0-9a-f-]+\.png$/);
      const arg = firstArg<{ data: { commentId: number | null } }>(
        prisma.changeRequestAttachment.create,
      );
      expect(arg.data.commentId).toBe(7);
      expect(rows(res).length).toBe(1);
    });

    it("bez commentId → prilog zahteva (commentId null, stara putanja)", async () => {
      prisma.changeRequest.findUnique.mockResolvedValue(
        baseReq({ status: "DRAFT" }),
      );
      await service.addAttachments(10, [fakeFile()], USER);
      const [, path] = storage.upload.mock.calls[0];
      expect(path).toMatch(/^req\/10\/[0-9a-f-]+\.png$/);
      const arg = firstArg<{ data: { commentId: number | null } }>(
        prisma.changeRequestAttachment.create,
      );
      expect(arg.data.commentId).toBeNull();
    });

    it("tuđ komentar (na svom zahtevu) → 403 — prepiska se ne dopisuje", async () => {
      prisma.changeRequestComment.findFirst.mockResolvedValue(
        ownComment({ authorUserId: ADMIN.userId }),
      );
      await expect(
        service.addAttachments(10, [fakeFile()], USER, "7"),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(storage.upload).not.toHaveBeenCalled();
    });

    it("ni admin ne kači fajl na tuđ komentar → 403", async () => {
      prisma.changeRequestComment.findFirst.mockResolvedValue(ownComment());
      await expect(
        service.addAttachments(10, [fakeFile()], ADMIN, "7"),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it("komentar TUĐEG zahteva → 404 (row-scope pre svega)", async () => {
      prisma.changeRequest.findUnique.mockResolvedValue(
        baseReq({ createdByUserId: OTHER.userId }),
      );
      await expect(
        service.addAttachments(10, [fakeFile()], USER, "7"),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.changeRequestComment.findFirst).not.toHaveBeenCalled();
    });

    it("komentar ne pripada ovom zahtevu → 404", async () => {
      prisma.changeRequestComment.findFirst.mockResolvedValue(null);
      await expect(
        service.addAttachments(10, [fakeFile()], USER, "7"),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it("prilog uz komentar radi i van statusnog prozora zahteva (APPROVED)", async () => {
      // Komentar se sme napisati u BILO kom statusu → i prilog uz njega. (Prilog samog
      // zahteva u APPROVED je i dalje 422 — pokriveno u bloku „prilozi (§5)".)
      prisma.changeRequest.findUnique.mockResolvedValue(
        baseReq({ status: "APPROVED" }),
      );
      await expect(
        service.addAttachments(10, [fakeFile()], USER, "7"),
      ).resolves.toBeDefined();
    });

    it("limit se broji PO KOMENTARU, ne po zahtevu", async () => {
      prisma.changeRequestAttachment.count.mockResolvedValue(10);
      await expect(
        service.addAttachments(10, [fakeFile()], USER, "7"),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
      expect(prisma.changeRequestAttachment.count).toHaveBeenCalledWith({
        where: { requestId: 10, commentId: 7, deletedAt: null },
      });
    });

    it("neispravan commentId → 400 (ne pretvara se tiho u prilog zahteva)", async () => {
      await expect(
        service.addAttachments(10, [fakeFile()], USER, "abc"),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("brisanje priloga uz komentar → 422 (nepromenjivo posle slanja), i adminu", async () => {
      prisma.changeRequestAttachment.findFirst.mockResolvedValue({
        id: 5,
        requestId: 10,
        commentId: 7,
        bucket: "zahtevi-prilozi",
        storagePath: "req/10/comment/7/x.png",
        deletedAt: null,
      });
      await expect(
        service.removeAttachment(10, 5, ADMIN),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
      expect(prisma.changeRequestAttachment.update).not.toHaveBeenCalled();
      expect(storage.remove).not.toHaveBeenCalled();
    });

    it("getDetail: prilozi zahteva su SAMO commentId=null, komentari nose svoje", async () => {
      prisma.changeRequest.findUnique.mockResolvedValue({
        ...baseReq(),
        attachments: [],
        analyses: [],
        comments: [],
        events: [],
      });
      await service.getDetail(10, USER);
      // Drugi poziv findUnique je onaj sa include-om (prvi je row-scope provera).
      const arg = calls(prisma.changeRequest.findUnique)[1][0] as {
        include: {
          attachments: { where: Record<string, unknown> };
          comments: { include: { attachments: unknown } };
        };
      };
      expect(arg.include.attachments.where).toEqual({
        deletedAt: null,
        commentId: null,
      });
      expect(arg.include.comments.include.attachments).toBeDefined();
    });

    it("returnForInfo vraća questionCommentIds (FE kači fajl na poslato pitanje)", async () => {
      prisma.changeRequest.findUnique.mockResolvedValue(
        baseReq({ status: "SUBMITTED" }),
      );
      let next = 100;
      prisma.changeRequestComment.create.mockImplementation(() =>
        Promise.resolve({ id: ++next }),
      );
      const res = await service.returnForInfo(
        10,
        { questions: ["Q1", "Q2"] },
        ADMIN,
      );
      expect((res.data as { questionCommentIds: number[] }).questionCommentIds)
        .toEqual([101, 102]);
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

  // ── RETURN-FOR-INFO (atomsko vraćanje na dopunu, 23.07 review) ───────────────
  describe("returnForInfo (atomsko: pitanja + NEEDS_INFO)", () => {
    it("SUBMITTED: N pitanja (isQuestion:true) + prelaz NEEDS_INFO + decisionNote + mejl", async () => {
      prisma.changeRequest.findUnique.mockResolvedValue(
        baseReq({ status: "SUBMITTED" }),
      );
      prisma.changeRequestComment.create.mockResolvedValue({ id: 1 });
      const res = await service.returnForInfo(
        10,
        { questions: ["Koji modul?", "  ", "Koja verzija?"], note: "hitno" },
        ADMIN,
      );
      // Dva neprazna pitanja → dva komentara isQuestion:true.
      const created = calls(prisma.changeRequestComment.create).map(
        (c) => (c[0] as { data: { isQuestion: boolean } }).data,
      );
      expect(created).toHaveLength(2);
      expect(created.every((d) => d.isQuestion === true)).toBe(true);
      // Prelaz preko CAS-a + NEEDS_INFO event + decisionNote.
      expect(prisma.changeRequest.updateMany).toHaveBeenCalledWith({
        where: { id: 10, status: "SUBMITTED" },
        data: { status: "NEEDS_INFO", decisionNote: "hitno" },
      });
      expect(eventTypes(prisma)).toContain("NEEDS_INFO");
      expect(row(res).status).toBe("NEEDS_INFO");
      // Mejl podnosiocu (needs-info) — fire-and-forget.
      expect(mail.notifySubmitter).toHaveBeenCalledWith({
        requestId: 10,
        outcome: "needs-info",
        note: "hitno",
      });
    });

    it("bez napomene → decisionNote null (bez placeholdera)", async () => {
      prisma.changeRequest.findUnique.mockResolvedValue(
        baseReq({ status: "ANALYZED" }),
      );
      prisma.changeRequestComment.create.mockResolvedValue({ id: 1 });
      await service.returnForInfo(10, { questions: ["Pitanje?"] }, ADMIN);
      const arg = firstArg<{ data: { decisionNote: string | null } }>(
        prisma.changeRequest.updateMany,
      );
      expect(arg.data.decisionNote).toBeNull();
    });

    it("prazna pitanja → 400", async () => {
      prisma.changeRequest.findUnique.mockResolvedValue(
        baseReq({ status: "SUBMITTED" }),
      );
      await expect(
        service.returnForInfo(10, { questions: ["  ", ""] }, ADMIN),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("nedozvoljen status (APPROVED) → 422, ništa se ne upiše", async () => {
      prisma.changeRequest.findUnique.mockResolvedValue(
        baseReq({ status: "APPROVED" }),
      );
      await expect(
        service.returnForInfo(10, { questions: ["Q"] }, ADMIN),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
      expect(prisma.changeRequestComment.create).not.toHaveBeenCalled();
    });

    it("ATOMIKA: CAS pad (status promenjen u pozadini) → 409 i NIJEDNO pitanje nije upisano", async () => {
      prisma.changeRequest.findUnique.mockResolvedValue(
        baseReq({ status: "SUBMITTED" }),
      );
      // Prelaz je dozvoljen (SUBMITTED→NEEDS_INFO), ali CAS ne pogađa red (count 0)
      // jer je AI auto-reject u međuvremenu prebacio status → cela tx puca pre komentara.
      prisma.changeRequest.updateMany.mockResolvedValue({ count: 0 });
      await expect(
        service.returnForInfo(10, { questions: ["Q1", "Q2"] }, ADMIN),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.changeRequestComment.create).not.toHaveBeenCalled();
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

  // ── PODNOSIOCI (048/26) ───────────────────────────────────────────────────
  describe("podnosioci", () => {
    it("vraća samo one koji imaju zahtev, sa imenom i brojem", async () => {
      prisma.changeRequest.groupBy.mockResolvedValue([
        { createdByUserId: 7, _count: { _all: 2 } },
        { createdByUserId: 3, _count: { _all: 5 } },
      ]);
      prisma.user.findMany.mockResolvedValue([
        { id: 7, fullName: "Ana Anić", email: "ana@x.rs" },
        { id: 3, fullName: null, email: "bora@x.rs" },
      ]);
      const res = await service.podnosioci();
      expect(res.data).toEqual([
        { id: 7, name: "Ana Anić", count: 2 },
        { id: 3, name: "bora@x.rs", count: 5 },
      ]);
    });

    it("bez zahteva → prazna lista i BEZ upita nad users", async () => {
      prisma.changeRequest.groupBy.mockResolvedValue([]);
      const res = await service.podnosioci();
      expect(res.data).toEqual([]);
      expect(prisma.user.findMany).not.toHaveBeenCalled();
    });
  });
});
