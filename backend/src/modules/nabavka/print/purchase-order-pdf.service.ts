import { Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type { Content, TDocumentDefinitions } from "pdfmake/interfaces";
import { PrismaService } from "../../../prisma/prisma.service";
import { PdfService } from "../../documents/pdf.service";
import {
  amountInWords,
  buildDocHeader,
  buildEmptyNotice,
  buildPageFooter,
  buildParties,
  buildSignatureRow,
  buildStampBox,
  DOC_STYLES,
  draftWatermark,
  fmtDate,
  fmtMoney,
  fmtQty,
  PAGE_MARGINS,
  safeFileName,
  TABLE_LAYOUT,
  type IssuerInfo,
  type PartyInfo,
  type StatusBadgeSpec,
} from "./doc-format";
import { loadPrimaryIssuer } from "./load-issuer";

/**
 * NARUDŽBENICA DOBAVLJAČU (PurchaseOrder + PurchaseOrderItem) — štampa.
 * =====================================================================
 * BigBit uzor: „Trebovanje - DEFAULT" / „TrebSaCenamaSrpski" (memorandum firme,
 * blok kupca, tabela R.br. | Šifra | NAZIV ROBE | Mera | Količina | CENA | IZNOS,
 * Σ iznos, dva potpisna mesta, noga „Strana N od M").
 *
 * Šta radimo BOLJE od BigBita (bez narušavanja obrasca):
 *   • statusna značka + vodeni žig za nacrt (BigBit štampa nacrt identično kao
 *     poslatu narudžbenicu — nema načina da se razlikuju);
 *   • iznos u slovima (BigBit ga ima samo na blagajni, i to kao praznu crtu);
 *   • trag štampe u nozi (ko je i kada štampao) i uvek `strana N/M`;
 *   • dve varijante iz jednog šablona: `sa cenama` (podrazumevano) i `bez cena`
 *     (`?variant=bezCena`) — BigBit za to ima DVA odvojena izveštaja;
 *   • zaglavlje tabele se ponavlja na svakoj strani (`headerRows: 1`).
 *
 * Renderer je isključivo `PdfService` (pdfmake) — nema novih zavisnosti.
 */

/** Varijanta štampe: sa cenama (nabavka/knjigovodstvo) ili bez (magacin). */
export type PurchaseOrderPrintVariant = "withPrices" | "withoutPrices";

type OrderWithItems = Prisma.PurchaseOrderGetPayload<{
  include: { items: true };
}>;

interface ArticleInfo {
  name: string;
  catalogNumber: string;
  unit: string | null;
}

@Injectable()
export class PurchaseOrderPdfService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pdf: PdfService,
  ) {}

  /**
   * Generiši PDF narudžbenice. Vraća `{ buffer, fileName }`.
   * `printedBy` je ime/e-pošta korisnika koji štampa (ide u nogu — trag štampe).
   */
  async buildPurchaseOrderPdf(
    orderId: number,
    opts: {
      variant?: PurchaseOrderPrintVariant;
      printedBy?: string | null;
    } = {},
  ): Promise<{ buffer: Buffer; fileName: string }> {
    const variant = opts.variant ?? "withPrices";

    const order = await this.prisma.purchaseOrder.findUnique({
      where: { id: orderId },
      include: { items: { orderBy: [{ lineNo: "asc" }, { id: "asc" }] } },
    });
    if (!order)
      throw new NotFoundException(`Narudžbenica ${orderId} ne postoji.`);

    // Meki ref-ovi se učitavaju batch-om (bez required-relation JOIN-a).
    const [issuer, supplier, articles, rfqNumber, projectNumber] =
      await Promise.all([
        loadPrimaryIssuer(this.prisma),
        this.loadSupplier(order.supplierId),
        this.loadArticles(order.items.map((i) => i.articleId)),
        this.loadRfqNumber(order.rfqId),
        this.loadProjectNumber(order.projectId),
      ]);

    const dd = this.buildDocDefinition({
      order,
      issuer,
      supplier,
      articles,
      rfqNumber,
      projectNumber,
      variant,
      printedBy: opts.printedBy ?? null,
    });

    const buffer = await this.pdf.render(dd);
    // Varijante moraju da imaju RAZLIČIT naziv fajla — inače primerak za magacin
    // prepiše onaj sa cenama u folderu preuzimanja.
    const suffix = variant === "withoutPrices" ? "-bez-cena" : "";
    return {
      buffer,
      fileName: `narudzbenica-${safeFileName(order.orderNumber)}${suffix}.pdf`,
    };
  }

  // ────────────────────────────────────────────────────────────── učitavanje

  private async loadSupplier(supplierId: number): Promise<PartyInfo | null> {
    const c = await this.prisma.customer.findUnique({
      where: { id: supplierId },
      select: {
        name: true,
        address: true,
        postalCode: true,
        city: true,
        country: true,
        taxId: true,
        bankAccount1: true,
        email: true,
        phone: true,
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
      bankAccount: c.bankAccount1,
      email: c.email,
      phone: c.phone,
    };
  }

  private async loadArticles(
    ids: (number | null)[],
  ): Promise<Map<number, ArticleInfo>> {
    const uniq = [
      ...new Set(ids.filter((i): i is number => i != null && i > 0)),
    ];
    const map = new Map<number, ArticleInfo>();
    if (!uniq.length) return map;
    const rows = await this.prisma.item.findMany({
      where: { id: { in: uniq } },
      select: { id: true, name: true, catalogNumber: true, unit: true },
    });
    for (const r of rows)
      map.set(r.id, {
        name: r.name,
        catalogNumber: r.catalogNumber,
        unit: r.unit,
      });
    return map;
  }

  private async loadRfqNumber(rfqId: number | null): Promise<string | null> {
    if (rfqId == null) return null;
    const rfq = await this.prisma.supplierRfq.findUnique({
      where: { id: rfqId },
      select: { rfqNumber: true },
    });
    return rfq?.rfqNumber ?? null;
  }

  private async loadProjectNumber(
    projectId: number | null,
  ): Promise<string | null> {
    if (projectId == null) return null;
    const p = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { projectNumber: true },
    });
    return p?.projectNumber ?? null;
  }

  // ──────────────────────────────────────────────────────────────── dokument

  private buildDocDefinition(args: {
    order: OrderWithItems;
    issuer: IssuerInfo;
    supplier: PartyInfo | null;
    articles: Map<number, ArticleInfo>;
    rfqNumber: string | null;
    projectNumber: string | null;
    variant: PurchaseOrderPrintVariant;
    printedBy: string | null;
  }): TDocumentDefinitions {
    const {
      order,
      issuer,
      supplier,
      articles,
      rfqNumber,
      projectNumber,
      variant,
      printedBy,
    } = args;

    const withPrices = variant === "withPrices";
    const status = statusBadge(order.status);
    // Zbir NAD ZAOKRUŽENIM iznosima stavki — red UKUPNO mora biti jednak
    // sabiranju odštampane kolone „Iznos". Puna preciznost (količina Decimal(19,6),
    // cena Decimal(19,4)) daje drugi broj od onog koji dobavljač sabere sa papira.
    const total = order.items.reduce(
      (acc, it) =>
        acc.plus(
          (it.unitPrice ?? new Prisma.Decimal(0))
            .mul(it.orderedQuantity)
            .toDecimalPlaces(2),
        ),
      new Prisma.Decimal(0),
    );

    const content: Content[] = [
      buildDocHeader({
        title: "NARUDŽBENICA",
        subtitle: withPrices ? undefined : "(bez cena — primerak za magacin)",
        issuer,
        status,
        meta: [
          { label: "Broj", value: order.orderNumber },
          {
            label: "Datum",
            value: fmtDate(order.orderedAt ?? order.createdAt),
          },
          { label: "Valuta", value: order.currency },
          ...(rfqNumber ? [{ label: "Po upitu", value: rfqNumber }] : []),
          ...(projectNumber
            ? [{ label: "Predmet", value: projectNumber }]
            : []),
        ],
      }),
      buildParties(
        { title: "NARUČILAC", party: issuerAsParty(issuer) },
        { title: "DOBAVLJAČ", party: supplier },
      ),
      this.buildItemsTable(order, articles, withPrices),
    ];

    if (order.items.length && withPrices) {
      content.push(this.buildTotals(total, order.currency));
    }

    if (order.note?.trim())
      content.push({
        text: `Napomena: ${order.note.trim()}`,
        style: "note",
      });

    content.push({
      text: "Molimo Vas da isporuku izvršite prema gore navedenim stavkama, uz obaveznu naznaku broja narudžbenice na otpremnici i fakturi.",
      style: "note",
    });

    content.push(buildSignatureRow(["Sastavio", "Odgovorno lice"]));
    content.push(buildStampBox());

    const dd: TDocumentDefinitions = {
      pageSize: "A4",
      pageMargins: PAGE_MARGINS,
      content,
      styles: DOC_STYLES,
      defaultStyle: { font: "Roboto", fontSize: 9 },
      footer: buildPageFooter(
        `Narudžbenica br. ${order.orderNumber}`,
        printedBy,
      ),
    };
    if (order.status === "DRAFT")
      dd.watermark = draftWatermark("NACRT — nije poručeno");
    return dd;
  }

  /** Tabela stavki; zaglavlje se ponavlja na svakoj strani (`headerRows: 1`). */
  private buildItemsTable(
    order: OrderWithItems,
    articles: Map<number, ArticleInfo>,
    withPrices: boolean,
  ): Content {
    if (!order.items.length)
      return buildEmptyNotice(
        "Narudžbenica nema stavki",
        "Dokument je odštampan bez stavki — dodaj stavke pa ponovi štampu.",
      );

    const head = withPrices
      ? [
          "R.br.",
          "Kat. broj",
          "Naziv robe / opis",
          "JM",
          "Količina",
          "Cena",
          "Iznos",
        ]
      : ["R.br.", "Kat. broj", "Naziv robe / opis", "JM", "Količina"];
    const widths: (string | number)[] = withPrices
      ? [22, 62, "*", 26, 58, 58, 70]
      : [22, 62, "*", 26, 58];

    const headerCells: Content[] = head.map((text, i) => ({
      text,
      style: "th",
      alignment: i >= 3 ? "right" : "left",
    }));

    const body: Content[][] = order.items.map((it, idx) => {
      const art = it.articleId != null ? articles.get(it.articleId) : undefined;
      const name = art?.name ?? it.description ?? "—";
      const unit = it.unit ?? art?.unit ?? "";
      const price = it.unitPrice ?? new Prisma.Decimal(0);
      const amount = price.mul(it.orderedQuantity);
      const row: Content[] = [
        { text: String(idx + 1), style: "td" },
        { text: art?.catalogNumber ?? "", style: "td" },
        { text: name, style: "td" },
        { text: unit, style: "tdNum" },
        { text: fmtQty(it.orderedQuantity), style: "tdNum" },
      ];
      if (withPrices) {
        row.push({
          text: it.unitPrice != null ? fmtMoney(price) : "—",
          style: "tdNum",
        });
        row.push({ text: fmtMoney(amount), style: "tdNum" });
      }
      return row;
    });

    return {
      table: { headerRows: 1, widths, body: [headerCells, ...body] },
      layout: TABLE_LAYOUT,
    };
  }

  /** Zbir + iznos u slovima (BigBit ima samo `Sum()` bez slova). */
  private buildTotals(total: Prisma.Decimal, currency: string): Content {
    return {
      unbreakable: true,
      margin: [0, 10, 0, 0],
      stack: [
        {
          columns: [
            { width: "*", text: "" },
            {
              width: 240,
              table: {
                widths: ["*", 90],
                body: [
                  [
                    { text: "UKUPNO:", style: "totLbl" },
                    { text: `${fmtMoney(total)} ${currency}`, style: "grand" },
                  ],
                ],
              },
              layout: {
                hLineWidth: (i: number) => (i === 0 ? 0.8 : 0),
                vLineWidth: () => 0,
                hLineColor: () => "#333333",
                paddingTop: () => 4,
                paddingBottom: () => 2,
                paddingLeft: () => 4,
                paddingRight: () => 4,
              },
            },
          ],
        },
        {
          text: `Slovima: ${amountInWords(total, currency)}`,
          fontSize: 8,
          italics: true,
          color: "#444",
          margin: [0, 6, 0, 0],
        },
      ],
    };
  }
}

/** Status narudžbenice → značka u zaglavlju (i vodeni žig za DRAFT). */
function statusBadge(status: string): StatusBadgeSpec {
  switch (status) {
    case "DRAFT":
      return { label: "NACRT", tone: "draft" };
    case "ORDERED":
      return { label: "PORUČENO", tone: "neutral" };
    case "SIGNED":
      return { label: "POTPISANO", tone: "ok" };
    case "LOCKED":
      return { label: "ZAKLJUČANO", tone: "ok" };
    case "RECEIVED":
      return { label: "PRIMLJENO", tone: "ok" };
    case "CLOSED":
      return { label: "ZATVORENO", tone: "neutral" };
    default:
      return { label: status, tone: "neutral" };
  }
}

/** Firma-izdavalac u obliku „strane" za dvokolonski blok. */
function issuerAsParty(issuer: IssuerInfo): PartyInfo {
  return {
    name: issuer.companyName,
    address: issuer.address,
    postalCode: issuer.postalCode,
    city: issuer.city,
    taxId: issuer.taxId,
    registrationNumber: issuer.registrationNumber,
    bankAccount: issuer.bankAccount,
    email: issuer.email,
    phone: issuer.phone,
  };
}
