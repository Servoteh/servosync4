import { Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type { Content, TDocumentDefinitions } from "pdfmake/interfaces";
import { PrismaService } from "../../../prisma/prisma.service";
import { PdfService } from "../../documents/pdf.service";
import { SERVOTEH_LOGO_DATA_URL } from "../../documents/servoteh-logo";

/**
 * Štampa izlaznog računa (Invoice + InvoiceItem) u PDF — Faza 5 §C.
 *
 * Renderer je zajednički `PdfService` (pdfmake 0.3, Roboto pokriva srpski
 * Latin Extended-A) — ISTI put kao `WorkOrderPrintService`; ovaj servis samo
 * gradi `TDocumentDefinitions` i vraća `Buffer` iz `pdf.render(...)`. Nema nove
 * PDF zavisnosti (pdfmake već u repou, koristi ga documents/work-orders).
 *
 * Varijante (§C):
 *   - `withPrices` (default): puna faktura sa cenama, rabatom, PDV-om i „za plaćanje".
 *   - `withoutPrices`: otpremnica (2× bez cena) — samo količine i opisi.
 *   - `export`: ino faktura na engleskom (izvoz; PDV kategorija Z/čl.24, valuta EUR).
 *
 * Iznosi su Prisma.Decimal (NIKAD Float) — formatiraju se `formatDecimal` sa
 * decimalnim zarezom; za engleski (`export`) tačkom.
 */
export type InvoicePrintVariant = "withPrices" | "withoutPrices" | "export";

/** Injektovani (denormalizovani) podaci firme izdavaoca za zaglavlje. */
interface IssuerInfo {
  companyName: string;
  address: string | null;
  city: string | null;
  taxId: string | null;
  registrationNumber: string | null;
  bankAccount: string | null;
  phone: string | null;
  email: string | null;
  swift?: string | null;
  iban?: string | null;
}

@Injectable()
export class InvoicePdfService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pdf: PdfService,
  ) {}

  /**
   * Generiši PDF fakture. `variant` bira šablon (v. `InvoicePrintVariant`);
   * kad se ne prosledi, izvedi ga iz dokumenta (`isExport` → `export`, inače
   * `withPrices`). Vraća `{ buffer, fileName }`.
   */
  async buildInvoicePdf(
    invoiceId: number,
    variant?: InvoicePrintVariant,
  ): Promise<{ buffer: Buffer; fileName: string }> {
    const invoice = await this.prisma.invoice.findUnique({
      where: { id: invoiceId },
      include: { items: { orderBy: [{ lineNo: "asc" }, { id: "asc" }] } },
    });
    if (!invoice) throw new NotFoundException(`Račun ${invoiceId} ne postoji.`);

    const effectiveVariant: InvoicePrintVariant =
      variant ?? (invoice.isExport ? "export" : "withPrices");

    // Batch-resolve mekih ref-ova (bez required-relation JOIN-a — orphan pravilo).
    const [customer, issuer, itemNames] = await Promise.all([
      invoice.customerId != null && invoice.customerId > 0
        ? this.prisma.customer.findUnique({
            where: { id: invoice.customerId },
            select: {
              name: true,
              address: true,
              city: true,
              postalCode: true,
              country: true,
              taxId: true,
              registrationNumber: true,
            },
          })
        : Promise.resolve(null),
      this.loadIssuer(invoice.companyId),
      this.resolveItemNames(
        invoice.items.map((i) => i.itemId),
        effectiveVariant === "export",
      ),
    ]);

    const docDefinition = this.buildDocDefinition({
      invoice,
      customer,
      issuer,
      itemNames,
      variant: effectiveVariant,
    });

    const buffer = await this.pdf.render(docDefinition);
    const safeNumber = invoice.documentNumber.replace(/[\\/:*?"<>|]+/g, "-");
    const prefix = effectiveVariant === "withoutPrices" ? "OTP" : "FAK";
    return { buffer, fileName: `${prefix}-${safeNumber}.pdf` };
  }

  /** Convenience: otpremnica bez cena (2× štampa, §C). */
  async buildDeliveryNotePdf(
    invoiceId: number,
  ): Promise<{ buffer: Buffer; fileName: string }> {
    return this.buildInvoicePdf(invoiceId, "withoutPrices");
  }

  /** Convenience: ino faktura na engleskom (izvoz, §C). */
  async buildExportInvoicePdf(
    invoiceId: number,
  ): Promise<{ buffer: Buffer; fileName: string }> {
    return this.buildInvoicePdf(invoiceId, "export");
  }

  // ------------------------------------------------------------ učitavanje

  /**
   * Firma izdavalac iz `companies` (multi-firma numeracija). SWIFT/IBAN za ino
   * fakturu je best-effort iz `bankAccount` (BigBit ih je držao slobodno); ako
   * firma ne postoji (legacy companyId=0 bez reda) → Servoteh fallback header.
   */
  private async loadIssuer(companyId: number): Promise<IssuerInfo> {
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
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

  /**
   * Mapa itemId → naziv artikla. Za izvoz (`useForeign`) prednost ima
   * `foreignName` (engleski) uz fallback na `name`. Uslužne stavke (itemId
   * null) nose opis sa same stavke, pa ovde ne učestvuju.
   */
  private async resolveItemNames(
    itemIds: (number | null)[],
    useForeign: boolean,
  ): Promise<Map<number, string>> {
    const ids = [
      ...new Set(itemIds.filter((i): i is number => i != null && i > 0)),
    ];
    if (!ids.length) return new Map();
    const rows = await this.prisma.item.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true, foreignName: true, unit: true },
    });
    const map = new Map<number, string>();
    for (const r of rows) {
      const name =
        useForeign && r.foreignName?.trim() ? r.foreignName : r.name;
      map.set(r.id, name);
    }
    return map;
  }

  // --------------------------------------------------------- dokument (pdfmake)

  private buildDocDefinition(args: {
    invoice: InvoiceWithItems;
    customer: CustomerInfo | null;
    issuer: IssuerInfo;
    itemNames: Map<number, string>;
    variant: InvoicePrintVariant;
  }): TDocumentDefinitions {
    const { invoice, customer, issuer, itemNames, variant } = args;
    const t = getLabels(variant);
    const showPrices = variant !== "withoutPrices";
    const english = variant === "export";
    const currency = invoice.currency || "RSD";

    const header = this.buildHeader(invoice, issuer, t, english, currency);
    const parties = this.buildParties(customer, issuer, t);
    const table = this.buildItemsTable(
      invoice,
      itemNames,
      t,
      showPrices,
      currency,
      english,
    );
    const totals = showPrices
      ? this.buildTotals(invoice, t, currency, english)
      : { text: "" };
    const footer = this.buildDocFooter(invoice, issuer, t, showPrices, english);

    return {
      pageSize: "A4",
      pageMargins: [32, 32, 32, 40],
      content: [header, parties, table, totals, footer],
      styles: {
        title: { fontSize: 18, bold: true },
        subtitle: { fontSize: 11, color: "#555", margin: [0, 2, 0, 0] },
        sectionLbl: { fontSize: 8, bold: true, color: "#555" },
        partyName: { fontSize: 11, bold: true },
        partyLine: { fontSize: 9, color: "#333" },
        th: { fontSize: 8, bold: true, fillColor: "#f0f0f0" },
        td: { fontSize: 8 },
        tdNum: { fontSize: 8, alignment: "right" },
        totLbl: { fontSize: 9, bold: true, alignment: "right" },
        totVal: { fontSize: 9, alignment: "right" },
        grand: { fontSize: 11, bold: true, alignment: "right" },
        note: { fontSize: 8, color: "#555", margin: [0, 10, 0, 0] },
      },
      defaultStyle: { font: "Roboto", fontSize: 9 },
      footer: (currentPage: number, pageCount: number): Content => ({
        text: `${t.docWord} ${invoice.documentNumber} · ${t.page} ${currentPage}/${pageCount}`,
        alignment: "center",
        fontSize: 7,
        color: "#888",
        margin: [0, 8, 0, 0],
      }),
    };
  }

  private buildHeader(
    invoice: InvoiceWithItems,
    issuer: IssuerInfo,
    t: Labels,
    english: boolean,
    currency: string,
  ): Content {
    const subtitleParts = [
      `${t.docWord} ${invoice.documentNumber}`,
      `${t.dateWord}: ${fmtDate(invoice.documentDate, english)}`,
    ];
    if (invoice.dueDate)
      subtitleParts.push(`${t.dueWord}: ${fmtDate(invoice.dueDate, english)}`);
    if (english && currency !== "RSD") subtitleParts.push(`${t.currencyWord}: ${currency}`);
    return {
      columns: [
        { image: SERVOTEH_LOGO_DATA_URL, width: 128 },
        {
          width: "*",
          margin: [12, 4, 0, 0],
          stack: [
            { text: t.title, style: "title" },
            { text: subtitleParts.join("   ·   "), style: "subtitle" },
          ],
        },
      ],
      columnGap: 8,
    };
  }

  private buildParties(
    customer: CustomerInfo | null,
    issuer: IssuerInfo,
    t: Labels,
  ): Content {
    const issuerLines = [
      issuer.companyName,
      [issuer.address, issuer.city].filter(Boolean).join(", "),
      issuer.taxId ? `${t.taxIdLbl}: ${issuer.taxId}` : "",
      issuer.registrationNumber
        ? `${t.regNoLbl}: ${issuer.registrationNumber}`
        : "",
    ].filter(Boolean);
    const customerLines = customer
      ? [
          customer.name,
          [customer.address, customer.postalCode, customer.city]
            .filter(Boolean)
            .join(", "),
          customer.country ?? "",
          customer.taxId ? `${t.taxIdLbl}: ${customer.taxId}` : "",
          customer.registrationNumber
            ? `${t.regNoLbl}: ${customer.registrationNumber}`
            : "",
        ].filter(Boolean)
      : ["—"];

    const partyStack = (title: string, lines: string[]) => ({
      width: "*",
      stack: [
        { text: title, style: "sectionLbl", margin: [0, 0, 0, 3] as [number, number, number, number] },
        { text: lines[0] ?? "", style: "partyName" },
        ...lines.slice(1).map((l) => ({ text: l, style: "partyLine" })),
      ],
    });

    return {
      margin: [0, 14, 0, 14],
      columns: [
        partyStack(t.sellerWord, issuerLines),
        partyStack(t.buyerWord, customerLines),
      ],
      columnGap: 24,
    };
  }

  private buildItemsTable(
    invoice: InvoiceWithItems,
    itemNames: Map<number, string>,
    t: Labels,
    showPrices: boolean,
    currency: string,
    english: boolean,
  ): Content {
    const head: string[] = [t.colNo, t.colDesc, t.colQty];
    const widths: (string | number)[] = ["auto", "*", "auto"];
    if (showPrices) {
      head.push(t.colPrice, t.colDiscount, t.colBase, t.colVat, t.colTotal);
      widths.push("auto", "auto", "auto", "auto", "auto");
    }
    const headerCells: Content[] = head.map((text, i) => ({
      text,
      style: "th",
      alignment: i === 0 || i === 1 ? "left" : "right",
    }));

    const bodyRows: Content[][] = invoice.items.map((item, idx) => {
      const desc =
        (item.itemId != null && item.itemId > 0
          ? itemNames.get(item.itemId)
          : undefined) ??
        item.description ??
        "";
      const cells: Content[] = [
        { text: String(idx + 1), style: "td" },
        { text: desc, style: "td" },
        { text: formatDecimal(item.quantity, 3, english), style: "tdNum" },
      ];
      if (showPrices) {
        cells.push(
          { text: formatDecimal(item.unitPrice, 2, english), style: "tdNum" },
          {
            text: formatDiscount(item.discountPercent, english),
            style: "tdNum",
          },
          { text: formatDecimal(item.vatBase, 2, english), style: "tdNum" },
          { text: formatDecimal(item.vatAmount, 2, english), style: "tdNum" },
          { text: formatDecimal(item.lineTotal, 2, english), style: "tdNum" },
        );
      }
      return cells;
    });

    if (!invoice.items.length) {
      return {
        text: t.noItems,
        italics: true,
        margin: [0, 6, 0, 0],
      };
    }

    return {
      table: {
        headerRows: 1,
        widths,
        body: [headerCells, ...bodyRows],
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
    };
  }

  private buildTotals(
    invoice: InvoiceWithItems,
    t: Labels,
    currency: string,
    english: boolean,
  ): Content {
    const row = (label: string, value: string, grand = false): Content[] => [
      { text: label, style: grand ? "grand" : "totLbl" },
      { text: value, style: grand ? "grand" : "totVal" },
    ];
    return {
      margin: [0, 12, 0, 0],
      columns: [
        { width: "*", text: "" },
        {
          width: "auto",
          table: {
            widths: ["auto", "auto"],
            body: [
              row(t.netTotalLbl, fmtMoney(invoice.netTotal, currency, english)),
              row(t.vatTotalLbl, fmtMoney(invoice.vatTotal, currency, english)),
              row(
                t.grossTotalLbl,
                fmtMoney(invoice.grossTotal, currency, english),
                true,
              ),
            ],
          },
          layout: "noBorders",
        },
      ],
    };
  }

  private buildDocFooter(
    invoice: InvoiceWithItems,
    issuer: IssuerInfo,
    t: Labels,
    showPrices: boolean,
    english: boolean,
  ): Content {
    const lines: Content[] = [];
    if (showPrices && issuer.bankAccount)
      lines.push({
        text: `${t.bankAccountLbl}: ${issuer.bankAccount}`,
        style: "note",
      });
    // Ino faktura: SWIFT/IBAN instrukcije (INO plaćanje, §izvoz).
    if (english && issuer.iban)
      lines.push({ text: `IBAN: ${issuer.iban}`, style: "note" });
    if (english && issuer.swift)
      lines.push({ text: `SWIFT: ${issuer.swift}`, style: "note" });
    if (invoice.note?.trim())
      lines.push({ text: `${t.noteLbl}: ${invoice.note}`, style: "note" });
    if (english && invoice.isExport)
      lines.push({ text: t.exportVatNote, style: "note" });
    // Prostor za potpis / pečat (paritet legacy printa).
    lines.push({
      columns: [
        { width: "*", text: "" },
        {
          width: 180,
          margin: [0, 30, 0, 0],
          stack: [
            { canvas: [{ type: "line", x1: 0, y1: 0, x2: 160, y2: 0, lineWidth: 0.5 }] },
            { text: t.signatureLbl, fontSize: 8, color: "#555", margin: [0, 2, 0, 0], alignment: "center" },
          ],
        },
      ],
    });
    return { stack: lines };
  }
}

// ---------------------------------------------------------------- pomoćni tipovi

type InvoiceWithItems = Prisma.InvoiceGetPayload<{ include: { items: true } }>;

interface CustomerInfo {
  name: string;
  address: string | null;
  city: string | null;
  postalCode: string | null;
  country: string | null;
  taxId: string;
  registrationNumber: string | null;
}

// ---------------------------------------------------------------- i18n natpisi

interface Labels {
  title: string;
  docWord: string;
  dateWord: string;
  dueWord: string;
  currencyWord: string;
  sellerWord: string;
  buyerWord: string;
  taxIdLbl: string;
  regNoLbl: string;
  colNo: string;
  colDesc: string;
  colQty: string;
  colPrice: string;
  colDiscount: string;
  colBase: string;
  colVat: string;
  colTotal: string;
  netTotalLbl: string;
  vatTotalLbl: string;
  grossTotalLbl: string;
  bankAccountLbl: string;
  noteLbl: string;
  signatureLbl: string;
  page: string;
  noItems: string;
  exportVatNote: string;
}

const SR_LABELS: Labels = {
  title: "RAČUN",
  docWord: "Račun br.",
  dateWord: "Datum",
  dueWord: "Valuta",
  currencyWord: "Valuta",
  sellerWord: "PRODAVAC",
  buyerWord: "KUPAC",
  taxIdLbl: "PIB",
  regNoLbl: "Mat. br.",
  colNo: "R.br.",
  colDesc: "Opis",
  colQty: "Količina",
  colPrice: "Cena",
  colDiscount: "Rabat",
  colBase: "Osnovica",
  colVat: "PDV",
  colTotal: "Za plaćanje",
  netTotalLbl: "Osnovica:",
  vatTotalLbl: "PDV:",
  grossTotalLbl: "Za plaćanje:",
  bankAccountLbl: "Tekući račun",
  noteLbl: "Napomena",
  signatureLbl: "Potpis i pečat",
  page: "strana",
  noItems: "Račun nema stavki.",
  exportVatNote: "",
};

const SR_DELIVERY_LABELS: Labels = {
  ...SR_LABELS,
  title: "OTPREMNICA",
  docWord: "Otpremnica br.",
  signatureLbl: "Primio / Potpis",
};

const EN_LABELS: Labels = {
  title: "INVOICE",
  docWord: "Invoice no.",
  dateWord: "Date",
  dueWord: "Due date",
  currencyWord: "Currency",
  sellerWord: "SELLER",
  buyerWord: "BUYER",
  taxIdLbl: "VAT ID",
  regNoLbl: "Reg. no.",
  colNo: "No.",
  colDesc: "Description",
  colQty: "Qty",
  colPrice: "Price",
  colDiscount: "Disc.",
  colBase: "Net",
  colVat: "VAT",
  colTotal: "Amount",
  netTotalLbl: "Net total:",
  vatTotalLbl: "VAT:",
  grossTotalLbl: "Total due:",
  bankAccountLbl: "Bank account",
  noteLbl: "Note",
  signatureLbl: "Signature & stamp",
  page: "page",
  noItems: "No items on this invoice.",
  exportVatNote:
    "VAT exempt — Article 24, Law on VAT (tax category Z / export of goods and services).",
};

function getLabels(variant: InvoicePrintVariant): Labels {
  if (variant === "export") return EN_LABELS;
  if (variant === "withoutPrices") return SR_DELIVERY_LABELS;
  return SR_LABELS;
}

// ---------------------------------------------------------------- formatiranje

/** Datum dd.MM.yyyy. (srpski) ili yyyy-MM-dd (engleski/izvoz). */
function fmtDate(d: Date | null, english: boolean): string {
  if (!d) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  if (english)
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()}.`;
}

/**
 * Prisma.Decimal → string sa fiksnim brojem decimala. Srpski koristi zarez,
 * engleski (izvoz) tačku. NIKAD Float aritmetika — `toFixed` nad Decimal-om.
 */
function formatDecimal(
  value: Prisma.Decimal,
  decimals: number,
  english: boolean,
): string {
  const s = value.toFixed(decimals);
  return english ? s : s.replace(".", ",");
}

/** Rabat: prazno za 0, inače „NN%" (zarez/tačka po jeziku). */
function formatDiscount(value: Prisma.Decimal, english: boolean): string {
  if (value.isZero()) return "";
  const s = value.toFixed(2).replace(/\.?0+$/, "");
  return `${english ? s : s.replace(".", ",")}%`;
}

/** Iznos + oznaka valute (npr. „1.234,56 RSD" / „1234.56 EUR"). */
function fmtMoney(
  value: Prisma.Decimal,
  currency: string,
  english: boolean,
): string {
  return `${formatDecimal(value, 2, english)} ${currency}`;
}
