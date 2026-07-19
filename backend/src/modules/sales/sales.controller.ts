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
import { FakturisanjeService } from "./fakturisanje.service";
import { DocumentCarryOverService } from "./carry-over.service";
import type { AuthUser } from "../auth/jwt.strategy";
import type { CreateProformaDto } from "./dto/create-proforma.dto";
import {
  type CreateInvoiceFromProformaDto,
  normalizeListInvoicesQuery,
} from "./dto/list-invoices.dto";

/**
 * Sales / Fakturisanje (Faza 5 §A). Izlazni računi nad Invoice (tip + level).
 *
 *   GET  /api/v1/sales/invoices                       — lista računa/predračuna
 *   GET  /api/v1/sales/invoices/:id                   — detalj
 *   POST /api/v1/sales/proformas                      — kreiraj predračun/ponudu (PON/PROF, level 250)
 *   POST /api/v1/sales/invoices/:id/from-proforma     — carry-over PROF → IFR/… (level 0 draft)
 *   POST /api/v1/sales/invoices/:id/post              — knjiženje (rezerviši broj + nalog GK)
 *
 * Permisije: read=SALES_READ, mutacije=SALES_WRITE, knjiženje=SALES_POST, odobrenje=SALES_APPROVE.
 */
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermission(PERMISSIONS.SALES_READ)
@Controller({ path: "sales", version: "1" })
export class SalesController {
  constructor(
    private readonly fakturisanje: FakturisanjeService,
    private readonly carryOver: DocumentCarryOverService,
  ) {}

  @Get("invoices")
  listInvoices(
    @Query()
    query: {
      documentType?: string;
      status?: string;
      level?: string;
      customerId?: string;
      companyId?: string;
      isExport?: string;
      skip?: string;
      take?: string;
    },
  ) {
    return this.fakturisanje.listInvoices(normalizeListInvoicesQuery(query));
  }

  @Get("invoices/:id")
  getInvoice(@Param("id", ParseIntPipe) id: number) {
    return this.fakturisanje.getInvoice(id);
  }

  @Post("proformas")
  @RequirePermission(PERMISSIONS.SALES_WRITE)
  createProforma(
    @Body() dto: CreateProformaDto,
    @Req() req: { user: AuthUser },
  ) {
    return this.fakturisanje.createProforma(dto, req.user);
  }

  @Post("invoices/:id/from-proforma")
  @RequirePermission(PERMISSIONS.SALES_WRITE)
  fromProforma(
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: CreateInvoiceFromProformaDto,
  ) {
    return this.carryOver.createInvoiceFromProforma(id, dto.targetType);
  }

  @Post("invoices/:id/post")
  @RequirePermission(PERMISSIONS.SALES_POST)
  postInvoice(
    @Param("id", ParseIntPipe) id: number,
    @Req() req: { user: AuthUser },
  ) {
    return this.fakturisanje.postInvoice(id, req.user);
  }
}
