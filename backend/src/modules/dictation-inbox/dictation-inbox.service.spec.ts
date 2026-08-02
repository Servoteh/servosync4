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

/**
 * Nalozi „u bazi" za mock. `findUnique` niže ih traži TAČNO (po `id` ili po celom
 * e-mailu) — baš kao Postgres nad `uq_users_email`. To je suština testa džokera:
 * mock ne zna za `ILIKE`, pa svaki upit koji bi se oslonio na obrazac vrati `null`.
 */
type MockUser = { id: number; email: string; active: boolean };
const USERS: MockUser[] = [
  { id: 42, email: "agent@servoteh.com", active: true },
  { id: 2, email: "nenad.jarakovic@servoteh.com", active: true },
  { id: 3, email: "bivsi@servoteh.com", active: false },
  { id: 99, email: "ugasen.agent@servoteh.com", active: false },
];

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
      // TAČNO poređenje (unique indeks), nikad „liči na" — vidi USERS gore.
      findUnique: jest.fn(
        ({ where }: { where: { id?: number; email?: string } }) => {
          const row = USERS.find((u) =>
            where.id !== undefined
              ? u.id === where.id
              : u.email === where.email,
          );
          return Promise.resolve(row ? { ...row } : null);
        },
      ),
      // Postoji samo da bi test mogao da dokaže da se NE koristi (ILIKE put).
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
/**
 * Parametri tog upita, redom pojavljivanja u SQL-u:
 * `[0]` = `claimed_by_user_id` (POZIVALAC, iz SET klauzule),
 * `[1]` = `user_id` (VLASNIK sandučeta, iz WHERE klauzule).
 * Testovi porede ceo niz — tako se vidi i ko povlači i čije se sanduče prazni.
 */
function claimParams(
  prisma: ReturnType<typeof prismaMock>,
  call = 0,
): unknown[] {
  return claimArg(prisma, call).values;
}

/** Prvi argument prvog `dictationInbox.findFirst` poziva — upit koji je servis poslao. */
function inboxQuery<T>(prisma: ReturnType<typeof prismaMock>): T {
  const calls = prisma.dictationInbox.findFirst.mock.calls as unknown as [T][];
  return calls[0][0];
}

/** Poruka odbijanja (za poređenje dva 403 — ne smeju se razlikovati). */
function poruka(p: Promise<unknown>): Promise<string> {
  return p.then(
    () => "NIJE PUKLO",
    (e: unknown) => (e instanceof Error ? e.message : String(e)),
  );
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
    expect(claimParams(prisma)).toEqual([42, 42]); // povlači 42, iz svog sandučeta
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
    // Tačno JEDAN upit — ne „pročitaj pa upiši" (između bi druga sesija stigla).
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(prisma.dictationInbox.findFirst).not.toHaveBeenCalled();
    expect(prisma.dictationInbox.update).not.toHaveBeenCalled();
    expect(prisma.dictationInbox.updateMany).not.toHaveBeenCalled();
  });

  it("FIFO: claim uzima NAJSTARIJI nepreuzet (ORDER BY created_at ASC, id ASC)", async () => {
    // Višedelni diktat („prvo X", „pa Y") mora agentu stići hronološki — LIFO bi mu
    // isporučio korake obrnutim redom. Redosled je deo UGOVORA rute, ne detalj.
    prisma.$queryRaw.mockResolvedValue([
      { id: 7, text: "prvo X", created_at: new Date() },
    ]);
    await service.claim(ACTOR);

    const sql = claimSql(prisma);
    expect(sql).toMatch(/ORDER BY created_at ASC, id ASC/i);
    expect(sql).not.toMatch(/ORDER BY created_at DESC/i);
  });

  it("FIFO: claim beleži KO je uzeo (claimed_by_user_id = pozivalac iz JWT-a)", async () => {
    // Bez ovoga `lastClaimed` ne bi umeo da razlikuje moj plen od tuđeg.
    prisma.$queryRaw.mockResolvedValue([
      { id: 7, text: "x", created_at: new Date() },
    ]);
    await service.claim(ACTOR);

    expect(claimSql(prisma)).toMatch(/claimed_by_user_id = \$\d+/i);
    expect(claimParams(prisma)).toContain(42);
  });

  it("ATOMIČNOST: dva uzastopna claim-a NE vraćaju isti red (treći → null)", async () => {
    // Mock se ponaša kao baza sa SKIP LOCKED: svaki poziv „potroši" jedan red.
    // Poredak reda odgovara FIFO-u — najstariji prvi.
    const queue = [
      { id: 8, text: "prvi", created_at: new Date("2026-08-02T09:00:00Z") },
      { id: 9, text: "drugi", created_at: new Date("2026-08-02T10:00:00Z") },
    ];
    prisma.$queryRaw.mockImplementation(() => {
      const row = queue.shift();
      return Promise.resolve(row ? [row] : []);
    });

    const a = await service.claim(ACTOR);
    const b = await service.claim(ACTOR);
    const c = await service.claim(ACTOR);

    expect(a.data?.id).toBe(8); // najstariji prvi (ORDER BY created_at ASC)
    expect(b.data?.id).toBe(9);
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
    // UPDATE gađa VLASNIKOVO sanduče (drugi parametar), a beleži POZIVAOCA (prvi).
    expect(claimParams(prisma)).toEqual([42, 2]);
  });

  it("DELEGACIJA odbijena: nema reda → 403 i NIJEDAN red se ne dira", async () => {
    prisma.dictationDelegate.findFirst.mockResolvedValue(null);

    await expect(
      service.claim(ACTOR, { ownerUserId: 2 }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it("DELEGACIJA: nepoznat vlasnik daje ISTI 403 (ruta nije orakl za nabrajanje naloga)", async () => {
    await expect(
      service.claim(ACTOR, { ownerEmail: "neko@nepostoji.rs" }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it("DELEGACIJA: ownerEmail se normalizuje (trim + mala slova) i traži TAČNO", async () => {
    prisma.dictationDelegate.findFirst.mockResolvedValue({ id: 1 });
    prisma.$queryRaw.mockResolvedValue([
      { id: 12, text: "t", created_at: new Date() },
    ]);

    await service.claim(ACTOR, {
      ownerEmail: "  Nenad.Jarakovic@Servoteh.com  ",
    });

    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { email: "nenad.jarakovic@servoteh.com" },
      select: { id: true, active: true },
    });
    expect(claimParams(prisma)).toEqual([42, 2]);
  });

  it("🔴 DŽOKER: `%@servoteh.com` NE razrešava nikoga → 403, bez diranja sandučeta", async () => {
    // Prva verzija je koristila `email: { equals, mode: "insensitive" }`, što Prisma
    // prevodi u `ILIKE $1` — a `%` i `_` su tamo DŽOKERI, ne slova. `@IsEmail` ovaj
    // niz propušta (validan oblik), pa bi napadač jednim pozivom pogodio proizvoljan
    // nalog (mereno nad živom bazom: 59 od 68). Sanduče je komandni kanal, pa je to
    // bio put do TUĐIH instrukcija. Sada: tačno poređenje po unique indeksu.
    prisma.dictationDelegate.findFirst.mockResolvedValue({ id: 1 }); // čak i da dozvola postoji

    for (const wildcard of [
      "%@servoteh.com",
      "_enad.jarakovic@servoteh.com",
      "%%@%",
    ]) {
      await expect(
        service.claim(ACTOR, { ownerEmail: wildcard }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    }

    // Nijedan diktat nije ni pipnut, i nigde nije upotrebljen `mode: insensitive`.
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(prisma.user.findFirst).not.toHaveBeenCalled();
    expect(JSON.stringify(prisma.user.findUnique.mock.calls)).not.toContain(
      "insensitive",
    );
  });

  it("claim: eksplicitno SVOJE sanduče prolazi bez delegacije", async () => {
    prisma.$queryRaw.mockResolvedValue([
      { id: 13, text: "moj", created_at: new Date() },
    ]);

    await service.claim(ACTOR, { ownerUserId: 42 });

    expect(prisma.dictationDelegate.findFirst).not.toHaveBeenCalled();
    expect(claimParams(prisma)).toEqual([42, 42]);
  });

  it("claim: ownerUserId I ownerEmail zajedno → 400", async () => {
    await expect(
      service.claim(ACTOR, { ownerUserId: 2, ownerEmail: "a@b.rs" }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  // ------------------------------------------------------- claim: aktivnost naloga

  it("NEAKTIVAN POZIVALAC → 403 odmah, i za SVOJE sanduče", async () => {
    // `JwtStrategy` veruje potpisu tokena i ne čita `users`, pa bi deaktiviran nalog
    // inače radio do isteka tokena. Za komandni kanal je to predugo.
    const ugasen = { userId: 99, email: "ugasen.agent@servoteh.com" };

    await expect(service.claim(ugasen)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it("NEAKTIVAN POZIVALAC → 403 i kad ima urednu delegaciju za tuđe sanduče", async () => {
    prisma.dictationDelegate.findFirst.mockResolvedValue({ id: 1 });
    const ugasen = { userId: 99, email: "ugasen.agent@servoteh.com" };

    await expect(
      service.claim(ugasen, { ownerUserId: 2 }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it("NEAKTIVAN VLASNIK → 403 (njegovi diktati se više ne povlače)", async () => {
    prisma.dictationDelegate.findFirst.mockResolvedValue({ id: 1 });

    await expect(
      service.claim(ACTOR, { ownerUserId: 3 }), // bivsi@servoteh.com, active: false
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it("NEAKTIVAN VLASNIK BEZ delegacije daje isti 403 — stanje naloga se ne odaje", async () => {
    prisma.dictationDelegate.findFirst.mockResolvedValue(null);

    const bezDozvole = await poruka(service.claim(ACTOR, { ownerUserId: 3 }));
    const nepostojeci = await poruka(
      service.claim(ACTOR, { ownerEmail: "neko@nepostoji.rs" }),
    );

    expect(bezDozvole).toBe(nepostojeci);
    expect(bezDozvole).toMatch(/Nemaš dozvolu/);
  });

  // ---------------------------------------------------------- claim: audit/RL

  it("AUDIT: beleži KO je i ČIJI diktat povukao — ali NIKAD sam tekst", async () => {
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

  it("RATE-LIMIT je NIŽI od punog sandučeta — inače se brana nikad ne okine", () => {
    // Suština nalaza: sa 60/min jedan napadač isprazni punih MAX_UNDELIVERED = 50
    // diktata u PRVOM minutu, bez ijednog 429. Granica mora biti manja od plena.
    expect(CLAIM_THROTTLE_POLICY.MAX_CLAIMS).toBeLessThan(
      DictationInboxService.MAX_UNDELIVERED,
    );
  });

  // ------------------------------------------------------------- last-claimed

  it("OPORAVAK: lastClaimed vraća SAMO svoj plen, u prozoru, najskoriji prvi", async () => {
    const claimedAt = new Date("2026-08-02T09:05:00Z");
    prisma.dictationInbox.findFirst.mockResolvedValue({
      id: 31,
      userId: 2,
      text: "dodaj dugme",
      createdAt: new Date("2026-08-02T09:00:00Z"),
      deliveredAt: claimedAt,
      claimedByUserId: 42,
    });
    prisma.dictationDelegate.findFirst.mockResolvedValue({ id: 1 });

    const res = await service.lastClaimed(ACTOR, { ownerUserId: 2 });

    const call = inboxQuery<{
      where: {
        userId: number;
        claimedByUserId: number;
        deliveredAt: { gte: Date };
      };
      orderBy: { deliveredAt: string };
    }>(prisma);
    expect(call.where.userId).toBe(2); // vlasnikovo sanduče
    expect(call.where.claimedByUserId).toBe(42); // ali SAMO ono što je moj plen
    expect(call.orderBy).toEqual({ deliveredAt: "desc" });
    expect(res.data).toEqual({
      id: 31,
      text: "dodaj dugme",
      createdAt: new Date("2026-08-02T09:00:00Z"),
      claimedAt,
    });
    expect(res.meta.windowMinutes).toBe(
      DictationInboxService.LAST_CLAIMED_WINDOW_MIN,
    );
  });

  it("OPORAVAK: prozor je tačno LAST_CLAIMED_WINDOW_MIN minuta unazad", async () => {
    const now = Date.now();
    await service.lastClaimed(ACTOR);

    const call = inboxQuery<{ where: { deliveredAt: { gte: Date } } }>(prisma);
    const backMs = now - call.where.deliveredAt.gte.getTime();
    const expected = DictationInboxService.LAST_CLAIMED_WINDOW_MIN * 60_000;
    // Tolerancija na trajanje samog testa; suština je da NIJE „sve od pamtiveka".
    expect(backMs).toBeGreaterThanOrEqual(expected - 1_000);
    expect(backMs).toBeLessThanOrEqual(expected + 1_000);
  });

  it("OPORAVAK: van prozora / tuđ plen → data: null (baza filtrira, servis ne izmišlja)", async () => {
    prisma.dictationInbox.findFirst.mockResolvedValue(null);
    await expect(service.lastClaimed(ACTOR)).resolves.toEqual({
      data: null,
      meta: { windowMinutes: DictationInboxService.LAST_CLAIMED_WINDOW_MIN },
    });
  });

  it("OPORAVAK: bez delegacije → 403, bez ijednog čitanja tuđeg sandučeta", async () => {
    prisma.dictationDelegate.findFirst.mockResolvedValue(null);

    await expect(
      service.lastClaimed(ACTOR, { ownerUserId: 2 }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.dictationInbox.findFirst).not.toHaveBeenCalled();
  });

  it("OPORAVAK: neaktivan pozivalac → 403", async () => {
    const ugasen = { userId: 99, email: "ugasen.agent@servoteh.com" };
    await expect(service.lastClaimed(ugasen)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(prisma.dictationInbox.findFirst).not.toHaveBeenCalled();
  });

  it("OPORAVAK: džoker e-mail ni ovde ne prolazi → 403", async () => {
    prisma.dictationDelegate.findFirst.mockResolvedValue({ id: 1 });
    await expect(
      service.lastClaimed(ACTOR, { ownerEmail: "%@servoteh.com" }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.dictationInbox.findFirst).not.toHaveBeenCalled();
  });

  it("OPORAVAK: lastClaimed NE troši rate-limit — radi i pošto je claim već u 429", async () => {
    prisma.$queryRaw.mockResolvedValue([]);
    for (let i = 0; i < CLAIM_THROTTLE_POLICY.MAX_CLAIMS; i++) {
      await service.claim(ACTOR);
    }
    await expect(service.claim(ACTOR)).rejects.toBeInstanceOf(HttpException);

    // Agent kome je poll pao u 429 i dalje sme da pročita ono što je već povukao —
    // inače bi ga brana koštala baš onog diktata zbog kog je zvao.
    await expect(service.lastClaimed(ACTOR)).resolves.toMatchObject({
      data: null,
    });
  });
});
