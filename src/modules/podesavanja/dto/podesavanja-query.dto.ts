import { IsBooleanString, IsOptional, IsString } from "class-validator";

/** Filteri liste korisnika (usersTab). */
export class ListUsersQueryDto {
  @IsOptional() @IsString() q?: string;
  @IsOptional() @IsString() role?: string;
  @IsOptional() @IsBooleanString() isActive?: string;
}

/** Audit log paginacija (v_settings_audit_log). */
export class AuditLogQueryDto {
  @IsOptional() @IsString() tableName?: string;
  @IsOptional() @IsString() page?: string;
  @IsOptional() @IsString() pageSize?: string;
}
