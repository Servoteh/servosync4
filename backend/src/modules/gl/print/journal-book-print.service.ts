/**
 * DNEVNIK KNJIŽENJA (dnevnik glavne knjige) — PDF.
 * =========================================================================
 * BigBit `DnevnikGK` (RecordSource „Dnevnik glavne knjige"): hronološki spisak
 * SVIH proknjiženih stavki glavne knjige u periodu, sa kolonama
 * R.br. / Konto / Broj naloga / Vrsta / Datum naloga / Šifra kom. / Komitent /
 * Broj dokumenta / Datum dok. / Duguje / Potražuje i zbirom na kraju.
 *
 * Naše dopune preko BigBita (v. „Uzor" §B):
 *   • A4 POLOŽENO + ponovljeno zaglavlje kolona na svakoj strani (BigBit ga ima
 *     samo kroz PageHeader sekciju),
 *   • „strana N/M" (BigBit štampa samo [Page] — ne vidi se da fali strana),
 *   • traka primenjenih filtera (dokazivost izveštaja),
 *   • kontrolni red „Redova: N · Σ duguje · Σ potražuje · razlika" sa crvenim
 *     „NEUSKLAĐENO" kad razlika nije nula,
 *   • prazan izveštaj se štampa sa jasnom napomenom, ne kao nema nula.
 *
 * NOVAC: Prisma.Decimal (NIKAD Float). Renderer: zajednički `PdfService`.
 */

import { BadRequestException, Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type {
  Content,
  TableCell,
  TDocumentDefinitions,
} from "pdfmake/interfaces";
import { PrismaService } from "../../../prisma/prisma.service";
import { PdfService } from "../../documents/pdf.service";
import {
  DEFAULT_STYLE,
  DOC_STYLES,
  PAGE_MARGINS,
  buildControlNote,
  buildDocHeader,
  buildDocTable,
  buildEmptyNotice,
  buildFilterStrip,
  buildPageFooter,
  buildSignatureRow,
  emptyRow,
  fmtDate,
  fmtMoneyOrBlank,
  fmtMoney,
  headerRow,
  loadIssuer,
  totalRow,
  type DocColumn,
} from "./doc-layout";

const D = Prisma.Decimal;
const ZERO = new D(0);

/** Filteri dnevnika — svi opcioni (bez njih ide ceo proknjižen obim). */
export interface JournalBookFilter {
  from?: Date;
  to?: Date;
  orderType?: string;
  year?: number;
  /** Ko štampa (ime i prezime) — ide u nogu dokumenta. */
  printedBy?: string | null;
}

interface BookRow {
  journal_number: string;
  order_type_code: string;
  posting_date: Date;
  document_date: Date;
  account_code: string;
  analytical_code: number | null;
  document_number: string | null;
  description: string | null;
  debit: Prisma.Decimal;
  credit: Prisma.Decimal;
}

/**
 * Tvrda kapa broja stavki po dokumentu. Preko ovoga PDF prestaje da bude
 * upotrebljiv (stotine strana), a render blokira jednonitni Nest proces.
 */
const MAX_ROWS = 20000;

/** Kolone dnevnika (položeno A4). */
const COLUMNS: DocColumn[] = [
  { header: "R.br.", width: "auto", numeric: true },
  { header: "Nalog", width: "auto" },
  { header: "Vrsta", width: "auto" },
  { header: "Datum naloga", width: "auto" },
  { header: "Konto", width: "auto" },
  { header: "Šifra kom.", width: "auto", numeric: true },
  { header: "Komitent", width: 90 },
  { header: "Broj dokumenta", width: "auto" },
  { header: "Datum dok.", width: "auto" },
  { header: "Opis", width: "*" },
  { header: "Duguje", width: "auto", numeric: true },
  { header: "Potražuje", width: "auto", numeric: true },
];

@Injectable()
export class JournalBookPrintService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pdf: PdfService,
  ) {}

  /**
   * Generiši PDF dnevnika glavne knjige za zadate filtere.
   *
   * OBIM JE OBAVEZAN: bez godine ili perioda ova ruta sinhrono renderuje CEO
   * ledger (mereno na dev bazi: 20.366 stavki → 4,8 MB, 757 strana, ~16 s CPU-a
   * u jednonitnom Nest procesu — za to vreme cela aplikacija stoji). Zato traži
   * `year` ili `from`/`to`, a preko `MAX_ROWS` odbija sa jasnom porukom.
   */
  async buildJournalBookPdf(
    filter: JournalBookFilter,
  ): Promise<{ buffer: Buffer; fileName: string }> {
    if (filter.year == null && !filter.from && !filter.to) {
      throw new BadRequestException(
        "Dnevnik se štampa za zadati obim — izaberi godinu ili period (od/do datuma knjiženja).",
      );
    }
    const [rows, issuer] = await Promise.all([
      this.loadRows(filter),
      loadIssuer(this.prisma),
    ]);
    if (rows.length > MAX_ROWS) {
      throw new BadRequestException(
        `Dnevnik za zadati obim ima ${rows.length} stavki (najviše ${MAX_ROWS} po dokumentu). ` +
          "Suzi period ili izaberi vrstu naloga.",
      );
    }
    const partnerNames = await this.loadPartnerNames(
      rows.map((r) => r.analytical_code).filter((c): c is number => c != null),
    );

    const docDefinition = this.buildDocDefinition(
      rows,
      partnerNames,
      issuer,
      filter,
    );
    const buffer = await this.pdf.render(docDefinition);
    const stamp = filter.year ? String(filter.year) : new Date().getFullYear();
    return { buffer, fileName: `Dnevnik-knjizenja-${stamp}.pdf` };
  }

  // ───────────────────────────────────────────────────── učitavanje

  private async loadRows(filter: JournalBookFilter): Promise<BookRow[]> {
    return this.prisma.$queryRaw<BookRow[]>(Prisma.sql`
      SELECT je.number       AS journal_number,
             je.order_type_code,
             je.posting_date,
             je.document_date,
             le.account_code,
             le.analytical_code,
             le.document_number,
             le.description,
             le.debit,
             le.credit
      FROM ledger_entries le
      JOIN journal_entries je ON je.id = le.journal_entry_id
      WHERE je.status IN ('POSTED', 'LOCKED')
        ${filter.orderType ? Prisma.sql`AND je.order_type_code = ${filter.orderType}` : Prisma.empty}
        ${filter.year != null ? Prisma.sql`AND je.year = ${filter.year}` : Prisma.empty}
        ${filter.from ? Prisma.sql`AND je.posting_date >= ${filter.from}` : Prisma.empty}
        ${filter.to ? Prisma.sql`AND je.posting_date <= ${filter.to}` : Prisma.empty}
      ORDER BY je.posting_date ASC, je.order_type_code ASC, je.number ASC, le.id ASC
    `);
  }

  /** Nazivi komitenata (batch; obrisan komitent → bez unosa). */
  private async loadPartnerNames(
    codes: number[],
  ): Promise<Map<number, string>> {
    const unique = [...new Set(codes)];
    if (unique.length === 0) return new Map();
    const rows = await this.prisma.customer.findMany({
      where: { id: { in: unique } },
      select: { id: true, name: true },
    });
    return new Map(rows.map((r) => [r.id, r.name]));
  }

  // ───────────────────────────────────────────────────── dokument

  private buildDocDefinition(
    rows: BookRow[],
    partnerNames: Map<number, string>,
    issuer: Awaited<ReturnType<typeof loadIssuer>>,
    filter: JournalBookFilter,
  ): TDocumentDefinitions {
    let totalDebit = ZERO;
    let totalCredit = ZERO;

    const body: TableCell[][] = [headerRow(COLUMNS)];
    if (rows.length === 0) {
      body.push(emptyRow(COLUMNS, "NEMA STAVKI ZA ZADATE USLOVE"));
    } else {
      rows.forEach((r, idx) => {
        totalDebit = totalDebit.add(r.debit);
        totalCredit = totalCredit.add(r.credit);
        body.push([
          { text: String(idx + 1), style: "tdNum" },
          { text: r.journal_number, style: "tdCode" },
          { text: r.order_type_code, style: "td" },
          { text: fmtDate(r.posting_date), style: "td" },
          { text: r.account_code, style: "tdCode" },
          {
            text: r.analytical_code != null ? String(r.analytical_code) : "",
            style: "tdNum",
          },
          {
            text:
              r.analytical_code != null
                ? (partnerNames.get(r.analytical_code) ?? "—")
                : "",
            style: "td",
          },
          { text: r.document_number ?? "", style: "td" },
          { text: fmtDate(r.document_date), style: "td" },
          { text: r.description ?? "", style: "td" },
          { text: fmtMoneyOrBlank(r.debit), style: "tdNum" },
          { text: fmtMoneyOrBlank(r.credit), style: "tdNum" },
        ]);
      });
    }
    body.push(
      totalRow(COLUMNS, "UKUPNO", 10, [
        fmtMoney(totalDebit),
        fmtMoney(totalCredit),
      ]),
    );

    const content: Content[] = [
      buildDocHeader({
        title: "DNEVNIK KNJIŽENJA",
        subtitle: "Dnevnik glavne knjige — proknjižene i zaključane stavke",
        issuer,
        meta: [
          ["Period", periodLabel(filter.from, filter.to)],
          ["Stavki", String(rows.length)],
        ],
      }),
      buildFilterStrip([
        ["Od datuma knjiženja", filter.from ? fmtDate(filter.from) : null],
        ["Do datuma knjiženja", filter.to ? fmtDate(filter.to) : null],
        ["Vrsta naloga", filter.orderType ?? null],
        ["Godina", filter.year != null ? String(filter.year) : null],
        ["Status naloga", "Proknjižen / Zaključan"],
      ]),
    ];
    if (rows.length === 0) {
      content.push(buildEmptyNotice("NEMA STAVKI ZA ZADATE USLOVE"));
    }
    content.push(buildDocTable(COLUMNS, body));
    content.push(buildControlNote(rows.length, totalDebit, totalCredit));
    content.push(buildSignatureRow(["Sastavio", "Kontrolisao", "Knjižio"]));

    return {
      pageSize: "A4",
      pageOrientation: "landscape",
      pageMargins: PAGE_MARGINS,
      content,
      styles: DOC_STYLES,
      defaultStyle: DEFAULT_STYLE,
      footer: buildPageFooter("Dnevnik knjiženja", filter.printedBy),
    };
  }
}

/** Čitljiv opis perioda za zaglavlje. */
function periodLabel(from?: Date, to?: Date): string {
  if (from && to) return `${fmtDate(from)} — ${fmtDate(to)}`;
  if (from) return `od ${fmtDate(from)}`;
  if (to) return `do ${fmtDate(to)}`;
  return "ceo obim";
}
