import { KadrovskaService } from "./kadrovska.service";
import {
  buildVacationPeriods,
  isNonWorkingDay,
  isoDay,
  mergeGridDays,
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
      // F3: ne-odobreni statusi izlaze SAMO pozivaocu sa `kadrovska.vacreq_manage`.
      includeUnapproved: true,
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
      includeUnapproved: true,
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
 * NALAZ F1 (review 30.07.2026): odmor upisan SAMO u grid (`work_hours`,
 * absence_code='go') je bio nevidljiv, a ćelija je za te ljude TVRDILA „nema
 * planiranog odmora" — iako isti red pokazuje „Iskorišćeno/Planirano" iz baš tih
 * redova (`v_vacation_balance.days_used = opening_used + grid_used`).
 *
 * Kontrolni primer sa žive baze: Dolovac Vladimir (62052ba2-…) — 12 GO dana u
 * gridu (07–08.05, 20–24.07, 27–31.07.2026), NULA zahteva i NULA odsustava.
 */
describe("GO periodi — treći izvor: grid (F1)", () => {
  const DOLOVAC = "62052ba2-6d65-4502-8829-638e9f1f6ee7";
  const DANAS = "2026-07-30";
  const dan = (employeeId: string, workDate: string) => ({ employeeId, workDate });
  /** Neradni praznici 2026. sa žive `kadr_holidays` (svi `is_workday=false`). */
  const PRAZNICI = [
    { holidayDate: "2026-01-01", isWorkday: false },
    { holidayDate: "2026-01-02", isWorkday: false },
    { holidayDate: "2026-05-01", isWorkday: false },
    { holidayDate: "2026-05-02", isWorkday: false },
    { holidayDate: "2026-11-11", isWorkday: false },
  ];

  it("GO samo u gridu daje raspon — čovek NE nestaje iz pregleda", () => {
    const out = buildVacationPeriods({
      requests: [],
      gridDays: [dan(DOLOVAC, "2026-05-07"), dan(DOLOVAC, "2026-05-08")],
      today: DANAS,
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      employeeId: DOLOVAC,
      dateFrom: "2026-05-07",
      dateTo: "2026-05-08",
      daysCount: 2,
      source: "grid",
      status: "grid",
      approved: false,
      phase: "iskorisceno",
    });
  });

  it("petak + ponedeljak = JEDAN raspon (vikend ne prekida odmor)", () => {
    // 24.07.2026 = petak, 27.07 = ponedeljak; 25–26.07 su subota/nedelja.
    const out = buildVacationPeriods({
      requests: [],
      gridDays: [
        dan(DOLOVAC, "2026-07-20"),
        dan(DOLOVAC, "2026-07-21"),
        dan(DOLOVAC, "2026-07-22"),
        dan(DOLOVAC, "2026-07-23"),
        dan(DOLOVAC, "2026-07-24"),
        dan(DOLOVAC, "2026-07-27"),
        dan(DOLOVAC, "2026-07-28"),
        dan(DOLOVAC, "2026-07-29"),
        dan(DOLOVAC, "2026-07-30"),
        dan(DOLOVAC, "2026-07-31"),
      ],
      today: DANAS,
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      dateFrom: "2026-07-20",
      dateTo: "2026-07-31",
      daysCount: 10, // broje se GO dani, ne kalendarski raspon (12)
    });
  });

  it("neradni praznik se premošćuje kao vikend (30.04 + 04.05 preko 01–03.05)", () => {
    // 30.04.2026 = četvrtak; 01.05 i 02.05 su praznici, 03.05 nedelja; 04.05 pon.
    const out = buildVacationPeriods({
      requests: [],
      gridDays: [dan(DOLOVAC, "2026-04-30"), dan(DOLOVAC, "2026-05-04")],
      holidays: PRAZNICI,
      today: DANAS,
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ dateFrom: "2026-04-30", dateTo: "2026-05-04", daysCount: 2 });
  });

  it("bez učitanih praznika radni dan između PREKIDA raspon (ne spaja se naslepo)", () => {
    const out = buildVacationPeriods({
      requests: [],
      gridDays: [dan(DOLOVAC, "2026-04-30"), dan(DOLOVAC, "2026-05-04")],
      holidays: [], // 01.05/02.05 nisu poznati kao praznici → 01.05 je petak = radni
      today: DANAS,
    });
    expect(out.map((p) => [p.dateFrom, p.dateTo])).toEqual([
      ["2026-04-30", "2026-04-30"],
      ["2026-05-04", "2026-05-04"],
    ]);
  });

  it("radna subota (is_workday=true) SEČE raspon — eksplicitan praznik > vikend", () => {
    // 2026-07-24 petak, 2026-07-25 subota (proglašena radnom), 2026-07-27 pon.
    const out = buildVacationPeriods({
      requests: [],
      gridDays: [dan(DOLOVAC, "2026-07-24"), dan(DOLOVAC, "2026-07-27")],
      holidays: [{ holidayDate: "2026-07-25", isWorkday: true }],
      today: DANAS,
    });
    expect(out).toHaveLength(2);
  });

  it("grid dani koje POKRIVA zahtev se NE emituju zasebno (Jerotić: 1 raspon, ne 3)", () => {
    // Živi kontrolni slučaj: zahtev 04.08–17.08 (10 d, approved) + ogledalo u
    // `absences` + 10 grid dana koje vikendi seku na 04–07 / 10–14 / 17.08.
    const JEROTIC = "8748dc24-8336-4fbd-b32b-46222ad9725a";
    const gridDays = [
      "2026-08-04", "2026-08-05", "2026-08-06", "2026-08-07",
      "2026-08-10", "2026-08-11", "2026-08-12", "2026-08-13", "2026-08-14",
      "2026-08-17",
    ].map((d) => dan(JEROTIC, d));
    const out = buildVacationPeriods({
      requests: [
        {
          id: "d9b06552-9f5f-475b-a92c-d9218a85866e",
          employeeId: JEROTIC,
          dateFrom: "2026-08-04",
          dateTo: "2026-08-17",
          daysCount: 10,
          status: "approved",
        },
      ],
      absences: [
        {
          id: "ba216cfd-4943-422b-8b1e-4bb7ee18d9c2",
          employeeId: JEROTIC,
          dateFrom: "2026-08-04",
          dateTo: "2026-08-17",
          daysCount: 10,
        },
      ],
      gridDays,
      today: DANAS,
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      dateFrom: "2026-08-04",
      dateTo: "2026-08-17",
      daysCount: 10,
      source: "zahtev",
      status: "approved",
    });
  });

  it("grid dani koje pokriva EVIDENCIJA (bez zahteva) se ne dupliraju", () => {
    const out = buildVacationPeriods({
      requests: [],
      absences: [
        { id: "a1", employeeId: DOLOVAC, dateFrom: "2026-05-04", dateTo: "2026-05-08", daysCount: 5 },
      ],
      gridDays: [dan(DOLOVAC, "2026-05-07"), dan(DOLOVAC, "2026-05-08")],
      today: DANAS,
    });
    expect(out).toHaveLength(1);
    expect(out[0].source).toBe("evidencija");
  });

  /**
   * ODLUKA o DELIMIČNOM pokrivanju: zahtev se NIKAD ne cepa niti duplira, ali
   * grid dani koji ISPADAJU iz njega ostaju vidljivi kao zaseban `grid` raspon.
   * Alternativa (odbaciti ceo grid raspon na prvi dodir) bi te dane tiho
   * izgubila iz prikaza, a oni i dalje ulaze u saldo („Iskorišćeno").
   */
  it("delimično pokrivanje: zahtev ostaje ceo, višak iz grida ide kao zaseban raspon", () => {
    const out = buildVacationPeriods({
      requests: [
        {
          id: "r1",
          employeeId: DOLOVAC,
          dateFrom: "2026-08-04",
          dateTo: "2026-08-07",
          daysCount: 4,
          status: "approved",
        },
      ],
      gridDays: [
        "2026-08-04", "2026-08-05", "2026-08-06", "2026-08-07",
        "2026-08-10", "2026-08-11", // 2 dana VAN zahteva (posle vikenda)
      ].map((d) => dan(DOLOVAC, d)),
      today: DANAS,
    });
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ dateFrom: "2026-08-04", dateTo: "2026-08-07", source: "zahtev" });
    expect(out[1]).toMatchObject({
      dateFrom: "2026-08-10",
      dateTo: "2026-08-11",
      daysCount: 2,
      source: "grid",
    });
  });

  it("zahtev koji seče grid na dva dela daje dva ostatka (ne premošćava se preko zahteva)", () => {
    const out = buildVacationPeriods({
      requests: [
        {
          id: "r1",
          employeeId: DOLOVAC,
          dateFrom: "2026-08-05",
          dateTo: "2026-08-06",
          daysCount: 2,
          status: "approved",
        },
      ],
      gridDays: ["2026-08-04", "2026-08-05", "2026-08-06", "2026-08-07"].map((d) =>
        dan(DOLOVAC, d),
      ),
      today: DANAS,
    });
    expect(out.map((p) => [p.source, p.dateFrom, p.dateTo])).toEqual([
      ["grid", "2026-08-04", "2026-08-04"],
      ["zahtev", "2026-08-05", "2026-08-06"],
      ["grid", "2026-08-07", "2026-08-07"],
    ]);
  });

  it("grid drugog zaposlenog se ne guta tuđim zahtevom", () => {
    const out = buildVacationPeriods({
      requests: [
        {
          id: "r1",
          employeeId: "aaaaaaaa-1111-4111-8111-111111111111",
          dateFrom: "2026-05-07",
          dateTo: "2026-05-08",
          daysCount: 2,
          status: "approved",
        },
      ],
      gridDays: [dan(DOLOVAC, "2026-05-07"), dan(DOLOVAC, "2026-05-08")],
      today: DANAS,
    });
    expect(out).toHaveLength(2);
    expect(out.map((p) => p.source).sort()).toEqual(["grid", "zahtev"]);
  });

  it("mergeGridDays: duplikati i neuređen ulaz ne prave lažne raspone", () => {
    const out = mergeGridDays(
      ["2026-07-22", "2026-07-20", "2026-07-21", "2026-07-20", ""],
      new Map(),
    );
    expect(out).toEqual([{ dateFrom: "2026-07-20", dateTo: "2026-07-22", daysCount: 3 }]);
  });

  it("isNonWorkingDay: vikend da, radni dan ne, praznik po `is_workday`", () => {
    const h = new Map<string, boolean>([
      ["2026-05-01", false], // praznik, neradni
      ["2026-07-25", true], // radna subota
    ]);
    expect(isNonWorkingDay("2026-07-25", h)).toBe(false);
    expect(isNonWorkingDay("2026-07-26", h)).toBe(true); // nedelja
    expect(isNonWorkingDay("2026-05-01", h)).toBe(true);
    expect(isNonWorkingDay("2026-07-30", h)).toBe(false); // četvrtak
  });
});

/**
 * NALAZ F3: ruta nosi klasnu `kadrovska.read`, a njen red-opseg
 * (`current_user_manages_employee`) na živoj bazi propušta SVE zaposlene roli
 * `projektant_vodja`, koja NEMA `kadrovska.vacreq_manage`. Bez ove brane bi ta
 * rola videla „ko je tražio odmor a još nije odobren" za celu firmu.
 */
describe("GO periodi — projekcija po permisiji pozivaoca (F3)", () => {
  const EMP = "8748dc24-8336-4fbd-b32b-46222ad9725a";
  const DANAS = "2026-07-30";
  const requests = [
    { id: "a", employeeId: EMP, dateFrom: "2026-08-04", dateTo: "2026-08-17", daysCount: 10, status: "approved" },
    { id: "s", employeeId: EMP, dateFrom: "2026-10-01", dateTo: "2026-10-05", daysCount: 5, status: "sef_approved" },
    { id: "p", employeeId: EMP, dateFrom: "2026-11-02", dateTo: "2026-11-06", daysCount: 5, status: "pending" },
  ];

  it("BEZ vacreq_manage: samo odobreni zahtevi (pending/sef_approved sakriveni)", () => {
    const out = buildVacationPeriods({ requests, today: DANAS, includeUnapproved: false });
    expect(out.map((p) => p.id)).toEqual(["a"]);
  });

  it("podrazumevano (bez zastavice) je UŽA projekcija — bezbedan default", () => {
    const out = buildVacationPeriods({ requests, today: DANAS });
    expect(out.map((p) => p.id)).toEqual(["a"]);
  });

  it("SA vacreq_manage: vide se i pending i sef_approved", () => {
    const out = buildVacationPeriods({ requests, today: DANAS, includeUnapproved: true });
    expect(out.map((p) => p.id)).toEqual(["a", "s", "p"]);
  });

  it("realizovan odmor (evidencija/grid) ostaje vidljiv i bez vacreq_manage", () => {
    const out = buildVacationPeriods({
      requests: [],
      absences: [{ id: "a1", employeeId: EMP, dateFrom: "2026-03-02", dateTo: "2026-03-06", daysCount: 5 }],
      gridDays: [{ employeeId: EMP, workDate: "2026-06-01" }],
      today: DANAS,
      includeUnapproved: false,
    });
    expect(out.map((p) => p.source)).toEqual(["evidencija", "grid"]);
  });
});

/**
 * Servisni sloj: opseg redova (AUDIT-K2 obrazac) — RLS `vr_select` NIJE scope,
 * pa `?employeeId=` sme samo da SUZI, nikad da probije opseg.
 */
describe("KadrovskaService.vacationPeriods — opseg", () => {
  const SELF = "11111111-1111-4111-8111-111111111111";
  const TUDJI = "22222222-2222-4222-8222-222222222222";
  /** Rola sa `kadrovska.read` ali BEZ `kadrovska.vacreq_manage` (F3). */
  const CITALAC = { userId: 7, email: "sef@servoteh.com", role: "projektant_vodja" };
  const HR = { userId: 8, email: "hr@servoteh.com", role: "hr" };

  const mk = (scopeIds: string[], override: { allow: boolean } | null = null) => {
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
      workHours: model,
      kadrHoliday: model,
    };
    const sy15 = {
      withUserRls: jest.fn(async (_e: string, fn: (t: unknown) => unknown) => fn(tx)),
    };
    // Glavna (3.0) baza — SAMO za `resolvePermissionDecision` (override lookup).
    const prisma = {
      userPermissionOverride: { findUnique: jest.fn(async () => override) },
    };
    return { seen, tx, svc: new KadrovskaService(sy15 as never, prisma as never) };
  };

  it("bez employeeId čita samo zaposlene iz opsega", async () => {
    const { seen, svc } = mk([SELF]);
    await svc.vacationPeriods(CITALAC, { year: 2026 } as never);
    expect((seen[0].where as Record<string, unknown>).employeeId).toEqual({ in: [SELF] });
  });

  it("?employeeId van opsega daje PRESEK = prazno (ne probija opseg)", async () => {
    const { seen, svc } = mk([SELF]);
    const res = await svc.vacationPeriods(CITALAC, {
      year: 2026,
      employeeId: TUDJI,
    } as never);
    // Prazan presek → ne ide se ni u upit.
    expect(seen).toHaveLength(0);
    expect(res.data).toEqual([]);
  });

  it("čita samo GO iz evidencije i preskače arhivirano", async () => {
    const { seen, svc } = mk([SELF]);
    await svc.vacationPeriods(CITALAC, { year: 2026 } as never);
    const absWhere = seen[1].where as Record<string, unknown>;
    expect(absWhere.type).toBe("godisnji");
    expect(absWhere.archivedAt).toBeNull();
  });

  it("F1: grid se čita u ISTOM opsegu zaposlenih i samo za GO dane godine", async () => {
    const { seen, svc } = mk([SELF]);
    await svc.vacationPeriods(CITALAC, { year: 2026 } as never);
    const whWhere = seen[2].where as Record<string, unknown>;
    expect(whWhere.employeeId).toEqual({ in: [SELF] }); // opseg se NE proširuje
    expect(whWhere.absenceCode).toBe("go");
    expect(whWhere.workDate).toEqual({
      gte: new Date("2026-01-01T00:00:00Z"),
      lte: new Date("2026-12-31T00:00:00Z"),
    });
  });

  it("F3: pozivalac BEZ vacreq_manage ne dobija ne-odobrene zahteve ni iz baze", async () => {
    const { seen, svc } = mk([SELF]);
    await svc.vacationPeriods(CITALAC, { year: 2026 } as never);
    expect((seen[0].where as Record<string, unknown>).status).toEqual({
      in: ["approved"],
    });
  });

  it("F3: pozivalac SA vacreq_manage dobija i pending/sef_approved", async () => {
    const { seen, svc } = mk([SELF]);
    await svc.vacationPeriods(HR, { year: 2026 } as never);
    expect((seen[0].where as Record<string, unknown>).status).toEqual({
      in: ["pending", "sef_approved", "approved"],
    });
  });

  it("F3: deny override obara `vacreq_manage` i roli koja ga inače ima", async () => {
    // `resolvePermissionDecision` čita override sveže iz baze (deny > grant > rola).
    const { seen, svc } = mk([SELF], { allow: false });
    await svc.vacationPeriods(HR, { year: 2026 } as never);
    expect((seen[0].where as Record<string, unknown>).status).toEqual({
      in: ["approved"],
    });
  });

  it("F3: grant override otvara ne-odobrene roli koja permisiju nema", async () => {
    const { seen, svc } = mk([SELF], { allow: true });
    await svc.vacationPeriods(CITALAC, { year: 2026 } as never);
    expect((seen[0].where as Record<string, unknown>).status).toEqual({
      in: ["pending", "sef_approved", "approved"],
    });
  });
});
