/**
 * KARTICA KONTA — PDF (BigBit `Kartica konta` / `Kartica analitike`).
 * =========================================================================
 * Sve proknjižene stavke jednog konta hronološki, sa kumulativnim prometom
 * (duguje/potražuje) i tekućim saldom. Isti obim i isti filteri kao ekran
 * „Glavna knjiga → Kartica konta" (`GlReadService.accountCard`): status naloga
 * POSTED/LOCKED, opcioni komitent, mesto troška i period po datumu dokumenta —
 * pa se štampa i ekran ne mogu razići.
 *
 * BigBit kolone: Broj naloga | Vrsta | Datum naloga | Komitent | Broj dokumenta |
 * Dat. dok. | Valuta | Duguje | Potražuje | Promet duguje | Promet potražuje | Opis.
 * Naše dopune: saldo po redu, zaglavlje se ponavlja, „strana N/M", traka filtera,
 * kontrolni red i jasna napomena kad nema stavki.
 *
 * NOVAC: Prisma.Decimal (NIKAD Float).
 */

import { Injectable } from "@nestjs/common";
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
  buildCardControlNote,
  buildDocHeader,
  buildDocTable,
  buildEmptyNotice,
  buildFilterStrip,
  buildPageFooter,
  buildSignatureRow,
  emptyRow,
  fmtDate,
  fmtMoney,
  fmtMoneyOrBlank,
  headerRow,
  loadIssuer,
  totalRow,
  type DocColumn,
} from "./doc-layout";

const D = Prisma.Decimal;
const ZERO = new D(0);

/** Filteri kartice konta — `accountCode` obavezan, ostalo opciono. */
export interface AccountCardFilter {
  accountCode: string;
  analyticalCode?: number;
  costCenter?: string;
  from?: Date;
  to?: Date;
  printedBy?: string | null;
}

interface CardRow {
  journal_number: string;
  order_type_code: string;
  posting_date: Date;
  document_date: Date;
  document_number: string | null;
  analytical_code: number | null;
  cost_center: string | null;
  due_date: Date | null;
  description: string | null;
  debit: Prisma.Decimal;
  credit: Prisma.Decimal;
}

const COLUMNS: DocColumn[] = [
  { header: "R.br.", width: "auto", numeric: true },
  { header: "Nalog", width: "auto" },
  { header: "Vrsta", width: "auto" },
  { header: "Datum naloga", width: "auto" },
  { header: "Komitent", width: 80 },
  { header: "Broj dok.", width: "auto" },
  { header: "Datum dok.", width: "auto" },
  { header: "Valuta", width: "auto" },
  { header: "Opis", width: "*" },
  { header: "Duguje", width: "auto", numeric: true },
  { header: "Potražuje", width: "auto", numeric: true },
  { header: "Saldo", width: "auto", numeric: true },
];

@Injectable()
export class AccountCardPrintService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pdf: PdfService,
  ) {}

  /** Generiši PDF kartice konta. Nepostojeći konto NIJE greška — štampa se prazna kartica. */
  async buildAccountCardPdf(
    filter: AccountCardFilter,
  ): Promise<{ buffer: Buffer; fileName: string }> {
    const code = filter.accountCode.trim();
    const [rows, issuer, account] = await Promise.all([
      this.loadRows({ ...filter, accountCode: code }),
      loadIssuer(this.prisma),
      this.prisma.account.findUnique({
        where: { code },
        select: { name: true },
      }),
    ]);
    const partnerNames = await this.loadPartnerNames(
      rows.map((r) => r.analytical_code).filter((c): c is number => c != null),
    );

    const docDefinition = this.buildDocDefinition(
      rows,
      partnerNames,
      issuer,
      { ...filter, accountCode: code },
      account?.name ?? null,
    );
    const buffer = await this.pdf.render(docDefinition);
    return { buffer, fileName: `Kartica-konta-${code}.pdf` };
  }

  // ───────────────────────────────────────────────────── učitavanje

  private async loadRows(filter: AccountCardFilter): Promise<CardRow[]> {
    return this.prisma.$queryRaw<CardRow[]>(Prisma.sql`
      SELECT je.number AS journal_number,
             je.order_type_code,
             je.posting_date,
             je.document_date,
             le.document_number,
             le.analytical_code,
             le.cost_center,
             le.due_date,
             le.description,
             le.debit,
             le.credit
      FROM ledger_entries le
      JOIN journal_entries je ON je.id = le.journal_entry_id
      WHERE le.account_code = ${filter.accountCode}
        AND je.status IN ('POSTED', 'LOCKED')
        ${filter.analyticalCode != null ? Prisma.sql`AND le.analytical_code = ${filter.analyticalCode}` : Prisma.empty}
        ${filter.costCenter ? Prisma.sql`AND le.cost_center = ${filter.costCenter}` : Prisma.empty}
        ${filter.from ? Prisma.sql`AND je.document_date >= ${filter.from}` : Prisma.empty}
        ${filter.to ? Prisma.sql`AND je.document_date <= ${filter.to}` : Prisma.empty}
      ORDER BY je.document_date ASC, le.id ASC
    `);
  }

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
    rows: CardRow[],
    partnerNames: Map<number, string>,
    issuer: Awaited<ReturnType<typeof loadIssuer>>,
    filter: AccountCardFilter,
    accountName: string | null,
  ): TDocumentDefinitions {
    let totalDebit = ZERO;
    let totalCredit = ZERO;
    let running = ZERO;

    const body: TableCell[][] = [headerRow(COLUMNS)];
    if (rows.length === 0) {
      body.push(emptyRow(COLUMNS, "NEMA STAVKI ZA ZADATE USLOVE"));
    } else {
      rows.forEach((r, idx) => {
        totalDebit = totalDebit.add(r.debit);
        totalCredit = totalCredit.add(r.credit);
        running = running.add(r.debit).sub(r.credit);
        body.push([
          { text: String(idx + 1), style: "tdNum" },
          { text: r.journal_number, style: "tdCode" },
          { text: r.order_type_code, style: "td" },
          { text: fmtDate(r.posting_date), style: "td" },
          {
            text:
              r.analytical_code != null
                ? `${r.analytical_code} ${partnerNames.get(r.analytical_code) ?? ""}`.trim()
                : "",
            style: "td",
          },
          { text: r.document_number ?? "", style: "td" },
          { text: fmtDate(r.document_date), style: "td" },
          { text: r.due_date ? fmtDate(r.due_date) : "", style: "td" },
          { text: r.description ?? "", style: "td" },
          { text: fmtMoneyOrBlank(r.debit), style: "tdNum" },
          { text: fmtMoneyOrBlank(r.credit), style: "tdNum" },
          { text: fmtMoney(running), style: "tdNum" },
        ]);
      });
    }
    body.push(
      totalRow(COLUMNS, "UKUPNO", 9, [
        fmtMoney(totalDebit),
        fmtMoney(totalCredit),
        fmtMoney(running),
      ]),
    );

    const saldoSide = running.isZero()
      ? "saldo je nula"
      : running.greaterThan(0)
        ? "dugovni saldo"
        : "potražni saldo";

    const content: Content[] = [
      buildDocHeader({
        title: "KARTICA KONTA",
        subtitle: `Konto ${filter.accountCode}${accountName ? ` — ${accountName}` : ""}`,
        issuer,
        meta: [
          ["Period", periodLabel(filter.from, filter.to)],
          ["Stavki", String(rows.length)],
          ["Zatvaranje", `${fmtMoney(running)} (${saldoSide})`],
        ],
      }),
      buildFilterStrip([
        ["Konto", filter.accountCode],
        [
          "Komitent",
          filter.analyticalCode != null ? String(filter.analyticalCode) : null,
        ],
        ["Mesto troška", filter.costCenter ?? null],
        ["Od datuma dokumenta", filter.from ? fmtDate(filter.from) : null],
        ["Do datuma dokumenta", filter.to ? fmtDate(filter.to) : null],
      ]),
    ];
    if (rows.length === 0) {
      content.push(buildEmptyNotice("NEMA STAVKI ZA ZADATE USLOVE"));
    }
    content.push(buildDocTable(COLUMNS, body));
    // Na KARTICI razlika duguje/potražuje NIJE greška nego SALDO — zato kartični
    // kontrolni red, a ne knjižni (koji alarmira na svakoj nenultoj razlici).
    content.push(buildCardControlNote(rows.length, totalDebit, totalCredit));
    content.push(buildSignatureRow(["Sastavio", "Kontrolisao"]));

    return {
      pageSize: "A4",
      pageOrientation: "landscape",
      pageMargins: PAGE_MARGINS,
      content,
      styles: DOC_STYLES,
      defaultStyle: DEFAULT_STYLE,
      footer: buildPageFooter(
        `Kartica konta ${filter.accountCode}`,
        filter.printedBy,
      ),
    };
  }
}

function periodLabel(from?: Date, to?: Date): string {
  if (from && to) return `${fmtDate(from)} — ${fmtDate(to)}`;
  if (from) return `od ${fmtDate(from)}`;
  if (to) return `do ${fmtDate(to)}`;
  return "ceo obim";
}
