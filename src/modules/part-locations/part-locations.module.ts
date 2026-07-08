import { Module } from "@nestjs/common";
import { PrismaModule } from "../../prisma/prisma.module";
import { PartLocationsController } from "./part-locations.controller";
import { PartLocationsService } from "./part-locations.service";
import { PositionsController } from "./positions.controller";
import { PositionsService } from "./positions.service";

/**
 * Lokacije napravljenih delova (MODULE_SPEC_lokacije) ovog talasa:
 * ledger `part_locations` sa PREDZNAKOM (pregled + kartica sa neto stanjem +
 * unos/prenos/trebovanje) + CRUD matičnih pozicija/polica `positions`.
 * Eksplicitan `part_location_movements` (movement_type) i dvosmerni sync ka
 * QBigTehn-u su van obima — spec §7.1/§11, preklapanje sa ServoSync 1.0
 * „Lokacije delova" (§8) čeka potvrdu Negovana/Nese.
 *
 * Registracija u `app.module.ts` je posao integratora (dodati `PartLocationsModule`
 * u `imports`).
 */
@Module({
  imports: [PrismaModule],
  controllers: [PartLocationsController, PositionsController],
  providers: [PartLocationsService, PositionsService],
})
export class PartLocationsModule {}
