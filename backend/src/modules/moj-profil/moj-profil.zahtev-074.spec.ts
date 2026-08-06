import { UnprocessableEntityException } from "@nestjs/common";
import { MojProfilService } from "./moj-profil.service";

/**
 * ZAHTEV 074/26 (Miljan Nikodijević, 06.08.2026) — „dan odmora" ima DVA datuma.
 *
 * Do 06.08.2026 je forma za tip `dan_odmora` slala isti datum i kao dan rada
 * vikendom i kao `absence_date`, pa je mejl taj dan ispisivao pod nazivom
 * „Datum izostanka" — obrnuto od istine (tog dana čovek RADI). Odluka vlasnika:
 * `absence_date` sme da nosi NEOBAVEZAN „Planirani slobodan dan".
 *
 * Ovi testovi pinuju granicu koja je jedina bezbednosno bitna: dan RADA mora
 * UVEK da ide u `weekend_work_date`, jer svi potrošači radnog datuma koriste
 * `COALESCE(weekend_work_date, absence_date)` (grid-autofill, autoFill predlozi,
 * kadr_grant_bonus_go / kadr_storno_makeup, bedž `bonus_granted`). Ako bi
 * planirani slobodan dan ikad završio u toj koloni, +1 dan GO i brisanje kucanih
 * sati bi pogodili POGREŠAN dan.
 */
describe("Moj profil 074/26 — dan odmora nosi dan rada i planirani slobodan dan", () => {
  const EMAIL = "u@servoteh.com";
  const SELF = "11111111-1111-4111-8111-111111111111";
  const CID = "3b241101-e2bb-4255-8caf-4136c566a962";

  type SqlLike = { strings?: readonly string[]; values?: unknown[] };
  const txt = (s: SqlLike) =>
    Array.isArray(s?.strings) ? s.strings.join("?") : String(s);

  const mkSvc = () => {
    const calls: SqlLike[] = [];
    const tx = {
      $queryRaw: jest.fn(async (sql: SqlLike) => {
        calls.push(sql);
        const t = txt(sql);
        if (t.includes("current_user_manages_employee")) return [{ ok: true }];
        if (t.includes("INSERT INTO")) return [{ id: "x1" }];
        return [{ id: SELF }];
      }),
      $executeRaw: jest.fn().mockResolvedValue(1),
    };
    const sy15 = {
      withUserRls: jest.fn(async (_e: string, fn: (t: unknown) => unknown) =>
        fn(tx),
      ),
      runIdempotentRls: jest.fn(
        async (
          _e: unknown,
          _c: unknown,
          _a: unknown,
          fn: (t: unknown) => unknown,
        ) => ({ idempotent: false, result: await fn(tx) }),
      ),
    };
    const svc = new MojProfilService(
      sy15 as never,
      {
        enabled: false,
        dispatchKadr: jest.fn(),
      } as never,
    );
    return { svc, calls };
  };

  /**
   * Parametri INSERT-a po redosledu iz `submitMakeup`:
   * 0 employee_id · 1 absence_date · 2 absence_hours · 3 reason · 4 makeup_plan ·
   * 5 makeup_deadline · 6 compensation_type · 7 weekend_work_date · 8 email.
   */
  const insertOf = (calls: SqlLike[]) => {
    const ins = calls.find((c) =>
      txt(c).includes("INSERT INTO makeup_requests"),
    );
    expect(ins).toBeTruthy();
    const v = ins!.values as unknown[];
    return {
      absenceDate: v[1],
      compensationType: v[6],
      weekendWorkDate: v[7],
    };
  };

  const danOdmora = (over: Record<string, unknown> = {}) => ({
    clientEventId: CID,
    absenceDate: "2026-08-08", // šta god klijent pošalje — servis presuđuje
    absenceHours: 8,
    reason: "Hitan posao",
    compensationType: "dan_odmora",
    weekendWorkDate: "2026-08-08", // subota
    ...over,
  });

  it("dan_odmora BEZ planiranog slobodnog dana: absence_date ostaje dan rada (današnje ponašanje)", async () => {
    const { svc, calls } = mkSvc();
    await svc.submitMakeup(EMAIL, danOdmora());
    const ins = insertOf(calls);
    expect(ins.compensationType).toBe("dan_odmora");
    expect(ins.weekendWorkDate).toBe("2026-08-08");
    expect(ins.absenceDate).toBe("2026-08-08");
  });

  it("dan_odmora SA planiranim slobodnim danom: absence_date = planirani dan, weekend_work_date = dan rada", async () => {
    const { svc, calls } = mkSvc();
    await svc.submitMakeup(
      EMAIL,
      danOdmora({ plannedAbsenceDate: "2026-09-04" }),
    );
    const ins = insertOf(calls);
    expect(ins.absenceDate).toBe("2026-09-04");
    expect(ins.weekendWorkDate).toBe("2026-08-08"); // dan RADA ostaje u svojoj koloni
  });

  it("planirani slobodan dan sme biti i PRE rada vikendom (nema pravila o redosledu)", async () => {
    const { svc, calls } = mkSvc();
    await svc.submitMakeup(
      EMAIL,
      danOdmora({ plannedAbsenceDate: "2026-08-05" }),
    );
    const ins = insertOf(calls);
    expect(ins.absenceDate).toBe("2026-08-05");
    expect(ins.weekendWorkDate).toBe("2026-08-08");
  });

  it("klijent koji pošalje samo `absenceDate` (bez planiranog dana) NE može da pregazi dan rada", async () => {
    const { svc, calls } = mkSvc();
    await svc.submitMakeup(EMAIL, danOdmora({ absenceDate: "2026-12-31" }));
    const ins = insertOf(calls);
    // Bez `plannedAbsenceDate` merodavan je dan rada — stari klijenti šalju
    // `absenceDate` kao duplikat, pa proizvoljna vrednost ne sme da prođe.
    expect(ins.absenceDate).toBe("2026-08-08");
    expect(ins.weekendWorkDate).toBe("2026-08-08");
  });

  it("nadoknada sa `plannedAbsenceDate` se ODBIJA (polje postoji samo za dan odmora)", async () => {
    const { svc } = mkSvc();
    await expect(
      svc.submitMakeup(EMAIL, {
        clientEventId: CID,
        absenceDate: "2026-08-04",
        absenceHours: 4,
        reason: "Lekar",
        makeupPlan: "Radim popodne",
        compensationType: "nadoknada",
        plannedAbsenceDate: "2026-08-20",
      }),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it("nadoknada ostaje NEPROMENJENA: absence_date = datum izostanka, weekend_work_date = null", async () => {
    const { svc, calls } = mkSvc();
    await svc.submitMakeup(EMAIL, {
      clientEventId: CID,
      absenceDate: "2026-08-04",
      absenceHours: 4,
      reason: "Lekar",
      makeupPlan: "Radim popodne",
      makeupDeadline: "2026-08-31",
      compensationType: "nadoknada",
    });
    const ins = insertOf(calls);
    expect(ins.compensationType).toBe("nadoknada");
    expect(ins.absenceDate).toBe("2026-08-04");
    expect(ins.weekendWorkDate).toBeNull();
  });
});
