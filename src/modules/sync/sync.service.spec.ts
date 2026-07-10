import { PrismaService } from "../../prisma/prisma.service";
import { MssqlClient } from "./mssql.client";
import { SyncService } from "./sync.service";
import type { CustomerSyncer } from "./syncers/customer.syncer";
import type { HandoverDerivationSyncer } from "./syncers/handover-derivation.syncer";

/**
 * Redosled registracije syncera je UGOVOR "all entities" run-a (runbook
 * pokriva samo eksplicitni scope — kod mora sam da sprovede redosled):
 * `drawing_handovers` derivacija + remap `work_orders.drawing_handover_id`
 * MORA ići POSLE `work_orders` re-importa, inače force run poništi remap u
 * istom prolazu. Zamka: `Map.set` na postojećem ključu ZADRŽAVA prvobitnu
 * poziciju umetanja (generičko PrimopredajaCrteza mapiranje dolazi pre
 * work_orders u SYNC_MAP), pa `register` mora delete-pa-set.
 */
describe("SyncService — redosled registracije", () => {
  function buildService(): SyncService {
    return new SyncService(
      {} as PrismaService,
      {} as MssqlClient,
      { entity: "customers" } as CustomerSyncer,
      { entity: "drawing_handovers" } as HandoverDerivationSyncer,
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
});
