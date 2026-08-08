import { Module } from "@nestjs/common";
import { MailModule } from "../../common/mail/mail.module";
import { SchedulerModule } from "../scheduler/scheduler.module";
import { KadrovskaController } from "./kadrovska.controller";
import { KadrovskaService } from "./kadrovska.service";
import { KadrovskaMutationsController } from "./kadrovska-mutations.controller";
import { KadrovskaMutationsService } from "./kadrovska-mutations.service";
import { KadrovskaGridAutofillService } from "./grid-autofill.service";
import { KadrovskaFnPlateService } from "./kadrovska-fn-plate.service";
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
    // Prepis sy15 DEFINER funkcija oblasti PLATE i PRISUSTVO nad 3.0 bazom
    // (korak 4, blokada 2). 🔴 Nosi i BRAVU nad zaradama (allowlist
    // `kadr_salary_viewer_allowlist`), koju je u sy15 sprovodio RLS — 3.0 ga
    // nema, pa bez ovog servisa zarade ne bi imale nijednu branu.
    KadrovskaFnPlateService,
    // Prekidač izvora (korak 4 gašenja sy15) — provajduje se PO MODULU, isto kao
    // `OdrzavanjeSourceService` i `PbSourceService`. EXPORT-uje se jer ga pod istim
    // prekidačem moraju čitati i „Moj profil", Podešavanja, scheduler i AI-chat
    // (spisak stvarnih pozivalaca je u doc-komentaru samog prekidača).
    KadrovskaSourceService,
  ],
  // Talas AI-1: alat `prisustvo_danas` (AiChatModule) zove `attendanceNow` —
  // poslovna logika prisustva ostaje ovde, AI je samo još jedan pozivalac.
  // `KadrovskaFnPlateService` se EXPORT-uje jer istu bravu nad platama i isti
  // prepis prisustva mora da koristi i „Moj profil" (samousluga: korekcije
  // kapije, moji sati) — inače bi drugi modul napravio svoju kopiju gejta.
  exports: [KadrovskaService, KadrovskaSourceService, KadrovskaFnPlateService],
})
export class KadrovskaModule {}
