import { Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type { Column, Content, TDocumentDefinitions } from "pdfmake/interfaces";
import { PrismaService } from "../../../prisma/prisma.service";
import { PdfService } from "../../documents/pdf.service";
import { SERVOTEH_LOGO_DATA_URL } from "../../documents/servoteh-logo";
import {
  LOGO_WIDTH,
  buildPageFooter,
  sanitizeText,
} from "../../documents/doc-layout";

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
 *   - `advance`: AVANSNI RAČUN (documentType='AVR') — osnov avansa, stanje naplate i
 *     napomena da poreska obaveza nastaje NAPLATOM (ZPDV čl. 16 t. 2). Bira se sam
 *     kad je dokument AVR i varijanta nije prosleđena.
 *   - `creditNote` / `debitNote`: KNJIŽNO ODOBRENJE / KNJIŽNO ZADUŽENJE — VREDNOSNI
 *     dokument (BigBit `KnjiznoZadOd`: R.br. | PDV % | OPIS | IZNOS, bez količine i
 *     cene), sa rekapitulacijom poreza i obaveznom klauzulom o potvrdi primaoca.
 *
 * Iznosi su Prisma.Decimal (NIKAD Float) — formatiraju se `formatDecimal` sa
 * decimalnim zarezom i TAČKOM kao razdelnikom hiljada (1.234.567,89); za engleski
 * (`export`) obrnuto (1,234,567.89).
 */
export type InvoicePrintVariant =
  | "withPrices"
  | "withoutPrices"
  | "export"
  | "advance"
  | "creditNote"
  | "debitNote";

/** Vrsta dokumenta avansnog računa — auto-izbor `advance` varijante. */
const ADVANCE_DOCUMENT_TYPE = "AVR";

/** Varijante koje su VREDNOSNI dokument (bez količine i cene) — KO/KZ. */
const VALUE_ONLY_VARIANTS = new Set<InvoicePrintVariant>([
  "creditNote",
  "debitNote",
]);

/** Prefiks naziva PDF fajla po varijanti (FAK/OTP/AVR/KO/KZ). */
const FILE_PREFIX_BY_VARIANT: Readonly<Record<InvoicePrintVariant, string>> = {
  withPrices: "FAK",
  withoutPrices: "OTP",
  export: "FAK",
  advance: "AVR",
  creditNote: "KO",
  debitNote: "KZ",
};

/** Jedan odbijen avans na računu (N:M primena): broj AVR-a + BRUTO iznos te primene. */
interface AdvanceDeduction {
  documentNumber: string | null;
  amount: Prisma.Decimal;
}

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
    printedBy?: string,
  ): Promise<{ buffer: Buffer; fileName: string }> {
    const invoice = await this.prisma.invoice.findUnique({
      where: { id: invoiceId },
      include: { items: { orderBy: [{ lineNo: "asc" }, { id: "asc" }] } },
    });
    if (!invoice) throw new NotFoundException(`Račun ${invoiceId} ne postoji.`);

    // Avansni račun se prepoznaje sam — bez ovoga je AVR izlazio kao obična
    // „FAKTURA", bez osnova avansa, stanja naplate i napomene o poreskoj obavezi.
    const effectiveVariant: InvoicePrintVariant =
      variant ??
      (invoice.documentType === ADVANCE_DOCUMENT_TYPE
        ? "advance"
        : invoice.isExport
          ? "export"
          : "withPrices");

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

    // Batch C §C1a: kad je na računu odbijen avans, štampa nosi red „Umanjenje za
    // primljeni avans (br. …)" po SVAKOM odbijenom avansu i završno „Za uplatu".
    const advanceDeductions = await this.loadAdvanceDeductions(invoice);
    // KO/KZ i AVR moraju da pokažu dokument na koji se odnose (BigBit: „Po dokumentu
    // broj …"). Izvor je carry-over trag (`copiedFromDocId`) ili PROF↔IFR veza.
    const referencedDocument = await this.loadReferencedDocument(invoice);

    const docDefinition = this.buildDocDefinition({
      invoice,
      customer,
      issuer,
      itemNames,
      variant: effectiveVariant,
      advanceDeductions,
      referencedDocument,
      printedBy,
    });

    const buffer = await this.pdf.render(docDefinition);
    const safeNumber = invoice.documentNumber.replace(/[\\/:*?"<>|]+/g, "-");
    const prefix = FILE_PREFIX_BY_VARIANT[effectiveVariant] ?? "FAK";
    return { buffer, fileName: `${prefix}-${safeNumber}.pdf` };
  }

  /** Convenience: otpremnica bez cena (2× štampa, §C). */
  async buildDeliveryNotePdf(
    invoiceId: number,
    printedBy?: string,
  ): Promise<{ buffer: Buffer; fileName: string }> {
    return this.buildInvoicePdf(invoiceId, "withoutPrices", printedBy);
  }

  /** Convenience: ino faktura na engleskom (izvoz, §C). */
  async buildExportInvoicePdf(
    invoiceId: number,
    printedBy?: string,
  ): Promise<{ buffer: Buffer; fileName: string }> {
    return this.buildInvoicePdf(invoiceId, "export", printedBy);
  }

  /** Convenience: avansni račun (AVR) — osnov avansa + stanje naplate. */
  async buildAdvanceInvoicePdf(
    invoiceId: number,
    printedBy?: string,
  ): Promise<{ buffer: Buffer; fileName: string }> {
    return this.buildInvoicePdf(invoiceId, "advance", printedBy);
  }

  /** Convenience: knjižno odobrenje (vrednosni dokument, umanjuje potraživanje). */
  async buildCreditNotePdf(
    invoiceId: number,
    printedBy?: string,
  ): Promise<{ buffer: Buffer; fileName: string }> {
    return this.buildInvoicePdf(invoiceId, "creditNote", printedBy);
  }

  /** Convenience: knjižno zaduženje (vrednosni dokument, uvećava potraživanje). */
  async buildDebitNotePdf(
    invoiceId: number,
    printedBy?: string,
  ): Promise<{ buffer: Buffer; fileName: string }> {
    return this.buildInvoicePdf(invoiceId, "debitNote", printedBy);
  }

  // ------------------------------------------------------------ učitavanje

  /**
   * Firma izdavalac iz `companies` (multi-firma numeracija). Ako firma ne postoji
   * (legacy companyId=0 bez reda) → Servoteh fallback header.
   *
   * IBAN/SWIFT: štampa ih je ČITALA i pre nego što su kolone postojale (`IssuerInfo`
   * ih deklariše, ino faktura ih ispisuje) — polja su uvek bila `undefined`, pa je
   * izvozni račun izlazio BEZ podataka za plaćanje. Kolone `companies.iban` i
   * `companies.swift` su dodate 27.07.2026. i unose se u Podešavanja → Podaci firme.
   * Kad nisu popunjene, ino faktura i dalje ne ispisuje ništa — to je i dalje ispravno:
   * bolje bez reda nego red sa izmišljenim brojem.
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
        iban: true,
        swift: true,
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
        iban: null,
        swift: null,
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
      iban: company.iban,
      swift: company.swift,
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

  /**
   * Odbijeni avansi ovog računa — po JEDAN red po primeni (N:M od migracije
   * 20260726120000). Ranije se štampao ZBIR svih primena uz broj SAMO PRVOG AVR-a,
   * pa je kupac dobijao poreski dokument sa umanjenjem većim od referenciranog
   * avansnog računa (revizija, VISOK). Rezerva: dokumenti vezani pre N:M migracije
   * (veza samo u koloni `advance_invoice_id`) → jedan red iz kolona.
   */
  private async loadAdvanceDeductions(
    invoice: InvoiceWithItems,
  ): Promise<AdvanceDeduction[]> {
    if (!invoice.advanceAppliedAmount.greaterThan(0)) return [];
    const applications = await this.prisma.invoiceAdvanceApplication.findMany({
      where: { invoiceId: invoice.id, status: "ACTIVE" },
      orderBy: { id: "asc" },
      select: {
        appliedAmount: true,
        advance: { select: { documentNumber: true } },
      },
    });
    if (applications.length > 0) {
      return applications.map((a) => ({
        documentNumber: a.advance?.documentNumber ?? null,
        amount: a.appliedAmount,
      }));
    }
    const legacy =
      invoice.advanceInvoiceId != null
        ? await this.prisma.invoice.findUnique({
            where: { id: invoice.advanceInvoiceId },
            select: { documentNumber: true },
          })
        : null;
    return [
      {
        documentNumber: legacy?.documentNumber ?? null,
        amount: invoice.advanceAppliedAmount,
      },
    ];
  }

  /**
   * Dokument na koji se štampa poziva („Po dokumentu broj …"): prvo carry-over trag
   * (`copiedFromDocId` — predračun iz koga je nastao AVR/račun), pa PROF↔IFR par
   * (`linkedInvoiceDocId`). Meki ref-ovi, pa se čita bez JOIN-a i tiho preskače kad
   * izvorni dokument više ne postoji.
   */
  private async loadReferencedDocument(
    invoice: InvoiceWithItems,
  ): Promise<ReferencedDocument | null> {
    const refId = invoice.copiedFromDocId ?? invoice.linkedInvoiceDocId ?? null;
    if (refId == null || refId <= 0) return null;
    const doc = await this.prisma.invoice.findUnique({
      where: { id: refId },
      select: { documentNumber: true, documentDate: true, documentType: true },
    });
    return doc ?? null;
  }

  // --------------------------------------------------------- dokument (pdfmake)

  private buildDocDefinition(args: {
    invoice: InvoiceWithItems;
    customer: CustomerInfo | null;
    issuer: IssuerInfo;
    itemNames: Map<number, string>;
    variant: InvoicePrintVariant;
    /** Odbijeni avansi (broj AVR-a + iznos), jedan red po primeni. */
    advanceDeductions?: AdvanceDeduction[];
    /** Izvorni dokument (predračun/ugovor-veza) — „Po dokumentu broj …". */
    referencedDocument?: ReferencedDocument | null;
    /** Ko je pokrenuo štampu (trag u nozi) — prosleđuje kontroler iz AuthUser-a. */
    printedBy?: string;
  }): TDocumentDefinitions {
    const { invoice, customer, issuer, itemNames, variant } = args;
    const t = getLabels(variant);
    const showPrices = variant !== "withoutPrices";
    const valueOnly = VALUE_ONLY_VARIANTS.has(variant);
    const english = variant === "export";
    const currency = invoice.currency || "RSD";

    const header = this.buildHeader(
      invoice,
      t,
      english,
      currency,
      variant,
      args.referencedDocument ?? null,
    );
    const parties = this.buildParties(customer, issuer, t);
    const table = this.buildItemsTable(
      invoice,
      itemNames,
      t,
      showPrices,
      valueOnly,
      english,
    );
    // Rekapitulacija poreza po stopama (BigBit obavezan blok na računu i KO/KZ).
    // Na otpremnici (bez cena) i ino fakturi (jedinstvena stopa Z/čl.24) nema smisla.
    const vatRecap =
      showPrices && !english && invoice.items.length > 0
        ? this.buildVatRecap(invoice, t, currency)
        : { text: "" };
    const totals = showPrices
      ? this.buildTotals(
          invoice,
          t,
          currency,
          english,
          args.advanceDeductions ?? [],
        )
      : { text: "" };
    const footer = this.buildDocFooter(
      invoice,
      issuer,
      customer,
      t,
      showPrices,
      english,
      variant,
    );

    return {
      pageSize: "A4",
      pageMargins: [32, 32, 32, 40],
      content: [header, parties, table, vatRecap, totals, footer],
      styles: {
        title: { fontSize: 18, bold: true },
        subtitle: { fontSize: 11, color: "#555", margin: [0, 2, 0, 0] },
        meta: { fontSize: 8, color: "#555", margin: [0, 1, 0, 0] },
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
        legal: { fontSize: 8, color: "#333", margin: [0, 10, 0, 0] },
        signLbl: { fontSize: 8, color: "#555", alignment: "center" },
        emptyNote: { fontSize: 10, bold: true, alignment: "center", color: "#a00" },
      },
      defaultStyle: { font: "Roboto", fontSize: 9 },
      footer: buildPageFooter(
        `${t.docWord} ${invoice.documentNumber}`,
        args.printedBy ?? null,
        undefined,
        english ? { printedBy: t.printedByLbl, page: t.page } : undefined,
      ),
    };
  }

  private buildHeader(
    invoice: InvoiceWithItems,
    t: Labels,
    english: boolean,
    currency: string,
    variant: InvoicePrintVariant,
    referencedDocument: ReferencedDocument | null,
  ): Content {
    const subtitleParts = [
      `${t.docWord} ${invoice.documentNumber}`,
      `${t.dateWord}: ${fmtDate(invoice.documentDate, english)}`,
    ];
    if (invoice.dueDate)
      subtitleParts.push(`${t.dueWord}: ${fmtDate(invoice.dueDate, english)}`);
    if (english && currency !== "RSD") subtitleParts.push(`${t.currencyWord}: ${currency}`);

    // Meta-red ispod naslova: veza na izvorni dokument i (na AVR-u) osnov avansa —
    // BigBit „Po dokumentu broj …" / „Po ugovoru …".
    const metaLines: string[] = [];
    if (referencedDocument) {
      metaLines.push(
        `${t.refDocLbl}: ${referencedDocument.documentNumber}` +
          ` (${fmtDate(referencedDocument.documentDate, english)})`,
      );
    }
    if (variant === "advance" && invoice.advanceBasis?.trim()) {
      metaLines.push(`${t.advanceBasisLbl}: ${invoice.advanceBasis.trim()}`);
    }

    return {
      columns: [
        { image: SERVOTEH_LOGO_DATA_URL, width: 128 },
        {
          width: "*",
          margin: [12, 4, 0, 0],
          stack: [
            { text: t.title, style: "title" },
            { text: subtitleParts.join("   ·   "), style: "subtitle" },
            ...metaLines.map((text) => ({ text, style: "meta" })),
          ],
        },
        // Statusna značka (nema je u BigBitu): storniran dokument se dosad štampao
        // istovetno važećem — pravni rizik. Sada nosi vidljivu oznaku u zaglavlju.
        buildStatusBadge(invoice, t),
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

  /**
   * Tabela stavki. Tri oblika iz jednog šablona:
   *   - `valueOnly` (KO/KZ)      → R.br. | PDV % | Opis | Iznos   (BigBit KnjiznoZadOd)
   *   - `showPrices` (račun/AVR) → R.br. | Opis | Količina | Cena | Rabat | Osnovica | PDV | Ukupno
   *   - inače (otpremnica)       → R.br. | Opis | Količina
   * `headerRows: 1` → zaglavlje kolona se PONAVLJA na svakoj strani (duge stavke).
   */
  private buildItemsTable(
    invoice: InvoiceWithItems,
    itemNames: Map<number, string>,
    t: Labels,
    showPrices: boolean,
    valueOnly: boolean,
    english: boolean,
  ): Content {
    // Prazan dokument se NE štampa nemo: jasna crvena napomena umesto prazne tabele.
    if (!invoice.items.length) {
      return {
        margin: [0, 12, 0, 12],
        stack: [
          { text: t.noItems, style: "emptyNote" },
          { text: t.noItemsHint, style: "note", alignment: "center" },
        ],
      };
    }

    const head: string[] = valueOnly
      ? [t.colNo, t.colVatRate, t.colDesc, t.colAmount]
      : showPrices
        ? [
            t.colNo,
            t.colDesc,
            t.colQty,
            t.colPrice,
            t.colDiscount,
            t.colBase,
            t.colVat,
            t.colTotal,
          ]
        : [t.colNo, t.colDesc, t.colQty];
    const widths: (string | number)[] = valueOnly
      ? [22, 40, "*", "auto"]
      : showPrices
        ? ["auto", "*", "auto", "auto", "auto", "auto", "auto", "auto"]
        : ["auto", "*", "auto"];
    // Levo poravnate su samo R.br. i Opis; sve numeričko ide desno (tabular).
    const leftAligned = valueOnly ? new Set([0, 2]) : new Set([0, 1]);
    const headerCells: Content[] = head.map((text, i) => ({
      text,
      style: "th",
      alignment: leftAligned.has(i) ? "left" : "right",
    }));

    const bodyRows: Content[][] = invoice.items.map((item, idx) => {
      const desc =
        (item.itemId != null && item.itemId > 0
          ? itemNames.get(item.itemId)
          : undefined) ??
        item.description ??
        "";
      if (valueOnly) {
        // KO/KZ je VREDNOSNI dokument — bez količine i cene (BigBit KnjiznoZadOd).
        // „Iznos" je OSNOVICA; PDV se prikazuje u rekapitulaciji ispod tabele.
        return [
          { text: String(idx + 1), style: "td" },
          { text: fmtPercent(effectiveVatPercent(item), english), style: "tdNum" },
          { text: desc, style: "td" },
          { text: formatDecimal(item.vatBase, 2, english), style: "tdNum" },
        ];
      }
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

  /**
   * REKAPITULACIJA POREZA po stopama (BigBit obavezan blok ispod stavki računa,
   * KO/KZ i avansnog računa). Stopa se izvodi iz SAMIH IZNOSA (`vatAmount/vatBase`),
   * ne iz šifarnika — tako odštampana stopa uvek odgovara stvarno obračunatom porezu.
   * Kontrolni red: Σ osnovica + Σ PDV = bruto dokumenta; razlika se ispisuje crveno.
   */
  private buildVatRecap(
    invoice: InvoiceWithItems,
    t: Labels,
    currency: string,
  ): Content {
    const byRate = new Map<
      string,
      { percent: Prisma.Decimal; base: Prisma.Decimal; vat: Prisma.Decimal }
    >();
    for (const item of invoice.items) {
      const percent = effectiveVatPercent(item);
      const key = percent.toFixed(2);
      const acc = byRate.get(key) ?? {
        percent,
        base: new Prisma.Decimal(0),
        vat: new Prisma.Decimal(0),
      };
      acc.base = acc.base.add(item.vatBase);
      acc.vat = acc.vat.add(item.vatAmount);
      byRate.set(key, acc);
    }

    const rates = [...byRate.values()].sort((a, b) =>
      a.percent.comparedTo(b.percent),
    );
    const body: Content[][] = [
      [
        { text: t.colVatRate, style: "th", alignment: "right" },
        { text: t.recapBaseLbl, style: "th", alignment: "right" },
        { text: t.recapVatLbl, style: "th", alignment: "right" },
        { text: t.recapTotalLbl, style: "th", alignment: "right" },
      ],
    ];
    let sumBase = new Prisma.Decimal(0);
    let sumVat = new Prisma.Decimal(0);
    for (const r of rates) {
      sumBase = sumBase.add(r.base);
      sumVat = sumVat.add(r.vat);
      body.push([
        { text: fmtPercent(r.percent, false), style: "tdNum" },
        { text: formatDecimal(r.base, 2, false), style: "tdNum" },
        { text: formatDecimal(r.vat, 2, false), style: "tdNum" },
        { text: formatDecimal(r.base.add(r.vat), 2, false), style: "tdNum" },
      ]);
    }
    body.push([
      { text: t.recapSumLbl, style: "th", alignment: "right" },
      { text: formatDecimal(sumBase, 2, false), style: "th", alignment: "right" },
      { text: formatDecimal(sumVat, 2, false), style: "th", alignment: "right" },
      {
        text: formatDecimal(sumBase.add(sumVat), 2, false),
        style: "th",
        alignment: "right",
      },
    ]);

    // Kontrola tihe greške: rekapitulacija MORA da se poklopi sa bruto iznosom.
    const diff = sumBase.add(sumVat).sub(invoice.grossTotal);
    const mismatch: Content[] = diff.abs().greaterThan(new Prisma.Decimal("0.01"))
      ? [
          {
            text:
              `${t.recapMismatchLbl}: ${formatDecimal(diff, 2, false)} ${currency}`,
            fontSize: 8,
            bold: true,
            color: "#a00",
            margin: [0, 3, 0, 0],
          },
        ]
      : [];

    return {
      margin: [0, 12, 0, 0],
      unbreakable: true,
      stack: [
        { text: t.vatRecapTitle, style: "sectionLbl", margin: [0, 0, 0, 3] },
        {
          columns: [
            { width: "*", text: "" },
            {
              width: "auto",
              table: { headerRows: 1, widths: [50, 80, 80, 90], body },
              layout: {
                hLineWidth: (i: number, node: { table: { body: unknown[] } }) =>
                  i <= 1 || i === node.table.body.length ? 0.8 : 0.4,
                vLineWidth: () => 0,
                hLineColor: () => "#cccccc",
                paddingTop: () => 3,
                paddingBottom: () => 3,
                paddingLeft: () => 4,
                paddingRight: () => 4,
              },
            },
          ],
        },
        ...mismatch,
      ],
    };
  }

  private buildTotals(
    invoice: InvoiceWithItems,
    t: Labels,
    currency: string,
    english: boolean,
    advanceDeductions: AdvanceDeduction[],
  ): Content {
    const row = (label: string, value: string, grand = false): Content[] => [
      { text: label, style: grand ? "grand" : "totLbl" },
      { text: value, style: grand ? "grand" : "totVal" },
    ];

    const body: Content[][] = [
      row(t.netTotalLbl, fmtMoney(invoice.netTotal, currency, english)),
      row(t.vatTotalLbl, fmtMoney(invoice.vatTotal, currency, english)),
    ];

    // Batch C §C1a: odbijen avans NE menja `grossTotal` (osnovica/PDV/prihod
    // ostaju isti) — umanjuje se samo IZNOS ZA UPLATU. Zato ostaje red „Za
    // plaćanje" (ukupno računa), pa umanjenje, pa „Za uplatu" kao završni iznos.
    // Zbir se izvodi iz PRIKAZANIH redova (N:M primene), da „Za uplatu" uvek bude
    // grossTotal minus tačno ono što je na štampi navedeno.
    const advance = advanceDeductions.reduce(
      (acc, d) => acc.add(d.amount),
      new Prisma.Decimal(0),
    );
    const hasAdvance = advance.greaterThan(0);
    if (!hasAdvance) {
      body.push(
        row(
          t.grossTotalLbl,
          fmtMoney(invoice.grossTotal, currency, english),
          true,
        ),
      );
    } else {
      body.push(
        row(t.grossTotalLbl, fmtMoney(invoice.grossTotal, currency, english)),
      );
      // Jedan red po odbijenom avansu — broj AVR-a i iznos MORAJU biti iz iste primene.
      for (const deduction of advanceDeductions) {
        body.push(
          row(
            deduction.documentNumber
              ? `${t.advanceDeductionLbl} (${t.advanceNoWord} ${deduction.documentNumber}):`
              : `${t.advanceDeductionLbl}:`,
            `− ${fmtMoney(deduction.amount, currency, english)}`,
          ),
        );
      }
      const raw = invoice.grossTotal.sub(advance);
      const payable = raw.greaterThan(0) ? raw : new Prisma.Decimal(0);
      body.push(
        row(
          t.payableAfterAdvanceLbl,
          fmtMoney(payable, currency, english),
          true,
        ),
      );
    }

    return {
      margin: [0, 12, 0, 0],
      columns: [
        { width: "*", text: "" },
        {
          width: "auto",
          table: { widths: ["auto", "auto"], body },
          layout: "noBorders",
        },
      ],
    };
  }

  private buildDocFooter(
    invoice: InvoiceWithItems,
    issuer: IssuerInfo,
    customer: CustomerInfo | null,
    t: Labels,
    showPrices: boolean,
    english: boolean,
    variant: InvoicePrintVariant,
  ): Content {
    const lines: Content[] = [];
    if (showPrices && issuer.bankAccount)
      lines.push({
        text: `${t.bankAccountLbl}: ${issuer.bankAccount}`,
        style: "note",
      });
    // Ino faktura: SWIFT/IBAN instrukcije (INO plaćanje, §izvoz).
    // IBAN se ČUVA kanonski (bez razmaka), a ŠTAMPA u grupama po 4 — tako ga
    // propisuje ISO 13616 za prikaz na papiru i tako se prekucava bez greške.
    if (english && issuer.iban)
      lines.push({
        text: `IBAN: ${groupIban(issuer.iban)}`,
        style: "note",
      });
    if (english && issuer.swift)
      lines.push({ text: `SWIFT: ${issuer.swift}`, style: "note" });

    // AVANSNI RAČUN: stanje naplate + poreska napomena. Bez ovoga se avansni račun
    // ne razlikuje od konačnog, a poreska obaveza po avansu nastaje NAPLATOM.
    if (variant === "advance") {
      lines.push({
        text: invoice.advancePaidAt
          ? `${t.advancePaidLbl}: ${formatDecimal(invoice.advancePaidAmount, 2, english)} ` +
            `${invoice.currency || "RSD"} (${fmtDate(invoice.advancePaidAt, english)})`
          : t.advanceUnpaidLbl,
        style: "note",
        bold: !invoice.advancePaidAt,
      });
      lines.push({ text: t.advanceLegalNote, style: "legal" });
    }

    // KNJIŽNO ODOBRENJE: obavezna klauzula o potvrdi primaoca (ispravka odbitka
    // prethodnog poreza) — BigBit KnjiznoZadOd štampa je na svakom primerku.
    if (variant === "creditNote") {
      lines.push({ text: t.creditNoteLegalNote, style: "legal" });
    }
    if (variant === "debitNote") {
      lines.push({ text: t.debitNoteLegalNote, style: "legal" });
    }

    if (invoice.note?.trim())
      lines.push({ text: `${t.noteLbl}: ${invoice.note}`, style: "note" });
    if (english && invoice.isExport)
      lines.push({ text: t.exportVatNote, style: "note" });

    // Potpisna mesta — BigBit natpisi po vrsti dokumenta. Blok se NE prelama.
    const signatureLabels =
      variant === "withoutPrices"
        ? [t.signGoodsReceivedLbl, t.signCarrierLbl, t.signGoodsIssuedLbl]
        : english
          ? [t.signatureLbl]
          : [
              customer?.name
                ? `${t.signAgreedLbl} ${customer.name}`
                : t.signAgreedLbl,
              t.signCheckedLbl,
              `${t.signForLbl} ${issuer.companyName}`,
            ];
    lines.push(buildSignatureRow(signatureLabels, t, !english));
    return { stack: lines };
  }
}

// ------------------------------------------------------------- deljeni blokovi

/**
 * Statusna značka u desnom uglu zaglavlja (NACRT / STORNIRANO / KNJIŽENO).
 * BigBit ovo NEMA — storniran dokument se tamo štampa istovetno važećem.
 */
function buildStatusBadge(invoice: InvoiceWithItems, t: Labels): Column {
  const meta =
    invoice.status === "CANCELLED"
      ? { text: t.statusCancelled, color: "#a00" }
      : invoice.status === "DRAFT" || invoice.level === 250
        ? { text: t.statusDraft, color: "#8a6d00" }
        : { text: t.statusPosted, color: "#276749" };
  return {
    width: 92,
    margin: [0, 6, 0, 0],
    table: {
      widths: [84],
      body: [
        [
          {
            text: meta.text,
            fontSize: 9,
            bold: true,
            color: meta.color,
            alignment: "center",
            margin: [0, 3, 0, 3],
          },
        ],
      ],
    },
    layout: {
      hLineWidth: () => 1,
      vLineWidth: () => 1,
      hLineColor: () => meta.color,
      vLineColor: () => meta.color,
    },
  };
}

/** Red potpisnih mesta (1–3): linija + natpis + „(M.P.)". Ne prelama se preko strane. */
function buildSignatureRow(
  labels: string[],
  t: Labels,
  withStamp: boolean,
): Content {
  return {
    margin: [0, 28, 0, 0],
    unbreakable: true,
    columns: labels.map((label) => ({
      width: "*",
      stack: [
        {
          canvas: [
            { type: "line", x1: 0, y1: 0, x2: 150, y2: 0, lineWidth: 0.5 },
          ],
        },
        { text: label, style: "signLbl", margin: [0, 2, 0, 0] },
        ...(withStamp
          ? [
              {
                text: t.stampLbl,
                style: "signLbl",
                margin: [0, 1, 0, 0] as [number, number, number, number],
              },
            ]
          : []),
      ],
    })),
    columnGap: 12,
  };
}

// ---------------------------------------------------------------- pomoćni tipovi

type InvoiceWithItems = Prisma.InvoiceGetPayload<{ include: { items: true } }>;

/** Izvorni dokument na koji se štampa poziva („Po dokumentu broj …"). */
interface ReferencedDocument {
  documentNumber: string;
  documentDate: Date;
  documentType: string;
}

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
  /** KO/KZ: kolona „PDV %" (stopa izvedena iz iznosa stavke). */
  colVatRate: string;
  /** KO/KZ: kolona „Iznos" (osnovica vrednosnog dokumenta). */
  colAmount: string;
  // — rekapitulacija poreza po stopama —
  vatRecapTitle: string;
  recapBaseLbl: string;
  recapVatLbl: string;
  recapTotalLbl: string;
  recapSumLbl: string;
  recapMismatchLbl: string;
  // — avansni račun —
  advanceBasisLbl: string;
  advancePaidLbl: string;
  advanceUnpaidLbl: string;
  advanceLegalNote: string;
  // — knjižno odobrenje / zaduženje —
  creditNoteLegalNote: string;
  debitNoteLegalNote: string;
  /** „Po dokumentu broj" — veza na izvorni dokument. */
  refDocLbl: string;
  // — statusna značka —
  statusDraft: string;
  statusPosted: string;
  statusCancelled: string;
  // — potpisna mesta —
  signAgreedLbl: string;
  signCheckedLbl: string;
  signForLbl: string;
  signGoodsReceivedLbl: string;
  signCarrierLbl: string;
  signGoodsIssuedLbl: string;
  stampLbl: string;
  /** „Štampao" — trag štampe u nozi. */
  printedByLbl: string;
  /** Objašnjenje uz praznu tabelu stavki. */
  noItemsHint: string;
  netTotalLbl: string;
  vatTotalLbl: string;
  grossTotalLbl: string;
  /** „Umanjenje za primljeni avans" (Batch C §C1a). */
  advanceDeductionLbl: string;
  /** „br." — prefiks broja avansnog računa u zagradi. */
  advanceNoWord: string;
  /** „Za uplatu" — konačni iznos posle odbijenog avansa. */
  payableAfterAdvanceLbl: string;
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
  colVatRate: "PDV %",
  colAmount: "Iznos",
  vatRecapTitle: "REKAPITULACIJA POREZA",
  recapBaseLbl: "Osnovica",
  recapVatLbl: "PDV",
  recapTotalLbl: "Sa PDV-om",
  recapSumLbl: "Ukupno",
  recapMismatchLbl:
    "NEUSKLAĐENO — zbir rekapitulacije se razlikuje od iznosa dokumenta za",
  advanceBasisLbl: "Osnov avansa",
  advancePaidLbl: "Avans naplaćen",
  advanceUnpaidLbl:
    "Avans NIJE naplaćen — poreska obaveza po ovom avansnom računu još nije nastala.",
  advanceLegalNote:
    "Poreska obaveza po avansu nastaje danom naplate avansa (Zakon o PDV, član 16. tačka 2). " +
    "Iznos ovog avansa umanjuje iznos za uplatu na konačnom računu, ali ne umanjuje osnovicu prihoda.",
  creditNoteLegalNote:
    "Ovo knjižno odobrenje važi samo u slučaju da nam u roku od 10 (deset) dana od dana prijema " +
    "pismeno potvrdite da ste izvršili ispravku odbitka prethodnog poreza za iznos PDV-a iskazan " +
    "u ovom dokumentu.",
  debitNoteLegalNote:
    "Ovim knjižnim zaduženjem uvećava se osnovica i iznos PDV-a po navedenom računu. " +
    "Iznos je dužan da uplatite u roku iskazanom na dokumentu.",
  refDocLbl: "Po dokumentu broj",
  statusDraft: "NACRT",
  statusPosted: "KNJIŽENO",
  statusCancelled: "STORNIRANO",
  signAgreedLbl: "Saglasan",
  signCheckedLbl: "Kontrolisao",
  signForLbl: "Za",
  signGoodsReceivedLbl: "Robu primio",
  signCarrierLbl: "Preuzeo za prevoz",
  signGoodsIssuedLbl: "Robu izdao",
  stampLbl: "(M.P.)",
  printedByLbl: "Štampao",
  noItemsHint:
    "Dokument je izdat bez stavki. Proveri unos pre slanja kupcu ili knjiženja.",
  netTotalLbl: "Osnovica:",
  vatTotalLbl: "PDV:",
  grossTotalLbl: "Za plaćanje:",
  advanceDeductionLbl: "Umanjenje za primljeni avans",
  advanceNoWord: "br.",
  payableAfterAdvanceLbl: "Za uplatu:",
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
  noItems: "Otpremnica nema stavki.",
};

/** Avansni račun (AVR) — naslov i završni iznos su avansni, ostalo kao na računu. */
const SR_ADVANCE_LABELS: Labels = {
  ...SR_LABELS,
  title: "AVANSNI RAČUN",
  docWord: "Avansni račun br.",
  grossTotalLbl: "Iznos avansa:",
  noItems: "Avansni račun nema stavki.",
};

/** Knjižno odobrenje — vrednosni dokument koji UMANJUJE potraživanje od kupca. */
const SR_CREDIT_NOTE_LABELS: Labels = {
  ...SR_LABELS,
  title: "KNJIŽNO ODOBRENJE",
  docWord: "Knjižno odobrenje br.",
  grossTotalLbl: "Ukupno odobrenje:",
  noItems: "Knjižno odobrenje nema stavki.",
};

/** Knjižno zaduženje — vrednosni dokument koji UVEĆAVA potraživanje od kupca. */
const SR_DEBIT_NOTE_LABELS: Labels = {
  ...SR_LABELS,
  title: "KNJIŽNO ZADUŽENJE",
  docWord: "Knjižno zaduženje br.",
  grossTotalLbl: "Ukupno zaduženje:",
  noItems: "Knjižno zaduženje nema stavki.",
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
  colVatRate: "VAT %",
  colAmount: "Amount",
  vatRecapTitle: "VAT RECAPITULATION",
  recapBaseLbl: "Net",
  recapVatLbl: "VAT",
  recapTotalLbl: "Gross",
  recapSumLbl: "Total",
  recapMismatchLbl: "MISMATCH — recapitulation differs from document total by",
  advanceBasisLbl: "Prepayment basis",
  advancePaidLbl: "Prepayment received",
  advanceUnpaidLbl: "Prepayment not received yet.",
  advanceLegalNote: "",
  creditNoteLegalNote: "",
  debitNoteLegalNote: "",
  refDocLbl: "Reference document",
  statusDraft: "DRAFT",
  statusPosted: "POSTED",
  statusCancelled: "CANCELLED",
  signAgreedLbl: "Agreed",
  signCheckedLbl: "Checked by",
  signForLbl: "For",
  signGoodsReceivedLbl: "Goods received by",
  signCarrierLbl: "Carrier",
  signGoodsIssuedLbl: "Goods issued by",
  stampLbl: "",
  printedByLbl: "Printed by",
  noItemsHint: "This document was issued without items.",
  netTotalLbl: "Net total:",
  vatTotalLbl: "VAT:",
  grossTotalLbl: "Total due:",
  advanceDeductionLbl: "Less prepayment received",
  advanceNoWord: "no.",
  payableAfterAdvanceLbl: "Amount payable:",
  bankAccountLbl: "Bank account",
  noteLbl: "Note",
  signatureLbl: "Signature & stamp",
  page: "page",
  noItems: "No items on this invoice.",
  exportVatNote:
    "VAT exempt — Article 24, Law on VAT (tax category Z / export of goods and services).",
};

function getLabels(variant: InvoicePrintVariant): Labels {
  switch (variant) {
    case "export":
      return EN_LABELS;
    case "withoutPrices":
      return SR_DELIVERY_LABELS;
    case "advance":
      return SR_ADVANCE_LABELS;
    case "creditNote":
      return SR_CREDIT_NOTE_LABELS;
    case "debitNote":
      return SR_DEBIT_NOTE_LABELS;
    default:
      return SR_LABELS;
  }
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

/** Datum i vreme dd.MM.yyyy. HH:mm (trag štampe u nozi). */
function fmtDateTime(d: Date, english: boolean): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${fmtDate(d, english)} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * Prisma.Decimal → string sa fiksnim brojem decimala i RAZDELNIKOM HILJADA.
 * Srpski: `1.234.567,89` (tačka hiljade, zarez decimale); engleski (izvoz):
 * `1,234,567.89`. NIKAD Float aritmetika — `toFixed` nad Decimal-om, pa se
 * grupisanje radi nad stringom.
 */
function formatDecimal(
  value: Prisma.Decimal,
  decimals: number,
  english: boolean,
): string {
  const raw = value.toFixed(decimals);
  const negative = raw.startsWith("-");
  const [intPart, fracPart] = (negative ? raw.slice(1) : raw).split(".");
  const groupSep = english ? "," : ".";
  const decSep = english ? "." : ",";
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, groupSep);
  const body = fracPart ? `${grouped}${decSep}${fracPart}` : grouped;
  return negative ? `-${body}` : body;
}

/** Rabat: prazno za 0, inače „NN%" (zarez/tačka po jeziku). */
function formatDiscount(value: Prisma.Decimal, english: boolean): string {
  if (value.isZero()) return "";
  const s = value.toFixed(2).replace(/\.?0+$/, "");
  return `${english ? s : s.replace(".", ",")}%`;
}

/** Procenat bez suvišnih nula: 20,00 → „20%", 8,50 → „8,5%". */
function fmtPercent(value: Prisma.Decimal, english: boolean): string {
  const s = value.toFixed(2).replace(/\.?0+$/, "");
  return `${english ? s : s.replace(".", ",")}%`;
}

/**
 * Efektivna PDV stopa stavke, IZVEDENA IZ IZNOSA (`vatAmount / vatBase × 100`),
 * zaokružena na 2 decimale. Namerno se ne čita iz šifarnika `tax_rates`: odštampana
 * stopa mora da odgovara porezu koji je stvarno obračunat na toj stavci, i kad je
 * šifarnik u međuvremenu promenjen. Osnovica 0 → 0%.
 */
function effectiveVatPercent(item: {
  vatBase: Prisma.Decimal;
  vatAmount: Prisma.Decimal;
}): Prisma.Decimal {
  if (item.vatBase.isZero()) return new Prisma.Decimal(0);
  return item.vatAmount
    .div(item.vatBase)
    .mul(100)
    .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
}

/** Iznos + oznaka valute (npr. „1.234,56 RSD" / „1234.56 EUR"). */
function fmtMoney(
  value: Prisma.Decimal,
  currency: string,
  english: boolean,
): string {
  return `${formatDecimal(value, 2, english)} ${currency}`;
}

/**
 * IBAN za PAPIR: grupe od po 4 znaka (ISO 13616 prikazni oblik).
 * U bazi ostaje kanonski oblik bez razmaka — poređenje sa bankarskim izvorom mora
 * da radi nad kanonskim, a čovek prekucava iz grupisanog.
 */
function groupIban(iban: string): string {
  return iban.replace(/\s+/g, "").replace(/(.{4})/g, "$1 ").trim();
}
