import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type { Content, TDocumentDefinitions } from "pdfmake/interfaces";
import { PrismaService } from "../../../prisma/prisma.service";
import { PdfService } from "../../documents/pdf.service";
import { ThreeWayMatchService } from "../three-way-match.service";
import type {
  MatchFinding,
  MatchFindingCode,
  MatchSummaryQueryDto,
  ThreeWayMatchResult,
  ThreeWayMatchSummaryRow,
} from "../dto/three-way-match.dto";
import {
  buildDocHeader,
  buildEmptyNotice,
  buildFilterStrip,
  buildPageFooter,
  buildSignatureRow,
  DOC_STYLES,
  fmtDate,
  fmtMoney,
  fmtQty,
  PAGE_MARGINS,
  safeFileName,
  sanitizeText,
  sumRounded,
  TABLE_LAYOUT,
  toDec,
  type IssuerInfo,
} from "./doc-format";
import { loadPrimaryIssuer } from "./load-issuer";

/**
 * ŠTAMPA POREĐENJA NARUČENO ↔ PRIMLJENO ↔ FAKTURISANO (3-way match).
 * ==================================================================
 * Dva dokumenta iz jednog šablona (kao `invoice-pdf` sa varijantama):
 *   1. DETALJ jedne narudžbenice — poređenje po STAVCI + spisak nalaza + izvori
 *      (robni ulaz, KUF stavka). Ruta: `GET /nabavka/orders/:id/match/pdf`.
 *   2. PREGLED odstupanja po više narudžbenica — po dokumentu, sa trakom
 *      primenjenih filtera. Ruta: `GET /nabavka/match-summary/pdf`.
 *
 * ⚠️ POSLOVNO PRAVILO (odluka korisnika): odstupanje se PRIJAVLJUJE, ali NIKAD ne
 * blokira. Ovaj servis je čitalac — ne piše ništa i ne baca zbog neslaganja.
 *
 * BigBit ovaj izveštaj NEMA — 3-way match je naša nadgradnja. Zato obrazac prati
 * naš standard (`doc-format`) i dodaje ono što BigBit izveštajima fali:
 *   • traka primenjenih filtera (bez nje izveštaj nije dokaziv);
 *   • kontrolni zbir u nozi tabele (Σ naručeno / Σ fakturisano / razlika);
 *   • jasna poruka kad nema redova, umesto prazne tabele sa 0,00;
 *   • ponovljeno zaglavlje tabele i `strana N/M` na svakoj strani.
 *
 * Široke tabele idu A4 POLOŽENO — 12 kolona uspravno je nečitljivo.
 */

/** Srpski naziv koda nalaza (isti rečnik kao UI `MATCH_FINDING_LABEL`). */
const FINDING_LABEL: Record<MatchFindingCode, string> = {
  QTY_OVER_RECEIPT: "Fakturisano > primljeno",
  QTY_UNDER_RECEIPT: "Primljeno > fakturisano",
  PRICE_VARIANCE: "Odstupanje cene",
  QTY_OVER_ORDER: "Primljeno > naručeno",
  NO_RECEIPT: "Faktura bez prijema",
};

@Injectable()
export class MatchReportPdfService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pdf: PdfService,
    private readonly match: ThreeWayMatchService,
  ) {}

  // ─────────────────────────────────────────── 1) detalj jedne narudžbenice

  /** PDF poređenja po stavkama jedne narudžbenice (404 samo ako PO ne postoji). */
  async buildOrderMatchPdf(
    orderId: number,
    opts: { printedBy?: string | null } = {},
  ): Promise<{ buffer: Buffer; fileName: string }> {
    const result = await this.match.matchOrder(orderId);
    const [issuer, articles] = await Promise.all([
      loadPrimaryIssuer(this.prisma),
      this.loadArticleNames(result.lines.map((l) => l.articleId)),
    ]);

    const dd = this.buildOrderDocDefinition(
      result,
      issuer,
      opts.printedBy ?? null,
      articles,
    );
    const buffer = await this.pdf.render(dd);
    return {
      buffer,
      fileName: `poredjenje-${safeFileName(result.orderNumber)}.pdf`,
    };
  }

  /**
   * Nazivi artikala po id-u. Bez ovoga se u koloni „Opis / artikal" štampao
   * interni id baze („Artikal #62"), pa knjigovođa uz ulaznu fakturu nije mogao
   * da zna na koju robu se odstupanje odnosi. BigBit u svakom izveštaju ima NAZIV.
   */
  private async loadArticleNames(
    ids: Array<number | null | undefined>,
  ): Promise<Map<number, { name: string; catalogNumber: string }>> {
    const uniq = [
      ...new Set(ids.filter((i): i is number => i != null && i > 0)),
    ];
    if (!uniq.length) return new Map();
    const rows = await this.prisma.item.findMany({
      where: { id: { in: uniq } },
      select: { id: true, name: true, catalogNumber: true },
    });
    return new Map(
      rows.map((r) => [
        r.id,
        { name: sanitizeText(r.name), catalogNumber: r.catalogNumber },
      ]),
    );
  }

  private buildOrderDocDefinition(
    m: ThreeWayMatchResult,
    issuer: IssuerInfo,
    printedBy: string | null,
    articles: Map<number, { name: string; catalogNumber: string }>,
  ): TDocumentDefinitions {
    const content: Content[] = [
      buildDocHeader({
        title: "POREĐENJE NARUČENO / PRIMLJENO / FAKTURISANO",
        subtitle:
          "Odstupanja su obaveštenje — ne blokiraju prijem ni plaćanje.",
        issuer,
        status: m.hasWarnings
          ? { label: "IMA ODSTUPANJA", tone: "danger" }
          : m.hasFindings
            ? { label: "NAPOMENE", tone: "draft" }
            : { label: "USKLAĐENO", tone: "ok" },
        meta: [
          { label: "Narudžbenica", value: m.orderNumber },
          { label: "Dobavljač", value: m.supplierName ?? `#${m.supplierId}` },
          { label: "Poručeno", value: fmtDate(m.orderedAt) },
          { label: "Status", value: m.status },
          { label: "Valuta", value: m.currency },
        ],
      }),
      this.buildOrderTotalsStrip(m),
      this.buildOrderLinesTable(m, articles),
    ];

    content.push(this.buildFindingsBlock(m.findings));
    content.push(this.buildSourcesBlock(m));
    content.push(buildSignatureRow(["Kontrolisao", "Odgovorno lice"]));

    return {
      pageSize: "A4",
      pageOrientation: "landscape",
      pageMargins: PAGE_MARGINS,
      content,
      styles: DOC_STYLES,
      defaultStyle: { font: "Roboto", fontSize: 9 },
      footer: buildPageFooter(
        `Poređenje · narudžbenica ${m.orderNumber}`,
        printedBy,
      ),
    };
  }

  /** Zbirna traka (naručeno / fakturisano / razlika) iznad tabele. */
  private buildOrderTotalsStrip(m: ThreeWayMatchResult): Content {
    return buildFilterStrip([
      {
        label: "Naručeno (iznos)",
        value: `${fmtMoney(m.totals.orderedAmount)} ${m.currency}`,
      },
      {
        label: "Fakturisano (iznos)",
        value: `${fmtMoney(m.totals.invoicedAmount)} ${m.currency}`,
      },
      {
        label: "Razlika",
        value: `${fmtMoney(m.totals.varianceAmount)} ${m.currency}`,
      },
      { label: "Broj nalaza", value: String(m.findings.length) },
    ]);
  }

  private buildOrderLinesTable(
    m: ThreeWayMatchResult,
    articles: Map<number, { name: string; catalogNumber: string }>,
  ): Content {
    if (!m.lines.length)
      return buildEmptyNotice(
        "Narudžbenica nema stavki",
        "Bez stavki nema šta da se poredi.",
      );

    const head = [
      "R.br.",
      "Opis / artikal",
      "JM",
      "Naručeno",
      "Primljeno",
      "Fakturisano",
      "Cena nar.",
      "Cena fakt.",
      "Iznos nar.",
      "Iznos fakt.",
      "Razlika",
      "Odstupanje",
    ];
    const widths: (string | number)[] = [
      24,
      "*",
      26,
      52,
      52,
      56,
      54,
      54,
      62,
      62,
      58,
      110,
    ];
    const headerCells: Content[] = head.map((text, i) => ({
      text,
      style: "th",
      alignment: i >= 2 && i <= 10 ? "right" : "left",
    }));

    const body: Content[][] = m.lines.map((l) => [
      { text: String(l.lineNo), style: "td" },
      {
        text: (() => {
          const a = l.articleId != null ? articles.get(l.articleId) : undefined;
          const base =
            a != null
              ? `${a.catalogNumber} · ${a.name}`
              : sanitizeText(l.description) ||
                (l.articleId != null ? `Artikal #${l.articleId}` : "—");
          return base + (l.matchable ? "" : "  (bez artikla — ne uparuje se)");
        })(),
        style: "td",
      },
      { text: l.unit ?? "", style: "tdNum" },
      { text: fmtQty(l.orderedQty), style: "tdNum" },
      { text: fmtQty(l.receivedQty), style: "tdNum" },
      { text: fmtQty(l.invoicedQty), style: "tdNum" },
      {
        text: l.orderedUnitPrice != null ? fmtMoney(l.orderedUnitPrice) : "—",
        style: "tdNum",
      },
      {
        text: l.invoicedUnitPrice != null ? fmtMoney(l.invoicedUnitPrice) : "—",
        style: "tdNum",
      },
      { text: fmtMoney(l.orderedAmount), style: "tdNum" },
      { text: fmtMoney(l.invoicedAmount), style: "tdNum" },
      {
        text: fmtMoney(l.varianceAmount),
        style: "tdNum",
        color: toDec(l.varianceAmount).isZero() ? "#333" : "#a00000",
      },
      {
        text:
          l.findings.length === 0
            ? "—"
            : l.findings.map((f) => FINDING_LABEL[f.code] ?? f.code).join("; "),
        style: "td",
      },
    ]);

    // Kontrolni zbir — BigBit tiho štampa Sum(); mi ispisujemo i broj redova.
    const totalRow: Content[] = [
      { text: "", style: "th" },
      { text: `UKUPNO (redova: ${m.lines.length})`, style: "th" },
      { text: "", style: "th" },
      { text: "", style: "th" },
      { text: "", style: "th" },
      { text: "", style: "th" },
      { text: "", style: "th" },
      { text: "", style: "th" },
      // Zbir se računa NAD ZAOKRUŽENIM iznosima stavki: red UKUPNO mora biti
      // jednak sabiranju odštampane kolone (količine su Decimal(19,6), cene
      // Decimal(19,4), pa puna preciznost daje drugi broj od onog na papiru).
      {
        text: fmtMoney(sumRounded(m.lines.map((l) => l.orderedAmount))),
        style: "th",
        alignment: "right",
      },
      {
        text: fmtMoney(sumRounded(m.lines.map((l) => l.invoicedAmount))),
        style: "th",
        alignment: "right",
      },
      {
        text: fmtMoney(sumRounded(m.lines.map((l) => l.varianceAmount))),
        style: "th",
        alignment: "right",
      },
      { text: "", style: "th" },
    ];

    return {
      table: {
        headerRows: 1,
        widths,
        body: [headerCells, ...body, totalRow],
      },
      layout: TABLE_LAYOUT,
    };
  }

  private buildFindingsBlock(findings: MatchFinding[]): Content {
    if (!findings.length)
      return {
        margin: [0, 12, 0, 0],
        text: "Naručeno, primljeno i fakturisano se slažu — nema odstupanja.",
        fontSize: 9,
        bold: true,
        color: "#0a6b2e",
      };
    return {
      margin: [0, 12, 0, 0],
      stack: [
        {
          text: `Odstupanja (${findings.length}) — obaveštenje, ne blokira plaćanje:`,
          fontSize: 9,
          bold: true,
        },
        {
          margin: [0, 4, 0, 0],
          ul: findings.map(
            (f) =>
              `${f.lineNo != null ? `stavka ${f.lineNo}: ` : "dokument: "}${f.message}`,
          ),
          fontSize: 8,
        },
      ],
    };
  }

  private buildSourcesBlock(m: ThreeWayMatchResult): Content {
    const stock =
      m.stockDocuments.length === 0
        ? "nema robnog ulaza"
        : m.stockDocuments
            .map(
              (d) =>
                `${d.documentNumber} (${fmtDate(d.documentDate)}, ${d.status})`,
            )
            .join(", ");
    const kuf = m.vatLedger
      ? `${m.vatLedger.documentNumbers.join(", ")} — osnovica ${fmtMoney(
          m.vatLedger.vatBase,
        )}, PDV ${fmtMoney(m.vatLedger.vatAmount)}`
      : "nije proknjižena";
    return {
      margin: [0, 10, 0, 0],
      stack: [
        {
          text: `Izvor „primljeno/fakturisano" (robni ulaz): ${stock}`,
          style: "note",
        },
        { text: `KUF (ulazna faktura): ${kuf}`, style: "note" },
      ],
    };
  }

  // ─────────────────────────────────────────── 2) pregled po više dokumenata

  /** PDF pregleda odstupanja po više narudžbenica (isti filteri kao ekran). */
  async buildMatchSummaryPdf(
    params: MatchSummaryQueryDto,
    opts: { printedBy?: string | null } = {},
  ): Promise<{ buffer: Buffer; fileName: string }> {
    // Štampa uzima ceo dozvoljeni opseg (ne stranu ekrana) — izveštaj mora da
    // pokrije period, a ne slučajno prvih 50 redova.
    const { data, meta } = await this.match.matchSummary({
      ...params,
      skip: 0,
      take: params.take ?? 200,
    });
    const issuer = await loadPrimaryIssuer(this.prisma);
    const supplierName =
      params.supplierId != null
        ? ((
            await this.prisma.customer.findUnique({
              where: { id: params.supplierId },
              select: { name: true },
            })
          )?.name ?? `#${params.supplierId}`)
        : null;

    const dd = this.buildSummaryDocDefinition({
      rows: data,
      meta,
      params,
      supplierName,
      issuer,
      printedBy: opts.printedBy ?? null,
    });
    const buffer = await this.pdf.render(dd);
    const stamp = new Date().toISOString().slice(0, 10);
    return { buffer, fileName: `pregled-odstupanja-${stamp}.pdf` };
  }

  private buildSummaryDocDefinition(args: {
    rows: ThreeWayMatchSummaryRow[];
    meta: {
      total: number;
      returned: number;
      withFindings: number;
      withWarnings: number;
    };
    params: MatchSummaryQueryDto;
    supplierName: string | null;
    issuer: IssuerInfo;
    printedBy: string | null;
  }): TDocumentDefinitions {
    const { rows, meta, params, supplierName, issuer, printedBy } = args;

    const totals = rows.reduce(
      (acc, r) => ({
        ordered: acc.ordered.plus(toDec(r.orderedAmount)),
        invoiced: acc.invoiced.plus(toDec(r.invoicedAmount)),
        variance: acc.variance.plus(toDec(r.varianceAmount)),
      }),
      {
        ordered: new Prisma.Decimal(0),
        invoiced: new Prisma.Decimal(0),
        variance: new Prisma.Decimal(0),
      },
    );

    const content: Content[] = [
      buildDocHeader({
        title: "PREGLED ODSTUPANJA (3-WAY MATCH)",
        subtitle: "Naručeno ↔ primljeno ↔ fakturisano po narudžbenicama",
        issuer,
        status:
          meta.withWarnings > 0
            ? { label: `UPOZORENJA: ${meta.withWarnings}`, tone: "danger" }
            : { label: "BEZ UPOZORENJA", tone: "ok" },
        meta: [
          { label: "Datum izveštaja", value: fmtDate(new Date()) },
          { label: "Narudžbenica u pregledu", value: String(rows.length) },
          { label: "Sa nalazom", value: String(meta.withFindings) },
        ],
      }),
      buildFilterStrip([
        {
          label: "Period od",
          value: params.from ? fmtDate(params.from) : "sve",
        },
        { label: "Period do", value: params.to ? fmtDate(params.to) : "sve" },
        { label: "Dobavljač", value: supplierName ?? "svi" },
        {
          label: "Filter",
          value: params.onlyWithFindings
            ? "samo sa nalazom"
            : "sve narudžbenice",
        },
        { label: "Ukupno u bazi", value: String(meta.total) },
      ]),
      ...(rows.length < meta.total
        ? [
            {
              margin: [0, 10, 0, 0],
              style: "noteWarn",
              text:
                `PRIKAZANO PRVIH ${rows.length} OD ${meta.total} NARUDŽBENICA — ` +
                "suzi period ili dobavljača; zbir se odnosi samo na prikazane redove.",
            } as Content,
          ]
        : []),
      this.buildSummaryTable(rows, totals, rows.length < meta.total),
    ];

    content.push({
      margin: [0, 12, 0, 0],
      text: "Napomena: odstupanje je obaveštenje i NIKAD ne blokira prijem, pripremu ni izvršenje plaćanja.",
      style: "note",
    });
    content.push(this.buildLegend());
    content.push(
      buildSignatureRow(["Sastavio", "Kontrolisao", "Odgovorno lice"]),
    );

    return {
      pageSize: "A4",
      pageOrientation: "landscape",
      pageMargins: PAGE_MARGINS,
      content,
      styles: DOC_STYLES,
      defaultStyle: { font: "Roboto", fontSize: 9 },
      footer: buildPageFooter("Pregled odstupanja (3-way match)", printedBy),
    };
  }

  private buildSummaryTable(
    rows: ThreeWayMatchSummaryRow[],
    totals: {
      ordered: Prisma.Decimal;
      invoiced: Prisma.Decimal;
      variance: Prisma.Decimal;
    },
    truncated = false,
  ): Content {
    if (!rows.length)
      return buildEmptyNotice(
        "Nema narudžbenica za zadate uslove",
        "Promeni period, dobavljača ili isključi filter „samo sa nalazom“.",
      );

    const head = [
      "R.br.",
      "Narudžbenica",
      "Dobavljač",
      "Poručeno",
      "Status",
      "Val.",
      "Iznos naručeno",
      "Iznos fakturisano",
      "Razlika",
      "Nalaza",
      "Upoz.",
      "Vrste odstupanja",
    ];
    // Fiksne širine + 8 pt padding po koloni moraju stati u širinu sadržaja
    // položenog A4 (777,89 pt), inače „*" kolona (Dobavljač) ostane ~45 pt i
    // naziv se lomi u šest redova. Pokriveno testom (widthSlack).
    const widths: (string | number)[] = [
      22,
      70,
      "*",
      52,
      48,
      26,
      72,
      72,
      64,
      32,
      30,
      110,
    ];
    const headerCells: Content[] = head.map((text, i) => ({
      text,
      style: "th",
      alignment: i === 0 || (i >= 6 && i <= 10) ? "right" : "left",
    }));

    const body: Content[][] = rows.map((r, idx) => [
      { text: String(idx + 1), style: "tdNum" },
      { text: r.orderNumber, style: "td" },
      { text: r.supplierName ?? `#${r.supplierId}`, style: "td" },
      { text: fmtDate(r.orderedAt), style: "td" },
      { text: r.status, style: "td" },
      { text: r.currency, style: "td" },
      { text: fmtMoney(r.orderedAmount), style: "tdNum" },
      { text: fmtMoney(r.invoicedAmount), style: "tdNum" },
      {
        text: fmtMoney(r.varianceAmount),
        style: "tdNum",
        color: toDec(r.varianceAmount).isZero() ? "#333" : "#a00000",
      },
      { text: String(r.findingCount), style: "tdNum" },
      { text: String(r.warningCount), style: "tdNum" },
      {
        text:
          r.codes.length === 0
            ? "—"
            : r.codes.map((c) => FINDING_LABEL[c] ?? c).join("; "),
        style: "td",
      },
    ]);

    const totalRow: Content[] = [
      { text: "", style: "th" },
      {
        text: truncated
          ? `UKUPNO (prikazani redovi: ${rows.length})`
          : `UKUPNO (redova: ${rows.length})`,
        style: "th",
      },
      { text: "", style: "th" },
      { text: "", style: "th" },
      { text: "", style: "th" },
      { text: "", style: "th" },
      { text: fmtMoney(totals.ordered), style: "th", alignment: "right" },
      { text: fmtMoney(totals.invoiced), style: "th", alignment: "right" },
      { text: fmtMoney(totals.variance), style: "th", alignment: "right" },
      { text: "", style: "th" },
      { text: "", style: "th" },
      { text: "", style: "th" },
    ];

    return {
      table: { headerRows: 1, widths, body: [headerCells, ...body, totalRow] },
      layout: TABLE_LAYOUT,
    };
  }

  /** Legenda kodova — izveštaj mora da bude čitljiv i bez ekrana. */
  private buildLegend(): Content {
    return {
      margin: [0, 8, 0, 0],
      stack: [
        { text: "Legenda vrsta odstupanja:", fontSize: 8, bold: true },
        {
          margin: [0, 2, 0, 0],
          ul: [
            "Fakturisano > primljeno — na fakturi je više nego što je fizički primljeno (upozorenje).",
            "Primljeno > fakturisano — faktura još nije stigla ili je delimična (informacija).",
            "Odstupanje cene — fakturna jedinična cena odstupa od naručene preko tolerancije (upozorenje).",
            "Primljeno > naručeno — prijem je veći od naručene količine (upozorenje).",
            "Faktura bez prijema — postoji zavedena faktura, a prijem nije evidentiran (upozorenje).",
          ],
          fontSize: 7.5,
          color: "#555",
        },
      ],
    };
  }
}
