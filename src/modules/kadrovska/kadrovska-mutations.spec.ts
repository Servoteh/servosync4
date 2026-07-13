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
    withUserRls = jest.fn(async (_e: string, fn: (tx: unknown) => Promise<unknown>) =>
      fn(mkTx()),
    );
    runIdempotentRls = jest.fn(async (_e, _cid, _a, fn: (tx: unknown) => Promise<unknown>) => ({
      idempotent: false,
      result: await fn(mkTx()),
    }));
    const sy15 = {
      withUserRls,
      runIdempotentRls,
      withUser: jest.fn(),
      runIdempotent: jest.fn(),
    } as Record<string, unknown>;
    Object.defineProperty(sy15, "db", {
      get() {
        dbAccessed = true;
        throw new Error("PII LEAK: this.sy15.db (BYPASSRLS) dodirnut u write putanji");
      },
    });
    const storage = { upload: jest.fn(), signUrl: jest.fn(), remove: jest.fn() };
    service = new KadrovskaMutationsService(sy15 as never, storage as never);
  });

  it("kreiranje (create) ide kroz runIdempotentRls sa clientEventId + email", async () => {
    await service.createAbsence(EMAIL, {
      clientEventId: UUID,
      employeeId: UUID,
      type: "godisnji",
      dateFrom: "2026-07-01",
      dateTo: "2026-07-05",
    } as never);
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
      service.submitVacation(EMAIL, { clientEventId: UUID, year: 2026, dateFrom: "2026-07-01", dateTo: "2026-07-02", daysCount: 2 } as never),
      service.vacationReject(EMAIL, UUID, { note: "x" }),
      service.gridBatch(EMAIL, { rows: [{ employeeId: UUID, workDate: "2026-07-01", hours: 8 }] } as never),
      service.gridSetGo(EMAIL, { employeeId: UUID, dateFrom: "2026-07-01", dateTo: "2026-07-02" }),
      service.createEmployee(EMAIL, { clientEventId: UUID, fullName: "X", workType: "ugovor" } as never),
      service.createChild(EMAIL, UUID, { clientEventId: UUID, firstName: "A" } as never),
      service.createBankCard(EMAIL, UUID, { clientEventId: UUID, bank: "B" } as never),
      service.createMedical(EMAIL, UUID, { clientEventId: UUID, examDate: "2026-07-01", examType: "sistematski" } as never),
      service.createSalaryTerm(EMAIL, { clientEventId: UUID, employeeId: UUID, salaryType: "ugovor", effectiveFrom: "2026-07-01" } as never),
      service.payrollInit(EMAIL, { year: 2026, month: 7 }),
      service.updateNotificationConfig(EMAIL, { enabled: true }),
      service.triggerWeeklyRisk(EMAIL),
    ]);
    expect(dbAccessed).toBe(false);
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
                  .mockResolvedValue([{ v: { applied: false, reason: "stale" } }]);
              return modelStub;
            },
          },
        ),
      ),
    );
    (service as unknown as { sy15: { withUserRls: unknown } }).sy15.withUserRls = withUserRls;
    await expect(
      service.updateEmployee(EMAIL, UUID, { patch: { note: "x" } }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("SQLSTATE 42501 (RLS/DEFINER guard) → 403 Forbidden", async () => {
    const err = Object.assign(new Error("permission_denied"), { code: "42501" });
    (service as unknown as { sy15: { withUserRls: unknown } }).sy15.withUserRls = jest
      .fn()
      .mockRejectedValue(err);
    await expect(service.vacationApprove(EMAIL, UUID, {})).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });
});
