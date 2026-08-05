import { Module } from "@nestjs/common";
import { PrintingModule } from "../../common/printing/printing.module";
import { ReversiController } from "./reversi.controller";
import { ReversiService } from "./reversi.service";
import { ReversiSourceService } from "./reversi-source.service";

/**
 * Reversi — prvi 3.0 pilot modul na 2.0 stacku.
 * PrintingModule: deljeni RAW TSPL2 transport (LabelPrintService) za labels/print
 * (RA-22 bulk štampa nalepnica / RB-47 nalepnica pri dodavanju).
 *
 * Izvor podataka bira `ReversiSourceService` iz `REVERSI_IZVOR` (default `sy15`) —
 * seoba na 3.0 bazu je u toku, v. docs/SEOBA_REVERSA_2026-08-05.md.
 * `PrismaService` (3.0) i `Sy15Service` stižu iz globalnih modula.
 */
@Module({
  imports: [PrintingModule],
  controllers: [ReversiController],
  providers: [ReversiService, ReversiSourceService],
})
export class ReversiModule {}
