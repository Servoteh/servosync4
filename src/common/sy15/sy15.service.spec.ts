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
      $transaction: (fn: (t: unknown) => Promise<unknown>) => fn(tx),
      $disconnect: () => Promise.resolve(),
    };
    return { svc, calls };
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

  it("withUser: BEZ SET ROLE (Reversi/Lokacije ponašanje netaknuto)", async () => {
    const { svc, calls } = makeService();
    await svc.withUser("test@servoteh.com", () => Promise.resolve(null));
    expect(calls.some((c) => c.includes("request.jwt.claims"))).toBe(true);
    expect(calls.some((c) => c.includes("SET LOCAL ROLE"))).toBe(false);
  });
});
