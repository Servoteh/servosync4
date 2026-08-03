import {
  IsEmail,
  IsInt,
  IsOptional,
  IsPositive,
  IsString,
  MaxLength,
} from "class-validator";

/**
 * `POST /v1/dictation-delegates` telo — dodela dozvole „delegat sme da povuče
 * vlasnikove diktate". Za svaku stranu prosleđuje se `…UserId` ILI `…Email`
 * (oba istovremeno → 400; nijedno → 400). Idempotentno: ponovljena ista dodela
 * vraća postojeći red, ne pravi duplikat (`uq_dictation_delegates_owner_delegate`).
 */
export class CreateDictationDelegateDto {
  @IsOptional()
  @IsInt()
  @IsPositive()
  ownerUserId?: number;

  @IsOptional()
  @IsEmail()
  ownerEmail?: string;

  @IsOptional()
  @IsInt()
  @IsPositive()
  delegateUserId?: number;

  @IsOptional()
  @IsEmail()
  delegateEmail?: string;

  /** Slobodna beleška za reviziju („Cursor agent sa telefona"). */
  @IsOptional()
  @IsString()
  @MaxLength(255)
  note?: string;
}
