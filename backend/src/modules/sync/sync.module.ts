import { Module } from "@nestjs/common";
import { PrismaModule } from "../../prisma/prisma.module";
import { PodesavanjaModule } from "../podesavanja/podesavanja.module";
import { BigbitMdbImportService } from "./bigbit-mdb-import.service";
import { BigbitMdbJobs } from "./bigbit-mdb-jobs";
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
// BigBit .mdb kanal (26.07.2026) je ZASEBAN PUT, ne dira MSSQL sync:
// `BigbitMdbImportService` čita samo `bb_mdb_stage_*` tabele koje host skripta
// `scripts/bigbit-mdb-export.sh` napuni, i nema nikakve veze sa `MssqlClient`-om
// ni sa `SYNC_MAP`-om. `BigbitMdbJobs` se izvozi da bi `SchedulerModule` mogao da
// registruje noćni posao (registraciju NE radi ovaj modul).
// `PodesavanjaModule` (izvozi `SyncSwitchService`) je ovde zbog NADZORNIKA:
// jutarnji posao čita ISTO stanje koje ekran prikazuje i gura upozorenje na
// zvonce. Nema ciklusa — Podešavanja nemaju `imports` i ne znaju za sync.
//
// Dopuna: registri artikala (R_Grupa / R_Podgrupa / R_Poreklo) nisu u
// generisanoj mapi, pa imaju sopstvene lagane syncere (bez watermarka).
@Module({
  imports: [PrismaModule, PodesavanjaModule],
  controllers: [SyncController],
  providers: [
    MssqlClient,
    SyncService,
    CustomerSyncer,
    BigbitMdbImportService,
    BigbitMdbJobs,
    ItemGroupSyncer,
    ItemSubgroupSyncer,
    ItemOriginSyncer,
  ],
  exports: [SyncService, BigbitMdbImportService, BigbitMdbJobs],
})
export class SyncModule {}
