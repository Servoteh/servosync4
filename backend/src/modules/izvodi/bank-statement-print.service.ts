/**
 * BANKOVNI IZVOD (izvod poslovnog računa) — PDF.
 * =========================================================================
 * BigBit NEMA obrazac za štampu izvoda (u oba izvezena skupa, 496 + 426
 * izveštaja, nema nijednog): izvod se tamo unosi kao nalog glavne knjige i
 * štampa kroz „Nalog" / „Kartica konta". Zato je ovde obrazac projektovan po
 * ServoSync šablonu, a raspored preuzet od najbližeg legitimnog srodnika —
 * naloga za knjiženje (zaglavlje firme, tabela stavki, zbirovi, potpisi) —
 * proširen rekapitulacijom stanja koju izvod mora da nosi:
 *
 *   Prethodno stanje + Σ priliva − Σ odliva = Novo stanje
 *
 * i kontrolom protiv unetog krajnjeg stanja (ista formula kao `computeControl`
 * u `BankStatementService` — traka na ekranu i štampa ne mogu da se raziđu).
 *
 * DEVIZNI IZVOD (E6): kolone „Valuta / Devizni iznos / Kurs" se dodaju samo kad
 * izvod nije dinarski; `amount` je UVEK RSD protivvrednost.
 *
 * NOVAC: Prisma.Decimal (NIKAD Float). Renderer: zajednički `PdfService`.
 */

import { Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type { Content, TableCell, TDocumentDefinitions } from "pdfmake/interfaces";
import { PrismaService } from "../../prisma/prisma.service";
import { PdfService } from "../documents/pdf.service";
import {
  DEFAULT_STYLE,
  DOC_STYLES,
  PAGE_MARGINS,
  amountInWords,
  buildDocHeader,
  buildDocTable,
  buildEmptyNotice,
  buildPageFooter,
  buildSignatureRow,
  emptyRow,
  fmtDate,
  fmtMoney,
  fmtMoneyOrBlank,
  fmtRate,
  headerRow,
  loadIssuer,
  totalRow,
  type DocColumn,
  type StatusBadge,
} from "../gl/print/doc-layout";

const D = Prisma.Decimal;
const ZERO = new D(0);
/** Tolerancija kontrole salda — pola pare (isto kao BankStatementService). */
const CONTROL_TOLERANCE = new D("0.005");

/** Status izvoda → značka u zaglavlju. */
const STATUS_BADGE: Record<string, StatusBadge> = {
  DRAFT: { label: "U pripremi", tone: "neutral" },
  IMPORTED: { label: "Uvezen", tone: "warn" },
  POSTED: { label: "Proknjižen", tone: "ok" },
};

/** Status stavke → čitljiv natpis. */
const LINE_STATUS_LABEL: Record<string, string> = {
  UNMATCHED: "Neupareno",
  MATCHED: "Upareno",
  POSTED: "Proknjiženo",
};

@Injectable()
export class BankStatementPrintService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pdf: PdfService,
  ) {}

  /**
   * Generiši PDF bankovnog izvoda po id-u. Nepostojeći izvod → 404 (isti obrazac
   * kao `BankStatementService.getStatement`). Izvod bez stavki se ŠTAMPA (prazan
   * dan na računu je legitiman) — sa napomenom umesto neme nule.
   */
  async buildStatementPdf(
    statementId: number,
    printedBy?: string | null,
  ): Promise<{ buffer: Buffer; fileName: string }> {
    const statement = await this.prisma.bankStatement.findUnique({
      where: { id: statementId },
      include: { lines: { where: { deletedAt: null }, orderBy: { lineNo: "asc" } } },
    });
    if (!statement) {
      throw new NotFoundException(`Izvod ${statementId} ne postoji.`);
    }

    const [issuer, partnerNames] = await Promise.all([
      loadIssuer(this.prisma),
      this.loadPartnerNames(
        statement.lines
          .map((l) => l.matchedCustomerId)
          .filter((c): c is number => c != null),
      ),
    ]);

    const docDefinition = this.buildDocDefinition(statement, partnerNames, issuer, printedBy);
    const buffer = await this.pdf.render(docDefinition);
    const safeNumber = statement.statementNumber.replace(/[^\w.-]+/g, "_");
    return { buffer, fileName: `Izvod-${safeNumber}-${statement.id}.pdf` };
  }

  private async loadPartnerNames(ids: number[]): Promise<Map<number, string>> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return new Map();
    const rows = await this.prisma.customer.findMany({
      where: { id: { in: unique } },
      select: { id: true, name: true },
    });
    return new Map(rows.map((r) => [r.id, r.name]));
  }

  // ───────────────────────────────────────────────────── dokument

  private buildDocDefinition(
    statement: {
      id: number;
      bankAccount: string;
      statementNumber: string;
      statementDate: Date;
      status: string;
      currency: string;
      openingBalance: Prisma.Decimal;
      closingBalance: Prisma.Decimal;
      importedFileName: string | null;
      lines: Array<{
        lineNo: number;
        partnerAccount: string | null;
        partnerName: string | null;
        amount: Prisma.Decimal;
        direction: string;
        referenceNumber: string | null;
        documentDate: Date | null;
        matchedCustomerId: number | null;
        status: string;
        currency: string | null;
        foreignAmount: Prisma.Decimal | null;
        exchangeRate: Prisma.Decimal | null;
      }>;
    },
    partnerNames: Map<number, string>,
    issuer: Awaited<ReturnType<typeof loadIssuer>>,
    printedBy?: string | null,
  ): TDocumentDefinitions {
    const currency = (statement.currency || "RSD").toUpperCase();
    const foreign = currency !== "RSD";
    const columns = buildColumns(foreign, currency);

    let inflow = ZERO;
    let outflow = ZERO;

    const body: TableCell[][] = [headerRow(columns)];
    if (statement.lines.length === 0) {
      body.push(emptyRow(columns, "IZVOD NEMA STAVKI (dan bez prometa)"));
    } else {
      statement.lines.forEach((l) => {
        const isInflow = l.direction === "CREDIT";
        if (isInflow) inflow = inflow.add(l.amount);
        else outflow = outflow.add(l.amount);

        const partner =
          l.matchedCustomerId != null
            ? (partnerNames.get(l.matchedCustomerId) ?? l.partnerName ?? "—")
            : (l.partnerName ?? "—");

        const cells: TableCell[] = [
          { text: String(l.lineNo), style: "tdNum" },
          { text: fmtDate(l.documentDate), style: "td" },
          { text: partner, style: "td" },
          { text: l.partnerAccount ?? "", style: "td" },
          { text: l.referenceNumber ?? "", style: "td" },
          { text: LINE_STATUS_LABEL[l.status] ?? l.status, style: "tdMuted" },
        ];
        if (foreign) {
          cells.push(
            { text: l.currency ?? currency, style: "td" },
            { text: fmtMoneyOrBlank(l.foreignAmount), style: "tdNum" },
            { text: l.exchangeRate ? fmtRate(l.exchangeRate) : "", style: "tdNum" },
          );
        }
        cells.push(
          { text: isInflow ? "" : fmtMoney(l.amount), style: "tdNum" },
          { text: isInflow ? fmtMoney(l.amount) : "", style: "tdNum" },
        );
        body.push(cells);
      });
    }

    const labelSpan = columns.length - 2;
    body.push(totalRow(columns, "UKUPNO", labelSpan, [fmtMoney(outflow), fmtMoney(inflow)]));

    const expectedClosing = statement.openingBalance.add(inflow).sub(outflow);
    const difference = expectedClosing.sub(statement.closingBalance);
    // Kontrola ima smisla samo kad je bar jedno stanje uneto (ista logika kao
    // traka na ekranu) — inače bi svaki izvod vikao „saldo se ne slaže".
    const controlAvailable = !(
      statement.openingBalance.isZero() && statement.closingBalance.isZero()
    );
    const controlOk =
      !controlAvailable || difference.abs().lessThanOrEqualTo(CONTROL_TOLERANCE);

    const content: Content[] = [
      buildDocHeader({
        title: "IZVOD POSLOVNOG RAČUNA",
        subtitle: `Izvod broj ${statement.statementNumber} · žiro račun ${statement.bankAccount}`,
        issuer,
        meta: [
          ["Datum izvoda", fmtDate(statement.statementDate)],
          ["Valuta", currency],
          ["Stavki", String(statement.lines.length)],
          [
            "Izvor",
            statement.importedFileName ? statement.importedFileName : "ručni unos",
          ],
        ],
        badge: STATUS_BADGE[statement.status] ?? { label: statement.status, tone: "neutral" },
      }),
    ];
    if (statement.lines.length === 0) {
      content.push(buildEmptyNotice("IZVOD NEMA STAVKI (dan bez prometa)"));
    }
    content.push(buildDocTable(columns, body));
    content.push(
      this.buildRecap(
        statement.openingBalance,
        inflow,
        outflow,
        expectedClosing,
        statement.closingBalance,
        difference,
        controlAvailable,
        controlOk,
        currency,
      ),
    );
    content.push(buildSignatureRow(["Kontrolisao", "Knjižio", "Odgovorno lice"]));

    return {
      pageSize: "A4",
      pageOrientation: foreign ? "landscape" : "portrait",
      pageMargins: PAGE_MARGINS,
      content,
      styles: DOC_STYLES,
      defaultStyle: DEFAULT_STYLE,
      footer: buildPageFooter(
        `Izvod ${statement.statementNumber} (${statement.bankAccount})`,
        printedBy,
      ),
    };
  }

  /** Rekapitulacija stanja + kontrola salda + iznos novog stanja u slovima. */
  private buildRecap(
    opening: Prisma.Decimal,
    inflow: Prisma.Decimal,
    outflow: Prisma.Decimal,
    expected: Prisma.Decimal,
    actual: Prisma.Decimal,
    difference: Prisma.Decimal,
    available: boolean,
    ok: boolean,
    currency: string,
  ): Content {
    const row = (label: string, value: string, bold = false): TableCell[] => [
      { text: label, style: bold ? "totLbl" : "td" },
      { text: value, style: bold ? "totNum" : "tdNum" },
    ];

    const recap: Content = {
      unbreakable: true,
      margin: [0, 14, 0, 0],
      columns: [
        {
          width: "*",
          stack: [
            { text: "REKAPITULACIJA", style: "sectionLbl" },
            {
              margin: [0, 4, 0, 0],
              table: {
                widths: ["*", "auto"],
                body: [
                  row("Prethodno stanje", fmtMoney(opening)),
                  row("Ukupan priliv (+)", fmtMoney(inflow)),
                  row("Ukupan odliv (−)", fmtMoney(outflow)),
                  row("Novo stanje po prometu", fmtMoney(expected), true),
                  row("Novo stanje po izvodu", fmtMoney(actual), true),
                ],
              },
              layout: {
                hLineWidth: (i: number, node) =>
                  i === 0 || i === node.table.body.length ? 0 : 0.4,
                vLineWidth: () => 0,
                hLineColor: () => "#dddddd",
                paddingLeft: () => 0,
                paddingRight: () => 4,
                paddingTop: () => 3,
                paddingBottom: () => 3,
              },
            },
          ],
        },
        {
          width: "*",
          margin: [16, 14, 0, 0],
          stack: [
            {
              text: !available
                ? "Kontrola salda nije dostupna — početno i krajnje stanje nisu uneti."
                : ok
                  ? `Kontrola salda: prethodno stanje + priliv − odliv = novo stanje (razlika ${fmtMoney(difference)}).`
                  : `NEUSKLAĐENO: novo stanje po prometu ${fmtMoney(expected)} ≠ stanje po izvodu ${fmtMoney(actual)} (razlika ${fmtMoney(difference)}).`,
              style: available && !ok ? "noteWarn" : "note",
            },
            {
              // Rekapitulacija se računa iz `amount`/`openingBalance`/`closingBalance`,
              // a to su po modelu UVEK dinari — i na deviznom izvodu. Slova zato
              // idu u dinarima; devizni iznos stavke stoji u svojoj koloni.
              text: `Slovima (novo stanje): ${amountInWords(actual, "dinara")}`,
              style: "words",
              margin: [0, 6, 0, 0],
            },
          ],
        },
      ],
      columnGap: 16,
    };
    return recap;
  }
}

/** Kolone tabele stavki; devizni izvod umeće valutu/devizni iznos/kurs. */
function buildColumns(foreign: boolean, currency: string): DocColumn[] {
  const base: DocColumn[] = [
    { header: "R.br.", width: "auto", numeric: true },
    { header: "Datum dok.", width: "auto" },
    { header: "Komitent", width: "*" },
    { header: "Žiro računa", width: "auto" },
    { header: "Poziv na broj", width: "auto" },
    { header: "Uparivanje", width: "auto" },
  ];
  if (foreign) {
    base.push(
      { header: "Valuta", width: "auto" },
      { header: `Devizni iznos (${currency})`, width: "auto", numeric: true },
      { header: "Kurs", width: "auto", numeric: true },
    );
  }
  // Kolone `amount` su UVEK dinarska protivvrednost (model `BankStatementLine`),
  // pa na deviznom izvodu MORAJU nositi oznaku RSD — inače se dve novčane skale
  // na istom papiru ne razlikuju.
  base.push(
    { header: "Odliv (RSD)", width: "auto", numeric: true },
    { header: "Priliv (RSD)", width: "auto", numeric: true },
  );
  return base;
}
