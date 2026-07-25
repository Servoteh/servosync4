import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type { Content, TDocumentDefinitions, TableCell } from "pdfmake/interfaces";
import { PrismaService } from "../../prisma/prisma.service";
import { PdfService } from "../documents/pdf.service";
import { SERVOTEH_LOGO_DATA_URL } from "../documents/servoteh-logo";

/**
 * KARTICA KOMITENTA — analitička kartica partnera (Talas 2 §A1).
 * =========================================================================
 * Hronološki pregled svih proknjiženih (posted/locked) stavki glavne knjige
 * jednog komitenta (analitička = partnerId), sa running saldo kolonom i
 * početnim stanjem pre datuma `from`. Kao i otvorene stavke — NE materijalizuje
 * se; izveden pogled nad `ledger_entries` × `journal_entries` × `saldakonto_accounts`.
 *
 * OBIM = saldakonto konti (`tracks_open_items = TRUE`) — isti skup kao
 * `OpenItemsService`. Zato se ZATVARANJE kartice slaže sa saldom otvorenih stavki
 * partnera (smoke §2): svaka uparena grupa neto-nula ne menja zbir, pa
 * Σ(sve stavke) == Σ(otvorene stavke). (Izuzetak: ručno zatvaranje sa ostatkom /
 * kursna razlika ostaje na kartici kao stvarni neto saldo — kartica prikazuje
 * istinu, ne open-items projekciju.)
 *
 * Running saldo se računa U KODU (Decimal), ne SQL window-om — čitljivije i
 * egzaktno (Decimal), a skup po jednom partneru je mali.
 *
 * NOVAC: Prisma.Decimal (NIKAD Float) — `toFixed`/aritmetika nad Decimal-om.
 */

const D = Prisma.Decimal;

/** Jedan red kartice — stavka glavne knjige + kumulativni saldo. */
export interface PartnerCardRow {
  ledgerEntryId: number;
  postingDate: Date; // datum knjiženja
  documentDate: Date | null; // datum dokumenta
  accountCode: string;
  journalNumber: string; // broj naloga
  orderTypeCode: string; // vrsta naloga
  documentNumber: string | null;
  description: string | null;
  debit: Prisma.Decimal;
  credit: Prisma.Decimal;
  balance: Prisma.Decimal; // running saldo = opening + Σ(duguje − potražuje) do ovog reda
  dueDate: Date | null;
  reconciledAt: Date | null; // NULL = otvorena stavka
  // Devizni par stavke (C2) — dinarske kolone iznad su PROTIVVREDNOST. NULL kad
  // stavka nije devizna. Aditivno: postojeća polja se ne menjaju.
  fxDebit: Prisma.Decimal | null;
  fxCredit: Prisma.Decimal | null;
  fxAmount: Prisma.Decimal | null; // fxDebit − fxCredit (devizni iznos sa predznakom)
  fxCurrency: string | null;
}

/** Podaci komitenta iz šifarnika (meki ref — null ako je obrisan/ne postoji). */
export interface PartnerInfo {
  id: number;
  name: string;
  address: string | null;
  postalCode: string | null;
  city: string | null;
  taxId: string | null;
  registrationNumber: string | null;
}

/** Kartica komitenta — početno stanje + hronološki redovi + zatvaranje. */
export interface PartnerCard {
  partnerId: number;
  accountCode: string | null;
  from: Date | null;
  to: Date | null;
  opening: Prisma.Decimal; // saldo pre `from` (0 ako nema `from`)
  rows: PartnerCardRow[];
  totalDebit: Prisma.Decimal; // Σ duguje (u opsegu)
  totalCredit: Prisma.Decimal; // Σ potražuje (u opsegu)
  closing: Prisma.Decimal; // opening + Σduguje − Σpotražuje
  partner: PartnerInfo | null;
}

interface IssuerInfo {
  companyName: string;
  address: string | null;
  city: string | null;
  taxId: string | null;
  registrationNumber: string | null;
  bankAccount: string | null;
  phone: string | null;
  email: string | null;
}

interface CardRawRow {
  ledger_entry_id: number;
  posting_date: Date;
  document_date: Date | null;
  account_code: string;
  journal_number: string;
  order_type_code: string;
  document_number: string | null;
  description: string | null;
  debit: Prisma.Decimal | null;
  credit: Prisma.Decimal | null;
  due_date: Date | null;
  reconciled_at: Date | null;
  fx_debit: Prisma.Decimal | null;
  fx_credit: Prisma.Decimal | null;
  fx_currency: string | null;
}

interface OpeningRawRow {
  opening: Prisma.Decimal | null;
}

@Injectable()
export class PartnerCardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pdf: PdfService,
  ) {}

  /**
   * Kartica komitenta — hronološke stavke + running saldo + početno stanje.
   * @param partnerId  analitička = komitent (obavezno)
   * @param accountCode tačan saldakonto konto (opciono; podrazumeva sve saldakonto konte)
   * @param from       početak perioda (opciono; početno stanje = saldo pre `from`)
   * @param to         kraj perioda (opciono; uključivo — poredi se po datumu)
   */
  async getPartnerCard(
    partnerId: number,
    accountCode?: string,
    from?: Date,
    to?: Date,
  ): Promise<PartnerCard> {
    const accountFilter = accountCode
      ? Prisma.sql`AND le.account_code = ${accountCode}`
      : Prisma.empty;
    const fromFilter = from
      ? Prisma.sql`AND je.posting_date::date >= ${from}::date`
      : Prisma.empty;
    const toFilter = to
      ? Prisma.sql`AND je.posting_date::date <= ${to}::date`
      : Prisma.empty;

    // Početno stanje: saldo (Σ duguje − Σ potražuje) svih stavki PRE `from`.
    // Bez `from` nema početnog stanja (kartica od početka evidencije) → opening 0.
    const [openingRows, rawRows, partner] = await Promise.all([
      from
        ? this.prisma.$queryRaw<OpeningRawRow[]>(Prisma.sql`
            SELECT COALESCE(SUM(le.debit) - SUM(le.credit), 0) AS opening
            FROM ledger_entries le
            JOIN journal_entries je ON je.id = le.journal_entry_id
            JOIN saldakonto_accounts sa ON sa.account = le.account_code
            WHERE je.status IN ('POSTED', 'LOCKED')
              AND le.analytical_code = ${partnerId}
              AND sa.tracks_open_items = TRUE
              ${accountFilter}
              AND je.posting_date::date < ${from}::date
          `)
        : Promise.resolve<OpeningRawRow[]>([]),
      this.prisma.$queryRaw<CardRawRow[]>(Prisma.sql`
        SELECT
          le.id              AS ledger_entry_id,
          je.posting_date    AS posting_date,
          je.document_date   AS document_date,
          le.account_code    AS account_code,
          je.number          AS journal_number,
          je.order_type_code AS order_type_code,
          le.document_number AS document_number,
          le.description     AS description,
          le.debit           AS debit,
          le.credit          AS credit,
          le.due_date        AS due_date,
          le.reconciled_at   AS reconciled_at,
          le.fx_debit        AS fx_debit,
          le.fx_credit       AS fx_credit,
          le.fx_currency     AS fx_currency
        FROM ledger_entries le
        JOIN journal_entries je ON je.id = le.journal_entry_id
        JOIN saldakonto_accounts sa ON sa.account = le.account_code
        WHERE je.status IN ('POSTED', 'LOCKED')
          AND le.analytical_code = ${partnerId}
          AND sa.tracks_open_items = TRUE
          ${accountFilter}
          ${fromFilter}
          ${toFilter}
        ORDER BY je.posting_date ASC, le.id ASC
      `),
      this.loadPartner(partnerId),
    ]);

    const opening = new D(openingRows[0]?.opening ?? 0);

    let running = opening;
    let totalDebit = new D(0);
    let totalCredit = new D(0);
    const rows: PartnerCardRow[] = rawRows.map((r) => {
      const debit = new D(r.debit ?? 0);
      const credit = new D(r.credit ?? 0);
      running = running.add(debit).sub(credit);
      totalDebit = totalDebit.add(debit);
      totalCredit = totalCredit.add(credit);
      // Devizni par (C2) — samo kad stavka nosi valutu; inače sve tri kolone null.
      const fxDebit = r.fx_currency ? new D(r.fx_debit ?? 0) : null;
      const fxCredit = r.fx_currency ? new D(r.fx_credit ?? 0) : null;
      return {
        ledgerEntryId: r.ledger_entry_id,
        postingDate: r.posting_date,
        documentDate: r.document_date,
        accountCode: r.account_code,
        journalNumber: r.journal_number,
        orderTypeCode: r.order_type_code,
        documentNumber: r.document_number,
        description: r.description,
        debit,
        credit,
        balance: running,
        dueDate: r.due_date,
        reconciledAt: r.reconciled_at,
        fxDebit,
        fxCredit,
        fxAmount: fxDebit && fxCredit ? fxDebit.sub(fxCredit) : null,
        fxCurrency: r.fx_currency,
      };
    });

    return {
      partnerId,
      accountCode: accountCode ?? null,
      from: from ?? null,
      to: to ?? null,
      opening,
      rows,
      totalDebit,
      totalCredit,
      closing: running,
      partner,
    };
  }

  /**
   * Kartica komitenta kao PDF (obrazac ios-pdf layout): zaglavlje firme + partner,
   * tabela datum / dokument / opis / duguje / potražuje / saldo, zbir. Vraća
   * `{ buffer, fileName }`.
   */
  async buildPartnerCardPdf(
    partnerId: number,
    accountCode?: string,
    from?: Date,
    to?: Date,
  ): Promise<{ buffer: Buffer; fileName: string }> {
    const [card, issuer] = await Promise.all([
      this.getPartnerCard(partnerId, accountCode, from, to),
      this.loadIssuer(),
    ]);

    const docDefinition = this.buildDocDefinition(card, issuer);
    const buffer = await this.pdf.render(docDefinition);

    const stamp = fmtStamp(to ?? new Date());
    return { buffer, fileName: `kartica-komitenta-${partnerId}-${stamp}.pdf` };
  }

  // ------------------------------------------------------------ učitavanje

  private async loadIssuer(): Promise<IssuerInfo> {
    const company = await this.prisma.company.findFirst({
      orderBy: { id: "asc" },
      select: {
        companyName: true,
        address: true,
        city: true,
        taxId: true,
        registrationNumber: true,
        bankAccount: true,
        phone: true,
        email: true,
      },
    });
    if (!company) {
      return {
        companyName: "Servoteh d.o.o.",
        address: null,
        city: null,
        taxId: null,
        registrationNumber: null,
        bankAccount: null,
        phone: null,
        email: null,
      };
    }
    return company;
  }

  private async loadPartner(partnerId: number): Promise<PartnerInfo | null> {
    const c = await this.prisma.customer.findUnique({
      where: { id: partnerId },
      select: {
        id: true,
        name: true,
        address: true,
        postalCode: true,
        city: true,
        taxId: true,
        registrationNumber: true,
      },
    });
    return c ?? null;
  }

  // --------------------------------------------------------- dokument (pdfmake)

  private buildDocDefinition(card: PartnerCard, issuer: IssuerInfo): TDocumentDefinitions {
    return {
      pageSize: "A4",
      pageMargins: [32, 32, 32, 40],
      content: [
        this.buildHeader(card),
        this.buildParties(issuer, card.partner, card.partnerId),
        this.buildItemsTable(card),
        this.buildSummary(card),
      ],
      styles: {
        title: { fontSize: 18, bold: true },
        subtitle: { fontSize: 11, color: "#555", margin: [0, 2, 0, 0] },
        sectionLbl: { fontSize: 8, bold: true, color: "#555" },
        partyName: { fontSize: 11, bold: true },
        partyLine: { fontSize: 9, color: "#333" },
        th: { fontSize: 8, bold: true, fillColor: "#f0f0f0" },
        td: { fontSize: 8 },
        tdNum: { fontSize: 8, alignment: "right" },
        totLbl: { fontSize: 8, bold: true },
        totNum: { fontSize: 8, bold: true, alignment: "right" },
        saldo: { fontSize: 11, bold: true, margin: [0, 12, 0, 0] },
        note: { fontSize: 8, color: "#555", margin: [0, 4, 0, 0] },
      },
      defaultStyle: { font: "Roboto", fontSize: 9 },
      footer: (currentPage: number, pageCount: number): Content => ({
        text: `Kartica komitenta ${card.partnerId} · strana ${currentPage}/${pageCount}`,
        alignment: "center",
        fontSize: 7,
        color: "#888",
        margin: [0, 8, 0, 0],
      }),
    };
  }

  private buildHeader(card: PartnerCard): Content {
    const period =
      card.from || card.to
        ? `Period: ${card.from ? fmtDate(card.from) : "početak"} — ${card.to ? fmtDate(card.to) : "danas"}`
        : "Period: sve stavke";
    return {
      columns: [
        { image: SERVOTEH_LOGO_DATA_URL, width: 128 },
        {
          width: "*",
          margin: [12, 4, 0, 0],
          stack: [
            { text: "KARTICA KOMITENTA", style: "title" },
            { text: period, style: "subtitle" },
          ],
        },
      ],
      columnGap: 8,
    };
  }

  private buildParties(
    issuer: IssuerInfo,
    partner: PartnerInfo | null,
    partnerId: number,
  ): Content {
    const issuerLines = [
      issuer.companyName,
      [issuer.address, issuer.city].filter(Boolean).join(", "),
      issuer.taxId ? `PIB: ${issuer.taxId}` : "",
      issuer.registrationNumber ? `Mat. br.: ${issuer.registrationNumber}` : "",
    ].filter(Boolean);
    const partnerLines = partner
      ? [
          partner.name,
          [partner.address, partner.postalCode, partner.city].filter(Boolean).join(", "),
          partner.taxId ? `PIB: ${partner.taxId}` : "",
          `Šifra komitenta: ${partner.id}`,
        ].filter(Boolean)
      : [`Komitent ${partnerId}`, "(komitent nije u šifarniku)"];

    const partyStack = (title: string, lines: string[]) => ({
      width: "*",
      stack: [
        {
          text: title,
          style: "sectionLbl",
          margin: [0, 0, 0, 3] as [number, number, number, number],
        },
        { text: lines[0] ?? "", style: "partyName" },
        ...lines.slice(1).map((l) => ({ text: l, style: "partyLine" })),
      ],
    });

    return {
      margin: [0, 14, 0, 6],
      columns: [
        partyStack("FIRMA", issuerLines),
        partyStack("KOMITENT", partnerLines),
      ],
      columnGap: 24,
    };
  }

  private buildItemsTable(card: PartnerCard): Content {
    const head = ["R.br.", "Datum", "Dokument", "Opis", "Duguje", "Potražuje", "Saldo"];
    const widths: (string | number)[] = ["auto", "auto", "auto", "*", "auto", "auto", "auto"];
    const headerCells: Content[] = head.map((text, i) => ({
      text,
      style: "th",
      alignment: i >= 4 ? "right" : "left",
    }));

    const body: TableCell[][] = [headerCells];

    // Početno stanje (samo kad postoji `from`) — running kreće od ovog salda.
    if (card.from) {
      body.push([
        { text: "", style: "td" },
        { text: fmtDate(card.from), style: "td" },
        { text: "", style: "td" },
        { text: "Početno stanje", style: "td", italics: true },
        { text: "", style: "tdNum" },
        { text: "", style: "tdNum" },
        { text: formatDecimal(card.opening, 2), style: "tdNum" },
      ]);
    }

    if (card.rows.length === 0) {
      body.push([
        { text: "Nema stavki u izabranom periodu.", italics: true, colSpan: 7, style: "td" },
        {},
        {},
        {},
        {},
        {},
        {},
      ]);
    } else {
      card.rows.forEach((r, idx) => {
        const doc = [r.documentNumber, `${r.orderTypeCode}-${r.journalNumber}`]
          .filter(Boolean)
          .join(" · ");
        body.push([
          { text: String(idx + 1), style: "td" },
          { text: fmtDate(r.postingDate), style: "td" },
          { text: doc || "—", style: "td" },
          { text: r.description ?? "—", style: "td" },
          { text: formatDecimal(r.debit, 2), style: "tdNum" },
          { text: formatDecimal(r.credit, 2), style: "tdNum" },
          { text: formatDecimal(r.balance, 2), style: "tdNum" },
        ]);
      });
    }

    // Zbirni red (Σ duguje / Σ potražuje / zatvaranje).
    body.push([
      { text: "UKUPNO", style: "totLbl", colSpan: 4 },
      {},
      {},
      {},
      { text: formatDecimal(card.totalDebit, 2), style: "totNum" },
      { text: formatDecimal(card.totalCredit, 2), style: "totNum" },
      { text: formatDecimal(card.closing, 2), style: "totNum" },
    ]);

    return {
      table: { headerRows: 1, widths, body },
      layout: {
        hLineWidth: (i: number) => (i <= 1 ? 0.8 : 0.4),
        vLineWidth: () => 0,
        hLineColor: () => "#cccccc",
        paddingTop: (i: number) => (i === 0 ? 3 : 5),
        paddingBottom: (i: number) => (i === 0 ? 3 : 5),
        paddingLeft: () => 4,
        paddingRight: () => 4,
      },
      margin: [0, 10, 0, 0],
    };
  }

  private buildSummary(card: PartnerCard): Content {
    const abs = card.closing.abs();
    let inFavor: string;
    if (card.closing.greaterThan(0)) {
      inFavor = "duguje nama (dugovni saldo)";
    } else if (card.closing.lessThan(0)) {
      inFavor = "potražuje od nas (potražni saldo)";
    } else {
      inFavor = "saldo je izravnat (0,00)";
    }
    return {
      stack: [
        {
          text: `Saldo kartice: ${formatDecimal(abs, 2)} RSD — komitent ${inFavor}.`,
          style: "saldo",
        },
        { text: "Svi iznosi su izraženi u dinarima (RSD).", style: "note" },
      ],
    };
  }
}

// ---------------------------------------------------------------- formatiranje

/** Datum dd.MM.yyyy. (srpski). */
function fmtDate(d: Date | null): string {
  if (!d) return "—";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()}.`;
}

/** yyyy-MM-dd za ime fajla. */
function fmtStamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Prisma.Decimal → string sa fiksnim decimalama (srpski zarez). NIKAD Float. */
function formatDecimal(value: Prisma.Decimal, decimals: number): string {
  return value.toFixed(decimals).replace(".", ",");
}
