import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { Response } from "express";
import { JwtAuthGuard } from "../../auth/jwt-auth.guard";
import type { AuthUser } from "../../auth/jwt.strategy";
import { PermissionsGuard } from "../../../common/authz/permissions.guard";
import { RequirePermission } from "../../../common/authz/require-permission.decorator";
import { PERMISSIONS } from "../../../common/authz/permissions";
import { SefService } from "./sef.service";
import { SefIncomingService } from "./sef-incoming.service";
import { SefPrintService } from "./sef-print.service";
import {
  normalizeListSefIncomingQuery,
  validatePullSefIncoming,
  validateRejectSefIncoming,
  type PullSefIncomingDto,
  type RejectSefIncomingDto,
} from "./dto/sef-incoming.dto";

/**
 * SEF e-fakture (izlazne) — Faza 5 §B. RBAC (doc 07 §9.1): pregled = admin
 * nabavke/prodaje + šefovi; slanje/storno = prodaja. Ovde grubi guard
 * (SEF_READ/SEND/CANCEL); row-politika (firma/prodavac) uz auth roljne kasnije.
 *
 *   POST /api/v1/sef/enqueue/:invoiceId  — sagradi UBL + kreiraj outbox (PENDING)
 *   POST /api/v1/sef/send/:outboxId      — pošalji UBL na SEF (idempotencija requestId)
 *   GET  /api/v1/sef/outbox              — lista outbox-a (filter status/invoiceId)
 *   POST /api/v1/sef/refresh/:outboxId   — poll status sa SEF-a
 *   POST /api/v1/sef/cancel/:outboxId    — storno/otkazivanje (guard MozeDaSeStornira)
 *
 * ULAZNE (purchase) fakture — SEF ulazni tok (doc 07 §5):
 *   GET  /api/v1/sef/incoming             — lista (filter status/deadlineSoon), rok 15 dana
 *   POST /api/v1/sef/incoming/pull        — povuci nove sa SEF-a (ids → xml → parse → dedup)
 *   POST /api/v1/sef/incoming/:id/accept  — prihvati (SEF poziv pre commit-a)
 *   POST /api/v1/sef/incoming/:id/reject  — odbij (razlog obavezan)
 */
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermission(PERMISSIONS.SEF_READ)
@Controller({ path: "sef", version: "1" })
export class SefController {
  constructor(
    private readonly sef: SefService,
    private readonly incoming: SefIncomingService,
    private readonly print: SefPrintService,
  ) {}

  /**
   * ŠTAMPA IZLAZNE e-FAKTURE — ljudski čitljiv prikaz UBL-a koji je poslat na SEF.
   * Do sada se poslati dokument mogao videti samo kao XML u bazi. Vraća
   * `application/pdf` inline. Permisija SEF_READ (kao ostale read rute modula).
   */
  @Get("outbox/:id/pdf")
  @RequirePermission(PERMISSIONS.SEF_READ)
  @Header("Content-Type", "application/pdf")
  async outboxPdf(
    @Param("id", ParseIntPipe) id: number,
    @Req() req: { user?: AuthUser },
    @Res() res: Response,
  ): Promise<void> {
    const doc = await this.print.buildOutboundPdf(id, {
      printedBy: req.user?.email ?? null,
    });
    res.setHeader(
      "Content-Disposition",
      `inline; filename="${encodeURIComponent(doc.fileName)}"`,
    );
    res.send(doc.buffer);
  }

  /**
   * ŠTAMPA ULAZNE e-FAKTURE — čitljiv prikaz UBL-a primljenog sa SEF-a, sa
   * istaknutim zakonskim rokom od 15 dana za prihvatanje/odbijanje.
   * Permisija SEF_READ.
   */
  @Get("incoming/:id/pdf")
  @RequirePermission(PERMISSIONS.SEF_READ)
  @Header("Content-Type", "application/pdf")
  async incomingPdf(
    @Param("id", ParseIntPipe) id: number,
    @Req() req: { user?: AuthUser },
    @Res() res: Response,
  ): Promise<void> {
    const doc = await this.print.buildIncomingPdf(id, {
      printedBy: req.user?.email ?? null,
    });
    res.setHeader(
      "Content-Disposition",
      `inline; filename="${encodeURIComponent(doc.fileName)}"`,
    );
    res.send(doc.buffer);
  }

  @Get("outbox")
  async listOutbox(
    @Query("status") status?: string,
    @Query("invoiceId") invoiceId?: string,
    @Query("skip") skip?: string,
    @Query("take") take?: string,
  ) {
    const data = await this.sef.listOutbox({
      status: status || undefined,
      invoiceId: invoiceId ? Number(invoiceId) : undefined,
      skip: skip ? Number(skip) : undefined,
      take: take ? Number(take) : undefined,
    });
    return { data };
  }

  /**
   * Status-istorija (timeline) jednog SEF reda — izlaznog (outboxId) ili ulaznog
   * (incomingId). Hronološki (najstariji prvo). Permisija SEF_READ.
   */
  @Get("status-log")
  @RequirePermission(PERMISSIONS.SEF_READ)
  async statusLog(
    @Query("outboxId") outboxId?: string,
    @Query("incomingId") incomingId?: string,
  ) {
    const data = await this.sef.listStatusLog({
      outboxId: outboxId ? Number(outboxId) : undefined,
      incomingId: incomingId ? Number(incomingId) : undefined,
    });
    return { data };
  }

  @Post("enqueue/:invoiceId")
  @RequirePermission(PERMISSIONS.SEF_SEND)
  async enqueue(
    @Param("invoiceId", ParseIntPipe) invoiceId: number,
    @Req() req: { user: AuthUser },
  ) {
    const { outbox, warning } = await this.sef.enqueue(
      invoiceId,
      req.user.userId,
    );
    return { data: outbox, warning };
  }

  @Post("send/:outboxId")
  @RequirePermission(PERMISSIONS.SEF_SEND)
  async send(
    @Param("outboxId", ParseIntPipe) outboxId: number,
    @Req() req: { user: AuthUser },
  ) {
    const data = await this.sef.send(outboxId, req.user.userId);
    return { data };
  }

  @Post("refresh/:outboxId")
  @RequirePermission(PERMISSIONS.SEF_READ)
  async refresh(
    @Param("outboxId", ParseIntPipe) outboxId: number,
    @Req() req: { user: AuthUser },
  ) {
    const data = await this.sef.refreshStatus(outboxId, req.user.userId);
    return { data };
  }

  @Post("cancel/:outboxId")
  @RequirePermission(PERMISSIONS.SEF_CANCEL)
  async cancel(
    @Param("outboxId", ParseIntPipe) outboxId: number,
    @Req() req: { user: AuthUser },
  ) {
    const data = await this.sef.cancel(outboxId, undefined, req.user.userId);
    return { data };
  }

  // ── Ulazne (purchase) fakture ──────────────────────────────────────────────

  @Get("incoming")
  @RequirePermission(PERMISSIONS.SEF_READ)
  async listIncoming(
    @Query("status") status?: string,
    @Query("deadlineSoon") deadlineSoon?: string,
  ) {
    const q = normalizeListSefIncomingQuery({ status, deadlineSoon });
    const data = await this.incoming.list(q);
    return { data };
  }

  @Post("incoming/pull")
  @RequirePermission(PERMISSIONS.SEF_SEND)
  async pullIncoming(@Body() body: PullSefIncomingDto) {
    const dto = body ?? {};
    validatePullSefIncoming(dto);
    const data = await this.incoming.pull(dto.dateFrom);
    return { data };
  }

  @Post("incoming/:id/accept")
  @RequirePermission(PERMISSIONS.SEF_SEND)
  async acceptIncoming(
    @Param("id", ParseIntPipe) id: number,
    @Req() req: { user: AuthUser },
  ) {
    const r = await this.incoming.accept(id, req.user.userId);
    return { data: r.invoice, dryRun: r.dryRun, note: r.note };
  }

  @Post("incoming/:id/reject")
  @RequirePermission(PERMISSIONS.SEF_SEND)
  async rejectIncoming(
    @Param("id", ParseIntPipe) id: number,
    @Body() body: RejectSefIncomingDto,
    @Req() req: { user: AuthUser },
  ) {
    const comment = validateRejectSefIncoming(body ?? { comment: "" });
    const r = await this.incoming.reject(id, comment, req.user.userId);
    return { data: r.invoice, dryRun: r.dryRun, note: r.note };
  }
}
