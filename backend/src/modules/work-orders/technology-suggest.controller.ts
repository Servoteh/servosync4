import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { PermissionsGuard } from "../../common/authz/permissions.guard";
import { RequirePermission } from "../../common/authz/require-permission.decorator";
import { PERMISSIONS } from "../../common/authz/permissions";
import { TechnologySuggestService } from "./technology-suggest.service";

/**
 * TALAS AI-6 — PREDLOG TEHNOLOGIJE IZ ISTORIJE CRTEŽA (READ-ONLY).
 *   GET /api/v1/tehnologija/suggest/drawing?crtez=…&osim=<rn_id>
 *     → reprezentativan ruting iz prošlih naloga tog crteža + stvarna vremena,
 *       ili jasan „nema istorije". `osim` izuzima TEKUĆI nalog iz osnove.
 *
 * `tehnologija.read` — isti gate kao AI-5 procena i alat `istorija_crteza`.
 * Predlog se NE upisuje: primena ide postojećim, potvrđenim tokom (Kopiraj iz
 * naloga) — ovde nema write puta.
 */
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermission(PERMISSIONS.TEHNOLOGIJA_READ)
@Controller({ path: "tehnologija/suggest", version: "1" })
export class TechnologySuggestController {
  constructor(private readonly suggest: TechnologySuggestService) {}

  @Get("drawing")
  forDrawing(@Query("crtez") crtez: string, @Query("osim") osim?: string) {
    const n = osim != null && osim !== "" ? Number(osim) : NaN;
    const exclude = Number.isInteger(n) && n > 0 ? n : undefined;
    return this.suggest.forDrawing(crtez ?? "", exclude);
  }
}
