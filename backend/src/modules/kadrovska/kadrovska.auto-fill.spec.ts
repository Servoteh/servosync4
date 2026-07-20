import { KadrovskaService } from "./kadrovska.service";
import type { Sy15Service } from "../../common/sy15/sy15.service";

/**
 * Auto-unos iz kapije (kucanje → grid) — READ-ONLY predlozi (odluka Nenad 20.07:
 * regular ~8h ±tol / dugme+pregled / SAMO prazni dani; Nikola verifikuje). Pinuje:
 * (1) SQL bira SAMO regularne PRAZNE dane (grid_covered=false, absence NULL, teren=0,
 *     open_intervals=0, ulaz+izlaz, prisustvo u opsegu) iz v_attendance_vs_grid;
 * (2) JS izbacuje vikend I praznike (holSet iz baze); (3) izlaz = hours=8 + kontekst
 *     (presenceHours/firstIn/lastOut) za pregled; (4) sve kroz withUserRls (RLS),
 *     NIKAD this.sy15.db (BYPASSRLS) — auto ne sme da probije PII/row-scope.
 */
type SqlLike = { strings: string[]; values: unknown[] };
const firstSql = (m: jest.Mock): SqlLike =>
  (m.mock.calls as unknown[][])[0]?.[0] as SqlLike;
const sqlText = (m: jest.Mock): string => firstSql(m).strings.join(" ? ");

function makeSvc(opts: {
  vsGridRows?: Record<string, unknown>[];
  holidays?: string[];
}) {
  const queryRaw = jest.fn().mockResolvedValue(opts.vsGridRows ?? []);
  let dbAccessed = false;
  const tx = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "$queryRaw") return queryRaw;
        if (prop === "kadrHoliday")
          return {
            findMany: jest.fn().mockResolvedValue(
              (opts.holidays ?? []).map((d) => ({
                holidayDate: new Date(`${d}T00:00:00Z`),
              })),
            ),
          };
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
  const svc = new KadrovskaService(sy15 as unknown as Sy15Service);
  return { svc, queryRaw, dbAccessed: () => dbAccessed };
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
  it("SQL bira SAMO regularne prazne dane iz v_attendance_vs_grid", async () => {
    const { svc, queryRaw } = makeSvc({ vsGridRows: [] });
    await svc.gridAutoFillSuggestions("hr@x", { year: 2026, month: 7 });
    const t = sqlText(queryRaw);
    expect(t).toContain("FROM v_attendance_vs_grid");
    expect(t).toContain("grid_covered = false");
    expect(t).toContain("absence_code IS NULL");
    expect(t).toContain("COALESCE(grid_field_hours, 0) = 0");
    expect(t).toContain("open_intervals = 0");
    expect(t).toContain("first_in IS NOT NULL");
    expect(t).toContain("last_out IS NOT NULL");
    // opseg prisustva parametrizovan (7.6–8.4)
    expect(firstSql(queryRaw).values).toEqual(
      expect.arrayContaining([7.6, 8.4]),
    );
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

  it("vikend (subota 2026-07-04) se izbacuje iako je regularan po kucanju", async () => {
    const { svc } = makeSvc({ vsGridRows: [vsRow("2026-07-04")] });
    const out = await svc.gridAutoFillSuggestions("hr@x", {
      year: 2026,
      month: 7,
    });
    expect((out.data as { suggestions: unknown[] }).suggestions).toHaveLength(
      0,
    );
  });

  it("praznik (2026-07-07 u holSet) se izbacuje", async () => {
    const { svc } = makeSvc({
      vsGridRows: [vsRow("2026-07-07")],
      holidays: ["2026-07-07"],
    });
    const out = await svc.gridAutoFillSuggestions("hr@x", {
      year: 2026,
      month: 7,
    });
    expect((out.data as { suggestions: unknown[] }).suggestions).toHaveLength(
      0,
    );
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
