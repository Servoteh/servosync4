import { HttpException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { AI_MODULE, AiLimitsService } from "./ai-limits.service";
import { AiUsageService } from "./ai-usage.service";
import type { PrismaService } from "../../prisma/prisma.service";

/**
 * Talas AI-0, stavke 4 i 5 — ledger (`ai_usage_log`) i dnevni budžeti nad njim.
 * Bez baze: PrismaService je mokovan.
 */

function prismaMock() {
  return {
    aiUsageLog: { create: jest.fn().mockResolvedValue({}) },
    $queryRaw: jest.fn().mockResolvedValue([{ n: BigInt(0) }]),
  };
}

/** `data` iz prvog `aiUsageLog.create({ data })` poziva (tipizovano, bez `any`). */
function createdData(prisma: ReturnType<typeof prismaMock>): unknown {
  const call = prisma.aiUsageLog.create.mock.calls[0] as [{ data: unknown }];
  return call[0].data;
}

describe("AiUsageService (ledger)", () => {
  const ENV = { ...process.env };
  afterEach(() => {
    process.env = { ...ENV };
  });

  it("upisuje red sa procenom cene za poznat model", async () => {
    const prisma = prismaMock();
    const svc = new AiUsageService(prisma as unknown as PrismaService);
    await svc.record({
      module: AI_MODULE.CHAT,
      userId: 5,
      provider: "anthropic",
      model: "claude-sonnet-5",
      tokensIn: 1_000_000,
      tokensOut: 0,
      durationMs: 123,
      outcome: "ok",
    });
    const data = createdData(prisma) as {
      estCostUsd: Prisma.Decimal;
      module: string;
      userId: number;
    };
    expect(data.module).toBe("chat");
    expect(data.userId).toBe(5);
    // 1M ulaznih tokena × $3/MTok = $3.000000
    expect(String(data.estCostUsd)).toBe("3");
  });

  it("nepoznat model → cena null (kolona je `est_`, ne izmišljamo brojeve)", async () => {
    const prisma = prismaMock();
    const svc = new AiUsageService(prisma as unknown as PrismaService);
    await svc.record({
      module: "chat",
      provider: "openai",
      model: "neki-novi-model",
      tokensIn: 10,
      tokensOut: 10,
      durationMs: 1,
      outcome: "ok",
    });
    const data = createdData(prisma) as {
      estCostUsd: unknown;
    };
    expect(data.estCostUsd).toBeNull();
  });

  it("datirani snapshot modela se ceni po prefiksu (haiku-4-5-20251001)", async () => {
    const prisma = prismaMock();
    const svc = new AiUsageService(prisma as unknown as PrismaService);
    await svc.record({
      module: "zahtevi-triage",
      provider: "anthropic",
      model: "claude-haiku-4-5-20251001",
      tokensIn: 1_000_000,
      tokensOut: 0,
      durationMs: 1,
      outcome: "ok",
    });
    const data = createdData(prisma) as {
      estCostUsd: Prisma.Decimal;
    };
    expect(String(data.estCostUsd)).toBe("1");
  });

  it("pad baze se guta (ledger nikad ne obara AI poziv)", async () => {
    const prisma = prismaMock();
    prisma.aiUsageLog.create.mockRejectedValue(new Error("db down"));
    const svc = new AiUsageService(prisma as unknown as PrismaService);
    await expect(
      svc.record({
        module: "chat",
        provider: "openai",
        model: "gpt-4o-mini",
        durationMs: 1,
        outcome: "ok",
      }),
    ).resolves.toBeUndefined();
  });
});

describe("AiLimitsService (dnevni budžeti)", () => {
  const ENV = { ...process.env };
  afterEach(() => {
    process.env = { ...ENV };
  });

  function make(dailyTokens = 0, dailyCalls = 0) {
    const usage = {
      dailyInputTokens: jest.fn().mockResolvedValue(dailyTokens),
      dailyCalls: jest.fn().mockResolvedValue(dailyCalls),
    } as unknown as AiUsageService;
    return new AiLimitsService(usage);
  }

  it("chat: podrazumevano 200.000 ULAZNIH tokena/korisnik/dan", async () => {
    const b = await make(50_000).chatBudget(1, "sef");
    expect(b).toEqual({
      used: 50_000,
      limit: 200_000,
      remaining: 150_000,
      unit: "tokens",
    });
  });

  it("chat: potrošen budžet → 429 sa ljudskom porukom na srpskom", async () => {
    let err!: HttpException;
    try {
      await make(200_000).assertChat(1, "sef");
    } catch (e) {
      err = e as HttpException;
    }
    expect(err.getStatus()).toBe(429);
    const body = err.getResponse() as { error: string; message: string };
    expect(body.error).toBe("chat_token_limit");
    expect(body.message).toContain("dnevni AI budžet");
    expect(body.message).toContain("Nastavi sutra");
  });

  it("admin nema limit (limit -1) i assert nikad ne baca", async () => {
    const svc = make(10_000_000);
    const b = await svc.chatBudget(1, "admin");
    expect(b.limit).toBe(-1);
    await expect(svc.assertChat(1, "admin")).resolves.toBeDefined();
  });

  it("STT: 30 min/dan = 30 poziva × prosečnih 60 s (dokumentovana procena)", async () => {
    const svc = make(0, 29);
    const b = await svc.sttBudget(1, "sef");
    expect(b.limit).toBe(1800);
    expect(b.used).toBe(1740);
    await expect(svc.assertStt(1, "sef")).resolves.toBeDefined();
    await expect(make(0, 30).assertStt(1, "sef")).rejects.toMatchObject({
      status: 429,
    });
  });

  it("refine: 100 poziva/dan", async () => {
    await expect(make(0, 99).assertRefine(1, "sef")).resolves.toBeDefined();
    await expect(make(0, 100).assertRefine(1, "sef")).rejects.toMatchObject({
      status: 429,
    });
  });

  it("limiti se podešavaju env-om (bez deploy-a)", async () => {
    process.env.AI_CHAT_DAILY_INPUT_TOKENS = "1000";
    process.env.AI_REFINE_DAILY_CALLS = "2";
    expect(AiLimitsService.chatTokenLimit()).toBe(1000);
    expect(AiLimitsService.refineCallLimit()).toBe(2);
    await expect(make(1000).assertChat(1, "sef")).rejects.toMatchObject({
      status: 429,
    });
  });
});
