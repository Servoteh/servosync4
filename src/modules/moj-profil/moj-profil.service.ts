import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { Prisma } from "@prisma-sy15/client";
import { Sy15Service, type Sy15Tx } from "../../common/sy15/sy15.service";
import { jsonSafe } from "../../common/sy15/json-safe";
import type { AttendanceRangeQueryDto } from "./dto/moj-profil-query.dto";
import type {
  AckDocumentDto,
  OpenSelfAssessmentDto,
  ReviseVacationDto,
  SaveSelfAnswersDto,
  SaveSelfScoresDto,
  SubmitCorrectionDto,
  SubmitMakeupDto,
  SubmitPaidLeaveDto,
  SubmitSelfAssessmentDto,
  SubmitVacationDto,
} from "./dto/moj-profil-mutation.dto";

/** Klijentski min-datum GO zahteva (§2.4 pravilo 10; server re-provera paritet 1.0). */
const REQUEST_MIN_DATE = "2026-05-01";

/**
 * Moj profil — 3.0 TALAS D, R1 read sloj (MODULE_SPEC_pb_profil_podesavanja_30.md §0.2/§3.2).
 * KLJUČNI NALAZ (§0.2): Moj profil NEMA NIJEDNU SVOJU TABELU — čist AGREGATOR nad tuđim
 * domenima (Kadrovska/G, Reversi, Podešavanja/D). Sav pristup ide kroz `Sy15Service.withUserRls`
 * (GUC claims `email`+`sub` + SET LOCAL ROLE authenticated); postojeći DEFINER RPC-ovi i RLS
 * „moji" pregledi rade NETAKNUTI — paritet po konstrukciji, TELA RPC-ova se NE diraju (vlasnik
 * ostaje Talas G, presuda D6). Scope visi na `lower(email) → v_employees_safe` aktivan red
 * (bez reda = prazan profil, poruka „Nismo pronašli…"). Self-tabele se dodatno filtriraju po
 * `employee_id` (paritet 1.0 klijentskih `.eq(employee_id, …)` filtera — pojas i tregeri uz RLS).
 * Mutacije (submit GO/nadoknada/plaćeno, korekcija prisustva, ack, 360) su R2. Reversi zaduženja
 * = reuse `/reversi/reports/my-*` (bez novog koda — §3.2, ne dupliramo Reversi).
 */
@Injectable()
export class MojProfilService {
  constructor(private readonly sy15: Sy15Service) {}

  /** Profil header + uloge/override (v_employees_safe email→red + get_my_user_roles DEFINER). */
  me(email: string) {
    return this.withUserMapped(email, async (tx) => {
      const emp = await this.resolveEmployee(tx, email);
      const roles = await tx.$queryRaw<unknown[]>(
        Prisma.sql`SELECT * FROM get_my_user_roles()`,
      );
      return {
        data: {
          hasProfile: emp != null,
          employee: emp,
          roles: jsonSafe(roles),
          ...(emp == null
            ? { message: "Nismo pronašli vaš zaposlenički profil." }
            : {}),
        },
      };
    });
  }

  /** GO: saldo (v_vacation_balance, tekuća godina) + zahtevi + istorija (self-scope). */
  vacation(email: string) {
    const year = new Date().getFullYear();
    return this.withUserMapped(email, async (tx) => {
      const emp = await this.resolveEmployee(tx, email);
      if (emp == null) return this.emptyProfile();
      const [balance, requests, history, ledger] = await Promise.all([
        tx.$queryRaw<unknown[]>(
          Prisma.sql`SELECT * FROM v_vacation_balance WHERE employee_id = ${emp.id}::uuid AND year = ${year}`,
        ),
        tx.$queryRaw<unknown[]>(
          Prisma.sql`SELECT * FROM vacation_requests WHERE employee_id = ${emp.id}::uuid ORDER BY date_from DESC`,
        ),
        tx.$queryRaw<unknown[]>(
          Prisma.sql`SELECT * FROM vacation_history WHERE employee_id = ${emp.id}::uuid ORDER BY year DESC`,
        ),
        // Jedinstveni presek GO po godinama (grid ∪ Excel po datumu, usklađeno sa saldom)
        tx.$queryRaw<{ v: unknown }[]>(
          Prisma.sql`SELECT go_ledger(${emp.id}::uuid) AS v`,
        ),
      ]);
      const ledgerVal = jsonSafe(ledger)[0]?.v;
      return {
        data: {
          balance: jsonSafe(balance)[0] ?? null,
          requests: jsonSafe(requests),
          history: jsonSafe(history),
          ledger: Array.isArray(ledgerVal) ? ledgerVal : [],
        },
      };
    });
  }

  /** Nadoknada sati + plaćeno odsustvo (self-scope). */
  makeupAndPaidLeave(email: string) {
    return this.withUserMapped(email, async (tx) => {
      const emp = await this.resolveEmployee(tx, email);
      if (emp == null) return this.emptyProfile();
      const [makeup, paidLeave] = await Promise.all([
        tx.$queryRaw<unknown[]>(
          Prisma.sql`SELECT * FROM makeup_requests WHERE employee_id = ${emp.id}::uuid ORDER BY created_at DESC`,
        ),
        tx.$queryRaw<unknown[]>(
          Prisma.sql`SELECT * FROM paid_leave_requests WHERE employee_id = ${emp.id}::uuid ORDER BY created_at DESC`,
        ),
      ]);
      return {
        data: { makeup: jsonSafe(makeup), paidLeave: jsonSafe(paidLeave) },
      };
    });
  }

  /** Moje prisustvo (v_attendance_daily, dnevni pregled u opsegu; default tekući mesec). */
  attendance(email: string, q: AttendanceRangeQueryDto) {
    const { from, to } = monthRange(q.from, q.to);
    return this.withUserMapped(email, async (tx) => {
      const emp = await this.resolveEmployee(tx, email);
      if (emp == null) return this.emptyProfile();
      const rows = await tx.$queryRaw<unknown[]>(
        Prisma.sql`SELECT * FROM v_attendance_daily
           WHERE employee_id = ${emp.id}::uuid AND day >= ${from}::date AND day <= ${to}::date
           ORDER BY day DESC`,
      );
      return { data: { from, to, days: jsonSafe(rows) } };
    });
  }

  /** Razgovori (employee_talks self; „Upoznat sam"/korektivne mere su R2/G). */
  talks(email: string) {
    return this.withUserMapped(email, async (tx) => {
      const emp = await this.resolveEmployee(tx, email);
      if (emp == null) return this.emptyProfile();
      const rows = await tx.$queryRaw<unknown[]>(
        Prisma.sql`SELECT * FROM employee_talks WHERE employee_id = ${emp.id}::uuid ORDER BY talk_date DESC`,
      );
      return { data: jsonSafe(rows) };
    });
  }

  /** Očekivanja zaposlenog (self; Prisma model — RLS self ∨ mgmt scope u DB). */
  expectations(email: string) {
    return this.withUserMapped(email, async (tx) => {
      const emp = await this.resolveEmployee(tx, email);
      if (emp == null) return this.emptyProfile();
      const rows = await tx.employeeExpectation.findMany({
        where: { employeeId: emp.id },
        orderBy: [{ createdAt: "desc" }],
      });
      return { data: rows };
    });
  }

  /** Opis pozicije (job_positions po position_id zaposlenog; PDF port je R3). */
  position(email: string) {
    return this.withUserMapped(email, async (tx) => {
      const emp = await this.resolveEmployee(tx, email);
      if (emp == null) return this.emptyProfile();
      if (emp.positionId == null) return { data: null };
      const pos = await tx.jobPosition.findUnique({
        where: { id: emp.positionId },
      });
      return { data: pos };
    });
  }

  /** Vrednosti firme (company_profile id=1; SELECT svima). */
  companyValues(email: string) {
    return this.withUserMapped(email, async (tx) => {
      const data = await tx.companyProfile.findUnique({ where: { id: 1 } });
      return { data };
    });
  }

  /** Kolege na odsustvu danas (absences preseca DANAS; ime iz v_employees_safe). */
  colleaguesOnLeave(email: string) {
    return this.withUserMapped(email, async (tx) => {
      const rows = await tx.$queryRaw<unknown[]>(
        Prisma.sql`SELECT a.employee_id, a.type, a.date_from, a.date_to, e.full_name, e.department
           FROM absences a
           JOIN v_employees_safe e ON e.id = a.employee_id
           WHERE a.archived_at IS NULL
             AND a.date_from <= CURRENT_DATE AND a.date_to >= CURRENT_DATE
           ORDER BY e.full_name`,
      );
      return { data: jsonSafe(rows) };
    });
  }

  /** Presek za landing (GO saldo + otvoreni zahtevi + mesečni sati prisustva + razgovori). */
  summary(email: string) {
    const year = new Date().getFullYear();
    const { from, to } = monthRange();
    return this.withUserMapped(email, async (tx) => {
      const emp = await this.resolveEmployee(tx, email);
      if (emp == null) return this.emptyProfile();
      const [balance, openReq, presence, talks] = await Promise.all([
        tx.$queryRaw<{ days_remaining: number | null }[]>(
          Prisma.sql`SELECT days_remaining FROM v_vacation_balance WHERE employee_id = ${emp.id}::uuid AND year = ${year}`,
        ),
        tx.$queryRaw<{ n: bigint }[]>(
          Prisma.sql`SELECT count(*) AS n FROM vacation_requests
             WHERE employee_id = ${emp.id}::uuid AND status IN ('pending', 'sef_approved')`,
        ),
        tx.$queryRaw<{ hours: unknown }[]>(
          Prisma.sql`SELECT COALESCE(sum(presence_hours), 0) AS hours FROM v_attendance_daily
             WHERE employee_id = ${emp.id}::uuid AND day >= ${from}::date AND day <= ${to}::date`,
        ),
        tx.$queryRaw<{ n: bigint }[]>(
          Prisma.sql`SELECT count(*) AS n FROM employee_talks
             WHERE employee_id = ${emp.id}::uuid AND shared_at IS NOT NULL AND acknowledged_at IS NULL`,
        ),
      ]);
      return {
        data: {
          employee: { id: emp.id, fullName: emp.full_name },
          vacationDaysRemaining: balance[0]?.days_remaining ?? null,
          openVacationRequests: Number(openReq[0]?.n ?? 0),
          monthPresenceHours: Number(presence[0]?.hours ?? 0),
          unacknowledgedTalks: Number(talks[0]?.n ?? 0),
        },
      };
    });
  }

  // ---------- interno ----------

  /** Aktivan employee red po email-u (v_employees_safe; null = prazan profil). */
  private async resolveEmployee(
    tx: Sy15Tx,
    email: string,
  ): Promise<{
    id: string;
    full_name: string | null;
    positionId: number | null;
  } | null> {
    const rows = await tx.$queryRaw<
      { id: string; full_name: string | null; position_id: number | null }[]
    >(
      Prisma.sql`SELECT id, full_name, position_id FROM v_employees_safe
         WHERE lower(email) = lower(${email}) LIMIT 1`,
    );
    const r = rows[0];
    return r
      ? { id: r.id, full_name: r.full_name, positionId: r.position_id }
      : null;
  }

  private emptyProfile() {
    return {
      data: null,
      meta: { message: "Nismo pronašli vaš zaposlenički profil." },
    };
  }

  private async withUserMapped<T>(
    email: string,
    fn: (tx: Sy15Tx) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.sy15.withUserRls(email, fn);
    } catch (e) {
      this.rethrowSy15(e);
    }
  }

  /** SQLSTATE → HTTP (paritet Reversi/Sastanci §5): 42501→403, P0001/P0002/23514→422, 23505→409. */
  private rethrowSy15(e: unknown): never {
    if (
      e instanceof NotFoundException ||
      e instanceof ForbiddenException ||
      e instanceof UnprocessableEntityException ||
      e instanceof ConflictException
    ) {
      throw e;
    }
    const meta = (e as { meta?: { code?: string; message?: string } }).meta;
    const code = meta?.code ?? (e as { code?: string }).code;
    const message = meta?.message ?? (e as Error).message;
    if (code === "42501") throw new ForbiddenException(message);
    if (code === "P0001" || code === "P0002" || code === "23514")
      throw new UnprocessableEntityException(message);
    if (code === "23505") throw new ConflictException(message);
    if (code === "P2025") throw new ForbiddenException(message);
    throw e;
  }

  // ============================================================================
  // R2 — MUTACIJE (self-service kroz GUC; POSTOJEĆI G-RPC-ovi, potpisi NETAKNUTI — D6)
  // ============================================================================
  // Sve ide pod `SET LOCAL ROLE authenticated` (withUserRls/runIdempotentRls) → sy15 RLS +
  // DEFINER G-RPC-ovi rade IDENTIČNO kao 1.0 PostgREST (submitted_by=email, employee_id=
  // rev_current_employee_id() itd. — izmereno 13.07). TELA hr_*/kadr_*/attendance_*/assessment_*
  // se NE diraju (vlasnik Talas G). Posle enqueue notifikacije → best-effort „pulse" edge
  // `hr-notify-dispatch` (van tx, ne blokira; cron ionako pokupi red).

  private async runIdem<T>(
    email: string,
    clientEventId: string,
    action: string,
    fn: (tx: Sy15Tx) => Promise<T>,
  ) {
    try {
      const out = await this.sy15.runIdempotentRls(
        email,
        clientEventId,
        action,
        fn,
      );
      return { data: out.result, meta: { idempotent: out.idempotent } };
    } catch (e) {
      this.rethrowSy15(e);
    }
  }

  /** Best-effort „pulse" edge hr-notify-dispatch (odmah pošalji queued mejlove). Ne baca. */
  private pulseHrDispatch(): void {
    const base = (
      process.env.SY15_REST_URL || "https://api.servosync.servoteh.com/rest/v1"
    ).replace(/\/rest\/v1\/?$/, "");
    const key = process.env.SY15_SERVICE_KEY;
    if (!base || !key) return;
    void fetch(`${base}/functions/v1/hr-notify-dispatch`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, apikey: key },
    }).catch(() => undefined);
  }

  // ---------- GO zahtevi (submit/revise/cancel/delete) ----------

  /**
   * GO submit — paritet 1.0 (mojProfil submit): server re-provera min-datuma/salda/preklapanja,
   * INSERT vacation_requests (submitted_by=email — RLS WITH CHECK), pa
   * kadr_queue_vacation_submission_notification + pulse. RLS pušta i za člana tima (submitted_by).
   */
  async submitVacation(email: string, dto: SubmitVacationDto) {
    if (dto.dateTo < dto.dateFrom)
      throw new UnprocessableEntityException('„Do" ne može biti pre „Od".');
    if (dto.dateFrom < REQUEST_MIN_DATE)
      throw new UnprocessableEntityException(
        `Najraniji dozvoljeni datum je ${REQUEST_MIN_DATE}.`,
      );
    const year = Number(dto.dateFrom.slice(0, 4));
    const out = await this.runIdem(
      email,
      dto.clientEventId,
      "profile.vacation-submit",
      async (tx) => {
        const empId = dto.employeeId ?? (await this.resolveEmployee(tx, email))?.id;
        if (!empId)
          throw new UnprocessableEntityException(
            "Nismo pronašli vaš zaposlenički profil.",
          );
        const balRows = await tx.$queryRaw<{ days_remaining: number | null }[]>(
          Prisma.sql`SELECT days_remaining FROM v_vacation_balance
             WHERE employee_id = ${empId}::uuid AND year = ${year} LIMIT 1`,
        );
        const remaining = balRows[0]?.days_remaining;
        if (
          remaining != null &&
          Number.isFinite(Number(remaining)) &&
          dto.daysCount > Number(remaining)
        )
          throw new UnprocessableEntityException(
            `Traženo ${dto.daysCount} radnih dana prelazi preostali saldo (${remaining}) za ${year}.`,
          );
        const overlap = await tx.$queryRaw<{ id: string }[]>(
          Prisma.sql`SELECT id FROM vacation_requests
             WHERE employee_id = ${empId}::uuid
               AND status IN ('pending','sef_approved','approved')
               AND date_from <= ${dto.dateTo}::date AND date_to >= ${dto.dateFrom}::date
             LIMIT 1`,
        );
        if (overlap.length)
          throw new ConflictException(
            "Već postoji aktivan zahtev za te dane — prvo ga obriši ili otkaži.",
          );
        const rows = await tx.$queryRaw<{ id: string }[]>(
          Prisma.sql`INSERT INTO vacation_requests
             (employee_id, year, date_from, date_to, days_count, note, submitted_by, status)
             VALUES (${empId}::uuid, ${year}, ${dto.dateFrom}::date, ${dto.dateTo}::date,
               ${dto.daysCount}, ${dto.note ?? ""}, lower(${email}), 'pending')
             RETURNING *`,
        );
        const req = jsonSafe(rows)[0] as { id: string } | undefined;
        if (req?.id)
          await tx.$executeRaw(
            Prisma.sql`SELECT kadr_queue_vacation_submission_notification(${req.id}::uuid)`,
          );
        return req ?? null;
      },
    );
    this.pulseHrDispatch();
    return out;
  }

  /** GO izmena (hr_revise_vacation_request; podnosilac∨upravljač u DB) + re-notify + pulse. */
  async reviseVacation(email: string, id: string, dto: ReviseVacationDto) {
    const data = await this.withUserMapped(email, async (tx) => {
      const rows = await tx.$queryRaw<{ result: unknown }[]>(
        Prisma.sql`SELECT hr_revise_vacation_request(${id}::uuid, ${dto.dateFrom}::date,
           ${dto.dateTo}::date, ${dto.daysCount}, ${dto.note ?? null}, NULL,
           ${dto.forceReapproval ?? false}) AS result`,
      );
      const res = jsonSafe(rows[0]?.result ?? null);
      // paritet 1.0 (mojProfil revise): posle izmene queue submission notif (best-effort).
      await tx
        .$executeRaw(
          Prisma.sql`SELECT kadr_queue_vacation_submission_notification(${id}::uuid)`,
        )
        .catch(() => undefined);
      return res;
    });
    this.pulseHrDispatch();
    return { data };
  }

  /** GO otkaži (hr_cancel_vacation_request). */
  cancelVacation(email: string, id: string) {
    return this.withUserMapped(email, async (tx) => {
      const rows = await tx.$queryRaw<{ result: unknown }[]>(
        Prisma.sql`SELECT hr_cancel_vacation_request(${id}::uuid) AS result`,
      );
      return { data: jsonSafe(rows[0]?.result ?? null) };
    });
  }

  /** GO obriši (hr_delete_vacation_request). */
  deleteVacation(email: string, id: string) {
    return this.withUserMapped(email, async (tx) => {
      const rows = await tx.$queryRaw<{ result: unknown }[]>(
        Prisma.sql`SELECT hr_delete_vacation_request(${id}::uuid) AS result`,
      );
      return { data: jsonSafe(rows[0]?.result ?? null) };
    });
  }

  // ---------- Nadoknada sati (makeup) ----------

  /** Nadoknada submit — INSERT makeup_requests (submitted_by=email) + queue 'submitted' + pulse. */
  async submitMakeup(email: string, dto: SubmitMakeupDto) {
    const out = await this.runIdem(
      email,
      dto.clientEventId,
      "profile.makeup-submit",
      async (tx) => {
        const empId =
          dto.employeeId ?? (await this.resolveEmployee(tx, email))?.id;
        if (!empId)
          throw new UnprocessableEntityException(
            "Nismo pronašli vaš zaposlenički profil.",
          );
        const rows = await tx.$queryRaw<{ id: string }[]>(
          Prisma.sql`INSERT INTO makeup_requests
             (employee_id, absence_date, absence_hours, reason, makeup_plan, makeup_deadline,
              compensation_type, weekend_work_date, submitted_by, status)
             VALUES (${empId}::uuid, ${dto.absenceDate}::date, ${dto.absenceHours},
               ${dto.reason ?? ""}, ${dto.makeupPlan ?? ""}, ${dto.makeupDeadline ?? null}::date,
               ${dto.compensationType === "dan_odmora" ? "dan_odmora" : "nadoknada"},
               ${dto.weekendWorkDate ?? null}::date, lower(${email}), 'pending')
             RETURNING *`,
        );
        const req = jsonSafe(rows)[0] as { id: string } | undefined;
        if (req?.id)
          await tx.$executeRaw(
            Prisma.sql`SELECT kadr_queue_makeup_notification(${req.id}::uuid, 'submitted')`,
          );
        return req ?? null;
      },
    );
    this.pulseHrDispatch();
    return out;
  }

  /** Nadoknada obriši (kadr_delete_makeup; podnosilac pending/sef_approved/rejected ∨ HR). */
  deleteMakeup(email: string, id: string) {
    return this.withUserMapped(email, async (tx) => {
      const rows = await tx.$queryRaw<{ result: unknown }[]>(
        Prisma.sql`SELECT kadr_delete_makeup(${id}::uuid) AS result`,
      );
      return { data: jsonSafe(rows[0]?.result ?? null) };
    });
  }

  // ---------- Plaćeno odsustvo (paid leave) ----------

  /** Plaćeno submit — INSERT paid_leave_requests (submitted_by=email) + queue 'submitted' + pulse. */
  async submitPaidLeave(email: string, dto: SubmitPaidLeaveDto) {
    if (dto.dateTo < dto.dateFrom)
      throw new UnprocessableEntityException('„Do" ne može biti pre „Od".');
    const out = await this.runIdem(
      email,
      dto.clientEventId,
      "profile.paid-leave-submit",
      async (tx) => {
        const empId =
          dto.employeeId ?? (await this.resolveEmployee(tx, email))?.id;
        if (!empId)
          throw new UnprocessableEntityException(
            "Nismo pronašli vaš zaposlenički profil.",
          );
        const rows = await tx.$queryRaw<{ id: string }[]>(
          Prisma.sql`INSERT INTO paid_leave_requests
             (employee_id, leave_type, date_from, date_to, days_count, reason, proof_note,
              submitted_by, status)
             VALUES (${empId}::uuid, ${dto.leaveType}, ${dto.dateFrom}::date, ${dto.dateTo}::date,
               ${dto.daysCount}, ${dto.reason ?? ""}, ${dto.proofNote ?? ""}, lower(${email}), 'pending')
             RETURNING *`,
        );
        const req = jsonSafe(rows)[0] as { id: string } | undefined;
        if (req?.id)
          await tx.$executeRaw(
            Prisma.sql`SELECT kadr_queue_paidleave_notification(${req.id}::uuid, 'submitted')`,
          );
        return req ?? null;
      },
    );
    this.pulseHrDispatch();
    return out;
  }

  /** Plaćeno obriši (paid_leave_delete). */
  deletePaidLeave(email: string, id: string) {
    return this.withUserMapped(email, async (tx) => {
      const rows = await tx.$queryRaw<{ result: unknown }[]>(
        Prisma.sql`SELECT paid_leave_delete(${id}::uuid) AS result`,
      );
      return { data: jsonSafe(rows[0]?.result ?? null) };
    });
  }

  // ---------- Prisustvo korekcija (attendance_submit_correction) ----------

  /** Korekcija prisustva — RPC presuđuje sve (self∨mgr∨HR, važenje 3 dana, mejl šefu). */
  submitAttendanceCorrection(email: string, dto: SubmitCorrectionDto) {
    return this.runIdem(
      email,
      dto.clientEventId,
      "profile.attendance-correction",
      async (tx) => {
        const empId =
          dto.employeeId ?? (await this.resolveEmployee(tx, email))?.id;
        if (!empId)
          throw new UnprocessableEntityException(
            "Nismo pronašli vaš zaposlenički profil.",
          );
        const rows = await tx.$queryRaw<{ result: unknown }[]>(
          Prisma.sql`SELECT attendance_submit_correction(${empId}::uuid, ${dto.day}::date,
             ${dto.timeIn ?? null}::time, ${dto.timeOut ?? null}::time, ${dto.reason}) AS result`,
        );
        return jsonSafe(rows[0]?.result ?? null);
      },
    );
  }

  // ---------- e-saglasnost / „Upoznat sam" (kadr_document_ack) ----------

  /** Ack dokumenta (Pravilnik GO / vrednosti / razgovor); employee_id=rev_current_employee_id() (RLS). */
  ackDocument(email: string, dto: AckDocumentDto) {
    return this.runIdem(
      email,
      dto.clientEventId,
      "profile.doc-ack",
      async (tx) => {
        const rows = await tx.$queryRaw<unknown[]>(
          Prisma.sql`INSERT INTO kadr_document_ack (employee_id, ref_type, ref_id, label, acked_by)
             VALUES (rev_current_employee_id(), ${dto.refType}, ${dto.refId}, ${dto.label ?? null}, lower(${email}))
             ON CONFLICT (employee_id, ref_type, ref_id) DO NOTHING
             RETURNING *`,
        );
        if (rows.length)
          return { ...(jsonSafe(rows[0]) as object), alreadyAcked: false };
        const existing = await tx.$queryRaw<unknown[]>(
          Prisma.sql`SELECT * FROM kadr_document_ack
             WHERE employee_id = rev_current_employee_id()
               AND ref_type = ${dto.refType} AND ref_id = ${dto.refId} LIMIT 1`,
        );
        return { ...(jsonSafe(existing[0] ?? {}) as object), alreadyAcked: true };
      },
    );
  }

  // ---------- Razgovori — „Upoznat sam" (talk_acknowledge) ----------

  /**
   * Potvrda razgovora (paritet 1.0 talks.acknowledgeTalk → RPC talk_acknowledge): postavlja
   * `employee_talks.acknowledged_at` + status='potvrdjen' (evidencija potvrde koju HR čita).
   * Row-scope „samo svoje" presuđuje DEFINER/RLS kroz GUC; guard = profile.self. Idempotentno
   * po prirodi (ponovna potvrda bezopasna) → withUserRls, bez idempotency ključa.
   */
  acknowledgeTalk(email: string, id: string) {
    return this.withUserMapped(email, async (tx) => {
      const rows = await tx.$queryRaw<{ result: unknown }[]>(
        Prisma.sql`SELECT talk_acknowledge(${id}::uuid) AS result`,
      );
      return { data: jsonSafe(rows[0]?.result ?? null) };
    });
  }

  // ---------- 360 samoprocena (assessment_open_self / scores / answers / self_submit) ----------

  /** Otvori/nađi sopstvenu samoprocenu (assessment_open_self → assessment_id). */
  openSelfAssessment(email: string, dto: OpenSelfAssessmentDto) {
    return this.withUserMapped(email, async (tx) => {
      const rows = await tx.$queryRaw<{ result: unknown }[]>(
        Prisma.sql`SELECT assessment_open_self(${dto.period ?? null}) AS result`,
      );
      return { data: { assessmentId: jsonSafe(rows[0]?.result ?? null) } };
    });
  }

  /** Bulk upsert sopstvenih ocena (RLS: samo svoj rater + assessment 'collecting'). */
  saveSelfScores(email: string, dto: SaveSelfScoresDto) {
    return this.withUserMapped(email, async (tx) => {
      if (!dto.items.length) return { data: { saved: 0 } };
      const compIds = dto.items.map((i) => i.competenceId);
      const levels = dto.items.map((i) =>
        i.level === undefined || i.level === null ? null : Number(i.level),
      );
      const comments = dto.items.map((i) => i.comment ?? null);
      await tx.$executeRaw(
        Prisma.sql`INSERT INTO assessment_scores (rater_id, competence_id, level, comment)
           SELECT ${dto.raterId}::uuid, c, l, cm
           FROM unnest(${compIds}::uuid[], ${levels}::int[], ${comments}::text[]) AS t(c, l, cm)
           ON CONFLICT (rater_id, competence_id)
           DO UPDATE SET level = EXCLUDED.level, comment = EXCLUDED.comment`,
      );
      return { data: { saved: dto.items.length } };
    });
  }

  /** Bulk upsert sopstvenih tekstualnih odgovora. */
  saveSelfAnswers(email: string, dto: SaveSelfAnswersDto) {
    return this.withUserMapped(email, async (tx) => {
      const items = dto.items.filter((i) => i.questionCode);
      if (!items.length) return { data: { saved: 0 } };
      const codes = items.map((i) => i.questionCode);
      const answers = items.map((i) => i.answerText ?? null);
      await tx.$executeRaw(
        Prisma.sql`INSERT INTO assessment_answers (rater_id, question_code, answer_text)
           SELECT ${dto.raterId}::uuid, q, a
           FROM unnest(${codes}::text[], ${answers}::text[]) AS t(q, a)
           ON CONFLICT (rater_id, question_code)
           DO UPDATE SET answer_text = EXCLUDED.answer_text`,
      );
      return { data: { saved: items.length } };
    });
  }

  /** Podnesi sopstvenu procenu (assessment_self_submit → preračun agregata). */
  submitSelfAssessment(email: string, dto: SubmitSelfAssessmentDto) {
    return this.withUserMapped(email, async (tx) => {
      await tx.$executeRaw(
        Prisma.sql`SELECT assessment_self_submit(${dto.assessmentId}::uuid)`,
      );
      return { data: { ok: true } };
    });
  }
}

/** Opseg meseca 'YYYY-MM-DD' (default: tekući mesec, Europe/Belgrade sidro). */
function monthRange(from?: string, to?: string): { from: string; to: string } {
  if (from && to) return { from, to };
  const belgrade = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Belgrade",
  }).format(new Date());
  const [y, m] = belgrade.split("-");
  const firstDay = `${y}-${m}-01`;
  const lastDay = new Date(Number(y), Number(m), 0).getDate();
  return {
    from: from ?? firstDay,
    to: to ?? `${y}-${m}-${String(lastDay).padStart(2, "0")}`,
  };
}
