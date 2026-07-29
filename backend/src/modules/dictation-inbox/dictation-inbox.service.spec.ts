import { HttpException, UnprocessableEntityException } from "@nestjs/common";
import { Test, TestingModule } from "@nestjs/testing";
import { PrismaService } from "../../prisma/prisma.service";
import { DictationInboxService } from "./dictation-inbox.service";

/** Mock PrismaService — samo model koji ovaj modul dodiruje. */
function prismaMock() {
  return {
    dictationInbox: {
      create: jest.fn().mockResolvedValue({
        id: 1,
        userId: 42,
        text: "sređen tekst",
        createdAt: new Date("2026-07-28T10:00:00Z"),
        deliveredAt: null,
      }),
      findFirst: jest.fn().mockResolvedValue(null),
      // Default: 0 nepreuzetih → ispod MAX_UNDELIVERED, insert prolazi.
      count: jest.fn().mockResolvedValue(0),
    },
  };
}

describe("DictationInboxService", () => {
  let service: DictationInboxService;
  let prisma: ReturnType<typeof prismaMock>;

  beforeEach(async () => {
    prisma = prismaMock();
    const mod: TestingModule = await Test.createTestingModule({
      providers: [
        DictationInboxService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    service = mod.get(DictationInboxService);
  });

  // ------------------------------------------------------------------ create

  it("create: upisuje red za userId iz JWT-a, trimovan tekst; vraća id + createdAt", async () => {
    const res = await service.create(42, "  zdravo Claude, dodaj dugme  ");

    expect(prisma.dictationInbox.create).toHaveBeenCalledWith({
      data: { userId: 42, text: "zdravo Claude, dodaj dugme" },
    });
    expect(res.data).toEqual({
      id: 1,
      createdAt: new Date("2026-07-28T10:00:00Z"),
    });
  });

  it("create: prazan/whitespace tekst → 422, bez upisa", async () => {
    await expect(service.create(42, "   ")).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
    await expect(service.create(42, "")).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
    expect(prisma.dictationInbox.create).not.toHaveBeenCalled();
  });

  it("create: tekst preko MAX_TEXT_LEN → 422, bez upisa", async () => {
    const tooLong = "a".repeat(DictationInboxService.MAX_TEXT_LEN + 1);
    await expect(service.create(42, tooLong)).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
    expect(prisma.dictationInbox.create).not.toHaveBeenCalled();
  });

  it("create: tačno MAX_TEXT_LEN prolazi (granica je uključiva)", async () => {
    const exact = "a".repeat(DictationInboxService.MAX_TEXT_LEN);
    await service.create(42, exact);
    expect(prisma.dictationInbox.create).toHaveBeenCalledWith({
      data: { userId: 42, text: exact },
    });
  });

  it("create: MAX_UNDELIVERED nagomilanih → 429 (TooManyRequests), bez upisa", async () => {
    prisma.dictationInbox.count.mockResolvedValue(
      DictationInboxService.MAX_UNDELIVERED,
    );
    let status = 0;
    try {
      await service.create(42, "još jedan diktat");
    } catch (e) {
      expect(e).toBeInstanceOf(HttpException);
      status = (e as HttpException).getStatus();
    }
    expect(status).toBe(429);
    expect(prisma.dictationInbox.create).not.toHaveBeenCalled();
    // Brojanje je skopirano na korisnika (ne globalno).
    expect(prisma.dictationInbox.count).toHaveBeenCalledWith({
      where: { userId: 42, deliveredAt: null },
    });
  });

  it("create: ispod MAX_UNDELIVERED (49) i dalje upisuje", async () => {
    prisma.dictationInbox.count.mockResolvedValue(
      DictationInboxService.MAX_UNDELIVERED - 1,
    );
    await service.create(42, "u redu");
    expect(prisma.dictationInbox.create).toHaveBeenCalled();
  });

  // ------------------------------------------------------------------ latest

  it("latest: traži samo NEISPORUČEN red TOG korisnika, najnoviji prvi", async () => {
    prisma.dictationInbox.findFirst.mockResolvedValue({
      id: 7,
      userId: 42,
      text: "poslednji",
      createdAt: new Date("2026-07-28T11:00:00Z"),
      deliveredAt: null,
    });

    const res = await service.latest(42);

    expect(prisma.dictationInbox.findFirst).toHaveBeenCalledWith({
      where: { userId: 42, deliveredAt: null },
      orderBy: { createdAt: "desc" },
    });
    expect(res.data?.id).toBe(7);
  });

  it("latest: nema reda → data: null", async () => {
    await expect(service.latest(42)).resolves.toEqual({ data: null });
  });

  // ------------------------------------------------------------------ IDOR

  it("IDOR: latest je UVEK skopiran na prosleđeni userId — drugi korisnik ne vidi tuđe", async () => {
    // Isti mock (nezavisno šta u bazi stoji): where.userId mora nositi userA, pa
    // userB nikad ne dobija userA-ov red kroz svoj poziv.
    await service.latest(100);
    await service.latest(200);

    const calls = prisma.dictationInbox.findFirst.mock.calls as unknown as [
      { where: { userId: number; deliveredAt: null } },
    ][];
    expect(calls[0][0].where).toEqual({ userId: 100, deliveredAt: null });
    expect(calls[1][0].where).toEqual({ userId: 200, deliveredAt: null });
  });

  it("IDOR: create piše red pod prosleđeni userId (iz JWT-a), ne pod telo zahteva", async () => {
    await service.create(555, "moj diktat");
    expect(prisma.dictationInbox.create).toHaveBeenCalledWith({
      data: { userId: 555, text: "moj diktat" },
    });
  });
});
