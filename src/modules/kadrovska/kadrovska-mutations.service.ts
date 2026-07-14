import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  NotImplementedException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { Prisma } from "@prisma-sy15/client";
import { Sy15Service, type Sy15Tx } from "../../common/sy15/sy15.service";
import { Sy15StorageService } from "../../common/sy15/sy15-storage.service";
import { MailService } from "../../common/mail/mail.service";
import {
  aggregateWorkHoursForMonth,
  computeEarnings,
  computeMonthlyFond,
  deriveCompensationModel,
  type SalaryTermsInput,
} from "./payroll/payroll-calc";
import type * as D from "./dto/kadrovska-mutation.dto";

/**
 * Kadrovska (HR) — 3.0 TALAS G, R2 MUTACIJE (MODULE_SPEC_kadrovska_30.md §3).
 *
 * ⚠️ Doktrina A.2a: SVE ide kroz `withUserRls`/`runIdempotentRls` (GUC sub+email +
 * SET LOCAL ROLE authenticated) — konekciona rola je BYPASSRLS, pa bi direktan put
 * probio PII/zarade maske i row-scope. Nikad `this.sy15.db` za HR write.
 *
 * Idempotencija (A4): kreiranje novog reda nosi OBAVEZAN `clientEventId`
 * (runIdempotentRls, `rev_api_idempotency` registar); odluke/prelazi nose OPCIONI
 * ključ. DEFINER RPC-ovi (kadr_ / hr_ familije) rade netaknuti — paritet po konstrukciji;
 * pozivaju se posle guard-a na kontroleru (pravilo 18: kadr_grid_set/unset_go bez
 * sopstvenog gejta). Optimistic-lock RPC-ovi vraćaju {applied:false, reason} → 409.
 *
 * GO grid-kanon (pravilo 1) NETAKNUT: saldo se NE preračunava — approve/reschedule/
 * revise/rollover pišu u grid kroz iste RPC-ove. Queue-okidači (kadr_queue_*) su
 * jedini legalni upis u kadr_notification_log (G10); dispatch/push OSTAJE 1.0
 * pozadina (paritet-only) — NE oživljavamo kadr_pulse_notify_dispatch (§7.9).
 */
@Injectable()
export class KadrovskaMutationsService {
  constructor(
    private readonly sy15: Sy15Service,
    private readonly storage: Sy15StorageService,
    private readonly mail: MailService,
  ) {}

  // ==========================================================================
  // ODMORI
  // ==========================================================================

  /** Podnošenje GO zahteva (INSERT vacation_requests; RLS submitter-self ∨ mgmt) +
   *  queue submission mejl. Submit RPC ne postoji u 1.0 → Prisma INSERT (no_overlap
   *  trigger presuđuje preklapanja → P0001/23514 → 422). */
  submitVacation(email: string, dto: D.SubmitVacationDto) {
    return this.create(email, dto.clientEventId, "kadr.vacation.submit", async (tx) => {
      const created = await tx.vacationRequest.create({
        data: {
          employeeId: dto.employeeId ?? (await this.selfEmployeeId(tx, email, true)),
          year: dto.year,
          dateFrom: this.date(dto.dateFrom)!,
          dateTo: this.date(dto.dateTo)!,
          daysCount: dto.daysCount,
          note: dto.note ?? "",
          status: "pending",
          submittedBy: email,
        },
      });
      await tx.$queryRaw`SELECT kadr_queue_vacation_submission_notification(${created.id}::uuid)`;
      return created;
    });
  }

  vacationApprove(email: string, id: string, dto: D.OptIdempotentDto) {
    return this.mutate(email, dto.clientEventId, "kadr.vacation.approve", (tx) =>
      this.rpcJson(tx, Prisma.sql`SELECT hr_approve_vacation_request(${id}::uuid, ${email}) AS v`),
    );
  }

  /** Dvostepeno odobravanje (šef → level1; finalno hr/admin). */
  vacationVacreqApprove(email: string, id: string, dto: D.OptIdempotentDto) {
    return this.mutate(email, dto.clientEventId, "kadr.vacation.vacreq_approve", (tx) =>
      this.rpcJson(tx, Prisma.sql`SELECT hr_vacreq_approve(${id}::uuid, ${email}) AS v`),
    );
  }

  vacationReject(email: string, id: string, dto: D.RejectDto) {
    return this.mutate(email, dto.clientEventId, "kadr.vacation.reject", (tx) =>
      this.rpcJson(
        tx,
        Prisma.sql`SELECT hr_reject_vacation_request(${id}::uuid, ${dto.note ?? null}, ${email}) AS v`,
      ),
    );
  }

  vacationReschedule(email: string, id: string, dto: D.RescheduleVacationDto) {
    return this.mutate(email, dto.clientEventId, "kadr.vacation.reschedule", (tx) =>
      this.rpcJson(
        tx,
        Prisma.sql`SELECT hr_reschedule_vacation_request(${id}::uuid, ${dto.dateFrom}::date, ${dto.dateTo}::date, ${dto.daysCount}::int, ${email}) AS v`,
      ),
    );
  }

  /** ⚠️ Deljen sa Talasom D (Moj profil) — G ne menja potpis (G7), samo poziva. */
  vacationRevise(email: string, id: string, dto: D.ReviseVacationDto) {
    return this.mutate(email, dto.clientEventId, "kadr.vacation.revise", (tx) =>
      this.rpcJson(
        tx,
        Prisma.sql`SELECT hr_revise_vacation_request(${id}::uuid, ${dto.dateFrom}::date, ${dto.dateTo}::date, ${dto.daysCount}::int, ${dto.note ?? null}, ${email}, ${dto.forceReapproval ?? false}) AS v`,
      ),
    );
  }

  vacationCancel(email: string, id: string, dto: D.OptIdempotentDto) {
    return this.mutate(email, dto.clientEventId, "kadr.vacation.cancel", (tx) =>
      this.rpcJson(tx, Prisma.sql`SELECT hr_cancel_vacation_request(${id}::uuid, ${email}) AS v`),
    );
  }

  vacationDelete(email: string, id: string, dto: D.OptIdempotentDto) {
    return this.mutate(email, dto.clientEventId, "kadr.vacation.delete", (tx) =>
      this.rpcJson(tx, Prisma.sql`SELECT hr_delete_vacation_request(${id}::uuid, ${email}) AS v`),
    );
  }

  /** saveEntitlement — upsert akrual/salda (can_edit_vacation_balance; RLS presuđuje).
   *  Nema jedinstvenog RPC-a → find+create/update (composite emp+year nije @@unique). */
  saveEntitlement(email: string, dto: D.SaveEntitlementDto) {
    return this.create(email, dto.clientEventId, "kadr.entitlement.save", async (tx) => {
      const existing = await tx.vacationEntitlement.findFirst({
        where: { employeeId: dto.employeeId, year: dto.year },
      });
      const data = {
        daysTotal: dto.daysTotal,
        ...(dto.daysCarriedOver != null ? { daysCarriedOver: dto.daysCarriedOver } : {}),
        ...(dto.openingUsed != null ? { openingUsed: dto.openingUsed } : {}),
        ...(dto.accrualModel != null ? { accrualModel: dto.accrualModel } : {}),
        ...(dto.accrualBase != null ? { accrualBase: dto.accrualBase } : {}),
        ...(dto.accrualStart ? { accrualStart: this.date(dto.accrualStart) } : {}),
        ...(dto.note != null ? { note: dto.note } : {}),
      };
      if (existing) {
        return tx.vacationEntitlement.update({ where: { id: existing.id }, data });
      }
      return tx.vacationEntitlement.create({
        data: {
          employeeId: dto.employeeId,
          year: dto.year,
          daysTotal: dto.daysTotal,
          daysCarriedOver: dto.daysCarriedOver ?? 0,
          openingUsed: dto.openingUsed ?? 0,
          accrualModel: dto.accrualModel ?? false,
          accrualBase: dto.accrualBase ?? 20,
          advanceApproved: false,
          ...(dto.accrualStart ? { accrualStart: this.date(dto.accrualStart) } : {}),
          ...(dto.note != null ? { note: dto.note } : {}),
        },
      });
    });
  }

  correctBalance(email: string, dto: D.CorrectBalanceDto) {
    return this.mutate(email, dto.clientEventId, "kadr.entitlement.correct", (tx) =>
      this.rpcJson(
        tx,
        Prisma.sql`SELECT hr_correct_vacation_balance(${dto.employeeId}::uuid, ${dto.year}::int, ${dto.targetRemaining}::int, ${dto.accrual ?? 20}::int) AS v`,
      ),
    );
  }

  setAdvanceApproval(email: string, dto: D.AdvanceApprovalDto) {
    return this.mutate(email, dto.clientEventId, "kadr.entitlement.advance", (tx) =>
      this.rpcJson(
        tx,
        Prisma.sql`SELECT hr_set_advance_approval(${dto.employeeId}::uuid, ${dto.year}::int, ${dto.approved}::boolean, ${dto.note ?? null}) AS v`,
      ),
    );
  }

  rollover(email: string, dto: D.RolloverDto) {
    return this.mutate(email, dto.clientEventId, "kadr.vacation.rollover", (tx) =>
      this.rpcJson(
        tx,
        Prisma.sql`SELECT hr_rollover_year(${dto.fromYear}::int, ${dto.toYear}::int, ${dto.dryRun ?? true}::boolean) AS v`,
      ),
    );
  }

  grantBonusGo(email: string, dto: D.BonusGoDto) {
    return this.create(email, dto.clientEventId, "kadr.vacation.bonus", (tx) =>
      this.rpcJson(
        tx,
        Prisma.sql`SELECT kadr_grant_bonus_go(${dto.employeeId}::uuid, ${dto.workDate}::date, ${dto.days ?? 1}::numeric, ${dto.reason ?? ""}, ${dto.makeupRequestId ?? null}::uuid) AS v`,
      ),
    );
  }

  /* Nadoknada */
  makeupApprove(email: string, id: string, dto: D.OptIdempotentDto) {
    return this.mutate(email, dto.clientEventId, "kadr.makeup.approve", (tx) =>
      this.rpcJson(tx, Prisma.sql`SELECT makeup_approve(${id}::uuid, ${email}) AS v`),
    );
  }
  makeupReject(email: string, id: string, dto: D.RejectDto) {
    return this.mutate(email, dto.clientEventId, "kadr.makeup.reject", (tx) =>
      this.rpcJson(tx, Prisma.sql`SELECT makeup_reject(${id}::uuid, ${dto.note ?? null}, ${email}) AS v`),
    );
  }
  makeupComplete(email: string, id: string, dto: D.OptIdempotentDto) {
    return this.mutate(email, dto.clientEventId, "kadr.makeup.complete", (tx) =>
      this.rpcJson(tx, Prisma.sql`SELECT makeup_complete(${id}::uuid, ${email}) AS v`),
    );
  }
  makeupStorno(email: string, id: string, dto: D.StornoMakeupDto) {
    return this.mutate(email, dto.clientEventId, "kadr.makeup.storno", (tx) =>
      this.rpcJson(tx, Prisma.sql`SELECT kadr_storno_makeup(${id}::uuid, ${dto.note ?? ""}) AS v`),
    );
  }
  makeupDelete(email: string, id: string, dto: D.OptIdempotentDto) {
    return this.mutate(email, dto.clientEventId, "kadr.makeup.delete", (tx) =>
      this.rpcJson(tx, Prisma.sql`SELECT kadr_delete_makeup(${id}::uuid) AS v`),
    );
  }

  /* Plaćeno odsustvo */
  paidLeaveApprove(email: string, id: string, dto: D.OptIdempotentDto) {
    return this.mutate(email, dto.clientEventId, "kadr.paidleave.approve", (tx) =>
      this.rpcJson(tx, Prisma.sql`SELECT paid_leave_approve(${id}::uuid, ${email}) AS v`),
    );
  }
  paidLeaveReject(email: string, id: string, dto: D.RejectDto) {
    return this.mutate(email, dto.clientEventId, "kadr.paidleave.reject", (tx) =>
      this.rpcJson(tx, Prisma.sql`SELECT paid_leave_reject(${id}::uuid, ${dto.note ?? null}, ${email}) AS v`),
    );
  }
  paidLeaveDelete(email: string, id: string, dto: D.OptIdempotentDto) {
    return this.mutate(email, dto.clientEventId, "kadr.paidleave.delete", (tx) =>
      this.rpcJson(tx, Prisma.sql`SELECT paid_leave_delete(${id}::uuid) AS v`),
    );
  }

  /* Neplaćeno (nop) — SAMO admin (RPC interni guard + endpoint admin) */
  nopApprove(email: string, id: string, dto: D.OptIdempotentDto) {
    return this.mutate(email, dto.clientEventId, "kadr.nop.approve", (tx) =>
      this.rpcJson(tx, Prisma.sql`SELECT approve_nop_request(${id}::uuid) AS v`),
    );
  }
  nopReject(email: string, id: string, dto: D.RejectDto) {
    return this.mutate(email, dto.clientEventId, "kadr.nop.reject", (tx) =>
      this.rpcJson(tx, Prisma.sql`SELECT reject_nop_request(${id}::uuid, ${dto.note ?? null}) AS v`),
    );
  }

  /* Odsustva CRUD (Prisma; RLS admin∨hr∨edit∧manages; `neplaceno`=admin) */
  createAbsence(email: string, dto: D.CreateAbsenceDto) {
    return this.create(email, dto.clientEventId, "kadr.absence.create", (tx) =>
      tx.absence.create({
        data: {
          employeeId: dto.employeeId,
          type: dto.type,
          dateFrom: this.date(dto.dateFrom)!,
          dateTo: this.date(dto.dateTo)!,
          daysCount: dto.daysCount ?? null,
          paidReason: dto.paidReason ?? null,
          absenceSubtype: dto.absenceSubtype ?? null,
          slobodanReason: dto.slobodanReason ?? null,
          note: dto.note ?? null,
        },
      }),
    );
  }
  updateAbsence(email: string, id: string, dto: D.UpdateAbsenceDto) {
    return this.mutate(email, undefined, "kadr.absence.update", (tx) =>
      this.requireRows(
        tx.absence.updateMany({
          where: { id },
          data: {
            ...(dto.type != null ? { type: dto.type } : {}),
            ...(dto.dateFrom ? { dateFrom: this.date(dto.dateFrom)! } : {}),
            ...(dto.dateTo ? { dateTo: this.date(dto.dateTo)! } : {}),
            ...(dto.daysCount !== undefined ? { daysCount: dto.daysCount } : {}),
            ...(dto.paidReason !== undefined ? { paidReason: dto.paidReason } : {}),
            ...(dto.absenceSubtype !== undefined ? { absenceSubtype: dto.absenceSubtype } : {}),
            ...(dto.slobodanReason !== undefined ? { slobodanReason: dto.slobodanReason } : {}),
            ...(dto.note !== undefined ? { note: dto.note } : {}),
          },
        }),
        "Odsustvo",
      ),
    );
  }
  deleteAbsence(email: string, id: string) {
    return this.mutate(email, undefined, "kadr.absence.delete", (tx) =>
      this.requireRows(tx.absence.deleteMany({ where: { id } }), "Odsustvo"),
    );
  }

  // ==========================================================================
  // SATI
  // ==========================================================================

  /** Mesečni grid batch upsert (hr_upsert_work_hours_batch; can_edit_kadrovska_grid).
   *  ON CONFLICT(emp,date) DO UPDATE → naturalno idempotentno; clientEventId opcioni. */
  gridBatch(email: string, dto: D.GridBatchDto) {
    const rows = dto.rows.map((r) => ({
      employee_id: r.employeeId,
      work_date: r.workDate,
      hours: r.hours ?? 0,
      overtime_hours: r.overtimeHours ?? 0,
      field_hours: r.fieldHours ?? 0,
      field_subtype: r.fieldSubtype ?? null,
      two_machine_hours: r.twoMachineHours ?? 0,
      absence_code: r.absenceCode ?? null,
      absence_subtype: r.absenceSubtype ?? null,
      note: r.note ?? "",
      project_ref: r.projectRef ?? "",
    }));
    return this.mutate(email, dto.clientEventId, "kadr.grid.batch", (tx) =>
      this.rpcJson(
        tx,
        Prisma.sql`SELECT hr_upsert_work_hours_batch(${JSON.stringify(rows)}::jsonb) AS v`,
      ),
    );
  }

  /** GO set/unset u grid (kadr_grid_set_go/unset_go — DEFINER bez sopstvenog gejta;
   *  endpoint guard grid_edit je gejt, pravilo 18). Vraća broj izmenjenih dana. */
  gridSetGo(email: string, dto: D.GridGoDto) {
    return this.mutate(email, dto.clientEventId, "kadr.grid.set_go", (tx) =>
      this.rpcScalar(
        tx,
        Prisma.sql`SELECT kadr_grid_set_go(${dto.employeeId}::uuid, ${dto.dateFrom}::date, ${dto.dateTo}::date, ${email}) AS v`,
      ),
    );
  }
  gridUnsetGo(email: string, dto: D.GridGoDto) {
    return this.mutate(email, dto.clientEventId, "kadr.grid.unset_go", (tx) =>
      this.rpcScalar(
        tx,
        Prisma.sql`SELECT kadr_grid_unset_go(${dto.employeeId}::uuid, ${dto.dateFrom}::date, ${dto.dateTo}::date) AS v`,
      ),
    );
  }

  /** Istorija izmena grida (kadr_work_hours_audit) — id bigint→Number.
   *  „↩ Vrati" nema RPC (front re-upsertuje old_data kroz grid/batch) → TODO R3. */
  gridAudit(email: string, employeeId?: string, from?: string, to?: string) {
    return this.mutate(email, undefined, "kadr.grid.audit", async (tx) => {
      const rows = await tx.$queryRaw<Record<string, unknown>[]>(
        Prisma.sql`SELECT * FROM kadr_work_hours_audit(${employeeId ?? null}::uuid, ${from ?? null}::date, ${to ?? null}::date, 300::int)`,
      );
      return rows.map((r) => ({ ...r, id: r.id == null ? null : Number(r.id) }));
    });
  }

  /* Primedbe (self create; manager resolve) */
  createRemark(email: string, dto: D.CreateRemarkDto) {
    return this.create(email, dto.clientEventId, "kadr.remark.create", (tx) =>
      tx.workHoursRemark.create({
        data: {
          employeeId: dto.employeeId,
          year: dto.year,
          month: dto.month,
          note: dto.note,
          status: "open",
        },
      }),
    );
  }
  resolveRemark(email: string, id: string, dto: D.ResolveRemarkDto) {
    return this.mutate(email, dto.clientEventId, "kadr.remark.resolve", (tx) =>
      this.requireRows(
        tx.workHoursRemark.updateMany({
          where: { id },
          data: {
            status: dto.status ?? "resolved",
            resolvedBy: email,
            resolvedAt: new Date(),
          },
        }),
        "Primedba",
      ),
    );
  }

  /* Prisustvo korekcije (attendance_submit_correction — deljen sa D; cancel) */
  submitCorrection(email: string, dto: D.SubmitCorrectionDto) {
    return this.mutate(email, dto.clientEventId, "kadr.attendance.correction", (tx) =>
      this.rpcJson(
        tx,
        Prisma.sql`SELECT attendance_submit_correction(${dto.employeeId}::uuid, ${dto.day}::date, ${dto.in ?? null}::time, ${dto.out ?? null}::time, ${dto.reason ?? null}) AS v`,
      ),
    );
  }
  cancelCorrection(email: string, id: string, dto: D.OptIdempotentDto) {
    return this.mutate(email, dto.clientEventId, "kadr.attendance.cancel_correction", (tx) =>
      this.rpcJson(tx, Prisma.sql`SELECT attendance_cancel_correction(${id}::uuid) AS v`),
    );
  }

  /* Dopunski primaoci prisustva (Prisma; hr_or_admin) */
  addExtraRecipient(email: string, dto: D.ExtraRecipientDto) {
    return this.create(email, dto.clientEventId, "kadr.attendance.extra_add", (tx) =>
      tx.attendanceNotifyExtra.create({
        data: {
          email: dto.email,
          subDepartmentId: dto.subDepartmentId ?? null,
          note: dto.note ?? null,
        },
      }),
    );
  }
  deleteExtraRecipient(email: string, id: string) {
    return this.mutate(email, undefined, "kadr.attendance.extra_del", (tx) =>
      this.requireRows(
        tx.attendanceNotifyExtra.deleteMany({ where: { id } }),
        "Primalac",
      ),
    );
  }

  // ==========================================================================
  // ZAPOSLENI
  // ==========================================================================

  createEmployee(email: string, dto: D.CreateEmployeeDto) {
    return this.create(email, dto.clientEventId, "kadr.employee.create", (tx) =>
      tx.employee.create({
        data: {
          fullName: dto.fullName,
          workType: dto.workType,
          position: dto.position ?? null,
          department: dto.department ?? null,
          departmentId: dto.departmentId ?? null,
          subDepartmentId: dto.subDepartmentId ?? null,
          positionId: dto.positionId ?? null,
          team: dto.team ?? null,
          phone: dto.phone ?? null,
          email: dto.email ?? null,
          hireDate: dto.hireDate ? this.date(dto.hireDate) : null,
          isActive: dto.isActive ?? true,
          note: dto.note ?? null,
        },
      }),
    );
  }

  /** hr_update_employee(p_id, p_patch, p_expected_updated_at) — optimistic lock.
   *  RPC vraća {applied:false, reason:'stale'} bez raise → mapiramo u 409. */
  updateEmployee(email: string, id: string, dto: D.UpdateEmployeeDto) {
    return this.mutate(email, undefined, "kadr.employee.update", async (tx) => {
      // Optimistic token: klijentski (ms) usklađen na punu µs vrednost iz baze.
      const expected = this.reconcileToken(
        dto.expectedUpdatedAt,
        await this.fullPrecUpdatedAt(tx, "employees", id),
      );
      const res = await this.rpcJson(
        tx,
        Prisma.sql`SELECT hr_update_employee(${id}::uuid, ${JSON.stringify(dto.patch)}::jsonb, ${expected}::timestamptz) AS v`,
      );
      this.assertApplied(res, "Zaposleni je u međuvremenu izmenjen");
      return res;
    });
  }

  /** Deaktivacija = hr_update_employee patch {is_active:false}; primeni na tekućem
   *  stanju (server čita PUNU µs updated_at → RPC exact-eq prolazi). */
  deactivateEmployee(email: string, id: string, dto: D.OptIdempotentDto) {
    return this.mutate(email, dto.clientEventId, "kadr.employee.deactivate", async (tx) => {
      const token = await this.fullPrecUpdatedAt(tx, "employees", id);
      if (token === null) throw new NotFoundException(`Zaposleni ${id} ne postoji`);
      const res = await this.rpcJson(
        tx,
        Prisma.sql`SELECT hr_update_employee(${id}::uuid, ${JSON.stringify({ is_active: false })}::jsonb, ${token}::timestamptz) AS v`,
      );
      this.assertApplied(res, "Zaposleni je u međuvremenu izmenjen");
      return res;
    });
  }

  /** Admin purge — hard delete (endpoint guard admin; RLS DELETE admin/hr). */
  purgeEmployee(email: string, id: string) {
    return this.mutate(email, undefined, "kadr.employee.purge", (tx) =>
      this.requireRows(tx.employee.deleteMany({ where: { id } }), "Zaposleni"),
    );
  }

  /* PII pod-resursi (kadrovska.pii; RLS can_manage_employee_pii je drugi sloj) */
  createChild(email: string, empId: string, dto: D.CreateChildDto) {
    return this.create(email, dto.clientEventId, "kadr.child.create", (tx) =>
      tx.employeeChild.create({
        data: {
          employeeId: empId,
          firstName: dto.firstName,
          birthDate: dto.birthDate ? this.date(dto.birthDate) : null,
          note: dto.note ?? null,
        },
      }),
    );
  }
  updateChild(email: string, id: string, dto: D.UpdateChildDto) {
    return this.mutate(email, undefined, "kadr.child.update", (tx) =>
      this.requireRows(
        tx.employeeChild.updateMany({
          where: { id },
          data: {
            ...(dto.firstName != null ? { firstName: dto.firstName } : {}),
            ...(dto.birthDate ? { birthDate: this.date(dto.birthDate) } : {}),
            ...(dto.note !== undefined ? { note: dto.note } : {}),
          },
        }),
        "Dete",
      ),
    );
  }
  deleteChild(email: string, id: string) {
    return this.mutate(email, undefined, "kadr.child.delete", (tx) =>
      this.requireRows(tx.employeeChild.deleteMany({ where: { id } }), "Dete"),
    );
  }

  createBankCard(email: string, empId: string, dto: D.CreateBankCardDto) {
    return this.create(email, dto.clientEventId, "kadr.bankcard.create", (tx) =>
      tx.employeeBankCard.create({
        data: {
          employeeId: empId,
          bank: dto.bank,
          cardNumber: dto.cardNumber ?? null,
          validThru: dto.validThru ? this.date(dto.validThru) : null,
          isActive: dto.isActive ?? true,
          note: dto.note ?? null,
        },
      }),
    );
  }
  updateBankCard(email: string, id: string, dto: D.UpdateBankCardDto) {
    return this.mutate(email, undefined, "kadr.bankcard.update", (tx) =>
      this.requireRows(
        tx.employeeBankCard.updateMany({
          where: { id },
          data: {
            ...(dto.bank != null ? { bank: dto.bank } : {}),
            ...(dto.cardNumber !== undefined ? { cardNumber: dto.cardNumber } : {}),
            ...(dto.validThru ? { validThru: this.date(dto.validThru) } : {}),
            ...(dto.isActive != null ? { isActive: dto.isActive } : {}),
            ...(dto.note !== undefined ? { note: dto.note } : {}),
          },
        }),
        "Kartica",
      ),
    );
  }
  deleteBankCard(email: string, id: string) {
    return this.mutate(email, undefined, "kadr.bankcard.delete", (tx) =>
      this.requireRows(tx.employeeBankCard.deleteMany({ where: { id } }), "Kartica"),
    );
  }

  /** Strani dokumenti (dinamička polja) — Prisma create sa mapiranjem snake→model. */
  createForeignDoc(email: string, empId: string, dto: D.CreatePiiDocDto) {
    return this.create(email, dto.clientEventId, "kadr.foreigndoc.create", (tx) =>
      tx.employeeForeignDoc.create({
        data: { employeeId: empId, ...this.mapForeign(dto.data) },
      }),
    );
  }
  updateForeignDoc(email: string, id: string, dto: D.UpdatePiiDocDto) {
    return this.mutate(email, undefined, "kadr.foreigndoc.update", (tx) =>
      this.requireRows(
        tx.employeeForeignDoc.updateMany({ where: { id }, data: this.mapForeign(dto.data) }),
        "Strani dokument",
      ),
    );
  }
  deleteForeignDoc(email: string, id: string) {
    return this.mutate(email, undefined, "kadr.foreigndoc.delete", (tx) =>
      this.requireRows(tx.employeeForeignDoc.deleteMany({ where: { id } }), "Strani dokument"),
    );
  }

  createPersonalDoc(email: string, empId: string, dto: D.CreatePiiDocDto) {
    return this.create(email, dto.clientEventId, "kadr.personaldoc.create", (tx) =>
      tx.employeePersonalDoc.create({
        data: { employeeId: empId, ...this.mapPersonal(dto.data) },
      }),
    );
  }
  updatePersonalDoc(email: string, id: string, dto: D.UpdatePiiDocDto) {
    return this.mutate(email, undefined, "kadr.personaldoc.update", (tx) =>
      this.requireRows(
        tx.employeePersonalDoc.updateMany({ where: { id }, data: this.mapPersonal(dto.data) }),
        "Lični dokument",
      ),
    );
  }
  deletePersonalDoc(email: string, id: string) {
    return this.mutate(email, undefined, "kadr.personaldoc.delete", (tx) =>
      this.requireRows(tx.employeePersonalDoc.deleteMany({ where: { id } }), "Lični dokument"),
    );
  }

  /* Medical / Certs (kadrovska.manage; RLS hr_or_admin∨poslovni_admin) */
  createMedical(email: string, empId: string, dto: D.CreateMedicalDto) {
    return this.create(email, dto.clientEventId, "kadr.medical.create", (tx) =>
      tx.kadrMedicalExam.create({
        data: {
          employeeId: empId,
          examDate: this.date(dto.examDate)!,
          examType: dto.examType,
          validUntil: dto.validUntil ? this.date(dto.validUntil) : null,
          institution: dto.institution ?? null,
          costRsd: dto.costRsd ?? 0,
          documentUrl: dto.documentUrl ?? null,
          note: dto.note ?? null,
        },
      }),
    );
  }
  updateMedical(email: string, id: string, dto: D.UpdateMedicalDto) {
    return this.mutate(email, undefined, "kadr.medical.update", (tx) =>
      this.requireRows(
        tx.kadrMedicalExam.updateMany({
          where: { id },
          data: {
            ...(dto.examDate ? { examDate: this.date(dto.examDate)! } : {}),
            ...(dto.examType != null ? { examType: dto.examType } : {}),
            ...(dto.validUntil ? { validUntil: this.date(dto.validUntil) } : {}),
            ...(dto.institution !== undefined ? { institution: dto.institution } : {}),
            ...(dto.costRsd != null ? { costRsd: dto.costRsd } : {}),
            ...(dto.documentUrl !== undefined ? { documentUrl: dto.documentUrl } : {}),
            ...(dto.note !== undefined ? { note: dto.note } : {}),
          },
        }),
        "Lekarski pregled",
      ),
    );
  }
  deleteMedical(email: string, id: string) {
    return this.mutate(email, undefined, "kadr.medical.delete", (tx) =>
      this.requireRows(tx.kadrMedicalExam.deleteMany({ where: { id } }), "Lekarski pregled"),
    );
  }

  createCert(email: string, empId: string, dto: D.CreateCertDto) {
    return this.create(email, dto.clientEventId, "kadr.cert.create", (tx) =>
      tx.kadrCertificate.create({
        data: {
          employeeId: empId,
          certType: dto.certType,
          certName: dto.certName,
          issuedOn: this.date(dto.issuedOn)!,
          expiresOn: dto.expiresOn ? this.date(dto.expiresOn) : null,
          issuer: dto.issuer ?? null,
          documentNo: dto.documentNo ?? null,
          costRsd: dto.costRsd ?? 0,
          documentUrl: dto.documentUrl ?? null,
          note: dto.note ?? null,
        },
      }),
    );
  }
  updateCert(email: string, id: string, dto: D.UpdateCertDto) {
    return this.mutate(email, undefined, "kadr.cert.update", (tx) =>
      this.requireRows(
        tx.kadrCertificate.updateMany({
          where: { id },
          data: {
            ...(dto.certType != null ? { certType: dto.certType } : {}),
            ...(dto.certName != null ? { certName: dto.certName } : {}),
            ...(dto.issuedOn ? { issuedOn: this.date(dto.issuedOn)! } : {}),
            ...(dto.expiresOn ? { expiresOn: this.date(dto.expiresOn) } : {}),
            ...(dto.issuer !== undefined ? { issuer: dto.issuer } : {}),
            ...(dto.documentNo !== undefined ? { documentNo: dto.documentNo } : {}),
            ...(dto.costRsd != null ? { costRsd: dto.costRsd } : {}),
            ...(dto.documentUrl !== undefined ? { documentUrl: dto.documentUrl } : {}),
            ...(dto.note !== undefined ? { note: dto.note } : {}),
          },
        }),
        "Sertifikat",
      ),
    );
  }
  deleteCert(email: string, id: string) {
    return this.mutate(email, undefined, "kadr.cert.delete", (tx) =>
      this.requireRows(tx.kadrCertificate.deleteMany({ where: { id } }), "Sertifikat"),
    );
  }

  /* Ugovori (kadrovska.edit) */
  createContract(email: string, empId: string, dto: D.CreateContractDto) {
    return this.create(email, dto.clientEventId, "kadr.contract.create", (tx) =>
      tx.contract.create({
        data: {
          employeeId: empId,
          contractType: dto.contractType,
          dateFrom: this.date(dto.dateFrom)!,
          dateTo: dto.dateTo ? this.date(dto.dateTo) : null,
          contractNumber: dto.contractNumber ?? null,
          position: dto.position ?? null,
          probniRad: dto.probniRad ?? false,
          probniMeseci: dto.probniMeseci ?? null,
          isActive: dto.isActive ?? true,
          note: dto.note ?? null,
        },
      }),
    );
  }
  updateContract(email: string, id: string, dto: D.UpdateContractDto) {
    return this.mutate(email, undefined, "kadr.contract.update", (tx) =>
      this.requireRows(
        tx.contract.updateMany({
          where: { id },
          data: {
            ...(dto.contractType != null ? { contractType: dto.contractType } : {}),
            ...(dto.dateFrom ? { dateFrom: this.date(dto.dateFrom)! } : {}),
            ...(dto.dateTo ? { dateTo: this.date(dto.dateTo) } : {}),
            ...(dto.contractNumber !== undefined ? { contractNumber: dto.contractNumber } : {}),
            ...(dto.position !== undefined ? { position: dto.position } : {}),
            ...(dto.probniRad != null ? { probniRad: dto.probniRad } : {}),
            ...(dto.probniMeseci !== undefined ? { probniMeseci: dto.probniMeseci } : {}),
            ...(dto.isActive != null ? { isActive: dto.isActive } : {}),
            ...(dto.note !== undefined ? { note: dto.note } : {}),
          },
        }),
        "Ugovor",
      ),
    );
  }
  archiveContract(email: string, id: string, restore: boolean) {
    return this.mutate(email, undefined, restore ? "kadr.contract.restore" : "kadr.contract.archive", (tx) =>
      this.requireRows(
        tx.contract.updateMany({
          where: { id },
          data: restore
            ? { archivedAt: null, archivedBy: null }
            : { archivedAt: new Date() },
        }),
        "Ugovor",
      ),
    );
  }
  /** kadr_set_contract_salary — piše salary_terms (admin; endpoint guard salary). */
  setContractSalary(email: string, empId: string, dto: D.ContractSalaryDto) {
    return this.mutate(email, dto.clientEventId, "kadr.contract.salary", (tx) =>
      this.rpcJson(
        tx,
        Prisma.sql`SELECT kadr_set_contract_salary(${empId}::uuid, ${dto.neto}::numeric, ${dto.bruto}::numeric, ${dto.effectiveFrom ?? new Date().toISOString().slice(0, 10)}::date, ${email}) AS v`,
      ),
    );
  }

  /* Uvođenje / Izlazak (kadrovska.manage) */
  onboardingStart(email: string, dto: D.OnboardingStartDto) {
    return this.create(email, dto.clientEventId, "kadr.onboarding.start", (tx) =>
      this.rpcScalar(
        tx,
        Prisma.sql`SELECT kadr_onboarding_start(${dto.employeeId}::uuid, ${dto.templateId}::uuid, ${dto.startDate ?? null}::date) AS v`,
      ),
    );
  }
  onboardingTask(email: string, id: string, dto: D.OnboardingTaskDto) {
    return this.mutate(email, undefined, "kadr.onboarding.task", (tx) =>
      this.requireRows(
        tx.kadrOnboardingTask.updateMany({
          where: { id },
          data: {
            ...(dto.status != null ? { status: dto.status } : {}),
            ...(dto.done != null
              ? { status: dto.done ? "done" : "pending", doneAt: dto.done ? new Date() : null, doneBy: dto.done ? email : null }
              : {}),
            ...(dto.note !== undefined ? { note: dto.note } : {}),
          },
        }),
        "Zadatak",
      ),
    );
  }
  /** „✓ Završi tok" / „Otkaži tok" (1.0 setOnbRunStatus) — run.status done/canceled.
   *  RLS p_onb_runs_manage (kadr_can_manage_hr) presuđuje; 0 redova → 403. */
  onboardingRunStatus(email: string, id: string, dto: D.OnboardingRunStatusDto) {
    return this.mutate(email, dto.clientEventId, "kadr.onboarding.run_status", (tx) =>
      this.requireRows(
        tx.kadrOnboardingRun.updateMany({
          where: { id },
          data: { status: dto.status },
        }),
        "Tok",
      ),
    );
  }
  /** Šabloni CRUD (1.0 createOnbTemplate/deleteOnbTemplate) — RLS kadr_can_manage_hr. */
  createOnbTemplate(email: string, dto: D.CreateOnbTemplateDto) {
    return this.create(email, dto.clientEventId, "kadr.onboarding.template_create", (tx) =>
      tx.kadrOnboardingTemplate.create({
        data: { name: dto.name, kind: dto.kind, isActive: true, createdBy: email },
      }),
    );
  }
  /** Brisanje šablona: stavke idu CASCADE, POKRENUTI TOKOVI OSTAJU (runs.template_id
   *  FK SET NULL — izmereno na živoj bazi; 1.0 poruka „Pokrenuti tokovi ostaju"). */
  deleteOnbTemplate(email: string, id: string) {
    return this.mutate(email, undefined, "kadr.onboarding.template_delete", (tx) =>
      this.requireRows(tx.kadrOnboardingTemplate.deleteMany({ where: { id } }), "Šablon"),
    );
  }
  createOnbTemplateItem(email: string, dto: D.CreateOnbTemplateItemDto) {
    return this.create(email, dto.clientEventId, "kadr.onboarding.item_create", (tx) =>
      tx.kadrOnboardingTemplateItem.create({
        data: {
          templateId: dto.templateId,
          title: dto.title,
          description: dto.description ?? null,
          sortOrder: dto.sortOrder ?? 0,
          offsetDays: dto.offsetDays ?? 0,
          assigneeHint: dto.assigneeHint ?? null,
        },
      }),
    );
  }
  deleteOnbTemplateItem(email: string, id: string) {
    return this.mutate(email, undefined, "kadr.onboarding.item_delete", (tx) =>
      this.requireRows(
        tx.kadrOnboardingTemplateItem.deleteMany({ where: { id } }),
        "Stavka šablona",
      ),
    );
  }

  /* Razvoj / razgovori / 360 (kadrovska.dev_manage; self za neke) */
  createDevPlan(email: string, dto: D.CreateDevPlanDto) {
    return this.create(email, dto.clientEventId, "kadr.devplan.create", (tx) =>
      tx.developmentPlan.create({
        data: {
          employeeId: dto.employeeId,
          periodLabel: dto.periodLabel,
          periodStart: dto.periodStart ? this.date(dto.periodStart) : null,
          periodEnd: dto.periodEnd ? this.date(dto.periodEnd) : null,
          careerGoalMd: dto.careerGoalMd ?? null,
          targetPositionId: dto.targetPositionId ?? null,
          mentorEmployeeId: dto.mentorEmployeeId ?? null,
          status: dto.status ?? "aktivan",
          createdBy: email,
        },
      }),
    );
  }
  updateDevPlan(email: string, id: string, dto: D.UpdateDevPlanDto) {
    return this.mutate(email, undefined, "kadr.devplan.update", (tx) =>
      this.requireRows(
        tx.developmentPlan.updateMany({
          where: { id },
          data: {
            ...(dto.periodLabel != null ? { periodLabel: dto.periodLabel } : {}),
            ...(dto.periodStart ? { periodStart: this.date(dto.periodStart) } : {}),
            ...(dto.periodEnd ? { periodEnd: this.date(dto.periodEnd) } : {}),
            ...(dto.careerGoalMd !== undefined ? { careerGoalMd: dto.careerGoalMd } : {}),
            ...(dto.targetPositionId !== undefined ? { targetPositionId: dto.targetPositionId } : {}),
            ...(dto.mentorEmployeeId !== undefined ? { mentorEmployeeId: dto.mentorEmployeeId } : {}),
            ...(dto.summaryMd !== undefined ? { summaryMd: dto.summaryMd } : {}),
            ...(dto.selfAssessmentMd !== undefined ? { selfAssessmentMd: dto.selfAssessmentMd } : {}),
            ...(dto.status != null ? { status: dto.status } : {}),
            updatedBy: email,
            updatedAt: new Date(),
          },
        }),
        "Plan razvoja",
      ),
    );
  }
  /** Brisanje plana (1.0 deletePlan — admin dugme; RLS dp_delete=admin): CILJEVI OSTAJU
   *  i odvezuju se (employee_expectations.plan_id FK SET NULL — izmereno), check-ins
   *  se brišu (FK CASCADE). Endpoint guard = kadrovska.admin (1.0 kaže admin). */
  deleteDevPlan(email: string, id: string) {
    return this.mutate(email, undefined, "kadr.devplan.delete", (tx) =>
      this.requireRows(tx.developmentPlan.deleteMany({ where: { id } }), "Plan razvoja"),
    );
  }
  createCheckin(email: string, planId: string, dto: D.CreateCheckinDto) {
    return this.create(email, dto.clientEventId, "kadr.checkin.create", (tx) =>
      tx.developmentCheckin.create({
        data: {
          planId,
          employeeId: dto.employeeId,
          checkinDate: this.date(dto.checkinDate)!,
          authorEmail: email,
          authorKind: dto.authorKind ?? "manager",
          noteMd: dto.noteMd ?? null,
        },
      }),
    );
  }
  /** Brisanje beleške 1-na-1 (1.0 deleteCheckin) — RLS dc_delete: autor ∨ manages_dev_plan. */
  deleteCheckin(email: string, id: string) {
    return this.mutate(email, undefined, "kadr.checkin.delete", (tx) =>
      this.requireRows(tx.developmentCheckin.deleteMany({ where: { id } }), "Beleška"),
    );
  }
  createExpectation(email: string, dto: D.CreateExpectationDto) {
    return this.create(email, dto.clientEventId, "kadr.expectation.create", (tx) =>
      tx.employeeExpectation.create({
        data: {
          employeeId: dto.employeeId,
          title: dto.title,
          category: dto.category,
          priority: dto.priority,
          status: "u_toku",
          descriptionMd: dto.descriptionMd ?? null,
          dueDate: dto.dueDate ? this.date(dto.dueDate) : null,
          planId: dto.planId ?? null,
          progress: 0,
          createdBy: email,
        },
      }),
    );
  }
  updateExpectation(email: string, id: string, dto: D.UpdateExpectationDto) {
    return this.mutate(email, undefined, "kadr.expectation.update", (tx) =>
      this.requireRows(
        tx.employeeExpectation.updateMany({
          where: { id },
          data: {
            ...(dto.title != null ? { title: dto.title } : {}),
            ...(dto.category != null ? { category: dto.category } : {}),
            ...(dto.priority != null ? { priority: dto.priority } : {}),
            ...(dto.status != null ? { status: dto.status } : {}),
            ...(dto.descriptionMd !== undefined ? { descriptionMd: dto.descriptionMd } : {}),
            ...(dto.dueDate ? { dueDate: this.date(dto.dueDate) } : {}),
            ...(dto.progress != null ? { progress: dto.progress } : {}),
            ...(dto.completionNote !== undefined ? { completionNote: dto.completionNote } : {}),
            updatedBy: email,
            updatedAt: new Date(),
          },
        }),
        "Očekivanje",
      ),
    );
  }
  /** Brisanje razvojnog cilja (1.0 deleteExpectation — admin dugme; RLS ee_delete=admin). */
  deleteExpectation(email: string, id: string) {
    return this.mutate(email, undefined, "kadr.expectation.delete", (tx) =>
      this.requireRows(tx.employeeExpectation.deleteMany({ where: { id } }), "Cilj"),
    );
  }
  createTalk(email: string, dto: D.CreateTalkDto) {
    // Odluka o zaradi važi SAMO za tip 'godisnji' (1.0 talksSection.js:264-267 šalje
    // null za ostale tipove) — review #24: raise_* se ignorišu na ne-godišnjem.
    const isGodisnji = dto.talkType === "godisnji";
    return this.create(email, dto.clientEventId, "kadr.talk.create", (tx) =>
      tx.employeeTalk.create({
        data: {
          employeeId: dto.employeeId,
          talkType: dto.talkType,
          talkDate: dto.talkDate ? this.date(dto.talkDate)! : new Date(),
          title: dto.title ?? null,
          zapisnikMd: dto.zapisnikMd ?? null,
          status: "nacrt",
          planId: dto.planId ?? null,
          raiseDecision: isGodisnji ? (dto.raiseDecision ?? null) : null,
          raisePercent: isGodisnji ? (dto.raisePercent ?? null) : null,
          raiseEffectiveFrom:
            isGodisnji && dto.raiseEffectiveFrom ? this.date(dto.raiseEffectiveFrom) : null,
          raiseNote: isGodisnji ? (dto.raiseNote ?? null) : null,
          createdBy: email,
          conductedBy: email,
        },
      }),
    );
  }
  /**
   * Review #24: EFEKTIVNI tip (DTO ∨ tekući red) odlučuje o raise_* — promena tipa
   * sa 'godisnji' na drugi FORSIRA sve četiri kolone na null (1.0 FE uvek šalje
   * raise ključeve, null za ne-godišnji; bez DB trigera koji bi ih čistio — izmereno).
   */
  updateTalk(email: string, id: string, dto: D.UpdateTalkDto) {
    return this.mutate(email, undefined, "kadr.talk.update", async (tx) => {
      let effType = dto.talkType ?? null;
      if (effType == null) {
        const cur = await tx.employeeTalk.findUnique({
          where: { id },
          select: { talkType: true },
        });
        effType = cur?.talkType ?? null;
      }
      const clearRaise = effType != null && effType !== "godisnji";
      return this.requireRows(
        tx.employeeTalk.updateMany({
          where: { id },
          data: {
            ...(dto.talkType != null ? { talkType: dto.talkType } : {}),
            ...(dto.talkDate ? { talkDate: this.date(dto.talkDate)! } : {}),
            ...(dto.title !== undefined ? { title: dto.title } : {}),
            ...(dto.zapisnikMd !== undefined ? { zapisnikMd: dto.zapisnikMd } : {}),
            ...(dto.status != null ? { status: dto.status } : {}),
            ...(clearRaise
              ? {
                  raiseDecision: null,
                  raisePercent: null,
                  raiseEffectiveFrom: null,
                  raiseNote: null,
                }
              : {
                  ...(dto.raiseDecision !== undefined ? { raiseDecision: dto.raiseDecision ?? null } : {}),
                  ...(dto.raisePercent !== undefined ? { raisePercent: dto.raisePercent ?? null } : {}),
                  ...(dto.raiseEffectiveFrom !== undefined
                    ? { raiseEffectiveFrom: dto.raiseEffectiveFrom ? this.date(dto.raiseEffectiveFrom) : null }
                    : {}),
                  ...(dto.raiseNote !== undefined ? { raiseNote: dto.raiseNote ?? null } : {}),
                }),
            updatedBy: email,
            updatedAt: new Date(),
          },
        }),
        "Razgovor",
      );
    });
  }
  /** Brisanje zapisnika (1.0 deleteTalk): nacrt = autor; podeljen/potvrđen = admin.
   *  Razlikovanje presuđuje sy15 RLS (endpoint gate = dev_manage); 0 redova → 403. */
  deleteTalk(email: string, id: string) {
    return this.mutate(email, undefined, "kadr.talk.delete", (tx) =>
      this.requireRows(tx.employeeTalk.deleteMany({ where: { id } }), "Razgovor"),
    );
  }
  talkShare(email: string, id: string, dto: D.OptIdempotentDto) {
    return this.mutate(email, dto.clientEventId, "kadr.talk.share", (tx) =>
      this.rpcJson(tx, Prisma.sql`SELECT talk_share(${id}::uuid) AS v`),
    );
  }
  talkUnshare(email: string, id: string, dto: D.OptIdempotentDto) {
    return this.mutate(email, dto.clientEventId, "kadr.talk.unshare", (tx) =>
      this.rpcJson(tx, Prisma.sql`SELECT talk_unshare(${id}::uuid) AS v`),
    );
  }
  /** ⚠️ Deljen sa D — G ne menja potpis (G7); zaposleni potvrđuje „Upoznat sam". */
  talkAcknowledge(email: string, id: string, dto: D.OptIdempotentDto) {
    return this.mutate(email, dto.clientEventId, "kadr.talk.ack", (tx) =>
      this.rpcJson(tx, Prisma.sql`SELECT talk_acknowledge(${id}::uuid) AS v`),
    );
  }
  /* Korektivni plan (1.0 saveCorrectivePlan/updateCorrectivePlan) */
  createCorrectivePlan(email: string, dto: D.CreateCorrectivePlanDto) {
    return this.create(email, dto.clientEventId, "kadr.cplan.create", (tx) =>
      tx.correctivePlan.create({
        data: {
          employeeId: dto.employeeId,
          talkId: dto.talkId ?? null,
          reasonMd: dto.reasonMd ?? null,
          // DB default 'otvoren'; FE ga ne šalje pri otvaranju iz razgovora.
          status: dto.status ?? "otvoren",
          followupDate: dto.followupDate ? this.date(dto.followupDate) : null,
          // visible_to_employee prati status razgovora (1.0: t.status !== 'nacrt').
          visibleToEmployee: dto.visibleToEmployee ?? false,
          createdBy: email,
        },
      }),
    );
  }
  updateCorrectivePlan(email: string, id: string, dto: D.UpdateCorrectivePlanDto) {
    return this.mutate(email, undefined, "kadr.cplan.update", (tx) =>
      this.requireRows(
        tx.correctivePlan.updateMany({
          where: { id },
          data: {
            ...(dto.reasonMd !== undefined ? { reasonMd: dto.reasonMd } : {}),
            ...(dto.status != null ? { status: dto.status } : {}),
            ...(dto.followupDate !== undefined
              ? { followupDate: dto.followupDate ? this.date(dto.followupDate) : null }
              : {}),
            ...(dto.closedAt !== undefined
              ? { closedAt: dto.closedAt ? new Date(dto.closedAt) : null }
              : {}),
            ...(dto.visibleToEmployee != null ? { visibleToEmployee: dto.visibleToEmployee } : {}),
            updatedAt: new Date(),
          },
        }),
        "Korektivni plan",
      ),
    );
  }

  createMeasure(email: string, dto: D.CreateMeasureDto) {
    return this.create(email, dto.clientEventId, "kadr.measure.create", (tx) =>
      tx.correctiveMeasure.create({
        data: {
          planId: dto.planId,
          descriptionMd: dto.descriptionMd,
          dueDate: dto.dueDate ? this.date(dto.dueDate) : null,
          responsibleEmployeeId: dto.responsibleEmployeeId ?? null,
          // 1.0 modal default = 'otvoreno' (DB default) — NE 'u_toku'; status-select šalje izbor.
          status: dto.status ?? "otvoreno",
          note: dto.note ?? null,
          sort: dto.sort ?? 0,
        },
      }),
    );
  }
  /**
   * 1.0 (talksSection.js:557): PROMENA ROKA resetuje escalated_at (nova šansa za
   * eskalacioni mejl). FE poredi stari↔novi datum; BE nema stari u DTO-u, pa ga
   * pročita u ISTOJ tx pre update-a i resetuje samo kad se rok stvarno promeni.
   */
  updateMeasure(email: string, id: string, dto: D.UpdateMeasureDto) {
    return this.mutate(email, undefined, "kadr.measure.update", async (tx) => {
      let resetEscalation = false;
      if (dto.dueDate !== undefined) {
        const cur = await tx.correctiveMeasure.findUnique({
          where: { id },
          select: { dueDate: true },
        });
        const newIso = dto.dueDate ? dto.dueDate.slice(0, 10) : null;
        const curIso = cur?.dueDate ? cur.dueDate.toISOString().slice(0, 10) : null;
        resetEscalation = newIso !== curIso;
      }
      return this.requireRows(
        tx.correctiveMeasure.updateMany({
          where: { id },
          data: {
            ...(dto.descriptionMd != null ? { descriptionMd: dto.descriptionMd } : {}),
            ...(dto.dueDate !== undefined
              ? { dueDate: dto.dueDate ? this.date(dto.dueDate) : null }
              : {}),
            ...(dto.responsibleEmployeeId !== undefined ? { responsibleEmployeeId: dto.responsibleEmployeeId } : {}),
            ...(dto.status != null ? { status: dto.status, ...(dto.status === "ispunjeno" ? { completedAt: new Date() } : {}) } : {}),
            ...(dto.note !== undefined ? { note: dto.note } : {}),
            ...(dto.sort != null ? { sort: dto.sort } : {}),
            ...(resetEscalation ? { escalatedAt: null } : {}),
            updatedAt: new Date(),
          },
        }),
        "Mera",
      );
    });
  }
  deleteMeasure(email: string, id: string) {
    return this.mutate(email, undefined, "kadr.measure.delete", (tx) =>
      this.requireRows(tx.correctiveMeasure.deleteMany({ where: { id } }), "Mera"),
    );
  }

  /* 360 procene (kadrovska.dev_manage; niko o sebi = RPC guard) */
  assessmentOpen360(email: string, dto: D.Open360Dto) {
    return this.create(email, dto.clientEventId, "kadr.assessment.open360", (tx) =>
      this.rpcScalar(
        tx,
        Prisma.sql`SELECT assessment_open_360(${dto.employeeId}::uuid, ${dto.period ?? null}, ${dto.peerEmployeeIds ?? []}::uuid[], ${dto.peerEmails ?? []}::text[], ${dto.cycle ?? null}::uuid) AS v`,
      ),
    );
  }
  assessmentOpenCampaign(email: string, dto: D.OpenCampaignDto) {
    return this.create(email, dto.clientEventId, "kadr.assessment.campaign", (tx) =>
      this.rpcScalar(
        tx,
        Prisma.sql`SELECT assessment_open_campaign(${dto.title}, ${dto.period}, ${dto.employeeIds}::uuid[]) AS v`,
      ),
    );
  }
  /** ⚠️ Deljen sa D (Moj profil samoprocena) — G ne menja potpis (G7). */
  assessmentOpenSelf(email: string, dto: D.OpenSelfDto) {
    return this.create(email, dto.clientEventId, "kadr.assessment.self_open", (tx) =>
      this.rpcScalar(tx, Prisma.sql`SELECT assessment_open_self(${dto.period ?? null}) AS v`),
    );
  }
  assessmentSelfSubmit(email: string, id: string, dto: D.OptIdempotentDto) {
    return this.mutate(email, dto.clientEventId, "kadr.assessment.self_submit", (tx) =>
      this.rpcVoid(tx, Prisma.sql`SELECT assessment_self_submit(${id}::uuid)`),
    );
  }
  assessmentSetTargets(email: string, id: string, dto: D.SetTargetsDto) {
    return this.mutate(email, dto.clientEventId, "kadr.assessment.set_targets", (tx) =>
      this.rpcVoid(tx, Prisma.sql`SELECT assessment_set_targets(${id}::uuid, ${JSON.stringify(dto.targets)}::jsonb)`),
    );
  }
  assessmentCompute(email: string, id: string, dto: D.OptIdempotentDto) {
    return this.mutate(email, dto.clientEventId, "kadr.assessment.compute", (tx) =>
      this.rpcVoid(tx, Prisma.sql`SELECT assessment_compute_results(${id}::uuid)`),
    );
  }
  assessmentGap(email: string, id: string, dto: D.GapToGoalsDto) {
    return this.mutate(email, dto.clientEventId, "kadr.assessment.gap", (tx) =>
      this.rpcScalar(
        tx,
        Prisma.sql`SELECT assessment_gap_to_goals(${id}::uuid, ${dto.source ?? "leader"}, ${dto.minGap ?? 1}::numeric) AS v`,
      ),
    );
  }
  assessmentShare(email: string, id: string, dto: D.OptIdempotentDto) {
    return this.mutate(email, dto.clientEventId, "kadr.assessment.share", (tx) =>
      this.rpcVoid(tx, Prisma.sql`SELECT assessment_share(${id}::uuid)`),
    );
  }
  assessmentUnshare(email: string, id: string, dto: D.OptIdempotentDto) {
    return this.mutate(email, dto.clientEventId, "kadr.assessment.unshare", (tx) =>
      this.rpcVoid(tx, Prisma.sql`SELECT assessment_unshare(${id}::uuid)`),
    );
  }
  assessmentClose(email: string, id: string, dto: D.OptIdempotentDto) {
    return this.mutate(email, dto.clientEventId, "kadr.assessment.close", (tx) =>
      this.rpcVoid(tx, Prisma.sql`SELECT assessment_close(${id}::uuid)`),
    );
  }
  assessmentReopen(email: string, id: string, dto: D.OptIdempotentDto) {
    return this.mutate(email, dto.clientEventId, "kadr.assessment.reopen", (tx) =>
      this.rpcVoid(tx, Prisma.sql`SELECT assessment_reopen(${id}::uuid)`),
    );
  }
  assessmentSetState(email: string, id: string, dto: D.SetStateDto) {
    return this.mutate(email, dto.clientEventId, "kadr.assessment.set_state", (tx) =>
      this.rpcVoid(tx, Prisma.sql`SELECT assessment_set_state(${id}::uuid, ${dto.status}, ${dto.visible}::boolean)`),
    );
  }

  /**
   * Upis ocena po rater id (1.0 saveScores: PostgREST upsert
   * `assessment_scores?on_conflict=rater_id,competence_id`) — rukovodilac upisuje SVOJE
   * leader ocene. RLS asc_write (rater = pozivalac ∧ status='collecting') presuđuje —
   * tuđi rater id → 42501 → 403. Recompute NE zovemo ovde (1.0 FE ga zove zasebno).
   */
  assessmentSaveScores(email: string, raterId: string, dto: D.SaveScoresDto) {
    return this.mutate(email, dto.clientEventId, "kadr.assessment.save_scores", async (tx) => {
      const values = dto.items.map(
        (it) =>
          Prisma.sql`(${raterId}::uuid, ${it.competenceId}::int, ${it.level ?? null}::smallint, ${it.comment ?? null})`,
      );
      const n = await tx.$executeRaw(Prisma.sql`
        INSERT INTO assessment_scores (rater_id, competence_id, level, comment)
        VALUES ${Prisma.join(values)}
        ON CONFLICT (rater_id, competence_id)
        DO UPDATE SET level = EXCLUDED.level, comment = EXCLUDED.comment`);
      return { upserted: n };
    });
  }

  /**
   * Email pozivnice ocenjivačima — PORT 1.0 edge fn `assessment-invite` (režimi:
   * jedna procena / ceo ciklus + rezime kreatoru). 2.0 šalje kroz MailService
   * (Resend direktno) umesto edge fn; bez RESEND_API_KEY → paritetni
   * `{ ok:false, reason:'resend_not_configured' }` (dry-run).
   *
   * Scope: čitanja/`invited_at` idu kroz withUserRls — umesto 1.0 service-role
   * gejta (admin/hr/menadzment) presuđuju RLS politike (as_select manages_dev_plan,
   * ar_write can_manage_assessment): admin/hr/menadzment vide sve (pun paritet),
   * pm/leadpm dobijaju svoj opseg (1.0 edge im je vraćao 401 — kontrolisani superset).
   */
  async assessmentInvite(
    email: string,
    opts: { assessmentId?: string; cycleId?: string; notifyCreator?: boolean },
  ) {
    const base = (process.env.ASSESSMENT_PUBLIC_BASE ?? "https://servosync.servoteh.com").replace(/\/+$/, "");

    // 1) READ faza (RLS): ciklus, ciljne procene, meta (ime zaposlenog + period), rateri.
    const read = await this.mutateRaw(email, undefined, "kadr.assessment.invite_read", async (tx) => {
      let cycle: { title: string; periodLabel: string; createdBy: string } | null = null;
      let assessmentIds: string[] = [];
      if (opts.cycleId) {
        const c = await tx.assessmentCycle.findUnique({ where: { id: opts.cycleId } });
        if (!c) throw new NotFoundException("Ciklus ne postoji ili nemate pravo");
        cycle = { title: c.title, periodLabel: c.periodLabel, createdBy: c.createdBy };
        const rows = await tx.assessment.findMany({
          where: { cycleId: opts.cycleId },
          select: { id: true },
        });
        assessmentIds = rows.map((r) => r.id);
      } else {
        assessmentIds = [opts.assessmentId!];
      }
      if (!assessmentIds.length) {
        return { cycle, assessmentIds, meta: new Map<string, { employeeName: string; period: string }>(), raters: [] as { id: string; assessmentId: string; raterKind: string; raterEmail: string | null; token: string | null }[] };
      }
      const metaRows = await tx.$queryRaw<
        { id: string; period_label: string; full_name: string | null }[]
      >(Prisma.sql`
        SELECT a.id, a.period_label, e.full_name
          FROM assessments a
          LEFT JOIN v_employees_safe e ON e.id = a.employee_id
         WHERE a.id IN (${Prisma.join(assessmentIds.map((id) => Prisma.sql`${id}::uuid`))})`);
      const meta = new Map(
        metaRows.map((m) => [
          m.id,
          {
            employeeName: (m.full_name ?? "").trim() || "kolega/koleginica",
            period: (m.period_label ?? "").trim(),
          },
        ]),
      );
      const raters = await tx.assessmentRater.findMany({
        where: {
          assessmentId: { in: assessmentIds },
          status: "pending",
          token: { not: null },
        },
        select: { id: true, assessmentId: true, raterKind: true, raterEmail: true, token: true },
      });
      return { cycle, assessmentIds, meta, raters };
    });

    // Prazan ciklus — rani return PRE mail.configured provere (1.0 edge fn :299-301):
    // ok:true + `message`, BEZ rezime mejla kreatoru (prazna tabela) — review #23.
    if (!read.assessmentIds.length) {
      return { data: { ok: true, sent: 0, skipped: [], message: "Ciklus nema procena." } };
    }

    const skipped: Array<{ assessment_id: string; employee: string; kind: string; reason: string }> = [];
    const sendable: typeof read.raters = [];
    for (const r of read.raters) {
      const to = (r.raterEmail ?? "").trim();
      if (!r.token || !to) {
        skipped.push({
          assessment_id: r.assessmentId,
          employee: read.meta.get(r.assessmentId)?.employeeName ?? "?",
          kind: r.raterKind,
          reason: "no_email",
        });
        continue;
      }
      sendable.push(r);
    }

    if (!this.mail.configured) {
      // Paritet 1.0: gracioznost umesto greške; kandidati vidljivi u odgovoru.
      return { data: { ok: false, reason: "resend_not_configured", sent: 0, candidates: sendable.length, skipped } };
    }

    // 2) SLANJE (van DB tx — mejl ne sme da obori radnju; MailService nikad ne baca).
    let sent = 0;
    const sentIds: string[] = [];
    const perAssessment = new Map<string, { employee: string; sent: number; skipped: string[] }>();
    const bucket = (aid: string) => {
      let b = perAssessment.get(aid);
      if (!b) {
        b = { employee: read.meta.get(aid)?.employeeName ?? "?", sent: 0, skipped: [] };
        perAssessment.set(aid, b);
      }
      return b;
    };
    for (const s of skipped) {
      bucket(s.assessment_id).skipped.push(s.kind === "self" ? "samoprocena (nema email)" : `${s.kind} (nema email)`);
    }
    for (const r of sendable) {
      const m = read.meta.get(r.assessmentId) ?? { employeeName: "kolega/koleginica", period: "" };
      const link = `${base}/ocena.html?token=${encodeURIComponent(r.token!)}`;
      const isSelf = r.raterKind === "self";
      const ok = await this.mail.send({
        to: r.raterEmail!,
        subject: isSelf
          ? "Zamolba za 360° procenu — Vaša samoprocena"
          : `Zamolba za 360° procenu — ${m.employeeName}`,
        html: this.inviteEmailHtml({ raterKind: r.raterKind, employeeName: m.employeeName, period: m.period, link }),
      });
      if (ok) {
        sent++;
        sentIds.push(r.id);
        bucket(r.assessmentId).sent++;
      }
    }

    // 3) Obeleži poslate pozivnice (RLS ar_write = can_manage_assessment).
    if (sentIds.length) {
      await this.sy15
        .withUserRls(email, (tx) =>
          tx.assessmentRater.updateMany({
            where: { id: { in: sentIds } },
            data: { invitedAt: new Date() },
          }),
        )
        .catch(() => undefined);
    }

    // 4) Rezime kreatoru kampanje (samo cycle režim; default uključeno — 1.0 paritet).
    let creatorNotified = false;
    if (read.cycle && opts.notifyCreator !== false) {
      const to = (read.cycle.createdBy ?? "").trim();
      if (to.includes("@")) {
        const rows = read.assessmentIds.map((aid) => bucket(aid));
        creatorNotified = await this.mail.send({
          to,
          subject: `360° kampanja otvorena — ${read.cycle.title || read.cycle.periodLabel || ""}`.trim(),
          html: this.inviteSummaryHtml({
            cycleTitle: read.cycle.title || "360° kampanja",
            period: read.cycle.periodLabel || "",
            base,
            rows,
          }),
        });
      }
    }

    return {
      data: {
        ok: true,
        sent,
        skipped,
        creator_notified: creatorNotified,
        perAssessment: Array.from(perAssessment.entries()).map(([aid, v]) => ({ assessment_id: aid, ...v })),
      },
    };
  }

  /** HTML-escape za email telo (port edge fn `esc`). */
  private escHtml(s: unknown): string {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  /** Email telo pozivnice (1:1 port edge fn `emailHtml`). */
  private inviteEmailHtml(o: { raterKind: string; employeeName: string; period: string; link: string }): string {
    const ACCENT = "#E8523A";
    const isSelf = o.raterKind === "self";
    const heading = isSelf
      ? "360° procena — Vaša samoprocena"
      : `360° procena — ${this.escHtml(o.employeeName)}`;
    const lead = isSelf
      ? "<p>Pozvani ste da popunite <strong>samoprocenu kompetencija</strong>. Ocenjujete sebe na skali zrelosti 0–5.</p>"
      : `<p>Pozvani ste da date <strong>360° procenu</strong> za kolegu/koleginicu <strong>${this.escHtml(o.employeeName)}</strong>. Ocenjujete na skali zrelosti 0–5.</p>`;
    const periodLine = o.period
      ? `<p style="color:#475569;font-size:.92em;margin:0 0 14px;">Period procene: <strong>${this.escHtml(o.period)}</strong></p>`
      : "";
    return (
      '<div style="font-family:-apple-system,Segoe UI,Arial,sans-serif;max-width:540px;margin:0 auto;color:#111827;line-height:1.55;">' +
      `<h2 style="color:${ACCENT};margin:0 0 6px;">${heading}</h2>` +
      periodLine +
      lead +
      "<p>Popunjavanje traje par minuta. Možete da menjate odgovore i ponovo pošaljete dok je procena otvorena.</p>" +
      `<p style="margin:22px 0;"><a href="${this.escHtml(o.link)}" style="display:inline-block;padding:13px 22px;background:${ACCENT};color:#fff;border-radius:10px;text-decoration:none;font-weight:700;font-size:15px;">Otvori upitnik</a></p>` +
      '<p style="font-size:.85em;color:#64748b;">Ako dugme ne radi, otvorite ovaj link:<br>' +
      `<a href="${this.escHtml(o.link)}" style="color:${ACCENT};word-break:break-all;">${this.escHtml(o.link)}</a></p>` +
      '<hr style="border:none;border-top:1px solid #e5e7eb;margin:22px 0;">' +
      '<p style="font-size:.8em;color:#94a3b8;"><em>Servoteh — automatsko obaveštenje. Vaši odgovori su poverljivi.</em></p>' +
      "</div>"
    );
  }

  /** Rezime mejl kreatoru kampanje (1:1 port edge fn `summaryHtml`). */
  private inviteSummaryHtml(o: {
    cycleTitle: string;
    period: string;
    base: string;
    rows: Array<{ employee: string; sent: number; skipped: string[] }>;
  }): string {
    const ACCENT = "#E8523A";
    const trs = o.rows
      .map(
        (r) =>
          "<tr>" +
          `<td style="padding:6px 10px;border-bottom:1px solid #e5e7eb;">${this.escHtml(r.employee)}</td>` +
          `<td style="padding:6px 10px;border-bottom:1px solid #e5e7eb;text-align:center;">${r.sent ? `✅ ${r.sent}` : "—"}</td>` +
          `<td style="padding:6px 10px;border-bottom:1px solid #e5e7eb;color:#b45309;">${r.skipped.length ? this.escHtml(r.skipped.join(", ")) : ""}</td>` +
          "</tr>",
      )
      .join("");
    return (
      '<div style="font-family:-apple-system,Segoe UI,Arial,sans-serif;max-width:560px;margin:0 auto;color:#111827;line-height:1.55;">' +
      `<h2 style="color:${ACCENT};margin:0 0 6px;">📊 360° kampanja otvorena</h2>` +
      `<p style="margin:0 0 4px;"><strong>${this.escHtml(o.cycleTitle)}</strong>${o.period ? ` · period ${this.escHtml(o.period)}` : ""}</p>` +
      '<p style="color:#475569;font-size:.92em;">Pregled poslatih pozivnica po zaposlenom:</p>' +
      '<table style="border-collapse:collapse;width:100%;font-size:14px;">' +
      "<thead><tr>" +
      '<th style="text-align:left;padding:6px 10px;border-bottom:2px solid #e5e7eb;">Zaposleni</th>' +
      '<th style="padding:6px 10px;border-bottom:2px solid #e5e7eb;">Pozivnice</th>' +
      '<th style="text-align:left;padding:6px 10px;border-bottom:2px solid #e5e7eb;">Preskočeno</th>' +
      "</tr></thead>" +
      `<tbody>${trs}</tbody></table>` +
      '<p style="font-size:.9em;color:#475569;margin-top:14px;">Napredak pratite u aplikaciji: <a href="' +
      `${this.escHtml(o.base)}" style="color:${ACCENT};">Kadrovska → Razvoj zaposlenih</a>. ` +
      `Zaposleni bez emaila ne mogu dobiti pozivnicu — procenu mogu popuniti u aplikaciji („Moj profil → Moja procena kompetencija") ili im dodajte email pa ponovo pošaljite pozivnice.</p>` +
      '<hr style="border:none;border-top:1px solid #e5e7eb;margin:22px 0;">' +
      '<p style="font-size:.8em;color:#94a3b8;"><em>Servoteh — automatsko obaveštenje.</em></p>' +
      "</div>"
    );
  }

  // ==========================================================================
  // ZARADE (admin)
  // ==========================================================================

  createSalaryTerm(email: string, dto: D.CreateSalaryTermDto) {
    return this.create(email, dto.clientEventId, "kadr.salary_term.create", (tx) =>
      tx.salaryTerm.create({
        data: {
          employeeId: dto.employeeId,
          salaryType: dto.salaryType,
          effectiveFrom: this.date(dto.effectiveFrom)!,
          effectiveTo: dto.effectiveTo ? this.date(dto.effectiveTo) : null,
          compensationModel: dto.compensationModel ?? null,
          createdBy: email,
          ...this.salaryAmounts(dto.amounts),
          ...(dto.note != null ? { note: dto.note } : {}),
        } as never,
      }),
    );
  }
  updateSalaryTerm(email: string, id: string, dto: D.UpdateSalaryTermDto) {
    return this.mutate(email, undefined, "kadr.salary_term.update", (tx) =>
      this.requireRows(
        tx.salaryTerm.updateMany({
          where: { id },
          data: {
            ...(dto.salaryType != null ? { salaryType: dto.salaryType } : {}),
            ...(dto.effectiveFrom ? { effectiveFrom: this.date(dto.effectiveFrom)! } : {}),
            ...(dto.effectiveTo ? { effectiveTo: this.date(dto.effectiveTo) } : {}),
            ...(dto.compensationModel !== undefined ? { compensationModel: dto.compensationModel } : {}),
            ...this.salaryAmounts(dto.amounts),
            ...(dto.note !== undefined ? { note: dto.note } : {}),
          } as never,
        }),
        "Uslovi zarade",
      ),
    );
  }
  deleteSalaryTerm(email: string, id: string) {
    return this.mutate(email, undefined, "kadr.salary_term.delete", (tx) =>
      this.requireRows(tx.salaryTerm.deleteMany({ where: { id } }), "Uslovi zarade"),
    );
  }

  payrollInit(email: string, dto: D.PayrollInitDto) {
    return this.mutate(email, dto.clientEventId, "kadr.payroll.init", (tx) =>
      this.rpcScalar(tx, Prisma.sql`SELECT kadr_payroll_init_month(${dto.year}::int, ${dto.month}::int) AS v`),
    );
  }

  /** hr_upsert_salary_payroll — V2 optimistic; {applied:false, reason:stale|locked|row_exists} → 409.
   *  Ako klijent šalje UPDATE (row.id + expected_updated_at), uskladi token na punu µs. */
  payrollUpsert(email: string, dto: D.PayrollUpsertDto) {
    return this.mutate(email, dto.clientEventId, "kadr.payroll.upsert", async (tx) => {
      const row = { ...dto.row };
      const id = typeof row.id === "string" && row.id ? row.id : null;
      if (id && "expected_updated_at" in row) {
        row.expected_updated_at = this.reconcileToken(
          row.expected_updated_at as string | null | undefined,
          await this.fullPrecUpdatedAt(tx, "salary_payroll", id),
        );
      }
      const res = await this.rpcJson(
        tx,
        Prisma.sql`SELECT hr_upsert_salary_payroll(${JSON.stringify(row)}::jsonb) AS v`,
      );
      this.assertApplied(res, "Obračun je u međuvremenu izmenjen/zaključan");
      return res;
    });
  }

  /** 🔒 Zaključavanje (status='paid') kroz upsert; optimistic token usklađen na µs. */
  payrollLock(email: string, id: string, dto: D.PayrollLockDto) {
    return this.mutate(email, dto.clientEventId, "kadr.payroll.lock", async (tx) => {
      const expected = this.reconcileToken(
        dto.expectedUpdatedAt,
        await this.fullPrecUpdatedAt(tx, "salary_payroll", id),
      );
      const res = await this.rpcJson(
        tx,
        Prisma.sql`SELECT hr_upsert_salary_payroll(${JSON.stringify({ id, status: "paid", expected_updated_at: expected })}::jsonb) AS v`,
      );
      this.assertApplied(res, "Obračun je u međuvremenu izmenjen/zaključan");
      return res;
    });
  }
  payrollUnlock(email: string, id: string, dto: D.OptIdempotentDto) {
    return this.mutate(email, dto.clientEventId, "kadr.payroll.unlock", (tx) =>
      this.rpcJson(tx, Prisma.sql`SELECT kadr_payroll_unlock(${id}::uuid) AS v`),
    );
  }

  /**
   * Recompute iz grida kroz PORTOVANI engine (G3). Za svakog traženog zaposlenog:
   * agregira work_hours meseca (aggregateWorkHoursForMonth), računa fond
   * (computeMonthlyFond) i zaradu (computeEarnings) po aktivnim uslovima; kad
   * `persist=true` upisuje kroz hr_upsert_salary_payroll (V2). Vraća preview redove.
   * ⚠️ IMPLEMENTED — pre oslanjanja u produ traži živi smoke (parity #45).
   */
  payrollRecompute(email: string, dto: D.PayrollRecomputeDto) {
    return this.mutate(email, dto.clientEventId, "kadr.payroll.recompute", async (tx) => {
      const { year, month } = dto;
      const start = new Date(Date.UTC(year, month - 1, 1));
      const end = new Date(Date.UTC(year, month, 1));
      const monthStart = `${year}-${String(month).padStart(2, "0")}-01`;
      const monthEnd = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);

      const holidays = await tx.kadrHoliday.findMany({
        where: { holidayDate: { gte: start, lt: end } },
        select: { holidayDate: true },
      });
      const holSet = new Set(
        holidays.map((h) => h.holidayDate.toISOString().slice(0, 10)),
      );

      const employees = await tx.employee.findMany({
        where: {
          isActive: true,
          ...(dto.employeeId ? { id: dto.employeeId } : {}),
        },
        select: { id: true, workType: true, hireDate: true, fullName: true },
      });

      const results: unknown[] = [];
      for (const emp of employees) {
        const wh = await tx.workHours.findMany({
          where: { employeeId: emp.id, workDate: { gte: start, lt: end } },
        });
        const byYmd = new Map<string, Record<string, unknown>>();
        let domesticDays = 0;
        let foreignDays = 0;
        for (const r of wh) {
          const ymd = r.workDate.toISOString().slice(0, 10);
          byYmd.set(ymd, {
            hours: r.hours,
            overtimeHours: r.overtimeHours,
            twoMachineHours: r.twoMachineHours,
            absenceCode: r.absenceCode,
            absenceSubtype: r.absenceSubtype,
          });
          if (Number(r.fieldHours) > 0) {
            if (r.fieldSubtype === "foreign") foreignDays += 1;
            else domesticDays += 1;
          }
        }
        const agg = aggregateWorkHoursForMonth(year, month, byYmd, holSet, {
          workType: emp.workType,
          hireDate: emp.hireDate ? emp.hireDate.toISOString().slice(0, 10) : null,
        });
        const neplacenoDays = agg.neplacenoDays ?? 0;
        // ⚠ PUN (bruto) fond — BEZ neplacenoDays. computeEarnings radi JEDINU
        // proporcionalnu redukciju (fiksno/jednokratno grana). Paritet 1.0
        // computeDisplayTotals (salaryPayroll.js:285). Dvostruko oduzimanje np bi
        // POTPLATILO fiksne zaposlene (npr. 70588.24 umesto 77272.73).
        const fond = computeMonthlyFond(year, month, holSet).fondSati;

        // Postojeći payroll red: advance + teren fallback + optimistic token
        // (updated_at::text = PUNA µs preciznost; JS Date bi izgubio µs → lažan 409).
        const exRows = await tx.$queryRaw<
          {
            id: string;
            status: string | null;
            advance_amount: unknown;
            domestic_days: unknown;
            foreign_days: unknown;
            u: string | null;
          }[]
        >(
          Prisma.sql`SELECT id, status, advance_amount, domestic_days, foreign_days, updated_at::text AS u
             FROM salary_payroll
             WHERE employee_id = ${emp.id}::uuid
               AND period_year = ${year}::int AND period_month = ${month}::int
             LIMIT 1`,
        );
        const existing = exRows[0];
        // Teren fallback na postojeći red (1.0 computeDisplayTotals:287-288).
        const domDays = domesticDays > 0 ? domesticDays : Number(existing?.domestic_days ?? 0);
        const forDays = foreignDays > 0 ? foreignDays : Number(existing?.foreign_days ?? 0);
        const advanceAmount = Number(existing?.advance_amount ?? 0);

        const termRows = await tx.$queryRaw<Record<string, unknown>[]>(
          Prisma.sql`SELECT * FROM salary_terms
             WHERE employee_id = ${emp.id}::uuid
               AND effective_from <= ${monthEnd}::date
               AND (effective_to IS NULL OR effective_to >= ${monthStart}::date)
             ORDER BY effective_from DESC LIMIT 1`,
        );
        const term = this.mapTerm(termRows[0]);

        const res = computeEarnings({
          workType: emp.workType,
          terms: term,
          hours: agg,
          terrain: { domestic: domDays, foreign: forDays },
          advanceAmount,
          neplacenoDays,
          fondSati: fond,
        });

        const preview = {
          employee_id: emp.id,
          employee_name: emp.fullName,
          period_year: year,
          period_month: month,
          fond_sati_meseca: fond,
          redovan_rad_sati: agg.redovanRadSati,
          prekovremeni_sati: agg.prekovremeniSati,
          praznik_placeni_sati: agg.praznikPlaceniSati,
          praznik_rad_sati: agg.praznikRadSati,
          godisnji_sati: agg.godisnjiSati,
          slobodni_dani_sati: agg.slobodniDaniSati,
          bolovanje_65_sati: agg.bolovanje65Sati,
          bolovanje_100_sati: agg.bolovanje100Sati,
          dve_masine_sati: agg.dveMasineSati,
          teren_u_zemlji_count: domDays,
          teren_u_inostranstvu_count: forDays,
          compensation_model: res.compensationModel,
          payable_hours: res.payableHours,
          ukupna_zarada: res.ukupnaZarada,
          prvi_deo: res.prviDeo,
          preostalo_za_isplatu: res.preostaloZaIsplatu,
          warnings: res.warnings,
        };

        if (dto.persist) {
          if (existing?.status === "paid") {
            results.push({ ...preview, persisted: false, reason: "locked" });
            continue;
          }
          const row = {
            ...preview,
            ...(existing ? { id: existing.id, expected_updated_at: existing.u } : {}),
          };
          const up = await this.rpcJson(
            tx,
            Prisma.sql`SELECT hr_upsert_salary_payroll(${JSON.stringify(row)}::jsonb) AS v`,
          );
          results.push({ ...preview, persisted: (up as { applied?: boolean })?.applied ?? false, upsert: up });
        } else {
          results.push(preview);
        }
      }
      return { year, month, count: results.length, rows: results };
    });
  }

  // ==========================================================================
  // NOTIFIKACIJE (manage) — dispatch/push OSTAJE 1.0 pozadina (paritet-only)
  // ==========================================================================

  updateNotificationConfig(email: string, dto: D.NotificationConfigDto) {
    return this.mutate(email, undefined, "kadr.notif.config", (tx) =>
      tx.kadrNotificationConfig.update({
        where: { id: 1 },
        data: {
          ...(dto.enabled != null ? { enabled: dto.enabled } : {}),
          ...(dto.medicalLeadDays != null ? { medicalLeadDays: dto.medicalLeadDays } : {}),
          ...(dto.contractLeadDays != null ? { contractLeadDays: dto.contractLeadDays } : {}),
          ...(dto.birthdayEnabled != null ? { birthdayEnabled: dto.birthdayEnabled } : {}),
          ...(dto.workAnniversaryEnabled != null ? { workAnniversaryEnabled: dto.workAnniversaryEnabled } : {}),
          ...(dto.whatsappRecipients ? { whatsappRecipients: dto.whatsappRecipients } : {}),
          ...(dto.emailRecipients ? { emailRecipients: dto.emailRecipients } : {}),
          ...(dto.childBirthdayEnabled != null ? { childBirthdayEnabled: dto.childBirthdayEnabled } : {}),
          ...(dto.birthdayOversightEnabled != null ? { birthdayOversightEnabled: dto.birthdayOversightEnabled } : {}),
          ...(dto.birthdayDigestEnabled != null ? { birthdayDigestEnabled: dto.birthdayDigestEnabled } : {}),
          ...(dto.lkLeadDays != null ? { lkLeadDays: dto.lkLeadDays } : {}),
          ...(dto.passportLeadDays != null ? { passportLeadDays: dto.passportLeadDays } : {}),
          ...(dto.driverLicenseLeadDays != null ? { driverLicenseLeadDays: dto.driverLicenseLeadDays } : {}),
          ...(dto.medicalEmpLeadDays != null ? { medicalEmpLeadDays: dto.medicalEmpLeadDays } : {}),
          updatedBy: email,
          updatedAt: new Date(),
        },
      }),
    );
  }

  /** Retry outbox reda: status→'queued' + reset attempts/next_attempt (dispatch cron ga
   *  preuzme — dequeue bira status IN ('queued','failed') AND attempts<max). Kolone
   *  izmerene iz kadr_dispatch_* (status/attempts/next_attempt_at/error). RLS hr_or_admin. */
  notificationRetry(email: string, id: string) {
    return this.mutate(email, undefined, "kadr.notif.retry", (tx) =>
      this.requireRows(
        tx.$executeRaw(
          Prisma.sql`UPDATE kadr_notification_log
             SET status='queued', attempts=0, next_attempt_at=now(), error=NULL
           WHERE id=${id}::uuid AND status <> 'sent'`,
        ),
        "Notifikacija",
      ),
    );
  }
  /** Otkazivanje: status→'canceled' (JEDNO L — živi CHECK `kadr_notif_status_chk` =
   *  {queued,sent,failed,canceled}; G10 ne menjamo CHECK). Skloni iz dispatch domena. */
  notificationCancel(email: string, id: string) {
    return this.mutate(email, undefined, "kadr.notif.cancel", (tx) =>
      this.requireRows(
        tx.$executeRaw(
          Prisma.sql`UPDATE kadr_notification_log SET status='canceled' WHERE id=${id}::uuid AND status <> 'sent'`,
        ),
        "Notifikacija",
      ),
    );
  }
  notificationDelete(email: string, id: string) {
    return this.mutate(email, undefined, "kadr.notif.delete", (tx) =>
      this.requireRows(
        tx.$executeRaw(Prisma.sql`DELETE FROM kadr_notification_log WHERE id=${id}::uuid`),
        "Notifikacija",
      ),
    );
  }

  /** Ručni okidači (DEFINER; jedini legalni upis u outbox, G10). Dispatch = pozadina. */
  triggerHrReminders(email: string) {
    return this.mutate(email, undefined, "kadr.notif.hr_reminders", async (tx) => {
      const rows = await tx.$queryRaw<Record<string, unknown>[]>(
        Prisma.sql`SELECT * FROM kadr_trigger_schedule_hr_reminders()`,
      );
      return this.numifyRow(rows[0] ?? {});
    });
  }
  triggerWeeklyRisk(email: string) {
    return this.mutate(email, undefined, "kadr.notif.weekly_risk", (tx) =>
      this.rpcScalar(tx, Prisma.sql`SELECT kadr_trigger_weekly_risk_summary() AS v`),
    );
  }
  triggerPayrollNotifications(email: string, dto: D.PayrollNotifyDto) {
    return this.mutate(email, dto.clientEventId, "kadr.notif.payroll", (tx) =>
      this.rpcScalar(
        tx,
        Prisma.sql`SELECT kadr_queue_payroll_notifications(${dto.year}::int, ${dto.month}::int) AS v`,
      ),
    );
  }

  // ==========================================================================
  // STORAGE PROXY (employee-docs) — G5 / A.2b (§7.5, obrazac F4)
  // ==========================================================================

  /**
   * Upload dokumenta zaposlenog. PII pravo se proverava PRE storage op kroz
   * `withUserRls` (RLS INSERT na employee_documents = can_manage_employee_pii);
   * meta-red je izvor istine, pa se ubaci prvo (RLS presuđuje), tek onda bajtovi
   * idu na sy15 storage-api service kredencijalom. Putanja 1.0-kompatibilna.
   * ⚠️ storage-api op je van DB tx — meta-red se briše ako upload padne (kompenzacija).
   */
  async uploadEmployeeDocument(
    email: string,
    empId: string,
    dto: D.DocumentMetaDto,
    file?: Express.Multer.File,
  ) {
    if (!file?.buffer?.length) {
      throw new UnprocessableEntityException("Očekivan fajl (multipart polje `file`)");
    }
    const bucket = "employee-docs";
    const safeName = file.originalname.replace(/[^\w.\-]+/g, "_");
    const path = `${empId}/${Date.now()}_${safeName}`;

    // 1) Meta-red kroz RLS (PII gate presuđuje sy15). uploaded_by=auth.uid() (default trg/kol).
    //    Vraćamo BEZ BigInt (sizeBytes→Number) — runIdempotentRls JSON.stringify-uje rezultat.
    const doc = await this.mutateRaw(email, dto.clientEventId, "kadr.doc.upload", async (tx) => {
      const d = await tx.employeeDocument.create({
        data: {
          employeeId: empId,
          docType: dto.docType,
          fileName: file.originalname,
          storagePath: path,
          mimeType: file.mimetype ?? null,
          sizeBytes: BigInt(file.size ?? file.buffer.length),
          description: dto.description ?? null,
        },
      });
      return {
        id: d.id,
        employeeId: d.employeeId,
        docType: d.docType,
        fileName: d.fileName,
        storagePath: d.storagePath,
        mimeType: d.mimeType,
        sizeBytes: d.sizeBytes == null ? null : Number(d.sizeBytes),
        description: d.description,
        uploadedAt: d.uploadedAt,
      };
    });

    // 2) Bajtovi na storage-api (van DB tx). Neuspeh → kompenzuj (obriši meta-red + fajl).
    try {
      await this.storage.upload(bucket, path, file.buffer, file.mimetype || "application/octet-stream");
    } catch (e) {
      await this.sy15
        .withUserRls(email, (tx) =>
          tx.employeeDocument.deleteMany({ where: { id: doc.id } }),
        )
        .catch(() => undefined);
      throw e;
    }

    // 3) Opcioni mejl knjigovođi/primaocu (DEFINER queue; jedini legalni INSERT u outbox).
    if (dto.queueEmail) {
      await this.sy15
        .withUserRls(email, (tx) =>
          tx.$queryRaw(
            Prisma.sql`SELECT kadr_queue_document_email(${empId}::uuid, ${dto.docType}, ${path}, ${file.originalname}, ${dto.emailLabel ?? null})`,
          ),
        )
        .catch(() => undefined);
    }
    return { data: { ...doc, path } };
  }

  /** Presigned URL za preuzimanje (PII gate: SELECT meta-red kroz RLS pre potpisa). */
  async signEmployeeDocument(email: string, docId: string) {
    const doc = await this.sy15.withUserRls(email, (tx) =>
      tx.employeeDocument.findFirst({ where: { id: docId, deletedAt: null } }),
    );
    if (!doc) throw new NotFoundException("Dokument ne postoji ili nemate pravo");
    const url = await this.storage.signUrl("employee-docs", doc.storagePath, 3600);
    return { data: url };
  }

  /** Soft-delete meta-reda (RLS PII) + best-effort brisanje fajla. */
  async deleteEmployeeDocument(email: string, docId: string) {
    const doc = await this.mutateRaw(email, undefined, "kadr.doc.delete", async (tx) => {
      const d = await tx.employeeDocument.findFirst({ where: { id: docId, deletedAt: null } });
      if (!d) throw new NotFoundException("Dokument ne postoji ili nemate pravo");
      await tx.employeeDocument.updateMany({
        where: { id: docId },
        data: { deletedAt: new Date() },
      });
      return d;
    });
    await this.storage.remove("employee-docs", (doc as { storagePath: string }).storagePath);
    return { data: { deleted: true } };
  }

  // ==========================================================================
  // interno
  // ==========================================================================

  /** OBAVEZNO idempotentna mutacija (kreiranje) — clientEventId je zahtevan. */
  private async create<T>(
    email: string,
    clientEventId: string,
    action: string,
    fn: (tx: Sy15Tx) => Promise<T>,
  ) {
    try {
      const out = await this.sy15.runIdempotentRls(email, clientEventId, action, fn);
      return { data: out.result, meta: { idempotent: out.idempotent } };
    } catch (e) {
      this.rethrowSy15(e);
    }
  }

  /** Odluka/prelaz — idempotentna kad je clientEventId prisutan, inače withUserRls. */
  private async mutate<T>(
    email: string,
    clientEventId: string | undefined,
    action: string,
    fn: (tx: Sy15Tx) => Promise<T>,
  ) {
    try {
      if (clientEventId) {
        const out = await this.sy15.runIdempotentRls(email, clientEventId, action, fn);
        return { data: out.result, meta: { idempotent: out.idempotent } };
      }
      const data = await this.sy15.withUserRls(email, fn);
      return { data };
    } catch (e) {
      this.rethrowSy15(e);
    }
  }

  /** Kao mutate ali vraća sirovi rezultat (za storage tokove koji sami sklapaju odgovor). */
  private async mutateRaw<T>(
    email: string,
    clientEventId: string | undefined,
    action: string,
    fn: (tx: Sy15Tx) => Promise<T>,
  ): Promise<T> {
    try {
      if (clientEventId) {
        const out = await this.sy15.runIdempotentRls(email, clientEventId, action, fn);
        return out.result;
      }
      return await this.sy15.withUserRls(email, fn);
    } catch (e) {
      this.rethrowSy15(e);
    }
  }

  private async rpcJson(tx: Sy15Tx, sql: Prisma.Sql): Promise<unknown> {
    const rows = await tx.$queryRaw<{ v: unknown }[]>(sql);
    return rows[0]?.v ?? null;
  }
  private async rpcScalar(tx: Sy15Tx, sql: Prisma.Sql): Promise<unknown> {
    const rows = await tx.$queryRaw<{ v: unknown }[]>(sql);
    const v = rows[0]?.v ?? null;
    return typeof v === "bigint" ? Number(v) : v;
  }
  private async rpcVoid(tx: Sy15Tx, sql: Prisma.Sql): Promise<{ ok: true }> {
    await tx.$queryRaw(sql);
    return { ok: true };
  }

  /** updateMany/executeRaw vratio 0 redova → RLS-filtrovan ili nepostojeći → 403/404. */
  private async requireRows(
    p: Promise<{ count: number } | number>,
    label: string,
  ): Promise<{ affected: number }> {
    const r = await p;
    const n = typeof r === "number" ? r : r.count;
    if (n === 0) {
      throw new ForbiddenException(`${label} ne postoji ili nemate pravo (0 redova)`);
    }
    return { affected: n };
  }

  /** Optimistic-lock RPC koji NE raise-uje nego vraća {applied:false, reason}. */
  private assertApplied(res: unknown, msg: string): void {
    const r = res as { applied?: boolean; reason?: string } | null;
    if (r && r.applied === false && r.reason && r.reason !== "noop") {
      throw new ConflictException(`${msg} (${r.reason})`);
    }
  }

  private async selfEmployeeId(tx: Sy15Tx, email: string, required = false): Promise<string> {
    const rows = await tx.$queryRaw<{ v: string | null }[]>(
      Prisma.sql`SELECT current_user_employee_id() AS v`,
    );
    const id = rows[0]?.v ?? null;
    if (!id && required) {
      throw new UnprocessableEntityException(
        `Nalog ${email} nije povezan sa zaposlenim (employee_id) — podnošenje nije moguće`,
      );
    }
    return id as string;
  }

  private date(v?: string | null): Date | null {
    if (!v) return null;
    return new Date(`${v.slice(0, 10)}T00:00:00Z`);
  }

  /**
   * PUNA (µs) preciznost `updated_at` kao text — optimistic-lock RPC-ovi rade EXACT
   * equality na timestamptz. Prisma → JS Date gubi µs (ms) → večiti lažni 409.
   * `table` je zatvoren skup (nije korisnički unos) → Prisma.raw je bezbedno.
   */
  private async fullPrecUpdatedAt(
    tx: Sy15Tx,
    table: "employees" | "salary_payroll",
    id: string,
  ): Promise<string | null> {
    const rows = await tx.$queryRaw<{ u: string | null }[]>(
      Prisma.sql`SELECT updated_at::text AS u FROM ${Prisma.raw(table)} WHERE id = ${id}::uuid`,
    );
    return rows[0]?.u ?? null;
  }

  /**
   * Uskladi klijentski optimistic token (ms preciznost — sve što klijent može da
   * vidi kroz Prisma read) sa punom µs vrednošću iz baze: ako se poklapaju NA ms
   * granularnosti → vrati punu µs vrednost (RPC exact-eq prolazi); ako ne → vrati
   * klijentski token (RPC → stale → 409, stvaran konflikt). Bez tokena → null (→409).
   */
  private reconcileToken(
    clientToken: string | null | undefined,
    dbText: string | null,
  ): string | null {
    if (!clientToken) return null;
    if (dbText == null) return clientToken;
    return new Date(clientToken).getTime() === new Date(dbText).getTime()
      ? dbText
      : clientToken;
  }

  private numifyRow(row: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(row)) out[k] = typeof v === "bigint" ? Number(v) : v;
    return out;
  }

  /** Strani dokument: prihvati snake/camel ključeve, mapiraj u Prisma model polja. */
  private mapForeign(data: Record<string, unknown>): Record<string, unknown> {
    const m: Record<string, string> = {
      passport_number: "passportNumber",
      passport_expiry: "passportExpiry",
      visa_number: "visaNumber",
      visa_expiry: "visaExpiry",
      work_permit_number: "workPermitNumber",
      work_permit_expiry: "workPermitExpiry",
      residence_permit_number: "residencePermitNumber",
      residence_permit_expiry: "residencePermitExpiry",
      residence_address: "residenceAddress",
      bank_account: "bankAccount",
      foreign_id_number: "foreignIdNumber",
      note: "note",
    };
    return this.mapPii(data, m, ["passportExpiry", "visaExpiry", "workPermitExpiry", "residencePermitExpiry"]);
  }
  private mapPersonal(data: Record<string, unknown>): Record<string, unknown> {
    const m: Record<string, string> = {
      lk_number: "lkNumber",
      lk_expiry: "lkExpiry",
      passport_number: "passportNumber",
      passport_expiry: "passportExpiry",
      driver_license_number: "driverLicenseNumber",
      driver_license_expiry: "driverLicenseExpiry",
      driver_license_categories: "driverLicenseCategories",
      note: "note",
    };
    return this.mapPii(data, m, ["lkExpiry", "passportExpiry", "driverLicenseExpiry"]);
  }
  private mapPii(
    data: Record<string, unknown>,
    map: Record<string, string>,
    dateFields: string[],
  ): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    const dset = new Set(dateFields);
    for (const [k, v] of Object.entries(data)) {
      const camel = map[k] ?? k;
      if (!Object.values(map).includes(camel) && !Object.keys(map).includes(k)) continue;
      out[camel] = dset.has(camel) && typeof v === "string" ? this.date(v) : v;
    }
    return out;
  }

  /** amounts objekat (comp modeli) → Prisma salary_terms numerička polja. */
  private salaryAmounts(a?: Record<string, unknown>): Record<string, unknown> {
    if (!a) return {};
    const keys: Record<string, string> = {
      amount: "amount",
      amountType: "amountType",
      currency: "currency",
      hourlyRate: "hourlyRate",
      fixedAmount: "fixedAmount",
      fixedTransportComponent: "fixedTransportComponent",
      fixedExtraHourRate: "fixedExtraHourRate",
      fixedNoExtraHours: "fixedNoExtraHours",
      firstPartAmount: "firstPartAmount",
      splitHourRate: "splitHourRate",
      splitTransportAmount: "splitTransportAmount",
      hourlyTransportAmount: "hourlyTransportAmount",
      terrainDomesticRate: "terrainDomesticRate",
      terrainForeignRate: "terrainForeignRate",
      transportAllowanceRsd: "transportAllowanceRsd",
      perDiemRsd: "perDiemRsd",
      perDiemEur: "perDiemEur",
      netoRsd: "netoRsd",
      brutoRsd: "brutoRsd",
      cashAllowanceRsd: "cashAllowanceRsd",
      paymentWindowOverride: "paymentWindowOverride",
      payrollGroup: "payrollGroup",
    };
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(a)) if (keys[k]) out[keys[k]] = v;
    return out;
  }

  /**
   * salary_terms DB red (snake) → engine SalaryTermsInput. PARITET 1.0
   * `termsForPayrollCalc` (salaryPayroll.js:144-167) — KRITIČNO za tačnu zaradu:
   *  - `hourly = salary_type==='satnica' ? amount : hourly_rate`
   *  - `fixedAmount = fixed_amount || (fiksno/jednokratno ? amount : 0)`  ⚠ `amount`
   *    fallback: kadr_set_contract_salary INSERT-uje fiksno sa amount=neto, fixed_amount=0
   *    → bez fallbacka svaki takav zaposleni bi imao platu 0.
   *  - transport/teren fallback na transport_allowance_rsd / per_diem_rsd / per_diem_eur.
   * `num()` semantika (null→0) + `||` fallback identično 1.0.
   */
  private mapTerm(row?: Record<string, unknown>): SalaryTermsInput {
    if (!row) return {};
    const num = (v: unknown) => (v == null || isNaN(Number(v)) ? 0 : Number(v));
    const salaryType = (row.salary_type as string) ?? null;
    const model =
      (row.compensation_model as string) ||
      deriveCompensationModel({ salaryType }) ||
      null;
    const hourly =
      salaryType === "satnica" ? num(row.amount) : num(row.hourly_rate);
    const fixedAmt =
      num(row.fixed_amount) ||
      (model === "fiksno" || model === "jednokratno" ? num(row.amount) : 0);
    return {
      compensationModel: model,
      salaryType,
      fixedAmount: fixedAmt,
      fixedTransportComponent: num(row.fixed_transport_component),
      fixedExtraHourRate: num(row.fixed_extra_hour_rate),
      fixedNoExtraHours: Boolean(row.fixed_no_extra_hours),
      firstPartAmount: num(row.first_part_amount),
      splitHourRate: num(row.split_hour_rate),
      splitTransportAmount:
        num(row.split_transport_amount) || num(row.transport_allowance_rsd),
      hourlyRate: hourly,
      hourlyTransportAmount:
        num(row.hourly_transport_amount) || num(row.transport_allowance_rsd),
      terrainDomesticRate:
        num(row.terrain_domestic_rate) || num(row.per_diem_rsd),
      terrainForeignRate:
        num(row.terrain_foreign_rate) || num(row.per_diem_eur),
    };
  }

  private rethrowSy15(e: unknown): never {
    if (
      e instanceof NotFoundException ||
      e instanceof ForbiddenException ||
      e instanceof UnprocessableEntityException ||
      e instanceof ConflictException ||
      e instanceof NotImplementedException
    ) {
      throw e;
    }
    const meta = (e as { meta?: { code?: string; message?: string } }).meta;
    const code = meta?.code ?? (e as { code?: string }).code;
    const message = meta?.message ?? (e as Error).message;
    if (code === "42501") throw new ForbiddenException(message);
    // 02000 = no_data (RPC RAISE za nedostajući red: employee_missing / payroll_row_missing).
    if (code === "02000") throw new NotFoundException(message);
    if (code === "P0001" || code === "P0002" || code === "23514" || code === "22023" || code === "23502")
      throw new UnprocessableEntityException(message);
    if (code === "23505") throw new ConflictException(message);
    if (code === "P2025") throw new ForbiddenException(message);
    throw e;
  }
}
