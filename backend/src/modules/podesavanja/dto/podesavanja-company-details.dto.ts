import { IsInt, IsOptional, IsPositive, IsString } from "class-validator";

/**
 * Matični podaci firme (`companies`) — memorandum i podaci za plaćanje koje štampa
 * svaki obrazac. Vidi `company-details.service.ts` za obrazloženje zašto je skup polja
 * namerno uzak (BigBit zastavice ponašanja se NE menjaju iz ove forme).
 *
 * SEMANTIKA: polje IZOSTAVLJENO (`undefined`) → ne dira se; `null`/prazan string →
 * briše se (papir tada taj red ne ispisuje).
 *
 * KLASA, NE INTERFEJS (ispravka 27.07.2026): globalni `ValidationPipe` u `main.ts`
 * validira isključivo klase sa `class-validator` dekoratorima — interfejs u runtime-u
 * ne postoji, pa je telo prolazilo netaknuto do servisa. `PUT /admin/firma` sa
 * `{"iban": 12345}` je zato padao na `v.replace is not a function` i vraćao 500
 * „Internal server error" umesto srpskog 422. Uz to `whitelist: true` sada odbacuje
 * nepoznata polja, pa se kroz ovu rutu ne mogu dohvatiti BigBit zastavice ponašanja.
 */
export class UpdateCompanyDetailsDto {
  /** Ako se ne prosledi, menja se primarna firma (najmanji id) — isti izbor kao štampe. */
  @IsOptional()
  @IsInt()
  @IsPositive()
  id?: number;

  @IsOptional()
  @IsString()
  companyName?: string | null;

  @IsOptional()
  @IsString()
  address?: string | null;

  @IsOptional()
  @IsString()
  city?: string | null;

  /**
   * Poštanski broj — ZASEBNO polje od mesta (odluka O-F10, 03.08.2026). Do tada je
   * `city` držao „11272 Dobanovci" kao jedan string, pa je poštanski broj izlazio i na
   * blokovima na kojima ga original nema (potpisni blok, adresa magacina).
   */
  @IsOptional()
  @IsString()
  postalCode?: string | null;

  @IsOptional()
  @IsString()
  municipality?: string | null;

  @IsOptional()
  @IsString()
  phone?: string | null;

  @IsOptional()
  @IsString()
  fax?: string | null;

  @IsOptional()
  @IsString()
  email?: string | null;

  @IsOptional()
  @IsString()
  webAddress?: string | null;

  /** PIB. */
  @IsOptional()
  @IsString()
  taxId?: string | null;

  /** Matični broj. */
  @IsOptional()
  @IsString()
  registrationNumber?: string | null;

  @IsOptional()
  @IsString()
  businessActivity?: string | null;

  @IsOptional()
  @IsString()
  businessActivityCode?: string | null;

  /** Tekući račun (domaći) — ispisuje se u zaglavlju svakog dokumenta. */
  @IsOptional()
  @IsString()
  bankAccount?: string | null;

  /** IBAN za ino plaćanje; čuva se bez razmaka, proverava se MOD-97. */
  @IsOptional()
  @IsString()
  iban?: string | null;

  /** SWIFT/BIC, 8 ili 11 znakova (ISO 9362). */
  @IsOptional()
  @IsString()
  swift?: string | null;

  /** Odgovorno lice / vlasnik (potpisni blok, KEP „Odgovorno lice"). */
  @IsOptional()
  @IsString()
  owner?: string | null;

  /** Mesto izdavanja računa. */
  @IsOptional()
  @IsString()
  invoiceIssuingPlace?: string | null;

  /** Tekst u podnožju memoranduma. */
  @IsOptional()
  @IsString()
  footerText?: string | null;
}
