/**
 * PDV ŠTAMPA — PP-PDV obrazac + KIF/KUF specifikacije (Talas 1D §D2).
 * =========================================================================
 * Regulatorni izlaz za poresku predaju: PDF štampa kroz zajednički `PdfService`
 * (pdfmake, Roboto pokriva srpski) — ISTI obrazac kao `InvoicePdfService` i
 * `RfqPdfService`; ovaj servis samo gradi `TDocumentDefinitions` i vraća `Buffer`.
 * Bez novih PDF zavisnosti.
 *
 *   buildPpPdvPdf(period)          — obrazac PP-PDV iz sačuvanog VatReturn-a
 *   buildLedgerSpecPdf(dir, y, m)  — KIF (output) ili KUF (input) specifikacija
 *
 * PP-PDV: zaglavlje obveznika + numerisane pozicije (001–110 koliko ima podataka;
 * ostalo prazno). Osnovica/PDV po stopama izvedeni iz `vat_ledger_entries` (KIF/KUF),
 * zbirne pozicije (105/108/obaveza) iz VatReturn (autoritativan obračun).
 */

import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type { Content, TDocumentDefinitions } from "pdfmake/interfaces";
import { PrismaService } from "../../prisma/prisma.service";
import { PdfService } from "../documents/pdf.service";
import { SERVOTEH_LOGO_DATA_URL } from "../documents/servoteh-logo";
import { vatReturnMonths } from "./vat-period-lock";

const D = Prisma.Decimal;
const ZERO = new D(0);

/** Firma obveznik za zaglavlje obrasca. */
interface IssuerInfo {
  companyName: string;
  address: string | null;
  city: string | null;
  taxId: string | null;
  registrationNumber: string | null;
}

/** Osnovica + PDV po jednoj stopi (agregat iz vat_ledger_entries). */
interface RateSum {
  base: Prisma.Decimal;
  vat: Prisma.Decimal;
}

const PERIOD_RE = /^(\d{4})-(?:(0[1-9]|1[0-2])|[Qq]([1-4]))$/;

@Injectable()
export class PdvPrintService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pdf: PdfService,
  ) {}

  // ─────────────────────────────────────────────────── PP-PDV obrazac

  /**
   * Štampa PP-PDV obrasca za period (`YYYY-MM` mesečni ili `YYYY-Qn` kvartalni).
   * Traži sačuvan `VatReturn` tog perioda (obračun se radi kroz POPDV compute).
   */
  async buildPpPdvPdf(
    period: string,
  ): Promise<{ buffer: Buffer; fileName: string }> {
    const { year, month, quarter } = this.parsePeriod(period);

    const vatReturn = await this.prisma.vatReturn.findFirst({
      where: {
        periodYear: year,
        periodMonth: month ?? null,
        periodQuarter: quarter ?? null,
      },
    });
    if (!vatReturn) {
      throw new NotFoundException(
        `Za period ${period} nema POPDV obračuna. Pokreni obračun (POPDV compute) pre štampe PP-PDV.`,
      );
    }

    const months = vatReturnMonths(month ?? null, quarter ?? null);
    const [issuer, outputByRate, inputByRate] = await Promise.all([
      this.loadIssuer(),
      this.sumByRate("output", year, months),
      this.sumByRate("input", year, months),
    ]);

    const docDefinition = this.buildPpPdvDoc({
      period,
      periodLabel: this.periodHumanLabel(year, month, quarter),
      issuer,
      vatReturn,
      outputByRate,
      inputByRate,
    });

    const buffer = await this.pdf.render(docDefinition);
    return { buffer, fileName: `pp-pdv-${period}.pdf` };
  }

  // ─────────────────────────────────────────────────── KIF/KUF specifikacija

  /**
   * KIF (direction=output) ili KUF (direction=input) specifikacija za mesec:
   * tabela stavki (broj, datum, komitent, stopa, osnovica, PDV) + rekapitulacija
   * po stopama i ukupno.
   */
  async buildLedgerSpecPdf(
    direction: "input" | "output",
    year: number,
    month: number,
  ): Promise<{ buffer: Buffer; fileName: string }> {
    this.assertPeriod(year, month);

    const entries = await this.prisma.vatLedgerEntry.findMany({
      where: { direction, taxPeriodYear: year, taxPeriodMonth: month },
      orderBy: [{ documentDate: "asc" }, { id: "asc" }],
    });

    const [issuer, partnerNames] = await Promise.all([
      this.loadIssuer(),
      this.resolvePartnerNames(entries.map((e) => e.partnerId)),
    ]);

    const docDefinition = this.buildLedgerSpecDoc({
      direction,
      year,
      month,
      issuer,
      entries,
      partnerNames,
    });

    const buffer = await this.pdf.render(docDefinition);
    const book = direction === "output" ? "kif" : "kuf";
    const mm = String(month).padStart(2, "0");
    return { buffer, fileName: `${book}-${year}-${mm}.pdf` };
  }

  // ─────────────────────────────────────────────────── učitavanje / agregacija

  /** Osnovica + PDV po šifri stope za period (Σ iz vat_ledger_entries). */
  private async sumByRate(
    direction: "input" | "output",
    year: number,
    months: number[],
  ): Promise<Map<string, RateSum>> {
    if (months.length === 0) return new Map();
    const grouped = await this.prisma.vatLedgerEntry.groupBy({
      by: ["vatRateCode"],
      where: {
        direction,
        taxPeriodYear: year,
        taxPeriodMonth: { in: months },
      },
      _sum: { vatBase: true, vatAmount: true },
    });
    const map = new Map<string, RateSum>();
    for (const g of grouped) {
      const key = g.vatRateCode ?? "";
      map.set(key, {
        base: new D(g._sum.vatBase ?? ZERO),
        vat: new D(g._sum.vatAmount ?? ZERO),
      });
    }
    return map;
  }

  /** Firma obveznik (primarna firma; Servoteh fallback). */
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

  /** Mapa partnerId → naziv komitenta (meki ref; obrisan partner → bez unosa). */
  private async resolvePartnerNames(
    partnerIds: (number | null)[],
  ): Promise<Map<number, string>> {
    const ids = [
      ...new Set(partnerIds.filter((i): i is number => i != null && i > 0)),
    ];
    if (!ids.length) return new Map();
    const rows = await this.prisma.customer.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true },
    });
    const map = new Map<number, string>();
    for (const r of rows) map.set(r.id, r.name);
    return map;
  }

  // ─────────────────────────────────────────────────── dokument: PP-PDV

  private buildPpPdvDoc(args: {
    period: string;
    periodLabel: string;
    issuer: IssuerInfo;
    vatReturn: {
      outputVat: Prisma.Decimal;
      inputVat: Prisma.Decimal;
      vatLiability: Prisma.Decimal;
      status: string;
    };
    outputByRate: Map<string, RateSum>;
    inputByRate: Map<string, RateSum>;
  }): TDocumentDefinitions {
    const { periodLabel, issuer, vatReturn, outputByRate, inputByRate } = args;

    const out20 = outputByRate.get("20") ?? { base: ZERO, vat: ZERO };
    const out10 = outputByRate.get("10") ?? { base: ZERO, vat: ZERO };
    const outTotalBase = sumBase(outputByRate);
    const inTotalBase = sumBase(inputByRate);
    const liability = new D(vatReturn.vatLiability);
    const owed = liability.gt(ZERO) ? liability : ZERO; // za uplatu
    const credit = liability.lt(ZERO) ? liability.neg() : ZERO; // povraćaj

    // Numerisane pozicije: [broj, opis, osnovica, PDV]. Prazno = "" (nema podataka).
    const rows: [string, string, Prisma.Decimal | null, Prisma.Decimal | null][] = [
      ["001", "Promet oslobođen PDV sa pravom na odbitak prethodnog poreza", null, null],
      ["002", "Promet oslobođen PDV bez prava na odbitak prethodnog poreza", null, null],
      ["003 / 103", "Oporezivi promet i PDV po opštoj stopi (20%)", out20.base, out20.vat],
      ["004 / 104", "Oporezivi promet i PDV po posebnoj stopi (10%)", out10.base, out10.vat],
      ["005 / 105", "Ukupan promet i ukupno obračunati PDV", outTotalBase, new D(vatReturn.outputVat)],
      ["008 / 108", "Prethodni porez — ukupno (pretporez)", inTotalBase, new D(vatReturn.inputVat)],
      ["109", "Poreska obaveza (105 − 108, ako je pozitivno)", null, owed],
      ["110", "Iznos poreskog kredita / povraćaj (108 − 105)", null, credit],
    ];

    const th = (t: string, align: "left" | "right" = "left"): Content => ({
      text: t,
      style: "th",
      alignment: align,
    });

    const body: Content[][] = [
      [th("Poz."), th("Opis pozicije"), th("Osnovica", "right"), th("PDV", "right")],
      ...rows.map(([no, label, base, vat]) => [
        { text: no, style: "tdNum" },
        { text: label, style: "td" },
        { text: base != null ? fmtMoney(base) : "", style: "tdNum" },
        { text: vat != null ? fmtMoney(vat) : "", style: "tdNum" },
      ]),
    ];

    return {
      pageSize: "A4",
      pageMargins: [32, 32, 32, 44],
      content: [
        this.ppPdvHeader(periodLabel),
        this.issuerBlock(issuer),
        { text: "PORESKA PRIJAVA POREZA NA DODATU VREDNOST", style: "sectionTitle", margin: [0, 12, 0, 6] },
        {
          table: { headerRows: 1, widths: ["auto", "*", "auto", "auto"], body },
          layout: tableLayout,
        },
        this.ppPdvSummary(new D(vatReturn.outputVat), new D(vatReturn.inputVat), liability),
        this.disclaimer(),
      ],
      styles: pdfStyles,
      defaultStyle: { font: "Roboto", fontSize: 9 },
      footer: (currentPage: number, pageCount: number): Content => ({
        text: `PP-PDV · ${periodLabel} · strana ${currentPage}/${pageCount}`,
        alignment: "center",
        fontSize: 7,
        color: "#888",
        margin: [0, 8, 0, 0],
      }),
    };
  }

  private ppPdvHeader(periodLabel: string): Content {
    return {
      columns: [
        { image: SERVOTEH_LOGO_DATA_URL, width: 120 },
        {
          width: "*",
          margin: [12, 4, 0, 0],
          stack: [
            { text: "OBRAZAC PP-PDV", style: "title" },
            { text: `Poreski period: ${periodLabel}`, style: "subtitle" },
          ],
        },
      ],
      columnGap: 8,
    };
  }

  private ppPdvSummary(
    output: Prisma.Decimal,
    input: Prisma.Decimal,
    liability: Prisma.Decimal,
  ): Content {
    const label = liability.gte(ZERO)
      ? "Poreska obaveza (za uplatu)"
      : "Poreski kredit (povraćaj)";
    const value = liability.gte(ZERO) ? liability : liability.neg();
    return {
      margin: [0, 14, 0, 0],
      columns: [
        summaryTile("Obračunati PDV (obaveza)", output),
        summaryTile("Prethodni porez (pretporez)", input),
        summaryTile(label, value, true),
      ],
      columnGap: 10,
    };
  }

  // ─────────────────────────────────────────────────── dokument: KIF/KUF spec

  private buildLedgerSpecDoc(args: {
    direction: "input" | "output";
    year: number;
    month: number;
    issuer: IssuerInfo;
    entries: {
      documentNumber: string;
      documentDate: Date;
      partnerId: number | null;
      vatRateCode: string | null;
      vatBase: Prisma.Decimal;
      vatAmount: Prisma.Decimal;
    }[];
    partnerNames: Map<number, string>;
  }): TDocumentDefinitions {
    const { direction, year, month, issuer, entries, partnerNames } = args;
    const bookName = direction === "output" ? "KIF" : "KUF";
    const bookFull =
      direction === "output"
        ? "Knjiga izlaznih faktura (KIF)"
        : "Knjiga ulaznih faktura (KUF)";
    const periodLabel = `${MONTH_NAMES[month - 1]} ${year}.`;

    const th = (t: string, align: "left" | "right" = "left"): Content => ({
      text: t,
      style: "th",
      alignment: align,
    });

    let totalBase = ZERO;
    let totalVat = ZERO;
    const byRate = new Map<string, RateSum>();

    const bodyRows: Content[][] = entries.map((e, idx) => {
      totalBase = totalBase.add(e.vatBase);
      totalVat = totalVat.add(e.vatAmount);
      const rateKey = e.vatRateCode ?? "";
      const acc = byRate.get(rateKey) ?? { base: ZERO, vat: ZERO };
      byRate.set(rateKey, {
        base: acc.base.add(e.vatBase),
        vat: acc.vat.add(e.vatAmount),
      });
      const partner =
        e.partnerId != null ? (partnerNames.get(e.partnerId) ?? `#${e.partnerId}`) : "—";
      return [
        { text: String(idx + 1), style: "td" },
        { text: e.documentNumber, style: "td" },
        { text: fmtDate(e.documentDate), style: "td" },
        { text: partner, style: "td" },
        { text: e.vatRateCode != null ? `${e.vatRateCode}%` : "—", style: "tdNum" },
        { text: fmtMoney(e.vatBase), style: "tdNum" },
        { text: fmtMoney(e.vatAmount), style: "tdNum" },
      ];
    });

    const head: Content[] = [
      th("R.br."),
      th("Dokument"),
      th("Datum"),
      th("Komitent"),
      th("Stopa", "right"),
      th("Osnovica", "right"),
      th("PDV", "right"),
    ];
    const totalRow: Content[] = [
      { text: "", style: "td" },
      { text: "UKUPNO", style: "tdBold" },
      { text: "", style: "td" },
      { text: "", style: "td" },
      { text: "", style: "td" },
      { text: fmtMoney(totalBase), style: "tdBold" },
      { text: fmtMoney(totalVat), style: "tdBold" },
    ];

    const table: Content = entries.length
      ? {
          table: {
            headerRows: 1,
            widths: ["auto", "auto", "auto", "*", "auto", "auto", "auto"],
            body: [head, ...bodyRows, totalRow],
          },
          layout: tableLayout,
        }
      : { text: "Nema stavki za izabrani period.", italics: true, margin: [0, 8, 0, 0] };

    return {
      pageSize: "A4",
      pageOrientation: "landscape",
      pageMargins: [28, 28, 28, 40],
      content: [
        {
          columns: [
            { image: SERVOTEH_LOGO_DATA_URL, width: 110 },
            {
              width: "*",
              margin: [12, 4, 0, 0],
              stack: [
                { text: `${bookName} — specifikacija`, style: "title" },
                { text: `${bookFull} · ${periodLabel}`, style: "subtitle" },
              ],
            },
          ],
          columnGap: 8,
        },
        this.issuerBlock(issuer),
        { text: " ", margin: [0, 4, 0, 0] },
        table,
        this.rateRecap(byRate),
      ],
      styles: pdfStyles,
      defaultStyle: { font: "Roboto", fontSize: 8 },
      footer: (currentPage: number, pageCount: number): Content => ({
        text: `${bookName} ${periodLabel} · strana ${currentPage}/${pageCount}`,
        alignment: "center",
        fontSize: 7,
        color: "#888",
        margin: [0, 8, 0, 0],
      }),
    };
  }

  /** Rekapitulacija osnovice/PDV po stopama (ispod tabele KIF/KUF). */
  private rateRecap(byRate: Map<string, RateSum>): Content {
    const keys = [...byRate.keys()].sort();
    if (!keys.length) return { text: "" };
    const body: Content[][] = [
      [
        { text: "Stopa", style: "th" },
        { text: "Osnovica", style: "th", alignment: "right" },
        { text: "PDV", style: "th", alignment: "right" },
      ],
      ...keys.map((k) => {
        const r = byRate.get(k)!;
        return [
          { text: k === "" ? "bez stope" : `${k}%`, style: "td" },
          { text: fmtMoney(r.base), style: "tdNum" },
          { text: fmtMoney(r.vat), style: "tdNum" },
        ];
      }),
    ];
    return {
      margin: [0, 12, 0, 0],
      columns: [
        { width: "*", text: "" },
        {
          width: "auto",
          stack: [
            { text: "Rekapitulacija po stopama", style: "sectionTitle", margin: [0, 0, 0, 4] },
            { table: { headerRows: 1, widths: ["auto", "auto", "auto"], body }, layout: tableLayout },
          ],
        },
      ],
    };
  }

  // ─────────────────────────────────────────────────── deljeni delovi

  private issuerBlock(issuer: IssuerInfo): Content {
    const lines = [
      issuer.companyName,
      [issuer.address, issuer.city].filter(Boolean).join(", "),
      issuer.taxId ? `PIB: ${issuer.taxId}` : "",
      issuer.registrationNumber ? `Matični broj: ${issuer.registrationNumber}` : "",
    ].filter(Boolean);
    return {
      margin: [0, 12, 0, 0],
      stack: [
        { text: "PORESKI OBVEZNIK", style: "sectionLbl", margin: [0, 0, 0, 3] },
        { text: lines[0] ?? "", style: "partyName" },
        ...lines.slice(1).map((l) => ({ text: l, style: "partyLine" })),
      ],
    };
  }

  private disclaimer(): Content {
    return {
      text:
        "Napomena: obrazac je rekonstruisan iz POPDV obračuna za period; popunjene su " +
        "pozicije za koje postoje proknjižene KIF/KUF stavke, ostale ostaju prazne.",
      style: "note",
      margin: [0, 14, 0, 0],
    };
  }

  // ─────────────────────────────────────────────────── period

  /** Parsira `YYYY-MM` (mesečni) ili `YYYY-Qn` (kvartalni). */
  private parsePeriod(period: string): {
    year: number;
    month: number | null;
    quarter: number | null;
  } {
    const m = typeof period === "string" ? period.trim().match(PERIOD_RE) : null;
    if (!m) {
      throw new BadRequestException(
        "Period mora biti u obliku 'YYYY-MM' (mesečni) ili 'YYYY-Qn' (kvartalni), npr. 2026-07 ili 2026-Q3.",
      );
    }
    const year = Number(m[1]);
    if (m[2] != null) return { year, month: Number(m[2]), quarter: null };
    return { year, month: null, quarter: Number(m[3]) };
  }

  private periodHumanLabel(
    year: number,
    month: number | null,
    quarter: number | null,
  ): string {
    if (month != null) return `${MONTH_NAMES[month - 1]} ${year}. (${String(month).padStart(2, "0")}/${year})`;
    if (quarter != null) return `${quarter}. kvartal ${year}.`;
    return String(year);
  }

  private assertPeriod(year: number, month: number): void {
    if (!Number.isInteger(year) || year < 2000 || year > 2100) {
      throw new BadRequestException(`Nevalidna godina: ${year}.`);
    }
    if (!Number.isInteger(month) || month < 1 || month > 12) {
      throw new BadRequestException(`Nevalidan mesec: ${month}.`);
    }
  }
}

// ─────────────────────────────────────────────────── pomoćne funkcije / stilovi

const MONTH_NAMES = [
  "Januar",
  "Februar",
  "Mart",
  "April",
  "Maj",
  "Jun",
  "Jul",
  "Avgust",
  "Septembar",
  "Oktobar",
  "Novembar",
  "Decembar",
];

/** Σ osnovica po svim stopama u mapi. */
function sumBase(byRate: Map<string, RateSum>): Prisma.Decimal {
  let s = ZERO;
  for (const r of byRate.values()) s = s.add(r.base);
  return s;
}

/** Zbirna pločica (Obračunati PDV / Pretporez / Obaveza). Kolona sa okvirom. */
function summaryTile(label: string, value: Prisma.Decimal, strong = false): Content {
  // `width` (kolona) + `table` nije jedan član Content unije — cast na Content
  // (pdfmake u runtime-u čita `width` na elementu kolone).
  return {
    width: "*",
    table: {
      widths: ["*"],
      body: [
        [{ text: label, style: "tileLabel" }],
        [{ text: fmtMoney(value), style: strong ? "tileValueStrong" : "tileValue" }],
      ],
    },
    layout: {
      hLineWidth: () => 0.4,
      vLineWidth: () => 0.4,
      hLineColor: () => "#cccccc",
      vLineColor: () => "#cccccc",
      paddingTop: () => 4,
      paddingBottom: () => 4,
      paddingLeft: () => 8,
      paddingRight: () => 8,
    },
  } as Content;
}

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
  sectionTitle: { fontSize: 11, bold: true, color: "#333" },
  sectionLbl: { fontSize: 8, bold: true, color: "#555" },
  partyName: { fontSize: 11, bold: true },
  partyLine: { fontSize: 9, color: "#333" },
  th: { fontSize: 8, bold: true, fillColor: "#f0f0f0" },
  td: { fontSize: 8 },
  tdBold: { fontSize: 8, bold: true },
  tdNum: { fontSize: 8, alignment: "right" as const },
  note: { fontSize: 8, color: "#777", italics: true },
  tileLabel: { fontSize: 8, color: "#555" },
  tileValue: { fontSize: 13, bold: true, alignment: "right" as const },
  tileValueStrong: { fontSize: 15, bold: true, alignment: "right" as const },
};

/** Datum dd.MM.yyyy. (srpski). */
function fmtDate(d: Date | null): string {
  if (!d) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()}.`;
}

/**
 * Prisma.Decimal → srpski novčani zapis (2 decimale, tačka za hiljade, zarez za
 * decimalu). NIKAD Float — `toFixed` nad Decimal-om, pa grupisanje nad stringom.
 */
function fmtMoney(value: Prisma.Decimal): string {
  const fixed = value.toFixed(2); // npr. "-1234567.89"
  const neg = fixed.startsWith("-");
  const [intPart, decPart] = (neg ? fixed.slice(1) : fixed).split(".");
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${neg ? "-" : ""}${grouped},${decPart}`;
}
