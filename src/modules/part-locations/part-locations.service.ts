import {
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import {
  pageMeta,
  parsePagination,
  SAFE_WORKER_SELECT,
} from "../../common/pagination";
import { byId, uniqueIds } from "../../common/relations";
import { alignIdSequence } from "../../common/db-sequences";
import {
  CreatePartLocationDto,
  RequisitionPartLocationDto,
  TransferPartLocationDto,
  validateCreatePartLocation,
  validateRequisitionPartLocation,
  validateTransferPartLocation,
} from "./dto/part-location.dto";

export interface ListPartLocationsQuery {
  page?: string;
  pageSize?: string;
  /** Pretraga: broj RN / naziv dela / crtež (WorkOrder), broj/naziv predmeta (Project), šifra/opis pozicije (Position). */
  q?: string;
  /** Radni nalog (tačan id). */
  workOrderId?: string;
  /** Predmet (tačan id). */
  projectId?: string;
  /** Pozicija/polica (tačan id). */
  positionId?: string;
  /** Radnik koji je uneo zapis (tačan id). */
  workerId?: string;
  /** Vrsta kvaliteta dela (tačan id — 0=OK,1=dorada,2=škart). */
  qualityTypeId?: string;
}

const intEq = (v: string | undefined) => {
  const n = Number.parseInt(v ?? "", 10);
  return Number.isNaN(n) ? undefined : n;
};

/** Zajednički oblik reda čiji se FK-ovi razrešavaju. */
interface PartLocationRow {
  workOrderId: number;
  projectId: number;
  positionId: number;
  workerId: number;
  qualityTypeId: number;
}

/**
 * 🔴 Konvencija predznaka ledgera (MODULE_SPEC_lokacije §3.1) — deljena napomena
 * u `meta.note` mutirajućih i kartičnih odgovora.
 */
const SIGN_CONVENTION_NOTE =
  "part_locations je LEDGER sa PREDZNAKOM: postavljanje (unos / cilj prenosa) = " +
  "+quantity, uklanjanje (trebovanje / izvor prenosa) = −quantity. Neto stanje " +
  "dela na poziciji = SUM(quantity) (MODULE_SPEC_lokacije §3.1). Zapisi su " +
  "append-only — korekcija je kontra-zapis, ne izmena/brisanje (§4).";

/**
 * Lokacije napravljenih delova (MODULE_SPEC_lokacije §1/§5, Was: tLokacijeDelova).
 *
 * 🔴 `part_locations` je LEDGER sa PREDZNAKOM (bez izmene šeme): `quantity` je
 * `Int` koji SME biti negativan — postavljanje = +qty, uklanjanje = −qty. Neto
 * stanje dela na poziciji = `SUM(quantity)` (ne bruto zbir). Postojeći synced
 * zapisi su pozitivni placement-i.
 *
 * Ovaj sloj radi READ (pregled + kartica sa neto stanjem) i ledger-WRITE
 * (unos / prenos / trebovanje) — sve mutacije su transakcione, sa advisory
 * lock-om po (RN, poziciji) da konkurentna uklanjanja ne prekorače stanje.
 * Eksplicitan `part_location_movements` (poseban ledger sa `movement_type`) i
 * dvosmerni sync ka QBigTehn-u (§8) su i dalje van obima — čekaju §11.
 */
@Injectable()
export class PartLocationsService {
  constructor(private readonly prisma: PrismaService) {}

  // ---------------------------------------------------------------- READ

  async list(query: ListPartLocationsQuery) {
    const { page, pageSize, skip, take } = parsePagination(
      query.page,
      query.pageSize,
    );

    // 🔴 PL-01: pretraga se filtrira U SQL-u (EXISTS podupiti nad work_orders /
    // projects / positions), a NE tako što se najpre sakupe ogromni nizovi
    // id-jeva pa proslede kao `{ in: [...] }` bind-parametri. Za širok `q`
    // (npr. "a") ti nizovi su prelazili PG bind-limit (65535) i obarali upit
    // (500). EXISTS ostaje u bazi — iz baze izlaze samo id-jevi jedne strane
    // (≤ pageSize). Egzaktni filteri i orderBy/wire-format su nepromenjeni.
    const filterSql = this.buildListFilterSql(query);

    const [idRows, countRows] = await this.prisma.$transaction([
      this.prisma.$queryRaw<{ id: number }[]>(Prisma.sql`
        SELECT id
        FROM part_locations
        WHERE ${filterSql}
        ORDER BY record_date DESC, id DESC
        LIMIT ${take} OFFSET ${skip}
      `),
      this.prisma.$queryRaw<{ total: bigint }[]>(Prisma.sql`
        SELECT COUNT(*)::bigint AS total
        FROM part_locations
        WHERE ${filterSql}
      `),
    ]);

    const total = Number(countRows[0]?.total ?? 0);
    const pageIds = idRows.map((r) => r.id);

    // Hidracija punih redova ide kroz Prisma (očuvan wire-format), a `{ in }`
    // ovde nosi SAMO id-jeve tekuće stranice (≤ pageSize) — nema overflow-a.
    const rows = pageIds.length
      ? await this.prisma.partLocation.findMany({
          where: { id: { in: pageIds } },
          orderBy: [{ recordDate: "desc" }, { id: "desc" }],
        })
      : [];

    const data = await this.attachRelations(rows);
    return { data, meta: pageMeta(page, pageSize, total) };
  }

  /**
   * WHERE fragment za `list()`: egzaktni skalarni filteri + (opciono) `q`
   * pretraga kao EXISTS podupiti nad work_orders / projects / positions.
   * Sve ostaje u SQL-u — nema materijalizacije id-nizova (PL-01).
   */
  private buildListFilterSql(query: ListPartLocationsQuery): Prisma.Sql {
    const clauses: Prisma.Sql[] = [];

    const exact: [string, number | undefined][] = [
      ["work_order_id", intEq(query.workOrderId)],
      ["project_id", intEq(query.projectId)],
      ["position_id", intEq(query.positionId)],
      ["worker_id", intEq(query.workerId)],
      ["quality_type_id", intEq(query.qualityTypeId)],
    ];
    for (const [col, val] of exact) {
      if (val !== undefined) {
        clauses.push(
          Prisma.sql`${Prisma.raw(col)} = ${val}`,
        );
      }
    }

    if (query.q) {
      const like = `%${query.q}%`;
      // OR preko tri izvora — svaki kao EXISTS (join u SQL-u, bez id-nizova).
      // `part_locations` nema FK ka work_orders (orphan-safe), pa je i WO grana
      // korelisan EXISTS podupit, isto kao project/position.
      clauses.push(Prisma.sql`(
        EXISTS (
          SELECT 1 FROM work_orders wo
          WHERE wo.id = part_locations.work_order_id
            AND (wo.ident_number ILIKE ${like}
              OR wo.part_name ILIKE ${like}
              OR wo.drawing_number ILIKE ${like})
        )
        OR EXISTS (
          SELECT 1 FROM projects pr
          WHERE pr.id = part_locations.project_id
            AND (pr.project_number ILIKE ${like}
              OR pr.project_name ILIKE ${like})
        )
        OR EXISTS (
          SELECT 1 FROM positions po
          WHERE po.id = part_locations.position_id
            AND (po.position_code ILIKE ${like}
              OR po.description ILIKE ${like})
        )
      )`);
    }

    return clauses.length
      ? Prisma.join(clauses, " AND ")
      : Prisma.sql`TRUE`;
  }

  /**
   * Kartica lokacije dela za dati RN: ledger istorija svih zapisa + NETO stanje
   * po poziciji i ukupno. Neto = `SUM(quantity sa predznakom)` (postavljeno +,
   * uklonjeno −) — vidi konvenciju u `meta.note`.
   */
  async card(workOrderId: number) {
    const records = await this.prisma.partLocation.findMany({
      where: { workOrderId },
      orderBy: [{ recordDate: "asc" }, { id: "asc" }],
    });

    const workOrders = await this.resolveWorkOrders([workOrderId]);
    const workOrder = workOrders.get(workOrderId) ?? null;
    if (!workOrder && records.length === 0) {
      throw new NotFoundException(
        `Radni nalog ${workOrderId} ne postoji i nema zapisa lokacija.`,
      );
    }

    const enrichedRecords = await this.attachRelations(records);

    // Neto stanje = SUM(quantity sa predznakom): placement (+) i removal (−)
    // se sabiraju direktno jer je `quantity` signed ledger (§3.1).
    const totalQuantity = records.reduce((sum, r) => sum + r.quantity, 0);
    const byPosition = new Map<number, number>();
    for (const r of records) {
      byPosition.set(
        r.positionId,
        (byPosition.get(r.positionId) ?? 0) + r.quantity,
      );
    }
    const positions = await this.resolvePositions([...byPosition.keys()]);
    const totalsByPosition = [...byPosition.entries()].map(
      ([positionId, quantity]) => ({
        positionId,
        position: positions.get(positionId) ?? null,
        quantity,
      }),
    );

    return {
      data: {
        workOrderId,
        workOrder,
        records: enrichedRecords,
        totalsByPosition,
        totalQuantity,
      },
      meta: {
        note:
          "totalsByPosition[].quantity i totalQuantity su NETO stanje = " +
          "SUM(quantity sa predznakom) po poziciji / za ceo RN. " +
          SIGN_CONVENTION_NOTE,
      },
    };
  }

  // ---------------------------------------------------------------- WRITE

  /**
   * Unos lokacije — placement (+quantity) iskontrolisanog dela (§3.7: definiše se
   * tek posle završne kontrole). Novi ledger zapis; `projectId` se izvodi iz RN-a
   * (§3.6, authoritative), `recordDate = now`. `id` dodeljuje serijska sekvenca
   * (ne DMax+1 — §6), poravnata pre insert-a zbog synced eksplicitnih id-jeva.
   */
  async create(dto: CreatePartLocationDto) {
    validateCreatePartLocation(dto);
    await this.assertPositionExists(dto.positionId);
    await this.assertWorkerExists(dto.workerId);
    const { projectId } = await this.resolveWorkOrderContext(dto.workOrderId);

    const created = await this.prisma.$transaction(async (tx) => {
      await this.alignPartLocationSequence(tx);
      return tx.partLocation.create({
        data: {
          workOrderId: dto.workOrderId,
          projectId,
          positionId: dto.positionId,
          qualityTypeId: dto.qualityTypeId,
          workerId: dto.workerId,
          quantity: dto.quantity, // placement = +qty
          recordDate: new Date(),
        },
      });
    });

    const [data] = await this.attachRelations([created]);
    return { data, meta: { note: SIGN_CONVENTION_NOTE } };
  }

  /**
   * Prenos dela sa police na policu (§3.2, legacy `spIzvrsiPrenosIliCiscenjeDela`).
   * U jednoj transakciji: −quantity na izvoru + +quantity na cilju. Validacija:
   * izvor ≠ cilj (DTO), quantity ≥ 1, neto stanje na izvoru (SUM signed za
   * RN+pozicija+kvalitet) ≥ quantity (inače 422). Advisory lock po (RN, poziciji)
   * — obe police u sortiranom redosledu (bez deadlock-a A→B / B→A) — serijalizuje
   * konkurentna uklanjanja da ne prekorače stanje.
   */
  async transfer(dto: TransferPartLocationDto) {
    validateTransferPartLocation(dto);
    await this.assertPositionExists(dto.fromPositionId);
    await this.assertPositionExists(dto.toPositionId);
    const { projectId, workerId } = await this.resolveWorkOrderContext(
      dto.workOrderId,
    );

    const result = await this.prisma.$transaction(async (tx) => {
      // Zaključaj obe police u sortiranom redosledu → nema deadlock-a između
      // konkurentnih prenosa A→B i B→A.
      for (const pos of [dto.fromPositionId, dto.toPositionId].sort(
        (a, b) => a - b,
      )) {
        await this.lockPosition(tx, dto.workOrderId, pos);
      }

      const available = await this.signedBalance(
        tx,
        dto.workOrderId,
        dto.fromPositionId,
        dto.qualityTypeId,
      );
      if (available < dto.quantity)
        throw new UnprocessableEntityException(
          `Nedovoljno stanje na izvornoj poziciji ${dto.fromPositionId} ` +
            `(raspoloživo ${available}, traženo ${dto.quantity}).`,
        );

      await this.alignPartLocationSequence(tx);
      const now = new Date();
      const fromRecord = await tx.partLocation.create({
        data: {
          workOrderId: dto.workOrderId,
          projectId,
          positionId: dto.fromPositionId,
          qualityTypeId: dto.qualityTypeId,
          workerId, // TODO(auth): izvršilac (magacioner) iz User↔Worker veze; do tada = radnik RN-a (FK-safe)
          quantity: -dto.quantity, // izvor prenosa = removal = −qty
          recordDate: now,
        },
      });
      const toRecord = await tx.partLocation.create({
        data: {
          workOrderId: dto.workOrderId,
          projectId,
          positionId: dto.toPositionId,
          qualityTypeId: dto.qualityTypeId,
          workerId, // TODO(auth)
          quantity: dto.quantity, // cilj prenosa = placement = +qty
          recordDate: now,
        },
      });
      const toBalanceAfter = await this.signedBalance(
        tx,
        dto.workOrderId,
        dto.toPositionId,
        dto.qualityTypeId,
      );
      return {
        fromRecord,
        toRecord,
        fromBalanceAfter: available - dto.quantity,
        toBalanceAfter,
      };
    });

    const [from, to] = await this.attachRelations([
      result.fromRecord,
      result.toRecord,
    ]);
    return {
      data: { from, to },
      meta: {
        note: SIGN_CONVENTION_NOTE,
        fromBalanceAfter: result.fromBalanceAfter,
        toBalanceAfter: result.toBalanceAfter,
      },
    };
  }

  /**
   * Trebovanje/uklanjanje dela sa police (§3.2) — jedan removal zapis (−quantity).
   * Validacija: quantity ≥ 1, neto stanje na poziciji (SUM signed za
   * RN+pozicija+kvalitet) ≥ quantity (inače 422). Advisory lock po (RN, poziciji).
   */
  async requisition(dto: RequisitionPartLocationDto) {
    validateRequisitionPartLocation(dto);
    await this.assertPositionExists(dto.positionId);
    const { projectId, workerId } = await this.resolveWorkOrderContext(
      dto.workOrderId,
    );

    const result = await this.prisma.$transaction(async (tx) => {
      await this.lockPosition(tx, dto.workOrderId, dto.positionId);

      const available = await this.signedBalance(
        tx,
        dto.workOrderId,
        dto.positionId,
        dto.qualityTypeId,
      );
      if (available < dto.quantity)
        throw new UnprocessableEntityException(
          `Nedovoljno stanje na poziciji ${dto.positionId} ` +
            `(raspoloživo ${available}, traženo ${dto.quantity}).`,
        );

      await this.alignPartLocationSequence(tx);
      const record = await tx.partLocation.create({
        data: {
          workOrderId: dto.workOrderId,
          projectId,
          positionId: dto.positionId,
          qualityTypeId: dto.qualityTypeId,
          workerId, // TODO(auth): izvršilac (magacioner) iz sesije; do tada = radnik RN-a (FK-safe)
          quantity: -dto.quantity, // trebovanje = removal = −qty
          recordDate: new Date(),
        },
      });
      return { record, balanceAfter: available - dto.quantity };
    });

    const [data] = await this.attachRelations([result.record]);
    return {
      data,
      meta: { note: SIGN_CONVENTION_NOTE, balanceAfter: result.balanceAfter },
    };
  }

  // --- write helperi ---

  /**
   * Neto stanje (SUM signed) dela na poziciji za dati kvalitet. Stanje je fungibilno
   * SAMO unutar iste `qualityType` klase (OK/dorada/škart, §3.4) — ne mešaju se.
   */
  private async signedBalance(
    tx: Prisma.TransactionClient,
    workOrderId: number,
    positionId: number,
    qualityTypeId: number,
  ): Promise<number> {
    const agg = await tx.partLocation.aggregate({
      _sum: { quantity: true },
      where: { workOrderId, positionId, qualityTypeId },
    });
    return agg._sum.quantity ?? 0;
  }

  /**
   * Serijalizuj mutacije nad jednom (RN, poziciji). `hashtext(text)` → int (isti
   * obrazac kao `draft-numbering.service.ts`), pa se izbegava dvoargumentni
   * advisory-lock overload i njegova bigint/int4 dvosmislenost.
   */
  private async lockPosition(
    tx: Prisma.TransactionClient,
    workOrderId: number,
    positionId: number,
  ): Promise<void> {
    const key = `part-locations:${workOrderId}:${positionId}`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
  }

  /**
   * `part_locations.id` ima serijsku sekvencu (`@default(autoincrement())`), a sync
   * upisuje eksplicitne legacy id-jeve; poravnaj sekvencu pre insert-a da
   * autoincrement ne kolidira sa uvezenim redovima (isti obrazac kao
   * `work-orders.service.ts` create()). Delegira na zajednički `alignIdSequence`
   * (src/common/db-sequences.ts) — 3-arg `setval` bezbedan i na praznoj tabeli.
   */
  private async alignPartLocationSequence(
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    await alignIdSequence(tx, "part_locations");
  }

  /**
   * RN kontekst za ledger zapis: `projectId` (authoritative iz RN-a, §3.6) i
   * `workerId` (FK-safe fallback izvršioca dok ne postoji User↔Worker veza).
   * `part_locations.project` je obavezan FK → proveri da predmet postoji (čist 422
   * umesto FK 500). `workOrder.workerId` je već FK-valid (work_orders.worker FK).
   */
  private async resolveWorkOrderContext(
    workOrderId: number,
  ): Promise<{ projectId: number; workerId: number }> {
    const workOrder = await this.prisma.workOrder.findUnique({
      where: { id: workOrderId },
      select: { projectId: true, workerId: true },
    });
    if (!workOrder)
      throw new NotFoundException(`Radni nalog ${workOrderId} ne postoji.`);
    const project = await this.prisma.project.findUnique({
      where: { id: workOrder.projectId },
      select: { id: true },
    });
    if (!project)
      throw new UnprocessableEntityException(
        `Predmet radnog naloga ${workOrderId} (id ${workOrder.projectId}) ne postoji — ` +
          "lokacija nije upisana.",
      );
    return { projectId: workOrder.projectId, workerId: workOrder.workerId };
  }

  private async assertPositionExists(id: number): Promise<void> {
    const position = await this.prisma.position.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!position) throw new NotFoundException(`Pozicija ${id} ne postoji.`);
  }

  private async assertWorkerExists(id: number): Promise<void> {
    const worker = await this.prisma.worker.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!worker) throw new NotFoundException(`Radnik ${id} ne postoji.`);
  }

  // --- batch resolveri (orphan-safe: FK skalar -> poseban upit, NIKAD include/select
  //     na obaveznoj to-one relaciji — vidi work-orders.service.ts) ---

  private async attachRelations<T extends PartLocationRow>(rows: T[]) {
    const [workOrders, projects, positions, workers, qualityTypes] =
      await Promise.all([
        this.resolveWorkOrders(rows.map((r) => r.workOrderId)),
        this.resolveProjects(rows.map((r) => r.projectId)),
        this.resolvePositions(rows.map((r) => r.positionId)),
        this.resolveWorkers(rows.map((r) => r.workerId)),
        this.resolveQualityTypes(rows.map((r) => r.qualityTypeId)),
      ]);
    return rows.map((r) => ({
      ...r,
      workOrder: workOrders.get(r.workOrderId) ?? null,
      project: projects.get(r.projectId) ?? null,
      position: positions.get(r.positionId) ?? null,
      worker: workers.get(r.workerId) ?? null,
      qualityType: qualityTypes.get(r.qualityTypeId) ?? null,
    }));
  }

  private async resolveWorkOrders(ids: number[]) {
    const uniq = uniqueIds(ids);
    if (!uniq.length) return new Map<number, never>();
    return byId(
      await this.prisma.workOrder.findMany({
        where: { id: { in: uniq } },
        select: {
          id: true,
          identNumber: true,
          partName: true,
          drawingNumber: true,
          projectId: true,
        },
      }),
    );
  }

  private async resolveProjects(ids: number[]) {
    const uniq = uniqueIds(ids);
    if (!uniq.length) return new Map<number, never>();
    return byId(
      await this.prisma.project.findMany({
        where: { id: { in: uniq } },
        select: {
          id: true,
          projectNumber: true,
          projectName: true,
          customerId: true,
        },
      }),
    );
  }

  private async resolvePositions(ids: number[]) {
    const uniq = uniqueIds(ids);
    if (!uniq.length) return new Map<number, never>();
    return byId(
      await this.prisma.position.findMany({
        where: { id: { in: uniq } },
        select: { id: true, positionCode: true, description: true },
      }),
    );
  }

  private async resolveWorkers(ids: number[]) {
    const uniq = uniqueIds(ids);
    if (!uniq.length) return new Map<number, never>();
    return byId(
      await this.prisma.worker.findMany({
        where: { id: { in: uniq } },
        select: SAFE_WORKER_SELECT,
      }),
    );
  }

  private async resolveQualityTypes(ids: number[]) {
    const uniq = uniqueIds(ids);
    if (!uniq.length) return new Map<number, never>();
    return byId(
      await this.prisma.partQualityType.findMany({
        where: { id: { in: uniq } },
        select: { id: true, name: true },
      }),
    );
  }
}
