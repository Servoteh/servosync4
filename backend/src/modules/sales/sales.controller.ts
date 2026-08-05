import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Param,
  ParseIntPipe,
  Patch,
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
import { SalesService } from "./sales.service";
import { ServiceRevenueTypeService } from "./service-revenue-type.service";
import { DocumentCarryOverService } from "./carry-over.service";
import { InvoicePdfService } from "./print/invoice-pdf.service";
import { InvoiceMailService } from "./print/invoice-mail.service";
import { AdvanceInvoiceService } from "./advance-invoice.service";
import type { CreateAdvanceInvoiceDto } from "./dto/advance-invoice.dto";
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
import type {
  CreateInvoiceItemDto,
  UpdateInvoiceHeaderDto,
  UpdateInvoiceItemDto,
} from "./dto/update-invoice.dto";

/**
 * Sales / Fakturisanje (Faza 5 §A). Izlazni računi nad Invoice (tip + level).
 *
 *   GET    /api/v1/sales/invoices                       — lista računa/predračuna
 *   GET    /api/v1/sales/invoices/:id                   — detalj
 *   POST   /api/v1/sales/proformas                      — kreiraj predračun/ponudu (PON/PROF, level 250)
 *   POST   /api/v1/sales/invoices/:id/from-proforma     — carry-over PROF → IFR/… (level 0 draft)
 *   POST   /api/v1/sales/invoices/:id/post              — knjiženje (rezerviši broj + nalog GK)
 *
 *   PATCH  /api/v1/sales/documents/:id                  — izmena zaglavlja nacrta
 *   POST   /api/v1/sales/documents/:id/items            — dodaj stavku
 *   PATCH  /api/v1/sales/documents/:id/items/:lineId    — izmeni stavku
 *   DELETE /api/v1/sales/documents/:id/items/:lineId    — obriši stavku
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
    private readonly advanceInvoice: AdvanceInvoiceService,
    private readonly sales: SalesService,
    private readonly serviceRevenueTypes: ServiceRevenueTypeService,
  ) {}

  // ── ŠIFARNIK VRSTA USLUGE ───────────────────────────────────────────────────

  /**
   * Vrste usluge za padajuću listu na uslužnom računu (`GET /v1/sales/service-revenue-types`).
   *
   * Vraća SAMO aktivne. Komercijala odavde bira ŠTA PRODAJE — konto prihoda i poreski
   * tretman stižu uz taj izbor i ne biraju se posebno (v. `service-revenue-type.ts`).
   * Zato ruta ide pod `SALES_READ`, a ne pod knjigovodstvenu permisiju: ovo je spisak
   * poslovnih situacija, ne kontni plan.
   *
   * Uređivanje šifarnika (dodavanje/gašenje vrste, izmena konta) je posao knjigovođe i
   * još nema svoj ekran — v. `docs/OTVORENI_POSLOVI.md`, odeljak P.
   */
  @Get("service-revenue-types")
  async listServiceRevenueTypes() {
    const data = await this.serviceRevenueTypes.listActive();
    return { data };
  }

  // ── IZMENA DOKUMENTA (nacrt) ────────────────────────────────────────────────
  // Dosad modul nije imao NIJEDNU rutu izmene: dokument je mogao da se napravi i
  // proknjiži, ali ne i da se ispravi. Sve četiri rute rade SAMO nad nacrtom —
  // proknjižen/zaključan dokument vraća 409 sa uputstvom (protivdokument/storno).
  //
  // Putanja je `documents/*` (dokument, ne samo račun — isti tok važi za ponudu,
  // predračun i revers), uz alias `invoices/*` radi doslednosti sa postojećim
  // rutama modula. Ista metoda, dva imena — bez dupliranja logike.

  /**
   * Izmena zaglavlja nacrta: datum, komitent, valuta, kursevi, rok plaćanja,
   * datum prometa, napomena, broj narudžbenice, poziv na broj, profil stavki
   * (`lineProfile`) i koeficijent cene (`priceCoefficient`).
   *
   * Koeficijent je PONOVLJIV (§8/O1): stavke pamte `baseUnitPrice`, a
   * `unitPrice = baseUnitPrice × koeficijent` se izvodi, pa dva ista poziva daju
   * isti dokument i povratak na 1 vraća polazne cene.
   */
  @Patch(["documents/:id", "invoices/:id"])
  @RequirePermission(PERMISSIONS.SALES_WRITE)
  async updateDocument(
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: UpdateInvoiceHeaderDto,
    @Req() req: { user: AuthUser },
  ) {
    const data = await this.sales.updateHeader(id, dto, req.user);
    return { data };
  }

  /** Dodaj stavku na nacrt (cena kroz PricingService; zbirovi se preračunavaju). */
  @Post(["documents/:id/items", "invoices/:id/items"])
  @RequirePermission(PERMISSIONS.SALES_WRITE)
  async addDocumentItem(
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: CreateInvoiceItemDto,
    @Req() req: { user: AuthUser },
  ) {
    const data = await this.sales.addItem(id, dto, req.user);
    return { data };
  }

  /**
   * Izmena stavke nacrta. Telo koje dira cenu (artikal/cena/rabat/kasa/PDV šifra)
   * ide ponovo kroz cenovnik; telo koje menja samo količinu/opis zadržava
   * dogovorenu cenu stavke.
   */
  @Patch(["documents/:id/items/:lineId", "invoices/:id/items/:lineId"])
  @RequirePermission(PERMISSIONS.SALES_WRITE)
  async updateDocumentItem(
    @Param("id", ParseIntPipe) id: number,
    @Param("lineId", ParseIntPipe) lineId: number,
    @Body() dto: UpdateInvoiceItemDto,
    @Req() req: { user: AuthUser },
  ) {
    const data = await this.sales.updateItem(id, lineId, dto, req.user);
    return { data };
  }

  /** Obriši stavku nacrta (preostale se prenumerišu, zbirovi se preračunavaju). */
  @Delete(["documents/:id/items/:lineId", "invoices/:id/items/:lineId"])
  @RequirePermission(PERMISSIONS.SALES_WRITE)
  async removeDocumentItem(
    @Param("id", ParseIntPipe) id: number,
    @Param("lineId", ParseIntPipe) lineId: number,
    @Req() req: { user: AuthUser },
  ) {
    const data = await this.sales.removeItem(id, lineId, req.user);
    return { data };
  }

  /**
   * Štampa fakture kao PDF (BigBit paritet — dosad je print servis postojao bez rute).
   * `variant` bira šablon:
   *   (izostavljen) — račun; za AVR se sam bira avansni obrazac
   *   `delivery`    — otpremnica (bez cena)
   *   `export`      — ino faktura (engleski)
   *   `advance`     — avansni račun (osnov avansa + stanje naplate)
   *   `credit-note` — knjižno odobrenje (vrednosni dokument, umanjenje)
   *   `debit-note`  — knjižno zaduženje (vrednosni dokument, uvećanje)
   * Vraća application/pdf inline (browser preview + download). Ime korisnika ide u
   * nogu kao trag štampe. Permisija SALES_READ (pregled/štampa).
   */
  @Get("invoices/:id/pdf")
  @Header("Content-Type", "application/pdf")
  async invoicePdfDownload(
    @Param("id", ParseIntPipe) id: number,
    @Query("variant") variant: string | undefined,
    @Res() res: Response,
    @Req() req: { user: AuthUser },
  ): Promise<void> {
    const printedBy = req.user?.email;
    const { buffer, fileName } =
      variant === "delivery"
        ? await this.invoicePdf.buildDeliveryNotePdf(id, printedBy)
        : variant === "export"
          ? await this.invoicePdf.buildExportInvoicePdf(id, printedBy)
          : variant === "advance"
            ? await this.invoicePdf.buildAdvanceInvoicePdf(id, printedBy)
            : variant === "credit-note"
              ? await this.invoicePdf.buildCreditNotePdf(id, printedBy)
              : variant === "debit-note"
                ? await this.invoicePdf.buildDebitNotePdf(id, printedBy)
                : await this.invoicePdf.buildInvoicePdf(
                    id,
                    undefined,
                    printedBy,
                  );
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

  // ── Avansni računi (Batch C) ────────────────────────────────────────────────
  // PDV obaveza po avansu nastaje NAPLATOM, ne izdavanjem — zato je knjiženje
  // vezano za `advance-invoices/:id/paid`, a ne za kreiranje AVR-a.

  /** Napravi avansni račun (AVR) iz predračuna. */
  @Post("advance-invoices")
  @RequirePermission(PERMISSIONS.SALES_WRITE)
  async createAdvanceInvoice(
    @Body() dto: CreateAdvanceInvoiceDto,
    @Req() req: { user: AuthUser },
  ) {
    const data = await this.advanceInvoice.createAdvanceInvoice(dto, req.user);
    return { data };
  }

  /** Naplata avansa → knjiži PDV obavezu po avansu. */
  @Post("advance-invoices/:id/paid")
  @RequirePermission(PERMISSIONS.SALES_POST)
  async markAdvancePaid(
    @Param("id", ParseIntPipe) id: number,
    @Body() body: { paidAt: string; amount: string | number },
    @Req() req: { user: AuthUser },
  ) {
    const data = await this.advanceInvoice.markAdvancePaid(
      { advanceInvoiceId: id, paidAt: body?.paidAt, amount: body?.amount },
      req.user,
    );
    return { data };
  }

  /**
   * Odbij naplaćen avans na konačnom (proknjiženom) računu.
   *
   * `amount` (BRUTO iznos OVE primene) je opcion — bez njega servis odbija ceo
   * preostali naplaćen avans. Bez njega je i DELIMIČNO odbijanje bilo nemoguće
   * kroz rutu: telo je bilo tipizirano samo sa `advanceInvoiceId`, pa je iznos
   * koji ekran pošalje tiho otpadao ovde i N:M podela avansa na više računa
   * (37.902 → 20.802 + 17.100) nije mogla da prođe ni jednim putem osim direktnog
   * poziva servisa.
   */
  @Post("invoices/:id/apply-advance")
  @RequirePermission(PERMISSIONS.SALES_POST)
  async applyAdvance(
    @Param("id", ParseIntPipe) id: number,
    @Body() body: { advanceInvoiceId: number; amount?: string | number },
    @Req() req: { user: AuthUser },
  ) {
    const data = await this.advanceInvoice.applyAdvance(
      {
        invoiceId: id,
        advanceInvoiceId: body?.advanceInvoiceId,
        amount: body?.amount,
      },
      req.user,
    );
    return { data };
  }
}
