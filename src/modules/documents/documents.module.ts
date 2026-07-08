import { Module } from "@nestjs/common";
import { BarcodeService } from "./barcode.service";
import { PdfService } from "./pdf.service";

/**
 * Zajednički sloj za generisanje dokumenata (MODULE_SPEC_stampa §7):
 * `BarcodeService` (Code 128 SVG, bwip-js) + `PdfService` (pdfmake render).
 * Domenski moduli (npr. work-orders) importuju ovaj modul i koriste servise
 * za štampu RN dokumenta, nalepnica, kartica.
 */
@Module({
  providers: [BarcodeService, PdfService],
  exports: [BarcodeService, PdfService],
})
export class DocumentsModule {}
