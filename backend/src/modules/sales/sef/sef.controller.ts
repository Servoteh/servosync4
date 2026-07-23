import {
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../auth/jwt-auth.guard";
import { PermissionsGuard } from "../../../common/authz/permissions.guard";
import { RequirePermission } from "../../../common/authz/require-permission.decorator";
import { PERMISSIONS } from "../../../common/authz/permissions";
import { SefService } from "./sef.service";

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
 */
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermission(PERMISSIONS.SEF_READ)
@Controller({ path: "sef", version: "1" })
export class SefController {
  constructor(private readonly sef: SefService) {}

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

  @Post("enqueue/:invoiceId")
  @RequirePermission(PERMISSIONS.SEF_SEND)
  async enqueue(@Param("invoiceId", ParseIntPipe) invoiceId: number) {
    const { outbox, warning } = await this.sef.enqueue(invoiceId);
    return { data: outbox, warning };
  }

  @Post("send/:outboxId")
  @RequirePermission(PERMISSIONS.SEF_SEND)
  async send(@Param("outboxId", ParseIntPipe) outboxId: number) {
    const data = await this.sef.send(outboxId);
    return { data };
  }

  @Post("refresh/:outboxId")
  @RequirePermission(PERMISSIONS.SEF_READ)
  async refresh(@Param("outboxId", ParseIntPipe) outboxId: number) {
    const data = await this.sef.refreshStatus(outboxId);
    return { data };
  }

  @Post("cancel/:outboxId")
  @RequirePermission(PERMISSIONS.SEF_CANCEL)
  async cancel(@Param("outboxId", ParseIntPipe) outboxId: number) {
    const data = await this.sef.cancel(outboxId);
    return { data };
  }
}
