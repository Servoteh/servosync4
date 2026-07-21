import { ConflictException, ForbiddenException } from "@nestjs/common";
import { KadrovskaMutationsService } from "./kadrovska-mutations.service";

/**
 * R2 WRITE PATH GUARD (MODULE_SPEC_kadrovska_30.md §5 t.48/51, doktrina A.2a/A4).
 * Dokazuje da SVE mutacije Kadrovske idu kroz `withUserRls`/`runIdempotentRls`
 * (RLS + GUC), NIKAD kroz `this.sy15.db` (BYPASSRLS) — inače bi PII/zarade write
 * politike bile zaobiđene. Plus: idempotencija (create=obavezan clientEventId),
 * optimistic-lock → 409, SQLSTATE 42501 → 403.
 */
describe("Kadrovska R2 mutacije — write-path guard + idempotencija", () => {
  const EMAIL = "test@servoteh.com";
  const UUID = "3b241101-e2bb-4255-8caf-4136c566a962";

  let dbAccessed = false;
  let withUserRls: jest.Mock;
  let runIdempotentRls: jest.Mock;
  let mailSend: jest.Mock;
  let service: KadrovskaMutationsService;

  const modelStub = {
    create: jest.fn().mockResolvedValue({ id: UUID }),
    update: jest.fn().mockResolvedValue({ id: UUID }),
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
    findFirst: jest.fn().mockResolvedValue(null),
    findUnique: jest.fn().mockResolvedValue({ updatedAt: new Date() }),
    findMany: jest.fn().mockResolvedValue([]),
  };
  const mkTx = () =>
    new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === "$queryRaw")
            return jest.fn().mockResolvedValue([{ v: { applied: true } }]);
          if (prop === "$executeRaw") return jest.fn().mockResolvedValue(1);
          return modelStub;
        },
      },
    );

  beforeEach(() => {
    dbAccessed = false;
    withUserRls = jest.fn(
      async (_e: string, fn: (tx: unknown) => Promise<unknown>) => fn(mkTx()),
    );
    runIdempotentRls = jest.fn(
      async (_e, _cid, _a, fn: (tx: unknown) => Promise<unknown>) => ({
        idempotent: false,
        result: await fn(mkTx()),
      }),
    );
    const sy15 = {
      withUserRls,
      runIdempotentRls,
      withUser: jest.fn(),
      runIdempotent: jest.fn(),
    } as Record<string, unknown>;
    Object.defineProperty(sy15, "db", {
      get() {
        dbAccessed = true;
        throw new Error(
          "PII LEAK: this.sy15.db (BYPASSRLS) dodirnut u write putanji",
        );
      },
    });
    const storage = {
      upload: jest.fn(),
      signUrl: jest.fn(),
      remove: jest.fn(),
    };
    mailSend = jest.fn().mockResolvedValue(true);
    const mail = { configured: true, send: mailSend };
    service = new KadrovskaMutationsService(
      sy15 as never,
      storage as never,
      mail as never,
    );
  });

  it("kreiranje (create) ide kroz runIdempotentRls sa clientEventId + email", async () => {
    await service.createAbsence(EMAIL, {
      clientEventId: UUID,
      employeeId: UUID,
      type: "godisnji",
      dateFrom: "2026-07-01",
      dateTo: "2026-07-05",
    });
    expect(runIdempotentRls).toHaveBeenCalledTimes(1);
    expect(runIdempotentRls.mock.calls[0][0]).toBe(EMAIL);
    expect(runIdempotentRls.mock.calls[0][1]).toBe(UUID);
    expect(withUserRls).not.toHaveBeenCalled();
    expect(dbAccessed).toBe(false);
  });

  it("odluka bez clientEventId → withUserRls; sa clientEventId → runIdempotentRls", async () => {
    await service.vacationApprove(EMAIL, UUID, {});
    expect(withUserRls).toHaveBeenCalledTimes(1);
    expect(runIdempotentRls).not.toHaveBeenCalled();

    withUserRls.mockClear();
    await service.vacationApprove(EMAIL, UUID, { clientEventId: UUID });
    expect(runIdempotentRls).toHaveBeenCalledTimes(1);
    expect(withUserRls).not.toHaveBeenCalled();
  });

  it("nijedna mutacija ne dodiruje this.sy15.db (BYPASSRLS sentinel)", async () => {
    await Promise.allSettled([
      service.submitVacation(EMAIL, {
        clientEventId: UUID,
        year: 2026,
        dateFrom: "2026-07-01",
        dateTo: "2026-07-02",
        daysCount: 2,
      }),
      service.vacationReject(EMAIL, UUID, { note: "x" }),
      service.gridBatch(EMAIL, {
        rows: [{ employeeId: UUID, workDate: "2026-07-01", hours: 8 }],
      }),
      service.gridSetGo(EMAIL, {
        employeeId: UUID,
        dateFrom: "2026-07-01",
        dateTo: "2026-07-02",
      }),
      service.createEmployee(EMAIL, {
        clientEventId: UUID,
        fullName: "X",
        workType: "ugovor",
      }),
      service.createChild(EMAIL, UUID, {
        clientEventId: UUID,
        firstName: "A",
      }),
      service.createBankCard(EMAIL, UUID, {
        clientEventId: UUID,
        bank: "B",
      }),
      service.createMedical(EMAIL, UUID, {
        clientEventId: UUID,
        examDate: "2026-07-01",
        examType: "sistematski",
      }),
      service.createSalaryTerm(EMAIL, {
        clientEventId: UUID,
        employeeId: UUID,
        salaryType: "ugovor",
        effectiveFrom: "2026-07-01",
      }),
      service.payrollInit(EMAIL, { year: 2026, month: 7 }),
      service.updateNotificationConfig(EMAIL, { enabled: true }),
      service.triggerWeeklyRisk(EMAIL),
    ]);
    expect(dbAccessed).toBe(false);
  });

  it("gridSetGo/gridUnsetGo: sy15 backstop — can_edit_kadrovska_grid()=false → 403, RPC se NE zove", async () => {
    const queryRaw = jest.fn().mockResolvedValueOnce([{ v: false }]); // samo assert
    withUserRls = jest.fn(async (_e, fn: (tx: unknown) => Promise<unknown>) =>
      fn(
        new Proxy(
          {},
          {
            get(_t, prop) {
              if (prop === "$queryRaw") return queryRaw;
              return modelStub;
            },
          },
        ),
      ),
    );
    (
      service as unknown as { sy15: { withUserRls: unknown } }
    ).sy15.withUserRls = withUserRls;
    await expect(
      service.gridSetGo(EMAIL, {
        employeeId: UUID,
        dateFrom: "2026-07-01",
        dateTo: "2026-07-02",
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(queryRaw).toHaveBeenCalledTimes(1); // RPC posle assert-a NIJE pozvan
  });

  it("gridSetGo: allowlist=true → assert pa RPC u ISTOJ tx (2 upita)", async () => {
    const queryRaw = jest
      .fn()
      .mockResolvedValueOnce([{ v: true }]) // assert
      .mockResolvedValueOnce([{ v: 3 }]); // kadr_grid_set_go
    withUserRls = jest.fn(async (_e, fn: (tx: unknown) => Promise<unknown>) =>
      fn(
        new Proxy(
          {},
          {
            get(_t, prop) {
              if (prop === "$queryRaw") return queryRaw;
              return modelStub;
            },
          },
        ),
      ),
    );
    (
      service as unknown as { sy15: { withUserRls: unknown } }
    ).sy15.withUserRls = withUserRls;
    await service.gridSetGo(EMAIL, {
      employeeId: UUID,
      dateFrom: "2026-07-01",
      dateTo: "2026-07-02",
    });
    expect(queryRaw).toHaveBeenCalledTimes(2);
  });

  it("optimistic-lock: {applied:false, reason:'stale'} → 409 Conflict", async () => {
    withUserRls = jest.fn(async (_e, fn: (tx: unknown) => Promise<unknown>) =>
      fn(
        new Proxy(
          {},
          {
            get(_t, prop) {
              if (prop === "$queryRaw")
                return jest
                  .fn()
                  .mockResolvedValue([
                    { v: { applied: false, reason: "stale" } },
                  ]);
              return modelStub;
            },
          },
        ),
      ),
    );
    (
      service as unknown as { sy15: { withUserRls: unknown } }
    ).sy15.withUserRls = withUserRls;
    await expect(
      service.updateEmployee(EMAIL, UUID, { patch: { note: "x" } }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("SQLSTATE 42501 (RLS/DEFINER guard) → 403 Forbidden", async () => {
    const err = Object.assign(new Error("permission_denied"), {
      code: "42501",
    });
    (
      service as unknown as { sy15: { withUserRls: unknown } }
    ).sy15.withUserRls = jest.fn().mockRejectedValue(err);
    await expect(
      service.vacationApprove(EMAIL, UUID, {}),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("submitVacation ZA TUĐEG (nije moj tim): current_user_manages_employee=false → 403, BEZ insert-a (IDOR guard)", async () => {
    const create = jest.fn();
    const queryRaw = jest
      .fn()
      .mockResolvedValueOnce([{ v: "self-emp-id" }]) // current_user_employee_id (self)
      .mockResolvedValueOnce([{ ok: false }]); // current_user_manages_employee(tudji)=false
    const tx = new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === "$queryRaw") return queryRaw;
          if (prop === "vacationRequest") return { create };
          return modelStub;
        },
      },
    );
    (
      service as unknown as {
        sy15: { runIdempotentRls: unknown };
      }
    ).sy15.runIdempotentRls = jest.fn(
      async (_e, _cid, _a, fn: (t: unknown) => Promise<unknown>) => ({
        idempotent: false,
        result: await fn(tx),
      }),
    );
    await expect(
      service.submitVacation(EMAIL, {
        clientEventId: UUID,
        year: 2026,
        dateFrom: "2026-08-01",
        dateTo: "2026-08-05",
        daysCount: 5,
        employeeId: "11111111-1111-1111-1111-111111111111", // ≠ self
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(create).not.toHaveBeenCalled(); // insert se NIKAD ne desi
  });

  // ── Review #24: raise_* odluka o zaradi vezana za tip 'godisnji' ──────────
  it("createTalk: raise_* upisani samo za 'godisnji'; za drugi tip forsiran null", async () => {
    const created: Record<string, unknown>[] = [];
    const tx = new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === "employeeTalk")
            return {
              create: jest.fn(
                async (a: { data: Record<string, unknown> }) => (
                  created.push(a.data),
                  { id: UUID }
                ),
              ),
            };
          if (prop === "$executeRaw") return jest.fn().mockResolvedValue(1);
          return modelStub;
        },
      },
    );
    (
      service as unknown as { sy15: { runIdempotentRls: unknown } }
    ).sy15.runIdempotentRls = jest.fn(
      async (_e, _c, _a, fn: (t: unknown) => Promise<unknown>) => ({
        idempotent: false,
        result: await fn(tx),
      }),
    );
    await service.createTalk(EMAIL, {
      clientEventId: UUID,
      employeeId: UUID,
      talkType: "jedan_na_jedan",
      raiseDecision: "da",
      raisePercent: 5,
      raiseEffectiveFrom: "2026-08-01",
      raiseNote: "x",
    });
    expect(created[0]).toMatchObject({
      raiseDecision: null,
      raisePercent: null,
      raiseEffectiveFrom: null,
      raiseNote: null,
    });
    await service.createTalk(EMAIL, {
      clientEventId: UUID,
      employeeId: UUID,
      talkType: "godisnji",
      raiseDecision: "da",
      raisePercent: 5,
    });
    expect(created[1]).toMatchObject({ raiseDecision: "da", raisePercent: 5 });
  });

  it("updateTalk: promena tipa sa 'godisnji' na drugi FORSIRA raise_* na null (efektivni tip)", async () => {
    const updates: Record<string, unknown>[] = [];
    const tx = new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === "employeeTalk")
            return {
              findUnique: jest.fn().mockResolvedValue({ talkType: "godisnji" }),
              updateMany: jest.fn(
                async (a: { data: Record<string, unknown> }) => (
                  updates.push(a.data),
                  { count: 1 }
                ),
              ),
            };
          return modelStub;
        },
      },
    );
    (
      service as unknown as { sy15: { withUserRls: unknown } }
    ).sy15.withUserRls = jest.fn(
      async (_e: string, fn: (t: unknown) => Promise<unknown>) => fn(tx),
    );
    // Menja tip u 'korektivni' bez slanja raise ključeva → sve 4 kolone eksplicitno null.
    await service.updateTalk(EMAIL, UUID, { talkType: "korektivni" });
    expect(updates[0]).toMatchObject({
      raiseDecision: null,
      raisePercent: null,
      raiseEffectiveFrom: null,
      raiseNote: null,
    });
  });

  // ── Review #23: prazan ciklus — rani return, bez rezime mejla kreatoru ────
  it("assessmentInvite: prazan ciklus vraća 'Ciklus nema procena' i NE šalje mejl", async () => {
    const tx = new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === "assessmentCycle")
            return {
              findUnique: jest.fn().mockResolvedValue({
                title: "C",
                periodLabel: "2026",
                createdBy: "boss@x.com",
              }),
            };
          if (prop === "assessment")
            return { findMany: jest.fn().mockResolvedValue([]) };
          if (prop === "$queryRaw") return jest.fn().mockResolvedValue([]);
          return modelStub;
        },
      },
    );
    (
      service as unknown as { sy15: { withUserRls: unknown } }
    ).sy15.withUserRls = jest.fn(
      async (_e: string, fn: (t: unknown) => Promise<unknown>) => fn(tx),
    );
    const res = await service.assessmentInvite(EMAIL, { cycleId: UUID });
    expect(res).toEqual({
      data: { ok: true, sent: 0, skipped: [], message: "Ciklus nema procena." },
    });
    expect(mailSend).not.toHaveBeenCalled();
  });
});

/**
 * INTEGRACIONI TESTOVI payroll recompute→engine WIRING (adversarni review R2).
 * Zlatni testovi engine-a su izolovani i NISU uhvatili dva CRITICAL bug-a u wiring-u:
 *  #1 mapTerm bez `amount` fallbacka → fiksni zaposleni (unet kroz kadr_set_contract_salary:
 *     amount=neto, fixed_amount=0) dobija platu 0;
 *  #2 fond dvostruko oduzima neplaceno → potplaćivanje.
 * Ovi testovi voze CELU putanju recompute (grid→terms→engine) na mokovanoj sy15 tx.
 */
describe("payrollRecompute — integracija (mapTerm/fond wiring, novac)", () => {
  const EMAIL = "admin@servoteh.com";
  const EMP = "3b241101-e2bb-4255-8caf-4136c566a962";

  function makeService(tx: unknown) {
    const sy15 = {
      withUserRls: jest.fn(
        async (_e: string, fn: (t: unknown) => Promise<unknown>) => fn(tx),
      ),
      runIdempotentRls: jest.fn(),
      withUser: jest.fn(),
      runIdempotent: jest.fn(),
    } as Record<string, unknown>;
    Object.defineProperty(sy15, "db", {
      get() {
        throw new Error("BYPASSRLS dodirnut u recompute");
      },
    });
    const storage = {
      upload: jest.fn(),
      signUrl: jest.fn(),
      remove: jest.fn(),
    };
    const mail = { configured: true, send: jest.fn().mockResolvedValue(true) };
    return new KadrovskaMutationsService(
      sy15 as never,
      storage as never,
      mail as never,
    );
  }

  // tx sa: bez praznika, jedan zaposleni, zadatim work_hours + term redom.
  // $queryRaw redosled u recompute: (1) salary_payroll (postojeći) → [], (2) salary_terms → [term].
  function makeTx(opts: {
    workType?: string;
    workHours: Array<Record<string, unknown>>;
    term: Record<string, unknown>;
  }) {
    return {
      kadrHoliday: { findMany: jest.fn().mockResolvedValue([]) },
      employee: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: EMP,
            workType: opts.workType ?? "ugovor",
            hireDate: null,
            fullName: "Test Radnik",
          },
        ]),
      },
      workHours: { findMany: jest.fn().mockResolvedValue(opts.workHours) },
      salaryPayroll: { findFirst: jest.fn().mockResolvedValue(null) },
      $queryRaw: jest
        .fn()
        .mockResolvedValueOnce([]) // postojeći salary_payroll red
        .mockResolvedValueOnce([opts.term]), // salary_terms
    };
  }

  function weekdaysInMonth(y: number, m: number): number {
    const last = new Date(y, m, 0).getDate();
    let c = 0;
    for (let d = 1; d <= last; d++) {
      const dow = new Date(y, m - 1, d).getDay();
      if (dow !== 0 && dow !== 6) c++;
    }
    return c;
  }
  function firstNWeekdayUtcDates(y: number, m: number, n: number): Date[] {
    const out: Date[] = [];
    const last = new Date(y, m, 0).getDate();
    for (let d = 1; d <= last && out.length < n; d++) {
      const dow = new Date(y, m - 1, d).getDay();
      if (dow !== 0 && dow !== 6) out.push(new Date(Date.UTC(y, m - 1, d)));
    }
    return out;
  }

  it("#1 fiksno sa amount=70000 / fixed_amount=0 → ukupna_zarada 70000 (NE 0)", async () => {
    // kadr_set_contract_salary INSERT-uje fiksno OVAKO: amount=neto, fixed_amount=0.
    const tx = makeTx({
      workHours: [],
      term: {
        salary_type: "ugovor",
        compensation_model: "fiksno",
        fixed_amount: 0,
        amount: 70000,
        hourly_rate: 0,
      },
    });
    const svc = makeService(tx);
    const out = (await svc.payrollRecompute(EMAIL, {
      year: 2026,
      month: 7,
    })) as {
      data: {
        rows: Array<{ ukupna_zarada: number; compensation_model: string }>;
      };
    };
    expect(out.data.rows[0].compensation_model).toBe("fiksno");
    expect(out.data.rows[0].ukupna_zarada).toBe(70000);
  });

  it("#1 satnica sa amount=600 (salary_type=satnica) → hourly=600 (NE 0)", async () => {
    // 160h redovnih × 600 = 96000. hourly izvire iz `amount` kad je salary_type='satnica'.
    const y = 2026;
    const m = 7;
    // 20 radnih dana × 8h; koristimo prvih 20 weekday-a sa 8h.
    const days = firstNWeekdayUtcDates(y, m, 20).map((wd) => ({
      workDate: wd,
      hours: 8,
      overtimeHours: 0,
      twoMachineHours: 0,
      fieldHours: 0,
      absenceCode: null,
      absenceSubtype: null,
    }));
    const tx = makeTx({
      workHours: days,
      term: {
        salary_type: "satnica",
        compensation_model: "satnica",
        amount: 600,
        hourly_rate: 0,
        hourly_transport_amount: 0,
      },
    });
    const svc = makeService(tx);
    const out = (await svc.payrollRecompute(EMAIL, { year: y, month: m })) as {
      data: { rows: Array<{ ukupna_zarada: number }> };
    };
    expect(out.data.rows[0].ukupna_zarada).toBe(20 * 8 * 600);
  });

  it("CRITICAL #2: recompute persist PRENOSI advance_paid_on/final_paid_on (RPC ih bez ključa briše)", async () => {
    const y = 2026;
    const m = 7;
    const captured: Array<{ values: unknown[] }> = [];
    const tx = {
      kadrHoliday: { findMany: jest.fn().mockResolvedValue([]) },
      employee: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            { id: EMP, workType: "ugovor", hireDate: null, fullName: "Test" },
          ]),
      },
      workHours: { findMany: jest.fn().mockResolvedValue([]) },
      $queryRaw: jest
        .fn()
        // (1) postojeći salary_payroll red — sa datumima isplate
        .mockResolvedValueOnce([
          {
            id: EMP,
            status: "u_obradi",
            advance_amount: 0,
            domestic_days: 0,
            foreign_days: 0,
            apo: "2026-07-10",
            fpo: "2026-08-05",
            u: "2026-07-31 10:00:00+00",
          },
        ])
        // (2) salary_terms
        .mockResolvedValueOnce([
          {
            salary_type: "ugovor",
            compensation_model: "fiksno",
            fixed_amount: 100000,
            amount: 0,
          },
        ])
        // (3) hr_upsert_salary_payroll — uhvati JSON row
        .mockImplementationOnce((sql: { values: unknown[] }) => {
          captured.push(sql);
          return Promise.resolve([{ v: { applied: true } }]);
        }),
    };
    const svc = makeService(tx);
    await svc.payrollRecompute(EMAIL, {
      year: y,
      month: m,
      employeeId: EMP,
      persist: true,
    });
    expect(captured).toHaveLength(1);
    const row = JSON.parse(String(captured[0].values[0])) as Record<
      string,
      unknown
    >;
    expect(row.advance_paid_on).toBe("2026-07-10");
    expect(row.final_paid_on).toBe("2026-08-05");
    expect(row.expected_updated_at).toBe("2026-07-31 10:00:00+00");
  });

  it("CRITICAL #2: payrollLock šalje postojeće advance_paid_on/final_paid_on u p_row", async () => {
    const captured: Array<{ values: unknown[] }> = [];
    const tx = {
      $queryRaw: jest
        .fn()
        .mockResolvedValueOnce([
          {
            u: "2026-07-31 10:00:00.123456+00",
            apo: "2026-07-10",
            fpo: "2026-08-05",
          },
        ])
        .mockImplementationOnce((sql: { values: unknown[] }) => {
          captured.push(sql);
          return Promise.resolve([{ v: { applied: true } }]);
        }),
    };
    const svc = makeService(tx);
    await svc.payrollLock(EMAIL, EMP, {
      expectedUpdatedAt: "2026-07-31T10:00:00.123Z",
    });
    const row = JSON.parse(String(captured[0].values[0])) as Record<
      string,
      unknown
    >;
    expect(row.status).toBe("paid");
    expect(row.advance_paid_on).toBe("2026-07-10");
    expect(row.final_paid_on).toBe("2026-08-05");
    // µs token usklađen (ms-jednak → puna DB vrednost).
    expect(row.expected_updated_at).toBe("2026-07-31 10:00:00.123456+00");
  });

  it("HIGH #5: ručni payrollUpsert K3.3 reda ubacuje SVEŽU ukupna_zarada (trigger short-circuit fix)", async () => {
    const y = 2026;
    const m = 7;
    const captured: Array<{ values: unknown[] }> = [];
    const tx = {
      kadrHoliday: { findMany: jest.fn().mockResolvedValue([]) },
      employee: {
        findFirst: jest
          .fn()
          .mockResolvedValue({ workType: "ugovor", hireDate: null }),
      },
      workHours: { findMany: jest.fn().mockResolvedValue([]) },
      $queryRaw: jest
        .fn()
        // (1) postojeći red po id
        .mockResolvedValueOnce([
          {
            employee_id: EMP,
            period_year: y,
            period_month: m,
            status: "u_obradi",
            advance_amount: 20000,
            domestic_days: 0,
            foreign_days: 0,
            transport_rsd: 0,
            per_diem_rsd: 0,
            per_diem_eur: 0,
            apo: null,
            fpo: null,
            u: "2026-07-31 10:00:00+00",
          },
        ])
        // (2) salary_terms (K3.3 fiksno)
        .mockResolvedValueOnce([
          {
            salary_type: "ugovor",
            compensation_model: "fiksno",
            fixed_amount: 100000,
            amount: 0,
          },
        ])
        // (3) RPC — uhvati row
        .mockImplementationOnce((sql: { values: unknown[] }) => {
          captured.push(sql);
          return Promise.resolve([{ v: { applied: true } }]);
        }),
    };
    const svc = makeService(tx);
    await svc.payrollUpsert(EMAIL, {
      row: {
        id: EMP,
        expected_updated_at: "2026-07-31T10:00:00.000Z",
        advance_amount: 20000,
      },
    });
    const row = JSON.parse(String(captured[0].values[0])) as Record<
      string,
      unknown
    >;
    // Fiksno 100000, bez neplaćenih → sveža ukupna_zarada 100000 (NE stara iz baze).
    expect(row.ukupna_zarada).toBe(100000);
    expect(row.compensation_model).toBe("fiksno");
    expect(row.payable_hours).toBeDefined();
    expect(row.fond_sati_meseca).toBeGreaterThan(0);
    // CRITICAL #2 (defanziva i na upsert putu): ključevi datuma prisutni (null = nema promene).
    expect("advance_paid_on" in row).toBe(true);
    expect("final_paid_on" in row).toBe(true);
  });

  it("#2 fiksno 100000 + 5 neplaćenih (22-radna meseca) → 77272.73 + fond 176 (NE 70588.24/136)", async () => {
    const y = 2026;
    let m = 0;
    for (let mm = 1; mm <= 12; mm++)
      if (weekdaysInMonth(y, mm) === 22) {
        m = mm;
        break;
      }
    expect(m).toBeGreaterThan(0); // postoji 22-radni mesec u 2026
    const npDays = firstNWeekdayUtcDates(y, m, 5).map((wd) => ({
      workDate: wd,
      hours: 0,
      overtimeHours: 0,
      twoMachineHours: 0,
      fieldHours: 0,
      absenceCode: "np",
      absenceSubtype: null,
    }));
    const tx = makeTx({
      workHours: npDays,
      term: {
        salary_type: "ugovor",
        compensation_model: "fiksno",
        fixed_amount: 100000,
        amount: 0,
      },
    });
    const svc = makeService(tx);
    const out = (await svc.payrollRecompute(EMAIL, { year: y, month: m })) as {
      data: {
        rows: Array<{ ukupna_zarada: number; fond_sati_meseca: number }>;
      };
    };
    // PUN fond (22×8=176) — NE umanjen (136); jedna proporcionalna redukcija 17/22.
    expect(out.data.rows[0].fond_sati_meseca).toBe(176);
    expect(out.data.rows[0].ukupna_zarada).toBe(77272.73);
  });
});
