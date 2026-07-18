import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { PermissionsGuard } from "../../common/authz/permissions.guard";
import { RequirePermission } from "../../common/authz/require-permission.decorator";
import { PERMISSIONS } from "../../common/authz/permissions";
import { EnergetikaService } from "./energetika.service";
import { SendCommandDto } from "./dto/send-command.dto";

interface AuthedRequest {
  user: { userId: number; email: string; role: string };
}

/**
 * Energetika / SCADA — 3.0 TALAS E, R1 read endpointi (MODULE_SPEC_scada_30.md §3).
 * Paritet žive 1.0 politike (9 politika, snapshot 12.07 — re-verifikovano 0 drift na
 * restore-izvoru): SELECT na svih 6 tabela = `scada_is_admin_or_management()`. Zato je
 * cela klasa `energetika.read` (SAMO admin+menadzment — NE viewer baseline; spec §2).
 *
 * KOMANDE (POST /commands insert + /commands/:id/cancel) = R2 (`energetika.control`,
 * per-metod override iznad klasnog `energetika.read`), semantika ZAMRZNUTA (spec §7).
 * Route ordering: statičke rute pre parametrizovanih, `:id`/`:siteKey` poslednje.
 */
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermission(PERMISSIONS.ENERGETIKA_READ)
@Controller({ path: "energetika", version: "1" })
export class EnergetikaController {
  constructor(private readonly energetika: EnergetikaService) {}

  @Get("sites")
  sites(@Req() req: AuthedRequest) {
    return this.energetika.sites(req.user.email);
  }

  @Get("snapshots")
  snapshots(@Req() req: AuthedRequest) {
    return this.energetika.snapshots(req.user.email);
  }

  @Get("snapshots/:siteKey")
  snapshotRow(@Req() req: AuthedRequest, @Param("siteKey") siteKey: string) {
    return this.energetika.snapshotRow(req.user.email, siteKey);
  }

  @Get("history/:siteKey")
  history(
    @Req() req: AuthedRequest,
    @Param("siteKey") siteKey: string,
    @Query("hours") hours?: string,
    @Query("system") system?: string,
  ) {
    return this.energetika.history(req.user.email, siteKey, hours, system);
  }

  @Get("alarms")
  alarms(@Req() req: AuthedRequest, @Query("active") active?: string) {
    // paritet fetchActiveAlarms: default aktivni; `?active=false` → svi (aktivni+očišćeni).
    return this.energetika.activeAlarms(req.user.email, active !== "false");
  }

  @Get("alarms/:siteKey")
  alarmHistory(
    @Req() req: AuthedRequest,
    @Param("siteKey") siteKey: string,
    @Query("limit") limit?: string,
  ) {
    return this.energetika.alarmHistory(req.user.email, siteKey, limit);
  }

  @Get("commands")
  commands(@Req() req: AuthedRequest, @Query("limit") limit?: string) {
    return this.energetika.recentCommands(req.user.email, limit);
  }

  @Get("commands/:id")
  command(@Req() req: AuthedRequest, @Param("id", ParseUUIDPipe) id: string) {
    return this.energetika.command(req.user.email, id);
  }

  // ---------- R2: komandni tok (control; semantika ZAMRZNUTA — spec §7) ----------

  /**
   * Pošalji komandu — INSERT `scada_commands` (`pending`) kroz withUserRls (RLS forsira
   * svoje ime + pending). BE NE dira PLC; bridge poluje i izvršava/odbija (allowlist).
   * 200 (paritet toka: FE odmah dobija red sa `id` i poll-uje status → cancel-on-timeout).
   */
  @Post("commands")
  @HttpCode(200)
  @RequirePermission(PERMISSIONS.ENERGETIKA_CONTROL)
  createCommand(@Req() req: AuthedRequest, @Body() dto: SendCommandDto) {
    return this.energetika.create(req.user.email, dto);
  }

  /**
   * Otkaži SVOJU pending komandu na timeout čekanja — DEFINER RPC `scada_cancel_command`
   * kroz withUserRls; vraća STVARNI status (`expired`/`applied`/…). 200 uvek (i „missing").
   */
  @Post("commands/:id/cancel")
  @HttpCode(200)
  @RequirePermission(PERMISSIONS.ENERGETIKA_CONTROL)
  cancelCommand(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.energetika.cancel(req.user.email, id);
  }
}
