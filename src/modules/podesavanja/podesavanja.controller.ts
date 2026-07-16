import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { PermissionsGuard } from "../../common/authz/permissions.guard";
import { RequirePermission } from "../../common/authz/require-permission.decorator";
import { PERMISSIONS } from "../../common/authz/permissions";
import { PodesavanjaService } from "./podesavanja.service";
import { PodesavanjaUsersService } from "./podesavanja-users.service";
import {
  AuditLogQueryDto,
  ListUsersQueryDto,
} from "./dto/podesavanja-query.dto";
import {
  DeleteUserDto,
  InviteUserDto,
  ResetPasswordDto,
  SetMustChangePasswordDto,
  UpdateUserDto,
} from "./dto/podesavanja-write.dto";
import {
  AddGridEditorDto,
  SetAiModelDto,
} from "./dto/podesavanja-system.dto";

interface AuthedRequest {
  user: { userId: number; email: string; role: string };
}

/**
 * Podešavanja (RBAC admin + matični + sistem) — 3.0 TALAS D, R1 READ endpoints (§3.3).
 * Klasa-baseline = `settings.users` (admin konzola); org_profile/predmet/audit/system se
 * override-uju per-endpoint (paritet 1.0 gate-ova §2.2). R1 je READ — invite/edit/reset
 * (dvostrani D1), overrides data-migracija (#44) i audit dvoizvor (D10) su R2. Row-odluke
 * (user_roles ALL=admin, audit SELECT=admin) sprovodi sy15 RLS kroz GUC (withUserRls).
 */
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermission(PERMISSIONS.SETTINGS_USERS)
@Controller({ path: "admin", version: "1" })
export class PodesavanjaController {
  constructor(
    private readonly settings: PodesavanjaService,
    private readonly users: PodesavanjaUsersService,
  ) {}

  // ----- Korisnici i pristup (settings.users) -----

  @Get("users")
  listUsers(@Req() req: AuthedRequest, @Query() query: ListUsersQueryDto) {
    return this.settings.listUsers(req.user.email, query);
  }

  // ----- Dvostrano upravljanje nalozima (D1 — R2, WRITE; docs/design/D1_DUAL_ACCOUNT_WRITE.md) -----
  // `:id` = sy15 `user_roles.id` (uuid) — isti ključ kao GET /admin/users/:id (R1 read).
  // Literal `users/invite` je pre param-ruta; sve nasleđuju klasnu permisiju settings.users.

  @Post("users/invite")
  invite(@Req() req: AuthedRequest, @Body() dto: InviteUserDto) {
    return this.users.invite(req.user.email, dto);
  }

  @Patch("users/:id")
  updateUser(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: UpdateUserDto,
  ) {
    return this.users.update(req.user.email, id, dto);
  }

  @Post("users/:id/reset-password")
  @HttpCode(200)
  resetPassword(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: ResetPasswordDto,
  ) {
    return this.users.resetPassword(req.user.email, id, dto);
  }

  @Post("users/:id/deactivate")
  @HttpCode(200)
  deactivateUser(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.users.deactivate(req.user.email, id);
  }

  @Post("users/:id/activate")
  @HttpCode(200)
  activateUser(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.users.activate(req.user.email, id);
  }

  @Post("users/:id/must-change-password")
  @HttpCode(200)
  mustChangePassword(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: SetMustChangePasswordDto,
  ) {
    return this.users.setMustChangePassword(req.user.email, id, dto);
  }

  @Delete("users/:id")
  softDeleteUser(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: DeleteUserDto,
  ) {
    return this.users.softDelete(req.user.email, id, dto);
  }

  @Get("roles/catalog")
  rolesCatalog() {
    return this.settings.rolesCatalog();
  }

  @Get("permissions/matrix")
  permissionsMatrix() {
    return this.settings.permissionsMatrix();
  }

  @Get("grid-editors")
  gridEditors(@Req() req: AuthedRequest) {
    return this.settings.gridEditors(req.user.email);
  }

  /** Dodaj grid urednika (email + note?). Duplikat → 409. Guard = settings.users (baseline). */
  @Post("grid-editors")
  addGridEditor(@Req() req: AuthedRequest, @Body() dto: AddGridEditorDto) {
    return this.settings.addGridEditor(req.user.email, dto.email, dto.note);
  }

  /** Ukloni grid urednika po email-u (nije uuid — bez ParseUUIDPipe). Literal `grid-editors`
   *  POST iznad ne koliduje (druga metoda); param `:email` je jedina :param ruta ovog prefiksa. */
  @Delete("grid-editors/:email")
  removeGridEditor(
    @Req() req: AuthedRequest,
    @Param("email") email: string,
  ) {
    return this.settings.removeGridEditor(req.user.email, email);
  }

  // ----- Organizacija: struktura (settings.users) -----

  @Get("org/structure")
  orgStructure(@Req() req: AuthedRequest) {
    return this.settings.orgStructure(req.user.email);
  }

  @Get("holidays")
  holidays(@Req() req: AuthedRequest) {
    return this.settings.holidays(req.user.email);
  }

  // ----- Organizacija: org_profile domen (settings.org_profile) -----

  @Get("company-profile")
  @RequirePermission(PERMISSIONS.SETTINGS_ORG_PROFILE)
  companyProfile(@Req() req: AuthedRequest) {
    return this.settings.companyProfile(req.user.email);
  }

  @Get("expectations")
  @RequirePermission(PERMISSIONS.SETTINGS_ORG_PROFILE)
  expectations(@Req() req: AuthedRequest) {
    return this.settings.expectations(req.user.email);
  }

  @Get("competence-framework")
  @RequirePermission(PERMISSIONS.SETTINGS_ORG_PROFILE)
  competenceFramework(@Req() req: AuthedRequest) {
    return this.settings.competenceFramework(req.user.email);
  }

  // ----- Podaci / Sistem -----

  @Get("predmet-aktivacija")
  @RequirePermission(PERMISSIONS.SETTINGS_PREDMET_AKTIVACIJA)
  predmetAktivacija(@Req() req: AuthedRequest) {
    return this.settings.predmetAktivacija(req.user.email);
  }

  @Get("audit-log")
  @RequirePermission(PERMISSIONS.SETTINGS_AUDIT)
  auditLog(@Req() req: AuthedRequest, @Query() query: AuditLogQueryDto) {
    return this.settings.auditLog(req.user.email, query);
  }

  @Get("system/ai-models")
  @RequirePermission(PERMISSIONS.SETTINGS_SYSTEM)
  aiModels(@Req() req: AuthedRequest) {
    return this.settings.aiModels(req.user.email);
  }

  @Put("system/ai-models")
  @RequirePermission(PERMISSIONS.SETTINGS_SYSTEM)
  setAiModel(@Req() req: AuthedRequest, @Body() dto: SetAiModelDto) {
    return this.settings.setAiModel(req.user.email, dto.target, dto.model);
  }

  // ----- :id rute POSLEDNJE -----

  @Get("users/:id")
  findUser(@Req() req: AuthedRequest, @Param("id", ParseUUIDPipe) id: string) {
    return this.settings.findUser(req.user.email, id);
  }
}
