import { IsOptional, IsString } from "class-validator";

/**
 * Dopuna deviznog računa (`payment_accounts`) — četiri kolone koje BigBit sync NE zna, a
 * izvozna faktura ih štampa u bloku „Beneficiary Customer / Bank of beneficiary".
 *
 * SEMANTIKA: polje IZOSTAVLJENO (`undefined`) → ne dira se; `null`/prazan string →
 * briše se (papir tada taj red ne ispisuje).
 *
 * ŠTA NAMERNO NIJE OVDE: `accountNumber`, `isDefault`, `sortOrder`, `countryCode`,
 * `bankCode`. Njih donosi BigBit sync i prepisao bi ih na sledećem prolazu, pa bi izmena
 * iz forme bila obećanje koje sistem ne može da održi. Obrazloženje je u
 * `payment-accounts.service.ts`.
 *
 * KLASA, NE INTERFEJS: globalni `ValidationPipe` (`main.ts`) validira isključivo klase sa
 * `class-validator` dekoratorima — interfejs u runtime-u ne postoji, pa bi telo prolazilo
 * netaknuto do servisa (`{"iban": 12345}` → 500 umesto srpskog 422). `whitelist: true`
 * uz to odbacuje nepoznata polja, pa se kroz ovu rutu ne može dohvatiti BigBit kolona.
 */
export class UpdatePaymentAccountDto {
  /** IBAN deviznog računa; čuva se bez razmaka, proverava se MOD-97 (ISO 13616/7064). */
  @IsOptional()
  @IsString()
  iban?: string | null;

  /** SWIFT/BIC banke, 8 ili 11 znakova (ISO 9362). */
  @IsOptional()
  @IsString()
  swift?: string | null;

  /** Naziv banke — na papiru stoji uz valutu („Banca Intesa a.d. EUR"). */
  @IsOptional()
  @IsString()
  bankName?: string | null;

  /** Adresa banke; VIŠERED — prelomi (`\n`) su deo podatka, papir ih prepisuje redom. */
  @IsOptional()
  @IsString()
  bankAddress?: string | null;

  /** Valuta računa (ISO 4217, npr. `EUR`) — po njoj štampa bira račun za valutu fakture. */
  @IsOptional()
  @IsString()
  currency?: string | null;
}
