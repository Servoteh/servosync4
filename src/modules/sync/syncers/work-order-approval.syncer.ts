import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../../prisma/prisma.service";
import { MssqlClient } from "../mssql.client";
import {
  ChainItemDelegate,
  LegacyChainItemSyncer,
} from "./legacy-chain-item.syncer";

interface Refs {
  workOrderIds: Set<number>;
}

/**
 * TEMPORARY (P4 §5.3): tSaglasanRN (QBigTehn) -> work_order_approvals.
 *
 * Work-order approval audit trail. The handover derivation READS tSaglasanRN
 * (OUTER APPLY TOP 1) for `status_changed_at/by`, but the full history also
 * belongs in the 2.0 table — that is this syncer. Exhaustive mapping of all
 * 10 source columns, mirroring the generated tLansiranRN ->
 * work_order_launches mapping 1:1; upsert key `IDSaglasan` -> `id`. The only
 * required FK (work order) is pre-resolved — unresolvable rows are skipped
 * and reported. `SifraRadnikaUnos`/`SifraRadnikaIspravka`
 * (`created/updated_by_worker_id`) are plain soft references, copied
 * verbatim. Deleted at cutover with the sync-map split (§7.2).
 */
@Injectable()
export class WorkOrderApprovalSyncer extends LegacyChainItemSyncer<Refs> {
  readonly entity = "work_order_approvals";

  constructor(mssql: MssqlClient, prisma: PrismaService) {
    super(mssql, prisma);
  }

  protected selectSql(): string {
    return `SELECT [IDSaglasan], [IDRN], [Saglasan], [DatumUnosa],
                   [DIVUnos], [SifraRadnikaUnos], [PotpisUnos],
                   [DIVIspravke], [SifraRadnikaIspravka], [PotpisIspravka]
            FROM [dbo].[tSaglasanRN]`;
  }

  protected delegate(): ChainItemDelegate {
    return this.prisma.workOrderApproval as unknown as ChainItemDelegate;
  }

  protected async resolveRefs(): Promise<Refs> {
    const workOrderIds = await this.prisma.workOrder
      .findMany({ select: { id: true } })
      .then((r) => new Set(r.map((x) => x.id)));
    return { workOrderIds };
  }

  protected rowLabel(row: Record<string, unknown>): string {
    return `IDSaglasan=${String(row["IDSaglasan"])}`;
  }

  protected mapRow(
    r: Record<string, unknown>,
    refs: Refs,
  ): { id: number; data: Record<string, unknown> } {
    const id = Number(r["IDSaglasan"]);
    const workOrderId = Number(r["IDRN"]);

    this.requireRef(refs.workOrderIds, workOrderId, "work order");

    return {
      id,
      data: {
        id,
        workOrderId,
        isApproved: this.bool(r["Saglasan"]),
        enteredAt: this.date(r["DatumUnosa"]),
        createdAt: this.date(r["DIVUnos"]),
        // Soft references (no FK constraint) — copied verbatim.
        createdByWorkerId: Number(r["SifraRadnikaUnos"]),
        createdBySignature: this.str(r["PotpisUnos"]),
        updatedAt: this.date(r["DIVIspravke"]),
        updatedByWorkerId: Number(r["SifraRadnikaIspravka"]),
        updatedBySignature: this.str(r["PotpisIspravka"]),
      },
    };
  }
}
