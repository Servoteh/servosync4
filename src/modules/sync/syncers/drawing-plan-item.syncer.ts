import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../../prisma/prisma.service";
import { MssqlClient } from "../mssql.client";
import {
  ChainItemDelegate,
  LegacyChainItemSyncer,
} from "./legacy-chain-item.syncer";

interface Refs {
  planIds: Set<number>;
  drawingIds: Set<number>;
}

/**
 * TEMPORARY (P4 §5.3): PDM_PlaniranjeStavke (QBigTehn) -> drawing_plan_items.
 *
 * Planning items of a PDM drawing plan (parent `PDM_Planiranje` ->
 * `drawing_plans` is covered by the generated mapping). Exhaustive mapping of
 * all 17 source columns; upsert key `IDPlanStavka` -> `id` (1:1). Required
 * FKs (plan, procurement drawing) are pre-resolved — unresolvable rows are
 * skipped and reported. `SifraArtikla` (`item_id`) and `PredProveraIDPlan`
 * (`prev_check_plan_id`) are plain soft references, copied verbatim. Deleted
 * at cutover with the sync-map split (§7.2).
 */
@Injectable()
export class DrawingPlanItemSyncer extends LegacyChainItemSyncer<Refs> {
  readonly entity = "drawing_plan_items";

  constructor(mssql: MssqlClient, prisma: PrismaService) {
    super(mssql, prisma);
  }

  protected selectSql(): string {
    return `SELECT [IDPlanStavka], [IDPlan], [IDCrtezNabavke], [SifraArtikla],
                   [KolicinaPoSklopu], [PotrebnoUkupno], [PredProveraIDPlan],
                   [OdlukaAkcija], [RucnaKolicina], [Rezervisano],
                   [ZaNabavku], [Zalihe], [NazivArtiklaStavke],
                   [KataloskiBrojStavke], [JMStavke], [JeRucnaStavka],
                   [IskljuciNabavku]
            FROM [dbo].[PDM_PlaniranjeStavke]`;
  }

  protected delegate(): ChainItemDelegate {
    return this.prisma.drawingPlanItem as unknown as ChainItemDelegate;
  }

  protected async resolveRefs(): Promise<Refs> {
    const [planIds, drawingIds] = await Promise.all([
      this.prisma.drawingPlan
        .findMany({ select: { id: true } })
        .then((r) => new Set(r.map((x) => x.id))),
      this.prisma.drawing
        .findMany({ select: { id: true } })
        .then((r) => new Set(r.map((x) => x.id))),
    ]);
    return { planIds, drawingIds };
  }

  protected rowLabel(row: Record<string, unknown>): string {
    return `IDPlanStavka=${String(row["IDPlanStavka"])}`;
  }

  protected mapRow(
    r: Record<string, unknown>,
    refs: Refs,
  ): { id: number; data: Record<string, unknown> } {
    const id = Number(r["IDPlanStavka"]);
    const planId = Number(r["IDPlan"]);
    const procurementDrawingId = Number(r["IDCrtezNabavke"]);

    this.requireRef(refs.planIds, planId, "drawing plan");
    this.requireRef(refs.drawingIds, procurementDrawingId, "drawing");

    return {
      id,
      data: {
        id,
        planId,
        procurementDrawingId,
        // Soft references (no FK constraint) — copied verbatim.
        itemId: this.num(r["SifraArtikla"]),
        quantityPerAssembly: this.decimal(r["KolicinaPoSklopu"]),
        totalRequired: this.decimal(r["PotrebnoUkupno"]),
        prevCheckPlanId: this.num(r["PredProveraIDPlan"]),
        decisionAction: Number(r["OdlukaAkcija"]),
        manualQuantity: this.decimal(r["RucnaKolicina"]),
        reserved: this.decimal(r["Rezervisano"]),
        toProcure: this.decimal(r["ZaNabavku"]),
        inStock: this.decimal(r["Zalihe"]),
        itemName: this.str(r["NazivArtiklaStavke"]),
        itemCatalogNumber: this.str(r["KataloskiBrojStavke"]),
        itemUnit: this.str(r["JMStavke"]),
        isManualItem: Boolean(r["JeRucnaStavka"]),
        excludeFromProcurement: Boolean(r["IskljuciNabavku"]),
      },
    };
  }
}
