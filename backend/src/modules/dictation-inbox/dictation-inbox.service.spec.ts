import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { Test, TestingModule } from "@nestjs/testing";
import { PrismaService } from "../../prisma/prisma.service";
import { DictationInboxService } from "./dictation-inbox.service";
import { CLAIM_THROTTLE_POLICY, __resetClaimThrottle } from "./claim-throttle";

/** Mock PrismaService — samo modeli koje ovaj modul dodiruje. */
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
      update: jest.fn(),
      updateMany: jest.fn(),
      // Default: 0 nepreuzetih → ispod MAX_UNDELIVERED, insert prolazi.
      count: jest.fn().mockResolvedValue(0),
    },
    dictationDelegate: {
      // Default: NEMA delegacije → tuđe sanduče je zatvoreno (default-deny).
      findFirst: jest.fn().mockResolvedValue(null),
    },
    user: {
      findUnique: jest.fn().mockResolvedValue(null),
      findFirst: jest.fn().mockResolvedValue(null),
    },
    auditLog: { create: jest.fn().mockResolvedValue({ id: 1 }) },
    // `claim` ide jednim sirovim UPDATE … RETURNING upitom.
    $queryRaw: jest.fn().mockResolvedValue([]),
  };
}

/** Prvi argument N-tog `$queryRaw` poziva — `Prisma.Sql` objekat. */
function claimArg(
  prisma: ReturnType<typeof prismaMock>,
  call: number,
): { text: string; values: unknown[] } {
  const calls = prisma.$queryRaw.mock.calls as unknown as [
    { text: string; values: unknown[] },
  ][];
  return calls[call][0];
}
/** Tekst SQL-a koji je `claim` poslao (Prisma.Sql → `$1` placeholderi). */
function claimSql(prisma: ReturnType<typeof prismaMock>, call = 0): string {
  return claimArg(prisma, call).text.replace(/\s+/g, " ");
}
/** Parametri tog upita (prvi je uvek `user_id` vlasnika sandučeta). */
function claimParams(
  prisma: ReturnType<typeof prismaMock>,
  call = 0,
): unknown[] {
  return claimArg(prisma, call).values;
}

describe("DictationInboxService", () => {
  let service: DictationInboxService;
  let prisma: ReturnType<typeof prismaMock>;

  beforeEach(async () => {
    __resetClaimThrottle();
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

  // ------------------------------------------------------------------- claim
  // Sve što sledi štiti rutu za AGENTA VAN LOKALNE MREŽE (oblak): `claim` mora
  // biti atomičan (pravilo „ko prvi povuče — njegov je") i default-deny za tuđe
  // sanduče.

  const ACTOR = { userId: 42, email: "agent@servoteh.com" };

  it("claim: bez ownera troši SVOJE sanduče i vraća { id, text, createdAt }", async () => {
    prisma.$queryRaw.mockResolvedValue([
      {
        id: 7,
        text: "dodaj dugme",
        created_at: new Date("2026-08-02T09:00:00Z"),
      },
    ]);

    const res = await service.claim(ACTOR);

    expect(res.data).toEqual({
      id: 7,
      text: "dodaj dugme",
      createdAt: new Date("2026-08-02T09:00:00Z"),
    });
    expect(claimParams(prisma)[0]).toBe(42); // sanduče = pozivalac iz JWT-a
  });

  it("ATOMIČNOST: jedan UPDATE … FOR UPDATE SKIP LOCKED … RETURNING, nema dvokoračnog puta", async () => {
    prisma.$queryRaw.mockResolvedValue([
      { id: 7, text: "x", created_at: new Date() },
    ]);
    await service.claim(ACTOR);

    const sql = claimSql(prisma);
    expect(sql).toMatch(/UPDATE dictation_inbox/i);
    expect(sql).toMatch(/SET delivered_at = now\(\)/i);
    expect(sql).toMatch(/FOR UPDATE SKIP LOCKED/i);
    expect(sql).toMatch(/RETURNING id, text, created_at/i);
    expect(sql).toMatch(/ORDER BY created_at DESC/i);
    // Tačno JEDAN upit — ne „pročitaj pa upiši" (između bi druga sesija stigla).
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(prisma.dictationInbox.findFirst).not.toHaveBeenCalled();
    expect(prisma.dictationInbox.update).not.toHaveBeenCalled();
    expect(prisma.dictationInbox.updateMany).not.toHaveBeenCalled();
  });

  it("ATOMIČNOST: dva uzastopna claim-a NE vraćaju isti red (treći → null)", async () => {
    // Mock se ponaša kao baza sa SKIP LOCKED: svaki poziv „potroši" jedan red.
    const queue = [
      { id: 9, text: "drugi", created_at: new Date("2026-08-02T10:00:00Z") },
      { id: 8, text: "prvi", created_at: new Date("2026-08-02T09:00:00Z") },
    ];
    prisma.$queryRaw.mockImplementation(() => {
      const row = queue.shift();
      return Promise.resolve(row ? [row] : []);
    });

    const a = await service.claim(ACTOR);
    const b = await service.claim(ACTOR);
    const c = await service.claim(ACTOR);

    expect(a.data?.id).toBe(9); // najnoviji prvi (ORDER BY created_at DESC)
    expect(b.data?.id).toBe(8);
    expect(a.data?.id).not.toBe(b.data?.id);
    expect(c.data).toBeNull(); // prazno sanduče
  });

  it("claim: prazno sanduče → { data: null }, bez audit upisa", async () => {
    prisma.$queryRaw.mockResolvedValue([]);
    await expect(service.claim(ACTOR)).resolves.toEqual({ data: null });
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  // --------------------------------------------------------- claim: delegacija

  it("DELEGACIJA dozvoljena: postoji red (owner, pozivalac) → troši TUĐE sanduče", async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 2 }); // vlasnik postoji
    prisma.dictationDelegate.findFirst.mockResolvedValue({ id: 1 });
    prisma.$queryRaw.mockResolvedValue([
      { id: 11, text: "Nenadov diktat", created_at: new Date() },
    ]);

    const res = await service.claim(ACTOR, { ownerUserId: 2 });

    expect(res.data?.id).toBe(11);
    // Dozvola se traži tačno za par (vlasnik, POZIVALAC) — ne obrnuto.
    expect(prisma.dictationDelegate.findFirst).toHaveBeenCalledWith({
      where: { ownerUserId: 2, delegateUserId: 42 },
      select: { id: true },
    });
    // UPDATE gađa VLASNIKOVO sanduče, ne pozivaočevo.
    expect(claimParams(prisma)[0]).toBe(2);
  });

  it("DELEGACIJA odbijena: nema reda → 403 i NIJEDAN red se ne dira", async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 2 });
    prisma.dictationDelegate.findFirst.mockResolvedValue(null);

    await expect(
      service.claim(ACTOR, { ownerUserId: 2 }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it("DELEGACIJA: nepoznat vlasnik daje ISTI 403 (ruta nije orakl za nabrajanje naloga)", async () => {
    prisma.user.findFirst.mockResolvedValue(null); // nema takvog e-maila

    await expect(
      service.claim(ACTOR, { ownerEmail: "neko@nepostoji.rs" }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it("DELEGACIJA: ownerEmail se razrešava u users.id (case-insensitive)", async () => {
    prisma.user.findFirst.mockResolvedValue({ id: 2 });
    prisma.dictationDelegate.findFirst.mockResolvedValue({ id: 1 });
    prisma.$queryRaw.mockResolvedValue([
      { id: 12, text: "t", created_at: new Date() },
    ]);

    await service.claim(ACTOR, { ownerEmail: "Nenad.Jarakovic@Servoteh.com" });

    expect(prisma.user.findFirst).toHaveBeenCalledWith({
      where: {
        email: { equals: "Nenad.Jarakovic@Servoteh.com", mode: "insensitive" },
      },
      select: { id: true },
    });
    expect(claimParams(prisma)[0]).toBe(2);
  });

  it("claim: eksplicitno SVOJE sanduče prolazi bez delegacije", async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 42 });
    prisma.$queryRaw.mockResolvedValue([
      { id: 13, text: "moj", created_at: new Date() },
    ]);

    await service.claim(ACTOR, { ownerUserId: 42 });

    expect(prisma.dictationDelegate.findFirst).not.toHaveBeenCalled();
    expect(claimParams(prisma)[0]).toBe(42);
  });

  it("claim: ownerUserId I ownerEmail zajedno → 400", async () => {
    await expect(
      service.claim(ACTOR, { ownerUserId: 2, ownerEmail: "a@b.rs" }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------- claim: audit/RL

  it("AUDIT: beleži KO je i ČIJI diktat povukao — ali NIKAD sam tekst", async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 2 });
    prisma.dictationDelegate.findFirst.mockResolvedValue({ id: 1 });
    prisma.$queryRaw.mockResolvedValue([
      { id: 21, text: "poslovna tajna u tekstu", created_at: new Date() },
    ]);

    await service.claim(ACTOR, { ownerUserId: 2 });

    const auditCalls = prisma.auditLog.create.mock.calls as unknown as [
      {
        data: {
          actorUserId: number;
          entityType: string;
          entityId: string;
          afterData: Record<string, unknown>;
        };
      },
    ][];
    const arg = auditCalls[0][0];
    expect(arg.data.actorUserId).toBe(42);
    expect(arg.data.entityType).toBe("dictation_inbox");
    expect(arg.data.entityId).toBe("21");
    expect(arg.data.afterData.owner_user_id).toBe(2);
    expect(arg.data.afterData.delegated).toBe(true);
    expect(arg.data.afterData.text_len).toBe("poslovna tajna u tekstu".length);
    // Tekst ne sme nigde u audit red.
    expect(JSON.stringify(arg.data)).not.toContain("poslovna tajna");
  });

  it("AUDIT je best-effort: pad upisa NE obara claim (diktat je već potrošen)", async () => {
    prisma.$queryRaw.mockResolvedValue([
      { id: 22, text: "x", created_at: new Date() },
    ]);
    prisma.auditLog.create.mockRejectedValue(new Error("audit down"));

    await expect(service.claim(ACTOR)).resolves.toMatchObject({
      data: { id: 22 },
    });
  });

  it("RATE-LIMIT: preko granice → 429, bez daljeg pražnjenja sandučeta", async () => {
    prisma.$queryRaw.mockResolvedValue([]);
    for (let i = 0; i < CLAIM_THROTTLE_POLICY.MAX_CLAIMS; i++) {
      await service.claim(ACTOR);
    }
    const before = prisma.$queryRaw.mock.calls.length;

    let status = 0;
    try {
      await service.claim(ACTOR);
    } catch (e) {
      expect(e).toBeInstanceOf(HttpException);
      status = (e as HttpException).getStatus();
    }
    expect(status).toBe(429);
    expect(prisma.$queryRaw.mock.calls.length).toBe(before); // nije ni pokušao
  });
});
