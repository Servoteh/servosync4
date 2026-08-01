import {
  BadRequestException,
  Body,
  Controller,
  Get,
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
import { MailService } from "../../common/mail/mail.service";
import type { AuthUser } from "../auth/jwt.strategy";
import { OpenItemsService } from "./open-items.service";
import { ReconciliationService } from "./reconciliation.service";
import { CompensationService } from "./compensation.service";
import { CompensationPdfService } from "./compensation-pdf.service";
import { DunningPdfService } from "./dunning-pdf.service";
import { IosPdfService } from "./ios-pdf.service";
import { CollectionDashboardService } from "./collection-dashboard.service";
import { PartnerCardService } from "./partner-card.service";
import { DunningService } from "./dunning.service";
import { FxRevaluationService } from "./fx-revaluation.service";
import {
  normalizeFxCurrency,
  parseAsOfDate,
  parseCompanyId,
  parseFlag,
  parseYear,
  type FxRevaluationReverseDto,
  type FxRevaluationRunDto,
} from "./dto/fx-revaluation.dto";
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
    private readonly compensationPdf: CompensationPdfService,
    private readonly dunningPdf: DunningPdfService,
    private readonly iosPdf: IosPdfService,
    private readonly partnerCard: PartnerCardService,
    private readonly mail: MailService,
    private readonly collectionDashboard: CollectionDashboardService,
    private readonly dunning: DunningService,
    private readonly fxRevaluation: FxRevaluationService,
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

  /**
   * SPISAK KOMPENZACIJA (za štampu izjave i posle zatvaranja ekrana).
   *
   * Bez ove liste se izjava o kompenzaciji mogla odštampati SAMO iz prolazne
   * trake odmah posle kreiranja: promena taba je brisala lokalno stanje i
   * proknjižen dokument više nije imao nijedan put do štampe.
   */
  @Get("compensation")
  async listCompensations(
    @Query("partnerId") partnerId?: string,
    @Query("status") status?: string,
    @Query("skip") skip?: string,
    @Query("take") take?: string,
  ) {
    return this.compensation.list({
      partnerId: parseOptionalInt(partnerId),
      status: status?.trim() || undefined,
      skip: parseOptionalInt(skip) ?? 0,
      take: parseOptionalInt(take) ?? 50,
    });
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

  /**
   * IZJAVA O KOMPENZACIJI (PDF inline) — obrazac prebijanja po nalogu kompenzacije:
   * dve tabele (naša potraživanja / naše obaveze), zbir svake strane, prebijeni
   * iznos brojem i slovima, kontrola bilateralnog bilansa i dva potpisa sa M.P.
   * Nepostojeći nalog → 404. Nasleđuje klasnu SALDAKONTI_READ (read-only izlaz).
   */
  @Get("compensation/:id/pdf")
  async compensationPdfObrazac(
    @Param("id", ParseIntPipe) id: number,
    @Req() req: { user: AuthUser },
    @Res() res: Response,
  ): Promise<void> {
    const { buffer, fileName } = await this.compensationPdf.buildCompensationPdf(
      id,
      req.user?.email ?? null,
    );
    sendPdf(res, buffer, fileName);
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

  // ── Talas 3 B6: automatske opomene / dunning (dodato na kraj kontrolera) ─────

  /**
   * Kandidati za opomenu (Talas 3 B6) — komitenti sa dospelim potraživanjima,
   * nivo (1|2|3) izveden iz najstarijeg kašnjenja aging-a + istorija opomena
   * (poslednja opomena, da li je isti nivo već slat danas). `asOf` presek na dan
   * (default danas). Nasleđuje klasnu SALDAKONTI_READ (read-only). Envelope { data, meta }.
   */
  @Get("dunning/candidates")
  async dunningCandidates(@Query("asOf") asOf?: string) {
    const data = await this.dunning.candidates(parseOptionalDate(asOf));
    return { data, meta: { count: data.length } };
  }

  /**
   * ŠTAMPA OPOMENE (PDF inline) — isti obrazac koji ide u prilogu mejla, ali za
   * ruku: pregled dospelih neizmirenih stavki komitenta na dan preseka, po nivou
   * (1|2|3; bez `level` = 1). Do sada je PDF servis postojao BEZ ijedne GET rute,
   * pa se opomena mogla samo poslati mejlom, nikad odštampati (nalaz revizije).
   * `asOf` default danas. Nasleđuje klasnu SALDAKONTI_READ (read-only izlaz).
   */
  @Get("dunning/pdf")
  async dunningPdfObrazac(
    @Query("partnerId") partnerId: string,
    @Query("level") level: string | undefined,
    @Query("asOf") asOf: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const id = parseOptionalInt(partnerId);
    if (id == null) {
      throw new BadRequestException("Parametar partnerId je obavezan.");
    }
    const { buffer, fileName } = await this.dunningPdf.buildDunningPdf(
      id,
      parseOptionalLevel(level) ?? 1,
      parseOptionalDate(asOf),
    );
    sendPdf(res, buffer, fileName);
  }

  /**
   * Pošalji opomenu jednom komitentu (Talas 3 B6). Telo `{ partnerId, level?, to? }`:
   * `level` opciono (default izvedeni iz aging-a), `to` opciono (default mejl
   * komitenta; bez ijednog → 422). Generiše PDF pregled dospelih stavki, šalje
   * kroz MailService (DRY-RUN → sentOk=false) i upisuje DunningNotice. 409 ako je
   * isti nivo već poslat danas (uz vreme prethodnog slanja). Permisija SALDAKONTI_RECONCILE.
   */
  @Post("dunning/send")
  @RequirePermission(PERMISSIONS.SALDAKONTI_RECONCILE)
  async dunningSend(
    @Body() dto: { partnerId?: number | string; level?: number | string; to?: string },
    @Req() req: { user: AuthUser },
  ) {
    const id = parseOptionalInt(dto.partnerId != null ? String(dto.partnerId) : undefined);
    if (id == null) {
      throw new BadRequestException("Parametar partnerId je obavezan.");
    }
    const to =
      dto.to != null && String(dto.to).trim() !== "" ? requireEmail(dto.to) : undefined;
    const level = parseOptionalLevel(dto.level);
    const data = await this.dunning.send({ partnerId: id, level, to }, req.user.userId);
    return { data };
  }

  /**
   * Masovno slanje opomena (Talas 3 B6) — svim kandidatima koji danas nisu dobili
   * opomenu tog nivoa, do `maxLevel` (default 3), najviše 50 po pozivu. Telo
   * `{ asOf?, maxLevel? }`. Vraća { sent, skipped, failed }. Permisija SALDAKONTI_RECONCILE.
   */
  @Post("dunning/send-batch")
  @RequirePermission(PERMISSIONS.SALDAKONTI_RECONCILE)
  async dunningSendBatch(
    @Body() dto: { asOf?: string; maxLevel?: number | string },
    @Req() req: { user: AuthUser },
  ) {
    const data = await this.dunning.sendBatch(
      { asOf: parseOptionalDate(dto.asOf), maxLevel: parseOptionalLevel(dto.maxLevel) },
      req.user.userId,
    );
    return { data };
  }

  // ── Kursne razlike / revalorizacija deviznih stavki (Batch C) ───────────────
  // Obavezno pri zatvaranju godine: devizne otvorene stavke se na dan bilansa
  // preračunavaju po kursu tog dana, razlika ide na 663 (prihod) / 563 (rashod).

  /**
   * Pregled bez upisa — stavke, kurs na dan i zbir razlike, plus liste grupa koje
   * obračun NE knjiži (više valuta u istoj grupi / nesaglasan devizni par).
   * `allowStaleRate=1` svesno dozvoljava kurs sa ranijeg dana (bez toga 409 kad
   * kursna lista za presek nije uneta); `force=1` uključuje sporne grupe u zbirove.
   */
  @Get("fx-revaluation/preview")
  async fxRevaluationPreview(
    @Query("asOfDate") asOfDate: string,
    @Query("currency") currency: string,
    @Query("companyId") companyId?: string,
    @Query("allowStaleRate") allowStaleRate?: string,
    @Query("force") force?: string,
  ) {
    const data = await this.fxRevaluation.preview({
      asOfDate: parseAsOfDate(asOfDate),
      currency: normalizeFxCurrency(currency),
      companyId: parseCompanyId(companyId),
      allowStaleRate: parseFlag(allowStaleRate),
      force: parseFlag(force),
    });
    return { data };
  }

  /** Ranije izvršeni obračuni. */
  @Get("fx-revaluation")
  async fxRevaluationList(
    @Query("year") year?: string,
    @Query("currency") currency?: string,
  ) {
    const data = await this.fxRevaluation.list({
      year: parseYear(year),
      currency: currency != null && currency !== "" ? normalizeFxCurrency(currency) : undefined,
    });
    return { data, meta: { count: data.length } };
  }

  /** Izvrši obračun — kreira nalog kursnih razlika; ponovljen presek → 409. */
  @Post("fx-revaluation/run")
  @RequirePermission(PERMISSIONS.SALDAKONTI_RECONCILE)
  async fxRevaluationRun(
    @Body() dto: FxRevaluationRunDto,
    @Req() req: { user: AuthUser },
  ) {
    const data = await this.fxRevaluation.run(dto, { userId: req.user.userId });
    return { data };
  }

  /** Storniraj obračun — oslobađa presek (datum, valuta) za ponovni obračun. */
  @Post("fx-revaluation/reverse")
  @RequirePermission(PERMISSIONS.SALDAKONTI_RECONCILE)
  async fxRevaluationReverse(
    @Body() dto: FxRevaluationReverseDto,
    @Req() req: { user: AuthUser },
  ) {
    const data = await this.fxRevaluation.reverse(dto, { userId: req.user.userId });
    return { data };
  }
}

/** Inline isporuka PDF-a (isti obrazac na svim štampama modula). */
function sendPdf(res: Response, buffer: Buffer, fileName: string): void {
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    `inline; filename="${encodeURIComponent(fileName)}"`,
  );
  res.send(buffer);
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

/** Opcioni nivo opomene (1|2|3); prazno → undefined; nevalidno → 400. */
function parseOptionalLevel(v?: number | string): number | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 3) {
    throw new BadRequestException("Nivo opomene mora biti 1, 2 ili 3.");
  }
  return n;
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
