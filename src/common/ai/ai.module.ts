import { Global, Module } from "@nestjs/common";
import { AiProviderService } from "./ai-provider.service";

/**
 * Globalni AI provider (Talas B; C/D/G reuse) — jedini izlaz ka OpenAI/Anthropic.
 * Ključevi u BE env; boot-safe (bez ključa engine vraća 503, aplikacija se diže).
 */
@Global()
@Module({
  providers: [AiProviderService],
  exports: [AiProviderService],
})
export class AiModule {}
