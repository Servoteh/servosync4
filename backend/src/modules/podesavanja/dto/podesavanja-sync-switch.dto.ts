import { IsBoolean, IsOptional, IsString, MaxLength } from "class-validator";

/**
 * Prekidač noćnog BigBit uvoza (stavka B). `enabled` je jedino obavezno polje —
 * `note` je slobodan tekst „zašto je ugašeno" koji se prikazuje uz prekidač,
 * da se posle mesec dana zna ko ga je i zbog čega isključio.
 */
export class SetSyncSwitchDto {
  @IsBoolean()
  enabled!: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
