import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../../prisma/prisma.service";
import { MssqlClient } from "../mssql.client";
import {
  ChainItemDelegate,
  LegacyChainItemSyncer,
} from "./legacy-chain-item.syncer";

interface Refs {
  workOrderIds: Set<number>;
  workerIds: Set<number>;
  operationCodes: Set<string>;
}

/**
 * TEMPORARY (P4 §5.3): tPLP (QBigTehn) -> work_order_blanks.
 *
 * Blank / semi-finished material items of a work order. Exhaustive mapping of
 * all 13 source columns; upsert key `IDStavkePLP` -> `id` (1:1). Required FKs
 * (work order, worker, work-center code) are pre-resolved — unresolvable rows
 * are skipped and reported. Deleted at cutover with the sync-map split (§7.2).
 */
@Injectable()
export class WorkOrderBlankSyncer extends LegacyChainItemSyncer<Refs> {
  readonly entity = "work_order_blanks";

  constructor(mssql: MssqlClient, prisma: PrismaService) {
    super(mssql, prisma);
  }

  protected selectSql(): string {
    return `SELECT [IDStavkePLP], [IDRN], [PozicijaPLP], [RJgrupaRC],
                   [Materijal], [DimenzijaMaterijala], [JM], [TezinaJed],
                   [Komada], [BrojPozicije], [DIVUnosa], [DIVIspravke],
                   [SifraRadnika]
            FROM [dbo].[tPLP]`;
  }

  protected delegate(): ChainItemDelegate {
    return this.prisma.workOrderBlank as unknown as ChainItemDelegate;
  }

  protected async resolveRefs(): Promise<Refs> {
    const [workOrderIds, workerIds, operationCodes] = await Promise.all([
      this.prisma.workOrder
        .findMany({ select: { id: true } })
        .then((r) => new Set(r.map((x) => x.id))),
      this.prisma.worker
        .findMany({ select: { id: true } })
        .then((r) => new Set(r.map((x) => x.id))),
      this.prisma.operation
        .findMany({ select: { workCenterCode: true } })
        .then((r) => new Set(r.map((x) => x.workCenterCode))),
    ]);
    return { workOrderIds, workerIds, operationCodes };
  }

  protected rowLabel(row: Record<string, unknown>): string {
    return `IDStavkePLP=${String(row["IDStavkePLP"])}`;
  }

  protected mapRow(
    r: Record<string, unknown>,
    refs: Refs,
  ): { id: number; data: Record<string, unknown> } {
    const id = Number(r["IDStavkePLP"]);
    const workOrderId = Number(r["IDRN"]);
    const workerId = Number(r["SifraRadnika"]);
    const workCenterCode = String(r["RJgrupaRC"]);

    this.requireRef(refs.workOrderIds, workOrderId, "work order");
    this.requireRef(refs.workerIds, workerId, "worker");
    this.requireRef(refs.operationCodes, workCenterCode, "work-center code");

    return {
      id,
      data: {
        id,
        workOrderId,
        position: String(r["PozicijaPLP"]),
        workCenterCode,
        material: this.str(r["Materijal"]),
        materialDimension: this.str(r["DimenzijaMaterijala"]),
        unit: this.str(r["JM"]),
        unitWeight: this.num(r["TezinaJed"]),
        quantity: this.num(r["Komada"]),
        positionNumber: this.str(r["BrojPozicije"]),
        createdAt: this.date(r["DIVUnosa"]),
        updatedAt: this.date(r["DIVIspravke"]),
        workerId,
      },
    };
  }
}
