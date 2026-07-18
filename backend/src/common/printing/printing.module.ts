import { Module } from "@nestjs/common";
import { LabelPrintService } from "./label-print.service";

/**
 * Deljeni RAW TSPL2 print transport (LabelPrintService). Importuju ga moduli koji
 * štampaju nalepnice: Tehnologija (TP/RNZ) i Lokacije (police + TP, Talas A).
 */
@Module({
  providers: [LabelPrintService],
  exports: [LabelPrintService],
})
export class PrintingModule {}
