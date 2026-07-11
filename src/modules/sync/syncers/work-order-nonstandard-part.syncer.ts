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
 * TEMPORARY (P4 §5.3): tPND (QBigTehn) -> work_order_nonstandard_parts.
 *
 * Non-standard part items of a work order. Exhaustive mapping of all 11
 * source columns; upsert key `IDStavkePND` -> `id` (1:1). Required FKs (work
 * order, worker, work-center code) are pre-resolved — unresolvable rows are
 * skipped and reported. `OperacijaPND` (`operation_id`) is a plain soft
 * reference and is copied verbatim. Deleted at cutover with the sync-map
 * split (§7.2).
 */
@Injectable()
export class WorkOrderNonstandardPartSyncer extends LegacyChainItemSyncer<Refs> {
  readonly entity = "work_order_nonstandard_parts";

  constructor(mssql: MssqlClient, prisma: PrismaService) {
    super(mssql, prisma);
  }

  protected selectSql(): string {
    return `SELECT [IDStavkePND], [IDRN], [PozicijaPND], [OperacijaPND],
                   [RJgrupaRC], [NazivDela], [Komada], [Napomena],
                   [DIVUnosa], [DIVIspravke], [SifraRadnika]
            FROM [dbo].[tPND]`;
  }

  protected delegate(): ChainItemDelegate {
    return this.prisma.workOrderNonstandardPart as unknown as ChainItemDelegate;
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
    return `IDStavkePND=${String(row["IDStavkePND"])}`;
  }

  protected mapRow(
    r: Record<string, unknown>,
    refs: Refs,
  ): { id: number; data: Record<string, unknown> } {
    const id = Number(r["IDStavkePND"]);
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
        position: String(r["PozicijaPND"]),
        // Soft reference (no FK constraint) — copied verbatim.
        operationId: this.num(r["OperacijaPND"]),
        workCenterCode,
        partName: String(r["NazivDela"]),
        quantity: this.num(r["Komada"]),
        note: this.str(r["Napomena"]),
        createdAt: this.date(r["DIVUnosa"]),
        updatedAt: this.date(r["DIVIspravke"]),
        workerId,
      },
    };
  }
}
