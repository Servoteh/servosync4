import {
  KadrovskaGridAutofillService,
  proposeHoursFromPresence,
  GRID_AUTOFILL_MARKER,
} from "./grid-autofill.service";
import type { Sy15Service } from "../../common/sy15/sy15.service";

/**
 * Zahtev 012/26 — dnevni auto-predlog grida iz kapije (presuda Nenad 24.07). Pinuje:
 * (1) predlog iz STVARNOG prisustva (NE paušalno 8h) — skraćeno vreme 5h → 5.0;
 * (2) upis je INSERT … ON CONFLICT (employee_id, work_date) DO NOTHING (idempotentno,
 *     nikad ne gazi ručni unos) + marker last_edited_by='auto:kapija';
 * (3) vikend/praznik/opseg se preskaču; (4) kill-switch KADROVSKA_GRID_AUTOFILL=false → no-op;
 * (5) dryRun ne piše.
 */

type SqlLike = { strings: string[]; values: unknown[] };
const textOf = (m: jest.Mock): string =>
  ((m.mock.calls[0]?.[0] as SqlLike)?.strings ?? []).join(" ? ");
const valuesOf = (m: jest.Mock): unknown[] =>
  (m.mock.calls[0]?.[0] as SqlLike)?.values ?? [];

function makeSvc(opts: {
  vsGridRows?: { employee_id: string; day: Date; presence_hours: number }[];
  holidays?: string[];
  executeResult?: number;
  flag?: string;
}) {
  if (opts.flag === undefined) delete process.env.KADROVSKA_GRID_AUTOFILL;
  else process.env.KADROVSKA_GRID_AUTOFILL = opts.flag;

  const queryRaw = jest.fn().mockResolvedValue(opts.vsGridRows ?? []);
  const executeRaw = jest
    .fn()
    .mockResolvedValue(opts.executeResult ?? (opts.vsGridRows?.length ?? 0));
  const holidayFindMany = jest.fn().mockResolvedValue(
    (opts.holidays ?? []).map((d) => ({
      holidayDate: new Date(`${d}T00:00:00Z`),
    })),
  );
  const db = {
    $queryRaw: queryRaw,
    $executeRaw: executeRaw,
    kadrHoliday: { findMany: holidayFindMany },
  };
  const sy15 = {
    get db() {
      return db;
    },
  } as unknown as Sy15Service;
  const svc = new KadrovskaGridAutofillService(sy15);
  return { svc, queryRaw, executeRaw };
}

// v_attendance_vs_grid red (samo kolone koje job čita).
function vsRow(day: string, presence: number) {
  return {
    employee_id: "3b241101-e2bb-4255-8caf-4136c566a962",
    day: new Date(`${day}T00:00:00Z`),
    presence_hours: presence,
  };
}

afterEach(() => {
  delete process.env.KADROVSKA_GRID_AUTOFILL;
});

describe("proposeHoursFromPresence (STVARNI sati, NE paušalno 8h)", () => {
  it("skraćeno radno vreme (~5h) → 5.0, NE 8h (Antić/Pavlović)", () => {
    expect(proposeHoursFromPresence(5.0)).toBe(5.0);
    expect(proposeHoursFromPresence(5.05)).toBe(5.0);
    expect(proposeHoursFromPresence(5.3)).toBe(5.5);
    expect(proposeHoursFromPresence(4.8)).toBe(5.0);
  });

  it("pun dan (prisustvo u/preko regularnog opsega) → 8", () => {
    expect(proposeHoursFromPresence(8.0)).toBe(8);
    expect(proposeHoursFromPresence(7.95)).toBe(8);
    expect(proposeHoursFromPresence(7.6)).toBe(8); // donja granica „pun dan"
    expect(proposeHoursFromPresence(8.4)).toBe(8);
    expect(proposeHoursFromPresence(9.5)).toBe(8); // duži dan → 8 redovnih; prekovremeni ručno
  });

  it("srednje kratko (6–7.5h) → zaokruženo na pola sata", () => {
    expect(proposeHoursFromPresence(6.7)).toBe(6.5);
    expect(proposeHoursFromPresence(7.5)).toBe(7.5);
    expect(proposeHoursFromPresence(7.4)).toBe(7.5);
  });

  it("van opsega → null (preskoči): <1h slučajno kucanje, >14h anomalija, null", () => {
    expect(proposeHoursFromPresence(0.5)).toBeNull();
    expect(proposeHoursFromPresence(0.9)).toBeNull();
    expect(proposeHoursFromPresence(15)).toBeNull();
    expect(proposeHoursFromPresence(null)).toBeNull();
    expect(proposeHoursFromPresence(Number.NaN)).toBeNull();
  });
});

describe("KadrovskaGridAutofillService.run", () => {
  it("čita v_attendance_vs_grid sa signalima 'regularnog praznog dana' + raspon u params", async () => {
    const { svc, queryRaw } = makeSvc({ vsGridRows: [] });
    await svc.run({ from: "2026-07-01", to: "2026-07-08" });
    const t = textOf(queryRaw);
    expect(t).toContain("FROM v_attendance_vs_grid");
    expect(t).toContain("grid_covered = false");
    expect(t).toContain("absence_code IS NULL");
    expect(t).toContain("COALESCE(grid_field_hours, 0) = 0");
    expect(t).toContain("open_intervals = 0");
    expect(t).toContain("first_in IS NOT NULL");
    expect(t).toContain("last_out IS NOT NULL");
    expect(valuesOf(queryRaw)).toEqual(
      expect.arrayContaining(["2026-07-01", "2026-07-08"]),
    );
  });

  it("skraćeno vreme (5h) upisuje se kao 5.0 (NE 8h) + marker + ON CONFLICT DO NOTHING", async () => {
    const { svc, executeRaw } = makeSvc({
      vsGridRows: [vsRow("2026-07-07", 5.05)], // utorak
      executeResult: 1,
    });
    const { data } = await svc.run({ from: "2026-07-07", to: "2026-07-07" });
    expect(data.proposed).toBe(1);
    expect(data.inserted).toBe(1);
    const t = textOf(executeRaw);
    expect(t).toContain("INSERT INTO work_hours");
    expect(t).toContain("ON CONFLICT (employee_id, work_date) DO NOTHING");
    const v = valuesOf(executeRaw);
    expect(v[0]).toBe(GRID_AUTOFILL_MARKER); // last_edited_by = 'auto:kapija'
    // unnest nizovi: [marker, empIds[], dates[], hrs[]] → sati = 5 (NE 8)
    expect(v).toEqual(
      expect.arrayContaining([["2026-07-07"], [5]]),
    );
  });

  it("pun radni dan → predlog 8", async () => {
    const { svc, executeRaw } = makeSvc({
      vsGridRows: [vsRow("2026-07-07", 8.1)],
      executeResult: 1,
    });
    await svc.run({ from: "2026-07-07", to: "2026-07-07" });
    expect(valuesOf(executeRaw)).toEqual(expect.arrayContaining([[8]]));
  });

  it("vikend (subota 2026-07-04) se preskače — bez upisa", async () => {
    const { svc, executeRaw } = makeSvc({
      vsGridRows: [vsRow("2026-07-04", 8.0)],
    });
    const { data } = await svc.run({ from: "2026-07-04", to: "2026-07-04" });
    expect(data.proposed).toBe(0);
    expect(data.skippedWeekendHoliday).toBe(1);
    expect(executeRaw).not.toHaveBeenCalled();
  });

  it("praznik u holSet se preskače — bez upisa", async () => {
    const { svc, executeRaw } = makeSvc({
      vsGridRows: [vsRow("2026-07-07", 8.0)],
      holidays: ["2026-07-07"],
    });
    const { data } = await svc.run({ from: "2026-07-07", to: "2026-07-07" });
    expect(data.proposed).toBe(0);
    expect(data.skippedWeekendHoliday).toBe(1);
    expect(executeRaw).not.toHaveBeenCalled();
  });

  it("idempotentno / ne-prepisivanje: već popunjen dan (DO NOTHING → 0 upisa) iako je predložen", async () => {
    const { svc, executeRaw } = makeSvc({
      vsGridRows: [vsRow("2026-07-07", 8.0)],
      executeResult: 0, // svi redovi u konfliktu → ništa upisano (ručni unos ostaje netaknut)
    });
    const { data } = await svc.run({ from: "2026-07-07", to: "2026-07-07" });
    expect(data.proposed).toBe(1);
    expect(data.inserted).toBe(0);
    expect(textOf(executeRaw)).toContain("DO NOTHING");
  });

  it("kill-switch KADROVSKA_GRID_AUTOFILL=false → no-op (bez čitanja i upisa)", async () => {
    const { svc, queryRaw, executeRaw } = makeSvc({
      vsGridRows: [vsRow("2026-07-07", 8.0)],
      flag: "false",
    });
    const { data } = await svc.run({ from: "2026-07-07", to: "2026-07-07" });
    expect(data.enabled).toBe(false);
    expect(data.inserted).toBe(0);
    expect(queryRaw).not.toHaveBeenCalled();
    expect(executeRaw).not.toHaveBeenCalled();
  });

  it("dryRun: izračuna predlog ali NE piše", async () => {
    const { svc, executeRaw } = makeSvc({
      vsGridRows: [vsRow("2026-07-07", 5.0)],
    });
    const { data } = await svc.run({
      from: "2026-07-07",
      to: "2026-07-07",
      dryRun: true,
    });
    expect(data.proposed).toBe(1);
    expect(data.inserted).toBe(0);
    expect(executeRaw).not.toHaveBeenCalled();
  });

  it("out-of-band prisustvo (0.5h / 15h) → skippedOutOfBand, bez upisa", async () => {
    const { svc, executeRaw } = makeSvc({
      vsGridRows: [vsRow("2026-07-07", 0.5), vsRow("2026-07-08", 15)], // uto, sre
    });
    const { data } = await svc.run({ from: "2026-07-07", to: "2026-07-08" });
    expect(data.proposed).toBe(0);
    expect(data.skippedOutOfBand).toBe(2);
    expect(executeRaw).not.toHaveBeenCalled();
  });
});
