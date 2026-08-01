/**
 * IZJAVA O KOMPENZACIJI (prebijanje potraživanja i obaveza) — PDF.
 * =========================================================================
 * BigBit uzor je samo delimično poznat: glavni obrazac „Kompenzacija" nije
 * izvezen (pao na linkovanim tabelama), poznati su podizveštaji `R Kompenzacije D`
 * / `R Kompenzacije K` — telo je par naspramnih tabela pod natpisom
 * „OBAVEZE POVERIOCA PREMA DUŽNIKU" (kolone Datum | Dokument | Iznos, red „Svega:").
 * Taj raspored je zadržan, a okvir (zaglavlje, strane, potpisi, N/M) je ServoSync
 * obrazac. Pravni osnov u tekstu je čl. 336 ZOO (prebijanje).
 *
 * Sadržaj: dve tabele po stranama kompenzacije (naša potraživanja koja se
 * zatvaraju / naše obaveze koje se zatvaraju), zbir svake strane, prebijeni iznos
 * brojem i SLOVIMA, kontrola bilateralnog bilansa (Σ potraživanja = Σ obaveza) i
 * dva potpisna mesta sa M.P.
 *
 * NOVAC: Prisma.Decimal (NIKAD Float). Renderer: zajednički `PdfService`.
 */

import { Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type {
  Content,
  TableCell,
  TDocumentDefinitions,
} from "pdfmake/interfaces";
import { PrismaService } from "../../prisma/prisma.service";
import { PdfService } from "../documents/pdf.service";
import {
  DEFAULT_STYLE,
  DOC_STYLES,
  PAGE_MARGINS,
  amountInWords,
  buildDocHeader,
  buildDocTable,
  buildParties,
  buildPageFooter,
  buildSignatureRow,
  emptyRow,
  fmtDate,
  fmtMoney,
  headerRow,
  issuerLines,
  loadIssuer,
  totalRow,
  type DocColumn,
  type IssuerInfo,
  type StatusBadge,
} from "../gl/print/doc-layout";

const D = Prisma.Decimal;
const ZERO = new D(0);

const STATUS_BADGE: Record<string, StatusBadge> = {
  DRAFT: { label: "Predlog", tone: "warn" },
  CONFIRMED: { label: "Potvrđeno", tone: "neutral" },
  POSTED: { label: "Proknjiženo", tone: "ok" },
};

/** Kolone jedne strane prebijanja. */
const COLUMNS: DocColumn[] = [
  { header: "R.br.", width: "auto", numeric: true },
  { header: "Konto", width: "auto" },
  { header: "Broj dokumenta", width: "auto" },
  { header: "Datum dokumenta", width: "auto" },
  { header: "Dospeće", width: "auto" },
  { header: "Opis", width: "*" },
  { header: "Iznos prebijanja", width: "auto", numeric: true },
];

interface LineView {
  accountCode: string;
  documentNumber: string | null;
  documentDate: Date | null;
  dueDate: Date | null;
  description: string | null;
  amount: Prisma.Decimal;
}

@Injectable()
export class CompensationPdfService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pdf: PdfService,
  ) {}

  /**
   * Generiši PDF izjave o kompenzaciji po id-u naloga kompenzacije.
   * Nepostojeća kompenzacija → 404. Kompenzacija bez linija se ŠTAMPA (prazan
   * predlog) uz jasnu napomenu, ne puca.
   */
  async buildCompensationPdf(
    compensationId: number,
    printedBy?: string | null,
  ): Promise<{ buffer: Buffer; fileName: string }> {
    const order = await this.prisma.compensationOrder.findUnique({
      where: { id: compensationId },
      include: { lines: { orderBy: { lineNo: "asc" } } },
    });
    if (!order) {
      throw new NotFoundException(`Kompenzacija ${compensationId} ne postoji.`);
    }

    const ledgerIds = order.lines
      .map((l) => l.ledgerEntryId)
      .filter((id): id is number => id != null);

    const [issuer, partner, ledger] = await Promise.all([
      loadIssuer(this.prisma),
      this.prisma.customer.findUnique({
        where: { id: order.partnerId },
        select: {
          id: true,
          name: true,
          address: true,
          postalCode: true,
          city: true,
          taxId: true,
          registrationNumber: true,
        },
      }),
      ledgerIds.length
        ? this.prisma.ledgerEntry.findMany({
            where: { id: { in: ledgerIds } },
            select: {
              id: true,
              accountCode: true,
              documentNumber: true,
              dueDate: true,
              description: true,
              journalEntry: { select: { documentDate: true } },
            },
          })
        : Promise.resolve([]),
    ]);

    const ledgerMap = new Map(ledger.map((l) => [l.id, l]));
    const toView = (line: {
      ledgerEntryId: number | null;
      amount: Prisma.Decimal;
    }): LineView => {
      const le =
        line.ledgerEntryId != null
          ? ledgerMap.get(line.ledgerEntryId)
          : undefined;
      return {
        accountCode: le?.accountCode ?? "—",
        documentNumber: le?.documentNumber ?? null,
        documentDate: le?.journalEntry?.documentDate ?? null,
        dueDate: le?.dueDate ?? null,
        description: le?.description ?? null,
        amount: line.amount,
      };
    };

    const receivable = order.lines
      .filter((l) => l.side === "receivable")
      .map(toView);
    const payable = order.lines.filter((l) => l.side === "payable").map(toView);

    const docDefinition = this.buildDocDefinition({
      order,
      issuer,
      partner,
      receivable,
      payable,
      printedBy,
    });
    const buffer = await this.pdf.render(docDefinition);
    const safeNumber = order.compensationNumber.replace(/[^\w.-]+/g, "_");
    return { buffer, fileName: `Kompenzacija-${safeNumber}.pdf` };
  }

  // ───────────────────────────────────────────────────── dokument

  private buildDocDefinition(args: {
    order: {
      id: number;
      compensationNumber: string;
      date: Date;
      status: string;
      totalAmount: Prisma.Decimal;
      journalEntryId: number | null;
      partnerId: number;
    };
    issuer: IssuerInfo;
    partner: {
      id: number;
      name: string;
      address: string | null;
      postalCode: string | null;
      city: string | null;
      taxId: string | null;
      registrationNumber: string | null;
    } | null;
    receivable: LineView[];
    payable: LineView[];
    printedBy?: string | null;
  }): TDocumentDefinitions {
    const { order, issuer, partner, receivable, payable, printedBy } = args;

    const sumReceivable = receivable.reduce((a, l) => a.add(l.amount), ZERO);
    const sumPayable = payable.reduce((a, l) => a.add(l.amount), ZERO);
    const balanced = sumReceivable.equals(sumPayable);
    const offset = sumReceivable.lessThan(sumPayable)
      ? sumReceivable
      : sumPayable;

    const partnerLines = partner
      ? [
          partner.name,
          [partner.address, partner.postalCode, partner.city]
            .filter(Boolean)
            .join(", "),
          partner.taxId ? `PIB: ${partner.taxId}` : "",
          partner.registrationNumber
            ? `Matični broj: ${partner.registrationNumber}`
            : "",
          `Šifra komitenta: ${partner.id}`,
        ].filter(Boolean)
      : [`Komitent ${order.partnerId}`, "(komitent nije u šifarniku)"];

    const content: Content[] = [
      buildDocHeader({
        title: "IZJAVA O KOMPENZACIJI",
        subtitle: `Kompenzacija broj ${order.compensationNumber}`,
        issuer,
        meta: [
          ["Datum", fmtDate(order.date)],
          [
            "Nalog u glavnoj knjizi",
            order.journalEntryId != null
              ? `#${order.journalEntryId}`
              : "nije proknjiženo",
          ],
        ],
        badge: STATUS_BADGE[order.status] ?? {
          label: order.status,
          tone: "neutral",
        },
      }),
      buildParties(
        { title: "PRVA STRANA (izdavalac izjave)", lines: issuerLines(issuer) },
        { title: "DRUGA STRANA (komitent)", lines: partnerLines },
      ),
      {
        text:
          "Na osnovu člana 336. Zakona o obligacionim odnosima, ugovorne strane saglasno utvrđuju da se " +
          "međusobna dospela potraživanja i obaveze iskazane u nastavku prebijaju (kompenziraju) do iznosa " +
          "manjeg potraživanja. Prebijanjem obaveze prestaju do prebijenog iznosa, a eventualna razlika ostaje " +
          "otvorena i izmiruje se na uobičajen način.",
        style: "intro",
        margin: [0, 12, 0, 0],
      },
      {
        text: "I  NAŠA POTRAŽIVANJA OD DRUGE STRANE (zatvaraju se prebijanjem)",
        style: "sectionTitle",
      },
      ...this.buildSideTable(receivable, sumReceivable),
      {
        text: "II  NAŠE OBAVEZE PREMA DRUGOJ STRANI (zatvaraju se prebijanjem)",
        style: "sectionTitle",
      },
      ...this.buildSideTable(payable, sumPayable),
      this.buildSummary(offset, sumReceivable, sumPayable, balanced),
      buildSignatureRow(
        [
          `Za ${issuer.companyName}`,
          `Za ${partner?.name ?? `komitenta ${order.partnerId}`}`,
        ],
        true,
      ),
    ];

    return {
      pageSize: "A4",
      pageMargins: PAGE_MARGINS,
      content,
      styles: DOC_STYLES,
      defaultStyle: DEFAULT_STYLE,
      footer: buildPageFooter(
        `Kompenzacija ${order.compensationNumber}`,
        printedBy,
      ),
    };
  }

  /** Jedna strana prebijanja: tabela stavki + red „Svega". */
  private buildSideTable(lines: LineView[], total: Prisma.Decimal): Content[] {
    const body: TableCell[][] = [headerRow(COLUMNS)];
    if (lines.length === 0) {
      body.push(emptyRow(COLUMNS, "Nema stavki na ovoj strani prebijanja."));
    } else {
      lines.forEach((l, idx) => {
        body.push([
          { text: String(idx + 1), style: "tdNum" },
          { text: l.accountCode, style: "tdCode" },
          { text: l.documentNumber ?? "—", style: "td" },
          { text: fmtDate(l.documentDate), style: "td" },
          { text: fmtDate(l.dueDate), style: "td" },
          { text: l.description ?? "", style: "td" },
          { text: fmtMoney(l.amount), style: "tdNum" },
        ]);
      });
    }
    body.push(totalRow(COLUMNS, "SVEGA", 6, [fmtMoney(total)]));
    return [buildDocTable(COLUMNS, body)];
  }

  /** Prebijeni iznos brojem i slovima + kontrola bilateralnog bilansa. */
  private buildSummary(
    offset: Prisma.Decimal,
    sumReceivable: Prisma.Decimal,
    sumPayable: Prisma.Decimal,
    balanced: boolean,
  ): Content {
    const stack: Content[] = [
      {
        text: `Prebijeni (kompenzirani) iznos: ${fmtMoney(offset)} RSD`,
        style: "grand",
        margin: [0, 14, 0, 0],
      },
      {
        text: `Slovima: ${amountInWords(offset)}`,
        style: "words",
        margin: [0, 2, 0, 0],
      },
    ];
    // Prazna kompenzacija je „usklađena" (0 = 0), pa bi se bez ovog uslova
    // odštampala kao VAŽEĆA izjava sa dva mesta za potpis i pečat — dokument
    // koji ne prebija ništa, a poziva obe strane da ga potpišu.
    const empty =
      offset.isZero() && sumReceivable.isZero() && sumPayable.isZero();
    stack.push(
      empty
        ? {
            text: "KOMPENZACIJA NEMA STAVKI — izjava se ne sme potpisati. Dodaj stavke prebijanja pa ponovi štampu.",
            style: "noteWarn",
            margin: [0, 6, 0, 0],
          }
        : balanced
          ? {
              text: `Kontrola: Σ potraživanja ${fmtMoney(sumReceivable)} = Σ obaveza ${fmtMoney(sumPayable)} — prebijanje je bilateralno usklađeno.`,
              style: "note",
              margin: [0, 6, 0, 0],
            }
          : {
              text: `NEUSKLAĐENO: Σ potraživanja ${fmtMoney(sumReceivable)} ≠ Σ obaveza ${fmtMoney(sumPayable)} — izjava se ne sme potpisati dok se strane ne izjednače.`,
              style: "noteWarn",
              margin: [0, 6, 0, 0],
            },
    );
    return { unbreakable: true, stack };
  }
}
