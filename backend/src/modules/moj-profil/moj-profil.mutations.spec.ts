import {
  ConflictException,
  ForbiddenException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { MojProfilService } from "./moj-profil.service";
import type { Sy15Service } from "../../common/sy15/sy15.service";

/**
 * R2 mutacije Moj profil — jedinični testovi (bez žive baze). Pinuju: (1) write kroz
 * withUserRls/runIdempotentRls (RLS paritet + idempotency ključ+akcija), (2) submit re-provera
 * min-datuma/salda/preklapanja (422/409), (3) INSERT-i pišu submitted_by=email a ack
 * rev_current_employee_id() (RLS WITH CHECK), (4) enqueue kroz POSTOJEĆE G-RPC-ove
 * (kadr_queue_*), (5) revise/cancel/delete zovu hr_* RPC-ove (tela netaknuta — D6).
 */
const CID = "3b241101-e2bb-4255-8caf-4136c566a962";
const ID = "11111111-2222-3333-4444-555555555555";
const EMP = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"; // self
const CLAN = "bbbbbbbb-cccc-dddd-eeee-ffffffffffff"; // član tima (≠ self)

type SqlLike = { strings: string[]; values: unknown[] };
const qText = (m: jest.Mock, n = 0): string =>
  (m.mock.calls[n]?.[0] as SqlLike).strings.join("?");
const eText = (m: jest.Mock, n = 0): string =>
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

describe("MojProfilService R2 mutacije", () => {
  // ---------- GO submit (guards + insert + queue) ----------

  it("submitVacation: dateFrom < REQUEST_MIN_DATE → 422 (pre tx)", async () => {
    const { svc } = makeSvc();
    await expect(
      svc.submitVacation("u@x", {
        clientEventId: CID,
        dateFrom: "2026-04-01",
        dateTo: "2026-04-05",
        daysCount: 5,
        employeeId: EMP,
      }),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  // Napomena: submitVacation sada PRVO razrešava self employee_id (jedan $queryRaw),
  // pa (ako je employeeId zadat i ≠ self) proverava manages, pa balance/overlap/insert.
  // Testovi za SEBE ne šalju employeeId → prvi mock = self-resolve [{ id: EMP }].

  it("submitVacation: preko preostalog salda → 422", async () => {
    const { svc, tx } = makeSvc();
    tx.$queryRaw
      .mockResolvedValueOnce([{ id: EMP }]) // self-resolve
      .mockResolvedValueOnce([{ days_remaining: 3 }]); // balance
    await expect(
      svc.submitVacation("u@x", {
        clientEventId: CID,
        dateFrom: "2026-08-01",
        dateTo: "2026-08-10",
        daysCount: 8,
      }),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it("submitVacation: preklapanje aktivnog zahteva → 409", async () => {
    const { svc, tx } = makeSvc();
    tx.$queryRaw
      .mockResolvedValueOnce([{ id: EMP }]) // self-resolve
      .mockResolvedValueOnce([{ days_remaining: 20 }]) // balance
      .mockResolvedValueOnce([{ id: "x" }]); // overlap
    await expect(
      svc.submitVacation("u@x", {
        clientEventId: CID,
        dateFrom: "2026-08-01",
        dateTo: "2026-08-05",
        daysCount: 5,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("submitVacation (za sebe): OK → runIdem + INSERT submitted_by + queue RPC", async () => {
    const { svc, sy15, tx } = makeSvc();
    tx.$queryRaw
      .mockResolvedValueOnce([{ id: EMP }]) // self-resolve
      .mockResolvedValueOnce([{ days_remaining: 20 }]) // balance
      .mockResolvedValueOnce([]) // overlap (nema)
      .mockResolvedValueOnce([{ id: "req1" }]); // INSERT RETURNING
    await svc.submitVacation("u@x", {
      clientEventId: CID,
      dateFrom: "2026-08-01",
      dateTo: "2026-08-05",
      daysCount: 5,
    });
    expect(sy15.runIdempotentRls).toHaveBeenCalledWith(
      "u@x",
      CID,
      "profile.vacation-submit",
      expect.any(Function),
    );
    expect(qText(tx.$queryRaw, 3)).toContain("INSERT INTO vacation_requests");
    expect(qText(tx.$queryRaw, 3)).toContain("submitted_by");
    expect(eText(tx.$executeRaw)).toContain(
      "kadr_queue_vacation_submission_notification",
    );
  });

  it("submitVacation ZA ČLANA TIMA: manages=true → INSERT za tuđi employee_id (submitted_by=ja)", async () => {
    const { svc, tx } = makeSvc();
    tx.$queryRaw
      .mockResolvedValueOnce([{ id: EMP }]) // self-resolve (ja)
      .mockResolvedValueOnce([{ ok: true }]) // current_user_manages_employee(clan)
      .mockResolvedValueOnce([{ days_remaining: 20 }]) // balance (clana)
      .mockResolvedValueOnce([]) // overlap
      .mockResolvedValueOnce([{ id: "req1" }]); // INSERT
    await svc.submitVacation("u@x", {
      clientEventId: CID,
      dateFrom: "2026-08-01",
      dateTo: "2026-08-05",
      daysCount: 5,
      employeeId: CLAN, // ≠ self
    });
    expect(qText(tx.$queryRaw, 1)).toContain("current_user_manages_employee");
    expect(qText(tx.$queryRaw, 4)).toContain("INSERT INTO vacation_requests");
  });

  it("submitVacation ZA TUĐEG (nije moj tim): manages=false → 403, BEZ insert-a (IDOR guard)", async () => {
    const { svc, tx } = makeSvc();
    tx.$queryRaw
      .mockResolvedValueOnce([{ id: EMP }]) // self-resolve (ja)
      .mockResolvedValueOnce([{ ok: false }]); // manages(tudji) = false
    await expect(
      svc.submitVacation("u@x", {
        clientEventId: CID,
        dateFrom: "2026-08-01",
        dateTo: "2026-08-05",
        daysCount: 5,
        employeeId: CLAN,
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    // samo 2 upita (self + manages) — insert se NIKAD ne desi
    expect(tx.$queryRaw).toHaveBeenCalledTimes(2);
  });

  // ---------- GO revise/cancel/delete (hr_* RPC — tela netaknuta) ----------

  it("reviseVacation: poziva hr_revise_vacation_request + re-queue submission notif", async () => {
    const { svc, tx } = makeSvc();
    tx.$queryRaw.mockResolvedValueOnce([{ result: { status: "pending" } }]);
    await svc.reviseVacation("u@x", ID, {
      dateFrom: "2026-08-01",
      dateTo: "2026-08-05",
      daysCount: 5,
    });
    expect(qText(tx.$queryRaw)).toContain("hr_revise_vacation_request(");
    expect(eText(tx.$executeRaw)).toContain(
      "kadr_queue_vacation_submission_notification",
    );
  });

  it("cancelVacation/deleteVacation: hr_cancel/hr_delete_vacation_request", async () => {
    const { svc, tx } = makeSvc();
    await svc.cancelVacation("u@x", ID);
    expect(qText(tx.$queryRaw)).toContain("hr_cancel_vacation_request(");
    const s2 = makeSvc();
    await s2.svc.deleteVacation("u@x", ID);
    expect(qText(s2.tx.$queryRaw)).toContain("hr_delete_vacation_request(");
  });

  // ---------- Nadoknada / plaćeno ----------

  it("submitMakeup: INSERT makeup_requests + queue 'submitted'; runIdem action", async () => {
    const { svc, sy15, tx } = makeSvc();
    tx.$queryRaw.mockResolvedValueOnce([{ id: "m1" }]); // INSERT
    await svc.submitMakeup("u@x", {
      clientEventId: CID,
      absenceDate: "2026-08-01",
      absenceHours: 4,
      employeeId: EMP,
    });
    expect(sy15.runIdempotentRls).toHaveBeenCalledWith(
      "u@x",
      CID,
      "profile.makeup-submit",
      expect.any(Function),
    );
    expect(qText(tx.$queryRaw)).toContain("INSERT INTO makeup_requests");
    expect(eText(tx.$executeRaw)).toContain("kadr_queue_makeup_notification");
  });

  it("deleteMakeup: kadr_delete_makeup RPC", async () => {
    const { svc, tx } = makeSvc();
    await svc.deleteMakeup("u@x", ID);
    expect(qText(tx.$queryRaw)).toContain("kadr_delete_makeup(");
  });

  it("submitPaidLeave: INSERT paid_leave_requests + queue 'submitted'", async () => {
    const { svc, tx } = makeSvc();
    tx.$queryRaw.mockResolvedValueOnce([{ id: "p1" }]);
    await svc.submitPaidLeave("u@x", {
      clientEventId: CID,
      leaveType: "brak",
      dateFrom: "2026-08-01",
      dateTo: "2026-08-03",
      daysCount: 3,
      employeeId: EMP,
    });
    expect(qText(tx.$queryRaw)).toContain("INSERT INTO paid_leave_requests");
    expect(eText(tx.$executeRaw)).toContain(
      "kadr_queue_paidleave_notification",
    );
  });

  it("deletePaidLeave: paid_leave_delete RPC", async () => {
    const { svc, tx } = makeSvc();
    await svc.deletePaidLeave("u@x", ID);
    expect(qText(tx.$queryRaw)).toContain("paid_leave_delete(");
  });

  // ---------- Prisustvo korekcija ----------

  it("submitAttendanceCorrection: attendance_submit_correction (employeeId dat)", async () => {
    const { svc, sy15, tx } = makeSvc();
    tx.$queryRaw.mockResolvedValueOnce([{ result: { ok: true } }]);
    await svc.submitAttendanceCorrection("u@x", {
      clientEventId: CID,
      day: "2026-08-01",
      timeIn: "08:00",
      reason: "zaboravio ulaz",
      employeeId: EMP,
    });
    expect(sy15.runIdempotentRls).toHaveBeenCalledWith(
      "u@x",
      CID,
      "profile.attendance-correction",
      expect.any(Function),
    );
    expect(qText(tx.$queryRaw)).toContain("attendance_submit_correction(");
  });

  // ---------- Ack ----------

  it("ackDocument: INSERT kadr_document_ack rev_current_employee_id() + ON CONFLICT DO NOTHING", async () => {
    const { svc, tx } = makeSvc();
    tx.$queryRaw.mockResolvedValueOnce([{ id: "a1" }]); // insert returning
    const out = await svc.ackDocument("u@x", {
      clientEventId: CID,
      refType: "pravilnik_go",
      refId: "v1",
    });
    const text = qText(tx.$queryRaw);
    expect(text).toContain("INSERT INTO kadr_document_ack");
    expect(text).toContain("rev_current_employee_id()");
    expect(text).toContain("ON CONFLICT");
    expect(out.data.alreadyAcked).toBe(false);
  });

  // ---------- Razgovori „Upoznat sam" (talk_acknowledge) ----------

  it("acknowledgeTalk: poziva talk_acknowledge RPC (evidencija koju summary broji)", async () => {
    const { svc, sy15, tx } = makeSvc();
    tx.$queryRaw.mockResolvedValueOnce([{ result: { status: "potvrdjen" } }]);
    const out = await svc.acknowledgeTalk("u@x", ID);
    // withUserRls (row „samo svoje" presuđuje DEFINER/RLS), NE runIdem.
    expect(sy15.withUserRls).toHaveBeenCalled();
    expect(sy15.runIdempotentRls).not.toHaveBeenCalled();
    expect(qText(tx.$queryRaw)).toContain("talk_acknowledge(");
    expect((out.data as { status: string }).status).toBe("potvrdjen");
    // Dekrement summary().unacknowledgedTalks je po konstrukciji: RPC postavlja
    // acknowledged_at, a summary broji `acknowledged_at IS NULL` (živi smoke R4).
  });

  // ---------- 360 ----------

  it("openSelfAssessment/submit: assessment_open_self / assessment_self_submit", async () => {
    const { svc, tx } = makeSvc();
    tx.$queryRaw.mockResolvedValueOnce([{ result: "assess-1" }]);
    const out = await svc.openSelfAssessment("u@x", {});
    expect(qText(tx.$queryRaw)).toContain("assessment_open_self(");
    expect((out.data as { assessmentId: unknown }).assessmentId).toBe(
      "assess-1",
    );
    const s2 = makeSvc();
    await s2.svc.submitSelfAssessment("u@x", { assessmentId: ID });
    expect(eText(s2.tx.$executeRaw)).toContain("assessment_self_submit(");
  });

  it("saveSelfScores: VALUES upsert (competence_id JE int; ON CONFLICT rater_id,competence_id)", async () => {
    const { svc, tx } = makeSvc();
    await svc.saveSelfScores("u@x", {
      raterId: ID,
      items: [{ competenceId: 7, level: 4 }],
    });
    const text = eText(tx.$executeRaw);
    expect(text).toContain("INSERT INTO assessment_scores");
    expect(text).toContain("::int"); // competence_id je int, ne uuid (kadrovska paritet)
    expect(text).toContain("ON CONFLICT");
  });
});
