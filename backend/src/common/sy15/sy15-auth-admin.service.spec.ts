import { BadGatewayException } from "@nestjs/common";
import { Sy15AuthAdminService } from "./sy15-auth-admin.service";
import type { Sy15Service } from "./sy15.service";

/**
 * 🔴 P0 REGRESIJA (31.07.2026) — GoTrue admin upit je vraćao POGREŠAN nalog.
 *
 * Zatečeno: `findUserIdByEmail` je zvao `GET /admin/users?email=<mejl>` i uzimao `users[0].id`.
 * Živi GoTrue v2.189.0 IGNORIŠE `?email=` i vraća prvu stranu SVIH naloga sortiranu po
 * `created_at DESC` (izmereno: 50 od 60 naloga; traženi `aleksandar.stanic@servoteh.com` bio je na
 * indeksu 3, a `users[0]` je bio tuđ nalog). Posledica u produkciji: lozinka koju je zaposleni
 * izabrao sebi upisana je TUĐEM nalogu — pogođeni admin reset, self-service promena lozinke i
 * idempotentna `createUser` grana.
 *
 * Ovi testovi pinuju obe brane: (1) rezoluciju po TAČNOM email-u, (2) potvrdu naloga pred PUT.
 */
describe("Sy15AuthAdminService — P0 rezolucija naloga po email-u", () => {
  const OLD_AUTH_URL = process.env.SY15_AUTH_URL;
  const OLD_KEY = process.env.SY15_SERVICE_KEY;
  const TARGET = "aleksandar.stanic@servoteh.com";
  const TARGET_ID = "id-stanic";
  const OTHER_ID = "id-ilic";
  const OTHER_EMAIL = "iliczaleksandar@gmail.com";

  beforeEach(() => {
    process.env.SY15_AUTH_URL = "http://sy15-auth:9999/auth/v1";
    process.env.SY15_SERVICE_KEY = "service-key";
  });

  afterEach(() => {
    if (OLD_AUTH_URL === undefined) delete process.env.SY15_AUTH_URL;
    else process.env.SY15_AUTH_URL = OLD_AUTH_URL;
    if (OLD_KEY === undefined) delete process.env.SY15_SERVICE_KEY;
    else process.env.SY15_SERVICE_KEY = OLD_KEY;
    jest.restoreAllMocks();
  });

  // ==================== stubovi ====================

  /** sy15 datasource nekonfigurisan → servis pada na GoTrue REST putanju. */
  const noDb = { isConfigured: false } as unknown as Sy15Service;

  /** sy15 datasource sa stubovanim `$queryRaw` (merodavna DB rezolucija). */
  function dbWith(queryRaw: jest.Mock): Sy15Service {
    return {
      isConfigured: true,
      db: { $queryRaw: queryRaw },
    } as unknown as Sy15Service;
  }

  /** Zabeležen `fetch` poziv — izbegava `any` iz `jest.Mock.calls`. */
  interface FetchCall {
    url: string;
    method: string;
    body?: string;
  }

  /** Jedan planiran odgovor; `body` kao string ide sirov (npr. GoTrue 422 tekst). */
  interface ResSpec {
    body: unknown;
    status?: number;
  }

  /**
   * Instalira `fetch` stub i vraća listu zabeleženih poziva. Odgovori se troše redom, a POSLEDNJI
   * se ponavlja. Svaki poziv pravi SVEŽ `Response` — telo Response-a se čita samo jednom, pa bi
   * deljeni objekat pukao na drugom pozivu („Body is unusable").
   */
  function mockFetch(specs: ResSpec[]): FetchCall[] {
    const calls: FetchCall[] = [];
    jest.spyOn(global, "fetch").mockImplementation((input, init) => {
      const spec = specs[Math.min(calls.length, specs.length - 1)];
      calls.push({
        url:
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : input.url,
        method: init?.method ?? "GET",
        body: typeof init?.body === "string" ? init.body : undefined,
      });
      const status = spec.status ?? 200;
      return Promise.resolve(
        typeof spec.body === "string"
          ? new Response(spec.body, { status })
          : new Response(JSON.stringify(spec.body), {
              status,
              headers: { "Content-Type": "application/json" },
            }),
      );
    });
    return calls;
  }

  /** Živi GoTrue odgovor: 50 naloga, traženi NIJE prvi (indeks 3, kao u produkciji). */
  function fiftyUsers(): Array<{ id: string; email: string }> {
    const users = [
      { id: OTHER_ID, email: OTHER_EMAIL },
      { id: "id-b", email: "b.neko@servoteh.com" },
      { id: "id-c", email: "c.neko@servoteh.com" },
      { id: TARGET_ID, email: TARGET },
    ];
    while (users.length < 50) {
      users.push({ id: `id-${users.length}`, email: `u${users.length}@x.com` });
    }
    return users;
  }

  // ==================== findUserIdByEmail ====================

  describe("findUserIdByEmail", () => {
    it("REST: 50 naloga i traženi NIJE prvi → vraća PRAVI id, ne users[0]", async () => {
      const calls = mockFetch([{ body: { users: fiftyUsers() } }]);
      const svc = new Sy15AuthAdminService(noDb);

      const id = await svc.findUserIdByEmail(TARGET);

      expect(id).toBe(TARGET_ID);
      expect(id).not.toBe(OTHER_ID); // ovo je bio bag: prvi iz liste
      // Ne oslanjamo se više na `?email=` (GoTrue ga ignoriše) — paginirani listing.
      expect(calls[0].url).toContain("page=1");
      expect(calls[0].url).toContain("per_page=");
    });

    it("REST: traženog nema u listi → null (NE users[0])", async () => {
      mockFetch([{ body: { users: fiftyUsers() } }, { body: { users: [] } }]);
      const svc = new Sy15AuthAdminService(noDb);
      await expect(
        svc.findUserIdByEmail("nepostojeci@servoteh.com"),
      ).resolves.toBeNull();
    });

    it("REST: poklapanje je case-insensitive po email-u", async () => {
      mockFetch([{ body: { users: fiftyUsers() } }]);
      const svc = new Sy15AuthAdminService(noDb);
      await expect(
        svc.findUserIdByEmail("  Aleksandar.Stanic@Servoteh.com  "),
      ).resolves.toBe(TARGET_ID);
    });

    it("REST: nastavlja na sledeću stranu dok se traženi ne nađe", async () => {
      mockFetch([
        { body: { users: fiftyUsers().slice(0, 3) } }, // strana 1 — bez traženog
        { body: { users: [{ id: TARGET_ID, email: TARGET }] } }, // strana 2
      ]);
      const svc = new Sy15AuthAdminService(noDb);
      await expect(svc.findUserIdByEmail(TARGET)).resolves.toBe(TARGET_ID);
    });

    it("REST: server ignoriše i `page` (uvek ista strana) → null, bez beskonačne petlje", async () => {
      const calls = mockFetch([{ body: { users: fiftyUsers() } }]);
      const svc = new Sy15AuthAdminService(noDb);
      await expect(
        svc.findUserIdByEmail("nepostojeci@servoteh.com"),
      ).resolves.toBeNull();
      expect(calls.length).toBeLessThanOrEqual(2);
    });

    it("REST: neuspešan odgovor (500) → null, bez nagađanja", async () => {
      mockFetch([{ body: "boom", status: 500 }]);
      const svc = new Sy15AuthAdminService(noDb);
      await expect(svc.findUserIdByEmail(TARGET)).resolves.toBeNull();
    });

    it("DB je merodavna: SELECT po lower(email) nad auth.users, bez GoTrue poziva", async () => {
      let sql = "";
      const queryRaw = jest.fn((strings: TemplateStringsArray) => {
        sql = strings.join("?");
        return Promise.resolve([{ id: TARGET_ID }]);
      });
      const calls = mockFetch([{ body: {} }]);

      const svc = new Sy15AuthAdminService(dbWith(queryRaw));
      await expect(svc.findUserIdByEmail(TARGET)).resolves.toBe(TARGET_ID);

      expect(calls).toHaveLength(0);
      expect(sql).toContain("auth.users");
      expect(sql).toContain("lower(email)");
    });

    it("DB kaže da naloga nema → null (ne pada na REST, pa ne nagađa)", async () => {
      const queryRaw = jest.fn(() => Promise.resolve([]));
      const calls = mockFetch([{ body: { users: fiftyUsers() } }]);
      const svc = new Sy15AuthAdminService(dbWith(queryRaw));
      await expect(svc.findUserIdByEmail(TARGET)).resolves.toBeNull();
      expect(calls).toHaveLength(0);
    });

    it("DB nedostupna → fallback na REST (i dalje TAČNO poklapanje)", async () => {
      const queryRaw = jest.fn(() => Promise.reject(new Error("no db")));
      mockFetch([{ body: { users: fiftyUsers() } }]);
      const svc = new Sy15AuthAdminService(dbWith(queryRaw));
      await expect(svc.findUserIdByEmail(TARGET)).resolves.toBe(TARGET_ID);
    });

    it("DB vrati više redova za isti mejl → null (ne bira nasumično)", async () => {
      const queryRaw = jest.fn(() =>
        Promise.resolve([{ id: "id-a" }, { id: "id-b" }]),
      );
      const svc = new Sy15AuthAdminService(dbWith(queryRaw));
      await expect(svc.findUserIdByEmail(TARGET)).resolves.toBeNull();
    });

    it("prazan email → null bez ijednog poziva", async () => {
      const calls = mockFetch([{ body: {} }]);
      const svc = new Sy15AuthAdminService(noDb);
      await expect(svc.findUserIdByEmail("   ")).resolves.toBeNull();
      expect(calls).toHaveLength(0);
    });
  });

  // ==================== resetPassword ====================

  describe("resetPassword (pojas i tregeri)", () => {
    it("nalog nosi DRUGI mejl → baca i NE poziva PUT", async () => {
      const calls = mockFetch([{ body: { id: OTHER_ID, email: OTHER_EMAIL } }]);
      const svc = new Sy15AuthAdminService(noDb);

      await expect(
        svc.resetPassword(OTHER_ID, "novaLozinka1", TARGET),
      ).rejects.toBeInstanceOf(BadGatewayException);

      expect(calls).toHaveLength(1); // samo GET provere
      expect(calls.some((c) => c.method === "PUT")).toBe(false);
    });

    it("mejl se poklapa (različit case) → PUT sa novom lozinkom", async () => {
      const calls = mockFetch([
        { body: { id: TARGET_ID, email: "Aleksandar.Stanic@Servoteh.com" } },
        { body: { id: TARGET_ID } },
      ]);
      const svc = new Sy15AuthAdminService(noDb);

      await expect(
        svc.resetPassword(TARGET_ID, "novaLozinka1", TARGET),
      ).resolves.toBeUndefined();

      const put = calls.find((c) => c.method === "PUT");
      expect(put).toBeDefined();
      expect(put?.url).toContain(TARGET_ID);
      expect(put?.body).toBe(JSON.stringify({ password: "novaLozinka1" }));
    });

    it("nalog nije čitljiv (404 na GET) → baca, bez PUT-a", async () => {
      const calls = mockFetch([{ body: "not found", status: 404 }]);
      const svc = new Sy15AuthAdminService(noDb);
      await expect(
        svc.resetPassword(TARGET_ID, "novaLozinka1", TARGET),
      ).rejects.toBeInstanceOf(BadGatewayException);
      expect(calls.some((c) => c.method === "PUT")).toBe(false);
    });

    it("prazan expectedEmail → baca pre ijednog mrežnog poziva", async () => {
      const calls = mockFetch([{ body: {} }]);
      const svc = new Sy15AuthAdminService(noDb);
      await expect(
        svc.resetPassword(TARGET_ID, "novaLozinka1", ""),
      ).rejects.toBeInstanceOf(BadGatewayException);
      expect(calls).toHaveLength(0);
    });
  });

  // ==================== createUser (idempotentna grana) ====================

  describe("createUser — 422/already fallback", () => {
    it("postojeći nalog se vraća SAMO uz potvrđen mejl", async () => {
      mockFetch([
        { body: "User already registered", status: 422 }, // POST create
        { body: { users: fiftyUsers() } }, // rezolucija (REST listing)
        { body: { id: TARGET_ID, email: TARGET } }, // potvrda naloga
      ]);
      const svc = new Sy15AuthAdminService(noDb);
      await expect(
        svc.createUser({ email: TARGET, password: "p" }),
      ).resolves.toEqual({ id: TARGET_ID, created: false });
    });

    it("rezolvisan nalog nosi tuđ mejl → baca (ne vraća tuđ id)", async () => {
      const queryRaw = jest.fn(() => Promise.resolve([{ id: OTHER_ID }]));
      mockFetch([
        { body: "User already registered", status: 422 }, // POST create
        { body: { id: OTHER_ID, email: OTHER_EMAIL } }, // potvrda → neusklađen mejl
      ]);
      const svc = new Sy15AuthAdminService(dbWith(queryRaw));
      await expect(
        svc.createUser({ email: TARGET, password: "p" }),
      ).rejects.toBeInstanceOf(BadGatewayException);
    });
  });
});
