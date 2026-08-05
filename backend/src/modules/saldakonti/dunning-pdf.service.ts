import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type {
  Content,
  TableCell,
  TDocumentDefinitions,
} from "pdfmake/interfaces";
import { companyAddressLine } from "../../common/company-address";
import { PrismaService } from "../../prisma/prisma.service";
import { PdfService } from "../documents/pdf.service";
import { SERVOTEH_LOGO_DATA_URL } from "../documents/servoteh-logo";
import {
  LOGO_WIDTH,
  buildPageFooter,
  buildSignatureRow,
  fmtMoney,
  sanitizeText,
} from "../documents/doc-layout";
import {
  OpenItemsService,
  isCustomerReceivable,
  type OpenItem,
} from "./open-items.service";

/**
 * OPOMENA (dunning) PDF — Talas 3 B6.
 * =========================================================================
 * Pregled dospelih neizmirenih obaveza komitenta na dan preseka, po nivou
 * opomene (1/2/3). Isti obrazac/renderer kao IOS (`ios-pdf.service.ts`):
 * zajednički `PdfService` (pdfmake), Servoteh zaglavlje, tabela otvorenih
 * stavki komitenta i zbir — samo je tekst/naslov po nivou (poslednji nivo je
 * OPOMENA PRED UTUŽENJE) i nema polja za overu (opomena je jednosmerna).
 *
 * Otvorene stavke se NE materijalizuju — izveden pogled nad `ledger_entries`
 * kroz `OpenItemsService.listOpenItems`. Dunning je nad KUPČEVIM POTRAŽIVANJIMA
 * (side=receivable I partner_scope=customer, dugovni saldo) — kupci koji nama duguju.
 * Pre popravke (04.08.2026) je filter bio samo `side === "receivable"`, pa se dati
 * avans dobavljaču (1520, dugovni saldo) štampao kao njegov dug na opomeni.
 *
 * NOVAC: Prisma.Decimal (NIKAD Float) — `toFixed` nad Decimal-om, srpski zarez.
 */

const D = Prisma.Decimal;

/** Nivo 1|2|3 → naslov obrasca. Poslednji nivo nosi najavu utuženja. */
const LEVEL_TITLE: Record<number, string> = {
  1: "OPOMENA",
  2: "OPOMENA",
  3: "OPOMENA PRED UTUŽENJE",
};

/** Uvodni tekst po nivou (ton raste — podsećanje → poslednja opomena). */
const LEVEL_INTRO: Record<number, string> = {
  1:
    "Podsećamo Vas da u našim poslovnim knjigama evidentiramo dospele, a neizmirene obaveze iskazane u " +
    "nastavku. Ukoliko ste u međuvremenu izvršili plaćanje, molimo Vas da ovu opomenu zanemarite. " +
    "U suprotnom, molimo za izmirenje duga u najkraćem roku.",
  2:
    "Ponovo Vas obaveštavamo da dospele obaveze iskazane u nastavku do danas nisu izmirene. Molimo Vas da " +
    "dugovanje izmirite bez odlaganja kako bismo izbegli dalje mere naplate i eventualno prekidanje isporuka.",
  3:
    "Ovo je poslednja opomena pre pokretanja postupka prinudne naplate. Ukoliko dospeli dug iskazan u nastavku " +
    "ne bude izmiren u ostavljenom roku, bićemo prinuđeni da potraživanje ostvarimo sudskim putem, uz naplatu " +
    "zakonske zatezne kamate i troškova postupka.",
};

/** Rok za plaćanje po nivou (dana od prijema opomene). */
const LEVEL_DEADLINE_DAYS: Record<number, number> = { 1: 8, 2: 5, 3: 3 };

interface IssuerInfo {
  companyName: string;
  address: string | null;
  city: string | null;
  /** Poštanski broj (O-F10) — od 03.08.2026. zasebna kolona, ne više deo mesta. */
  postalCode?: string | null;
  taxId: string | null;
  registrationNumber: string | null;
  bankAccount: string | null;
  phone: string | null;
  email: string | null;
}

interface PartnerInfo {
  id: number;
  name: string;
  address: string | null;
  postalCode: string | null;
  city: string | null;
  taxId: string | null;
  registrationNumber: string | null;
}

@Injectable()
export class DunningPdfService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pdf: PdfService,
    private readonly openItems: OpenItemsService,
  ) {}

  /**
   * Generiši PDF opomene za komitenta na dan preseka (`asOf` default danas),
   * po nivou (1|2|3). Vraća `{ buffer, fileName }`. Nivo van 1..3 se svodi na 1..3.
   */
  async buildDunningPdf(
    partnerId: number,
    level: number,
    asOf?: Date,
    printedBy?: string | null,
  ): Promise<{ buffer: Buffer; fileName: string }> {
    const cutoff = asOf ?? new Date();
    const lvl = level < 1 ? 1 : level > 3 ? 3 : level;

    const [items, issuer, partner] = await Promise.all([
      this.openItems.listOpenItems(undefined, partnerId, cutoff),
      this.loadIssuer(),
      this.loadPartner(partnerId),
    ]);

    // Dunning je nad KUPČEVIM potraživanjima — receivable strana I partner_scope
    // 'customer' iz registra (isti uslov kao DunningService, jedan izvor).
    const receivable = items.filter(isCustomerReceivable);

    const docDefinition = this.buildDocDefinition({
      items: receivable,
      issuer,
      partner,
      partnerId,
      level: lvl,
      asOf: cutoff,
      printedBy: printedBy ?? null,
    });

    const buffer = await this.pdf.render(docDefinition);
    const p = (n: number) => String(n).padStart(2, "0");
    const stamp = `${cutoff.getFullYear()}-${p(cutoff.getMonth() + 1)}-${p(cutoff.getDate())}`;
    return { buffer, fileName: `Opomena-${partnerId}-N${lvl}-${stamp}.pdf` };
  }

  // ------------------------------------------------------------ učitavanje

  private async loadIssuer(): Promise<IssuerInfo> {
    const company = await this.prisma.company.findFirst({
      orderBy: { id: "asc" },
      select: {
        companyName: true,
        address: true,
        city: true,
        postalCode: true,
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
      postalCode: company.postalCode,
      taxId: company.taxId,
      registrationNumber: company.registrationNumber,
      bankAccount: company.bankAccount,
      phone: company.phone,
      email: company.email,
    };
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

  // --------------------------------------------------------- dokument (pdfmake)

  private buildDocDefinition(args: {
    items: OpenItem[];
    issuer: IssuerInfo;
    partner: PartnerInfo | null;
    partnerId: number;
    level: number;
    asOf: Date;
    printedBy: string | null;
  }): TDocumentDefinitions {
    const { items, issuer, partner, partnerId, level, asOf, printedBy } = args;

    // Dospele stavke = dugovni saldo sa poznatim dospećem u docnji (daysOverdue ≥ 1).
    const overdue = items.filter(
      (it) =>
        it.balance.greaterThan(0) &&
        it.daysOverdue != null &&
        it.daysOverdue >= 1,
    );
    let overdueTotal = new D(0);
    let maxDays = 0;
    for (const it of overdue) {
      overdueTotal = overdueTotal.add(it.balance);
      if (it.daysOverdue != null && it.daysOverdue > maxDays)
        maxDays = it.daysOverdue;
    }

    const header = this.buildHeader(level, asOf);
    const parties = this.buildParties(issuer, partner, partnerId);
    const intro = this.buildIntro(level, asOf);
    const table = this.buildItemsTable(overdue, overdueTotal);
    const summary = this.buildSummary(
      level,
      overdueTotal,
      maxDays,
      issuer,
      asOf,
    );

    return {
      pageSize: "A4",
      pageMargins: [32, 32, 32, 40],
      content: [
        header,
        parties,
        intro,
        table,
        summary,
        // Nepotpisan akt kojim se preti utuženjem dužnik u sporu odbacuje kao
        // neovlašćenu ispravu — BigBit opomenu nema uopšte, mi je potpisujemo.
        {
          margin: [0, 18, 0, 0],
          text: `U ${issuer.city ?? "________"}, dana ${fmtDate(asOf)}`,
          style: "note",
        },
        buildSignatureRow(["Odgovorno lice"], true),
      ],
      styles: {
        title: { fontSize: 18, bold: true },
        titleDanger: { fontSize: 18, bold: true, color: "#b42318" },
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
        saldo: { fontSize: 12, bold: true, margin: [0, 12, 0, 0] },
        note: { fontSize: 8, color: "#555", margin: [0, 4, 0, 0] },
        pay: { fontSize: 9, color: "#333", margin: [0, 8, 0, 0] },
        signLbl: {
          fontSize: 8,
          color: "#333",
          alignment: "center",
          margin: [0, 2, 0, 0],
        },
      },
      defaultStyle: { font: "Roboto", fontSize: 9 },
      footer: buildPageFooter(
        `Opomena nivo ${level} · komitent ${partnerId} · na dan ${fmtDate(asOf)}`,
        printedBy,
      ),
    };
  }

  private buildHeader(level: number, asOf: Date): Content {
    return {
      columns: [
        { image: SERVOTEH_LOGO_DATA_URL, width: LOGO_WIDTH },
        {
          width: "*",
          margin: [12, 4, 0, 0],
          stack: [
            {
              text: LEVEL_TITLE[level] ?? "OPOMENA",
              style: level >= 3 ? "titleDanger" : "title",
            },
            {
              text: `Pregled dospelih neizmirenih obaveza na dan ${fmtDate(asOf)}`,
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
      companyAddressLine(issuer.address, issuer.postalCode, issuer.city),
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
        partyStack("POVERILAC (izdaje opomenu)", issuerLines),
        partyStack("DUŽNIK (komitent)", partnerLines),
      ],
      columnGap: 24,
    };
  }

  private buildIntro(level: number, asOf: Date): Content {
    void asOf;
    const lead = `Poštovani,\n` + (LEVEL_INTRO[level] ?? LEVEL_INTRO[1]);
    return { text: lead, style: "intro" };
  }

  private buildItemsTable(
    overdue: OpenItem[],
    overdueTotal: Prisma.Decimal,
  ): Content {
    const head = [
      "R.br.",
      "Dokument",
      "Dospeće",
      "Kašnjenje (dana)",
      "Dospeli iznos",
    ];
    const widths: (string | number)[] = ["auto", "*", "auto", "auto", "auto"];
    const headerCells: Content[] = head.map((text, i) => ({
      text,
      style: "th",
      alignment: i <= 1 ? "left" : "right",
    }));

    const body: TableCell[][] = [headerCells];

    if (overdue.length === 0) {
      body.push([
        {
          text: "Nema dospelih neizmirenih stavki na dan preseka.",
          italics: true,
          colSpan: 5,
          style: "td",
        },
        {},
        {},
        {},
        {},
      ]);
    } else {
      overdue.forEach((it, idx) => {
        body.push([
          { text: String(idx + 1), style: "td" },
          { text: it.documentNumber ?? "—", style: "td" },
          { text: fmtDate(it.dueDate), style: "tdNum" },
          {
            text: it.daysOverdue != null ? String(it.daysOverdue) : "—",
            style: "tdNum",
          },
          { text: formatDecimal(it.balance, 2), style: "tdNum" },
        ]);
      });
    }

    body.push([
      { text: "UKUPNO DOSPELO", style: "totLbl", colSpan: 4 },
      {},
      {},
      {},
      { text: formatDecimal(overdueTotal, 2), style: "totNum" },
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
      margin: [0, 4, 0, 0],
    };
  }

  private buildSummary(
    level: number,
    overdueTotal: Prisma.Decimal,
    maxDays: number,
    issuer: IssuerInfo,
    asOf: Date,
  ): Content {
    const deadlineDays = LEVEL_DEADLINE_DAYS[level] ?? 8;
    const lines: Content[] = [
      {
        text: `Ukupno dospelo za naplatu na dan ${fmtDate(asOf)}: ${formatDecimal(overdueTotal, 2)} RSD.`,
        style: "saldo",
      },
      {
        text:
          maxDays > 0
            ? `Najstarije kašnjenje: ${maxDays} dana.`
            : "Svi iznosi su izraženi u dinarima (RSD).",
        style: "note",
      },
      {
        text:
          `Molimo Vas da dugovanje izmirite u roku od ${deadlineDays} dana od prijema ove opomene` +
          (issuer.bankAccount
            ? `, uplatom na tekući račun ${issuer.bankAccount}.`
            : "."),
        style: "pay",
      },
    ];
    if (level >= 3) {
      lines.push({
        text:
          "Po isteku roka pristupićemo prinudnoj naplati sudskim putem, uz obračun zakonske zatezne " +
          "kamate i troškova postupka.",
        style: "pay",
      });
    }
    return { stack: lines };
  }
}

// ---------------------------------------------------------------- formatiranje

function fmtDate(d: Date | null): string {
  if (!d) return "—";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()}.`;
}

/**
 * Novac u srpskom zapisu SA razdelnikom hiljada (`1.234.567,89`). Ranije se
 * štampalo `1234567,89` — na opomeni sa milionskim dugom to je nečitljivo i lako
 * se pogrešno pročita za red veličine. NIKAD Float: `toFixed` ide nad Decimal-om.
 */
function formatDecimal(value: Prisma.Decimal, decimals: number): string {
  const fixed = value.toFixed(decimals);
  const neg = fixed.startsWith("-");
  const [intPart, decPart] = (neg ? fixed.slice(1) : fixed).split(".");
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${neg ? "-" : ""}${grouped},${decPart}`;
}
