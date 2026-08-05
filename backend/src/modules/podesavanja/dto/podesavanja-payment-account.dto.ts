import { IsInt, IsOptional, IsPositive, IsString } from "class-validator";

/**
 * Dopuna deviznog računa (`payment_accounts`) — četiri kolone koje BigBit sync NE zna, a
 * izvozna faktura ih štampa u bloku „Beneficiary Customer / Bank of beneficiary".
 *
 * SEMANTIKA: polje IZOSTAVLJENO (`undefined`) → ne dira se; `null`/prazan string →
 * briše se (papir tada taj red ne ispisuje).
 *
 * ŠTA NAMERNO NIJE OVDE: `isDefault`, `sortOrder`, `countryCode`, `bankCode`. Njih donosi
 * BigBit sync i prepisao bi ih na sledećem prolazu, pa bi izmena iz forme bila obećanje
 * koje sistem ne može da održi. Obrazloženje je u `payment-accounts.service.ts`.
 *
 * `accountNumber` je od 05.08.2026 OVDE, ali samo za račun UNET U 4.0 (`id` iz native
 * opsega): takav red BigBit ne poznaje i ne prepisuje, pa je popravka greške u kucanju
 * naša odgovornost. Na BigBit redu ista izmena se odbija sa 422 — bez toga bi ekran nudio
 * izmenu koju sync vraća na staro. Bez toga bi jedini put za slovnu grešku u broju računa
 * bio novi ćorsokak (unos postoji, ispravka ne).
 *
 * KLASA, NE INTERFEJS: globalni `ValidationPipe` (`main.ts`) validira isključivo klase sa
 * `class-validator` dekoratorima — interfejs u runtime-u ne postoji, pa bi telo prolazilo
 * netaknuto do servisa (`{"iban": 12345}` → 500 umesto srpskog 422). `whitelist: true`
 * uz to odbacuje nepoznata polja, pa se kroz ovu rutu ne može dohvatiti BigBit kolona.
 */
export class UpdatePaymentAccountDto {
  /**
   * Broj računa — dozvoljen SAMO na 4.0-native računu (`id >= 900.000.000`). Na BigBit
   * redu servis vraća 422: sync bi izmenu vratio na staro.
   */
  @IsOptional()
  @IsString()
  accountNumber?: string;

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

/**
 * NOV DEVIZNI RAČUN (`POST /admin/firma/racuni`) — unos iz aplikacije, 05.08.2026.
 *
 * ZAŠTO POSTOJI: `payment_accounts` na produkciji ima NULA redova (izmereno), BigBit
 * `.mdb` kanal ovu tabelu ne uvozi uopšte, a izvozna faktura u stranoj valuti bez IBAN-a
 * i SWIFT-a ODBIJA da se odštampa (brana 02.08.2026). Ekran je do sada nudio samo izmenu
 * zatečenih redova i upućivao na SQL u dokumentaciji — dakle na put koji vlasnik ne može
 * da pređe. Red se sada pravi u REZERVISANOM 4.0 opsegu ključeva (`id >= 900.000.000`,
 * `sync/table-ownership.ts`), istim obrascem kojim se prave native artikli i komitenti.
 *
 * SVA ČETIRI OBAVEZNA POLJA su obavezna zato što račun bez njih NE OTKLJUČAVA štampu:
 * `assertBankDetails` traži i IBAN i SWIFT, a `loadForeignAccount` bira račun PO VALUTI.
 * Red bez valute ili bez jednog od dva koda bio bi novi ćorsokak — unos je prošao, papir
 * i dalje ne izlazi.
 *
 * ŠTA NIJE OVDE: `isDefault`, `sortOrder`, `countryCode`, `bankCode`. Podrazumevani račun
 * je BigBit-ov dinarski (zaglavlje dokumenta ga ionako čita iz `companies.bankAccount`),
 * a `bankCode` je konto banke za izvode — knjigovodstveni podatak koji se ne izmišlja iz
 * ovog ekrana.
 */
export class CreatePaymentAccountDto {
  /** Firma; izostavljeno → primarna (najmanji `id`), isto kao u štampama. */
  @IsOptional()
  @IsInt()
  @IsPositive()
  companyId?: number;

  /** Broj računa kako stoji na izvodu („160-0050100035011-86"). Obavezan, do 50 znakova. */
  @IsString()
  accountNumber!: string;

  /** Valuta računa (ISO 4217) — obavezna, po njoj štampa bira ovaj račun. */
  @IsString()
  currency!: string;

  /** IBAN — obavezan, proverava se MOD-97 (ISO 13616/7064). */
  @IsString()
  iban!: string;

  /** SWIFT/BIC — obavezan, 8 ili 11 znakova (ISO 9362). */
  @IsString()
  swift!: string;

  /** Naziv banke — nije obavezan, ali papir bez njega nema „Bank of beneficiary". */
  @IsOptional()
  @IsString()
  bankName?: string | null;

  /** Adresa banke; VIŠERED — prelomi (`\n`) su deo podatka. */
  @IsOptional()
  @IsString()
  bankAddress?: string | null;
}
