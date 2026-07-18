import { Module } from "@nestjs/common";
import { PrintingModule } from "../../common/printing/printing.module";
import { LocationsController } from "./locations.controller";
import { LocationsService } from "./locations.service";

/**
 * Lokacije delova — 3.0 Talas A (fizičke lokacije loc_*; podaci u sy15 bazi —
 * Sy15Module je globalno dostupan preko app.module). MODULE_SPEC_lokacije_30.md.
 * PrintingModule: deljeni RAW TSPL2 transport (LabelPrintService) za labels/print (R2).
 */
@Module({
  imports: [PrintingModule],
  controllers: [LocationsController],
  providers: [LocationsService],
})
export class LocationsModule {}
