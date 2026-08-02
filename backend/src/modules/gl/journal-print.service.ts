/**
 * ŠTAMPA NALOGA ZA KNJIŽENJE (temeljnica) — PDF (Talas 2 A2, BigBit paritet).
 * =========================================================================
 * BigBit „Nalog za knjiženje / Temeljnica": zaglavlje (broj, vrsta, datum) +
 * tabela stavki (konto / naziv konta / komitent / opis / duguje / potražuje) sa
 * Σ redom, i blok potpisa (Sastavio / Kontrolisao / Knjižio). Renderer je
 * zajednički `PdfService` (pdfmake 0.3, Roboto pokriva srpski Latin Extended-A) —
 * ISTI obrazac i put kao `PdvPrintService` / `IosPdfService`; ovaj servis samo
 * gradi `TDocumentDefinitions` i vraća `Buffer`. Bez novih PDF zavisnosti.
 *
 * NOVAC: Prisma.Decimal (NIKAD Float) — `toFixed` nad Decimal-om, srpski zarez.
 */

import { Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type { Column, Content, TableCell, TDocumentDefinitions } from "pdfmake/interfaces";
import { PrismaService } from "../../prisma/prisma.service";
import { PdfService } from "../documents/pdf.service";
import { SERVOTEH_LOGO_DATA_URL } from "../documents/servoteh-logo";
import {
  LOGO_WIDTH,
  buildPageFooter,
  sanitizeText,
} from "../documents/doc-layout";

const D = Prisma.Decimal;
const ZERO = new D(0);

/** Firma izdavalac za zaglavlje obrasca. */
interface IssuerInfo {
  companyName: string;
  address: string | null;
  city: string | null;
  taxId: string | null;
  registrationNumber: string | null;
}

/**
 * Status naloga → čitljiva labela (kanonska mapa GK). Ključevi su VELIKIM slovima
 * jer je `journal_entries.status` prebačen na DRAFT/POSTED/LOCKED (migracija
 * 20260725220000, DB-028) — sa malim ključevima je štampa ispisivala sirovo
 * „POSTED" umesto „Proknjižen". `toUpperCase()` drži i stare zapise.
 */
const STATUS_LABEL: Record<string, string> = {
  DRAFT: "U pripremi",
  POSTED: "Proknjižen",
  LOCKED: "Zaključan",
};

@Injectable()
export class JournalPrintService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pdf: PdfService,
  ) {}

  /**
   * Generiši PDF naloga za knjiženje (temeljnica) po id-u. Vraća `{ buffer, fileName }`.
   * Nepostojeći nalog → 404 (isti obrazac kao gl-read).
   */
  async buildJournalPdf(
    journalEntryId: number,
  ): Promise<{ buffer: Buffer; fileName: string }> {
    const entry = await this.prisma.journalEntry.findUnique({
      where: { id: journalEntryId },
      include: { lines: { orderBy: { id: "asc" } } },
    });
    if (!entry) throw new NotFoundException(`Nalog ${journalEntryId} ne postoji.`);

    const [issuer, orderType, accountNames] = await Promise.all([
      this.loadIssuer(),
      this.loadOrderTypeName(entry.orderTypeCode),
      this.loadAccountNames(entry.lines.map((l) => l.accountCode)),
    ]);

    const docDefinition = this.buildDocDefinition({
      entry,
      issuer,
      orderTypeName: orderType,
      accountNames,
    });

    const buffer = await this.pdf.render(docDefinition);
    const fileName = `nalog-${entry.orderTypeCode}-${entry.number}-${entry.year}.pdf`;
    return { buffer, fileName };
  }

  // ─────────────────────────────────────────────────── učitavanje

  /** Firma izdavalac (primarna firma; Servoteh fallback) — isti obrazac kao PdvPrint. */
  private async loadIssuer(): Promise<IssuerInfo> {
    const company = await this.prisma.company.findFirst({
      orderBy: { id: "asc" },
      select: {
        companyName: true,
        address: true,
        city: true,
        taxId: true,
        registrationNumber: true,
      },
    });
    if (!company) {
      return {
        companyName: "Servoteh d.o.o.",
        address: null,
        city: null,
        taxId: null,
        registrationNumber: null,
      };
    }
    return company;
  }

  /** Naziv vrste naloga (šifarnik OrderType) — meki ref; null ako nema. */
  private async loadOrderTypeName(code: string): Promise<string | null> {
    const ot = await this.prisma.orderType.findUnique({
      where: { code },
      select: { description: true },
    });
    return ot?.description ?? null;
  }

  /** Mapa konto → naziv konta (batch; obrisan konto → bez unosa). */
  private async loadAccountNames(codes: string[]): Promise<Map<string, string>> {
    const unique = [...new Set(codes)];
    if (!unique.length) return new Map();
    const rows = await this.prisma.account.findMany({
      where: { code: { in: unique } },
      select: { code: true, name: true },
    });
    const map = new Map<string, string>();
    for (const r of rows) map.set(r.code, r.name);
    return map;
  }

  // ─────────────────────────────────────────────────── dokument (pdfmake)

  private buildDocDefinition(args: {
    entry: {
      number: string;
      orderTypeCode: string;
      year: number;
      status: string;
      documentDate: Date;
      postingDate: Date;
      lines: {
        accountCode: string;
        analyticalCode: number | null;
        debit: Prisma.Decimal;
        credit: Prisma.Decimal;
        description: string | null;
        documentNumber: string | null;
      }[];
    };
    issuer: IssuerInfo;
    orderTypeName: string | null;
    accountNames: Map<string, string>;
  }): TDocumentDefinitions {
    const { entry, issuer, orderTypeName, accountNames } = args;

    let totalDebit = ZERO;
    let totalCredit = ZERO;

    const th = (t: string, align: "left" | "right" = "left"): Content => ({
      text: t,
      style: "th",
      alignment: align,
    });

    const head: Content[] = [
      th("R.br."),
      th("Konto"),
      th("Naziv konta"),
      th("Komitent", "right"),
      th("Opis"),
      th("Duguje", "right"),
      th("Potražuje", "right"),
    ];

    const bodyRows: TableCell[][] = entry.lines.map((l, idx) => {
      totalDebit = totalDebit.add(l.debit);
      totalCredit = totalCredit.add(l.credit);
      return [
        { text: String(idx + 1), style: "td" },
        { text: l.accountCode, style: "tdCode" },
        { text: accountNames.get(l.accountCode) ?? "—", style: "td" },
        { text: l.analyticalCode != null ? String(l.analyticalCode) : "—", style: "tdNum" },
        { text: l.description ?? "—", style: "td" },
        { text: fmtMoney(l.debit), style: "tdNum" },
        { text: fmtMoney(l.credit), style: "tdNum" },
      ];
    });

    const totalRow: TableCell[] = [
      { text: "UKUPNO", style: "totLbl", colSpan: 5 },
      {},
      {},
      {},
      {},
      { text: fmtMoney(totalDebit), style: "totNum" },
      { text: fmtMoney(totalCredit), style: "totNum" },
    ];

    const balanced = totalDebit.equals(totalCredit);

    return {
      pageSize: "A4",
      pageMargins: [32, 32, 32, 44],
      content: [
        this.buildHeader(entry, orderTypeName),
        this.buildIssuer(issuer),
        {
          table: {
            headerRows: 1,
            widths: ["auto", "auto", "*", "auto", "auto", "auto", "auto"],
            body: [head, ...bodyRows, totalRow],
          },
          layout: tableLayout,
          margin: [0, 12, 0, 0],
        },
        this.buildBalanceNote(balanced, totalDebit, totalCredit),
        this.buildSignoff(),
      ],
      styles: pdfStyles,
      defaultStyle: { font: "Roboto", fontSize: 9 },
      footer: buildPageFooter(
        `Nalog za knjiženje ${entry.orderTypeCode} ${entry.number}/${entry.year}`,
        null,
      ),
    };
  }

  private buildHeader(
    entry: {
      number: string;
      orderTypeCode: string;
      year: number;
      status: string;
      documentDate: Date;
      postingDate: Date;
    },
    orderTypeName: string | null,
  ): Content {
    const vrsta = orderTypeName
      ? `${entry.orderTypeCode} — ${orderTypeName}`
      : entry.orderTypeCode;
    return {
      columns: [
        { image: SERVOTEH_LOGO_DATA_URL, width: LOGO_WIDTH },
        {
          width: "*",
          margin: [12, 4, 0, 0],
          stack: [
            { text: "NALOG ZA KNJIŽENJE", style: "title" },
            { text: `Temeljnica broj ${entry.number}/${entry.year}`, style: "subtitle" },
            {
              margin: [0, 6, 0, 0],
              columns: [
                { width: "*", text: [{ text: "Vrsta: ", style: "metaLbl" }, { text: vrsta, style: "metaVal" }] },
                {
                  width: "auto",
                  text: [
                    { text: "Status: ", style: "metaLbl" },
                    {
                      text: STATUS_LABEL[entry.status.toUpperCase()] ?? entry.status,
                      style: "metaVal",
                    },
                  ],
                },
              ],
            },
            {
              margin: [0, 2, 0, 0],
              columns: [
                {
                  width: "*",
                  text: [
                    { text: "Datum dokumenta: ", style: "metaLbl" },
                    { text: fmtDate(entry.documentDate), style: "metaVal" },
                  ],
                },
                {
                  width: "auto",
                  text: [
                    { text: "Datum knjiženja: ", style: "metaLbl" },
                    { text: fmtDate(entry.postingDate), style: "metaVal" },
                  ],
                },
              ],
            },
          ],
        },
      ],
      columnGap: 8,
    };
  }

  private buildIssuer(issuer: IssuerInfo): Content {
    const lines = [
      issuer.companyName,
      [issuer.address, issuer.city].filter(Boolean).join(", "),
      issuer.taxId ? `PIB: ${issuer.taxId}` : "",
      issuer.registrationNumber ? `Matični broj: ${issuer.registrationNumber}` : "",
    ].filter(Boolean);
    return {
      margin: [0, 14, 0, 0],
      stack: [
        { text: "IZDAVALAC", style: "sectionLbl", margin: [0, 0, 0, 3] },
        { text: lines[0] ?? "", style: "partyName" },
        ...lines.slice(1).map((l) => ({ text: l, style: "partyLine" })),
      ],
    };
  }

  private buildBalanceNote(
    balanced: boolean,
    totalDebit: Prisma.Decimal,
    totalCredit: Prisma.Decimal,
  ): Content {
    if (balanced) {
      return {
        text: "Nalog je uravnotežen (Σ Duguje = Σ Potražuje).",
        style: "note",
        margin: [0, 8, 0, 0],
      };
    }
    return {
      text: `Upozorenje: nalog nije uravnotežen — Σ Duguje ${fmtMoney(totalDebit)} ≠ Σ Potražuje ${fmtMoney(totalCredit)}.`,
      style: "noteWarn",
      margin: [0, 8, 0, 0],
    };
  }

  /** Blok potpisa: Sastavio / Kontrolisao / Knjižio (BigBit obrazac). */
  private buildSignoff(): Content {
    const signatureBlock = (label: string): Column => ({
      width: "*",
      stack: [
        {
          canvas: [{ type: "line", x1: 0, y1: 0, x2: 150, y2: 0, lineWidth: 0.5 }],
          margin: [0, 34, 0, 0],
        },
        { text: label, style: "signLbl" },
      ],
    });
    return {
      margin: [0, 24, 0, 0],
      columns: [
        signatureBlock("Sastavio"),
        signatureBlock("Kontrolisao"),
        signatureBlock("Knjižio"),
      ],
      columnGap: 24,
    };
  }
}

// ─────────────────────────────────────────────────── pomoćne funkcije / stilovi

const tableLayout = {
  hLineWidth: (i: number) => (i <= 1 ? 0.8 : 0.4),
  vLineWidth: () => 0,
  hLineColor: () => "#cccccc",
  paddingTop: (i: number) => (i === 0 ? 3 : 4),
  paddingBottom: (i: number) => (i === 0 ? 3 : 4),
  paddingLeft: () => 4,
  paddingRight: () => 4,
};

const pdfStyles = {
  title: { fontSize: 18, bold: true },
  subtitle: { fontSize: 11, color: "#555", margin: [0, 2, 0, 0] as [number, number, number, number] },
  metaLbl: { fontSize: 8, color: "#777" },
  metaVal: { fontSize: 8, bold: true, color: "#333" },
  sectionLbl: { fontSize: 8, bold: true, color: "#555" },
  partyName: { fontSize: 11, bold: true },
  partyLine: { fontSize: 9, color: "#333" },
  th: { fontSize: 8, bold: true, fillColor: "#f0f0f0" },
  td: { fontSize: 8 },
  tdCode: { fontSize: 8, bold: true },
  tdNum: { fontSize: 8, alignment: "right" as const },
  totLbl: { fontSize: 8, bold: true },
  totNum: { fontSize: 8, bold: true, alignment: "right" as const },
  note: { fontSize: 8, color: "#777", italics: true },
  noteWarn: { fontSize: 8, color: "#b00020", bold: true },
  signLbl: { fontSize: 8, color: "#555", alignment: "center" as const, margin: [0, 2, 0, 0] as [number, number, number, number] },
};

/** Datum dd.MM.yyyy. (srpski). */
function fmtDate(d: Date | null): string {
  if (!d) return "—";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()}.`;
}

/**
 * Prisma.Decimal → srpski novčani zapis (2 decimale, tačka za hiljade, zarez za
 * decimalu). NIKAD Float — `toFixed` nad Decimal-om, pa grupisanje nad stringom.
 */
function fmtMoney(value: Prisma.Decimal): string {
  const fixed = value.toFixed(2);
  const neg = fixed.startsWith("-");
  const [intPart, decPart] = (neg ? fixed.slice(1) : fixed).split(".");
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${neg ? "-" : ""}${grouped},${decPart}`;
}
