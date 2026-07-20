import { Module } from "@nestjs/common";
import { DocumentsModule } from "../../documents/documents.module";
import { MailModule } from "../../../common/mail/mail.module";
import { InvoicePdfService } from "./invoice-pdf.service";
import { InvoiceMailService } from "./invoice-mail.service";

/**
 * Štampa i slanje izlaznih računa (Faza 5 §C).
 *
 * `InvoicePdfService` renderuje PDF fakture kroz zajednički `PdfService`
 * (pdfmake) iz `DocumentsModule`; `InvoiceMailService` ga šalje kupcu kroz
 * globalni `MailService` (Resend). `PrismaService` je globalno dostupan.
 *
 * NAPOMENA: modul se NE registruje u `app.module.ts` ovde — to radi integrator
 * (Faza 5 wiring), zajedno sa sales controller-om koji izlaže endpointe.
 */
@Module({
  imports: [DocumentsModule, MailModule],
  providers: [InvoicePdfService, InvoiceMailService],
  exports: [InvoicePdfService, InvoiceMailService],
})
export class SalesPrintModule {}
