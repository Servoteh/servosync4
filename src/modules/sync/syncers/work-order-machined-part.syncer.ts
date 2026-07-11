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
 * TEMPORARY (P4 §5.3): tPDM (QBigTehn) -> work_order_machined_parts.
 *
 * Machined-part items of a work order. Exhaustive mapping of all 11 source
 * columns; upsert key `IDStavkePDM` -> `id` (1:1, same policy as the sibling
 * tStavkeRN mapping). Required FKs (work order, worker, work-center code) are
 * pre-resolved — unresolvable rows are skipped and reported. `OperacijaPDM`
 * (`operation_id`) is a plain soft reference (no FK constraint) and is copied
 * verbatim. Deleted at cutover with the sync-map split (§7.2).
 */
@Injectable()
export class WorkOrderMachinedPartSyncer extends LegacyChainItemSyncer<Refs> {
  readonly entity = "work_order_machined_parts";

  constructor(mssql: MssqlClient, prisma: PrismaService) {
    super(mssql, prisma);
  }

  protected selectSql(): string {
    return `SELECT [IDStavkePDM], [IDRN], [PozicijaPDM], [OperacijaPDM],
                   [RJgrupaRC], [NazivP], [BrojCrtezaP], [Komada],
                   [DIVUnosa], [DIVIspravke], [SifraRadnika]
            FROM [dbo].[tPDM]`;
  }

  protected delegate(): ChainItemDelegate {
    return this.prisma.workOrderMachinedPart as unknown as ChainItemDelegate;
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
    return `IDStavkePDM=${String(row["IDStavkePDM"])}`;
  }

  protected mapRow(
    r: Record<string, unknown>,
    refs: Refs,
  ): { id: number; data: Record<string, unknown> } {
    const id = Number(r["IDStavkePDM"]);
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
        position: String(r["PozicijaPDM"]),
        // Soft reference (no FK constraint) — copied verbatim.
        operationId: this.num(r["OperacijaPDM"]),
        workCenterCode,
        partName: this.str(r["NazivP"]),
        drawingNumber: this.str(r["BrojCrtezaP"]),
        quantity: this.num(r["Komada"]),
        createdAt: this.date(r["DIVUnosa"]),
        updatedAt: this.date(r["DIVIspravke"]),
        workerId,
      },
    };
  }
}
