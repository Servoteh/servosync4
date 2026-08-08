import { Module } from "@nestjs/common";
import { PrintingModule } from "../../common/printing/printing.module";
import { ReversiLokacijeIzvorModule } from "../../common/sy15/reversi-lokacije-izvor.module";
import { LocationsController } from "./locations.controller";
import { LocationsService } from "./locations.service";
import { LocTpFeedService } from "./loc-tp-feed.service";

/**
 * Lokacije delova — 3.0 Talas A (fizičke lokacije loc_*; podaci u sy15 bazi —
 * Sy15Module je globalno dostupan preko app.module). MODULE_SPEC_lokacije_30.md.
 * PrintingModule: deljeni RAW TSPL2 transport (LabelPrintService) za labels/print (R2).
 *
 * ReversiLokacijeIzvorModule: prekidač `LOKACIJE_IZVOR` (seoba sy15, korak 3). Nosi
 * i `REVERSI_IZVOR` jer su ta dva domena transakciono spojena — izdavanje alata u
 * jednom commit-u piše `rev_document_lines` i `loc_location_movements`
 * (docs/SEOBA_REVERSI_LOKACIJE_2026-08-07.md §2).
 */
@Module({
  imports: [PrintingModule, ReversiLokacijeIzvorModule],
  controllers: [LocationsController],
  providers: [LocationsService, LocTpFeedService],
})
export class LocationsModule {}
