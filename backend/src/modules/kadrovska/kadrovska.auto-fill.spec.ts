import { KadrovskaService } from "./kadrovska.service";
import type { Sy15Service } from "../../common/sy15/sy15.service";

/**
 * Auto-unos iz kapije (kucanje → grid) — READ-ONLY predlozi. Poravnat sa noćnim
 * auto-tikom (deli `proposeHoursForDay`) posle zahteva 044/26. Pinuje:
 * (1) SQL bira SAMO PRAZNE dane (grid_covered=false, absence NULL, teren=0,
 *     open_intervals=0, ulaz+izlaz) iz v_attendance_vs_grid — BEZ uskog opsega
 *     prisustva u SQL-u (opseg + predlog sati računa JS = izvor istine);
 * (2) VIKEND SA čistim kucanjem se PREDLAŽE kao redovni (D1, 044/26 — više se ne
 *     izbacuje); skraćena smena se seče NANIŽE na pola sata (D2);
 * (3) NERADNI PRAZNIK od 01.08.2026 NEMA poseban tretman — i delimično kucanje je
 *     predlog (O-1 je uklonio zamku „upis sati pojede 8h", O-4 + presuda vlasnika traže
 *     evidenciju); ovaj put zato više ne čita kadr_holidays;
 * (4) KLAMP na JUČE — dan koji još traje se NIKAD ne predlaže (isto kao noćni tik);
 * (5) izlaz = hours (predlog) + kontekst (presenceHours/firstIn/lastOut) za pregled;
 * (6) sve kroz withUserRls (RLS), NIKAD this.sy15.db (BYPASSRLS) — auto ne sme da
 *     probije PII/row-scope.
 */
type SqlLike = { strings: string[]; values: unknown[] };
const firstSql = (m: jest.Mock): SqlLike =>
  (m.mock.calls as unknown[][])[0]?.[0] as SqlLike;
const sqlText = (m: jest.Mock): string => firstSql(m).strings.join(" ? ");

/** Praznik u fixture-u: string = pravi NERADNI praznik; objekat = eksplicitan is_workday. */
type HolidayFixture = string | { date: string; isWorkday: boolean };

/** kadr_holidays redovi iz fixture-a, uz poštovanje `where.isWorkday` filtera. */
function holidayRowsFor(
  fixtures: HolidayFixture[] | undefined,
  wantIsWorkday: boolean | undefined,
): { holidayDate: Date }[] {
  return (fixtures ?? [])
    .map((h) => (typeof h === "string" ? { date: h, isWorkday: false } : h))
    .filter((h) => wantIsWorkday === undefined || h.isWorkday === wantIsWorkday)
    .map((h) => ({ holidayDate: new Date(`${h.date}T00:00:00Z`) }));
}

/** „Danas"/„juče" u pogonskoj zoni — nezavisan izračun (ne uvozi se iz servisa). */
function belgradeDay(offset: number): string {
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Belgrade",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}

function makeSvc(opts: {
  vsGridRows?: Record<string, unknown>[];
  holidays?: HolidayFixture[];
}) {
  const queryRaw = jest.fn().mockResolvedValue(opts.vsGridRows ?? []);
  let dbAccessed = false;
  // Mock POŠTUJE `where.isWorkday` — inače bi test „radna subota" prošao lažno.
  const holidayFindMany = jest
    .fn()
    .mockImplementation((args?: { where?: { isWorkday?: boolean } }) =>
      Promise.resolve(holidayRowsFor(opts.holidays, args?.where?.isWorkday)),
    );
  const tx = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "$queryRaw") return queryRaw;
        if (prop === "kadrHoliday") return { findMany: holidayFindMany };
        return { findMany: jest.fn().mockResolvedValue([]) };
      },
    },
  );
  const sy15 = {
    withUserRls: jest.fn(
      async (_e: string, fn: (t: unknown) => Promise<unknown>) => fn(tx),
    ),
  } as Record<string, unknown>;
  Object.defineProperty(sy15, "db", {
    get() {
      dbAccessed = true;
      throw new Error(
        "PII LEAK: this.sy15.db dodirnut u auto-fill read putanji",
      );
    },
  });
  const svc = new KadrovskaService(sy15 as unknown as Sy15Service, {} as never);
  return { svc, queryRaw, holidayFindMany, dbAccessed: () => dbAccessed };
}

/** Predlozi iz odgovora (kraće u testovima). */
async function suggestionsOf(
  svc: KadrovskaService,
  q: { year: number; month: number },
): Promise<Record<string, unknown>[]> {
  const out = await svc.gridAutoFillSuggestions("hr@x", q);
  return (out.data as { suggestions: Record<string, unknown>[] }).suggestions;
}

// v_attendance_vs_grid red — samo kolone koje servis čita.
function vsRow(day: string, over: Partial<Record<string, unknown>> = {}) {
  return {
    employee_id: "3b241101-e2bb-4255-8caf-4136c566a962",
    full_name: "Test Radnik",
    day: new Date(`${day}T00:00:00Z`),
    presence_hours: 8.0,
    first_in: new Date(`${day}T07:00:00Z`),
    last_out: new Date(`${day}T15:00:00Z`),
    ...over,
  };
}

describe("KadrovskaService.gridAutoFillSuggestions (kapija → grid predlozi)", () => {
  it("SQL bira SAMO prazne dane iz v_attendance_vs_grid — BEZ uskog opsega prisustva", async () => {
    const { svc, queryRaw } = makeSvc({ vsGridRows: [] });
    await svc.gridAutoFillSuggestions("hr@x", { year: 2026, month: 7 });
    const t = sqlText(queryRaw);
    expect(t).toContain("FROM v_attendance_vs_grid");
    expect(t).toContain("grid_covered = false");
    expect(t).toContain("absence_code IS NULL");
    expect(t).toContain("COALESCE(v.grid_field_hours, 0) = 0");
    expect(t).toContain("open_intervals = 0");
    expect(t).toContain("first_in IS NOT NULL");
    expect(t).toContain("last_out IS NOT NULL");
    // Zamena dana (31.07.2026): dan sa odobrenim 'dan_odmora' zahtevom se NE predlaže
    // (+1 dan GO umesto plaćenih sati — nikad oboje; isti filter kao noćni tik).
    expect(t).toContain("FROM makeup_requests");
    expect(t).toContain("'dan_odmora'");
    expect(t).toContain("COALESCE(mr.weekend_work_date, mr.absence_date) = v.day");
    // opseg prisustva se više NE zida u SQL (računa ga proposeHoursFromPresence u JS-u);
    // parametri su samo granice meseca.
    expect(firstSql(queryRaw).values).toEqual(
      expect.arrayContaining(["2026-07-01", "2026-08-01"]),
    );
    expect(firstSql(queryRaw).values).not.toContain(7.6);
    expect(firstSql(queryRaw).values).not.toContain(8.4);
  });

  it("regularan radni dan (uto 2026-07-07) → predlog hours=8 + kontekst za pregled", async () => {
    const { svc, dbAccessed } = makeSvc({
      vsGridRows: [vsRow("2026-07-07", { presence_hours: 8.1 })],
    });
    const out = await svc.gridAutoFillSuggestions("hr@x", {
      year: 2026,
      month: 7,
    });
    const s = (out.data as { suggestions: Record<string, unknown>[] })
      .suggestions;
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({
      workDate: "2026-07-07",
      hours: 8,
      presenceHours: 8.1,
    });
    expect(s[0].firstIn).toContain("2026-07-07");
    expect(dbAccessed()).toBe(false); // NIKAD BYPASSRLS
  });

  it("vikend (subota 2026-07-25) SA kucanjem → PREDLAŽE se kao redovni (D1, 044/26)", async () => {
    // Duško: subota 08:00–14:31 = 6.52h → predlog 6.5h (D1 vikend + D2 floor).
    const { svc } = makeSvc({
      vsGridRows: [vsRow("2026-07-25", { presence_hours: 6.52 })],
    });
    const out = await svc.gridAutoFillSuggestions("hr@x", {
      year: 2026,
      month: 7,
    });
    const s = (out.data as { suggestions: Record<string, unknown>[] })
      .suggestions;
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ workDate: "2026-07-25", hours: 6.5 });
  });

  it("NERADNI praznik + PUN dan (8.0h) → PREDLAŽE se kao 8", async () => {
    const { svc, holidayFindMany } = makeSvc({
      vsGridRows: [vsRow("2026-07-07")], // default presence 8.0 → hours 8
      holidays: ["2026-07-07"],
    });
    const s = await suggestionsOf(svc, { year: 2026, month: 7 });
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ workDate: "2026-07-07", hours: 8 });
    expect(holidayFindMany).not.toHaveBeenCalled(); // kalendar praznika nije potreban
  });

  it("NERADNI praznik + DELIMIČNO kucanje (2.5h) → SADA JESTE predlog (2.5), poravnato sa tikom", async () => {
    // Kapija ukinuta 01.08.2026: posle O-1 obračun sate DODAJE na 8h plaćenog praznika
    // (ne zamenjuje ih), pa se evidencija „ko je dodatno radio za praznik" beleži
    // automatski (O-4 + presuda vlasnika); kontrolu radi kadrovska mesečno.
    const { svc, holidayFindMany } = makeSvc({
      vsGridRows: [vsRow("2026-07-07", { presence_hours: 2.5 })],
      holidays: ["2026-07-07"],
    });
    const s = await suggestionsOf(svc, { year: 2026, month: 7 });
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ workDate: "2026-07-07", hours: 2.5 });
    expect(holidayFindMany).not.toHaveBeenCalled();
  });

  it("neradni praznik + 8.2h → i dalje 8 (kapa na pun dan, nepromenjeno)", async () => {
    const { svc } = makeSvc({
      vsGridRows: [vsRow("2026-07-07", { presence_hours: 8.2 })],
      holidays: ["2026-07-07"],
    });
    const s = await suggestionsOf(svc, { year: 2026, month: 7 });
    expect(s[0]).toMatchObject({ hours: 8 });
  });

  it("kadr_holidays sa is_workday=TRUE (radna subota) → običan dan (6.52h → 6.5)", async () => {
    const { svc } = makeSvc({
      vsGridRows: [vsRow("2026-07-25", { presence_hours: 6.52 })], // subota
      holidays: [{ date: "2026-07-25", isWorkday: true }],
    });
    const s = await suggestionsOf(svc, { year: 2026, month: 7 });
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ workDate: "2026-07-25", hours: 6.5 });
  });

  it("pokriven dan / dan sa odsustvom se NIKAD ne predlaže (SQL filter, i na praznik)", async () => {
    // Predlozi su READ-ONLY, ali brana je ista kao kod tika: kandidatski SQL izbacuje
    // grid_covered=true i absence_code IS NOT NULL, pa takav dan ne stigne do predloga.
    const { svc, queryRaw } = makeSvc({ vsGridRows: [] });
    await svc.gridAutoFillSuggestions("hr@x", { year: 2026, month: 7 });
    const t = sqlText(queryRaw);
    expect(t).toContain("grid_covered = false");
    expect(t).toContain("absence_code IS NULL");
  });

  it("skraćena smena (6.75h) → predlog sečen NANIŽE na 6.5 (D2), NE 8h", async () => {
    const { svc } = makeSvc({
      vsGridRows: [vsRow("2026-07-07", { presence_hours: 6.75 })],
    });
    const out = await svc.gridAutoFillSuggestions("hr@x", {
      year: 2026,
      month: 7,
    });
    const s = (out.data as { suggestions: Record<string, unknown>[] })
      .suggestions;
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ hours: 6.5, presenceHours: 6.75 });
  });

  it("van opsega prisustva (0.5h) → NIJE predlog (proposeHoursFromPresence → null)", async () => {
    const { svc } = makeSvc({
      vsGridRows: [vsRow("2026-07-07", { presence_hours: 0.5 })],
    });
    const out = await svc.gridAutoFillSuggestions("hr@x", {
      year: 2026,
      month: 7,
    });
    expect((out.data as { suggestions: unknown[] }).suggestions).toHaveLength(
      0,
    );
  });

  it("KLAMP: DANAS (dan koji još traje) NIJE predlog, JUČE jeste — isto kao noćni tik", async () => {
    // Ranije je uski SQL opseg (7.6–8.4h) slučajno držao tekući dan napolju; posle
    // 044/26 bi čovek koji je ušao u 08:00 i izašao u 10:00 bio predložen sa 2h.
    const today = belgradeDay(0);
    const yesterday = belgradeDay(-1);
    const [y, m] = yesterday.split("-").map(Number);
    const { svc, queryRaw } = makeSvc({
      vsGridRows: [
        vsRow(yesterday, { presence_hours: 8.0 }),
        vsRow(today, { presence_hours: 2.0 }), // dan u toku (izlaz zatvoren, ali nije kraj)
      ],
    });
    const s = await suggestionsOf(svc, { year: y, month: m });
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ workDate: yesterday, hours: 8 });
    // gornja granica ide i u SQL (indeksni raspon), ne samo u JS
    expect(firstSql(queryRaw).values).toContain(yesterday);
    expect(sqlText(queryRaw)).toContain("day <=");
  });

  it("employeeId suženje ide u SQL (::uuid) kad je zadat", async () => {
    const { svc, queryRaw } = makeSvc({ vsGridRows: [] });
    await svc.gridAutoFillSuggestions("hr@x", {
      year: 2026,
      month: 7,
      employeeId: "3b241101-e2bb-4255-8caf-4136c566a962",
    });
    expect(sqlText(queryRaw)).toContain("employee_id =");
  });

  it("decembar → sledeća godina u gornjoj granici raspona (bez off-by-one)", async () => {
    const { svc, queryRaw } = makeSvc({ vsGridRows: [] });
    await svc.gridAutoFillSuggestions("hr@x", { year: 2026, month: 12 });
    expect(firstSql(queryRaw).values).toEqual(
      expect.arrayContaining(["2026-12-01", "2027-01-01"]),
    );
  });
});
