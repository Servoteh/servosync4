import {
  Injectable,
  Logger,
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

/** Minimalna polja za prikazni redosled CAM reda (list i move dele komparator). */
export interface CamDisplayRef {
  id: number;
  productionDeadline: Date | null;
  queueOrder: number | null;
}

/**
 * Komparator PRIKAZNOG redosleda (ugovor sa FE): queue_order asc NULLS LAST →
 * rok asc NULLS LAST (PG semantika dosadašnjeg `productionDeadline: asc`) →
 * id desc. `moveInQueue` računa mete nad ISTIM redosledom koji FE renderuje —
 * to je bio review HIGH nalaz (meta sme biti i NErangiran red).
 */
export function compareCamDisplay(a: CamDisplayRef, b: CamDisplayRef): number {
  const qa = a.queueOrder;
  const qb = b.queueOrder;
  if (qa !== qb) {
    if (qa == null) return 1; // NULL rang ide posle rangiranog
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
}

/**
 * Čist izračun novog redosleda: `moved` se ubacuje ODMAH IZA `after`
 * (null = na vrh) u prikaznom redosledu `displayIds`. Poziv garantuje da su
 * `moved` i `after` u skupu. Vraća NOV niz (ne mutira ulaz).
 */
export function computeNewCamOrder(
  displayIds: number[],
  moved: number,
  after: number | null,
): number[] {
  const working = displayIds.filter((id) => id !== moved);
  const insertAt = after === null ? 0 : working.indexOf(after) + 1;
  working.splice(insertAt, 0, moved);
  return working;
}

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
  private readonly logger = new Logger(CncProgramsService.name);

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
      // Deterministična truncacija na cap-u (review LOW: bez orderBy bi cap
      // sekao proizvoljno). Rok/id je i fallback prikaznog redosleda.
      orderBy: [{ productionDeadline: "asc" }, { id: "desc" }],
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
    if (candidates.length === CAM_CANDIDATES_CAP)
      this.logger.warn(
        `CAM kandidata je tačno ${CAM_CANDIDATES_CAP} (cap) — mogući odsečeni redovi; razmotriti veći cap ili DB-side sort.`,
      );

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

    // Sort po ugovoru — DELJENI komparator sa moveInQueue (isti prikazni red).
    merged.sort((a, b) =>
      compareCamDisplay(
        {
          id: a.id,
          productionDeadline: a.productionDeadline,
          queueOrder: a.cam.queueOrder,
        },
        {
          id: b.id,
          productionDeadline: b.productionDeadline,
          queueOrder: b.cam.queueOrder,
        },
      ),
    );

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
   * u PRIKAZNOM redosledu (null = na vrh); prevučena pozicija se ubacuje ISPOD
   * njega. Meta sme biti i NErangiran red (review HIGH: početno stanje je ceo
   * red nerangiran) — potez MATERIJALIZUJE rang 1..N za ceo prikazni red, pa je
   * redosled posle prvog poteza potpuno eksplicitan. `remove: true` = skida
   * poziciju iz rangiranja (queue_order → NULL, vraća se u nerangiranu zonu).
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

    // Kandidati se filtriraju ISTIM predikatima kao list() (review LOW: ranija
    // verzija je proveravala samo postojanje RN-a, pa se mogao rangirati i
    // završen/ne-CAM nalog).
    const [camCodes, camDoneCodes] = await Promise.all([
      this.camWorkCenterCodes(),
      this.camDoneWorkCenterCodes(),
    ]);
    const camDoneIds = await this.workOrderIdsWithCamDone(camDoneCodes);

    return this.prisma.$transaction(
      async (tx) => {
        // Serijalizuj sve izmene CAM reda (jedan logički lock za ceo red).
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('cam_queue'))`;

        const candidates = await tx.workOrder.findMany({
          where: {
            status: { not: true },
            operations: { some: { workCenterCode: { in: camCodes } } },
            ...(camDoneIds.length ? { id: { notIn: camDoneIds } } : {}),
          },
          take: CAM_CANDIDATES_CAP,
          orderBy: [{ productionDeadline: "asc" }, { id: "desc" }],
          select: { id: true, productionDeadline: true },
        });
        const candidateIds = new Set(candidates.map((c) => c.id));

        if (!candidateIds.has(workOrderId)) {
          const wo = await tx.workOrder.findUnique({
            where: { id: workOrderId },
            select: { id: true },
          });
          if (!wo)
            throw new NotFoundException(
              `Radni nalog ${workOrderId} ne postoji.`,
            );
          throw new UnprocessableEntityException(
            `Pozicija ${workOrderId} nije u CAM redu (završena je ili nema CAM operaciju).`,
          );
        }

        const programs = await tx.cncProgram.findMany({
          where: { workOrderId: { in: [...candidateIds] } },
          select: { workOrderId: true, queueOrder: true },
        });
        const rankOf = new Map(
          programs.map((p) => [p.workOrderId, p.queueOrder]),
        );

        // PRIKAZNI redosled — identičan onome što FE renderuje (deljeni
        // komparator sa list()). Review HIGH: meta poteza sme biti i
        // NErangiran red (početno stanje je ceo red nerangiran).
        const display = candidates
          .map((c) => ({
            id: c.id,
            productionDeadline: c.productionDeadline,
            queueOrder: rankOf.get(c.id) ?? null,
          }))
          .sort(compareCamDisplay)
          .map((c) => c.id);

        if (dto.remove === true) {
          // Skini iz rangiranja (queue_order → NULL) i kompaktuj PREOSTALE
          // rangirane 1..N (nerangirani se ne diraju — red se vraća u
          // „nerangiranu zonu" po roku).
          const wasRanked = rankOf.get(workOrderId) != null;
          if (wasRanked)
            await tx.cncProgram.update({
              where: { workOrderId },
              data: {
                queueOrder: null,
                queueSetByWorkerId: null,
                queueSetAt: null,
              },
            });
          const remainingRanked = display.filter(
            (id) => id !== workOrderId && rankOf.get(id) != null,
          );
          await this.renumberQueue(tx, remainingRanked, actor);
          return { data: { workOrderId, queueOrder: null } };
        }

        const after = dto.afterWorkOrderId ?? null;
        if (after !== null && after === workOrderId) {
          // Drop na samog sebe = no-op (bez upisa); vrati trenutni rang.
          return {
            data: { workOrderId, queueOrder: rankOf.get(workOrderId) ?? null },
          };
        }
        if (after !== null && !candidateIds.has(after))
          throw new UnprocessableEntityException(
            `Pozicija ${after} nije u CAM redu — meta poteza mora biti pozicija iz liste.`,
          );

        // Novi redosled + MATERIJALIZACIJA: rang 1..N se upisuje za CEO
        // prikazni red (ne samo rangirani deo). Time svaki sused postaje
        // validna meta narednih poteza, a redosled je potpuno eksplicitan.
        // Novi RN-ovi koji se kasnije pojave ulaze nerangirani na dno.
        const newOrder = computeNewCamOrder(display, workOrderId, after);
        await this.renumberQueue(tx, newOrder, actor);
        return {
          data: { workOrderId, queueOrder: newOrder.indexOf(workOrderId) + 1 },
        };
      },
      // Batch upis je 1 round-trip, ali lock čekanje ulazi u budžet transakcije
      // (review LOW: Prisma default 5s) — dižemo eksplicitno.
      { timeout: 15_000 },
    );
  }

  /**
   * Materijalizuje rang 1..N nad datim redosledom JEDNIM SQL iskazom
   * (unnest + ON CONFLICT po `uq_cnc_programs_work_order`) — review LOW:
   * N sekvencijalnih upserta je probijalo Prisma tx budžet. Audit
   * `queueSetByWorkerId` = svež worker lookup aktora (nikad direktno JWT).
   */
  private async renumberQueue(
    tx: Prisma.TransactionClient,
    order: number[],
    actor?: AuthUser,
  ): Promise<void> {
    if (!order.length) return;
    const workerId = await resolveActorWorkerId(tx, actor);
    const ranks = order.map((_, i) => i + 1);
    await tx.$executeRaw`
      INSERT INTO cnc_programs (work_order_id, queue_order, queue_set_by_worker_id, queue_set_at)
      SELECT u.wo_id, u.rank, ${workerId}, now()
      FROM unnest(${order}::int[], ${ranks}::int[]) AS u(wo_id, rank)
      ON CONFLICT (work_order_id) DO UPDATE
      SET queue_order = EXCLUDED.queue_order,
          queue_set_by_worker_id = EXCLUDED.queue_set_by_worker_id,
          queue_set_at = EXCLUDED.queue_set_at
    `;
  }
}
