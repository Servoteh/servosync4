import { Module } from "@nestjs/common";
import { MailModule } from "../../common/mail/mail.module";
import { KadrovskaController } from "./kadrovska.controller";
import { KadrovskaService } from "./kadrovska.service";
import { KadrovskaMutationsController } from "./kadrovska-mutations.controller";
import { KadrovskaMutationsService } from "./kadrovska-mutations.service";
import { KadrovskaGridAutofillService } from "./grid-autofill.service";

/** Kadrovska (HR) — 3.0 TALAS G (podaci u sy15 bazi — Sy15Module, globalan).
 *  R1 read (KadrovskaController/Service) + R2 mutacije (Mutations*).
 *  MailModule: 360° pozivnice (port 1.0 edge fn assessment-invite → Resend direktno).
 *  GridAutofill (zahtev 012/26): dnevni auto-predlog grida iz kapije (poseban servis). */
@Module({
  imports: [MailModule],
  controllers: [KadrovskaController, KadrovskaMutationsController],
  providers: [
    KadrovskaService,
    KadrovskaMutationsService,
    KadrovskaGridAutofillService,
  ],
})
export class KadrovskaModule {}
