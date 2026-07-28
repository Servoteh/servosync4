import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type { QualityEvent } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import {
  pageMeta,
  parsePagination,
  SAFE_WORKER_SELECT,
} from "../../common/pagination";
import { byId, uniqueIds } from "../../common/relations";
import { parseDateParam } from "../../common/date-params";
import { resolveManagementWorkerIds } from "../../common/workers/management-criteria";
import type { AuthUser } from "../auth/jwt.strategy";
import { NotificationsService } from "../notifications/notifications.service";
import { QualityEventsMailService } from "./quality-events-mail.service";
import {
  QUALITY_EVENT_STATUSES,
  QUALITY_EVENT_TYPES,
  validateConfirmQualityEvent,
  validateCreateQualityEvent,
  validatePrijavaQualityEvent,
  validateRejectQualityEvent,
  type ConfirmQualityEventDto,
  type CreateQualityEventDto,
  type PrijavaQualityEventDto,
  type RejectQualityEventDto,
} from "./dto/quality-event.dto";
import type {
  ListQualityEventsQuery,
  QualityParetoQuery,
} from "./dto/quality-event.query";

/** Statusi (MODULE_SPEC_kvalitet_skart_dorada §3) — u izveštaje ulazi SAMO POTVRDJEN. */
const STATUS = {
  PRIJAVLJEN: "PRIJAVLJEN",
  POTVRDJEN: "POTVRDJEN",
  ODBACEN: "ODBACEN",
} as const;

const TYPE_LABEL: Record<string, string> = { SKART: "škart", DORADA: "dorada" };

/** Prag za zvonce menadžmentu (env; §4). */
function envInt(name: string, fallback: number): number {
  const raw = Number.parseInt((process.env[name] ?? "").trim(), 10);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

/** Razrešeni radnik (SAFE — bez lozinki). */
interface WorkerRef {
  id: number;
  fullName: string | null;
  username: string;
}

/** Decimal|number|string → number (Prisma Decimal, mock string ili number). */
function toNum(v: Prisma.Decimal | number | string | null | undefined): number {
  if (v === null || v === undefined) return 0;
  return Number(typeof v === "string" ? v : v.toString());
}

/**
 * Škart i dorada — evidencija događaja kvaliteta (MODULE_SPEC_kvalitet_skart_dorada,
 * presuda 26.07). App-owned 2.0-native tabele (`quality_events` + `quality_reason_codes`).
 * TRI statusa (PRIJAVLJEN → POTVRDJEN/ODBACEN); u Pareto/izveštaje ulazi SAMO POTVRDJEN.
 * Kontrolor unosi direktno kao POTVRDJEN (autoritet); radnik na kiosku šalje PRIJAVLJEN
 * signal (`prijava`) koji kontrolor `confirm`-uje/`reject`-uje. Compare-and-set na status
 * (PRIJAVLJEN → …; drugačije → 409). Zvonce menadžmentu iznad praga je best-effort (kao D8).
 */
@Injectable()
export class QualityEventsService {
  private readonly logger = new Logger(QualityEventsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly mail: QualityEventsMailService,
  ) {}

  // ------------------------------------------------------------------ ŠIFARNIK

  /** `GET /kvalitet/reason-codes` — aktivni razlozi (za padajuću listu forme). */
  async listReasonCodes() {
    const rows = await this.prisma.qualityReasonCode.findMany({
      where: { active: true },
      orderBy: [{ sortOrder: "asc" }, { label: "asc" }],
      select: { id: true, code: true, label: true, sortOrder: true },
    });
    return { data: rows };
  }

  // ------------------------------------------------------------------ LISTA

  /**
   * `GET /kvalitet/events` — lista (server-side filter + paginacija),
   * `reported_at desc, id desc`. `meta.pendingCount` = broj PRIJAVLJEN (red čekanja
   * kontrolora, brojač na tabu; poštuje `type` filter). Batch-resolve razloga/radnika/korisnika.
   */
  async list(query: ListQualityEventsQuery) {
    const { page, pageSize, skip, take } = parsePagination(
      query.page,
      query.pageSize,
    );

    const where = this.buildWhere(query);
    const pendingWhere: Prisma.QualityEventWhereInput = {
      status: STATUS.PRIJAVLJEN,
    };
    const type = this.normalizeType(query.type);
    if (type) pendingWhere.type = type;

    const [rows, total, pendingCount] = await Promise.all([
      this.prisma.qualityEvent.findMany({
        where,
        orderBy: [{ reportedAt: "desc" }, { id: "desc" }],
        skip,
        take,
      }),
      this.prisma.qualityEvent.count({ where }),
      this.prisma.qualityEvent.count({ where: pendingWhere }),
    ]);

    const data = await this.mapMany(rows);
    return {
      data,
      meta: { ...pageMeta(page, pageSize, total), pendingCount },
    };
  }

  /** `GET /kvalitet/events/:id` — detalj. */
  async getEvent(id: number) {
    const row = await this.prisma.qualityEvent.findUnique({ where: { id } });
    if (!row) throw new NotFoundException(`Događaj ${id} ne postoji.`);
    return { data: (await this.mapMany([row]))[0] };
  }

  // ------------------------------------------------------------------ KONTROLOR UNOS (POTVRDJEN)

  /**
   * `POST /kvalitet/events` — kanonski kontrolorski unos. Nastaje ODMAH kao POTVRDJEN
   * (kontrolor je autoritet, §3). Validira: razlog (postoji+aktivan), radni nalog (postoji,
   * inače tiho vezivanje za pogrešan RN — review [0]), operaciju (pripada TOM RN-u). NE
   * podrazumeva `reportedByWorkerId` = kontrolor (review [7]): reporter je „ko je napravio
   * škart", a to zna samo forma; kontrolor je `confirmedByUserId`. Posle upisa → zvonce
   * menadžmentu iznad praga (best-effort).
   */
  async createByController(dto: CreateQualityEventDto, actor: AuthUser) {
    validateCreateQualityEvent(dto);
    await this.assertReasonActive(dto.reasonCodeId);
    await this.assertWorkOrder(dto.workOrderId);
    const workUnitCode = await this.resolveWorkUnit(
      dto.workUnitCode,
      dto.techProcessId,
      dto.workOrderId,
    );
    const now = new Date();

    const created = await this.prisma.qualityEvent.create({
      data: {
        type: dto.type,
        status: STATUS.POTVRDJEN,
        workOrderId: dto.workOrderId,
        techProcessId: dto.techProcessId ?? null,
        qty: new Prisma.Decimal(dto.qty),
        unit: dto.unit?.trim() || "kom",
        reasonCodeId: dto.reasonCodeId,
        note: dto.note?.trim() || null,
        workUnitCode,
        // [7] reporter = radnik koji je napravio škart (opciono iz forme), NE kontrolor.
        reportedByWorkerId: dto.reportedByWorkerId ?? null,
        reportedAt: now,
        confirmedByUserId: actor.userId,
        confirmedAt: now,
        photoPath: dto.photoPath?.trim() || null,
        createdByUserId: actor.userId,
      },
    });

    await this.maybeAlert(created);
    return { data: (await this.mapMany([created]))[0] };
  }

  // ------------------------------------------------------------------ KIOSK PRIJAVA (PRIJAVLJEN)

  /**
   * `POST /kvalitet/events/prijava` — laka prijava-signal radnika sa kioska (§3).
   * Nastaje kao PRIJAVLJEN (ne ulazi u izveštaje dok ga kontrolor ne potvrdi). Radnik
   * se identifikuje ID karticom (`workerCard` → `workers.cardId`) — RN/operacija/mašina
   * dolaze iz konteksta poziva. Razlog je opcion (kontrolor ga dopuni pri potvrdi).
   * `actor` = deljeni kiosk nalog (audit `createdByUserId`).
   */
  async prijava(dto: PrijavaQualityEventDto, actor: AuthUser) {
    validatePrijavaQualityEvent(dto);
    const worker = await this.resolveWorkerByCard(dto.workerCard);
    await this.assertWorkOrder(dto.workOrderId);
    if (dto.reasonCodeId != null)
      await this.assertReasonActive(dto.reasonCodeId);
    const workUnitCode = await this.resolveWorkUnit(
      dto.workUnitCode,
      dto.techProcessId,
      dto.workOrderId,
    );

    const created = await this.prisma.qualityEvent.create({
      data: {
        type: dto.type,
        status: STATUS.PRIJAVLJEN,
        workOrderId: dto.workOrderId,
        techProcessId: dto.techProcessId ?? null,
        qty: new Prisma.Decimal(dto.qty),
        unit: dto.unit?.trim() || "kom",
        reasonCodeId: dto.reasonCodeId ?? null,
        note: dto.note?.trim() || null,
        workUnitCode,
        reportedByWorkerId: worker.id,
        reportedAt: new Date(),
        photoPath: dto.photoPath?.trim() || null,
        createdByUserId: actor.userId,
      },
    });
    // PRIJAVLJEN NE ulazi u izveštaje → bez praga/zvonca (okida tek POTVRDJEN).
    return { data: (await this.mapMany([created]))[0] };
  }

  // ------------------------------------------------------------------ POTVRDA (PRIJAVLJEN → POTVRDJEN)

  /**
   * `PATCH /kvalitet/events/:id/potvrdi` — kontrolor potvrđuje prijavu (dopuni razlog/
   * količinu/operaciju). Compare-and-set na status PRIJAVLJEN → POTVRDJEN; ako više nije
   * PRIJAVLJEN (dupli klik / već obrađen) → 409. Razlog je obavezan. Posle → zvonce iznad praga.
   */
  async confirm(id: number, dto: ConfirmQualityEventDto, actor: AuthUser) {
    validateConfirmQualityEvent(dto);
    const existing = await this.loadForTransition(id);
    await this.assertReasonActive(dto.reasonCodeId);

    // Operacija (ako je zadata pri potvrdi) mora pripadati RN-u tog događaja (review [6]).
    const workUnitCode =
      dto.workUnitCode !== undefined || dto.techProcessId !== undefined
        ? await this.resolveWorkUnit(
            dto.workUnitCode,
            dto.techProcessId,
            existing.workOrderId,
          )
        : undefined;

    const data: Prisma.QualityEventUncheckedUpdateInput = {
      status: STATUS.POTVRDJEN,
      reasonCodeId: dto.reasonCodeId,
      confirmedByUserId: actor.userId,
      confirmedAt: new Date(),
    };
    if (dto.qty !== undefined) data.qty = new Prisma.Decimal(dto.qty);
    if (dto.unit !== undefined) data.unit = dto.unit.trim() || "kom";
    if (dto.techProcessId !== undefined)
      data.techProcessId = dto.techProcessId ?? null;
    if (workUnitCode !== undefined) data.workUnitCode = workUnitCode;
    if (dto.note !== undefined) data.note = dto.note?.trim() || null;

    const res = await this.prisma.qualityEvent.updateMany({
      where: { id, status: STATUS.PRIJAVLJEN },
      data,
    });
    if (res.count === 0)
      throw new ConflictException(
        `Događaj ${id} je u međuvremenu obrađen — osvežite stranicu.`,
      );

    const updated = await this.prisma.qualityEvent.findUnique({
      where: { id },
    });
    if (updated) await this.maybeAlert(updated);
    return { data: (await this.mapMany([updated!]))[0] };
  }

  // ------------------------------------------------------------------ ODBACIVANJE (PRIJAVLJEN → ODBACEN)

  /**
   * `PATCH /kvalitet/events/:id/odbaci` — kontrolor odbacuje prijavu (razlog odbacivanja
   * je obavezan — i odbacivanje je podatak, §3). CAS PRIJAVLJEN → ODBACEN; drugačije → 409.
   */
  async reject(id: number, dto: RejectQualityEventDto, actor: AuthUser) {
    validateRejectQualityEvent(dto);
    await this.loadForTransition(id);

    const res = await this.prisma.qualityEvent.updateMany({
      where: { id, status: STATUS.PRIJAVLJEN },
      data: {
        status: STATUS.ODBACEN,
        rejectedByUserId: actor.userId,
        rejectedAt: new Date(),
        rejectReason: dto.rejectReason.trim(),
      },
    });
    if (res.count === 0)
      throw new ConflictException(
        `Događaj ${id} je u međuvremenu obrađen — osvežite stranicu.`,
      );

    const updated = await this.prisma.qualityEvent.findUnique({
      where: { id },
    });
    return { data: (await this.mapMany([updated!]))[0] };
  }

  // ------------------------------------------------------------------ PARETO (samo POTVRDJEN)

  /**
   * `GET /kvalitet/events/pareto` — zbir po razlogu i po mašini nad POTVRDJEN događajima
   * (§4). Bez grafike — count, qty i procenat (udeo u ukupnoj količini). Sort qty desc.
   */
  async pareto(query: QualityParetoQuery) {
    const where: Prisma.QualityEventWhereInput = { status: STATUS.POTVRDJEN };
    const type = this.normalizeType(query.type);
    if (type) where.type = type;
    const from = parseDateParam(query.from, "from");
    const to = parseDateParam(query.to, "to");
    if (from || to)
      where.reportedAt = {
        ...(from ? { gte: from } : {}),
        ...(to ? { lte: to } : {}),
      };

    const [byReasonRaw, byMachineRaw] = await Promise.all([
      this.prisma.qualityEvent.groupBy({
        by: ["reasonCodeId"],
        where,
        _count: { _all: true },
        _sum: { qty: true },
      }),
      this.prisma.qualityEvent.groupBy({
        by: ["workUnitCode"],
        where,
        _count: { _all: true },
        _sum: { qty: true },
      }),
    ]);

    const totalQty = byReasonRaw.reduce((s, g) => s + toNum(g._sum.qty), 0);
    const pct = (q: number) =>
      totalQty > 0 ? Math.round((q / totalQty) * 1000) / 10 : 0;

    // Labele razloga (batch).
    const reasonIds = uniqueIds(byReasonRaw.map((g) => g.reasonCodeId));
    const reasons = reasonIds.length
      ? byId(
          await this.prisma.qualityReasonCode.findMany({
            where: { id: { in: reasonIds } },
            select: { id: true, label: true },
          }),
        )
      : new Map<number, { id: number; label: string }>();

    const byReason = byReasonRaw
      .map((g) => {
        const qty = toNum(g._sum.qty);
        return {
          reasonCodeId: g.reasonCodeId,
          label:
            g.reasonCodeId != null
              ? (reasons.get(g.reasonCodeId)?.label ?? `#${g.reasonCodeId}`)
              : "Bez razloga",
          count: g._count._all,
          qty,
          percent: pct(qty),
        };
      })
      .sort((a, b) => b.qty - a.qty || b.count - a.count);

    const byMachine = byMachineRaw
      .map((g) => {
        const qty = toNum(g._sum.qty);
        return {
          workUnitCode: g.workUnitCode,
          label: g.workUnitCode ?? "Bez mašine",
          count: g._count._all,
          qty,
          percent: pct(qty),
        };
      })
      .sort((a, b) => b.qty - a.qty || b.count - a.count);

    return {
      data: { byReason, byMachine },
      meta: {
        from: from ?? null,
        to: to ?? null,
        type: type ?? null,
        totalQty,
      },
    };
  }

  // ------------------------------------------------------------------ HELPERI (validacija/resolve)

  private buildWhere(
    query: ListQualityEventsQuery,
  ): Prisma.QualityEventWhereInput {
    const where: Prisma.QualityEventWhereInput = {};
    const type = this.normalizeType(query.type);
    if (type) where.type = type;
    if (
      query.status &&
      (QUALITY_EVENT_STATUSES as readonly string[]).includes(query.status)
    )
      where.status = query.status;

    const workOrderId = Number.parseInt(query.workOrderId ?? "", 10);
    if (Number.isInteger(workOrderId) && workOrderId > 0)
      where.workOrderId = workOrderId;

    const reasonCodeId = Number.parseInt(query.reasonCodeId ?? "", 10);
    if (Number.isInteger(reasonCodeId) && reasonCodeId > 0)
      where.reasonCodeId = reasonCodeId;

    const machine = query.machine?.trim();
    if (machine)
      where.workUnitCode = { contains: machine, mode: "insensitive" };

    const from = parseDateParam(query.from, "from");
    const to = parseDateParam(query.to, "to");
    if (from || to)
      where.reportedAt = {
        ...(from ? { gte: from } : {}),
        ...(to ? { lte: to } : {}),
      };
    return where;
  }

  private normalizeType(type: string | undefined): string | undefined {
    return type && (QUALITY_EVENT_TYPES as readonly string[]).includes(type)
      ? type
      : undefined;
  }

  /** Razlog mora postojati i biti aktivan (soft-delete ne sme da uđe u nov unos). 422 inače. */
  private async assertReasonActive(reasonCodeId: number): Promise<void> {
    const reason = await this.prisma.qualityReasonCode.findUnique({
      where: { id: reasonCodeId },
      select: { id: true, active: true },
    });
    if (!reason)
      throw new UnprocessableEntityException(
        `Razlog ${reasonCodeId} ne postoji.`,
      );
    if (!reason.active)
      throw new UnprocessableEntityException(
        `Razlog ${reasonCodeId} je ukinut i ne može se koristiti.`,
      );
  }

  /** Učitaj događaj za tranziciju statusa: 404 ako ne postoji, 409 ako nije PRIJAVLJEN. */
  private async loadForTransition(
    id: number,
  ): Promise<{ id: number; status: string; workOrderId: number }> {
    const existing = await this.prisma.qualityEvent.findUnique({
      where: { id },
      select: { id: true, status: true, workOrderId: true },
    });
    if (!existing) throw new NotFoundException(`Događaj ${id} ne postoji.`);
    if (existing.status !== STATUS.PRIJAVLJEN)
      throw new ConflictException(
        `Događaj ${id} nije u statusu PRIJAVLJEN (trenutno: ${existing.status}) — obrada nije moguća.`,
      );
    return existing;
  }

  /** Radni nalog mora postojati (inače tiho vezivanje za pogrešan RN — review [0]). 422 inače. */
  private async assertWorkOrder(
    workOrderId: number,
  ): Promise<{ id: number; identNumber: string }> {
    const wo = await this.prisma.workOrder.findUnique({
      where: { id: workOrderId },
      select: { id: true, identNumber: true },
    });
    if (!wo)
      throw new UnprocessableEntityException(
        `Radni nalog ${workOrderId} ne postoji.`,
      );
    return wo;
  }

  /**
   * Operacija (`tech_processes`) mora postojati i pripadati datom RN-u (review [6]) —
   * inače se škart veže za operaciju tuđeg naloga. Vraća `work_center_code` (RC kod)
   * za popunu radne jedinice. 422 ako ne postoji ili ne pripada RN-u.
   */
  private async assertTechProcessBelongs(
    techProcessId: number,
    workOrderId: number,
  ): Promise<string | null> {
    const tp = await this.prisma.techProcess.findUnique({
      where: { id: techProcessId },
      select: { id: true, workOrderId: true, workCenterCode: true },
    });
    if (!tp)
      throw new UnprocessableEntityException(
        `Operacija ${techProcessId} ne postoji.`,
      );
    if (tp.workOrderId !== workOrderId)
      throw new UnprocessableEntityException(
        `Operacija ${techProcessId} ne pripada radnom nalogu ${workOrderId}.`,
      );
    return tp.workCenterCode?.trim() || null;
  }

  /** Razrešavanje radnika po ID kartici (kiosk identitet); samo AKTIVAN radnik (review [8],
   *  `active` je nullable — legacy sync, pa `not: false` a ne `= true`). 422 ako nije prepoznata. */
  private async resolveWorkerByCard(card: string): Promise<WorkerRef> {
    const trimmed = card.trim();
    const worker = await this.prisma.worker.findFirst({
      where: { cardId: trimmed, active: { not: false } },
      select: SAFE_WORKER_SELECT,
    });
    if (!worker)
      throw new UnprocessableEntityException(
        "ID kartica nije prepoznata (ili je radnik neaktivan) — prijava nije moguća.",
      );
    return worker;
  }

  /**
   * Radna jedinica (RC kod): eksplicitna vrednost ako je zadata; inače iz operacije
   * (`tech_processes.work_center_code`). Ako je `techProcessId` zadat, uvek se validira
   * pripadnost RN-u (review [6]) — i kad je `workUnitCode` eksplicitan.
   */
  private async resolveWorkUnit(
    workUnitCode: string | null | undefined,
    techProcessId: number | null | undefined,
    workOrderId: number,
  ): Promise<string | null> {
    const tpCode =
      techProcessId != null
        ? await this.assertTechProcessBelongs(techProcessId, workOrderId)
        : null;
    const explicit = workUnitCode?.trim();
    if (explicit) return explicit.slice(0, 20);
    return tpCode;
  }

  /**
   * Zvonce menadžmentu iznad praga (§4) — best-effort (try/catch, NIKAD ne baca; kao D8).
   * Prag (env): pojedinačna qty ≥ `KVALITET_EVENT_ALERT_QTY` (default 5) ILI ≥
   * `KVALITET_EVENT_ALERT_COUNT` (default 3) POTVRDJEN događaja istog razloga u 7 dana.
   * Kanali: in-app zvonce (`notifyWorkers` + management worker-id) + mail (fire-and-forget).
   * Okida se SAMO za POTVRDJEN događaje (PRIJAVLJEN/ODBACEN ne ulaze u izveštaje).
   */
  private async maybeAlert(event: QualityEvent): Promise<void> {
    if (event.status !== STATUS.POTVRDJEN) return;
    try {
      const qtyThreshold = envInt("KVALITET_EVENT_ALERT_QTY", 5);
      const countThreshold = envInt("KVALITET_EVENT_ALERT_COUNT", 3);
      const qty = toNum(event.qty);
      const reasons: string[] = [];

      if (qty >= qtyThreshold)
        reasons.push(
          `pojedinačna količina ${qty} ${event.unit} ≥ ${qtyThreshold}`,
        );

      if (event.reasonCodeId != null) {
        const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        const recent = await this.prisma.qualityEvent.count({
          where: {
            status: STATUS.POTVRDJEN,
            reasonCodeId: event.reasonCodeId,
            reportedAt: { gte: since },
          },
        });
        if (recent >= countThreshold)
          reasons.push(
            `${recent} potvrđenih događaja istog razloga u 7 dana (prag ${countThreshold})`,
          );
      }
      if (!reasons.length) return;

      const reasonLabel = event.reasonCodeId
        ? ((
            await this.prisma.qualityReasonCode.findUnique({
              where: { id: event.reasonCodeId },
              select: { label: true },
            })
          )?.label ?? null)
        : null;
      const typeLabel = TYPE_LABEL[event.type] ?? event.type.toLowerCase();
      const thresholdReason = reasons.join("; ");

      // In-app zvonce menadžmentu (worker-scoped). Nalog bez vezanog radnika nema
      // inbox red — to nije greška (deljeni terminali); mail ga svejedno pokriva.
      const workerIds = await resolveManagementWorkerIds(this.prisma);
      if (workerIds.length)
        await this.notifications.notifyWorkers(workerIds, {
          type: `kvalitet.${event.type.toLowerCase()}`,
          message: `Kvalitet — ${typeLabel} iznad praga (RN ${event.workOrderId}, ${qty} ${event.unit}${
            reasonLabel ? `, razlog: ${reasonLabel}` : ""
          }).`,
          refTable: "quality_events",
          refId: event.id,
        });

      // Mail je fire-and-forget (samostalno guarded, ne baca) — ne blokira odgovor.
      void this.mail
        .notifyManagementThreshold(
          this.prisma,
          {
            id: event.id,
            type: event.type,
            qty: String(event.qty),
            unit: event.unit,
            reasonLabel,
            workOrderId: event.workOrderId,
            workUnitCode: event.workUnitCode,
          },
          thresholdReason,
        )
        .catch(() => undefined);
    } catch (err) {
      this.logger.warn(
        `Zvonce praga za događaj kvaliteta ${event.id} nije upisano: ${
          (err as Error).message
        }`,
      );
    }
  }

  // ------------------------------------------------------------------ SERIJALIZACIJA

  /** Batch-mapiranje redova → envelope (razreši razloge, radnike, korisnike). */
  private async mapMany(rows: QualityEvent[]) {
    if (!rows.length) return [];

    const reasonIds = uniqueIds(rows.map((r) => r.reasonCodeId));
    const reasons = reasonIds.length
      ? byId(
          await this.prisma.qualityReasonCode.findMany({
            where: { id: { in: reasonIds } },
            select: { id: true, code: true, label: true },
          }),
        )
      : new Map<number, { id: number; code: string; label: string }>();

    const workers = await this.resolveWorkers(
      rows.map((r) => r.reportedByWorkerId),
    );
    const users = await this.resolveUsers([
      ...rows.map((r) => r.confirmedByUserId),
      ...rows.map((r) => r.rejectedByUserId),
      ...rows.map((r) => r.createdByUserId),
    ]);
    // Razreši poslovni broj RN-a (ident_number) — UI prikazuje njega, ne interni id (review [4]).
    const workOrders = await this.resolveWorkOrders(
      rows.map((r) => r.workOrderId),
    );

    return rows.map((r) =>
      this.mapEvent(r, reasons, workers, users, workOrders),
    );
  }

  private mapEvent(
    r: QualityEvent,
    reasons: Map<number, { id: number; code: string; label: string }>,
    workers: Map<number, WorkerRef>,
    users: Map<number, { id: number; fullName: string | null }>,
    workOrders: Map<number, { id: number; identNumber: string }>,
  ) {
    const reason =
      r.reasonCodeId != null ? (reasons.get(r.reasonCodeId) ?? null) : null;
    const reporter =
      r.reportedByWorkerId != null
        ? {
            id: r.reportedByWorkerId,
            fullName: workers.get(r.reportedByWorkerId)?.fullName ?? null,
          }
        : null;
    const userName = (id: number | null) =>
      id != null ? { id, fullName: users.get(id)?.fullName ?? null } : null;
    return {
      id: r.id,
      type: r.type,
      status: r.status,
      workOrderId: r.workOrderId,
      workOrderIdent: workOrders.get(r.workOrderId)?.identNumber ?? null,
      techProcessId: r.techProcessId,
      qty: r.qty != null ? r.qty.toString() : null,
      unit: r.unit,
      reasonCodeId: r.reasonCodeId,
      reason: reason
        ? { id: reason.id, code: reason.code, label: reason.label }
        : null,
      note: r.note,
      machineId: r.machineId,
      workUnitCode: r.workUnitCode,
      reportedByWorkerId: r.reportedByWorkerId,
      reportedByWorker: reporter,
      reportedAt: r.reportedAt,
      confirmedBy: userName(r.confirmedByUserId),
      confirmedAt: r.confirmedAt,
      rejectedBy: userName(r.rejectedByUserId),
      rejectedAt: r.rejectedAt,
      rejectReason: r.rejectReason,
      photoPath: r.photoPath,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    };
  }

  /** Batch-resolve RN-ova → poslovni broj (ident_number); prazna mapa za prazan ulaz. */
  private async resolveWorkOrders(
    ids: (number | null | undefined)[],
  ): Promise<Map<number, { id: number; identNumber: string }>> {
    const uniq = uniqueIds(ids);
    if (!uniq.length)
      return new Map<number, { id: number; identNumber: string }>();
    return byId(
      await this.prisma.workOrder.findMany({
        where: { id: { in: uniq } },
        select: { id: true, identNumber: true },
      }),
    );
  }

  /** Batch-resolve radnika (SAFE — bez lozinki); prazna mapa za prazan ulaz. */
  private async resolveWorkers(
    ids: (number | null | undefined)[],
  ): Promise<Map<number, WorkerRef>> {
    const uniq = uniqueIds(ids);
    if (!uniq.length) return new Map<number, WorkerRef>();
    return byId(
      await this.prisma.worker.findMany({
        where: { id: { in: uniq } },
        select: SAFE_WORKER_SELECT,
      }),
    );
  }

  /** Batch-resolve `users` (potvrdio/odbacio/kreirao); prazna mapa za prazan ulaz. */
  private async resolveUsers(
    ids: (number | null | undefined)[],
  ): Promise<Map<number, { id: number; fullName: string | null }>> {
    const uniq = uniqueIds(ids);
    if (!uniq.length)
      return new Map<number, { id: number; fullName: string | null }>();
    return byId(
      await this.prisma.user.findMany({
        where: { id: { in: uniq } },
        select: { id: true, fullName: true },
      }),
    );
  }
}
