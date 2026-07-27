import { Module } from "@nestjs/common";
import { PrismaModule } from "../../prisma/prisma.module";
import { MssqlClient } from "./mssql.client";
import { SyncController } from "./sync.controller";
import { SyncService } from "./sync.service";
import { CustomerSyncer } from "./syncers/customer.syncer";
import { ItemGroupSyncer } from "./syncers/item-group.syncer";
import { ItemOriginSyncer } from "./syncers/item-origin.syncer";
import { ItemSubgroupSyncer } from "./syncers/item-subgroup.syncer";

// Cutover izvršen 2026-07-14 (runbook §17 korak 6): QBigTehn lanac ugašen —
// §5.3 privremeni chain-item synceri i handover-derivation syncer OBRISANI
// (mrtav kod se briše, ne stoji iza prekidača). Ostaje samo trajni BigBit
// sync: CustomerSyncer (bespoke) + generički map-driven synceri iz
// sync-map.generated.ts. Vidi QBIGTEHN_CHAIN_ENTITIES u table-ownership.ts.
// Dopuna: registri artikala (R_Grupa / R_Podgrupa / R_Poreklo) nisu u
// generisanoj mapi, pa imaju sopstvene lagane syncere (bez watermarka).
@Module({
  imports: [PrismaModule],
  controllers: [SyncController],
  providers: [
    MssqlClient,
    SyncService,
    CustomerSyncer,
    ItemGroupSyncer,
    ItemSubgroupSyncer,
    ItemOriginSyncer,
  ],
  exports: [SyncService],
})
export class SyncModule {}
