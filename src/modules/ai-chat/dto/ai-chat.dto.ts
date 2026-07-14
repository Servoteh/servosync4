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
}

/** Multipart polja uz `/ai/images/sign` (path se šalje kao query/param). */
export class SignImageDto {
  @IsString() @MaxLength(300) path!: string;
}
