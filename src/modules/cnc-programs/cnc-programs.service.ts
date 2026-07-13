import {
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { pageMeta, parsePagination } from "../../common/pagination";
import { byId, uniqueIds } from "../../common/relations";
import { resolveActorWorkerId } from "../../common/workers/resolve-actor-worker";
import type { AuthUser } from "../auth/jwt.strategy";
import {
  validateSetCncProgramDone,
  type SetCncProgramDoneDto,
} from "./dto/set-cnc-program-done.dto";
import {
  validateMoveCncQueue,
  type MoveCncQueueDto,
} from "./dto/move-cnc-queue.dto";

/** Lokalni gornji limit strane za CAM listu (FE traži ceo red jednom stranom). */
const CAM_LIST_MAX_PAGE_SIZE = 500;
/** Safety cap na broj kandidata koje učitavamo (CAM skup je ~stotine pozicija). */
const CAM_CANDIDATES_CAP = 1000;

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
    // pageSize do 500 SAMO za ovaj endpoint (FE traži ceo CAM red jednom stranom);
    // ostali endpointi zadržavaju parsePagination default max (200).
    const { page, pageSize } = parsePagination(
      query.page,
      query.pageSize,
      CAM_LIST_MAX_PAGE_SIZE,
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

    // CAM red se sortira po `queue_order` koji živi na `cnc_programs` (bez Prisma
    // relacije na WorkOrder), pa DB-paginacija po WorkOrder-u nije moguća. Skup
    // kandidata je ograničen (~stotine; cap 1000), pa učitamo SVE kandidate +
    // njihove cnc_programs redove JEDNIM findMany, spojimo, primenimo onlyPending
    // PRE slice-a (popravlja raniji caveat: filter posle paginacije), sortiramo
    // po ugovoru, pa isečemo stranu.
    const candidates = await this.prisma.workOrder.findMany({
      where,
      take: CAM_CANDIDATES_CAP,
      select: {
        id: true,
        projectId: true,
        identNumber: true,
        variant: true,
        partName: true,
        drawingNumber: true,
        drawingId: true,
        pieceCount: true,
        productionDeadline: true,
      },
    });

    const programRows = await this.prisma.cncProgram.findMany({
      where: { workOrderId: { in: candidates.map((r) => r.id) } },
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

    let merged = candidates.map((r) => {
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
          queueOrder: p?.queueOrder ?? null,
        },
      };
    });

    // onlyPending PRE slice-a (raniji caveat: filtrirao se posle paginacije, pa
    // je strana mogla imati manje redova nego pageSize dok su ranjiji otpadali).
    if (query.onlyPending === "true" || query.onlyPending === "1")
      merged = merged.filter((r) => !r.cam.isDone);

    // Sort po ugovoru: queueOrder asc NULLS LAST → productionDeadline asc NULLS
    // LAST (kao dosadašnji Prisma `productionDeadline: asc` na PG) → id desc.
    merged.sort((a, b) => {
      const qa = a.cam.queueOrder;
      const qb = b.cam.queueOrder;
      if (qa !== qb) {
        if (qa == null) return 1; // NULL red ide posle rangiranog
        if (qb == null) return -1;
        return qa - qb;
      }
      const da = a.productionDeadline ? a.productionDeadline.getTime() : null;
      const db = b.productionDeadline ? b.productionDeadline.getTime() : null;
      if (da !== db) {
        if (da == null) return 1; // NULL rok ide posle (PG asc NULLS LAST)
        if (db == null) return -1;
        return da - db;
      }
      return b.id - a.id; // id desc
    });

    const total = merged.length;
    const data = merged.slice(
      (page - 1) * pageSize,
      (page - 1) * pageSize + pageSize,
    );

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

  /**
   * Premeštanje pozicije u CAM redu (prevlačenje) — Miljan/Nikola/Jovica.
   *
   * Semantika (ugovor sa FE): `afterWorkOrderId` = id reda NEPOSREDNO IZNAD mete
   * (null = na vrh); prevučena pozicija se ubacuje ISPOD njega. `remove: true` =
   * skida poziciju iz rangiranja (queue_order → NULL). Rang se renumeriše 1..N
   * bez rupa nakon svake operacije.
   *
   * Konkurentnost: `pg_advisory_xact_lock` serijalizuje izmene reda (poslednji
   * pobeđuje — poslovno OK). Audit `queueSetByWorkerId` iz SVEŽEG worker lookup-a
   * (`resolveActorWorkerId`), nikad direktno iz JWT-a (stale-token slučaj).
   */
  async moveInQueue(
    workOrderId: number,
    dto: MoveCncQueueDto,
    actor?: AuthUser,
  ) {
    validateMoveCncQueue(dto);

    return this.prisma.$transaction(async (tx) => {
      // Serijalizuj sve izmene CAM reda (jedan logički lock za ceo red).
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('cam_queue'))`;

      const wo = await tx.workOrder.findUnique({
        where: { id: workOrderId },
        select: { id: true },
      });
      if (!wo)
        throw new NotFoundException(`Radni nalog ${workOrderId} ne postoji.`);

      // Trenutni rangirani red (queue_order NOT NULL), rastuće.
      const ranked = await tx.cncProgram.findMany({
        where: { queueOrder: { not: null } },
        select: { workOrderId: true, queueOrder: true },
        orderBy: { queueOrder: "asc" },
      });
      let order = ranked.map((r) => r.workOrderId);

      if (dto.remove === true) {
        // Skini iz rangiranja (ako je uopšte u redu; inače no-op) i renumeriši.
        const wasRanked = order.includes(workOrderId);
        order = order.filter((id) => id !== workOrderId);
        if (wasRanked) {
          const p = await tx.cncProgram.findUnique({
            where: { workOrderId },
            select: { workOrderId: true },
          });
          // Red mora postojati ako je bio rangiran, ali branimo se od trke.
          if (p)
            await tx.cncProgram.update({
              where: { workOrderId },
              data: {
                queueOrder: null,
                queueSetByWorkerId: null,
                queueSetAt: null,
              },
            });
        }
        await this.renumberQueue(tx, order, workOrderId, actor);
        return { data: { workOrderId, queueOrder: null } };
      }

      // Ubacivanje: afterWorkOrderId = red IZNAD mete (null = vrh).
      const after = dto.afterWorkOrderId ?? null;
      if (after !== null) {
        if (after === workOrderId) {
          // Drop na samog sebe = no-op; vrati trenutni rang.
          const idx = order.indexOf(workOrderId);
          return {
            data: { workOrderId, queueOrder: idx >= 0 ? idx + 1 : null },
          };
        }
        if (!order.includes(after))
          throw new UnprocessableEntityException(
            `Pozicija ${after} nije u CAM redu (mora biti rangirana).`,
          );
      }

      // Izbaci prevučeni red iz trenutne pozicije (ako je već rangiran), pa ga
      // ubaci ODMAH IZA `after` (ili na vrh kad je after === null).
      order = order.filter((id) => id !== workOrderId);
      const insertAt = after === null ? 0 : order.indexOf(after) + 1;
      order.splice(insertAt, 0, workOrderId);

      await this.renumberQueue(tx, order, workOrderId, actor);
      const newQueueOrder = order.indexOf(workOrderId) + 1;
      return { data: { workOrderId, queueOrder: newQueueOrder } };
    });
  }

  /**
   * Renumeriše rang 1..N bez rupa nad datim redosledom `order` (niz workOrderId).
   * Audit (`queueSetByWorkerId`/`queueSetAt`) upisuje SAMO na dodirnutim redovima;
   * ovde radi renumeraciju za sve (splice/remove pomera rangove) — jeftino jer je
   * red mali (~stotine). `queueSetByWorkerId` = svež worker lookup aktora.
   */
  private async renumberQueue(
    tx: Prisma.TransactionClient,
    order: number[],
    _movedWorkOrderId: number,
    actor?: AuthUser,
  ): Promise<void> {
    const workerId = await resolveActorWorkerId(tx, actor);
    const now = new Date();
    for (let i = 0; i < order.length; i++) {
      const woId = order[i];
      const queueOrder = i + 1;
      await tx.cncProgram.upsert({
        where: { workOrderId: woId },
        create: {
          workOrderId: woId,
          queueOrder,
          queueSetByWorkerId: workerId,
          queueSetAt: now,
        },
        update: {
          queueOrder,
          queueSetByWorkerId: workerId,
          queueSetAt: now,
        },
      });
    }
  }
}
