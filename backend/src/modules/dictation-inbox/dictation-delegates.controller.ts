import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { PermissionsGuard } from "../../common/authz/permissions.guard";
import { RequirePermission } from "../../common/authz/require-permission.decorator";
import { PERMISSIONS } from "../../common/authz/permissions";
import type { AuthUser } from "../auth/jwt.strategy";
import { DictationDelegatesService } from "./dictation-delegates.service";
import { CreateDictationDelegateDto } from "./dto/dictation-delegate.dto";

/**
 * Administracija delegacije diktafon „sandučeta":
 *   GET    /api/v1/dictation-delegates      — sve dozvole (mala tabela, bez paginacije)
 *   POST   /api/v1/dictation-delegates      — dodaj (idempotentno)
 *   DELETE /api/v1/dictation-delegates/:id  — ukloni
 *
 * Permisija = POSTOJEĆA `settings.users` (ista kao konzola korisnika u Podešavanjima).
 * NOVA permisija se namerno NE uvodi: dodela dozvole je po posledici isto što i
 * „daj ovom nalogu pristup tuđim porukama" — spada u administraciju naloga.
 *
 * Ruta je na TOP nivou (`/v1/dictation-delegates`), a ne pod `/v1/admin/...`, zbog
 * globalnog `AuditInterceptor`-a: on izvodi `entityType`/`entityId` iz segmenata
 * URL-a (`/api/v1/<resurs>/<id>`), pa ovako audit red glasi
 * `entity_type=dictation-delegates, entity_id=<id>` — pod `/admin/...` bi ispalo
 * `entity_type=admin, entity_id=dictation-delegates` (bezvredno).
 *
 * ALTERNATIVA BEZ HTTP-a: dozvola sme da se upiše i čistim SQL-om (vidi
 * `docs/design/MODULE_SPEC_diktafon.md`) — ove rute su udobnost, ne uslov.
 */
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermission(PERMISSIONS.SETTINGS_USERS)
@Controller({ path: "dictation-delegates", version: "1" })
export class DictationDelegatesController {
  constructor(private readonly delegates: DictationDelegatesService) {}

  @Get()
  list() {
    return this.delegates.list();
  }

  @Post()
  add(@Body() dto: CreateDictationDelegateDto, @Req() req: { user: AuthUser }) {
    return this.delegates.add(
      { userId: req.user.userId, email: req.user.email },
      dto,
    );
  }

  @Delete(":id")
  remove(@Param("id", ParseIntPipe) id: number) {
    return this.delegates.remove(id);
  }
}
