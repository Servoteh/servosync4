import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type { Column, Content, TableCell, TDocumentDefinitions } from "pdfmake/interfaces";
import { PrismaService } from "../../prisma/prisma.service";
import { PdfService } from "../documents/pdf.service";
import { SERVOTEH_LOGO_DATA_URL } from "../documents/servoteh-logo";
import { OpenItemsService, type OpenItem } from "./open-items.service";

/**
 * IOS / NIOS obrazac usaglašavanja (Talas 1E §E3, gap #49).
 * =========================================================================
 * IOS = Izvod otvorenih stavki — zakonski obrazac godišnjeg usaglašavanja
 * salda sa komitentom. Poverilac (naša firma) štampa svoju evidenciju
 * otvorenih stavki komitenta na dan preseka; komitent je overava (saglasnost)
 * ili osporava (upisuje svoj saldo i razliku). NIOS = isti obrazac kada nema
 * otvorenih stavki (saldo 0) — obrazac se svejedno štampa (ne izostaje).
 *
 * Renderer je zajednički `PdfService` (pdfmake 0.3, Roboto pokriva srpski
 * Latin Extended-A) — ISTI put i obrazac kao `RfqPdfService` / `InvoicePdfService`;
 * ovaj servis samo gradi `TDocumentDefinitions` i vraća `Buffer` iz
 * `pdf.render(...)`. Nema nove PDF zavisnosti (pdfmake već u repou).
 *
 * Otvorene stavke se NE materijalizuju — izveden pogled nad `ledger_entries`
 * kroz `OpenItemsService.listOpenItems(undefined, partnerId, asOf)`.
 *
 * NOVAC: Prisma.Decimal (NIKAD Float) — `toFixed` nad Decimal-om, srpski zarez.
 */

const D = Prisma.Decimal;

/** Injektovani (denormalizovani) podaci firme poverioca za zaglavlje. */
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

/** Podaci komitenta (dužnika) iz šifarnika. */
interface PartnerInfo {
  id: number;
  name: string;
  address: string | null;
  postalCode: string | null;
  city: string | null;
  taxId: string | null;
  registrationNumber: string | null;
}

/** Zbir po obrascu — Σ duguje / Σ potražuje / Σ saldo. */
interface Totals {
  debit: Prisma.Decimal;
  credit: Prisma.Decimal;
  balance: Prisma.Decimal;
}

@Injectable()
export class IosPdfService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pdf: PdfService,
    private readonly openItems: OpenItemsService,
  ) {}

  /**
   * Generiši IOS/NIOS PDF za komitenta na dan preseka. `asOf` je default danas.
   * Kada nema otvorenih stavki (NIOS), obrazac se svejedno gradi sa saldom 0.
   * Vraća `{ buffer, fileName }`.
   */
  async buildIosPdf(
    partnerId: number,
    asOf?: Date,
  ): Promise<{ buffer: Buffer; fileName: string }> {
    const cutoff = asOf ?? new Date();

    // Otvorene stavke komitenta (izveden pogled), firma-poverilac i komitent —
    // batch (meki ref na komitenta; orphan pravilo — bez required JOIN-a).
    const [items, issuer, partner] = await Promise.all([
      this.openItems.listOpenItems(undefined, partnerId, cutoff),
      this.loadIssuer(),
      this.loadPartner(partnerId),
    ]);

    const totals = this.sumTotals(items);
    const docDefinition = this.buildDocDefinition({
      items,
      totals,
      issuer,
      partner,
      partnerId,
      asOf: cutoff,
    });

    const buffer = await this.pdf.render(docDefinition);
    const p = (n: number) => String(n).padStart(2, "0");
    const stamp = `${cutoff.getFullYear()}-${p(cutoff.getMonth() + 1)}-${p(cutoff.getDate())}`;
    return { buffer, fileName: `IOS-${partnerId}-${stamp}.pdf` };
  }

  // ------------------------------------------------------------ učitavanje

  /**
   * Firma-poverilac za zaglavlje. Obrazac nema `companyId` (usaglašavanje je na
   * nivou firme), pa se uzima primarna firma (najmanji id); ako je nema →
   * Servoteh fallback (isti obrazac kao `RfqPdfService.loadIssuer`).
   */
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
    return {
      companyName: company.companyName,
      address: company.address,
      city: company.city,
      taxId: company.taxId,
      registrationNumber: company.registrationNumber,
      bankAccount: company.bankAccount,
      phone: company.phone,
      email: company.email,
    };
  }

  /** Komitent (dužnik) iz šifarnika — meki ref; null ako je obrisan/ne postoji. */
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
    if (!c) return null;
    return {
      id: c.id,
      name: c.name,
      address: c.address,
      postalCode: c.postalCode,
      city: c.city,
      taxId: c.taxId,
      registrationNumber: c.registrationNumber,
    };
  }

  private sumTotals(items: OpenItem[]): Totals {
    let debit = new D(0);
    let credit = new D(0);
    let balance = new D(0);
    for (const it of items) {
      debit = debit.add(it.totalDebit);
      credit = credit.add(it.totalCredit);
      balance = balance.add(it.balance);
    }
    return { debit, credit, balance };
  }

  // --------------------------------------------------------- dokument (pdfmake)

  private buildDocDefinition(args: {
    items: OpenItem[];
    totals: Totals;
    issuer: IssuerInfo;
    partner: PartnerInfo | null;
    partnerId: number;
    asOf: Date;
  }): TDocumentDefinitions {
    const { items, totals, issuer, partner, partnerId, asOf } = args;

    const header = this.buildHeader(asOf);
    const parties = this.buildParties(issuer, partner, partnerId);
    const intro = this.buildIntro(asOf);
    const table = this.buildItemsTable(items, totals);
    const summary = this.buildSaldoSummary(totals, asOf);
    const signoff = this.buildSignoff(asOf);

    return {
      pageSize: "A4",
      pageMargins: [32, 32, 32, 40],
      content: [header, parties, intro, table, summary, signoff],
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
        intro: { fontSize: 9, color: "#333", margin: [0, 14, 0, 8] },
        saldo: { fontSize: 11, bold: true, margin: [0, 12, 0, 0] },
        note: { fontSize: 8, color: "#555", margin: [0, 4, 0, 0] },
        boxTitle: { fontSize: 9, bold: true, margin: [0, 0, 0, 4] },
        boxText: { fontSize: 8, color: "#333" },
        signLbl: { fontSize: 8, color: "#555", alignment: "center", margin: [0, 2, 0, 0] },
      },
      defaultStyle: { font: "Roboto", fontSize: 9 },
      footer: (currentPage: number, pageCount: number): Content => ({
        text: `IOS komitent ${partnerId} · ${fmtDate(asOf)} · strana ${currentPage}/${pageCount}`,
        alignment: "center",
        fontSize: 7,
        color: "#888",
        margin: [0, 8, 0, 0],
      }),
    };
  }

  private buildHeader(asOf: Date): Content {
    return {
      columns: [
        { image: SERVOTEH_LOGO_DATA_URL, width: 128 },
        {
          width: "*",
          margin: [12, 4, 0, 0],
          stack: [
            { text: "IZVOD OTVORENIH STAVKI (IOS)", style: "title" },
            {
              text: `Obrazac usaglašavanja salda na dan ${fmtDate(asOf)}`,
              style: "subtitle",
            },
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
      issuer.bankAccount ? `Tekući račun: ${issuer.bankAccount}` : "",
      issuer.email ? `E-pošta: ${issuer.email}` : "",
    ].filter(Boolean);
    const partnerLines = partner
      ? [
          partner.name,
          [partner.address, partner.postalCode, partner.city]
            .filter(Boolean)
            .join(", "),
          partner.taxId ? `PIB: ${partner.taxId}` : "",
          partner.registrationNumber
            ? `Mat. br.: ${partner.registrationNumber}`
            : "",
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
        partyStack("POVERILAC (izdaje izvod)", issuerLines),
        partyStack("DUŽNIK (komitent)", partnerLines),
      ],
      columnGap: 24,
    };
  }

  private buildIntro(asOf: Date): Content {
    return {
      text:
        `Na dan ${fmtDate(asOf)} naše poslovne knjige iskazuju sledeće otvorene stavke i saldo Vašeg konta. ` +
        `Molimo Vas da izvršite proveru i, ukoliko se saldo slaže, da ovaj izvod overite pečatom i potpisom ` +
        `i vratite nam jedan primerak. Ukoliko postoji neslaganje, upišite Vaš saldo u predviđeno polje ` +
        `i navedite razliku, uz obrazloženje.`,
      style: "intro",
    };
  }

  private buildItemsTable(items: OpenItem[], totals: Totals): Content {
    const head = [
      "R.br.",
      "Konto",
      "Dokument",
      "Dospeće",
      "Duguje",
      "Potražuje",
      "Saldo",
    ];
    const widths: (string | number)[] = [
      "auto",
      "auto",
      "*",
      "auto",
      "auto",
      "auto",
      "auto",
    ];
    const headerCells: Content[] = head.map((text, i) => ({
      text,
      style: "th",
      alignment: i <= 2 ? "left" : "right",
    }));

    // TableCell (ne Content) — redovi sa colSpan + {} filer ćelijama (pdfmake API).
    const body: TableCell[][] = [headerCells];

    if (items.length === 0) {
      // NIOS — nema otvorenih stavki; obrazac se svejedno štampa (saldo 0).
      body.push([
        {
          text: "Nema otvorenih stavki na dan preseka (saldo 0,00).",
          italics: true,
          colSpan: 7,
          style: "td",
        },
        {},
        {},
        {},
        {},
        {},
        {},
      ]);
    } else {
      items.forEach((it, idx) => {
        body.push([
          { text: String(idx + 1), style: "td" },
          { text: it.accountCode, style: "td" },
          { text: it.documentNumber ?? "—", style: "td" },
          { text: fmtDate(it.dueDate), style: "tdNum" },
          { text: formatDecimal(it.totalDebit, 2), style: "tdNum" },
          { text: formatDecimal(it.totalCredit, 2), style: "tdNum" },
          { text: formatDecimal(it.balance, 2), style: "tdNum" },
        ]);
      });
    }

    // Zbirni red (Σ) — uvek, i za NIOS (0,00).
    body.push([
      { text: "UKUPNO", style: "totLbl", colSpan: 4 },
      {},
      {},
      {},
      { text: formatDecimal(totals.debit, 2), style: "totNum" },
      { text: formatDecimal(totals.credit, 2), style: "totNum" },
      { text: formatDecimal(totals.balance, 2), style: "totNum" },
    ]);

    return {
      table: {
        headerRows: 1,
        widths,
        body,
      },
      layout: {
        hLineWidth: (i: number) => (i <= 1 ? 0.8 : 0.4),
        vLineWidth: () => 0,
        hLineColor: () => "#cccccc",
        paddingTop: (i: number) => (i === 0 ? 3 : 5),
        paddingBottom: (i: number) => (i === 0 ? 3 : 5),
        paddingLeft: () => 4,
        paddingRight: () => 4,
      },
      margin: [0, 4, 0, 0],
    };
  }

  private buildSaldoSummary(totals: Totals, asOf: Date): Content {
    const abs = totals.balance.abs();
    let inFavor: string;
    if (totals.balance.greaterThan(0)) {
      inFavor = "u našu korist (Vaše dugovanje prema nama)";
    } else if (totals.balance.lessThan(0)) {
      inFavor = "u Vašu korist (naše dugovanje prema Vama)";
    } else {
      inFavor = "saldo je izravnat (0,00)";
    }
    const lines: Content[] = [
      {
        text: `Saldo na dan ${fmtDate(asOf)}: ${formatDecimal(abs, 2)} RSD — ${inFavor}.`,
        style: "saldo",
      },
      { text: "Svi iznosi su izraženi u dinarima (RSD).", style: "note" },
    ];
    return { stack: lines };
  }

  /**
   * Sekcija overe: leva kutija „saglasnost" (dužnik potvrđuje saldo), desna
   * „osporavanje" (dužnik upisuje svoju evidenciju i razliku). Ispod — potpisi
   * obe strane (poverilac / dužnik) sa mestom za pečat (M.P.).
   */
  private buildSignoff(asOf: Date): Content {
    // Column (ne Content) — `width` je dozvoljen samo na elementu unutar `columns`.
    const box = (title: string, textLines: Content[]): Column => ({
      width: "*",
      stack: [{ text: title, style: "boxTitle" }, ...textLines],
      margin: [0, 0, 0, 0],
    });

    const agreeBox = box("SAGLASNOST DUŽNIKA", [
      {
        text: "Saglasni smo sa iskazanim saldom i otvorenim stavkama iz ovog izvoda.",
        style: "boxText",
      },
    ]);

    const disputeBox = box("OSPORAVANJE (popunjava dužnik)", [
      {
        text: `Naša evidencija na dan ${fmtDate(asOf)} pokazuje saldo od ______________________ RSD.`,
        style: "boxText",
        margin: [0, 0, 0, 4],
      },
      {
        text: "Razlika: ______________________ RSD. Obrazloženje: ____________________________.",
        style: "boxText",
      },
    ]);

    const signatureBlock = (label: string): Column => ({
      width: "*",
      stack: [
        {
          canvas: [
            { type: "line", x1: 0, y1: 0, x2: 180, y2: 0, lineWidth: 0.5 },
          ],
          margin: [0, 34, 0, 0],
        },
        { text: label, style: "signLbl" },
        { text: "M.P.", style: "signLbl", margin: [0, 6, 0, 0] },
      ],
    });

    return {
      margin: [0, 20, 0, 0],
      stack: [
        {
          columns: [agreeBox, disputeBox],
          columnGap: 24,
        },
        {
          margin: [0, 10, 0, 0],
          columns: [
            signatureBlock("Za poverioca (izdao)"),
            signatureBlock("Za dužnika (overava komitent)"),
          ],
          columnGap: 40,
        },
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

/**
 * Prisma.Decimal → string sa fiksnim brojem decimala (srpski zarez). NIKAD Float
 * aritmetika — `toFixed` nad Decimal-om.
 */
function formatDecimal(value: Prisma.Decimal, decimals: number): string {
  return value.toFixed(decimals).replace(".", ",");
}
