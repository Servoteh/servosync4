import { IsIn, IsOptional, IsString, IsUUID, MaxLength } from "class-validator";

/**
 * `/ai/chat` ulaz (port edge `ai-chat`). Slika ide kao multipart `image` fajl
 * (vision) — ovde su samo tekst-polja. `message` sme biti prazan ako je slika
 * priložena; prazan I bez slike → 400 (proverava servis, paritet edge).
 */
export class ChatDto {
  @IsOptional() @IsString() @MaxLength(4000) message?: string;

  @IsOptional() @IsIn(["openai", "claude", "gemini", "kimi"]) engine?: string;

  /** Nastavak postojeće niti (lične ili projektne). */
  @IsOptional() @IsUUID() conversationId?: string;

  /** Nova/postojeća projektna nit — project_code (npr. 9400/7). */
  @IsOptional() @IsString() @MaxLength(64) projectRef?: string;

  /**
   * Floating AI widget (request 003/26): short human label of the screen/route
   * the user is currently on (e.g. "Sastanci (/sastanci)"), computed FE-side from
   * the nav model. When present, the system prompt asks the assistant to help with
   * the current screen first. Optional — desktop/mobile /ai variants omit it.
   */
  @IsOptional() @IsString() @MaxLength(300) screenContext?: string;
}

/** Multipart polja uz `/ai/images/sign` (path se šalje kao query/param). */
export class SignImageDto {
  @IsString() @MaxLength(300) path!: string;
}
