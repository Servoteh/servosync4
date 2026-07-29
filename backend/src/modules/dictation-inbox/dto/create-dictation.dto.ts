import { IsOptional, IsString } from "class-validator";

/**
 * `POST /v1/dictation-inbox` telo — jedan sređen diktat.
 *
 * Ovde je SAMO tipska provera (`@IsString` → global ValidationPipe vraća 400 na
 * ne-string). Poslovna pravila — NEPRAZAN i ≤ `MAX_TEXT_LEN` znakova — forsira
 * `DictationInboxService` kao **422 (Unprocessable)**, jer zadatak traži 422, a
 * global pipe za `@IsNotEmpty`/`@MaxLength` vraća 400. Zato dužinu/praznost
 * namerno presuđuje servis, ne dekoratori. `@IsOptional` drži polje u whitelist-u
 * (bez dekoratora bi ga `whitelist:true` uklonio); nedostajući `text` → servis ga
 * tretira kao prazan → 422.
 */
export class CreateDictationDto {
  @IsOptional()
  @IsString()
  text?: string;
}
