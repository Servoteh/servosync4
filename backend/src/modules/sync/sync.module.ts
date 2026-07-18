import { Module } from "@nestjs/common";
import { PrismaModule } from "../../prisma/prisma.module";
import { MssqlClient } from "./mssql.client";
import { SyncController } from "./sync.controller";
import { SyncService } from "./sync.service";
import { CustomerSyncer } from "./syncers/customer.syncer";

// Cutover izvršen 2026-07-14 (runbook §17 korak 6): QBigTehn lanac ugašen —
// §5.3 privremeni chain-item synceri i handover-derivation syncer OBRISANI
// (mrtav kod se briše, ne stoji iza prekidača). Ostaje samo trajni BigBit
// sync: CustomerSyncer (bespoke) + generički map-driven synceri iz
// sync-map.generated.ts. Vidi QBIGTEHN_CHAIN_ENTITIES u table-ownership.ts.
@Module({
  imports: [PrismaModule],
  controllers: [SyncController],
  providers: [MssqlClient, SyncService, CustomerSyncer],
  exports: [SyncService],
})
export class SyncModule {}
