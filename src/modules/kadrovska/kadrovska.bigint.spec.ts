import { KadrovskaService } from "./kadrovska.service";

/**
 * BigInt → Number guard (adversarni review R1, HIGH). View count-agregati su bigint
 * (v_development_plans.goals_total/goals_done, v_kadr_audit_log.id) → Prisma vraća
 * JS BigInt → `res.json` baca „Do not know how to serialize a BigInt" = 500. Servis
 * mora da ih pretvori u Number (numify) da odgovor prežive serijalizaciju.
 */
describe("Kadrovska R1 read — BigInt view kolone → Number (nema 500)", () => {
  const EMAIL = "test@servoteh.com";

  /** sy15 mock gde $queryRaw vraća redove sa bigint kolonama (kao živi view). */
  const makeService = (rows: unknown[]) => {
    const tx = { $queryRaw: jest.fn().mockResolvedValue(rows) };
    const sy15 = {
      withUserRls: jest.fn(
        async (_e: string, fn: (t: unknown) => Promise<unknown>) => fn(tx),
      ),
    } as Record<string, unknown>;
    return new KadrovskaService(sy15 as never);
  };

  it("devPlans: goals_total/goals_done bigint → Number (JSON.stringify ne baca)", async () => {
    const svc = makeService([
      { id: "p1", goals_total: 5n, goals_done: 2n, overall_progress: "40" },
    ]);
    const out = (await svc.devPlans(EMAIL, {})) as {
      data: Array<Record<string, unknown>>;
    };
    expect(typeof out.data[0].goals_total).toBe("number");
    expect(out.data[0].goals_total).toBe(5);
    expect(out.data[0].goals_done).toBe(2);
    // Dokaz: ceo odgovor je serijalizabilan (inače 500 u res.json).
    expect(() => JSON.stringify(out)).not.toThrow();
  });

  it("report('audit'): v_kadr_audit_log.id bigint → Number", async () => {
    const svc = makeService([{ id: 1234567890123n, action: "update" }]);
    const out = (await svc.report(EMAIL, "audit")) as {
      data: Array<Record<string, unknown>>;
    };
    expect(typeof out.data[0].id).toBe("number");
    expect(out.data[0].id).toBe(1234567890123);
    expect(() => JSON.stringify(out)).not.toThrow();
  });
});
