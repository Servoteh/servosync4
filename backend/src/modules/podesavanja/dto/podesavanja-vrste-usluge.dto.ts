import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
} from "class-validator";
import { TAX_TREATMENTS } from "../../sales/service-revenue-type";

/**
 * DTO-ovi za ekran „Vrste usluge" (šifarnik `service_revenue_types`, nalaz P10).
 *
 * ⚠️ Spisak dozvoljenih poreskih tretmana se NE prekucava ovde nego se uvozi iz
 * `sales/service-revenue-type.ts` — isti skup koji poznaje računica PDV-a, koji čuva DB
 * CHECK i koji ekran nudi u padajućoj listi. Prekucan spisak bi se razišao prvog dana
 * kad se doda četvrti tretman: DTO bi ga odbijao, a knjiženje bi ga očekivalo.
 */
const TREATMENTS = [...TAX_TREATMENTS];

/** Nova vrsta usluge — sva obavezna polja moraju biti tu. */
export class CreateServiceRevenueTypeDto {
  /** Šifra (velika slova, cifre, crtica) — jedinstvena; posle se NE menja. */
  @IsString()
  @MaxLength(20)
  code!: string;

  /** Naziv koji komercijala vidi na padajućoj listi — bez konta u tekstu. */
  @IsString()
  @MaxLength(100)
  name!: string;

  /** Konto prihoda; servis proverava da POSTOJI u `accounts` (meki ref, bez FK). */
  @IsString()
  @MaxLength(10)
  revenueAccountCode!: string;

  /** Ko obračunava PDV — izbor sa liste, nikad slobodan tekst. */
  @IsIn(TREATMENTS)
  vatTreatment!: string;

  /** Napomena za papir; prazno = nema (obrazac pada na rezervni tekst). */
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  paperNote?: string | null;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsInt()
  sortOrder?: number;
}

/**
 * Izmena zatečene vrste — polje koje nije poslato se NE dira.
 * `code` se sme poslati (ekran ga šalje kao deo forme) ali se ne sme PROMENITI;
 * servis odbija izmenu uz objašnjenje šta da se uradi umesto toga.
 */
export class UpdateServiceRevenueTypeDto {
  @IsOptional()
  @IsString()
  @MaxLength(20)
  code?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(10)
  revenueAccountCode?: string;

  @IsOptional()
  @IsIn(TREATMENTS)
  vatTreatment?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  paperNote?: string | null;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsInt()
  sortOrder?: number;
}
