import { KadrovskaService } from "./kadrovska.service";
import {
  buildVacationPeriods,
  isoDay,
  phaseOf,
  VACATION_PERIOD_STATUSES,
} from "./vacation-periods";

/**
 * GO periodi „od–do" (zahtev vlasnika 30.07.2026): na kartici zaposlenog mora da
 * se vidi od kad do kad ima planiran/odobren odmor, kao JEDAN raspon po zahtevu.
 *
 * Kontrolni primer sa žive baze: Jerotić Milorad ima JEDAN odobren zahtev
 * 04.08.–17.08.2026. (10 radnih dana), a u gridu 10 pojedinačnih dana koje
 * vikendi seku na 04–07.08 / 10–14.08 / 17.08. Prikaz sme da bude 1, ne 3.
 */
describe("GO periodi (vacation-periods)", () => {
  const EMP = "8748dc24-8336-4fbd-b32b-46222ad9725a";
  const EMP2 = "22222222-2222-4222-8222-222222222222";
  const DANAS = "2026-07-30";

  const zahtev = (o: Partial<Parameters<typeof buildVacationPeriods>[0]["requests"][number]> = {}) => ({
    id: "r1",
    employeeId: EMP,
    dateFrom: "2026-08-04",
    dateTo: "2026-08-17",
    daysCount: 10,
    status: "approved",
    ...o,
  });

  // ── grupisanje: jedan zahtev = jedan raspon ────────────────────────────────

  it("odobren zahtev daje JEDAN raspon 04.08–17.08 (ne tri isečka po vikendima)", () => {
    const out = buildVacationPeriods({ requests: [zahtev()], today: DANAS });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      employeeId: EMP,
      dateFrom: "2026-08-04",
      dateTo: "2026-08-17",
      daysCount: 10,
      status: "approved",
      approved: true,
      phase: "planiran",
      source: "zahtev",
    });
  });

  it("više zahteva se vraća sortirano po datumu početka", () => {
    const out = buildVacationPeriods({
      requests: [
        zahtev({ id: "b", dateFrom: "2026-08-04", dateTo: "2026-08-17" }),
        zahtev({ id: "a", dateFrom: "2026-02-10", dateTo: "2026-02-14" }),
        zahtev({ id: "c", dateFrom: "2026-12-24", dateTo: "2026-12-31" }),
      ],
      today: DANAS,
    });
    expect(out.map((p) => p.id)).toEqual(["a", "b", "c"]);
  });

  // ── razlikovanje statusa ──────────────────────────────────────────────────

  it("razlikuje odobreno od dvostepenog međukoraka i od zahteva na čekanju", () => {
    const out = buildVacationPeriods({
      requests: [
        zahtev({ id: "p", status: "pending", dateFrom: "2026-09-01", dateTo: "2026-09-05" }),
        zahtev({ id: "s", status: "sef_approved", dateFrom: "2026-10-01", dateTo: "2026-10-05" }),
        zahtev({ id: "a", status: "approved", dateFrom: "2026-08-04", dateTo: "2026-08-17" }),
      ],
      today: DANAS,
    });
    expect(out.map((p) => [p.id, p.status, p.approved])).toEqual([
      ["a", "approved", true],
      ["p", "pending", false],
      ["s", "sef_approved", false],
    ]);
  });

  it("sef_approved OSTAJE u prikazu (inače nestaje čovek kome zahtev čeka HR)", () => {
    expect(VACATION_PERIOD_STATUSES.has("sef_approved")).toBe(true);
  });

  it("odbijen i otkazan zahtev se NE prikazuju kao odmor", () => {
    const out = buildVacationPeriods({
      requests: [
        zahtev({ id: "r", status: "rejected" }),
        zahtev({ id: "c", status: "canceled" }),
      ],
      today: DANAS,
    });
    expect(out).toEqual([]);
  });

  // ── faza po datumima, ne po statusu ───────────────────────────────────────

  it("faza se izvodi iz datuma (planiran / u toku / iskorišćeno)", () => {
    expect(phaseOf("2026-08-04", "2026-08-17", DANAS)).toBe("planiran");
    expect(phaseOf("2026-07-27", "2026-08-03", DANAS)).toBe("u_toku");
    expect(phaseOf("2026-06-01", "2026-06-10", DANAS)).toBe("iskorisceno");
    // Granice su uključive.
    expect(phaseOf(DANAS, DANAS, DANAS)).toBe("u_toku");
  });

  // ── evidencija kao dopuna ─────────────────────────────────────────────────

  it("evidencija bez zahteva ulazi označena kao `evidencija`", () => {
    const out = buildVacationPeriods({
      requests: [],
      absences: [
        { id: "a1", employeeId: EMP2, dateFrom: "2026-05-04", dateTo: "2026-05-08", daysCount: 5 },
      ],
      today: DANAS,
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      source: "evidencija",
      status: "approved",
      approved: true,
      phase: "iskorisceno",
    });
  });

  it("evidencija koja pokriva isti odmor kao zahtev se NE duplira", () => {
    const out = buildVacationPeriods({
      requests: [zahtev()],
      absences: [
        // ogledalo istog odobrenog zahteva (hr_vacreq_approve)
        { id: "a1", employeeId: EMP, dateFrom: "2026-08-04", dateTo: "2026-08-17", daysCount: 10 },
      ],
      today: DANAS,
    });
    expect(out).toHaveLength(1);
    expect(out[0].source).toBe("zahtev");
  });

  it("evidencija DRUGOG zaposlenog u istom terminu se ne guta", () => {
    const out = buildVacationPeriods({
      requests: [zahtev()],
      absences: [
        { id: "a1", employeeId: EMP2, dateFrom: "2026-08-04", dateTo: "2026-08-17", daysCount: 10 },
      ],
      today: DANAS,
    });
    expect(out).toHaveLength(2);
    expect(out.map((p) => p.source).sort()).toEqual(["evidencija", "zahtev"]);
  });

  // ── prazan slučaj / rubovi ────────────────────────────────────────────────

  it("bez zahteva i bez evidencije vraća praznu listu", () => {
    expect(buildVacationPeriods({ requests: [], absences: [], today: DANAS })).toEqual([]);
    expect(buildVacationPeriods({ requests: [], today: DANAS })).toEqual([]);
  });

  it("Prisma Date (@db.Date, UTC ponoć) se normalizuje u YYYY-MM-DD", () => {
    expect(isoDay(new Date("2026-08-04T00:00:00.000Z"))).toBe("2026-08-04");
    expect(isoDay("2026-08-04T00:00:00.000Z")).toBe("2026-08-04");
    expect(isoDay(null)).toBe("");
    const out = buildVacationPeriods({
      requests: [
        zahtev({
          dateFrom: new Date("2026-08-04T00:00:00.000Z"),
          dateTo: new Date("2026-08-17T00:00:00.000Z"),
        }),
      ],
      today: DANAS,
    });
    expect(out[0]).toMatchObject({ dateFrom: "2026-08-04", dateTo: "2026-08-17" });
  });

  it("daysCount = null (absences dozvoljava NULL) ne pravi NaN", () => {
    const out = buildVacationPeriods({
      requests: [],
      absences: [
        { id: "a1", employeeId: EMP, dateFrom: "2026-05-04", dateTo: "2026-05-08", daysCount: null },
      ],
      today: DANAS,
    });
    expect(out[0].daysCount).toBe(0);
  });
});

/**
 * Servisni sloj: opseg redova (AUDIT-K2 obrazac) — RLS `vr_select` NIJE scope,
 * pa `?employeeId=` sme samo da SUZI, nikad da probije opseg.
 */
describe("KadrovskaService.vacationPeriods — opseg", () => {
  const EMAIL = "sef@servoteh.com";
  const SELF = "11111111-1111-4111-8111-111111111111";
  const TUDJI = "22222222-2222-4222-8222-222222222222";

  const mk = (scopeIds: string[]) => {
    const seen: Record<string, unknown>[] = [];
    const model = {
      findMany: jest.fn(async (args: Record<string, unknown>) => {
        seen.push(args);
        return [];
      }),
    };
    const tx = {
      $queryRaw: jest.fn(async () => scopeIds.map((id) => ({ id }))),
      vacationRequest: model,
      absence: model,
    };
    const sy15 = {
      withUserRls: jest.fn(async (_e: string, fn: (t: unknown) => unknown) => fn(tx)),
    };
    return { seen, tx, svc: new KadrovskaService(sy15 as never) };
  };

  it("bez employeeId čita samo zaposlene iz opsega", async () => {
    const { seen, svc } = mk([SELF]);
    await svc.vacationPeriods(EMAIL, { year: 2026 } as never);
    expect((seen[0].where as Record<string, unknown>).employeeId).toEqual({ in: [SELF] });
  });

  it("?employeeId van opsega daje PRESEK = prazno (ne probija opseg)", async () => {
    const { seen, svc } = mk([SELF]);
    const res = await svc.vacationPeriods(EMAIL, {
      year: 2026,
      employeeId: TUDJI,
    } as never);
    // Prazan presek → ne ide se ni u upit.
    expect(seen).toHaveLength(0);
    expect(res.data).toEqual([]);
  });

  it("čita samo GO iz evidencije i preskače arhivirano", async () => {
    const { seen, svc } = mk([SELF]);
    await svc.vacationPeriods(EMAIL, { year: 2026 } as never);
    const absWhere = seen[1].where as Record<string, unknown>;
    expect(absWhere.type).toBe("godisnji");
    expect(absWhere.archivedAt).toBeNull();
  });
});
