import { Module } from "@nestjs/common";
import { AiChatController } from "./ai-chat.controller";
import { AiChatService } from "./ai-chat.service";
import { KadrovskaModule } from "../kadrovska/kadrovska.module";

/**
 * AI asistent — 3.0 TALAS B (podaci u sy15 bazi — Sy15Module, globalan).
 * Talas AI-1: alati čitaju i GLAVNU bazu (PrismaService — `PrismaModule` je
 * @Global), a `prisustvo_danas` zove postojeći `KadrovskaService` umesto da
 * duplira upit nad `v_attendance_now` (plan §2.4) — otud import kadrovske.
 */
@Module({
  imports: [KadrovskaModule],
  controllers: [AiChatController],
  providers: [AiChatService],
})
export class AiChatModule {}
