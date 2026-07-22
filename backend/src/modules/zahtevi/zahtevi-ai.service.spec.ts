import { Test, TestingModule } from "@nestjs/testing";
import {
  ForbiddenException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { Sy15StorageService } from "../../common/sy15/sy15-storage.service";
import { AiProviderService } from "../../common/ai/ai-provider.service";
import { ZahteviAiService } from "./zahtevi-ai.service";
import type { AuthUser } from "../auth/jwt.strategy";

/**
 * F3 AI cevovod (MODULE_SPEC_zahtevi §4/§10/§12.1) — mock AiProviderService.
 * Grane: trijaža DONE (predlozi u prazna polja, ocena≥1 PROPOSED, TRIAGED event),
 * ocena 0 auto-reject (REJECTED + AI_REJECTED), NE-pregazivanje popunjenih polja,
 * duplikat lista se šalje AI-ju, trijaža FAILED (event, status ostaje),
 * not_configured (bez ključa) → FAILED not_configured, detaljna DONE/FAILED,
 * restore guard, retryTranscribe immutable.
 */

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

function baseReq(over: Record<string, unknown> = {}) {
  return {
    id: 10,
    reqNo: "001/26",
    title: "Naslov zahteva",
    description: "Opis zahteva korisnika.",
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
    status: "SUBMITTED",
    createdByUserId: USER.userId,
    submittedAt: new Date(),
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
    findUnique: jest.Mock;
    findMany: jest.Mock;
    count: jest.Mock;
    update: jest.Mock;
  };
  changeRequestAttachment: { findMany: jest.Mock; update: jest.Mock };
  changeRequestComment: { findMany: jest.Mock };
  changeRequestAiAnalysis: {
    create: jest.Mock;
    update: jest.Mock;
    findFirst: jest.Mock;
  };
  changeRequestEvent: { create: jest.Mock; findFirst: jest.Mock };
  changeRequestAttachmentUpdate?: jest.Mock;
  $transaction: jest.Mock;
}

function prismaMock(): PrismaMock {
  const mock: PrismaMock = {
    changeRequest: {
      findUnique: jest.fn().mockResolvedValue(baseReq()),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      update: jest
        .fn()
        .mockImplementation((a: { data: unknown }) =>
          Promise.resolve(baseReq(a.data as Record<string, unknown>)),
        ),
    },
    changeRequestAttachment: {
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({ id: 5, transcript: "prepis" }),
    },
    changeRequestComment: { findMany: jest.fn().mockResolvedValue([]) },
    changeRequestAiAnalysis: {
      create: jest
        .fn()
        .mockImplementation((a: { data: { kind: string } }) =>
          Promise.resolve({ id: 500, status: "PENDING", ...a.data }),
        ),
      update: jest
        .fn()
        .mockImplementation((a: { data: unknown }) =>
          Promise.resolve({ id: 500, ...(a.data as object) }),
        ),
      findFirst: jest.fn().mockResolvedValue(null),
    },
    changeRequestEvent: {
      create: jest.fn().mockResolvedValue({}),
      findFirst: jest.fn().mockResolvedValue(null),
    },
    $transaction: jest.fn(),
  };
  mock.$transaction.mockImplementation((arg: unknown) =>
    Array.isArray(arg)
      ? Promise.all(arg)
      : (arg as (tx: PrismaMock) => unknown)(mock),
  );
  return mock;
}

function storageMock() {
  return {
    download: jest.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
    signUrl: jest.fn(),
    upload: jest.fn(),
    remove: jest.fn(),
  };
}

function aiMock() {
  return {
    extractWithTool: jest.fn(),
    transcribe: jest
      .fn()
      .mockResolvedValue({ text: "prepis", model: "gpt-4o-transcribe" }),
  };
}

/** Pozivi mock funkcije kao unknown[][] (jest ih tipira any). */
function calls(mock: jest.Mock): unknown[][] {
  return mock.mock.calls as unknown[][];
}
/** Tipovi svih upisanih event-ova. */
function eventTypes(prisma: PrismaMock): string[] {
  return calls(prisma.changeRequestEvent.create).map(
    (c) => (c[0] as { data: { type: string } }).data.type,
  );
}
/** Poslednji update na change_request (data). */
function lastReqUpdate(prisma: PrismaMock): Record<string, unknown> {
  const cs = calls(prisma.changeRequest.update);
  return (cs[cs.length - 1][0] as { data: Record<string, unknown> }).data;
}
/** Poslednji update na red analize (data). */
function lastAnalysisUpdate(prisma: PrismaMock): Record<string, unknown> {
  const cs = calls(prisma.changeRequestAiAnalysis.update);
  return (cs[cs.length - 1][0] as { data: Record<string, unknown> }).data;
}

const TRIAGE_OK = {
  toolInput: {
    summary: "Kratak sažetak.",
    module: "nabavka",
    kind: "BUG",
    areas: ["BACKEND"],
    priorityProposal: "HIGH",
    duplicates: [],
    score: 3,
    scoreReason: "Validan ozbiljniji bug.",
    questions: [],
  },
  model: "claude-haiku-4-5-20251001",
  usage: { input_tokens: 120, output_tokens: 45 },
};

describe("ZahteviAiService", () => {
  let service: ZahteviAiService;
  let prisma: PrismaMock;
  let storage: ReturnType<typeof storageMock>;
  let ai: ReturnType<typeof aiMock>;

  beforeEach(async () => {
    prisma = prismaMock();
    storage = storageMock();
    ai = aiMock();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ZahteviAiService,
        { provide: PrismaService, useValue: prisma },
        { provide: Sy15StorageService, useValue: storage },
        { provide: AiProviderService, useValue: ai },
      ],
    }).compile();
    service = module.get(ZahteviAiService);
    delete process.env.ZAHTEVI_TRIAGE_MODEL;
    delete process.env.ZAHTEVI_ANALYSIS_MODEL;
  });

  // ── TRIJAŽA ──────────────────────────────────────────────────────────────
  describe("trijaža (§4.1)", () => {
    it("DONE: predlozi u PRAZNA polja, aiScore/scoreReason, PROPOSED, TRIAGED event", async () => {
      ai.extractWithTool.mockResolvedValue(TRIAGE_OK);
      // runTriage je private — retriage ga okida sinhrono kroz scheduleTriage; koristimo direktan
      // poziv privatnog metoda radi determinizma (fire-and-forget bi bio async).
      await (
        service as unknown as {
          runTriage: (id: number, u: number | null) => Promise<void>;
        }
      ).runTriage(10, null);

      const upd = lastReqUpdate(prisma);
      expect(upd.module).toBe("nabavka");
      expect(upd.kind).toBe("BUG");
      expect(upd.priorityFinal).toBe("HIGH");
      expect(upd.aiScore).toBe(3);
      expect(upd.aiScoreReason).toBe("Validan ozbiljniji bug.");
      expect(upd.rewardStatus).toBe("PROPOSED");
      expect(upd.status).toBeUndefined(); // ocena≥1 → status se NE menja

      const a = lastAnalysisUpdate(prisma);
      expect(a.status).toBe("DONE");
      expect(a.tokensIn).toBe(120);
      expect(a.tokensOut).toBe(45);
      expect(a.model).toBe("claude-haiku-4-5-20251001");
      expect(eventTypes(prisma)).toContain("TRIAGED");
      expect(eventTypes(prisma)).not.toContain("AI_REJECTED");
    });

    it("NE pregazuje popunjena polja (podnosilac izabrao module/kind/priorityFinal)", async () => {
      prisma.changeRequest.findUnique.mockResolvedValue(
        baseReq({
          module: "odrzavanje",
          kind: "FEATURE_4_0",
          priorityFinal: "LOW",
        }),
      );
      ai.extractWithTool.mockResolvedValue(TRIAGE_OK);
      await (
        service as unknown as {
          runTriage: (id: number, u: null) => Promise<void>;
        }
      ).runTriage(10, null);

      const upd = lastReqUpdate(prisma);
      expect(upd.module).toBeUndefined(); // ostaje "odrzavanje"
      expect(upd.kind).toBeUndefined(); // ostaje "FEATURE_4_0"
      expect(upd.priorityFinal).toBeUndefined(); // ostaje "LOW"
      expect(upd.aiScore).toBe(3); // ocena se UVEK upisuje
    });

    it("ocena 0 → auto REJECTED + event AI_REJECTED (sa duplicates u data)", async () => {
      ai.extractWithTool.mockResolvedValue({
        toolInput: {
          summary: "Već postoji.",
          score: 0,
          scoreReason: "Duplikat zahteva 005/26.",
          duplicates: [
            { requestId: 5, confidence: "HIGH", reason: "isti cilj" },
          ],
        },
        model: "claude-haiku-4-5-20251001",
        usage: { input_tokens: 80, output_tokens: 20 },
      });
      await (
        service as unknown as {
          runTriage: (id: number, u: null) => Promise<void>;
        }
      ).runTriage(10, null);

      const upd = lastReqUpdate(prisma);
      expect(upd.status).toBe("REJECTED");
      expect(upd.aiScore).toBe(0);
      expect(upd.rewardStatus).toBe("NONE");
      expect(eventTypes(prisma)).toContain("AI_REJECTED");

      const aiRejectCall = calls(prisma.changeRequestEvent.create).find(
        (c) => (c[0] as { data: { type: string } }).data.type === "AI_REJECTED",
      ) as [{ data: { data: { duplicates: unknown[] } } }];
      expect(aiRejectCall[0].data.data.duplicates).toHaveLength(1);
    });

    it("ocena 0 ali status nije SUBMITTED → NE menja status (guard)", async () => {
      prisma.changeRequest.findUnique.mockResolvedValue(
        baseReq({ status: "APPROVED" }),
      );
      ai.extractWithTool.mockResolvedValue({
        toolInput: { summary: "x", score: 0, scoreReason: "r", duplicates: [] },
        model: "m",
        usage: {},
      });
      await (
        service as unknown as {
          runTriage: (id: number, u: null) => Promise<void>;
        }
      ).runTriage(10, null);
      const upd = lastReqUpdate(prisma);
      expect(upd.status).toBeUndefined();
      expect(eventTypes(prisma)).not.toContain("AI_REJECTED");
    });

    it("šalje AI-ju KOMPLETNU listu postojećih zahteva (kandidati za duplikate)", async () => {
      prisma.changeRequest.count.mockResolvedValue(2);
      prisma.changeRequest.findMany.mockResolvedValue([
        {
          id: 7,
          reqNo: "007/26",
          title: "Slično",
          status: "SUBMITTED",
          description: "neki opis",
        },
      ]);
      ai.extractWithTool.mockResolvedValue(TRIAGE_OK);
      await (
        service as unknown as {
          runTriage: (id: number, u: null) => Promise<void>;
        }
      ).runTriage(10, null);

      const firstCall = calls(ai.extractWithTool)[0][0] as {
        content: { text?: string }[];
      };
      const text = firstCall.content[0].text ?? "";
      expect(text).toContain("POSTOJEĆI ZAHTEVI");
      expect(text).toContain("007/26");
    });

    it("FAILED: event TRIAGE_FAILED, red analize FAILED + errorCode, status ostaje", async () => {
      ai.extractWithTool.mockRejectedValue(new Error("upstream_error"));
      await (
        service as unknown as {
          runTriage: (id: number, u: null) => Promise<void>;
        }
      ).runTriage(10, null);
      const a = lastAnalysisUpdate(prisma);
      expect(a.status).toBe("FAILED");
      expect(a.errorCode).toBe("upstream_error");
      expect(eventTypes(prisma)).toContain("TRIAGE_FAILED");
    });

    it("bez ključa (ServiceUnavailable) → FAILED not_configured, modul radi", async () => {
      ai.extractWithTool.mockRejectedValue(
        new ServiceUnavailableException("ANTHROPIC_API_KEY nije postavljen."),
      );
      await (
        service as unknown as {
          runTriage: (id: number, u: null) => Promise<void>;
        }
      ).runTriage(10, null);
      const a = lastAnalysisUpdate(prisma);
      expect(a.status).toBe("FAILED");
      expect(a.errorCode).toBe("not_configured");
    });

    it("scheduleTriage ne baca (fire-and-forget) i upiše PENDING red", async () => {
      ai.extractWithTool.mockResolvedValue(TRIAGE_OK);
      expect(() => service.scheduleTriage(10, null)).not.toThrow();
      // dozvoli mikro-taskovima da završe
      await new Promise((r) => setTimeout(r, 5));
      expect(prisma.changeRequestAiAnalysis.create).toHaveBeenCalled();
    });

    it("retriage: samo admin", async () => {
      await expect(service.retriage(10, USER)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });
  });

  // ── DETALJNA ANALIZA ──────────────────────────────────────────────────────
  describe("detaljna analiza (§4.2)", () => {
    const ANALYSIS_OK = {
      toolInput: {
        understanding: "Korisnik traži X.",
        affectedModules: ["nabavka"],
        impact: "Srednji.",
        risks: ["r1"],
        conflicts: [],
        openQuestions: ["p1"],
        acceptanceCriteria: ["AC1"],
        testScenarios: ["T1"],
        estimate: "M",
        priorityProposal: "MEDIUM",
        claudePackage: "# Zahtev Z-001/26\n...",
      },
      model: "claude-sonnet-5",
      usage: { input_tokens: 900, output_tokens: 700 },
    };

    it("approve-analysis: SUBMITTED→ANALYSIS_APPROVED + event (samo admin)", async () => {
      prisma.changeRequest.findUnique.mockResolvedValue(
        baseReq({ status: "SUBMITTED" }),
      );
      ai.extractWithTool.mockResolvedValue(ANALYSIS_OK);
      const res = await service.approveAnalysis(10, ADMIN);
      expect((res.data as { status: string }).status).toBe("ANALYSIS_APPROVED");
      expect(eventTypes(prisma)).toContain("ANALYSIS_APPROVED");
    });

    it("approve-analysis: ne-admin → 403", async () => {
      await expect(service.approveAnalysis(10, USER)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it("approve-analysis: pogrešan status → 422", async () => {
      prisma.changeRequest.findUnique.mockResolvedValue(
        baseReq({ status: "ANALYZED" }),
      );
      await expect(service.approveAnalysis(10, ADMIN)).rejects.toBeInstanceOf(
        UnprocessableEntityException,
      );
    });

    it("runAnalysis DONE: status ANALYZED, claudePackage upisan, event ANALYZED", async () => {
      prisma.changeRequest.findUnique.mockResolvedValue(
        baseReq({ status: "ANALYSIS_APPROVED" }),
      );
      ai.extractWithTool.mockResolvedValue(ANALYSIS_OK);
      await (
        service as unknown as {
          runAnalysis: (id: number, u: number) => Promise<void>;
        }
      ).runAnalysis(10, ADMIN.userId);

      const reqUpd = calls(prisma.changeRequest.update).map(
        (c) => (c[0] as { data: Record<string, unknown> }).data,
      );
      expect(reqUpd.some((d) => d.status === "ANALYZED")).toBe(true);
      const a = lastAnalysisUpdate(prisma);
      expect(a.status).toBe("DONE");
      expect(a.claudePackage).toContain("# Zahtev Z-001/26");
      expect(a.tokensIn).toBe(900);
      expect(eventTypes(prisma)).toContain("ANALYZED");
    });

    it("runAnalysis FAILED: red FAILED, status vraćen na SUBMITTED, event ANALYSIS_FAILED", async () => {
      prisma.changeRequest.findUnique.mockResolvedValue(
        baseReq({ status: "ANALYSIS_APPROVED" }),
      );
      ai.extractWithTool.mockRejectedValue(new Error("upstream_unreachable"));
      await (
        service as unknown as {
          runAnalysis: (id: number, u: number) => Promise<void>;
        }
      ).runAnalysis(10, ADMIN.userId);

      const a = lastAnalysisUpdate(prisma);
      expect(a.status).toBe("FAILED");
      expect(a.errorCode).toBe("upstream_unreachable");
      const reqUpd = calls(prisma.changeRequest.update).map(
        (c) => (c[0] as { data: Record<string, unknown> }).data,
      );
      expect(reqUpd.some((d) => d.status === "SUBMITTED")).toBe(true);
      expect(eventTypes(prisma)).toContain("ANALYSIS_FAILED");
    });
  });

  // ── PATCH claudePackage ────────────────────────────────────────────────────
  describe("patchAnalysis (§4.3)", () => {
    it("admin menja claudePackage detaljne analize", async () => {
      prisma.changeRequestAiAnalysis.findFirst.mockResolvedValue({
        id: 77,
        requestId: 10,
        kind: "DETAILED",
      });
      prisma.changeRequestAiAnalysis.update.mockResolvedValue({
        id: 77,
        claudePackage: "novi",
      });
      const res = await service.patchAnalysis(
        10,
        77,
        { claudePackage: "novi" },
        ADMIN,
      );
      expect((res.data as { claudePackage: string }).claudePackage).toBe(
        "novi",
      );
    });

    it("ne-admin → 403", async () => {
      await expect(
        service.patchAnalysis(10, 77, { claudePackage: "x" }, USER),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it("trijažni red (ne DETAILED) → 422", async () => {
      prisma.changeRequestAiAnalysis.findFirst.mockResolvedValue({
        id: 77,
        requestId: 10,
        kind: "TRIAGE",
      });
      await expect(
        service.patchAnalysis(10, 77, { claudePackage: "x" }, ADMIN),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
    });
  });

  // ── RESTORE ─────────────────────────────────────────────────────────────────
  describe("restore (§12.1 ventil)", () => {
    it("AI-odbačen (REJECTED + event AI_REJECTED) → SUBMITTED + STATUS_CHANGED", async () => {
      prisma.changeRequest.findUnique.mockResolvedValue(
        baseReq({ status: "REJECTED", aiScore: 0 }),
      );
      prisma.changeRequestEvent.findFirst.mockResolvedValue({
        id: 1,
        type: "AI_REJECTED",
      });
      const res = await service.restore(10, ADMIN);
      expect((res.data as { status: string }).status).toBe("SUBMITTED");
      expect(eventTypes(prisma)).toContain("STATUS_CHANGED");
    });

    it("REJECTED bez AI_REJECTED eventa → 422 (ne vraća ručno odbijene)", async () => {
      prisma.changeRequest.findUnique.mockResolvedValue(
        baseReq({ status: "REJECTED" }),
      );
      prisma.changeRequestEvent.findFirst.mockResolvedValue(null);
      await expect(service.restore(10, ADMIN)).rejects.toBeInstanceOf(
        UnprocessableEntityException,
      );
    });

    it("nije REJECTED → 422", async () => {
      prisma.changeRequest.findUnique.mockResolvedValue(
        baseReq({ status: "SUBMITTED" }),
      );
      await expect(service.restore(10, ADMIN)).rejects.toBeInstanceOf(
        UnprocessableEntityException,
      );
    });

    it("spojen (mergedIntoId) → 422", async () => {
      prisma.changeRequest.findUnique.mockResolvedValue(
        baseReq({ status: "REJECTED", mergedIntoId: 3 }),
      );
      await expect(service.restore(10, ADMIN)).rejects.toBeInstanceOf(
        UnprocessableEntityException,
      );
    });

    it("ne-admin → 403", async () => {
      await expect(service.restore(10, USER)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });
  });

  // ── RETRY TRANSKRIPCIJE ──────────────────────────────────────────────────────
  describe("retryTranscribe (§5, dovršava F1)", () => {
    it("dohvati bajtove iz storage-a, pozovi STT, upiši transcript", async () => {
      const res = await service.retryTranscribe({
        id: 5,
        bucket: "zahtevi-prilozi",
        storagePath: "req/10/x.webm",
        contentType: "audio/webm",
        transcript: null,
      });
      expect(storage.download).toHaveBeenCalledWith(
        "zahtevi-prilozi",
        "req/10/x.webm",
      );
      expect(ai.transcribe).toHaveBeenCalled();
      expect((res.data as { transcript: string }).transcript).toBe("prepis");
    });

    it("postojeći transcript (immutable) → 422, NE zove STT", async () => {
      await expect(
        service.retryTranscribe({
          id: 5,
          bucket: "b",
          storagePath: "p",
          contentType: "audio/webm",
          transcript: "već postoji",
        }),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
      expect(ai.transcribe).not.toHaveBeenCalled();
    });
  });
});
