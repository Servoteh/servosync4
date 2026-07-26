import { Global, Module } from "@nestjs/common";
import { AiProviderService } from "./ai-provider.service";
import { AiUsageService } from "./ai-usage.service";
import { AiLimitsService } from "./ai-limits.service";
import { AiModelPolicyService } from "./ai-model-policy.service";

/**
 * Globalni AI provider (Talas B; C/D/G reuse) — jedini izlaz ka OpenAI/Anthropic.
 * Ključevi u BE env; boot-safe (bez ključa engine vraća 503, aplikacija se diže).
 *
 * Talas AI-0 dodaje tri satelita, sve nad GLAVNOM bazom (PrismaModule je @Global):
 *  - `AiUsageService`       → `ai_usage_log` (merenje svakog poziva),
 *  - `AiLimitsService`      → dnevni token/poziv budžeti nad tim logom,
 *  - `AiModelPolicyService` → registar „zadatak → model" (`ai_model_policy`).
 */
@Global()
@Module({
  providers: [
    AiProviderService,
    AiUsageService,
    AiLimitsService,
    AiModelPolicyService,
  ],
  exports: [
    AiProviderService,
    AiUsageService,
    AiLimitsService,
    AiModelPolicyService,
  ],
})
export class AiModule {}
