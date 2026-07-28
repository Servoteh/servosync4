import { Controller, Get, Param, ParseIntPipe, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { PermissionsGuard } from "../../common/authz/permissions.guard";
import { RequirePermission } from "../../common/authz/require-permission.decorator";
import { PERMISSIONS } from "../../common/authz/permissions";
import { TimeEstimateService } from "./time-estimate.service";

/**
 * TALAS AI-5 — statistička procena vremena operacija po radnom mestu (READ-ONLY).
 *   GET /api/v1/tehnologija/time-estimate/work-center/:code   — h/kom kvantili jednog RM
 *   GET /api/v1/tehnologija/time-estimate/drawing?crtez=…      — istorija istog crteža
 *   GET /api/v1/tehnologija/time-estimate/work-order/:id       — po-operaciji za nalog (FE panel)
 *
 * Klasa nosi `tehnologija.read` — isti gate kao alat `istorija_crteza` (procena
 * je uvid u tehnologiju/normative). Sve je čitanje glavne baze; ne menja normativ.
 */
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermission(PERMISSIONS.TEHNOLOGIJA_READ)
@Controller({ path: "tehnologija/time-estimate", version: "1" })
export class TimeEstimateController {
  constructor(private readonly estimate: TimeEstimateService) {}

  @Get("work-center/:code")
  byWorkCenter(@Param("code") code: string) {
    return this.estimate.byWorkCenter(code);
  }

  @Get("drawing")
  forDrawing(@Query("crtez") crtez: string) {
    return this.estimate.forDrawing(crtez ?? "");
  }

  @Get("work-order/:id")
  forWorkOrder(@Param("id", ParseIntPipe) id: number) {
    return this.estimate.forWorkOrder(id);
  }
}
