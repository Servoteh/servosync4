import { Module } from "@nestjs/common";
import { OdrzavanjeSourceService } from "../../common/sy15/odrzavanje-source.service";
import { PrismaModule } from "../../prisma/prisma.module";
import { PrintingModule } from "../../common/printing/printing.module";
import { ReversiController } from "./reversi.controller";
import { ReversiService } from "./reversi.service";

/**
 * Reversi — prvi 3.0 pilot modul na 2.0 stacku (podaci u sy15 bazi — Sy15Module).
 * PrintingModule: deljeni RAW TSPL2 transport (LabelPrintService) za labels/print
 * (RA-22 bulk štampa nalepnica / RB-47 nalepnica pri dodavanju).
 */
@Module({
  imports: [PrintingModule, PrismaModule],
  controllers: [ReversiController],
  providers: [
    ReversiService,
    // Prekidač TUĐEG domena: `reportMachines()` čita `v_rev_machines` nad
    // `maint_machines` (održavanje, korak 2 gašenja sy15). Bez njega bi posle
    // preklopa održavanja izveštaj mašina tiho prikazivao zastarelo stanje.
    OdrzavanjeSourceService,
  ],
})
export class ReversiModule {}
