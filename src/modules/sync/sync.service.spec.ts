import { PrismaService } from "../../prisma/prisma.service";
import { MssqlClient } from "./mssql.client";
import { SyncService } from "./sync.service";
import type { CustomerSyncer } from "./syncers/customer.syncer";
import type { HandoverDerivationSyncer } from "./syncers/handover-derivation.syncer";
import type { DrawingHandoverPdfSyncer } from "./syncers/drawing-handover-pdf.syncer";
import type { DrawingPlanItemSyncer } from "./syncers/drawing-plan-item.syncer";
import type { WorkOrderApprovalSyncer } from "./syncers/work-order-approval.syncer";
import type { WorkOrderBlankSyncer } from "./syncers/work-order-blank.syncer";
import type { WorkOrderMachinedPartSyncer } from "./syncers/work-order-machined-part.syncer";
import type { WorkOrderNonstandardPartSyncer } from "./syncers/work-order-nonstandard-part.syncer";

/**
 * Redosled registracije syncera je UGOVOR "all entities" run-a (runbook
 * pokriva samo eksplicitni scope — kod mora sam da sprovede redosled):
 * `drawing_handovers` derivacija + remap `work_orders.drawing_handover_id`
 * MORA ići POSLE `work_orders` re-importa, inače force run poništi remap u
 * istom prolazu. Zamka: `Map.set` na postojećem ključu ZADRŽAVA prvobitnu
 * poziciju umetanja (generičko PrimopredajaCrteza mapiranje dolazi pre
 * work_orders u SYNC_MAP), pa `register` mora delete-pa-set.
 * §5.3 chain-item importeri idu POSLEDNJI (roditelji + derivacija pre njih).
 */
describe("SyncService — redosled registracije", () => {
  function buildService(): SyncService {
    return new SyncService(
      {} as PrismaService,
      {} as MssqlClient,
      { entity: "customers" } as CustomerSyncer,
      { entity: "drawing_handovers" } as HandoverDerivationSyncer,
      { entity: "work_order_machined_parts" } as WorkOrderMachinedPartSyncer,
      { entity: "work_order_blanks" } as WorkOrderBlankSyncer,
      {
        entity: "work_order_nonstandard_parts",
      } as WorkOrderNonstandardPartSyncer,
      { entity: "work_order_approvals" } as WorkOrderApprovalSyncer,
      { entity: "drawing_plan_items" } as DrawingPlanItemSyncer,
      { entity: "drawing_handover_pdfs" } as DrawingHandoverPdfSyncer,
    );
  }

  it("drawing_handovers dolazi POSLE work_orders u availableEntities", () => {
    const entities = buildService().availableEntities;
    const workOrdersIdx = entities.indexOf("work_orders");
    const handoversIdx = entities.indexOf("drawing_handovers");

    expect(workOrdersIdx).toBeGreaterThanOrEqual(0);
    expect(handoversIdx).toBeGreaterThan(workOrdersIdx);
  });

  it("re-registracija ne duplira entitet (jedan drawing_handovers)", () => {
    const entities = buildService().availableEntities;
    expect(entities.filter((e) => e === "drawing_handovers")).toHaveLength(1);
    expect(entities.filter((e) => e === "customers")).toHaveLength(1);
  });

  it("§5.3 chain-item importeri dolaze POSLE roditelja i derivacije", () => {
    const entities = buildService().availableEntities;
    const idx = (e: string) => entities.indexOf(e);

    // Roditelji moraju biti registrovani (i pre) — required FK-ovi se
    // razrešavaju tek kad roditelji postoje u istom "all entities" prolazu.
    for (const child of [
      "work_order_machined_parts",
      "work_order_blanks",
      "work_order_nonstandard_parts",
      "work_order_approvals",
    ]) {
      expect(idx(child)).toBeGreaterThan(idx("work_orders"));
      expect(idx(child)).toBeGreaterThan(idx("workers"));
      expect(idx(child)).toBeGreaterThan(idx("operations"));
    }
    expect(idx("drawing_plan_items")).toBeGreaterThan(idx("drawing_plans"));
    expect(idx("drawing_plan_items")).toBeGreaterThan(idx("drawings"));
    // PDF-ovi primopredaje tek posle DERIVIRANIH drawing_handovers redova.
    expect(idx("drawing_handover_pdfs")).toBeGreaterThan(
      idx("drawing_handovers"),
    );
  });
});
