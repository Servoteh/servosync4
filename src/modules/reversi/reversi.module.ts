import { Module } from "@nestjs/common";
import { PrintingModule } from "../../common/printing/printing.module";
import { ReversiController } from "./reversi.controller";
import { ReversiService } from "./reversi.service";

/**
 * Reversi — prvi 3.0 pilot modul na 2.0 stacku (podaci u sy15 bazi — Sy15Module).
 * PrintingModule: deljeni RAW TSPL2 transport (LabelPrintService) za labels/print
 * (RA-22 bulk štampa nalepnica / RB-47 nalepnica pri dodavanju).
 */
@Module({
  imports: [PrintingModule],
  controllers: [ReversiController],
  providers: [ReversiService],
})
export class ReversiModule {}
