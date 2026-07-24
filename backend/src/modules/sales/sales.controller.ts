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
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { PermissionsGuard } from "../../common/authz/permissions.guard";
import { RequirePermission } from "../../common/authz/require-permission.decorator";
import { PERMISSIONS } from "../../common/authz/permissions";
import { FakturisanjeService } from "./fakturisanje.service";
import { DocumentCarryOverService } from "./carry-over.service";
import { InvoicePdfService } from "./print/invoice-pdf.service";
import { InvoiceMailService } from "./print/invoice-mail.service";
import type { AuthUser } from "../auth/jwt.strategy";
import type { CreateProformaDto } from "./dto/create-proforma.dto";
import {
  type CreateInvoiceFromProformaDto,
  normalizeListInvoicesQuery,
} from "./dto/list-invoices.dto";
import {
  validateStornoInvoice,
  type StornoInvoiceDto,
} from "./dto/storno-invoice.dto";
import {
  type SendInvoiceMailDto,
  normalizeInvoiceMailTo,
  normalizeMailNote,
} from "./dto/send-invoice-mail.dto";

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
    private readonly invoicePdf: InvoicePdfService,
    private readonly invoiceMail: InvoiceMailService,
  ) {}

  /**
   * Štampa fakture kao PDF (BigBit paritet — dosad je print servis postojao bez rute).
   * variant: standardni/otpremnica/izvozni. Vraća application/pdf inline (browser preview
   * + download). Permisija SALES_READ (pregled/štampa).
   */
  @Get("invoices/:id/pdf")
  @Header("Content-Type", "application/pdf")
  async invoicePdfDownload(
    @Param("id", ParseIntPipe) id: number,
    @Query("variant") variant: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const { buffer, fileName } =
      variant === "delivery"
        ? await this.invoicePdf.buildDeliveryNotePdf(id)
        : variant === "export"
          ? await this.invoicePdf.buildExportInvoicePdf(id)
          : await this.invoicePdf.buildInvoicePdf(id);
    res.setHeader(
      "Content-Disposition",
      `inline; filename="${encodeURIComponent(fileName)}"`,
    );
    res.send(buffer);
  }

  /**
   * Pošalji fakturu kupcu mejlom sa PDF prilogom (BigBit paritet — zamena OSSMTP).
   * Telo `{ to?, note? }`: `to` je adresa primaoca (kad je prazna → email kupca sa
   * računa), `note` opciona propratna poruka. PDF se generiše istim `InvoicePdfService`
   * kao štampa, pa prilaže uz Resend mejl (`MailService`). Slanje NE baca (DRY-RUN kad
   * ključ fali) — vraća `{ data: { sent, to, fileName } }`. Permisija SALES_WRITE
   * (slanje računa kupcu je komercijalna radnja iznad pregleda/štampe).
   */
  @Post("invoices/:id/send-mail")
  @RequirePermission(PERMISSIONS.SALES_WRITE)
  async sendInvoiceMail(
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: SendInvoiceMailDto,
  ) {
    const to = normalizeInvoiceMailTo(dto.to);
    const note = normalizeMailNote(dto.note);
    const result = await this.invoiceMail.sendInvoice(id, to, undefined, note);
    return { data: result };
  }

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
    @Body() body: { force?: boolean } | undefined,
    @Req() req: { user: AuthUser },
  ) {
    // T3/A8: telo { force: true } preskače kreditni-limit guard (svesno knjiženje
    // uprkos prekoračenju limita) — FAKTURISANJE post permisija je dovoljna.
    return this.fakturisanje.postInvoice(id, req.user, body?.force === true);
  }

  /**
   * Storno proknjižene fakture (A5). Telo `{ reason }` — razlog OBAVEZAN. D8: storno je
   * jedini put koji sme da dira zaključan dokument (isLocked guard mutacija ga propušta).
   * Tok: status → CANCELLED + reverse GL naloga + SEF cancel (SENT/DELIVERED outbox).
   * Permisija SALES_POST (storno je knjigovodstvena radnja ranga knjiženja).
   */
  @Post("invoices/:id/storno")
  @RequirePermission(PERMISSIONS.SALES_POST)
  storno(
    @Param("id", ParseIntPipe) id: number,
    @Body() body: StornoInvoiceDto,
    @Req() req: { user: AuthUser },
  ) {
    const reason = validateStornoInvoice(body ?? {});
    return this.fakturisanje.stornoInvoice(id, reason, req.user);
  }
}
