import { Module } from "@nestjs/common";
import { PrismaModule } from "../../prisma/prisma.module";
import { MailModule } from "../../common/mail/mail.module";
import { NabavkaController } from "./nabavka.controller";
import { NabavkaService } from "./nabavka.service";
import { PurchaseNumberingService } from "./purchase-numbering.service";

/**
 * NACRT — modul Nabavka (Traka B §B). Zavisnosti:
 *   PrismaModule (baza), MailModule (auto-mail RFQ preko Resend — već exportuje MailService).
 *
 * Aktivacija (kad modeli budu u schema.prisma i baza dostupna):
 *   1) preimenuj sve `*.ts.nacrt` → `*.ts`
 *   2) dodaj `NabavkaModule` u app.module.ts imports
 *   3) dodaj NABAVKA_READ/WRITE/APPROVE u src/common/authz/permissions.ts + role mapiranje
 *      + mirror u frontend/src/lib/permissions.ts
 */
@Module({
  imports: [PrismaModule, MailModule],
  controllers: [NabavkaController],
  providers: [NabavkaService, PurchaseNumberingService],
})
export class NabavkaModule {}
