import { IsNumberString, IsOptional, IsString } from "class-validator";

/** Query DTO-i za Plan montaže read endpointe. */

export class ProjectsQueryDto {
  /** `tree` = stablo projekat→WP→faze (default; paritet 1.0, ali JEDNIM upitom — C8). */
  @IsOptional() @IsString() include?: string;
}

export class ReportsQueryDto {
  /** Filter po statusu izveštaja (zavrseno/delimicno/u_toku/…). */
  @IsOptional() @IsString() status?: string;
  /** Pretraga po 6 polja (broj/predmet/projekat/klijent/lokacija/autor) — paritet listIzvestaji. */
  @IsOptional() @IsString() q?: string;
  @IsOptional() @IsNumberString() limit?: string;
}

export class PredmetiLookupQueryDto {
  @IsOptional() @IsString() q?: string;
  /**
   * `1`/`true` = samo aktivni (status='U TOKU' ∧ datum_zakljucenja IS NULL).
   * DEFAULT (izostavljeno) = i ZATVORENI predmeti — paritet 1.0 montaža picker-a
   * (onlyActive:false; serviser vezuje izveštaj na zatvoren predmet).
   */
  @IsOptional() @IsString() onlyActive?: string;
}

export class DrawingsLookupQueryDto {
  /** CSV brojeva crteža za exists-check (bigtehn_drawings_cache). */
  @IsString() codes!: string;
}
