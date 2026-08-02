import { Type } from "class-transformer";
import { IsEmail, IsInt, IsOptional, IsPositive } from "class-validator";

/**
 * `POST /v1/dictation-inbox/claim` telo — SVE je opciono.
 *
 * Bez tela (ili prazno `{}`) → povlači se SVOJE sanduče (pozivalac iz JWT-a).
 * Sa `ownerUserId` ili `ownerEmail` → povlači se TUĐE sanduče, ali samo ako u
 * `dictation_delegates` postoji red (vlasnik, pozivalac); inače 403. Tačno jedno
 * od dva polja (oba istovremeno → 400).
 *
 * `@IsOptional` drži polja u whitelist-u global ValidationPipe-a; poslovnu odluku
 * („sme li pozivalac u to sanduče") presuđuje servis, ne dekoratori.
 */
export class ClaimDictationDto {
  @IsOptional()
  @IsInt()
  @IsPositive()
  ownerUserId?: number;

  @IsOptional()
  @IsEmail()
  ownerEmail?: string;
}

/**
 * `GET /v1/dictation-inbox/last-claimed` — isti izbor sandučeta, ali kroz query.
 *
 * Ista dva polja kao gore; razlika je `@Type(() => Number)`, jer query parametri
 * stižu kao STRING (globalni `ValidationPipe` ima `transform: true`, ali ne i
 * `enableImplicitConversion`) pa bi `@IsInt` inače oborio `?ownerUserId=2`.
 */
export class LastClaimedQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  ownerUserId?: number;

  @IsOptional()
  @IsEmail()
  ownerEmail?: string;
}
