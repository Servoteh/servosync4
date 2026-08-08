import { Module } from "@nestjs/common";
import { MailModule } from "../../common/mail/mail.module";
import { SchedulerModule } from "../scheduler/scheduler.module";
import { KadrovskaController } from "./kadrovska.controller";
import { KadrovskaService } from "./kadrovska.service";
import { KadrovskaMutationsController } from "./kadrovska-mutations.controller";
import { KadrovskaMutationsService } from "./kadrovska-mutations.service";
import { KadrovskaGridAutofillService } from "./grid-autofill.service";
import { KadrovskaAuthzService } from "./kadrovska-authz.service";

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
    // Seoba sy15 → 3.0, sloj prava: 3.0 parnjak 49 RLS politika domena.
    // Registrovan sada da bi CRUD faza imala u što da se zakači; nijedan
    // postojeći pozivalac se ne menja, pa je zatečeno ponašanje netaknuto.
    KadrovskaAuthzService,
  ],
  // Talas AI-1: alat `prisustvo_danas` (AiChatModule) zove `attendanceNow` —
  // poslovna logika prisustva ostaje ovde, AI je samo još jedan pozivalac.
  exports: [KadrovskaService, KadrovskaAuthzService],
})
export class KadrovskaModule {}
