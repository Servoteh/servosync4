import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { PermissionsGuard } from "../../common/authz/permissions.guard";
import { RequirePermission } from "../../common/authz/require-permission.decorator";
import { PERMISSIONS } from "../../common/authz/permissions";
import { NabavkaService } from "./nabavka.service";
import type { AuthUser } from "../auth/jwt.strategy";
import type { CreatePurchaseRequestDto } from "./dto/create-purchase-request.dto";

/**
 * NACRT — Nabavka (Traka B §B). Operativni tok (Nenad):
 *   preuzimaju i klikću administratori nabavke/prodaje + njihovi šefovi + admin;
 *   nabavka posle ODOBRAVA. Otud posebne permisije za approve.
 *
 *   GET  /api/v1/nabavka/requests                  — radna lista zahteva (status, projectId, paginacija)
 *   POST /api/v1/nabavka/requests                  — kreiraj zahtev (broj NNNN/god server)
 *   POST /api/v1/nabavka/requests/:id/submit       — DRAFT → SUBMITTED (inženjer)
 *   POST /api/v1/nabavka/requests/:id/approve       — SUBMITTED → APPROVED (nabavka)
 *   POST /api/v1/nabavka/requests/:id/send-rfq      — napravi + auto-mail upit dobavljaču (quick-win)
 *   POST /api/v1/nabavka/orders/:id/receive         — prijem robe (3-way match)
 *
 * Permisije: read=NABAVKA_READ, mutacije=NABAVKA_WRITE, odobravanje=NABAVKA_APPROVE.
 * (Nove permisije se PRVO dodaju u backend authz katalog, pa u frontend permissions.ts mirror.)
 */
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermission(PERMISSIONS.NABAVKA_READ)
@Controller({ path: "nabavka", version: "1" })
export class NabavkaController {
  constructor(private readonly nabavka: NabavkaService) {}

  @Get("requests")
  listRequests(
    @Query("status") status?: string,
    @Query("projectId") projectId?: string,
    @Query("skip") skip?: string,
    @Query("take") take?: string,
  ) {
    return this.nabavka.listRequests({
      status,
      projectId: projectId ? Number(projectId) : undefined,
      skip: skip ? Number(skip) : undefined,
      take: take ? Number(take) : undefined,
    });
  }

  @Post("requests")
  @RequirePermission(PERMISSIONS.NABAVKA_WRITE)
  createRequest(
    @Body() dto: CreatePurchaseRequestDto,
    @Req() req: { user: AuthUser },
  ) {
    return this.nabavka.createRequest(dto, req.user);
  }

  @Post("requests/:id/submit")
  @RequirePermission(PERMISSIONS.NABAVKA_WRITE)
  submit(
    @Param("id", ParseIntPipe) id: number,
    @Req() req: { user: AuthUser },
  ) {
    return this.nabavka.submitRequest(id, req.user);
  }

  @Post("requests/:id/approve")
  @RequirePermission(PERMISSIONS.NABAVKA_APPROVE)
  approve(
    @Param("id", ParseIntPipe) id: number,
    @Req() req: { user: AuthUser },
  ) {
    return this.nabavka.approveRequest(id, req.user);
  }

  @Post("requests/:id/send-rfq")
  @RequirePermission(PERMISSIONS.NABAVKA_WRITE)
  sendRfq(
    @Param("id", ParseIntPipe) id: number,
    @Body() body: { supplierId: number; supplierEmail: string },
    @Req() req: { user: AuthUser },
  ) {
    return this.nabavka.createAndSendRfq(
      id,
      body.supplierId,
      body.supplierEmail,
      req.user,
    );
  }

  @Post("orders/:id/receive")
  @RequirePermission(PERMISSIONS.NABAVKA_WRITE)
  receive(
    @Param("id", ParseIntPipe) id: number,
    @Body()
    body: { lines: Array<{ itemId: number; receivedQuantity?: number }> },
    @Req() req: { user: AuthUser },
  ) {
    return this.nabavka.receiveOrder(id, body.lines ?? [], req.user);
  }
}
