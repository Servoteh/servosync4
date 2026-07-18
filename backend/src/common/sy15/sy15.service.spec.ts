import { Sy15Service } from "./sy15.service";

/**
 * withUserRls (TALAS B review 12.07): konekciona rola servosync2_app je BYPASSRLS,
 * pa RLS paritet postoji SAMO ako se u istoj tx posle GUC claims-a izvrši
 * `SET LOCAL ROLE authenticated`. Ovaj spec pinuje redosled i to da `withUser`
 * (Reversi/Lokacije) OSTAJE bez SET ROLE.
 */
describe("Sy15Service GUC most", () => {
  const OLD_URL = process.env.SY15_DATABASE_URL;

  beforeAll(() => {
    process.env.SY15_DATABASE_URL = "postgresql://stub:stub@localhost:5/stub";
  });
  afterAll(() => {
    if (OLD_URL === undefined) delete process.env.SY15_DATABASE_URL;
    else process.env.SY15_DATABASE_URL = OLD_URL;
  });

  function makeService() {
    const calls: string[] = [];
    const txOptions: (unknown | undefined)[] = [];
    const tx = {
      $queryRaw: jest.fn((strings: TemplateStringsArray) => {
        calls.push(strings.join("$"));
        return Promise.resolve([]);
      }),
      $executeRaw: jest.fn((strings: TemplateStringsArray) => {
        calls.push(strings.join("$"));
        return Promise.resolve(0);
      }),
    };
    const svc = new Sy15Service();
    // Zameni realan PrismaClient stubom (nema žive baze u unit testu).
    (svc as unknown as { client: unknown }).client = {
      $transaction: (fn: (t: unknown) => Promise<unknown>, options?: unknown) => {
        txOptions.push(options);
        return fn(tx);
      },
      $disconnect: () => Promise.resolve(),
    };
    return { svc, calls, txOptions };
  }

  it("withUserRls: GUC claims PA SET LOCAL ROLE authenticated, u istoj tx", async () => {
    const { svc, calls } = makeService();
    const out = await svc.withUserRls("test@servoteh.com", () =>
      Promise.resolve("rezultat"),
    );
    expect(out).toBe("rezultat");
    const claimsIdx = calls.findIndex((c) => c.includes("request.jwt.claims"));
    const roleIdx = calls.findIndex((c) =>
      c.includes("SET LOCAL ROLE authenticated"),
    );
    // claims (uklj. auth.users lookup za sub) MORAJU pre SET ROLE —
    // authenticated nema SELECT na auth.users.
    expect(claimsIdx).toBeGreaterThanOrEqual(0);
    expect(roleIdx).toBeGreaterThan(claimsIdx);
  });

  it("withUserRls: opcioni {timeoutMs} ide u $transaction options (per-poziv, ne globalni default)", async () => {
    const { svc, txOptions } = makeService();
    // Bez opcije → nema options (globalni Prisma default ostaje netaknut).
    await svc.withUserRls("test@servoteh.com", () => Promise.resolve(1));
    expect(txOptions[0]).toBeUndefined();
    // Sa opcijom → { timeout: N } se prosleđuje u $transaction.
    await svc.withUserRls("test@servoteh.com", () => Promise.resolve(2), {
      timeoutMs: 30000,
    });
    expect(txOptions[1]).toEqual({ timeout: 30000 });
  });

  it("withUser: BEZ SET ROLE (Reversi/Lokacije ponašanje netaknuto)", async () => {
    const { svc, calls } = makeService();
    await svc.withUser("test@servoteh.com", () => Promise.resolve(null));
    expect(calls.some((c) => c.includes("request.jwt.claims"))).toBe(true);
    expect(calls.some((c) => c.includes("SET LOCAL ROLE"))).toBe(false);
  });

  /**
   * runIdempotentRls (TALAS B): registar (rev_api_idempotency) piše se pod BYPASSRLS
   * konekcionom rolom, akcija ide pod `authenticated`. Pinuje redosled i idempotent-replay.
   */
  function makeIdemService(opts: {
    inserted: number;
    stored?: { action: string; result: unknown }[];
  }) {
    const calls: string[] = [];
    const tx = {
      $queryRaw: jest.fn((strings: TemplateStringsArray) => {
        const sql = strings.join("$");
        calls.push(sql);
        if (sql.includes("SELECT action, result"))
          return Promise.resolve(opts.stored ?? []);
        return Promise.resolve([]);
      }),
      $executeRaw: jest.fn((strings: TemplateStringsArray) => {
        const sql = strings.join("$");
        calls.push(sql);
        if (sql.includes("INSERT INTO rev_api_idempotency"))
          return Promise.resolve(opts.inserted);
        return Promise.resolve(0);
      }),
    };
    const svc = new Sy15Service();
    (svc as unknown as { client: unknown }).client = {
      $transaction: (fn: (t: unknown) => Promise<unknown>) => fn(tx),
      $disconnect: () => Promise.resolve(),
    };
    return { svc, calls };
  }

  it("runIdempotentRls: svež ključ → claims → INSERT registar → SET ROLE → fn → RESET ROLE → UPDATE", async () => {
    const { svc, calls } = makeIdemService({ inserted: 1 });
    const fn = jest.fn().mockResolvedValue({ ok: true });
    const out = await svc.runIdempotentRls(
      "u@servoteh.com",
      "3b241101-e2bb-4255-8caf-4136c566a962",
      "sastanci.create-sastanak",
      fn,
    );
    expect(out).toEqual({ idempotent: false, result: { ok: true } });
    expect(fn).toHaveBeenCalledTimes(1);
    const iInsert = calls.findIndex((c) =>
      c.includes("INSERT INTO rev_api_idempotency"),
    );
    const iRole = calls.findIndex((c) =>
      c.includes("SET LOCAL ROLE authenticated"),
    );
    const iReset = calls.findIndex((c) => c.includes("RESET ROLE"));
    const iUpd = calls.findIndex((c) =>
      c.includes("UPDATE rev_api_idempotency"),
    );
    // Registar-insert PRE SET ROLE (authenticated nema grant na registar);
    // RESET ROLE PRE update-a rezultata.
    expect(iInsert).toBeGreaterThanOrEqual(0);
    expect(iRole).toBeGreaterThan(iInsert);
    expect(iReset).toBeGreaterThan(iRole);
    expect(iUpd).toBeGreaterThan(iReset);
  });

  it("runIdempotentRls: ponovljen ključ (ista akcija) → vraća sačuvan rezultat BEZ fn", async () => {
    const { svc } = makeIdemService({
      inserted: 0,
      stored: [{ action: "sastanci.lock", result: { ok: true } }],
    });
    const fn = jest.fn();
    const out = await svc.runIdempotentRls(
      "u@servoteh.com",
      "3b241101-e2bb-4255-8caf-4136c566a962",
      "sastanci.lock",
      fn,
    );
    expect(out).toEqual({ idempotent: true, result: { ok: true } });
    expect(fn).not.toHaveBeenCalled();
  });

  it("runIdempotentRls: ključ upotrebljen za DRUGU akciju → ConflictException", async () => {
    const { svc } = makeIdemService({
      inserted: 0,
      stored: [{ action: "sastanci.lock", result: null }],
    });
    await expect(
      svc.runIdempotentRls(
        "u@servoteh.com",
        "3b241101-e2bb-4255-8caf-4136c566a962",
        "sastanci.create-akcija",
        jest.fn(),
      ),
    ).rejects.toThrow(/već upotrebljen/);
  });
});
