import { Module } from "@nestjs/common";
import { PrismaModule } from "../../prisma/prisma.module";
import { MssqlClient } from "./mssql.client";
import { SyncController } from "./sync.controller";
import { SyncService } from "./sync.service";
import { CustomerSyncer } from "./syncers/customer.syncer";
import { HandoverDerivationSyncer } from "./syncers/handover-derivation.syncer";

@Module({
  imports: [PrismaModule],
  controllers: [SyncController],
  providers: [
    MssqlClient,
    SyncService,
    CustomerSyncer,
    HandoverDerivationSyncer,
  ],
  exports: [SyncService],
})
export class SyncModule {}
