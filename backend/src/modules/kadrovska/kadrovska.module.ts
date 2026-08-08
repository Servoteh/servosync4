import { Module } from "@nestjs/common";
import { MailModule } from "../../common/mail/mail.module";
import { SchedulerModule } from "../scheduler/scheduler.module";
import { KadrovskaController } from "./kadrovska.controller";
import { KadrovskaService } from "./kadrovska.service";
import { KadrovskaMutationsController } from "./kadrovska-mutations.controller";
import { KadrovskaMutationsService } from "./kadrovska-mutations.service";
import { KadrovskaGridAutofillService } from "./grid-autofill.service";
import { KadrovskaSourceService } from "../../common/sy15/kadrovska-source.service";

/** Kadrovska (HR) — 3.0 TALAS G (podaci u sy15 bazi — Sy15Module, globalan).
 *  R1 read (KadrovskaController/Service) + R2 mutacije (Mutations*).
 *  MailModule: 360° pozivnice (port 1.0 edge fn assessment-invite → Resend direktno).
 *  GridAutofill (zahtev 012/26): dnevni auto-predlog grida iz kapije (poseban servis). */
@Module({
  // SchedulerModule → NotifyDispatchService (3.0 nativni dispečer outboxa).
  imports: [MailModule, SchedulerModule],
  controllers: [KadrovskaController, KadrovskaMutationsController],
  providers: [
    KadrovskaService,
    KadrovskaMutationsService,
    KadrovskaGridAutofillService,
    // Prekidač izvora (korak 4 gašenja sy15) — provajduje se PO MODULU, isto kao
    // `OdrzavanjeSourceService` i `PbSourceService`. EXPORT-uje se jer ga pod istim
    // prekidačem moraju čitati i „Moj profil", Podešavanja, scheduler i AI-chat
    // (spisak stvarnih pozivalaca je u doc-komentaru samog prekidača).
    KadrovskaSourceService,
  ],
  // Talas AI-1: alat `prisustvo_danas` (AiChatModule) zove `attendanceNow` —
  // poslovna logika prisustva ostaje ovde, AI je samo još jedan pozivalac.
  exports: [KadrovskaService, KadrovskaSourceService],
})
export class KadrovskaModule {}
