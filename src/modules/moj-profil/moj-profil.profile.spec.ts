import { NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import { MojProfilService } from "./moj-profil.service";
import type { Sy15Service } from "../../common/sy15/sy15.service";

/**
 * Drop 2 READ/self-write Moj profil — jedinični testovi (bez žive baze). Pinuju:
 * (1) dev-plan {plan,goals,checkins} oblik + self-assessment PATCH + self check-in kind='zaposleni',
 * (2) očekivanja self status/progress grane (paritet markMyExpectationStatus/Progress),
 * (3) 360 READ agregira sve u jednom pozivu (assessment_open_self → scope/rater/scores/…),
 * (4) onboarding/absences/attendance-events/talk-detail scope kroz withUserRls.
 * Potpisi RPC-ova NETAKNUTI; RLS presuđuje row-scope (mock samo verifikuje SQL/grananje).
 */
const CID = "3b241101-e2bb-4255-8caf-4136c566a962";
const ID = "11111111-2222-3333-4444-555555555555";
const EMP = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

type SqlLike = { strings: string[]; values: unknown[] };
const qText = (m: jest.Mock, n = 0): string =>
  (m.mock.calls[n]?.[0] as SqlLike).strings.join("?");
const eText = (m: jest.Mock, n = 0): string =>
  (m.mock.calls[n]?.[0] as SqlLike).strings.join("?");

function makeSvc() {
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    $executeRaw: jest.fn().mockResolvedValue(1),
    employeeExpectation: {
      findMany: jest.fn().mockResolvedValue([]),
    },
    developmentCheckin: {
      findMany: jest.fn().mockResolvedValue([]),
    },
    kadrOnboardingRun: {
      findMany: jest.fn().mockResolvedValue([]),
    },
    kadrOnboardingTask: {
      findMany: jest.fn().mockResolvedValue([]),
    },
    absence: {
      findMany: jest.fn().mockResolvedValue([]),
    },
    employeeTalk: {
      findFirst: jest.fn().mockResolvedValue(null),
    },
    correctivePlan: {
      findMany: jest.fn().mockResolvedValue([]),
    },
    correctiveMeasure: {
      findMany: jest.fn().mockResolvedValue([]),
    },
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

/** resolveEmployee je prvi $queryRaw poziv — vrati aktivan red (ili [] za prazan profil). */
function mockEmployee(tx: { $queryRaw: jest.Mock }) {
  tx.$queryRaw.mockResolvedValueOnce([
    { id: EMP, full_name: "Test", position_id: 3, work_type: "puno", hire_date: "2020-01-01" },
  ]);
}

describe("MojProfilService Drop 2 — razvoj self + očekivanja self", () => {
  it("devPlan: v_development_plans (aktivan prvi) + goals(plan_id) + checkins desc", async () => {
    const { svc, tx } = makeSvc();
    mockEmployee(tx);
    tx.$queryRaw.mockResolvedValueOnce([{ id: "plan1", status: "aktivan" }]); // plan
    tx.employeeExpectation.findMany.mockResolvedValueOnce([{ id: "g1" }]);
    tx.developmentCheckin.findMany.mockResolvedValueOnce([{ id: "c1" }]);
    const out = await svc.devPlan("u@x");
    expect(qText(tx.$queryRaw, 1)).toContain("FROM v_development_plans");
    expect(tx.employeeExpectation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { employeeId: EMP, planId: "plan1" } }),
    );
    const d = out.data as { plan: unknown; goals: unknown[]; checkins: unknown[] };
    expect(d.plan).not.toBeNull();
    expect(d.goals).toHaveLength(1);
    expect(d.checkins).toHaveLength(1);
  });

  it("devPlan: bez plana → {plan:null,goals:[],checkins:[]}", async () => {
    const { svc, tx } = makeSvc();
    mockEmployee(tx);
    tx.$queryRaw.mockResolvedValueOnce([]); // nema plana
    const out = await svc.devPlan("u@x");
    expect(out.data).toEqual({ plan: null, goals: [], checkins: [] });
  });

  it("updateSelfAssessment: UPDATE development_plans self_assessment_md + updated_by", async () => {
    const { svc, tx } = makeSvc();
    tx.$executeRaw.mockResolvedValueOnce(1);
    await svc.updateSelfAssessment("u@x", ID, "moja procena");
    const text = eText(tx.$executeRaw);
    expect(text).toContain("UPDATE development_plans");
    expect(text).toContain("self_assessment_md");
    expect(text).toContain("updated_by");
  });

  it("updateSelfAssessment: 0 redova → 404 (tuđi/nepostojeći plan)", async () => {
    const { svc, tx } = makeSvc();
    tx.$executeRaw.mockResolvedValueOnce(0);
    await expect(svc.updateSelfAssessment("u@x", ID, "x")).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("addSelfCheckin: prazan tekst → 422 (pre tx)", async () => {
    const { svc } = makeSvc();
    await expect(
      svc.addSelfCheckin("u@x", ID, { clientEventId: CID, noteMd: "   " }),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it("addSelfCheckin: INSERT development_checkins author_kind='zaposleni' + runIdem", async () => {
    const { svc, sy15, tx } = makeSvc();
    mockEmployee(tx);
    tx.$queryRaw.mockResolvedValueOnce([{ id: "chk1" }]); // INSERT RETURNING
    await svc.addSelfCheckin("u@x", ID, { clientEventId: CID, noteMd: "beleška" });
    expect(sy15.runIdempotentRls).toHaveBeenCalledWith(
      "u@x",
      CID,
      "profile.devplan-checkin",
      expect.any(Function),
    );
    const text = qText(tx.$queryRaw, 1);
    expect(text).toContain("INSERT INTO development_checkins");
    expect(text).toContain("'zaposleni'");
  });

  it("updateMyExpectation: status 'ispunjeno' → completed_at + progress=100", async () => {
    const { svc, tx } = makeSvc();
    tx.$executeRaw.mockResolvedValueOnce(1);
    await svc.updateMyExpectation("u@x", ID, { status: "ispunjeno" });
    const text = eText(tx.$executeRaw);
    expect(text).toContain("UPDATE employee_expectations");
    expect(text).toContain("completed_at = now()");
    expect(text).toContain("progress = ");
  });

  it("updateMyExpectation: progress≥100 → status ispunjeno + completed_at", async () => {
    const { svc, tx } = makeSvc();
    tx.$executeRaw.mockResolvedValueOnce(1);
    await svc.updateMyExpectation("u@x", ID, { progress: 100 });
    const text = eText(tx.$executeRaw);
    expect(text).toContain("status = ");
    expect(text).toContain("completed_at = now()");
  });

  it("updateMyExpectation: nedozvoljen status → 422", async () => {
    const { svc } = makeSvc();
    await expect(
      svc.updateMyExpectation("u@x", ID, { status: "otkazano" }),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it("updateMyExpectation: ni status ni progress → 422", async () => {
    const { svc } = makeSvc();
    await expect(svc.updateMyExpectation("u@x", ID, {})).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
  });

  it("updateMyExpectation: 0 redova → 404", async () => {
    const { svc, tx } = makeSvc();
    tx.$executeRaw.mockResolvedValueOnce(0);
    await expect(
      svc.updateMyExpectation("u@x", ID, { status: "u_toku" }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe("MojProfilService Drop 2 — 360 READ", () => {
  it("selfAssessmentRead: RPC vrati null → poruka, bez daljih upita", async () => {
    const { svc, tx } = makeSvc();
    tx.$queryRaw.mockResolvedValueOnce([{ v: null }]); // assessment_open_self
    const out = await svc.selfAssessmentRead("u@x");
    const d = out.data as { assessmentId: unknown; message?: string };
    expect(d.assessmentId).toBeNull();
    expect(d.message).toContain("nisu povezani");
  });

  it("selfAssessmentRead: agregira scope/rater/scores/answers/results/framework/questions", async () => {
    const { svc, tx } = makeSvc();
    tx.$queryRaw
      .mockResolvedValueOnce([{ v: "assess-1" }]) // assessment_open_self
      .mockResolvedValueOnce([{ id: "assess-1", visible_to_employee: true }]) // assessments
      .mockResolvedValueOnce([{ group_id: 1, competence_id: 5 }]) // v_assessment_scope
      .mockResolvedValueOnce([{ id: "rater1" }]) // assessment_raters self
      .mockResolvedValueOnce([{ group_id: 1 }]) // v_competence_framework
      .mockResolvedValueOnce([{ code: "q1" }]) // competence_questions
      .mockResolvedValueOnce([{ competence_id: 5, level: 4 }]) // scores
      .mockResolvedValueOnce([{ question_code: "q1", answer_text: "a" }]) // answers
      .mockResolvedValueOnce([{ scope_kind: "group" }]); // results
    const out = await svc.selfAssessmentRead("u@x", "2026");
    const d = out.data as Record<string, unknown>;
    expect(d.assessmentId).toBe("assess-1");
    expect(d.visibleToEmployee).toBe(true);
    expect((d.scope as unknown[]).length).toBe(1);
    expect((d.scores as unknown[]).length).toBe(1);
    expect((d.answers as unknown[]).length).toBe(1);
    expect((d.results as unknown[]).length).toBe(1);
    // scores/answers čitani po self rater id
    expect(qText(tx.$queryRaw, 6)).toContain("FROM assessment_scores");
    expect(qText(tx.$queryRaw, 6)).toContain("rater_id");
  });

  it("selfAssessmentRead: prazan scope → poruka o profilu kompetencija", async () => {
    const { svc, tx } = makeSvc();
    tx.$queryRaw
      .mockResolvedValueOnce([{ v: "assess-1" }])
      .mockResolvedValueOnce([{ id: "assess-1", visible_to_employee: false }])
      .mockResolvedValueOnce([]) // scope PRAZAN
      .mockResolvedValueOnce([]) // rater
      .mockResolvedValueOnce([]) // framework
      .mockResolvedValueOnce([]) // questions
      .mockResolvedValueOnce([]) // scores (raterId null → prazno, ali mock ipak vrati [])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    const out = await svc.selfAssessmentRead("u@x");
    const d = out.data as { message?: string };
    expect(d.message).toContain("profil kompetencija");
  });
});

describe("MojProfilService Drop 2 — profil dopune", () => {
  it("onboarding: kadr_onboarding_runs active + tasks(run_id in)", async () => {
    const { svc, tx } = makeSvc();
    mockEmployee(tx);
    tx.kadrOnboardingRun.findMany.mockResolvedValueOnce([{ id: "run1" }]);
    tx.kadrOnboardingTask.findMany.mockResolvedValueOnce([{ id: "t1" }]);
    const out = await svc.onboarding("u@x");
    expect(tx.kadrOnboardingRun.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { employeeId: EMP, status: "active" } }),
    );
    expect(tx.kadrOnboardingTask.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { runId: { in: ["run1"] } } }),
    );
    expect((out.data as { runs: unknown[] }).runs).toHaveLength(1);
  });

  it("absences: tekuća godina, arhivirana izbačena, self-scope", async () => {
    const { svc, tx } = makeSvc();
    mockEmployee(tx);
    tx.absence.findMany.mockResolvedValueOnce([{ id: "a1" }]);
    await svc.absences("u@x");
    const arg = tx.absence.findMany.mock.calls[0][0];
    expect(arg.where.employeeId).toBe(EMP);
    expect(arg.where.archivedAt).toBeNull();
  });

  it("attendanceEvents: attendance_events self + dan po event_ts_local::date", async () => {
    const { svc, tx } = makeSvc();
    mockEmployee(tx);
    tx.$queryRaw.mockResolvedValueOnce([{ id: 1, direction: "in" }]);
    const out = await svc.attendanceEvents("u@x", "2026-07-16");
    const text = qText(tx.$queryRaw, 1);
    expect(text).toContain("FROM attendance_events");
    expect(text).toContain("event_ts_local");
    expect((out.data as { events: unknown[] }).events).toHaveLength(1);
  });

  it("talkDetail: talk self + korektivni planovi(talk_id∨closing) + ugnježdene mere", async () => {
    const { svc, tx } = makeSvc();
    mockEmployee(tx); // 1. resolveEmployee
    tx.$queryRaw
      .mockResolvedValueOnce([{ id: ID, zapisnik_md: "x" }]) // 2. talk (snake_case raw)
      .mockResolvedValueOnce([{ id: "pl1" }]) // 3. plans
      .mockResolvedValueOnce([{ id: "m1", plan_id: "pl1" }]); // 4. measures
    const out = await svc.talkDetail("u@x", ID);
    const d = out.data as {
      talk: unknown;
      correctivePlans: { measures: unknown[] }[];
      correctiveMeasures: unknown[];
    };
    expect(d.talk).not.toBeNull();
    expect(d.correctiveMeasures).toHaveLength(1);
    // mere ugnježdene u plan (paritet 1.0 embed)
    expect(d.correctivePlans[0].measures).toHaveLength(1);
  });

  it("talkDetail: nema reda → 404", async () => {
    const { svc, tx } = makeSvc();
    mockEmployee(tx); // resolveEmployee
    tx.$queryRaw.mockResolvedValueOnce([]); // talk = prazan → 404
    await expect(svc.talkDetail("u@x", ID)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
