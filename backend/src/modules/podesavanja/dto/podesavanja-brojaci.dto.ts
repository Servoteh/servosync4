import {
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from "class-validator";

/**
 * Upis STARTNOG BROJA po seriji i godini (ekran „Brojači dokumenata", odluka O-F11).
 *
 * `lastNumber` je POSLEDNJI IZDATI broj — sledeći dokument dobija `lastNumber + 1`.
 * To je isto značenje koje kolona `document_number_sequences.last_number` već ima, pa
 * ekran i baza govore istim jezikom; da polje značilo „prvi sledeći broj", svaka
 * poruka o grešci i svaki upit nad bazom bi morali da ga prevode, i pre ili kasnije
 * bi se negde pogrešilo za jedan.
 *
 * ⚠️ Granice ovde su GRUBE (oblik podatka). Poslovnu branu — da broj koji bi se izdao
 * ne postoji već u glavnoj knjizi — sprovodi servis (`assertStartNumberAboveBook`),
 * jer za nju treba merenje nad bazom.
 */
export class SetLastNumberDto {
  /** Ključ serije iz registra numeracije: `@FAKTURA`, `AVR`, `PROF`, `PON`, `REV`. */
  @IsString()
  @MaxLength(10)
  seriesKey!: string;

  /** Puna godina (npr. 2027) — brojač je po seriji I godini. */
  @IsInt()
  @Min(2000)
  @Max(2100)
  year!: number;

  /**
   * Poslednji izdati broj; 0 = još nijedan (sledeći je 1).
   * Gornja granica prati regex brane (7 cifara) — veći broj se u knjizi više ne bi
   * prepoznao kao broj te serije, pa bi brana tiho prestala da radi.
   */
  @IsInt()
  @Min(0)
  @Max(9_999_999)
  lastNumber!: number;

  /** Firma; izostavljeno = 0 (niz na kome fakturisanje stvarno radi). */
  @IsOptional()
  @IsInt()
  @Min(0)
  companyId?: number;

  /** Zašto je broj promenjen — ulazi u trag izmene. */
  @IsOptional()
  @IsString()
  @MaxLength(300)
  note?: string;
}
