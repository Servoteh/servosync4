import { UnprocessableEntityException } from "@nestjs/common";
import { MojProfilService } from "./moj-profil.service";

/**
 * ZAHTEV 028/26 — „GO: pogrešan prikaz raspoloživih dana" + zakucavanje serverskih brana.
 *
 * Živi slučaj koji je otkrio bug (27.07): Zoran (saldo 41) podnosi godišnji ZA Lazara.
 * Lazar 2026: days_total 20, days_carried_over 3, opening_used 6, grid_used 2 →
 * kalendarski `days_remaining` = 20 + 3 − 6 − 2 = 15, a `days_remaining_accrued`
 * (stečeno do jula) = 7. Forma je pisala 41 (saldo PODNOSIOCA), a server je propuštao:
 *  - validirao je klijentski `daysCount` (DTO ga pušta 0–366) umesto svog broja,
 *  - kad reda u `v_vacation_balance` nema, tiho je propuštao (fail-open),
 *  - kapa se merila nad saldom ciljanog zaposlenog samo ako red postoji.
 *
 * Ovi testovi pinuju serversko ponašanje; FE deo (saldo izabranog člana + accrued
 * prikaz) je u `frontend/src/app/profil/_components/vacation-section.tsx`.
 */
describe("Moj profil — ZAHTEV 028/26 (GO brane na serveru)", () => {
  const EMAIL = "zoran@servoteh.com";
  const CID = "3b241101-e2bb-4255-8caf-4136c566a962";
  const ZORAN = "11111111-1111-4111-8111-111111111111"; // podnosilac (saldo 41)
  const LAZAR = "22222222-2222-4222-8222-222222222222"; // član tima (saldo 15 / 7)

  type SqlLike = { strings?: readonly string[]; values?: unknown[] };
  const txt = (s: SqlLike) =>
    Array.isArray(s?.strings) ? s.strings.join("?") : String(s);

  /** Saldo po zaposlenom — `v_vacation_balance` red (kalendarski + accrued). */
  const BALANCES: Record<string, Record<string, unknown> | undefined> = {
    [ZORAN]: {
      days_total: 26,
      days_carried_over: 15,
      days_used: 0,
      days_remaining: 41,
      days_remaining_accrued: 41,
    },
    [LAZAR]: {
      days_total: 20,
      days_carried_over: 3,
      days_used: 8, // opening_used 6 + grid_used 2
      days_remaining: 15,
      days_remaining_accrued: 7,
    },
  };

  /**
   * @param opts.workDays   broj radnih dana koji server izbroji (bez vikenda/praznika)
   * @param opts.weekdays   Pon–Pet u istom rasponu (ono što FE forma prikaže)
   * @param opts.balances   override mape salda (npr. brisanje reda → fail-closed test)
   * @param opts.manages    da li pozivalac upravlja ciljanim zaposlenim
   */
  const mkSvc = (
    opts: {
      workDays?: number;
      weekdays?: number;
      balances?: Record<string, Record<string, unknown> | undefined>;
      manages?: boolean;
    } = {},
  ) => {
    const workDays = opts.workDays ?? 16;
    const weekdays = opts.weekdays ?? workDays;
    const balances = opts.balances ?? BALANCES;
    const calls: SqlLike[] = [];
    const tx = {
      $queryRaw: jest.fn(async (sql: SqlLike) => {
        calls.push(sql);
        const t = txt(sql);
        if (t.includes("v_employees_safe")) return [{ id: ZORAN }];
        if (t.includes("current_user_manages_employee"))
          return [{ ok: opts.manages ?? true }];
        if (t.includes("generate_series"))
          return [{ n: BigInt(workDays), weekdays: BigInt(weekdays) }];
        if (t.includes("v_vacation_balance")) {
          const emp = (sql.values ?? []).find(
            (v): v is string => typeof v === "string" && v in balances,
          );
          const row = emp ? balances[emp] : undefined;
          return row ? [row] : [];
        }
        if (t.includes("INSERT INTO vacation_requests")) return [{ id: "req1" }];
        return []; // overlap: nema aktivnog zahteva
      }),
      $executeRaw: jest.fn().mockResolvedValue(1),
    };
    const sy15 = {
      withUserRls: jest.fn(async (_e: string, fn: (t: unknown) => unknown) => fn(tx)),
      runIdempotentRls: jest.fn(
        async (
          _e: unknown,
          _c: unknown,
          _a: unknown,
          fn: (t: unknown) => unknown,
        ) => ({ idempotent: false, result: await fn(tx) }),
      ),
    };
    const svc = new MojProfilService(sy15 as never, {
      enabled: false,
      dispatchKadr: jest.fn(),
    } as never);
    return { svc, tx, calls };
  };

  /** 16 radnih dana: 03.08.2026 (pon) – 24.08.2026 (pon), bez praznika. */
  const dto = (over: Record<string, unknown> = {}) => ({
    clientEventId: CID,
    dateFrom: "2026-08-03",
    dateTo: "2026-08-24",
    daysCount: 16,
    ...over,
  });

  const insertOf = (calls: SqlLike[]) =>
    calls.find((c) => txt(c).includes("INSERT INTO vacation_requests"));

  // ── 1. Kapa nad saldom ciljanog zaposlenog ────────────────────────────────

  it("16 dana za Lazara (preostalo 15) pada — kapa je kalendarski saldo", async () => {
    const { svc, calls } = mkSvc({ workDays: 16 });
    await expect(
      svc.submitVacation(EMAIL, dto({ employeeId: LAZAR }) as never),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(insertOf(calls)).toBeUndefined();
  });

  it("poruka 422 nudi i STEČENO do danas (accrued 7), pored kalendarskih 15", async () => {
    const { svc } = mkSvc({ workDays: 16 });
    await expect(
      svc.submitVacation(EMAIL, dto({ employeeId: LAZAR }) as never),
    ).rejects.toThrow(/preostali saldo \(15\)[\s\S]*ste[čc]eno 7 dana/i);
  });

  it("15 dana za Lazara prolazi — avans preko accrued (7) NIJE blokada", async () => {
    const { svc, calls } = mkSvc({ workDays: 15 });
    await svc.submitVacation(
      EMAIL,
      dto({ employeeId: LAZAR, daysCount: 15 }) as never,
    );
    expect(insertOf(calls)).toBeTruthy();
  });

  // ── 2. Saldo se meri nad ČLANOM, ne nad podnosiocem ───────────────────────

  it("podnosilac sa 41 danom NE može da progura 16 dana za člana (saldo 15)", async () => {
    const { svc, calls } = mkSvc({ workDays: 16 });
    await expect(
      svc.submitVacation(EMAIL, dto({ employeeId: LAZAR }) as never),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    // Saldo je čitan za LAZARA (ciljanog), nikad za podnosioca.
    const balCall = calls.find((c) => txt(c).includes("v_vacation_balance"));
    expect(balCall?.values).toContain(LAZAR);
    expect(balCall?.values).not.toContain(ZORAN);
  });

  it("istih 16 dana ZA SEBE (Zoran, saldo 41) prolazi — dokaz da je razlika u saldu člana", async () => {
    const { svc, calls } = mkSvc({ workDays: 16 });
    await svc.submitVacation(EMAIL, dto() as never);
    expect(insertOf(calls)).toBeTruthy();
  });

  // ── 3. FAIL-CLOSED: nema reda fonda → 422 (ranije se tiho propuštalo) ─────

  it("bez reda u v_vacation_balance zahtev PADA (fail-closed), bez INSERT-a", async () => {
    const { svc, calls } = mkSvc({
      workDays: 5,
      balances: { [ZORAN]: undefined, [LAZAR]: undefined },
    });
    await expect(
      svc.submitVacation(EMAIL, dto({ daysCount: 5 }) as never),
    ).rejects.toThrow(/nema evidencije|ne postoji evidencija/i);
    expect(insertOf(calls)).toBeUndefined();
  });

  // ── 4. days_count računa SERVER, ne klijent ───────────────────────────────

  it("u INSERT ide SERVERSKI broj dana (praznik odbijen), ne klijentski", async () => {
    // 10 kalendarskih Pon–Pet, ali jedan je državni praznik → 9 dana troši fond.
    const { svc, calls } = mkSvc({ workDays: 9, weekdays: 10 });
    await svc.submitVacation(EMAIL, dto({ daysCount: 10 }) as never);
    const ins = insertOf(calls);
    expect(ins?.values).toContain(9);
    expect(ins?.values).not.toContain(10);
  });

  it("klijent koji laže o broju dana (1 za 16-dnevni period) → 422", async () => {
    const { svc, calls } = mkSvc({ workDays: 16 });
    await expect(
      svc.submitVacation(EMAIL, dto({ daysCount: 1 }) as never),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(insertOf(calls)).toBeUndefined();
  });

  it("period bez ijednog radnog dana (vikend) → 422", async () => {
    const { svc, calls } = mkSvc({ workDays: 0, weekdays: 0 });
    await expect(
      svc.submitVacation(
        EMAIL,
        dto({ dateFrom: "2026-08-08", dateTo: "2026-08-09", daysCount: 0 }) as never,
      ),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(insertOf(calls)).toBeUndefined();
  });

  it("praznici se traže iz kadr_holidays u istom upitu kao vikendi (grid kanon)", async () => {
    const { svc, calls } = mkSvc({ workDays: 5 });
    await svc.submitVacation(EMAIL, dto({ daysCount: 5 }) as never);
    const gs = calls.find((c) => txt(c).includes("generate_series"));
    expect(gs).toBeTruthy();
    expect(txt(gs!)).toContain("kadr_holidays");
    expect(txt(gs!)).toContain("ISODOW");
  });
});
