import {
  BadRequestException,
  Body,
  Controller,
  Get,
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
import { MailService } from "../../common/mail/mail.service";
import type { AuthUser } from "../auth/jwt.strategy";
import { OpenItemsService } from "./open-items.service";
import { ReconciliationService } from "./reconciliation.service";
import { CompensationService } from "./compensation.service";
import { IosPdfService } from "./ios-pdf.service";
import { CollectionDashboardService } from "./collection-dashboard.service";
import { PartnerCardService } from "./partner-card.service";
import {
  type ListOpenItemsQuery,
  type AgingQuery,
  type ReconcileDto,
  type UnreconcileDto,
  type CreateCompensationDto,
  validateReconcileDto,
  validateUnreconcileDto,
} from "./dto/saldakonti.dto";

/**
 * Saldakonti — otvorene stavke / aging / uparivanje / kompenzacija (Faza 4 §A).
 *   GET  /api/v1/saldakonti/open-items        — otvorene stavke (accountCode?, partnerId?, asOf?)
 *   GET  /api/v1/saldakonti/aging             — aging po komitentu (accountCode?, asOf?)
 *   POST /api/v1/saldakonti/reconcile         — uparivanje (auto|manual) datih stavki
 *   POST /api/v1/saldakonti/reconcile/unreconcile — razveži grupu (role-gated)
 *   POST /api/v1/saldakonti/compensation      — kreiranje kompenzacije (bilateralni bilans)
 *   GET  /api/v1/saldakonti/compensation/proposal — predlog kompenzacije iz otvorenih stavki
 *   GET  /api/v1/saldakonti/ios-pdf           — IOS/NIOS obrazac usaglašavanja (PDF; partnerId, asOf?)
 *   GET  /api/v1/saldakonti/partner-card      — kartica komitenta (ledger + running saldo; partnerId, accountCode?, from?, to?)
 *   GET  /api/v1/saldakonti/partner-card/pdf  — kartica komitenta kao PDF (isti filteri)
 *
 * JWT + PermissionsGuard. read = SALDAKONTI_READ; sve mutacije (uparivanje,
 * razvezivanje, kompenzacija) = SALDAKONTI_RECONCILE (write nad zatvaranjem GK).
 * Manual reconcile i unreconcile su namerno pod istim RECONCILE ključem — to je
 * write-težina; finija podela (npr. poseban ključ za unreconcile) je stvar
 * role-permissions dodele pri aktivaciji, ne novog ključa.
 */
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermission(PERMISSIONS.SALDAKONTI_READ)
@Controller({ path: "saldakonti", version: "1" })
export class SaldakontiController {
  constructor(
    private readonly openItems: OpenItemsService,
    private readonly reconciliation: ReconciliationService,
    private readonly compensation: CompensationService,
    private readonly iosPdf: IosPdfService,
    private readonly partnerCard: PartnerCardService,
    private readonly mail: MailService,
    private readonly collectionDashboard: CollectionDashboardService,
  ) {}

  @Get("open-items")
  async listOpenItems(@Query() query: ListOpenItemsQuery) {
    const partnerId = parseOptionalInt(query.partnerId);
    const asOf = parseOptionalDate(query.asOf);
    const data = await this.openItems.listOpenItems(
      query.accountCode,
      partnerId,
      asOf,
    );
    return { data, meta: { count: data.length } };
  }

  @Get("aging")
  async aging(@Query() query: AgingQuery) {
    const asOf = parseOptionalDate(query.asOf);
    const data = await this.openItems.agingByPartner(query.accountCode, asOf);
    return { data, meta: { count: data.length } };
  }

  /**
   * IOS/NIOS obrazac usaglašavanja (Talas 1E §E3, gap #49). Zakonski godišnji
   * obrazac — otvorene stavke komitenta na dan preseka + polja za saglasnost/
   * osporavanje i potpise obe strane. NIOS = isti obrazac kad nema otvorenih
   * stavki (saldo 0) — svejedno se štampa (ne 404). `asOf` default danas.
   * PDF se vraća inline (`application/pdf`) — isti obrazac kao PdvPrintController.
   * Nasleđuje klasnu SALDAKONTI_READ permisiju (read-only izlaz).
   */
  @Get("ios-pdf")
  async iosPdfObrazac(
    @Query("partnerId") partnerId: string,
    @Query("asOf") asOf: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const id = parseOptionalInt(partnerId);
    if (id == null) {
      throw new BadRequestException("Parametar partnerId je obavezan.");
    }
    const asOfDate = parseOptionalDate(asOf);
    const { buffer, fileName } = await this.iosPdf.buildIosPdf(id, asOfDate);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `inline; filename="${encodeURIComponent(fileName)}"`,
    );
    res.send(buffer);
  }

  /**
   * Pošalji IOS/NIOS obrazac komitentu mejlom sa PDF prilogom (Talas 3 A6).
   * Telo `{ partnerId, to, asOf? }`: isti obrazac kao GET ios-pdf, samo umesto
   * inline preuzimanja ide kao prilog Resend mejla. Slanje NE baca (DRY-RUN kad
   * ključ fali) — vraća `{ data: { sent, to, fileName } }`. Nasleđuje klasnu
   * SALDAKONTI_READ (dostava izveštaja koji je već štampiv; bez elevacije).
   */
  @Post("ios-pdf/send-mail")
  async sendIosPdfMail(
    @Body() dto: { partnerId?: number | string; to?: string; asOf?: string },
  ) {
    const id = parseOptionalInt(
      dto.partnerId != null ? String(dto.partnerId) : undefined,
    );
    if (id == null) {
      throw new BadRequestException("Parametar partnerId je obavezan.");
    }
    const to = requireEmail(dto.to);
    const asOf = parseOptionalDate(dto.asOf);
    const { buffer, fileName } = await this.iosPdf.buildIosPdf(id, asOf);
    const subject = `IOS obrazac usaglašavanja - komitent ${id}`;
    const html =
      `<p>Poštovani,</p>` +
      `<p>U prilogu Vam dostavljamo izvod otvorenih stavki (IOS) radi usaglašavanja salda.</p>` +
      `<p>Molimo Vas da obrazac overite i vratite nam jedan primerak.</p>` +
      `<p>Srdačan pozdrav,<br/>Servoteh</p>`;
    const sent = await this.mail.send({
      to,
      subject,
      html,
      attachments: [{ filename: fileName, content: buffer }],
    });
    return { data: { sent, to, fileName } };
  }

  /**
   * Kartica komitenta (Talas 2 §A1) — hronološke stavke glavne knjige partnera
   * (posted/locked) sa running saldo kolonom + početnim stanjem pre `from`.
   * Obim = saldakonto konti; zatvaranje kartice se slaže sa saldom otvorenih
   * stavki partnera. `partnerId` obavezan; `accountCode`/`from`/`to` opcioni.
   * Nasleđuje klasnu SALDAKONTI_READ (read-only izlaz). Envelope { data }.
   */
  @Get("partner-card")
  async partnerCardData(
    @Query("partnerId") partnerId?: string,
    @Query("accountCode") accountCode?: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
  ) {
    const id = parseOptionalInt(partnerId);
    if (id == null) {
      throw new BadRequestException("Parametar partnerId je obavezan.");
    }
    const data = await this.partnerCard.getPartnerCard(
      id,
      accountCode?.trim() || undefined,
      parseOptionalDate(from),
      parseOptionalDate(to),
    );
    return { data };
  }

  /**
   * Kartica komitenta kao PDF (isti filteri kao gore) — obrazac ios-pdf layout:
   * zaglavlje firme + partner, tabela datum/dokument/opis/duguje/potražuje/saldo,
   * zbir. PDF se vraća inline (`application/pdf`). read = SALDAKONTI_READ.
   */
  @Get("partner-card/pdf")
  async partnerCardPdf(
    @Query("partnerId") partnerId: string,
    @Query("accountCode") accountCode: string | undefined,
    @Query("from") from: string | undefined,
    @Query("to") to: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const id = parseOptionalInt(partnerId);
    if (id == null) {
      throw new BadRequestException("Parametar partnerId je obavezan.");
    }
    const { buffer, fileName } = await this.partnerCard.buildPartnerCardPdf(
      id,
      accountCode?.trim() || undefined,
      parseOptionalDate(from),
      parseOptionalDate(to),
    );
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `inline; filename="${encodeURIComponent(fileName)}"`,
    );
    res.send(buffer);
  }

  @Post("reconcile")
  @RequirePermission(PERMISSIONS.SALDAKONTI_RECONCILE)
  async reconcile(
    @Body() dto: ReconcileDto,
    @Req() req: { user: AuthUser },
  ) {
    validateReconcileDto(dto);
    const data =
      dto.mode === "manual"
        ? await this.reconciliation.manualReconcile(
            dto.entryIds,
            req.user.userId,
            dto.note,
          )
        : await this.reconciliation.autoReconcile(
            dto.entryIds,
            req.user.userId,
            dto.note,
          );
    return { data };
  }

  @Post("reconcile/unreconcile")
  @RequirePermission(PERMISSIONS.SALDAKONTI_RECONCILE)
  async unreconcile(@Body() dto: UnreconcileDto) {
    validateUnreconcileDto(dto);
    const data = await this.reconciliation.unreconcile(dto.groupId);
    return { data };
  }

  @Get("compensation/proposal")
  async compensationProposal(@Query("partnerId") partnerId?: string) {
    const id = parseOptionalInt(partnerId);
    if (id == null) {
      return { data: null, meta: { error: "partnerId je obavezan." } };
    }
    const data = await this.compensation.buildFromOpenItems(id);
    return { data };
  }

  @Post("compensation")
  @RequirePermission(PERMISSIONS.SALDAKONTI_RECONCILE)
  async createCompensation(
    @Body() dto: CreateCompensationDto,
    @Req() req: { user: AuthUser },
  ) {
    const data = await this.compensation.create(dto, req.user.userId);
    return { data };
  }

  // ── Talas 3 §A7: dashboard naplate + MaxSaldo (dodato na kraj kontrolera) ────

  /**
   * Dashboard naplate (Talas 3 §A7) — agregati nad otvorenim stavkama: ukupno
   * potraživanja/obaveze, DSO (ponderisan dani dospelosti), aging bucketi ukupno
   * i top 10 dužnika sa bucket raspodelom. `asOf` presek na dan (default danas).
   * Nasleđuje klasnu SALDAKONTI_READ (read-only izlaz). Envelope { data }.
   */
  @Get("collection-dashboard")
  async collectionDashboardData(@Query("asOf") asOf?: string) {
    const data = await this.collectionDashboard.build(parseOptionalDate(asOf));
    return { data };
  }

  /**
   * MaxSaldo (Talas 3 §A7) — auto-zatvaranje sitnih salda. Zatvara sve otvorene
   * grupe sa 0 < |saldo| ≤ prag postojećim reconcile mehanizmom (samo flag; otpis
   * razlike se NE knjiži ovde). Telo `{ threshold? }` (default 1.00). Vraća
   * `{ closedGroups, totalAmount, threshold }`. Permisija SALDAKONTI_RECONCILE.
   */
  @Post("reconcile/small-balances")
  @RequirePermission(PERMISSIONS.SALDAKONTI_RECONCILE)
  async reconcileSmallBalances(
    @Body() dto: { threshold?: number | string },
    @Req() req: { user: AuthUser },
  ) {
    const data = await this.reconciliation.reconcileSmallBalances(
      dto?.threshold,
      req.user.userId,
    );
    return { data };
  }
}

function parseOptionalInt(v?: string): number | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

function parseOptionalDate(v?: string): Date | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/** Osnovna provera email formata (jedan primalac); baca 400 na prazno/nevalidno. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function requireEmail(to: unknown): string {
  const email = typeof to === "string" ? to.trim() : "";
  if (!email) {
    throw new BadRequestException("Email adresa primaoca je obavezna.");
  }
  if (!EMAIL_RE.test(email)) {
    throw new BadRequestException(`Neispravna email adresa primaoca: ${email}.`);
  }
  return email;
}
