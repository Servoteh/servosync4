import { Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type {
  Content,
  TableCell,
  TDocumentDefinitions,
} from "pdfmake/interfaces";
import { PrismaService } from "../../../prisma/prisma.service";
import { PdfService } from "../../documents/pdf.service";
import { BarcodeService } from "../../documents/barcode.service";
import {
  DEFAULT_STYLE,
  PAGE_LANDSCAPE,
  PAGE_PORTRAIT,
  ROBNO_STYLES,
  COMPACT_TABLE_LAYOUT,
  buildAmountInWords,
  buildDocHeader,
  buildDocTable,
  buildEmptyNotice,
  buildMeta,
  buildParties,
  buildPageFooter,
  buildSignatureRow,
  fmtDate,
  fmtMoney,
  fmtPercent,
  fmtQty,
  loadIssuer,
  loadPrintedBy,
  roundingTolerance,
  safeFileName,
  sanitizeText,
  type DocBadge,
  type DocColumn,
  type IssuerInfo,
  type PartyBlock,
} from "./robno-doc-layout";

/**
 * Štampa robnih dokumenata (`stock_documents` + `stock_document_items`) — BigBit paritet
 * i nadgradnja. Jedan servis, više obrazaca (kao `invoice-pdf` sa varijantama):
 *
 *   `primka`      — Prijemnica / primka robe (BigBit `Prijemnica`), za UL
 *   `izdatnica`   — Izlaz robe iz magacina (BigBit `NalogZaIzdavanjeRobe`), za IZ
 *   `otpremnica`  — Otpremnica BEZ cena sa barkodovima (BigBit `OtpremnicaBezCena`), za IZ
 *   `nivelacija`  — Nivelacija cena (BigBit `NivelacijaZalihaVP`), za NIV
 *   `prenosnica`  — Prenos između magacina (BigBit `Prenosnica - DEFAULT`), za PRENOS
 *   `kalkulacija` — Kalkulacija nabavne/prodajne cene, obrazac KL (landed cost), za UL
 *   `zapisnik`    — Zapisnik o višku/manjku iz popisa, za VISAK/MANJAK
 *
 * Nadgradnja u odnosu na BigBit (v. `robno-doc-layout`):
 *   - PRENOSNICA nosi OBA magacina („IZ MAGACINA → U MAGACIN") — BigBit štampa samo odredište,
 *     pa se nije videlo odakle roba ide;
 *   - statusna značka + vodeni žig „NACRT" na neknjiženom dokumentu;
 *   - „strana N/M" i trag štampe na svakom obrascu;
 *   - iznos u slovima na dokumentima sa vrednošću;
 *   - Code 128 barkod broja dokumenta u zaglavlju i barkod artikla po stavci na otpremnici.
 *
 * Renderer je zajednički `PdfService` (pdfmake) — bez novih zavisnosti.
 */
export type StockPrintVariant =
  | "primka"
  | "izdatnica"
  | "otpremnica"
  | "nivelacija"
  | "prenosnica"
  | "kalkulacija"
  | "zapisnik";

export const STOCK_PRINT_VARIANTS: StockPrintVariant[] = [
  "primka",
  "izdatnica",
  "otpremnica",
  "nivelacija",
  "prenosnica",
  "kalkulacija",
  "zapisnik",
];

const ZERO = new Prisma.Decimal(0);

type DocWithItems = Prisma.StockDocumentGetPayload<{
  include: { items: true; stockLevelingItems: true };
}>;

interface ItemMeta {
  id: number;
  name: string;
  catalogNumber: string;
  barCode: string | null;
  unit: string | null;
  transportPackaging: number | null;
  goodsTaxRateCode: string;
}

interface PartyMeta {
  name: string;
  address: string | null;
  city: string | null;
  postalCode: string | null;
  taxId: string | null;
  registrationNumber: string | null;
  phone: string | null;
}

interface WarehouseMeta {
  id: number;
  name: string;
  street: string | null;
  city: string | null;
  managerName: string | null;
}

@Injectable()
export class StockDocumentPdfService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pdf: PdfService,
    private readonly barcode: BarcodeService,
  ) {}

  /** Podrazumevani obrazac po vrsti dokumenta (kad korisnik ne bira varijantu). */
  static defaultVariant(kind: string): StockPrintVariant {
    switch (kind) {
      case "UL":
        return "primka";
      case "IZ":
        return "izdatnica";
      case "NIV":
        return "nivelacija";
      case "PRENOS":
        return "prenosnica";
      case "VISAK":
      case "MANJAK":
        return "zapisnik";
      default:
        return "izdatnica";
    }
  }

  /**
   * Generiši PDF robnog dokumenta. `variant` bira obrazac; kad se ne prosledi, izvodi se
   * iz `kind`. Vraća `{ buffer, fileName }`. Dokument bez stavki NE puca — štampa se sa
   * jasnom napomenom (zaglavlje, potpisi i noga ostaju).
   */
  async buildPdf(
    documentId: number,
    variant?: StockPrintVariant,
    userId?: number | null,
  ): Promise<{ buffer: Buffer; fileName: string }> {
    const doc = await this.prisma.stockDocument.findUnique({
      where: { id: documentId },
      include: {
        // Meko obrisane stavke se NE štampaju (isti filter kao detalj/kalkulacija).
        items: {
          where: { deletedAt: null },
          orderBy: [{ lineNo: "asc" }, { id: "asc" }],
        },
        stockLevelingItems: { orderBy: { id: "asc" } },
      },
    });
    if (!doc)
      throw new NotFoundException(`Robni dokument ${documentId} ne postoji.`);

    const effective =
      variant ?? StockDocumentPdfService.defaultVariant(doc.kind);

    const itemIds = [
      ...new Set([
        ...doc.items.map((i) => i.itemId),
        ...doc.stockLevelingItems.map((i) => i.itemId),
      ]),
    ];

    const [
      issuer,
      printedBy,
      itemsById,
      warehouse,
      targetWarehouse,
      party,
      docTypeName,
      taxRates,
    ] = await Promise.all([
      loadIssuer(this.prisma, doc.companyId),
      loadPrintedBy(this.prisma, userId),
      this.loadItems(itemIds),
      this.loadWarehouse(doc.warehouseId),
      this.loadWarehouse(doc.targetWarehouseId),
      this.loadParty(doc.supplierId ?? doc.customerId ?? null),
      this.loadDocumentTypeName(doc.documentTypeCode),
      this.loadTaxRates(),
    ]);

    const docDefinition = this.buildDocDefinition({
      doc,
      variant: effective,
      issuer,
      printedBy,
      itemsById,
      warehouse,
      targetWarehouse,
      party,
      docTypeName,
      taxRates,
    });

    const buffer = await this.pdf.render(docDefinition);
    const prefix = FILE_PREFIX[effective];
    return {
      buffer,
      fileName: `${prefix}-${safeFileName(doc.documentNumber)}.pdf`,
    };
  }

  // ─────────────────────────────────────────────────── učitavanje (meki ref-ovi)

  private async loadItems(ids: number[]): Promise<Map<number, ItemMeta>> {
    if (!ids.length) return new Map();
    const rows = await this.prisma.item.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        name: true,
        catalogNumber: true,
        barCode: true,
        unit: true,
        transportPackaging: true,
        goodsTaxRateCode: true,
      },
    });
    // Nazivi artikala mašinogradnje nose ⌀ (prečnik) — Roboto ga nema i štampao
    // se kao prazan kvadratić; `sanitizeText` ga preslikava na Ø.
    return new Map(
      rows.map((r) => [
        r.id,
        { ...r, name: sanitizeText(r.name), catalogNumber: r.catalogNumber },
      ]),
    );
  }

  private async loadWarehouse(
    id: number | null,
  ): Promise<WarehouseMeta | null> {
    if (id == null || id <= 0) return null;
    const w = await this.prisma.warehouse.findUnique({
      where: { id },
      select: {
        id: true,
        name: true,
        street: true,
        city: true,
        managerName: true,
      },
    });
    return w ?? null;
  }

  private async loadParty(id: number | null): Promise<PartyMeta | null> {
    if (id == null || id <= 0) return null;
    const c = await this.prisma.customer.findUnique({
      where: { id },
      select: {
        name: true,
        address: true,
        city: true,
        postalCode: true,
        taxId: true,
        registrationNumber: true,
        phone: true,
      },
    });
    return c ?? null;
  }

  private async loadDocumentTypeName(code: string): Promise<string | null> {
    const t = await this.prisma.documentType.findUnique({
      where: { code },
      select: { description: true },
    });
    return t?.description ?? null;
  }

  /** Šifra poreske stope → osnovna stopa (%), za kolonu „PDV %" na otpremnici/kalkulaciji. */
  private async loadTaxRates(): Promise<Map<string, number>> {
    const rows = await this.prisma.taxRate.findMany({
      select: { code: true, baseRate: true },
    });
    return new Map(rows.map((r) => [r.code, r.baseRate ?? 0]));
  }

  /** Code 128 broja dokumenta; nikad ne baca (dokument bez broja = bez barkoda). */
  private code128(value: string, height = 10): string | null {
    const v = (value ?? "").trim();
    if (!v) return null;
    try {
      return this.barcode.code128Svg(v, { height });
    } catch {
      return null;
    }
  }

  // ──────────────────────────────────────────────────────── definicija dokumenta

  private buildDocDefinition(args: {
    doc: DocWithItems;
    variant: StockPrintVariant;
    issuer: IssuerInfo;
    printedBy: string | null;
    itemsById: Map<number, ItemMeta>;
    warehouse: WarehouseMeta | null;
    targetWarehouse: WarehouseMeta | null;
    party: PartyMeta | null;
    docTypeName: string | null;
    taxRates: Map<string, number>;
  }): TDocumentDefinitions {
    const { doc, variant, issuer, printedBy } = args;
    // Nivelacija ima 10 kolona od kojih 5 novčanih: na uspravnom A4 fiksne
    // širine + padding prelaze širinu sadržaja, pa poslednja kolona
    // („Nivelacija" — ono zbog čega dokument postoji) ispadne van papira.
    const landscape = variant === "kalkulacija" || variant === "nivelacija";
    const page = landscape ? PAGE_LANDSCAPE : PAGE_PORTRAIT;

    const badge = statusBadge(doc.status);
    const title = TITLES[variant](doc.kind);
    const formCode = variant === "kalkulacija" ? "Obrazac - KL" : null;

    const header = buildDocHeader({
      issuer,
      title,
      subtitle: `br. ${doc.documentNumber}   ·   ${fmtDate(doc.documentDate)}`,
      formCode,
      badge,
      barcodeSvg: this.code128(
        `SD:${doc.documentTypeCode}:${doc.documentNumber}`,
      ),
      compact: landscape,
    });

    const parties = this.buildPartyBlock(args);
    const meta = buildMeta(this.metaPairs(args));

    const bodyContent =
      variant === "nivelacija"
        ? this.buildNivelacijaBody(args)
        : variant === "kalkulacija"
          ? this.buildKalkulacijaBody(args)
          : variant === "otpremnica"
            ? this.buildOtpremnicaBody(args)
            : this.buildValueBody(args);

    const content: Content[] = [header, parties, meta, ...bodyContent];

    if (variant === "kalkulacija") {
      content.push(this.buildImportStrip(doc));
    }
    content.push(
      buildSignatureRow(SIGNATURES[variant], { stampOn: STAMP_ON[variant] }),
    );

    return {
      ...page,
      // Neknjižen dokument nosi vidljiv žig — BigBit ovo NEMA, pa se nacrt i
      // proknjižen dokument u ruci ne razlikuju.
      watermark:
        doc.status === "DRAFT"
          ? {
              text: "NACRT — nije knjiženo",
              opacity: 0.07,
              bold: true,
              angle: -30,
            }
          : undefined,
      content,
      styles: ROBNO_STYLES,
      defaultStyle: DEFAULT_STYLE,
      footer: buildPageFooter(
        `${title} br. ${doc.documentNumber}`,
        printedBy,
        landscape ? 24 : 32,
      ),
    };
  }

  /** Strane dokumenta — natpisi po BigBit terminologiji, po vrsti dokumenta. */
  private buildPartyBlock(args: {
    doc: DocWithItems;
    variant: StockPrintVariant;
    warehouse: WarehouseMeta | null;
    targetWarehouse: WarehouseMeta | null;
    party: PartyMeta | null;
  }): Content {
    const { doc, variant, warehouse, targetWarehouse, party } = args;

    const whBlock = (
      label: string,
      w: WarehouseMeta | null,
      id: number | null,
    ): PartyBlock => ({
      label,
      name: w ? w.name : id != null ? `Magacin #${id}` : "—",
      lines: [
        [w?.street, w?.city].filter(Boolean).join(", ") || null,
        w?.managerName ? `Magacioner: ${w.managerName}` : null,
      ],
    });
    const partyBlock = (label: string): PartyBlock => ({
      label,
      name: party?.name ?? "—",
      lines: [
        [party?.postalCode, party?.city].filter(Boolean).join(" ") || null,
        party?.address ?? null,
        [
          party?.taxId ? `PIB: ${party.taxId}` : null,
          party?.registrationNumber ? `MB: ${party.registrationNumber}` : null,
        ]
          .filter(Boolean)
          .join("   ·   ") || null,
      ],
    });

    if (variant === "prenosnica") {
      // Nadgradnja: BigBit `Prenosnica - DEFAULT` imenuje SAMO odredište („U prodavnicu:"),
      // pa se iz papira ne vidi odakle je roba otišla.
      return buildParties(
        whBlock("IZ MAGACINA", warehouse, doc.warehouseId),
        whBlock("U MAGACIN", targetWarehouse, doc.targetWarehouseId),
      );
    }
    if (variant === "primka" || variant === "kalkulacija") {
      return buildParties(
        partyBlock("Isporučilac robe"),
        whBlock("Magacin prijema", warehouse, doc.warehouseId),
      );
    }
    if (variant === "izdatnica" || variant === "otpremnica") {
      return buildParties(
        partyBlock("K u p a c"),
        whBlock("Magacin izdavanja", warehouse, doc.warehouseId),
      );
    }
    return buildParties(whBlock("Magacin", warehouse, doc.warehouseId), null);
  }

  private metaPairs(args: {
    doc: DocWithItems;
    variant: StockPrintVariant;
    docTypeName: string | null;
  }): Array<[string, string]> {
    const { doc, docTypeName, variant } = args;
    const pairs: Array<[string, string]> = [
      ["Broj dokumenta", doc.documentNumber],
      [
        "Vrsta",
        `${doc.documentTypeCode}${docTypeName ? ` — ${docTypeName}` : ""}`,
      ],
      ["Datum dokumenta", fmtDate(doc.documentDate)],
      ["Datum knjiženja", fmtDate(doc.postingDate)],
    ];
    if (variant === "otpremnica") {
      // BigBit `OtpremnicaBezCena` traka od 4 polja iznad tabele.
      pairs.push(["Roba je FCO", "magacin isporučioca"]);
      pairs.push(["Način otpreme", "sopstveni prevoz"]);
      pairs.push(["Datum otpreme", fmtDate(doc.documentDate)]);
      pairs.push(["Mesto prometa", "magacin"]);
    }
    if (doc.projectId) pairs.push(["Predmet", String(doc.projectId)]);
    if (doc.workOrderId) pairs.push(["Radni nalog", String(doc.workOrderId)]);
    if (doc.purchaseOrderId)
      pairs.push(["Narudžbenica", String(doc.purchaseOrderId)]);
    if (doc.inventoryCountId)
      pairs.push(["Popis", String(doc.inventoryCountId)]);
    if (doc.linkedInboundDocId)
      pairs.push(["Parni dokument", String(doc.linkedInboundDocId)]);
    if (doc.journalEntryId)
      pairs.push(["Nalog GK", String(doc.journalEntryId)]);
    return pairs;
  }

  // ────────────────────────────────────────────── telo: vrednosni obrasci

  /** Primka / izdatnica / prenosnica / zapisnik — tabela sa cenom i vrednošću. */
  private buildValueBody(args: {
    doc: DocWithItems;
    variant: StockPrintVariant;
    itemsById: Map<number, ItemMeta>;
  }): Content[] {
    const { doc, variant, itemsById } = args;
    if (!doc.items.length) return [emptyDocNotice()];

    const inbound =
      variant === "primka" || doc.kind === "UL" || doc.kind === "VISAK";
    const priceHeader = inbound ? "Nabavna neto" : "Cena";

    // Širine su podešene tako da i primka sa fakturnom cenom i rabatom (9 kolona)
    // ostavi bar 110 pt za naziv artikla — inače se naziv „Ležaj kuglični SKF
    // 6208-2RS čelik 8" lomi u pet redova i 36 artikala ode na pet strana.
    const columns: DocColumn[] = [
      { header: "R.br.", width: 22, numeric: true },
      { header: "Kat. broj", width: 54 },
      { header: "Naziv artikla", width: "*" },
      { header: "J.m.", width: 22 },
      { header: "Količina", width: 46, numeric: true },
      { header: priceHeader, width: 54, numeric: true },
      { header: "Vrednost", width: 62, numeric: true },
    ];
    if (variant === "primka") {
      columns.splice(5, 0, { header: "Fakturna", width: 50, numeric: true });
      columns.splice(6, 0, { header: "Rabat", width: 34, numeric: true });
    }

    let sumQty = ZERO;
    let sumValue = ZERO;

    const rows: TableCell[][] = doc.items.map((it, idx) => {
      const meta = itemsById.get(it.itemId);
      const price = this.linePrice(it, inbound);
      const value = it.quantity.mul(price).toDecimalPlaces(2);
      sumQty = sumQty.add(it.quantity);
      sumValue = sumValue.add(value);

      const cells: TableCell[] = [
        { text: String(it.lineNo || idx + 1), style: "tdNum" },
        { text: meta?.catalogNumber ?? "—", style: "td" },
        { text: meta?.name ?? `Artikal #${it.itemId}`, style: "td" },
        { text: meta?.unit ?? "", style: "td" },
        { text: fmtQty(it.quantity), style: "tdNum" },
      ];
      if (variant === "primka") {
        cells.push({ text: fmtMoney(it.invoicePrice), style: "tdNum" });
        cells.push({ text: fmtPercent(it.discountPercent), style: "tdNum" });
      }
      cells.push({ text: fmtMoney(price), style: "tdNum" });
      cells.push({ text: fmtMoney(value), style: "tdNum" });
      return cells;
    });

    // Zbir: natpis preko prve 4 kolone, Σ količina pod kolonom količine, Σ vrednost
    // pod poslednjom kolonom; broj praznih ćelija između se izvodi iz širine tabele.
    const totals: TableCell[][] = [
      [
        { text: "UKUPNO", colSpan: 4, style: "totLbl" },
        { text: "" },
        { text: "" },
        { text: "" },
        { text: fmtQty(sumQty), style: "totVal" },
        ...Array.from({ length: columns.length - 6 }, () => ({ text: "" })),
        { text: fmtMoney(sumValue), style: "totVal" },
      ],
    ];

    const out: Content[] = [buildDocTable({ columns, rows, totals })];
    out.push(buildAmountInWords(sumValue));
    out.push({
      margin: [0, 6, 0, 0],
      style: "note",
      text: `Kontrola: stavki ${doc.items.length}   ·   Σ količina ${fmtQty(
        sumQty,
      )}   ·   Σ vrednost ${fmtMoney(sumValue)}`,
    });
    return out;
  }

  /** Cena stavke: ulaz = nabavna neto (fallback fakturna), izlaz = stvarna VP (fallback kalk. VP). */
  private linePrice(
    it: DocWithItems["items"][number],
    inbound: boolean,
  ): Prisma.Decimal {
    if (inbound) {
      const landed = it.purchasePriceNet
        .add(it.dependentCostOwn)
        .add(it.dependentCostSupplier);
      return landed.isZero() ? it.invoicePrice : landed;
    }
    if (!it.actualWholesalePrice.isZero()) return it.actualWholesalePrice;
    if (!it.calculatedWholesalePrice.isZero())
      return it.calculatedWholesalePrice;
    return it.invoicePrice;
  }

  // ─────────────────────────────────────────────────── telo: otpremnica

  /**
   * Otpremnica BEZ cena (BigBit `OtpremnicaBezCena`): PDV %, kat. broj, BARKOD po stavci,
   * naziv, transportno pakovanje, j.m., količina. Barkod je Code 128 SVG (mi to već umemo
   * iz štampe radnog naloga) — BigBit ga štampa samo kao tekst.
   */
  private buildOtpremnicaBody(args: {
    doc: DocWithItems;
    itemsById: Map<number, ItemMeta>;
    taxRates: Map<string, number>;
  }): Content[] {
    const { doc, itemsById, taxRates } = args;
    if (!doc.items.length) return [emptyDocNotice()];

    const columns: DocColumn[] = [
      { header: "R.br.", width: 22, numeric: true },
      { header: "PDV %", width: 34, numeric: true },
      { header: "Kat. broj", width: 62 },
      { header: "Bar kod", width: 96 },
      { header: "N A Z I V   R O B E", width: "*" },
      { header: "Tr. pak.", width: 40, numeric: true },
      { header: "J.m.", width: 26 },
      { header: "Količina", width: 56, numeric: true },
    ];

    let sumQty = ZERO;
    const rows: TableCell[][] = doc.items.map((it, idx) => {
      const meta = itemsById.get(it.itemId);
      sumQty = sumQty.add(it.quantity);
      const rate = taxRates.get(it.goodsTaxRateCode ?? "") ?? 0;
      const barValue = (meta?.barCode ?? "").trim();
      const svg = barValue ? this.code128(barValue, 7) : null;
      return [
        { text: String(it.lineNo || idx + 1), style: "tdNum" },
        { text: rate ? fmtQty(rate, 0) : "", style: "tdNum" },
        { text: meta?.catalogNumber ?? "—", style: "td" },
        svg
          ? { svg, fit: [92, 22] }
          : { text: barValue || "—", style: "tdMuted" },
        { text: meta?.name ?? `Artikal #${it.itemId}`, style: "td" },
        {
          text: meta?.transportPackaging
            ? fmtQty(meta.transportPackaging, 2)
            : "",
          style: "tdNum",
        },
        { text: meta?.unit ?? "", style: "td" },
        { text: fmtQty(it.quantity), style: "tdNum" },
      ];
    });

    const totals: TableCell[][] = [
      [
        { text: "UKUPNO", colSpan: 7, style: "totLbl" },
        ...Array.from({ length: 6 }, () => ({ text: "" })),
        { text: fmtQty(sumQty), style: "totVal" },
      ],
    ];

    return [
      buildDocTable({ columns, rows, totals }),
      {
        margin: [0, 8, 0, 0],
        style: "note",
        text:
          "Roba se otprema po osnovu navedenog dokumenta. Primalac je dužan da robu " +
          "pregleda odmah po prijemu i eventualne primedbe unese na ovu otpremnicu.",
      },
      {
        margin: [0, 4, 0, 0],
        style: "note",
        text: `Kontrola: stavki ${doc.items.length}   ·   Σ količina ${fmtQty(sumQty)}`,
      },
    ];
  }

  // ─────────────────────────────────────────────────── telo: nivelacija

  /**
   * Nivelacija cena (BigBit `NivelacijaZalihaVP`). Nova cena se ispisuje SAMO ako se razlikuje
   * od stare (BigBit `IIf(Abs(nova-stara)<0.001;"";nova)`) — nepromenjeni redovi ostaju prazni.
   */
  private buildNivelacijaBody(args: {
    doc: DocWithItems;
    itemsById: Map<number, ItemMeta>;
  }): Content[] {
    const { doc, itemsById } = args;
    const lines = doc.stockLevelingItems;
    if (!lines.length) {
      return [
        buildEmptyNotice(
          "Nema nivelacionih stavki",
          "Nivelacioni parovi (stara → nova cena) nastaju kalkulacijom ulaznog dokumenta. " +
            "Pokreni kalkulaciju, pa ponovi štampu.",
        ),
      ];
    }

    const columns: DocColumn[] = [
      { header: "R.br.", width: 22, numeric: true },
      { header: "Kat. broj", width: 62 },
      { header: "Naziv artikla", width: "*" },
      { header: "J.m.", width: 24 },
      { header: "Količina", width: 50, numeric: true },
      { header: "Stara VP", width: 54, numeric: true },
      { header: "Nova VP", width: 54, numeric: true },
      { header: "Stara vrednost", width: 66, numeric: true },
      { header: "Nova vrednost", width: 66, numeric: true },
      { header: "Nivelacija", width: 62, numeric: true },
    ];

    // Zbirovi za red UKUPNO idu nad ZAOKRUŽENIM vrednostima (moraju biti jednaki
    // sabiranju odštampane kolone), a kontrola u nozi nad NEZAOKRUŽENIM — inače
    // zaokružna razlika po stavci lažno pali „NEUSKLAĐENO" na ispravnim podacima.
    let sumOld = ZERO;
    let sumNew = ZERO;
    let sumDiff = ZERO;
    let exactOld = ZERO;
    let exactNew = ZERO;

    const rows: TableCell[][] = lines.map((l, idx) => {
      const meta = itemsById.get(l.itemId);
      const oldValue = l.quantityRevalued
        .mul(l.oldWholesalePrice)
        .toDecimalPlaces(2);
      const newValue = l.quantityRevalued
        .mul(l.newWholesalePrice)
        .toDecimalPlaces(2);
      sumOld = sumOld.add(oldValue);
      sumNew = sumNew.add(newValue);
      sumDiff = sumDiff.add(l.valueAdjustment);
      exactOld = exactOld.add(l.quantityRevalued.mul(l.oldWholesalePrice));
      exactNew = exactNew.add(l.quantityRevalued.mul(l.newWholesalePrice));
      const changed = l.newWholesalePrice
        .minus(l.oldWholesalePrice)
        .abs()
        .gte(0.001);
      return [
        { text: String(idx + 1), style: "tdNum" },
        { text: meta?.catalogNumber ?? "—", style: "td" },
        { text: meta?.name ?? `Artikal #${l.itemId}`, style: "td" },
        { text: meta?.unit ?? "", style: "td" },
        { text: fmtQty(l.quantityRevalued), style: "tdNum" },
        { text: fmtMoney(l.oldWholesalePrice), style: "tdNum" },
        { text: changed ? fmtMoney(l.newWholesalePrice) : "", style: "tdNum" },
        { text: fmtMoney(oldValue), style: "tdNum" },
        { text: changed ? fmtMoney(newValue) : "", style: "tdNum" },
        { text: fmtMoney(l.valueAdjustment), style: "tdNum" },
      ];
    });

    const totals: TableCell[][] = [
      [
        { text: "UKUPNO", colSpan: 7, style: "totLbl" },
        ...Array.from({ length: 6 }, () => ({ text: "" })),
        { text: fmtMoney(sumOld), style: "totVal" },
        { text: fmtMoney(sumNew), style: "totVal" },
        { text: fmtMoney(sumDiff), style: "totVal" },
      ],
    ];

    const exactDiff = exactNew.minus(exactOld);
    const nivDeviation = exactDiff.minus(sumDiff).abs();
    return [
      buildDocTable({ columns, rows, totals }),
      buildAmountInWords(sumDiff),
      {
        margin: [0, 6, 0, 0],
        style: "note",
        text: `Kontrola: stavki ${lines.length}   ·   razlika vrednosti (nova - stara) ${fmtMoney(
          exactDiff,
        )}   ·   knjižena nivelacija ${fmtMoney(sumDiff)}`,
      },
      nivDeviation.gt(roundingTolerance(lines.length))
        ? {
            margin: [0, 4, 0, 0],
            style: "warn",
            text: "NEUSKLAĐENO — razlika vrednosti se ne poklapa sa knjiženom nivelacijom.",
          }
        : { text: "" },
    ];
  }

  // ─────────────────────────────────────────────────── telo: kalkulacija (KL)

  /**
   * Kalkulacija nabavne/prodajne cene — obrazac KL, A4 POLOŽENO (BigBit `Kalkulacija - DEFAULT`).
   * Ćelije novčanih kolona su DVOREDNE kao u BigBitu: gore jedinična cena, dole vrednost
   * (količina × cena).
   */
  private buildKalkulacijaBody(args: {
    doc: DocWithItems;
    itemsById: Map<number, ItemMeta>;
    taxRates: Map<string, number>;
  }): Content[] {
    const { doc, itemsById, taxRates } = args;
    if (!doc.items.length) return [emptyDocNotice()];

    const columns: DocColumn[] = [
      // Širine su izmerene tako da fiksni deo + padding stanu u širinu sadržaja
      // položenog A4 (v. `widthSlack` test) — inače „*" kolona naziva dobije
      // negativnu širinu i poslednja kolona („MP cena") ispadne van papira.
      { header: "R.br.", width: 20, numeric: true },
      { header: "Kat. broj", width: 50 },
      { header: "Naziv artikla", width: "*" },
      { header: "J.m.", width: 20 },
      { header: "Količina", width: 42, numeric: true },
      { header: "Fakturna\ncena / vred.", width: 56, numeric: true },
      { header: "Rabat %\n/ iznos", width: 46, numeric: true },
      { header: "Nab. neto\ncena / vred.", width: 56, numeric: true },
      { header: "ZT sopstveni", width: 44, numeric: true },
      { header: "ZT dobavljača", width: 44, numeric: true },
      { header: "Nab. cena\n/ vrednost", width: 56, numeric: true },
      { header: "Razlika\nu ceni", width: 44, numeric: true },
      { header: "Kalk. VP\ncena / vred.", width: 56, numeric: true },
      { header: "PDV\n%", width: 22, numeric: true },
      { header: "MP cena\n/ vrednost", width: 56, numeric: true },
    ];

    let sQty = ZERO;
    let sInvoice = ZERO;
    let sDiscount = ZERO;
    let sNet = ZERO;
    let sZtOwn = ZERO;
    let sZtSup = ZERO;
    let sLanded = ZERO;
    let sMarkup = ZERO;
    let sVp = ZERO;
    let sMp = ZERO;

    // `noWrap`: novčana vrednost se NE sme prelomiti usred broja — inače se sa
    // papira pročita „12.345.678,9" (manji iznos) umesto odsečenog. Prelivanje
    // je vidljiva greška, tiho lomljenje nije.
    const two = (top: string, bottom: string): TableCell => ({
      text: `${top}\n${bottom}`,
      style: "tdNum",
      fontSize: 7,
      noWrap: true,
    });

    const rows: TableCell[][] = doc.items.map((it, idx) => {
      const meta = itemsById.get(it.itemId);
      const qty = it.quantity;
      const invoiceValue = qty.mul(it.invoicePrice).toDecimalPlaces(2);
      const discountAmount = invoiceValue
        .mul(it.discountPercent)
        .div(100)
        .toDecimalPlaces(2);
      const netValue = qty.mul(it.purchasePriceNet).toDecimalPlaces(2);
      const ztOwn = qty.mul(it.dependentCostOwn).toDecimalPlaces(2);
      const ztSup = qty.mul(it.dependentCostSupplier).toDecimalPlaces(2);
      const landedPrice = it.purchasePriceNet
        .add(it.dependentCostOwn)
        .add(it.dependentCostSupplier);
      const landedValue = qty.mul(landedPrice).toDecimalPlaces(2);
      const markupValue = qty.mul(it.markupAmount).toDecimalPlaces(2);
      const vpValue = qty.mul(it.calculatedWholesalePrice).toDecimalPlaces(2);
      const mpValue = qty.mul(it.calculatedRetailPrice).toDecimalPlaces(2);

      sQty = sQty.add(qty);
      sInvoice = sInvoice.add(invoiceValue);
      sDiscount = sDiscount.add(discountAmount);
      sNet = sNet.add(netValue);
      sZtOwn = sZtOwn.add(ztOwn);
      sZtSup = sZtSup.add(ztSup);
      sLanded = sLanded.add(landedValue);
      sMarkup = sMarkup.add(markupValue);
      sVp = sVp.add(vpValue);
      sMp = sMp.add(mpValue);

      const rate = taxRates.get(it.goodsTaxRateCode ?? "") ?? 0;
      return [
        { text: String(it.lineNo || idx + 1), style: "tdNum" },
        { text: meta?.catalogNumber ?? "—", style: "td" },
        { text: meta?.name ?? `Artikal #${it.itemId}`, style: "td" },
        { text: meta?.unit ?? "", style: "td" },
        { text: fmtQty(qty), style: "tdNum" },
        two(fmtMoney(it.invoicePrice), fmtMoney(invoiceValue)),
        two(fmtPercent(it.discountPercent) || "—", fmtMoney(discountAmount)),
        two(fmtMoney(it.purchasePriceNet), fmtMoney(netValue)),
        two(fmtMoney(it.dependentCostOwn), fmtMoney(ztOwn)),
        two(fmtMoney(it.dependentCostSupplier), fmtMoney(ztSup)),
        two(fmtMoney(landedPrice), fmtMoney(landedValue)),
        two(fmtMoney(it.markupAmount), fmtMoney(markupValue)),
        two(fmtMoney(it.calculatedWholesalePrice), fmtMoney(vpValue)),
        { text: rate ? fmtQty(rate, 0) : "", style: "tdNum" },
        two(fmtMoney(it.calculatedRetailPrice), fmtMoney(mpValue)),
      ];
    });

    const totals: TableCell[][] = [
      [
        { text: "UKUPNO", colSpan: 4, style: "totLbl" },
        { text: "" },
        { text: "" },
        { text: "" },
        { text: fmtQty(sQty), style: "totVal" },
        { text: fmtMoney(sInvoice), style: "totVal" },
        { text: fmtMoney(sDiscount), style: "totVal" },
        { text: fmtMoney(sNet), style: "totVal" },
        { text: fmtMoney(sZtOwn), style: "totVal" },
        { text: fmtMoney(sZtSup), style: "totVal" },
        { text: fmtMoney(sLanded), style: "totVal" },
        { text: fmtMoney(sMarkup), style: "totVal" },
        { text: fmtMoney(sVp), style: "totVal" },
        { text: "" },
        { text: fmtMoney(sMp), style: "totVal" },
      ],
    ];

    const control = sNet.add(sZtOwn).add(sZtSup).add(sMarkup).minus(sVp).abs();
    return [
      // 15 kolona — uži prelom, da naziv artikla ostane čitljiv.
      buildDocTable({ columns, rows, totals, layout: COMPACT_TABLE_LAYOUT }),
      buildAmountInWords(sLanded),
      {
        margin: [0, 6, 0, 0],
        style: "note",
        text:
          `Kontrola kalkulacije: nabavna neto + zavisni troškovi + razlika u ceni = kalkulisana VP   ·   ` +
          `${fmtMoney(sNet)} + ${fmtMoney(sZtOwn.add(sZtSup))} + ${fmtMoney(
            sMarkup,
          )} = ${fmtMoney(sVp)}   ·   odstupanje ${fmtMoney(control)}`,
      },
      control.gt(roundingTolerance(doc.items.length))
        ? {
            margin: [0, 4, 0, 0],
            style: "warn",
            text: "NEUSKLAĐENO — kalkulacija ne zatvara. Ponovi kalkulaciju pre knjiženja.",
          }
        : { text: "" },
    ];
  }

  /** Traka kurseva i doc-level zavisnih troškova (uvoz) — iznad potpisa na kalkulaciji. */
  private buildImportStrip(doc: DocWithItems): Content {
    return {
      margin: [0, 10, 0, 0],
      table: {
        widths: ["*", "*", "*", "*", "*", "*"],
        body: [
          [
            { text: "Obračunski kurs", style: "metaLbl" },
            { text: "Carinski kurs", style: "metaLbl" },
            { text: "Carina", style: "metaLbl" },
            { text: "Špedicija", style: "metaLbl" },
            { text: "Ostali zav. troškovi", style: "metaLbl" },
            { text: "Devizna vrednost fakture", style: "metaLbl" },
          ],
          [
            { text: fmtQty(doc.accountingExchangeRate, 4), style: "tdNum" },
            { text: fmtQty(doc.customsExchangeRate, 4), style: "tdNum" },
            { text: fmtMoney(doc.customs), style: "tdNum" },
            { text: fmtMoney(doc.forwarding), style: "tdNum" },
            { text: fmtMoney(doc.otherDependentCosts), style: "tdNum" },
            { text: fmtMoney(doc.fxInvoiceValue), style: "tdNum" },
          ],
        ],
      },
      layout: "lightHorizontalLines",
    };
  }
}

// ──────────────────────────────────────────────────────────────── konstante

const TITLES: Record<StockPrintVariant, (kind: string) => string> = {
  primka: () => "PRIJEMNICA",
  izdatnica: () => "IZDATNICA",
  otpremnica: () => "OTPREMNICA",
  nivelacija: () => "NIVELACIJA CENA",
  prenosnica: () => "PRENOSNICA",
  kalkulacija: () => "KALKULACIJA CENE",
  zapisnik: (kind) =>
    kind === "MANJAK" ? "ZAPISNIK O MANJKU" : "ZAPISNIK O VIŠKU",
};

const FILE_PREFIX: Record<StockPrintVariant, string> = {
  primka: "PRIMKA",
  izdatnica: "IZDATNICA",
  otpremnica: "OTPREMNICA",
  nivelacija: "NIVELACIJA",
  prenosnica: "PRENOSNICA",
  kalkulacija: "KALKULACIJA",
  zapisnik: "ZAPISNIK",
};

/** Natpisi potpisa preuzeti DOSLOVNO iz BigBit obrazaca. */
const SIGNATURES: Record<StockPrintVariant, string[]> = {
  primka: ["Robu primio", "Kontrolisao", "Robu izdao"],
  izdatnica: ["Robu izdao", "Robu primio"],
  otpremnica: ["Robu izdao", "Preuzeo za prevoz", "Robu primio"],
  nivelacija: ["Sastavio", "Odgovorno lice"],
  prenosnica: ["Robu izdao", "Robu primio"],
  kalkulacija: ["Sastavio", "Kontrolisao", "Odgovorno lice"],
  zapisnik: ["Članovi komisije", "Za knjigovodstvo", "Odgovorno lice"],
};

/** Indeksi potpisnih mesta koja nose (M.P.). */
const STAMP_ON: Record<StockPrintVariant, number[]> = {
  primka: [],
  izdatnica: [],
  otpremnica: [0],
  nivelacija: [1],
  prenosnica: [],
  kalkulacija: [2],
  zapisnik: [2],
};

function statusBadge(status: string): DocBadge {
  switch (status) {
    case "DRAFT":
      return { text: "NACRT", tone: "neutral" };
    case "CALCULATED":
      return { text: "KALKULISAN", tone: "info" };
    case "POSTED":
      return { text: "PROKNJIŽEN", tone: "success" };
    case "LOCKED":
      return { text: "ZAKLJUČANO", tone: "success" };
    default:
      return { text: status, tone: "neutral" };
  }
}

function emptyDocNotice(): Content {
  return buildEmptyNotice(
    "Dokument nema stavki",
    "Stavke se dodaju pri kreiranju dokumenta ili prepisom (narudžbenica / predračun). " +
      "Zaglavlje i potpisna mesta su odštampani da obrazac ostane upotrebljiv.",
  );
}
