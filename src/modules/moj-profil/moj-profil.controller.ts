import { Controller, Get, Query, Req, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { PermissionsGuard } from "../../common/authz/permissions.guard";
import { RequirePermission } from "../../common/authz/require-permission.decorator";
import { PERMISSIONS } from "../../common/authz/permissions";
import { MojProfilService } from "./moj-profil.service";
import { AttendanceRangeQueryDto } from "./dto/moj-profil-query.dto";

interface AuthedRequest {
  user: { userId: number; email: string; role: string };
}

/**
 * Moj profil — 3.0 TALAS D, R1 read endpoints (MODULE_SPEC_pb_profil_podesavanja_30.md §3.2).
 * `profile.self` = SVAKI prijavljen (presuda §2.5); scope (email→employee) + row-odluke
 * sprovodi sy15 RLS/DEFINER kroz GUC (withUserRls). Agregator NEMA svoje tabele — čita tuđe
 * domene (G/Reversi/D) bez diranja tela deljenih RPC-ova (presuda D6). Mutacije (submit
 * GO/nadoknada/plaćeno, korekcija prisustva, „Upoznat sam", 360) su R2. Zaduženja (revers)
 * = reuse `/reversi/reports/my-issued|my-consumed` (§3.2 — bez novog endpointa ovde).
 */
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermission(PERMISSIONS.PROFILE_SELF)
@Controller({ path: "profile", version: "1" })
export class MojProfilController {
  constructor(private readonly profil: MojProfilService) {}

  @Get("me")
  me(@Req() req: AuthedRequest) {
    return this.profil.me(req.user.email);
  }

  @Get("summary")
  summary(@Req() req: AuthedRequest) {
    return this.profil.summary(req.user.email);
  }

  @Get("vacation")
  vacation(@Req() req: AuthedRequest) {
    return this.profil.vacation(req.user.email);
  }

  @Get("makeup-paid-leave")
  makeupAndPaidLeave(@Req() req: AuthedRequest) {
    return this.profil.makeupAndPaidLeave(req.user.email);
  }

  @Get("attendance")
  attendance(
    @Req() req: AuthedRequest,
    @Query() query: AttendanceRangeQueryDto,
  ) {
    return this.profil.attendance(req.user.email, query);
  }

  @Get("talks")
  talks(@Req() req: AuthedRequest) {
    return this.profil.talks(req.user.email);
  }

  @Get("expectations")
  expectations(@Req() req: AuthedRequest) {
    return this.profil.expectations(req.user.email);
  }

  @Get("position")
  position(@Req() req: AuthedRequest) {
    return this.profil.position(req.user.email);
  }

  @Get("company-values")
  companyValues(@Req() req: AuthedRequest) {
    return this.profil.companyValues(req.user.email);
  }

  @Get("colleagues-on-leave")
  colleaguesOnLeave(@Req() req: AuthedRequest) {
    return this.profil.colleaguesOnLeave(req.user.email);
  }
}
