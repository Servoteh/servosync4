import { UnprocessableEntityException } from "@nestjs/common";
import { MojProfilService } from "./moj-profil.service";
import type { Sy15Service } from "../../common/sy15/sy15.service";
import {
  formatPresenceHm,
  sumPresence,
  withPresenceDisplay,
} from "./presence-hours.util";

/**
 * P1 — Mesečni sati + primedba (Moj profil). Pinuje: (1) GET /hours agregira work_hours meseca
 * kroz REUSE payroll-calc (chips + karnet totals + praznici + postojeća primedba), (2) prazan
 * profil → poruka, (3) PUT remark upsert on_conflict(employee_id,year,month) status→'open',
 * (4) prazan text + postojeći red = brisanje (paritet 1.0 gridRemarks), (5) DELETE remark.
 */
const CID = "3b241101-e2bb-4255-8caf-4136c566a962";
const EMP = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

type SqlLike = { strings: string[]; values: unknown[] };
const qText = (m: jest.Mock, n = 0): string =>
  (m.mock.calls[n]?.[0] as SqlLike).strings.join("?");

function makeSvc() {
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    $executeRaw: jest.fn().mockResolvedValue(0),
    workHours: { findMany: jest.fn().mockResolvedValue([]) },
    kadrHoliday: { findMany: jest.fn().mockResolvedValue([]) },
    workHoursRemark: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const sy15 = {
    withUserRls: jest.fn((_e: string, fn: (t: unknown) => Promise<unknown>) =>
      fn(tx),
    ),
    runIdempotentRls: jest.fn(
      async (
        _e: string,
        _cid: string,
        _action: string,
        fn: (t: unknown) => Promise<unknown>,
      ) => ({ idempotent: false, result: await fn(tx) }),
    ),
  };
  const svc = new MojProfilService(sy15 as unknown as Sy15Service, { enabled: false, dispatchKadr: jest.fn() } as never);
  return { svc, sy15, tx };
}

/** resolveEmployee ($queryRaw) → aktivan zaposleni (work_type/hire_date iz v_employees_safe). */
function mockEmployee(tx: ReturnType<typeof makeSvc>["tx"]) {
  tx.$queryRaw.mockImplementation((sql: unknown) => {
    const text = (sql as SqlLike).strings.join("?");
    if (text.includes("v_employees_safe"))
      return Promise.resolve([
        {
          id: EMP,
          full_name: "Test Radnik",
          position_id: 1,
          work_type: "ugovor",
          hire_date: new Date("2020-01-01"),
        },
      ]);
    return Promise.resolve([]);
  });
}

describe("MojProfilService — mesečni sati (P1)", () => {
  it("monthlyHours: bez profila → poruka (emptyProfile)", async () => {
    const { svc, tx } = makeSvc();
    tx.$queryRaw.mockResolvedValue([]); // v_employees_safe prazan
    const out = (await svc.monthlyHours("u@x", { month: "2026-07" })) as {
      data: null;
      meta: { message: string };
    };
    expect(out.data).toBeNull();
    expect(out.meta.message).toContain("zaposlenički profil");
  });

  it("monthlyHours: agregira dane + chips + totals + praznike (REUSE payroll-calc)", async () => {
    const { svc, tx } = makeSvc();
    mockEmployee(tx);
    // radni dan (sreda 2026-07-01) 8h + prekovremeni + teren
    tx.workHours.findMany.mockResolvedValue([
      {
        workDate: new Date("2026-07-01T00:00:00Z"),
        hours: 8,
        overtimeHours: 2,
        fieldHours: 3,
        twoMachineHours: 0,
        absenceCode: null,
        absenceSubtype: null,
      },
    ]);
    tx.kadrHoliday.findMany.mockResolvedValue([]);
    tx.workHoursRemark.findMany.mockResolvedValue([]);

    const out = await svc.monthlyHours("u@x", { month: "2026-07" });
    const d = out.data as {
      month: string;
      days: unknown[];
      holidays: string[];
      totals: { redovanRadSati: number; prekovremeniSati: number };
      chips: {
        radnihSati: number;
        prekovremeniH: number;
        terenH: number;
        prisustvoSati: number;
      };
      remark: unknown;
    };
    expect(d.month).toBe("2026-07");
    expect(d.days).toHaveLength(31);
    expect(d.chips.radnihSati).toBe(8);
    expect(d.chips.prekovremeniH).toBe(2);
    expect(d.chips.terenH).toBe(3);
    expect(d.chips.prisustvoSati).toBe(8);
    expect(d.totals.redovanRadSati).toBe(8);
    expect(d.totals.prekovremeniSati).toBe(2);
    expect(d.remark).toBeNull();
  });

  it("monthlyHours: vraća postojeću primedbu (text+status+resolvedBy)", async () => {
    const { svc, tx } = makeSvc();
    mockEmployee(tx);
    tx.workHoursRemark.findMany.mockResolvedValue([
      {
        id: "r1",
        note: "Fali mi 1h",
        status: "open",
        resolvedBy: null,
        resolvedAt: null,
        updatedAt: new Date("2026-07-10T10:00:00Z"),
      },
    ]);
    const out = await svc.monthlyHours("u@x", { month: "2026-07" });
    const remark = (out.data as { remark: { text: string; status: string } })
      .remark;
    expect(remark.text).toBe("Fali mi 1h");
    expect(remark.status).toBe("open");
  });

  it("saveHoursRemark: upsert on_conflict(employee_id,year,month) status→'open'", async () => {
    const { svc, sy15, tx } = makeSvc();
    tx.$queryRaw.mockImplementation((sql: unknown) => {
      const text = (sql as SqlLike).strings.join("?");
      if (text.includes("v_employees_safe"))
        return Promise.resolve([
          { id: EMP, full_name: "X", position_id: 1, work_type: "ugovor", hire_date: null },
        ]);
      if (text.includes("INSERT INTO work_hours_remarks"))
        return Promise.resolve([{ id: "r1", note: "test", status: "open" }]);
      return Promise.resolve([]);
    });
    const out = await svc.saveHoursRemark("u@x", {
      clientEventId: CID,
      year: 2026,
      month: 7,
      text: "test",
    });
    expect(sy15.runIdempotentRls).toHaveBeenCalledWith(
      "u@x",
      CID,
      "profile.hours-remark",
      expect.any(Function),
    );
    // insert je poziv nakon resolveEmployee (n=1)
    const insertText = qText(tx.$queryRaw, 1);
    expect(insertText).toContain("INSERT INTO work_hours_remarks");
    expect(insertText).toContain("ON CONFLICT (employee_id, year, month)");
    expect(insertText).toContain("status = 'open'");
    expect((out.data as { remark: unknown }).remark).not.toBeNull();
  });

  it("saveHoursRemark: prazan text + postojeći red = brisanje (paritet 1.0)", async () => {
    const { svc, tx } = makeSvc();
    tx.$queryRaw.mockImplementation((sql: unknown) => {
      const text = (sql as SqlLike).strings.join("?");
      if (text.includes("v_employees_safe"))
        return Promise.resolve([
          { id: EMP, full_name: "X", position_id: 1, work_type: "ugovor", hire_date: null },
        ]);
      return Promise.resolve([]);
    });
    tx.$executeRaw.mockResolvedValue(1); // DELETE affected 1
    const out = await svc.saveHoursRemark("u@x", {
      clientEventId: CID,
      year: 2026,
      month: 7,
      text: "   ",
    });
    expect(qText(tx.$executeRaw)).toContain("DELETE FROM work_hours_remarks");
    expect((out.data as { deleted: boolean }).deleted).toBe(true);
  });

  it("deleteHoursRemark: DELETE po employee_id+year+month", async () => {
    const { svc, sy15, tx } = makeSvc();
    tx.$queryRaw.mockResolvedValue([
      { id: EMP, full_name: "X", position_id: 1, work_type: "ugovor", hire_date: null },
    ]);
    tx.$executeRaw.mockResolvedValue(1);
    const out = await svc.deleteHoursRemark("u@x", 2026, 7);
    expect(sy15.withUserRls).toHaveBeenCalled();
    expect(qText(tx.$executeRaw)).toContain("DELETE FROM work_hours_remarks");
    expect((out.data as { deleted: boolean }).deleted).toBe(true);
  });

  it("saveHoursRemark: bez profila → 422", async () => {
    const { svc, tx } = makeSvc();
    tx.$queryRaw.mockResolvedValue([]); // v_employees_safe prazan
    await expect(
      svc.saveHoursRemark("u@x", {
        clientEventId: CID,
        year: 2026,
        month: 7,
        text: "x",
      }),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });
});

/**
 * ZAHTEV 032/26 — prisustvo se prikazuje u h:mm, a prekovremeno ispod 30 min se ne
 * prikazuje ([8:00, 8:30) → „8:00"). Prijava je bila „8.17 sati" (= 8h10min, račun
 * TAČAN, decimalni prikaz zbunjuje). Mesečni zbir = suma zaokruženih dana.
 */
describe("prisustvo — h:mm prikaz + pravilo zaokruživanja (032/26)", () => {
  const HM = (h: number, m: number) => h + m / 60;

  it.each([
    ["7:45 (ispod pune smene) → stvarno vreme", HM(7, 45), "7:45"],
    ["8:00 (tačno puna smena)", HM(8, 0), "8:00"],
    ["8:10 (prekovremeno <30min) → 8:00", HM(8, 10), "8:00"],
    ["8:29 (granica, još uvek <30min) → 8:00", HM(8, 29), "8:00"],
    ["8:30 (granica, prikazuje se) → 8:30", HM(8, 30), "8:30"],
    ["9:05 (prekovremeno >30min) → stvarno vreme", HM(9, 5), "9:05"],
  ])("%s", (_label, hours, expected) => {
    expect(formatPresenceHm(hours)).toBe(expected);
  });

  it("prijavljeni slučaj: 8.17 decimalnih sati = 8h10min → 8:00", () => {
    expect(formatPresenceHm(8.17)).toBe("8:00");
  });

  it("null/prazno prisustvo → null (prikaz pada na crticu)", () => {
    expect(formatPresenceHm(null)).toBeNull();
    expect(formatPresenceHm(undefined)).toBeNull();
  });

  it("Decimal iz baze (toNumber) se podržava", () => {
    const dec = { toNumber: () => 8.1667 };
    expect(formatPresenceHm(dec)).toBe("8:00");
  });

  it("withPresenceDisplay: čuva sirov presence_hours, dodaje presence_hm", () => {
    const [row] = withPresenceDisplay([
      { day: "2026-07-15", presence_hours: 8.17 },
    ]);
    expect(row.presence_hours).toBe(8.17); // sirov podatak netaknut
    expect(row.presence_hm).toBe("8:00");
    expect(row.presence_minutes).toBe(480);
  });

  it("mesečni zbir = suma ZAOKRUŽENIH dana (ne sirovih)", () => {
    // 8:10→8:00 (480) + 7:45 (465) + 8:30 (510) = 1455 min = 24:15
    const days = [
      { presence_hours: HM(8, 10) },
      { presence_hours: HM(7, 45) },
      { presence_hours: HM(8, 30) },
    ];
    const sum = sumPresence(days);
    expect(sum.minutes).toBe(1455);
    expect(sum.hm).toBe("24:15");
    expect(sum.hours).toBe(24.25);
    // sirova suma bi bila 24.42h — namerno se NE koristi
    expect(sum.hours).not.toBeCloseTo(24.42, 2);
  });

  it("attendance(): dani nose presence_hm + totals po istom pravilu", async () => {
    const { svc, tx } = makeSvc();
    tx.$queryRaw.mockImplementation((sql: unknown) => {
      const text = (sql as SqlLike).strings.join("?");
      if (text.includes("v_employees_safe"))
        return Promise.resolve([
          { id: EMP, full_name: "X", position_id: 1, work_type: "ugovor", hire_date: null },
        ]);
      if (text.includes("v_attendance_daily"))
        return Promise.resolve([
          { day: "2026-07-15", first_in: "07:48", last_out: "15:58", presence_hours: 8.17 },
          { day: "2026-07-16", first_in: "07:00", last_out: "16:35", presence_hours: HM(9, 35) },
        ]);
      return Promise.resolve([]);
    });
    const out = await svc.attendance("u@x", {} as never);
    const d = out.data as {
      days: { presence_hm: string }[];
      totals: { hm: string; minutes: number };
    };
    expect(d.days[0].presence_hm).toBe("8:00"); // prijavljeni red 07:48→15:58
    expect(d.days[1].presence_hm).toBe("9:35");
    expect(d.totals.minutes).toBe(480 + 575);
    expect(d.totals.hm).toBe("17:35");
  });
});
