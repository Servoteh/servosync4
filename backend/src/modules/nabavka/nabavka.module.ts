import { Module } from "@nestjs/common";
import { PrismaModule } from "../../prisma/prisma.module";
import { MailModule } from "../../common/mail/mail.module";
import { RobnoModule } from "../robno/robno.module";
import { PostingModule } from "../gl/posting/posting.module";
import { NabavkaController } from "./nabavka.controller";
import { NabavkaService } from "./nabavka.service";
import { PurchaseNumberingService } from "./purchase-numbering.service";

/**
 * Modul Nabavka (Traka B §B). Zavisnosti:
 *   PrismaModule (baza), MailModule (auto-mail RFQ preko Resend),
 *   RobnoModule (prijem → robni ulaz + kalkulacija) i PostingModule (robni ulaz → GL nalog) —
 *   `receiveOrder` posle prijema automatski pravi UL StockDocument, kalkuliše i knjiži (Faza 3 veza).
 */
@Module({
  imports: [PrismaModule, MailModule, RobnoModule, PostingModule],
  controllers: [NabavkaController],
  providers: [NabavkaService, PurchaseNumberingService],
})
export class NabavkaModule {}
