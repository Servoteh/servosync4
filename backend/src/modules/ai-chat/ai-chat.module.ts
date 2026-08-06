import { Module } from "@nestjs/common";
import { AiChatController } from "./ai-chat.controller";
import { AiChatService } from "./ai-chat.service";
import { KadrovskaModule } from "../kadrovska/kadrovska.module";
import { OdrzavanjeSourceService } from "../../common/sy15/odrzavanje-source.service";

/**
 * AI asistent — 3.0 TALAS B (podaci u sy15 bazi — Sy15Module, globalan).
 * Talas AI-1: alati čitaju i GLAVNU bazu (PrismaService — `PrismaModule` je
 * @Global), a `prisustvo_danas` zove postojeći `KadrovskaService` umesto da
 * duplira upit nad `v_attendance_now` (plan §2.4) — otud import kadrovske.
 */
@Module({
  imports: [KadrovskaModule],
  controllers: [AiChatController],
  providers: [
    AiChatService,
    // Korak 2 gašenja sy15: pet alata (`masina_info`, `kvar_istorija`,
    // `masina_uputstvo`, `prijavi_kvar`, `trosak_sredstva`) radi nad `maint_*`
    // podacima, a `prijavi_kvar` u njih PIŠE (`INSERT INTO maint_incidents`).
    // Bez prekidača bi pod `ODRZAVANJE_IZVOR=3.0` te prijave i dalje išle u sy15
    // dok modul piše u 3.0 — dve istine o kvarovima, bez ijedne greške u logu.
    // Provider (a ne import `OdrzavanjeModule`) iz istog razloga kao
    // `PbSourceService` u `SchedulerModule`: prekidač je bez stanja (čita env),
    // pa druga instanca ne menja ponašanje, a modul ostaje nespregnut.
    OdrzavanjeSourceService,
  ],
})
export class AiChatModule {}
