import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
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
import { MojProfilService } from "./moj-profil.service";
import {
  AttendanceRangeQueryDto,
  DeleteHoursRemarkQueryDto,
  MonthlyHoursQueryDto,
} from "./dto/moj-profil-query.dto";
import {
  AckDocumentDto,
  OpenSelfAssessmentDto,
  ReviseVacationDto,
  SaveHoursRemarkDto,
  SaveSelfAnswersDto,
  SaveSelfScoresDto,
  SubmitCorrectionDto,
  SubmitMakeupDto,
  SubmitPaidLeaveDto,
  SubmitSelfAssessmentDto,
  SubmitVacationDto,
} from "./dto/moj-profil-mutation.dto";

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

  /** Mesečni sati (dnevna tabela + praznici + chips + karnet totals + postojeća primedba). */
  @Get("hours")
  hours(@Req() req: AuthedRequest, @Query() query: MonthlyHoursQueryDto) {
    return this.profil.monthlyHours(req.user.email, query);
  }

  // ==========================================================================
  // R2 — MUTACIJE (self-service; guard = profile.self; row-odluka = sy15 RLS/DEFINER kroz GUC)
  // Sve zove POSTOJEĆE G-RPC-ove (potpisi netaknuti — D6). Route ordering: literali pre :id.
  // ==========================================================================

  // ---------- GO zahtevi ----------

  @Post("vacation-requests")
  submitVacation(@Req() req: AuthedRequest, @Body() dto: SubmitVacationDto) {
    return this.profil.submitVacation(req.user.email, dto);
  }

  @Post("vacation-requests/:id/revise")
  reviseVacation(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: ReviseVacationDto,
  ) {
    return this.profil.reviseVacation(req.user.email, id, dto);
  }

  @Post("vacation-requests/:id/cancel")
  cancelVacation(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.profil.cancelVacation(req.user.email, id);
  }

  @Delete("vacation-requests/:id")
  deleteVacation(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.profil.deleteVacation(req.user.email, id);
  }

  // ---------- Nadoknada sati ----------

  @Post("makeup")
  submitMakeup(@Req() req: AuthedRequest, @Body() dto: SubmitMakeupDto) {
    return this.profil.submitMakeup(req.user.email, dto);
  }

  @Delete("makeup/:id")
  deleteMakeup(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.profil.deleteMakeup(req.user.email, id);
  }

  // ---------- Plaćeno odsustvo ----------

  @Post("paid-leave")
  submitPaidLeave(@Req() req: AuthedRequest, @Body() dto: SubmitPaidLeaveDto) {
    return this.profil.submitPaidLeave(req.user.email, dto);
  }

  @Delete("paid-leave/:id")
  deletePaidLeave(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.profil.deletePaidLeave(req.user.email, id);
  }

  // ---------- Prisustvo korekcija ----------

  @Post("attendance/corrections")
  submitCorrection(
    @Req() req: AuthedRequest,
    @Body() dto: SubmitCorrectionDto,
  ) {
    return this.profil.submitAttendanceCorrection(req.user.email, dto);
  }

  // ---------- Mesečni sati — primedba (self upsert/delete) ----------

  /** Upsert primedbe za mesec (prazan text + postojeći red = brisanje; status→'open'). */
  @Put("hours/remark")
  saveHoursRemark(@Req() req: AuthedRequest, @Body() dto: SaveHoursRemarkDto) {
    return this.profil.saveHoursRemark(req.user.email, dto);
  }

  /** Obriši mesečnu primedbu (year+month iz query-ja). */
  @Delete("hours/remark")
  deleteHoursRemark(
    @Req() req: AuthedRequest,
    @Query() query: DeleteHoursRemarkQueryDto,
  ) {
    return this.profil.deleteHoursRemark(
      req.user.email,
      query.year,
      query.month,
    );
  }

  // ---------- e-saglasnost / „Upoznat sam" ----------

  @Get("acks")
  acks(@Req() req: AuthedRequest) {
    return this.profil.acks(req.user.email);
  }

  @Post("acks")
  ackDocument(@Req() req: AuthedRequest, @Body() dto: AckDocumentDto) {
    return this.profil.ackDocument(req.user.email, dto);
  }

  // ---------- Razgovori — „Upoznat sam" (potvrda zapisnika razgovora) ----------

  @Post("talks/:id/acknowledge")
  acknowledgeTalk(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.profil.acknowledgeTalk(req.user.email, id);
  }

  // ---------- 360 samoprocena ----------

  @Post("assessment/self/open")
  openSelfAssessment(
    @Req() req: AuthedRequest,
    @Body() dto: OpenSelfAssessmentDto,
  ) {
    return this.profil.openSelfAssessment(req.user.email, dto);
  }

  @Post("assessment/self/scores")
  saveSelfScores(@Req() req: AuthedRequest, @Body() dto: SaveSelfScoresDto) {
    return this.profil.saveSelfScores(req.user.email, dto);
  }

  @Post("assessment/self/answers")
  saveSelfAnswers(@Req() req: AuthedRequest, @Body() dto: SaveSelfAnswersDto) {
    return this.profil.saveSelfAnswers(req.user.email, dto);
  }

  @Post("assessment/self/submit")
  submitSelfAssessment(
    @Req() req: AuthedRequest,
    @Body() dto: SubmitSelfAssessmentDto,
  ) {
    return this.profil.submitSelfAssessment(req.user.email, dto);
  }
}
