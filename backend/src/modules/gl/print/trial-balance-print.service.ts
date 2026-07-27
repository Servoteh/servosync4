/**
 * BRUTO BILANS (zaključni list, BigBit „Bruto stanje") — PDF.
 * =========================================================================
 * Po kontu: početno stanje (nalozi vrste PS), promet u periodu i saldo, sa
 * međuzbirovima po sintetici (3 cifre) i klasi (1 cifra), pa velikim zbirom.
 * Obim = proknjižene i zaključane stavke (`journal_entries.status`), isto što
 * čita i /zavrsni/bruto-bilans — ovo je samo štampani izlaz nad istim ledgerom.
 *
 * BigBit kolone: Konto | Opis | PS Duguje | PS Potražuje | Zbir duguje |
 * Zbir potražuje | Saldo duguje | Saldo potražuje (A4 položeno).
 * Naše dopune: ponovljeno zaglavlje kolona, „strana N/M", traka filtera,
 * kontrolni red (Σ saldo duguje mora = Σ saldo potražuje) i jasna napomena
 * kad nema prometa.
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

/** Vrsta naloga početnog stanja (year-open.service.ts — OPENING_ORDER_TYPE). */
const OPENING_ORDER_TYPE = "PS";

export interface TrialBalanceFilter {
  /** Poslovna godina (obavezna — bruto bilans je uvek za godinu). */
  year: number;
  /** Klasa 0..9 — opcioni filter (BigBit „Za klasu"). */
  accountClass?: string;
  printedBy?: string | null;
}

interface RawRow {
  account_code: string;
  ps_debit: Prisma.Decimal;
  ps_credit: Prisma.Decimal;
  turn_debit: Prisma.Decimal;
  turn_credit: Prisma.Decimal;
}

interface Totals {
  psDebit: Prisma.Decimal;
  psCredit: Prisma.Decimal;
  turnDebit: Prisma.Decimal;
  turnCredit: Prisma.Decimal;
  saldoDebit: Prisma.Decimal;
  saldoCredit: Prisma.Decimal;
}

const COLUMNS: DocColumn[] = [
  { header: "Konto", width: "auto" },
  { header: "Opis", width: "*" },
  { header: "PS duguje", width: "auto", numeric: true },
  { header: "PS potražuje", width: "auto", numeric: true },
  { header: "Promet duguje", width: "auto", numeric: true },
  { header: "Promet potražuje", width: "auto", numeric: true },
  { header: "Saldo duguje", width: "auto", numeric: true },
  { header: "Saldo potražuje", width: "auto", numeric: true },
];

@Injectable()
export class TrialBalancePrintService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pdf: PdfService,
  ) {}

  async buildTrialBalancePdf(
    filter: TrialBalanceFilter,
  ): Promise<{ buffer: Buffer; fileName: string }> {
    const [rows, issuer] = await Promise.all([
      this.loadRows(filter),
      loadIssuer(this.prisma),
    ]);
    const names = await this.loadAccountNames(rows.map((r) => r.account_code));

    const docDefinition = this.buildDocDefinition(rows, names, issuer, filter);
    const buffer = await this.pdf.render(docDefinition);
    return { buffer, fileName: `Bruto-bilans-${filter.year}.pdf` };
  }

  // ───────────────────────────────────────────────────── učitavanje

  private async loadRows(filter: TrialBalanceFilter): Promise<RawRow[]> {
    const classFilter =
      filter.accountClass && filter.accountClass.trim() !== ""
        ? Prisma.sql`AND le.account_code LIKE ${`${filter.accountClass.trim()}%`}`
        : Prisma.empty;
    return this.prisma.$queryRaw<RawRow[]>(Prisma.sql`
      SELECT le.account_code,
             SUM(CASE WHEN je.order_type_code = ${OPENING_ORDER_TYPE} THEN le.debit  ELSE 0 END) AS ps_debit,
             SUM(CASE WHEN je.order_type_code = ${OPENING_ORDER_TYPE} THEN le.credit ELSE 0 END) AS ps_credit,
             SUM(CASE WHEN je.order_type_code <> ${OPENING_ORDER_TYPE} THEN le.debit  ELSE 0 END) AS turn_debit,
             SUM(CASE WHEN je.order_type_code <> ${OPENING_ORDER_TYPE} THEN le.credit ELSE 0 END) AS turn_credit
      FROM ledger_entries le
      JOIN journal_entries je ON je.id = le.journal_entry_id
      WHERE je.status IN ('POSTED', 'LOCKED')
        AND je.year = ${filter.year}
        ${classFilter}
      GROUP BY le.account_code
      ORDER BY le.account_code ASC
    `);
  }

  private async loadAccountNames(
    codes: string[],
  ): Promise<Map<string, string>> {
    const unique = [...new Set(codes)];
    if (unique.length === 0) return new Map();
    const rows = await this.prisma.account.findMany({
      where: { code: { in: unique } },
      select: { code: true, name: true },
    });
    return new Map(rows.map((r) => [r.code, r.name]));
  }

  // ───────────────────────────────────────────────────── dokument

  private buildDocDefinition(
    rows: RawRow[],
    names: Map<string, string>,
    issuer: Awaited<ReturnType<typeof loadIssuer>>,
    filter: TrialBalanceFilter,
  ): TDocumentDefinitions {
    const body: TableCell[][] = [headerRow(COLUMNS)];
    const grand = emptyTotals();

    if (rows.length === 0) {
      body.push(emptyRow(COLUMNS, "NEMA PROKNJIŽENIH STAVKI ZA ZADATU GODINU"));
    } else {
      let classKey = "";
      let synthKey = "";
      let classTotals = emptyTotals();
      let synthTotals = emptyTotals();
      let synthCount = 0;

      const flushSynth = () => {
        if (synthKey !== "" && synthCount > 1) {
          body.push(subtotal(`Σ sintetika ${synthKey}`, synthTotals));
        }
        synthTotals = emptyTotals();
        synthCount = 0;
      };
      const flushClass = () => {
        if (classKey !== "") {
          body.push(subtotal(`Σ KLASA ${classKey}`, classTotals));
        }
        classTotals = emptyTotals();
      };

      for (const r of rows) {
        const cls = r.account_code.slice(0, 1);
        const syn = r.account_code.slice(0, 3);
        if (cls !== classKey) {
          flushSynth();
          flushClass();
          classKey = cls;
          synthKey = "";
        }
        if (syn !== synthKey) {
          flushSynth();
          synthKey = syn;
        }

        const t = rowTotals(r);
        body.push([
          { text: r.account_code, style: "tdCode" },
          { text: names.get(r.account_code) ?? "—", style: "td" },
          { text: fmtMoneyOrBlank(t.psDebit), style: "tdNum" },
          { text: fmtMoneyOrBlank(t.psCredit), style: "tdNum" },
          { text: fmtMoneyOrBlank(t.turnDebit), style: "tdNum" },
          { text: fmtMoneyOrBlank(t.turnCredit), style: "tdNum" },
          { text: fmtMoneyOrBlank(t.saldoDebit), style: "tdNum" },
          { text: fmtMoneyOrBlank(t.saldoCredit), style: "tdNum" },
        ]);
        addTotals(synthTotals, t);
        addTotals(classTotals, t);
        addTotals(grand, t);
        synthCount += 1;
      }
      flushSynth();
      flushClass();
    }

    body.push(
      totalRow(COLUMNS, "VELIKI ZBIR", 2, [
        fmtMoney(grand.psDebit),
        fmtMoney(grand.psCredit),
        fmtMoney(grand.turnDebit),
        fmtMoney(grand.turnCredit),
        fmtMoney(grand.saldoDebit),
        fmtMoney(grand.saldoCredit),
      ]),
    );

    const saldoDiff = grand.saldoDebit.sub(grand.saldoCredit);
    const control: Content = saldoDiff.isZero()
      ? {
          text:
            `Konta: ${rows.length} · Σ saldo duguje ${fmtMoney(grand.saldoDebit)} = ` +
            `Σ saldo potražuje ${fmtMoney(grand.saldoCredit)} — bilans je usklađen.`,
          style: "note",
          margin: [0, 8, 0, 0],
        }
      : {
          text:
            `Konta: ${rows.length} · Σ saldo duguje ${fmtMoney(grand.saldoDebit)} ≠ ` +
            `Σ saldo potražuje ${fmtMoney(grand.saldoCredit)} (razlika ${fmtMoney(saldoDiff)}) — NEUSKLAĐENO.`,
          style: "noteWarn",
          margin: [0, 8, 0, 0],
        };

    const content: Content[] = [
      buildDocHeader({
        title: "BRUTO BILANS",
        subtitle: `Zaključni list za ${filter.year}. godinu`,
        issuer,
        meta: [
          ["Na dan", fmtDate(new Date(Date.UTC(filter.year, 11, 31)))],
          ["Konta", String(rows.length)],
        ],
      }),
      buildFilterStrip([
        ["Godina", String(filter.year)],
        ["Klasa", filter.accountClass ?? "sve"],
        ["Status naloga", "Proknjižen / Zaključan"],
        ["Početno stanje", `nalozi vrste ${OPENING_ORDER_TYPE}`],
        // Obim se ISPISUJE, jer se razlikuje od ekrana „Bruto bilans" na
        // /zavrsni-racun (koji je KUMULATIVAN po `posting_date <= 31.12.`).
        // Bez ove rečenice dva dokumenta istog imena i iste godine daju
        // različite zbirove, a niko sa papira ne vidi zašto.
        [
          "Obim",
          `samo nalozi poslovne godine ${filter.year} (bez kumulativa ranijih godina)`,
        ],
      ]),
    ];
    if (rows.length === 0) {
      content.push(
        buildEmptyNotice("NEMA PROKNJIŽENIH STAVKI ZA ZADATU GODINU"),
      );
    }
    content.push(buildDocTable(COLUMNS, body));
    content.push(control);
    content.push(
      buildSignatureRow(["Sastavio", "Kontrolisao", "Odgovorno lice"]),
    );

    return {
      pageSize: "A4",
      pageOrientation: "landscape",
      pageMargins: PAGE_MARGINS,
      content,
      styles: DOC_STYLES,
      defaultStyle: DEFAULT_STYLE,
      footer: buildPageFooter(`Bruto bilans ${filter.year}`, filter.printedBy),
    };
  }
}

// ───────────────────────────────────────────────────── zbirovi

function emptyTotals(): Totals {
  return {
    psDebit: ZERO,
    psCredit: ZERO,
    turnDebit: ZERO,
    turnCredit: ZERO,
    saldoDebit: ZERO,
    saldoCredit: ZERO,
  };
}

/** Saldo konta: razlika ukupnog duguje/potražuje ide u jednu od dve kolone. */
function rowTotals(r: RawRow): Totals {
  const psDebit = new D(r.ps_debit);
  const psCredit = new D(r.ps_credit);
  const turnDebit = new D(r.turn_debit);
  const turnCredit = new D(r.turn_credit);
  const diff = psDebit.add(turnDebit).sub(psCredit).sub(turnCredit);
  return {
    psDebit,
    psCredit,
    turnDebit,
    turnCredit,
    saldoDebit: diff.greaterThan(0) ? diff : ZERO,
    saldoCredit: diff.lessThan(0) ? diff.abs() : ZERO,
  };
}

function addTotals(acc: Totals, t: Totals): void {
  acc.psDebit = acc.psDebit.add(t.psDebit);
  acc.psCredit = acc.psCredit.add(t.psCredit);
  acc.turnDebit = acc.turnDebit.add(t.turnDebit);
  acc.turnCredit = acc.turnCredit.add(t.turnCredit);
  acc.saldoDebit = acc.saldoDebit.add(t.saldoDebit);
  acc.saldoCredit = acc.saldoCredit.add(t.saldoCredit);
}

function subtotal(label: string, t: Totals): TableCell[] {
  return totalRow(
    COLUMNS,
    label,
    2,
    [
      fmtMoney(t.psDebit),
      fmtMoney(t.psCredit),
      fmtMoney(t.turnDebit),
      fmtMoney(t.turnCredit),
      fmtMoney(t.saldoDebit),
      fmtMoney(t.saldoCredit),
    ],
    "subLbl",
  );
}
