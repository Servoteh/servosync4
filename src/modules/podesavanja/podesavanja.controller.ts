import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { PermissionsGuard } from "../../common/authz/permissions.guard";
import { RequirePermission } from "../../common/authz/require-permission.decorator";
import { PERMISSIONS } from "../../common/authz/permissions";
import { PodesavanjaService } from "./podesavanja.service";
import {
  AuditLogQueryDto,
  ListUsersQueryDto,
} from "./dto/podesavanja-query.dto";

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
  constructor(private readonly settings: PodesavanjaService) {}

  // ----- Korisnici i pristup (settings.users) -----

  @Get("users")
  listUsers(@Req() req: AuthedRequest, @Query() query: ListUsersQueryDto) {
    return this.settings.listUsers(req.user.email, query);
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

  // ----- :id rute POSLEDNJE -----

  @Get("users/:id")
  findUser(@Req() req: AuthedRequest, @Param("id", ParseUUIDPipe) id: string) {
    return this.settings.findUser(req.user.email, id);
  }
}
