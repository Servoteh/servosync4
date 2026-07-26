import { UnprocessableEntityException } from "@nestjs/common";
import { MojProfilService } from "./moj-profil.service";

/**
 * AUDIT-K4 (26.07) — poslovna pravila koja su ispala u seobi 1.0 → 3.0.
 * Sve provere stoje na SERVERU: forma ih ponavlja radi UX-a, ali mobilni/REST
 * klijent ih ne sme zaobići.
 */
describe("Moj profil AUDIT-K4 — paritet poslovnih pravila", () => {
  const EMAIL = "u@servoteh.com";
  const SELF = "11111111-1111-4111-8111-111111111111";

  type SqlLike = { strings?: readonly string[]; values?: unknown[] };
  const txt = (s: SqlLike) =>
    Array.isArray(s?.strings) ? s.strings.join("?") : String(s);

  const mkSvc = () => {
    const calls: SqlLike[] = [];
    const tx = {
      $queryRaw: jest.fn(async (sql: SqlLike) => {
        calls.push(sql);
        const t = txt(sql);
        if (t.includes("current_user_manages_employee")) return [{ ok: true }];
        if (t.includes("generate_series")) return [{ n: BigInt(2) }];
        if (t.includes("INSERT INTO")) return [{ id: "x1" }];
        return [{ id: SELF }];
      }),
      $executeRaw: jest.fn().mockResolvedValue(1),
    };
    const sy15 = {
      withUserRls: jest.fn(async (_e: string, fn: (t: unknown) => unknown) => fn(tx)),
      runIdempotentRls: jest.fn(
        async (_e: unknown, _c: unknown, _a: unknown, fn: (t: unknown) => unknown) => ({
          idempotent: false,
          result: await fn(tx),
        }),
      ),
    };
    const svc = new MojProfilService(sy15 as never, {
      enabled: false,
      dispatchKadr: jest.fn(),
    } as never);
    return { svc, tx, calls };
  };

  const makeup = (over: Record<string, unknown>) => ({
    clientEventId: "c1",
    absenceDate: "2026-08-04", // utorak
    absenceHours: 8,
    reason: "razlog",
    makeupPlan: "plan",
    compensationType: "nadoknada",
    ...over,
  });

  // ── „Dan odmora" = +1 dan GO: mora biti vikend i ≥8h ─────────────────────

  it("dan_odmora za RADNI dan se odbija (1.0: mora subota ili nedelja)", async () => {
    const { svc } = mkSvc();
    await expect(
      svc.submitMakeup(
        EMAIL,
        makeup({
          compensationType: "dan_odmora",
          weekendWorkDate: "2026-08-04", // utorak
        }) as never,
      ),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it("dan_odmora sa manje od 8h se odbija (inače +1 dan GO bez pokrića)", async () => {
    const { svc } = mkSvc();
    await expect(
      svc.submitMakeup(
        EMAIL,
        makeup({
          compensationType: "dan_odmora",
          weekendWorkDate: "2026-08-08", // subota
          absenceHours: 0.5,
        }) as never,
      ),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it("dan_odmora subotom sa 8h prolazi", async () => {
    const { svc, calls } = mkSvc();
    await svc.submitMakeup(
      EMAIL,
      makeup({
        compensationType: "dan_odmora",
        weekendWorkDate: "2026-08-08", // subota
        absenceHours: 8,
      }) as never,
    );
    expect(calls.some((c) => txt(c).includes("INSERT INTO makeup_requests"))).toBe(
      true,
    );
  });

  // ── Razlog i predlog nadoknade su obavezni (1.0 paritet) ────────────────

  it("nadoknada bez razloga se odbija", async () => {
    const { svc } = mkSvc();
    await expect(
      svc.submitMakeup(EMAIL, makeup({ reason: "  " }) as never),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it("nadoknada bez predloga nadoknade se odbija", async () => {
    const { svc } = mkSvc();
    await expect(
      svc.submitMakeup(EMAIL, makeup({ makeupPlan: "" }) as never),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  // ── Plaćeno odsustvo: dane računa SERVER (bez vikenda i praznika) ────────

  it("days_count za plaćeno odsustvo se računa na serveru, ne uzima sa klijenta", async () => {
    const { svc, calls } = mkSvc();
    await svc.submitPaidLeave(EMAIL, {
      clientEventId: "c2",
      leaveType: "smrt_uze",
      dateFrom: "2026-08-03",
      dateTo: "2026-08-07",
      daysCount: 999, // klijent laže — mora se ignorisati
    } as never);

    // Upit koji izuzima vikende i praznike je izvršen…
    const gs = calls.find((c) => txt(c).includes("generate_series"));
    expect(gs).toBeTruthy();
    expect(txt(gs!)).toContain("kadr_holidays");
    expect(txt(gs!)).toContain("ISODOW");
    // …a u INSERT je otišla SERVERSKA vrednost (2 iz mock-a), ne 999.
    const ins = calls.find((c) => txt(c).includes("INSERT INTO paid_leave_requests"));
    expect(ins).toBeTruthy();
    expect(ins!.values).toContain(2);
    expect(ins!.values).not.toContain(999);
  });
});
