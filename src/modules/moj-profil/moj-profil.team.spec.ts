import { NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import { MojProfilService } from "./moj-profil.service";
import type { Sy15Service } from "../../common/sy15/sy15.service";

/**
 * P5 Moj tim — jedinični testovi (bez žive baze). Pinuju: (1) roster scope kroz DB fn
 * `current_user_manages_employee(id)` (guard = gruba kapija), self isključen; (2) presek po članu
 * (GO saldo / trenutno-nadolazeće odsustvo / broj zaduženja iz get_team_issued_tools jsonb array);
 * (3) drill tools filtrira na člana; (4) karnet člana kroz resolveEmployeeById (RLS), 404 kad ne
 * pušta; (5) korekcija kucanja člana → attendance_submit_correction ZA člana (RPC presuđuje pravo),
 * rani 422 na min danas-3, runIdem sa akcijom. TELA RPC-ova NETAKNUTA.
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
  const svc = new MojProfilService(sy15 as unknown as Sy15Service);
  return { svc, sy15, tx };
}

/** Datum danas-N (YYYY-MM-DD). */
function ymdOffset(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

describe("MojProfilService P5 — Moj tim", () => {
  it("team: roster scoped kroz current_user_manages_employee + isključuje self", async () => {
    const { svc, tx } = makeSvc();
    tx.$queryRaw
      .mockResolvedValueOnce([{ id: "self-id" }]) // resolveEmployee (self)
      .mockResolvedValueOnce([
        { id: EMP, full_name: "Petar", position_id: 3, sub_department_id: 2 },
      ]) // members
      .mockResolvedValueOnce([{ employee_id: EMP, days_remaining: 12 }]) // balances
      .mockResolvedValueOnce([]) // absences
      .mockResolvedValueOnce([{ v: [{ recipient_employee_id: EMP }] }]); // tools
    const out = await svc.team("sef@x");
    const rosterSql = qText(tx.$queryRaw, 1);
    expect(rosterSql).toContain("v_employees_safe");
    expect(rosterSql).toContain("current_user_manages_employee(id)");
    expect(rosterSql).toContain("id <> "); // self isključen
    const members = (out.data as { members: unknown[] }).members as Array<{
      id: string;
      issuedToolsCount: number;
    }>;
    expect(members).toHaveLength(1);
    expect(members[0].id).toBe(EMP);
    expect(members[0].issuedToolsCount).toBe(1); // 1 red iz get_team_issued_tools
  });

  it("team: prazan roster → { members: [] } (nema batch upita)", async () => {
    const { svc, tx } = makeSvc();
    tx.$queryRaw
      .mockResolvedValueOnce([]) // self (nema)
      .mockResolvedValueOnce([]); // members prazno
    const out = await svc.team("sef@x");
    expect((out.data as { members: unknown[] }).members).toEqual([]);
  });

  it("team: current vs upcoming odsustvo razdvojeno po datumu", async () => {
    const { svc, tx } = makeSvc();
    tx.$queryRaw
      .mockResolvedValueOnce([{ id: "self" }])
      .mockResolvedValueOnce([{ id: EMP, full_name: "P", sub_department_id: 1 }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { employee_id: EMP, type: "go", date_from: ymdOffset(-1), date_to: ymdOffset(2) }, // trenutno
        { employee_id: EMP, type: "go", date_from: ymdOffset(10), date_to: ymdOffset(12) }, // sledeće
      ])
      .mockResolvedValueOnce([{ v: [] }]);
    const out = await svc.team("sef@x");
    const m = (out.data as { members: Array<{ currentAbsence: unknown; upcomingAbsence: unknown }> })
      .members[0];
    expect(m.currentAbsence).not.toBeNull();
    expect(m.upcomingAbsence).not.toBeNull();
  });

  it("teamMemberTools: filtrira get_team_issued_tools na člana", async () => {
    const { svc, tx } = makeSvc();
    tx.$queryRaw.mockResolvedValueOnce([
      {
        v: [
          { recipient_employee_id: EMP, doc_number: "R-1" },
          { recipient_employee_id: "other", doc_number: "R-2" },
        ],
      },
    ]);
    const out = await svc.teamMemberTools("sef@x", EMP);
    expect(qText(tx.$queryRaw)).toContain("get_team_issued_tools()");
    const tools = (out.data as { tools: unknown[] }).tools;
    expect(tools).toHaveLength(1);
  });

  it("teamMemberHours: IDOR guard — current_user_manages_employee=false → 404 pre računanja", async () => {
    const { svc, tx } = makeSvc();
    // managesEmployee je PRVI upit; false = nije moj čovek → 404 pre resolveEmployeeById/hours.
    tx.$queryRaw.mockResolvedValueOnce([{ ok: false }]);
    await expect(
      svc.teamMemberHours("sef@x", EMP, "2026-07"),
    ).rejects.toBeInstanceOf(NotFoundException);
    // Samo 1 upit (scope check) — NIJE dosao do resolveEmployeeById/computeMonthlyHours.
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it("teamMemberHours: manages=true ali resolveEmployeeById null → 404", async () => {
    const { svc, tx } = makeSvc();
    tx.$queryRaw
      .mockResolvedValueOnce([{ ok: true }]) // managesEmployee
      .mockResolvedValueOnce([]); // resolveEmployeeById prazan
    await expect(
      svc.teamMemberHours("sef@x", EMP, "2026-07"),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("teamAttendanceCorrection: dan pre danas-3 → 422 (pre tx)", async () => {
    const { svc } = makeSvc();
    await expect(
      svc.teamAttendanceCorrection("sef@x", EMP, {
        clientEventId: CID,
        day: ymdOffset(-10),
        reason: "zaboravio",
      }),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it("teamAttendanceCorrection: OK → runIdem('profile.team-attendance-correction') + RPC za člana", async () => {
    const { svc, sy15, tx } = makeSvc();
    tx.$queryRaw.mockResolvedValueOnce([{ result: { ok: true } }]);
    await svc.teamAttendanceCorrection("sef@x", EMP, {
      clientEventId: CID,
      day: ymdOffset(-1),
      timeIn: "08:00",
      reason: "zaboravio ulaz",
    });
    expect(sy15.runIdempotentRls).toHaveBeenCalledWith(
      "sef@x",
      CID,
      "profile.team-attendance-correction",
      expect.any(Function),
    );
    const sql = qText(tx.$queryRaw);
    expect(sql).toContain("attendance_submit_correction(");
  });
});
