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

  async list(query: ListCncProgramsQuery) {
    const { page, pageSize, skip, take } = parsePagination(
      query.page,
      query.pageSize,
    );

    const camCodes = await this.camWorkCenterCodes();
    if (!camCodes.length) {
      return { data: [], meta: pageMeta(page, pageSize, 0) };
    }

    // Pozicija zahteva CAM = NEZAVRŠEN RN (status ≠ true) sa bar jednom
    // operacijom na CAM radnom centru. `some` relacijski filter = bez ručnog JOIN-a.
    const where: Prisma.WorkOrderWhereInput = {
      status: { not: true },
      operations: { some: { workCenterCode: { in: camCodes } } },
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
