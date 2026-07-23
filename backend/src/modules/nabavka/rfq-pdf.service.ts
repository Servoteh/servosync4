import { Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type { Content, TDocumentDefinitions } from "pdfmake/interfaces";
import { PrismaService } from "../../prisma/prisma.service";
import { PdfService } from "../documents/pdf.service";
import { SERVOTEH_LOGO_DATA_URL } from "../documents/servoteh-logo";

/**
 * Štampa upita za ponudu (SupplierRfq + SupplierRfqItem) u PDF — Nabavka §B (C7).
 *
 * Renderer je zajednički `PdfService` (pdfmake 0.3, Roboto pokriva srpski Latin
 * Extended-A) — ISTI put i obrazac kao `InvoicePdfService`; ovaj servis samo gradi
 * `TDocumentDefinitions` i vraća `Buffer` iz `pdf.render(...)`. Nema nove PDF
 * zavisnosti (pdfmake već u repou).
 *
 * PDF se prilaže uz auto-mail RFQ-a (`NabavkaService.createAndSendRfq`); mejl i
 * dalje nosi isti HTML, PDF je dodatni prilog (`upit-za-ponudu-<broj>.pdf`).
 *
 * Bez cena — upit NE nosi cenu (cena tek u narudžbenici, BigBit pravilo, doc 24).
 */

/** Injektovani (denormalizovani) podaci firme naručioca za zaglavlje. */
interface IssuerInfo {
  companyName: string;
  address: string | null;
  city: string | null;
  taxId: string | null;
  registrationNumber: string | null;
  phone: string | null;
  email: string | null;
}

/** Podaci dobavljača (primaoca upita). */
interface SupplierInfo {
  name: string;
  address: string | null;
  postalCode: string | null;
  city: string | null;
  country: string | null;
  taxId: string | null;
}

@Injectable()
export class RfqPdfService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pdf: PdfService,
  ) {}

  /**
   * Generiši PDF upita za ponudu. Učitava upit + stavke, dobavljača (meki ref)
   * i firmu-naručioca; vraća `{ buffer, fileName }`. `offerDeadline` je opcioni
   * rok za dostavu ponude (renderuje se samo ako je prosleđen).
   */
  async buildRfqPdf(
    rfqId: number,
    offerDeadline?: Date,
  ): Promise<{ buffer: Buffer; fileName: string }> {
    const rfq = await this.prisma.supplierRfq.findUnique({
      where: { id: rfqId },
      include: { items: { orderBy: [{ lineNo: "asc" }, { id: "asc" }] } },
    });
    if (!rfq) throw new NotFoundException(`Upit ${rfqId} ne postoji.`);

    // Batch-resolve mekih ref-ova (bez required-relation JOIN-a — orphan pravilo).
    const [supplier, issuer, itemNames] = await Promise.all([
      this.loadSupplier(rfq.supplierId),
      this.loadIssuer(),
      this.resolveItemNames(rfq.items.map((i) => i.articleId)),
    ]);

    const docDefinition = this.buildDocDefinition({
      rfq,
      supplier,
      issuer,
      itemNames,
      offerDeadline,
    });

    const buffer = await this.pdf.render(docDefinition);
    const safeNumber = rfq.rfqNumber.replace(/[\\/:*?"<>|]+/g, "-");
    return { buffer, fileName: `upit-za-ponudu-${safeNumber}.pdf` };
  }

  // ------------------------------------------------------------ učitavanje

  /** Dobavljač iz šifarnika komitenata (meki ref); null ako je obrisan. */
  private async loadSupplier(supplierId: number): Promise<SupplierInfo | null> {
    const c = await this.prisma.customer.findUnique({
      where: { id: supplierId },
      select: {
        name: true,
        address: true,
        postalCode: true,
        city: true,
        country: true,
        taxId: true,
      },
    });
    if (!c) return null;
    return {
      name: c.name,
      address: c.address,
      postalCode: c.postalCode,
      city: c.city,
      country: c.country,
      taxId: c.taxId,
    };
  }

  /**
   * Firma-naručilac za zaglavlje. Upit nema `companyId` (za razliku od fakture),
   * pa se uzima primarna firma (najmanji id); ako je nema → Servoteh fallback.
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
      phone: company.phone,
      email: company.email,
    };
  }

  /**
   * Mapa articleId → naziv artikla. Stavke bez artikla (articleId null) nose
   * slobodan opis sa same stavke, pa ovde ne učestvuju.
   */
  private async resolveItemNames(
    itemIds: (number | null)[],
  ): Promise<Map<number, string>> {
    const ids = [
      ...new Set(itemIds.filter((i): i is number => i != null && i > 0)),
    ];
    if (!ids.length) return new Map();
    const rows = await this.prisma.item.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true },
    });
    const map = new Map<number, string>();
    for (const r of rows) map.set(r.id, r.name);
    return map;
  }

  // --------------------------------------------------------- dokument (pdfmake)

  private buildDocDefinition(args: {
    rfq: RfqWithItems;
    supplier: SupplierInfo | null;
    issuer: IssuerInfo;
    itemNames: Map<number, string>;
    offerDeadline?: Date;
  }): TDocumentDefinitions {
    const { rfq, supplier, issuer, itemNames, offerDeadline } = args;

    const header = this.buildHeader(rfq);
    const parties = this.buildParties(issuer, supplier);
    const table = this.buildItemsTable(rfq, itemNames);
    const footer = this.buildDocFooter(rfq, offerDeadline);

    return {
      pageSize: "A4",
      pageMargins: [32, 32, 32, 40],
      content: [header, parties, table, footer],
      styles: {
        title: { fontSize: 18, bold: true },
        subtitle: { fontSize: 11, color: "#555", margin: [0, 2, 0, 0] },
        sectionLbl: { fontSize: 8, bold: true, color: "#555" },
        partyName: { fontSize: 11, bold: true },
        partyLine: { fontSize: 9, color: "#333" },
        th: { fontSize: 8, bold: true, fillColor: "#f0f0f0" },
        td: { fontSize: 8 },
        tdNum: { fontSize: 8, alignment: "right" },
        note: { fontSize: 9, color: "#333", margin: [0, 10, 0, 0] },
        deadline: { fontSize: 10, bold: true, margin: [0, 12, 0, 0] },
      },
      defaultStyle: { font: "Roboto", fontSize: 9 },
      footer: (currentPage: number, pageCount: number): Content => ({
        text: `Upit br. ${rfq.rfqNumber} · strana ${currentPage}/${pageCount}`,
        alignment: "center",
        fontSize: 7,
        color: "#888",
        margin: [0, 8, 0, 0],
      }),
    };
  }

  private buildHeader(rfq: RfqWithItems): Content {
    const subtitleParts = [
      `Upit br. ${rfq.rfqNumber}`,
      `Datum: ${fmtDate(rfq.createdAt)}`,
    ];
    return {
      columns: [
        { image: SERVOTEH_LOGO_DATA_URL, width: 128 },
        {
          width: "*",
          margin: [12, 4, 0, 0],
          stack: [
            { text: "UPIT ZA PONUDU", style: "title" },
            { text: subtitleParts.join("   ·   "), style: "subtitle" },
          ],
        },
      ],
      columnGap: 8,
    };
  }

  private buildParties(
    issuer: IssuerInfo,
    supplier: SupplierInfo | null,
  ): Content {
    const issuerLines = [
      issuer.companyName,
      [issuer.address, issuer.city].filter(Boolean).join(", "),
      issuer.taxId ? `PIB: ${issuer.taxId}` : "",
      issuer.registrationNumber ? `Mat. br.: ${issuer.registrationNumber}` : "",
      issuer.email ? `E-pošta: ${issuer.email}` : "",
      issuer.phone ? `Tel: ${issuer.phone}` : "",
    ].filter(Boolean);
    const supplierLines = supplier
      ? [
          supplier.name,
          [supplier.address, supplier.postalCode, supplier.city]
            .filter(Boolean)
            .join(", "),
          supplier.country ?? "",
          supplier.taxId ? `PIB: ${supplier.taxId}` : "",
        ].filter(Boolean)
      : ["—"];

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
      margin: [0, 14, 0, 14],
      columns: [
        partyStack("NARUČILAC", issuerLines),
        partyStack("DOBAVLJAČ", supplierLines),
      ],
      columnGap: 24,
    };
  }

  private buildItemsTable(
    rfq: RfqWithItems,
    itemNames: Map<number, string>,
  ): Content {
    if (!rfq.items.length) {
      return { text: "Upit nema stavki.", italics: true, margin: [0, 6, 0, 0] };
    }

    const head = ["R.br.", "Artikal", "Količina", "JM", "Rok isporuke"];
    const widths: (string | number)[] = ["auto", "*", "auto", "auto", "auto"];
    const headerCells: Content[] = head.map((text, i) => ({
      text,
      style: "th",
      alignment: i === 0 || i === 1 ? "left" : "right",
    }));

    const bodyRows: Content[][] = rfq.items.map((item, idx) => {
      const desc =
        (item.articleId != null && item.articleId > 0
          ? itemNames.get(item.articleId)
          : undefined) ??
        item.description ??
        "";
      const lead =
        item.offeredLeadTimeDays != null
          ? `${item.offeredLeadTimeDays} dana`
          : "";
      return [
        { text: String(idx + 1), style: "td" },
        { text: desc, style: "td" },
        { text: formatDecimal(item.quantity, 3), style: "tdNum" },
        { text: item.unit ?? "", style: "tdNum" },
        { text: lead, style: "tdNum" },
      ];
    });

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

  private buildDocFooter(rfq: RfqWithItems, offerDeadline?: Date): Content {
    const lines: Content[] = [];
    // Rok za dostavu ponude — samo ako je prosleđen (nema polja u šemi upita).
    if (offerDeadline)
      lines.push({
        text: `Rok za dostavu ponude: ${fmtDate(offerDeadline)}`,
        style: "deadline",
      });
    lines.push({
      text: "Molimo Vas da nam dostavite ponudu sa cenama, uslovima plaćanja i rokom isporuke za navedene stavke.",
      style: "note",
    });
    if (rfq.note?.trim())
      lines.push({ text: `Napomena: ${rfq.note}`, style: "note" });
    // Prostor za potpis / pečat (paritet legacy printa).
    lines.push({
      columns: [
        { width: "*", text: "" },
        {
          width: 180,
          margin: [0, 30, 0, 0],
          stack: [
            {
              canvas: [
                { type: "line", x1: 0, y1: 0, x2: 160, y2: 0, lineWidth: 0.5 },
              ],
            },
            {
              text: "Potpis i pečat",
              fontSize: 8,
              color: "#555",
              margin: [0, 2, 0, 0],
              alignment: "center",
            },
          ],
        },
      ],
    });
    return { stack: lines };
  }
}

// ---------------------------------------------------------------- pomoćni tipovi

type RfqWithItems = Prisma.SupplierRfqGetPayload<{ include: { items: true } }>;

// ---------------------------------------------------------------- formatiranje

/** Datum dd.MM.yyyy. (srpski). */
function fmtDate(d: Date | null): string {
  if (!d) return "";
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
