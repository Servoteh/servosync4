import { Module } from "@nestjs/common";
import { AiChatController } from "./ai-chat.controller";
import { AiChatService } from "./ai-chat.service";

/** AI asistent — 3.0 TALAS B (podaci u sy15 bazi — Sy15Module, globalan). */
@Module({
  controllers: [AiChatController],
  providers: [AiChatService],
})
export class AiChatModule {}
