import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
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
import { AddGridEditorDto, SetAiModelDto } from "./dto/podesavanja-system.dto";
import {
  BulkExpectationDto,
  CreateExpectationDto,
  UpdateCompanyProfileDto,
  UpdateExpectationDto,
} from "./dto/podesavanja-org.dto";
import {
  SetPredmetAktivacijaDto,
  SetPrioritetIdsDto,
  SetPrioritetMaxDto,
} from "./dto/podesavanja-predmet.dto";
import {
  BulkJobPositionProfileDto,
  CreateDepartmentDto,
  CreateJobPositionDto,
  CreateSubDepartmentDto,
  UpdateDepartmentDto,
  UpdateJobPositionDto,
  UpdateJobPositionProfileDto,
  UpdateSubDepartmentDto,
} from "./dto/podesavanja-org-crud.dto";
import {
  CreateCompetenceDto,
  CreateCompetenceGroupDto,
  CreateCompetenceQuestionDto,
  UpdateCompetenceDto,
  UpdateCompetenceGroupDto,
  UpdateCompetenceQuestionDto,
} from "./dto/podesavanja-competence.dto";

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

  // ----- P13 (#44): override migracija — bulk backfill sy15 user_roles → 2.0 (admin) -----
  // Idempotentno (ponovljivo). Guard = settings.users (klasni baseline). Literal path — bez
  // kolizije sa users/:id. Vraća {processed, overridesUpserted, scopesUpdated, skippedNoUser}.

  @Post("migrations/overrides-backfill")
  @HttpCode(200)
  overridesBackfill(@Req() req: AuthedRequest) {
    return this.users.backfillOverrides(req.user.email);
  }

  /** #52: sy15 email-allowliste (grid/GO urednici) → 2.0 override ogledalo (mirror;
   *  idempotentno — ponovljiv poziv konvergira). Guard = settings.users (baseline). */
  @Post("migrations/allowlist-overrides-backfill")
  @HttpCode(200)
  allowlistOverridesBackfill(@Req() req: AuthedRequest) {
    return this.users.backfillAllowlistOverrides(req.user.email);
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
  removeGridEditor(@Req() req: AuthedRequest, @Param("email") email: string) {
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

  // ----- P8: Organizacija CRUD (struktura = settings.users; opisi = settings.org_profile) -----
  // Struktura ID-jevi su INTEGER (ParseIntPipe). Route ordering: literali (`bulk-profile`) pre
  // `:id`; `:id/profile` je zaseban sufiks. RLS je autoritativan (admin za strukturu; org_profile
  // za opise) — guard je gruba kapija.

  @Post("org/departments")
  createDepartment(
    @Req() req: AuthedRequest,
    @Body() dto: CreateDepartmentDto,
  ) {
    return this.settings.createDepartment(req.user.email, dto);
  }

  @Patch("org/departments/:id")
  updateDepartment(
    @Req() req: AuthedRequest,
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: UpdateDepartmentDto,
  ) {
    return this.settings.updateDepartment(req.user.email, id, dto);
  }

  @Delete("org/departments/:id")
  deleteDepartment(
    @Req() req: AuthedRequest,
    @Param("id", ParseIntPipe) id: number,
  ) {
    return this.settings.deleteDepartment(req.user.email, id);
  }

  @Post("org/sub-departments")
  createSubDepartment(
    @Req() req: AuthedRequest,
    @Body() dto: CreateSubDepartmentDto,
  ) {
    return this.settings.createSubDepartment(req.user.email, dto);
  }

  @Patch("org/sub-departments/:id")
  updateSubDepartment(
    @Req() req: AuthedRequest,
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: UpdateSubDepartmentDto,
  ) {
    return this.settings.updateSubDepartment(req.user.email, id, dto);
  }

  @Delete("org/sub-departments/:id")
  deleteSubDepartment(
    @Req() req: AuthedRequest,
    @Param("id", ParseIntPipe) id: number,
  ) {
    return this.settings.deleteSubDepartment(req.user.email, id);
  }

  @Post("org/job-positions")
  createJobPosition(
    @Req() req: AuthedRequest,
    @Body() dto: CreateJobPositionDto,
  ) {
    return this.settings.createJobPosition(req.user.email, dto);
  }

  /** Bulk import opisa pozicija (org_profile). Literal `bulk-profile` MORA pre `:id` param-ruta. */
  @Post("org/job-positions/bulk-profile")
  @RequirePermission(PERMISSIONS.SETTINGS_ORG_PROFILE)
  bulkJobPositionProfiles(
    @Req() req: AuthedRequest,
    @Body() dto: BulkJobPositionProfileDto,
  ) {
    return this.settings.bulkJobPositionProfiles(req.user.email, dto);
  }

  /** Opis pozicije (4 md sekcije; org_profile). `:id/profile` sufiks — ne koliduje sa `:id`. */
  @Patch("org/job-positions/:id/profile")
  @RequirePermission(PERMISSIONS.SETTINGS_ORG_PROFILE)
  updateJobPositionProfile(
    @Req() req: AuthedRequest,
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: UpdateJobPositionProfileDto,
  ) {
    return this.settings.updateJobPositionProfile(req.user.email, id, dto);
  }

  @Patch("org/job-positions/:id")
  updateJobPosition(
    @Req() req: AuthedRequest,
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: UpdateJobPositionDto,
  ) {
    return this.settings.updateJobPosition(req.user.email, id, dto);
  }

  @Delete("org/job-positions/:id")
  deleteJobPosition(
    @Req() req: AuthedRequest,
    @Param("id", ParseIntPipe) id: number,
  ) {
    return this.settings.deleteJobPosition(req.user.email, id);
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

  // ----- P10: Kompetencije editor CRUD (admin = settings.users, klasni baseline) -----
  // GET framework je iznad (org_profile — čitanje). WRITE je admin-only (DB RLS
  // ALL=current_user_is_admin, autoritativan). ID-jevi INTEGER. Route ordering: `groups`/
  // `competences`/`questions` (literali) pre `:id`. `code` auto-generisan; nivoi upsert/delete.

  @Post("competence/groups")
  createCompetenceGroup(
    @Req() req: AuthedRequest,
    @Body() dto: CreateCompetenceGroupDto,
  ) {
    return this.settings.createCompetenceGroup(req.user.email, dto);
  }

  @Patch("competence/groups/:id")
  updateCompetenceGroup(
    @Req() req: AuthedRequest,
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: UpdateCompetenceGroupDto,
  ) {
    return this.settings.updateCompetenceGroup(req.user.email, id, dto);
  }

  @Delete("competence/groups/:id")
  deleteCompetenceGroup(
    @Req() req: AuthedRequest,
    @Param("id", ParseIntPipe) id: number,
  ) {
    return this.settings.deleteCompetenceGroup(req.user.email, id);
  }

  @Post("competence/competences")
  createCompetence(
    @Req() req: AuthedRequest,
    @Body() dto: CreateCompetenceDto,
  ) {
    return this.settings.createCompetence(req.user.email, dto);
  }

  @Patch("competence/competences/:id")
  updateCompetence(
    @Req() req: AuthedRequest,
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: UpdateCompetenceDto,
  ) {
    return this.settings.updateCompetence(req.user.email, id, dto);
  }

  @Delete("competence/competences/:id")
  deleteCompetence(
    @Req() req: AuthedRequest,
    @Param("id", ParseIntPipe) id: number,
  ) {
    return this.settings.deleteCompetence(req.user.email, id);
  }

  @Post("competence/questions")
  createCompetenceQuestion(
    @Req() req: AuthedRequest,
    @Body() dto: CreateCompetenceQuestionDto,
  ) {
    return this.settings.createCompetenceQuestion(req.user.email, dto);
  }

  @Patch("competence/questions/:id")
  updateCompetenceQuestion(
    @Req() req: AuthedRequest,
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: UpdateCompetenceQuestionDto,
  ) {
    return this.settings.updateCompetenceQuestion(req.user.email, id, dto);
  }

  @Delete("competence/questions/:id")
  deleteCompetenceQuestion(
    @Req() req: AuthedRequest,
    @Param("id", ParseIntPipe) id: number,
  ) {
    return this.settings.deleteCompetenceQuestion(req.user.email, id);
  }

  // ----- P9: org_profile WRITE (vrednosti firme + očekivanja admin) -----
  // Literal `expectations/bulk` MORA pre `expectations/:id` (route ordering).

  @Put("company-profile")
  @RequirePermission(PERMISSIONS.SETTINGS_ORG_PROFILE)
  updateCompanyProfile(
    @Req() req: AuthedRequest,
    @Body() dto: UpdateCompanyProfileDto,
  ) {
    return this.settings.updateCompanyProfile(req.user.email, dto);
  }

  @Post("expectations")
  @RequirePermission(PERMISSIONS.SETTINGS_ORG_PROFILE)
  createExpectation(
    @Req() req: AuthedRequest,
    @Body() dto: CreateExpectationDto,
  ) {
    return this.settings.createExpectation(req.user.email, dto);
  }

  @Post("expectations/bulk")
  @RequirePermission(PERMISSIONS.SETTINGS_ORG_PROFILE)
  bulkCreateExpectations(
    @Req() req: AuthedRequest,
    @Body() dto: BulkExpectationDto,
  ) {
    return this.settings.bulkCreateExpectations(req.user.email, dto);
  }

  @Patch("expectations/:id")
  @RequirePermission(PERMISSIONS.SETTINGS_ORG_PROFILE)
  updateExpectation(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: UpdateExpectationDto,
  ) {
    return this.settings.updateExpectation(req.user.email, id, dto);
  }

  /** Brisanje očekivanja — admin only (1.0 pravilo). Guard = settings.users (jedini admin-scalar
   *  ključ u settings domenu — coarse VIDLJIVOST); DB RLS DELETE=admin je autoritativan (42501→403). */
  @Delete("expectations/:id")
  @RequirePermission(PERMISSIONS.SETTINGS_USERS)
  deleteExpectation(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.settings.deleteExpectation(req.user.email, id);
  }

  // ----- Podaci / Sistem -----

  @Get("predmet-aktivacija")
  @RequirePermission(PERMISSIONS.SETTINGS_PREDMET_AKTIVACIJA)
  predmetAktivacija(@Req() req: AuthedRequest) {
    return this.settings.predmetAktivacija(req.user.email);
  }

  // ----- P11: predmet-aktivacija WRITE + ⭐ prioritet -----
  // `prioritet*` rute (literali) MORAJU pre `:itemId` (route ordering). RPC re-validira gate u DB.

  @Get("predmet-aktivacija/prioritet")
  @RequirePermission(PERMISSIONS.SETTINGS_PREDMET_AKTIVACIJA)
  predmetPrioritet(@Req() req: AuthedRequest) {
    return this.settings.predmetPrioritet(req.user.email);
  }

  @Get("predmet-aktivacija/prioritet/prev")
  @RequirePermission(PERMISSIONS.SETTINGS_PREDMET_AKTIVACIJA)
  predmetPrioritetPrev(@Req() req: AuthedRequest) {
    return this.settings.predmetPrioritetPrev(req.user.email);
  }

  @Put("predmet-aktivacija/prioritet/max")
  @RequirePermission(PERMISSIONS.SETTINGS_PREDMET_AKTIVACIJA)
  setPredmetPrioritetMax(
    @Req() req: AuthedRequest,
    @Body() dto: SetPrioritetMaxDto,
  ) {
    return this.settings.setPredmetPrioritetMax(req.user.email, dto.max);
  }

  @Put("predmet-aktivacija/prioritet")
  @RequirePermission(PERMISSIONS.SETTINGS_PREDMET_AKTIVACIJA)
  setPredmetPrioritet(
    @Req() req: AuthedRequest,
    @Body() dto: SetPrioritetIdsDto,
  ) {
    return this.settings.setPredmetPrioritet(req.user.email, dto.itemIds);
  }

  @Post("predmet-aktivacija/:itemId")
  @RequirePermission(PERMISSIONS.SETTINGS_PREDMET_AKTIVACIJA)
  setPredmetAktivacija(
    @Req() req: AuthedRequest,
    @Param("itemId") itemId: string,
    @Body() dto: SetPredmetAktivacijaDto,
  ) {
    return this.settings.setPredmetAktivacija(
      req.user.email,
      Number(itemId),
      dto,
    );
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
