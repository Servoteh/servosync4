import { Module } from "@nestjs/common";
import { PrismaModule } from "../../prisma/prisma.module";
import { PostingModule } from "../gl/posting/posting.module";
import { DocumentsModule } from "../documents/documents.module";
import { StockDocumentPdfService } from "./print/stock-document-pdf.service";
import { InventoryCountPdfService } from "./print/inventory-count-pdf.service";
import { StockReportPdfService } from "./print/stock-report-pdf.service";
import { GoodsReceiptReportPdfService } from "./print/goods-receipt-report-pdf.service";
import { RobnoController } from "./robno.controller";
import { RobnoService } from "./robno.service";
import { LagerQueryService } from "./lager-query.service";
import { KepuService } from "./kepu.service";
import { CalculationService } from "./calculation.service";
import { StockDocumentNumberingService } from "./stock-document-numbering.service";
import { CostingService } from "./costing.service";
import { NivelacijaService, COSTING_SERVICE } from "./nivelacija.service";
import { NIVELACIJA_HOOK } from "./nivelacija.hook";
import { InventoryService } from "./inventory.service";
import { CarryOverService } from "./carry-over.service";
import { DocumentEditService } from "./document-edit.service";
import { ReservationService } from "./reservation.service";
import { TransferService } from "./transfer.service";

/**
 * Robno / magacin (Faza 3) — costing, kalkulacija (landed cost), nivelacija, lager, popis (doc 39).
 *
 * DI portovi (labava sprega — paralelni servisi ne uvoze jedni druge direktno):
 *   - `COSTING_SERVICE` (StateProvider)      → `CostingService` (stateAsOf za nivelaciju)
 *   - `NIVELACIJA_HOOK` (hook iz kalkulacije) → `NivelacijaService`
 * Kada su vezani, ulaz robe (UL) posle kalkulacije AUTOMATSKI okida uprosečavanje
 * (doc 39 §F): |ulaznaVP−staraVP|≥0.01 → nova ponderisana valuaciona cena + NIV dokument + GK razlika.
 *
 * `NIV_NUMBERING` se NAMERNO ne vezuje — potpis `StockDocumentNumberingService.next` se razlikuje od
 * `NivNumberingProvider.nextNivNumber`; NivelacijaService pada na ugrađeni advisory-lock MAX fallback.
 *
 * Registracija u `app.module.ts` je posao integratora (dodati `RobnoModule` u `imports`).
 */
@Module({
  // `DocumentsModule` daje deljeni `PdfService` (pdfmake) + `BarcodeService` (Code 128) —
  // isti put štampe kao work-orders/sales; bez novih zavisnosti.
  imports: [PrismaModule, PostingModule, DocumentsModule],
  controllers: [RobnoController],
  providers: [
    // Podela odgovornosti (04.08.2026): `RobnoService` je od tada UPIS (kreiranje dokumenta
    // pod advisory lock-om, guard stanja, lock, soft-delete stavki). Čitanje izveštaja i
    // KEPU knjiga su izdvojeni, jer se menjaju iz sasvim drugih razloga.
    RobnoService,
    LagerQueryService, // read-only: lager lista + kartica artikla
    KepuService, // KEPU knjiga (maloprodajna evidencija) iz robnog toka
    StockDocumentPdfService, // štampa robnih dokumenata (primka/izdatnica/otpremnica/…)
    InventoryCountPdfService, // popisna lista (zakonski obrazac, 2 varijante)
    StockReportPdfService, // lager lista + kartica artikla
    GoodsReceiptReportPdfService, // zapisnik o prijemu robe (kvantitativno-kvalitativni)
    CalculationService,
    StockDocumentNumberingService,
    CostingService,
    NivelacijaService,
    InventoryService, // E2 popis/inventura (predpunjenje → unos → VISAK/MANJAK)
    CarryOverService, // Batch B: PO → primka, predračun → izdatnica
    DocumentEditService, // izmena zaglavlja + dodavanje/izmena stavke (PLAN_UNOS_DOKUMENATA §5.7)
    ReservationService, // Batch C: rezervacija zaliha (raspoloživo = stanje − rezervisano)
    TransferService, // prenos između magacina — PAR dokumenata (izlaz+ulaz) + storno
    { provide: COSTING_SERVICE, useExisting: CostingService },
    { provide: NIVELACIJA_HOOK, useExisting: NivelacijaService },
  ],
  exports: [
    RobnoService,
    LagerQueryService,
    KepuService,
    CalculationService,
    CostingService,
    ReservationService,
  ],
})
export class RobnoModule {}
