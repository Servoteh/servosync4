/**
 * Prompts that used to be hard-coded inside the gateway (Talas AI-0, item 7b).
 * `AiProviderService` is transport only — every prompt string lives here or in the
 * owning module (`zahtevi-ai.ts`, `sastanci-summary.ts`, `montaza-ai.ts`).
 *
 * Wording is unchanged from the gateway — this is a move, not a rewrite.
 */

/** Auto-title for a new personal chat thread (gpt-4o-mini, max_tokens 24). */
export const CHAT_TITLE_SYSTEM_PROMPT =
  "Vrati SAMO kratak naslov razgovora (2–5 reči, srpski, latinica, bez navodnika i tačke).";

/** Whisper biasing prompt for Serbian audio, per capture context. */
export function whisperSerbianPrompt(context?: string): string {
  return context === "chat"
    ? "Neformalna poruka na srpskom jeziku, latinicom — svakodnevni razgovor, pitanja o poslu i aplikaciji."
    : "Servisni zapisnik na srpskom jeziku, latinicom. Radni nalozi i predmeti se pišu ciframa, npr. 9400/2, TP 1/430, presa 350t.";
}
