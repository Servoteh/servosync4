import { Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { pageMeta, parsePagination } from "../../common/pagination";
import { byId, uniqueIds } from "../../common/relations";
import type { AuthUser } from "../auth/jwt.strategy";
import {
  validateSetCncProgramDone,
  type SetCncProgramDoneDto,
} from "./dto/set-cnc-program-done.dto";

export interface ListCncProgramsQuery {
  page?: string;
  pageSize?: string;
  /** Pretraga po identu / nazivu pozicije / crtežu. */
  q?: string;
  /** '1'/'true' = samo pozicije kojima CAM JOŠ NIJE završen. */
  onlyPending?: string;
}

/**
 * CAM / CNC programiranje (Miljan t.7, ODLUKE #8 + #35). „Pozicija zahteva CAM"
 * se IZVODI iz rutinga: RN čije operacije koriste prioritet
 * (`operations.usesPriority=true`) — isti signal koji puni „Operacije po
 * prioritetu" (CNC planska tabla). Ovaj modul dodaje pregled tih pozicija +
 * čekiranje „CAM završen" sa auditom ko/kada (`cnc_programs`, app-owned).
 *
 * Status se pamti po `workOrderId` (jedna pozicija = jedan CAM zapis); read je
 * left-join na `cnc_programs`, write je upsert. Gate: read=tehnologija.read,
 * write=tehnologija.write (rola `cnc_programer` ima oba, `rn.write` NE — zato
 * ovde ne diramo RN).
 */
@Injectable()
export class CncProgramsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Radni centri (šifre) čije operacije koriste prioritet = kandidati za CAM. */
  private async camWorkCenterCodes(): Promise<string[]> {
    const ops = await this.prisma.operation.findMany({
      where: { usesPriority: true },
      select: { workCenterCode: true },
    });
    return [...new Set(ops.map((o) => o.workCenterCode).filter(Boolean))];
  }

  /**
   * Šifre radnih centara koji ZNAČE da je CAM već urađen (proba 13.07, Miljan):
   *  - CNC glodanje/struganje (naziv počinje „CNC") — CAM programiranje PRETHODI
   *    tim operacijama, pa otkucano CNC ⇒ CAM implicitno urađen (glavni signal:
   *    izbacuje 271/549 pozicija);
   *  - završna kontrola (`significantForFinishing`) — pozicija proizvodno gotova.
   * Pozicija čija je trojka otkucala bilo koju od ovih (isProcessFinished) izlazi
   * iz CAM liste. Naziv „CNC" je jedini stabilan signal (svi ti RC-ovi imaju
   * `uses_priority=f`, `significant=f`); univerzalno glodanje/struganje (ručne
   * mašine, bez CAM-a) su namerno IZUZETI.
   */
  private async camDoneWorkCenterCodes(): Promise<string[]> {
    const ops = await this.prisma.operation.findMany({
      where: {
        OR: [
          { workCenterName: { startsWith: "CNC", mode: "insensitive" } },
          { significantForFinishing: true },
        ],
      },
      select: { workCenterCode: true },
    });
    return [...new Set(ops.map((o) => o.workCenterCode).filter(Boolean))];
  }

  /**
   * Id-jevi RN-ova čija je trojka (projectId, identNumber, variant) otkucala
   * operaciju koja implicira urađen CAM (CNC glodanje/struganje ili završna
   * kontrola). `tech_processes`↔`work_orders` veza je poslovna trojka (nema
   * FK/relacije), pa raw JOIN po trojci. `[]` kad nema takvih RC-ova.
   */
  private async workOrderIdsWithCamDone(
    camDoneCodes: string[],
  ): Promise<number[]> {
    if (!camDoneCodes.length) return [];
    const rows = await this.prisma.$queryRaw<{ id: number }[]>(Prisma.sql`
      SELECT DISTINCT wo.id
      FROM work_orders wo
      JOIN tech_processes tp
        ON tp.project_id = wo.project_id
       AND tp.ident_number = wo.ident_number
       AND tp.variant = wo.variant
      WHERE tp.work_center_code IN (${Prisma.join(camDoneCodes)})
        AND COALESCE(tp.is_process_finished, false) = true
    `);
    return rows.map((r) => r.id);
  }

  async list(query: ListCncProgramsQuery) {
    const { page, pageSize, skip, take } = parsePagination(
      query.page,
      query.pageSize,
    );

    const [camCodes, camDoneCodes] = await Promise.all([
      this.camWorkCenterCodes(),
      this.camDoneWorkCenterCodes(),
    ]);
    if (!camCodes.length) {
      return { data: [], meta: pageMeta(page, pageSize, 0) };
    }

    // Pozicija zahteva CAM = NEZAVRŠEN RN sa bar jednom CAM operacijom
    // (`usesPriority`, tj. 17.0/17.1), a NIJE joj otkucana operacija koja
    // implicira urađen CAM — CNC glodanje/struganje (CAM prethodi) ili završna
    // kontrola (proba 13.07 — smanjuje 549→~270 pozicija). `tech_processes` NEMA
    // Prisma relaciju na WorkOrder (veza je poslovna trojka), pa se izračuna skup
    // RN id-jeva sa otkucanim CAM-done signalom i isključi kroz `id notIn`.
    const camDoneIds = await this.workOrderIdsWithCamDone(camDoneCodes);
    const where: Prisma.WorkOrderWhereInput = {
      status: { not: true },
      operations: { some: { workCenterCode: { in: camCodes } } },
      ...(camDoneIds.length ? { id: { notIn: camDoneIds } } : {}),
    };
    if (query.q) {
      where.OR = [
        { identNumber: { contains: query.q, mode: "insensitive" } },
        { partName: { contains: query.q, mode: "insensitive" } },
        { drawingNumber: { contains: query.q, mode: "insensitive" } },
      ];
    }

    // `onlyPending` filtrira posle spajanja sa cnc_programs (isDone) — radi se
    // na page-nivou nakon dohvata statusa (mali skup: samo nezavršeni CAM RN-ovi).
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.workOrder.findMany({
        where,
        orderBy: [{ productionDeadline: "asc" }, { id: "desc" }],
        skip,
        take,
        select: {
          id: true,
          projectId: true,
          identNumber: true,
          variant: true,
          partName: true,
          drawingNumber: true,
          pieceCount: true,
          productionDeadline: true,
        },
      }),
      this.prisma.workOrder.count({ where }),
    ]);

    const programRows = await this.prisma.cncProgram.findMany({
      where: { workOrderId: { in: rows.map((r) => r.id) } },
    });
    const programs = new Map(programRows.map((p) => [p.workOrderId, p]));
    const workers = byId(
      await this.prisma.worker.findMany({
        where: {
          id: {
            in: uniqueIds(
              programRows
                .map((p) => p.completedByWorkerId)
                .filter((x): x is number => x != null),
            ),
          },
        },
        select: { id: true, fullName: true, username: true },
      }),
    );

    let data = rows.map((r) => {
      const p = programs.get(r.id);
      return {
        ...r,
        cam: {
          isDone: p?.isDone ?? false,
          completedAt: p?.completedAt ?? null,
          completedBy:
            p?.completedByWorkerId != null
              ? (workers.get(p.completedByWorkerId) ?? null)
              : null,
          note: p?.note ?? null,
        },
      };
    });
    if (query.onlyPending === "true" || query.onlyPending === "1")
      data = data.filter((r) => !r.cam.isDone);

    return { data, meta: pageMeta(page, pageSize, total) };
  }

  /**
   * Upsert „CAM završen" po poziciji. `isDone=true` → audit `completedBy/At`
   * (JWT worker); `false` → briše audit. Idempotentno. Zahteva postojeći RN.
   */
  async setDone(
    workOrderId: number,
    dto: SetCncProgramDoneDto,
    actor?: AuthUser,
  ) {
    validateSetCncProgramDone(dto);
    const wo = await this.prisma.workOrder.findUnique({
      where: { id: workOrderId },
      select: { id: true },
    });
    if (!wo)
      throw new NotFoundException(`Radni nalog ${workOrderId} ne postoji.`);

    const note = dto.note?.trim() || null;
    const completed = dto.isDone
      ? {
          completedByWorkerId: actor?.workerId ?? null,
          completedAt: new Date(),
        }
      : { completedByWorkerId: null, completedAt: null };

    await this.prisma.cncProgram.upsert({
      where: { workOrderId },
      create: { workOrderId, isDone: dto.isDone, note, ...completed },
      update: { isDone: dto.isDone, note, ...completed },
    });
    return { data: { workOrderId, isDone: dto.isDone } };
  }
}
