import {
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
} from "class-validator";

/**
 * DTO-ovi za Sistem/Podaci deo Podešavanja (Talas D):
 *  - P12a: izbor AI modela (Sastanci / Montaža) — setter kroz DEFINER RPC.
 *  - P7: grid urednici (kadr_grid_editor_allowlist) — add/remove.
 * Alowliste modela se re-validiraju i u servisu i u RPC-u (defense-in-depth).
 */

/** Postavi AI model (target = potrošač; model = allowlist string; servis+RPC re-validiraju). */
export class SetAiModelDto {
  // Talas AI-0 (stavka 7c): pored dva sy15 potrošača i zadaci koji žive samo u
  // registru `ai_model_policy` (chat + dva AI prolaza Zahteva).
  @IsIn([
    "sastanci",
    "montaza",
    "chat-claude",
    "zahtevi-triage",
    "zahtevi-analysis",
  ])
  target!:
    | "sastanci"
    | "montaza"
    | "chat-claude"
    | "zahtevi-triage"
    | "zahtevi-analysis";

  @IsString()
  @MaxLength(80)
  model!: string;
}

/** Dodaj grid urednika (email obavezan; note opciono). Duplikat → 409 u servisu. */
export class AddGridEditorDto {
  @IsEmail()
  @MaxLength(200)
  email!: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  note?: string;
}

/**
 * Dodaj primaoca obaveštenja o neusaglašenosti na montaži (034/26 — tabela
 * `montaza_nm_primaoci`). Aktivan duplikat → 409; ugašen red se reaktivira.
 */
export class AddNmPrimalacDto {
  @IsEmail()
  @MaxLength(200)
  email!: string;

  @IsOptional()
  @IsString()
  @MaxLength(150)
  fullName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  note?: string;
}
