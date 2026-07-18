import { KadrovskaService } from "./kadrovska.service";

/**
 * PII LEAK GUARD (MODULE_SPEC_kadrovska_30.md §5 t.48/49, doktrina A.2a) — DOKAZ da
 * CEO read sloj Kadrovske ide kroz `Sy15Service.withUserRls` (GUC + SET LOCAL ROLE
 * authenticated), a NIKAD kroz `this.sy15.db` (BYPASSRLS konekciona rola).
 *
 * Zašto je ovo kritično baš za G: PII maska (v_employees_safe /
 * current_user_can_manage_employee_pii) i zarade (admin-only) su ROW/ROLE-scoped u
 * sy15 RLS. `servosync2_app` je BYPASSRLS → `this.sy15.db.*` bi VRATIO JMBG/adresu/
 * zaradu SVAKOME. Sentinel: `db` getter baca; ako bilo koji read dodirne BYPASSRLS
 * put, ovaj test pukne. Takođe: mora `withUserRls` (RLS), NE `withUser` (samo claims).
 */
describe("Kadrovska R1 read — PII leak guard (sve kroz withUserRls, NIKAD this.sy15.db)", () => {
  const EMAIL = "test@servoteh.com";
  const UUID = "3b241101-e2bb-4255-8caf-4136c566a962";

  let dbAccessed = false;
  let withUserRls: jest.Mock;
  let withUser: jest.Mock;
  let service: KadrovskaService;

  // Stub Prisma tx: svaki model → no-op read; $queryRaw → []. Bez prave baze.
  const modelStub = {
    findMany: jest.fn().mockResolvedValue([]),
    findUnique: jest.fn().mockResolvedValue(null),
    count: jest.fn().mockResolvedValue(0),
    aggregate: jest.fn().mockResolvedValue({ _max: {} }),
  };
  const mockTx = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "$queryRaw") return jest.fn().mockResolvedValue([]);
        return modelStub;
      },
    },
  );

  beforeEach(() => {
    dbAccessed = false;
    withUserRls = jest.fn(
      async (_email: string, fn: (tx: unknown) => Promise<unknown>) =>
        fn(mockTx),
    );
    withUser = jest.fn();
    const sy15 = {
      withUserRls,
      withUser,
      runIdempotent: jest.fn(),
      runIdempotentRls: jest.fn(),
    } as Record<string, unknown>;
    // Sentinel: BYPASSRLS getter — dodir = PII leak.
    Object.defineProperty(sy15, "db", {
      get() {
        dbAccessed = true;
        throw new Error(
          "PII LEAK: this.sy15.db (BYPASSRLS) dodirnut u read putanji — koristi withUserRls",
        );
      },
    });
    service = new KadrovskaService(sy15 as never);
  });

  /** Svi R1 read pozivi (pokriva sve hub-grupe, sa naglaskom na PII + zarade). */
  const invokeAll = () =>
    Promise.allSettled([
      service.me(EMAIL),
      service.dashboard(EMAIL, {}),
      service.report(EMAIL, "medical"),
      service.notifications(EMAIL, {}),
      service.notificationConfig(EMAIL),
      service.vacationBalance(EMAIL, {}),
      service.vacationHistory(EMAIL, {}),
      service.vacationEntitlements(EMAIL, {}),
      service.requests(EMAIL, {}),
      service.absences(EMAIL, {}),
      service.absentNow(EMAIL),
      service.grid(EMAIL, {}),
      service.workHours(EMAIL, {}),
      service.attendanceNow(EMAIL),
      service.attendanceShadow(EMAIL, {}),
      service.attendanceVsGrid(EMAIL, {}),
      service.attendanceDaily(EMAIL, {}),
      service.attendanceCorrections(EMAIL, {}),
      service.attendanceExtraRecipients(EMAIL),
      // Zaposleni — PII osetljivo
      service.employees(EMAIL, {}),
      service.employee(EMAIL, UUID),
      service.employeeChildren(EMAIL, UUID),
      service.employeeBankCards(EMAIL, UUID),
      service.employeeForeignDocs(EMAIL, UUID),
      service.employeePersonalDocs(EMAIL, UUID),
      service.employeeDocuments(EMAIL, UUID),
      service.employeeMedicalExams(EMAIL, UUID),
      service.medicalExams(EMAIL, {}),
      service.certificates(EMAIL, {}),
      service.contracts(EMAIL, {}),
      service.directory(EMAIL),
      service.onboarding(EMAIL, {}),
      service.onboardingTemplates(EMAIL),
      service.devPlans(EMAIL, {}),
      service.devPlanCheckins(EMAIL, UUID),
      service.expectations(EMAIL, {}),
      service.talks(EMAIL, {}),
      service.assessments(EMAIL, {}),
      service.assessmentScope(EMAIL, UUID),
      // Zarade — admin-only
      service.salaryTerms(EMAIL, {}),
      service.salaryCurrent(EMAIL, {}),
      service.salaryPayroll(EMAIL, {}),
    ]);

  it("nijedan read NE dodiruje this.sy15.db (BYPASSRLS sentinel ostaje netaknut)", async () => {
    await invokeAll();
    expect(dbAccessed).toBe(false);
  });

  it("SVAKI read ulazi kroz withUserRls (RLS put), a NIKAD kroz withUser (samo-claims put)", async () => {
    const results = await invokeAll();
    // 42 read metoda → tačno toliko withUserRls poziva (svaki metod = 1 tx).
    expect(withUserRls.mock.calls.length).toBe(42);
    expect(withUser).not.toHaveBeenCalled();
    // Svaki withUserRls poziv ima email kao prvi argument (GUC claims → auth.uid()).
    for (const call of withUserRls.mock.calls as unknown[][]) {
      expect(call[0]).toBe(EMAIL);
    }
    // Nijedan poziv ne sme baciti PII-leak sentinel (rejected zbog db-a).
    for (const r of results) {
      if (r.status === "rejected") {
        expect(String(r.reason)).not.toContain("PII LEAK");
      }
    }
  });
});
