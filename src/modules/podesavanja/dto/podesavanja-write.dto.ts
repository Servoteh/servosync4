import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from "class-validator";

/**
 * DTO-ovi dvostranog upravljanja nalozima (Talas D / D1, MODULE_SPEC §3.3, docs/design/
 * D1_DUAL_ACCOUNT_WRITE.md). Rola se dodatno validira `isKnownRole()` u servisu (default-deny;
 * BACKEND_RULES §2 — bez DB CHECK-a, katalog je izvor istine). `clientEventId` je opcioni
 * idempotency/audit ključ; stvarna idempotencija su prirodni ključevi (email/userId+role).
 */

/** Zajednička override + scope polja (paritet 1.0 user_roles kolone). */
class UserRbacFieldsDto {
  @IsOptional() @IsString() @MaxLength(150) fullName?: string;
  @IsOptional() @IsString() @MaxLength(100) team?: string;
  /** project_id (per-projekat pm/leadpm scope); null/izostavljeno = global. */
  @IsOptional() @IsUUID() projectId?: string | null;
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @IsInt({ each: true })
  managedSubDepartmentIds?: number[] | null;
  /** D2: → deny `plan_montaze.write`. */
  @IsOptional() @IsBoolean() planMontazeReadonly?: boolean;
  /** D2: → grant `kadrovska.access`. */
  @IsOptional() @IsBoolean() kadrovskaAccess?: boolean;
  /** D2: → deny `kadrovska.contracts_read`. */
  @IsOptional() @IsBoolean() kadrovskaHideContracts?: boolean;
}

/** POST /admin/users/invite — nov nalog (GoTrue + sy15 user_roles + 2.0 users/roles/overrides). */
export class InviteUserDto extends UserRbacFieldsDto {
  @IsEmail() @MaxLength(255) email!: string;
  @IsString() @MaxLength(30) role!: string;
  /** Opciona zadata lozinka; ako izostane — server generiše nasumičnu (korisnik je resetuje sam). */
  @IsOptional() @IsString() @MaxLength(200) password?: string;
  @IsOptional() @IsUUID() clientEventId?: string;
}

/** PATCH /admin/users/:id — izmena postojećeg (rola/scope/override/aktivnost/must_change). */
export class UpdateUserDto extends UserRbacFieldsDto {
  @IsOptional() @IsString() @MaxLength(30) role?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
  @IsOptional() @IsBoolean() mustChangePassword?: boolean;
  @IsOptional() @IsUUID() clientEventId?: string;
}

/** POST /admin/users/:id/reset-password — GoTrue reset + must_change flag (oba sveta). */
export class ResetPasswordDto {
  @IsOptional() @IsString() @MaxLength(200) password?: string;
}

/** POST /admin/users/:id/must-change-password — postavi/skini force-change flag. */
export class SetMustChangePasswordDto {
  @IsBoolean() value!: boolean;
}

/** DELETE /admin/users/:id — SOFT deactivate uz eksplicitnu email-potvrdu (NE hard delete). */
export class DeleteUserDto {
  @IsEmail() @MaxLength(255) confirmEmail!: string;
}
