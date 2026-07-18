import { IsIn, IsOptional, IsString, MaxLength } from "class-validator";

/** Multipart polja uz `/ai/stt` (audio je fajl `audio`). */
export class SttMetaDto {
  /** ISO-639-1 (default sr). */
  @IsOptional() @IsString() @MaxLength(5) lang?: string;
  /** Prompt-profil za Whisper: 'chat' (razgovor) ili 'zapisnik' (tehnicki). */
  @IsOptional() @IsIn(["chat", "zapisnik"]) context?: string;
}

/** `/ai/refine` — sirov tekst + profil dokumenta. */
export class RefineDto {
  @IsString() @MaxLength(8000) tekst!: string;

  @IsOptional()
  @IsIn([
    "montaza_opis",
    "montaza_problem",
    "montaza_napomena",
    "zapisnik",
    "zadatak",
    "napomena",
  ])
  profil?: string;
}
