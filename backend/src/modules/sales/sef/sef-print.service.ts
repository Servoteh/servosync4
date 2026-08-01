import { Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type { Content, TDocumentDefinitions } from "pdfmake/interfaces";
import { XmlDocument, type XmlElement } from "xmldoc";
import { PrismaService } from "../../../prisma/prisma.service";
import { PdfService } from "../../documents/pdf.service";
/**
 * NAPOMENA O UVOZU: `doc-format` je zajednički obrazac štampe (pdfmake gradnja,
 * bez DI i bez baze). Trenutno živi u `modules/nabavka/print/` jer je tamo prvi put
 * izdvojen; predviđeno mesto mu je `DocumentsModule/doc-layout` — seoba je posebna
 * stavka (v. izveštaj paketa), da svi moduli koriste JEDNO zaglavlje i nogu.
 */
import {
  amountInWords,
  buildDocHeader,
  buildEmptyNotice,
  buildPageFooter,
  buildParties,
  buildSignatureRow,
  DOC_STYLES,
  draftWatermark,
  fmtDate,
  fmtMoney,
  fmtQty,
  PAGE_MARGINS,
  safeFileName,
  TABLE_LAYOUT,
  toDec,
  type IssuerInfo,
  type PartyInfo,
  type StatusBadgeSpec,
} from "../../nabavka/print/doc-format";

/**
 * ŠTAMPA SEF e-FAKTURA — ljudski čitljiv prikaz UBL 2.1 dokumenta.
 * ================================================================
 * Dva dokumenta iz jednog šablona:
 *   1. IZLAZNA e-faktura (`sef_outbox`) — ono što je STVARNO poslato na SEF
 *      (`ublXml`), ne ono što danas piše u bazi. To je poenta: UBL je pravni
 *      original, a knjigovođa/kupac ga ne mogu čitati kao XML.
 *   2. ULAZNA e-faktura (`sef_incoming_invoices`) — `rawXml` sa SEF-a, sa
 *      istaknutim ZAKONSKIM ROKOM od 15 dana za prihvatanje/odbijanje.
 *
 * Parsiranje: `xmldoc` (već zavisnost repoa — koristi je PDM parser). Nema nove
 * npm zavisnosti; render je isključivo `PdfService` (pdfmake).
 *
 * OTPORNOST (obavezno — SEF ume da vrati krnj dokument):
 *   • XML koji se ne parsira ili ga uopšte nema → dokument se ipak štampa, sa
 *     jasnom napomenom i podacima iz baze; NIKAD izuzetak zbog sadržaja XML-a;
 *   • faktura bez stavki → poruka „NEMA STAVKI", ne prazna tabela sa 0,00.
 */

/** Jedna stavka izvučena iz `cac:InvoiceLine`. */
interface UblLine {
  lineNo: string;
  name: string;
  unit: string;
  quantity: Prisma.Decimal;
  unitPrice: Prisma.Decimal;
  allowance: Prisma.Decimal;
  lineAmount: Prisma.Decimal;
  vatPercent: string;
  vatCategory: string;
}

/** Jedna grupa poreske rekapitulacije (`cac:TaxSubtotal`). */
interface UblTaxGroup {
  category: string;
  percent: string;
  taxableAmount: Prisma.Decimal;
  taxAmount: Prisma.Decimal;
  exemptionReason: string | null;
}

/** Sve što nam iz UBL-a treba za čitljiv prikaz. */
interface ParsedUbl {
  ok: boolean;
  parseError: string | null;
  invoiceNumber: string;
  issueDate: string;
  dueDate: string;
  deliveryDate: string;
  currency: string;
  invoiceTypeCode: string;
  note: string | null;
  customizationId: string;
  profileId: string;
  supplier: PartyInfo | null;
  customer: PartyInfo | null;
  paymentMeansAccount: string | null;
  paymentReference: string | null;
  lines: UblLine[];
  taxGroups: UblTaxGroup[];
  lineExtensionAmount: Prisma.Decimal;
  taxExclusiveAmount: Prisma.Decimal;
  taxInclusiveAmount: Prisma.Decimal;
  prepaidAmount: Prisma.Decimal;
  payableAmount: Prisma.Decimal;
  taxTotal: Prisma.Decimal;
  billingReference: string | null;
}

@Injectable()
export class SefPrintService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pdf: PdfService,
  ) {}

  // ───────────────────────────────────────────────── izlazna e-faktura (outbox)

  /** Čitljiv PDF izlazne e-fakture iz `sef_outbox.ubl_xml`. */
  async buildOutboundPdf(
    outboxId: number,
    opts: { printedBy?: string | null } = {},
  ): Promise<{ buffer: Buffer; fileName: string }> {
    const row = await this.prisma.sefOutbox.findUnique({
      where: { id: outboxId },
      select: {
        id: true,
        invoiceId: true,
        requestId: true,
        ublXml: true,
        status: true,
        sefInvoiceId: true,
        errorMessage: true,
        sentAt: true,
        createdAt: true,
      },
    });
    if (!row) throw new NotFoundException(`SEF stavka ${outboxId} ne postoji.`);

    const issuer = await this.loadIssuer();
    const parsed = parseUbl(row.ublXml);

    const content: Content[] = [
      buildDocHeader({
        title: "IZLAZNA e-FAKTURA (SEF)",
        subtitle:
          "Čitljiv prikaz elektronske fakture (UBL 2.1) poslate na Sistem elektronskih faktura",
        issuer,
        status: outboundStatusBadge(row.status),
        meta: [
          { label: "Broj fakture", value: parsed.invoiceNumber || "—" },
          { label: "Datum izdavanja", value: fmtDate(parsed.issueDate) },
          { label: "Datum prometa", value: fmtDate(parsed.deliveryDate) },
          { label: "Rok plaćanja", value: fmtDate(parsed.dueDate) },
          { label: "Valuta", value: parsed.currency || "RSD" },
        ],
      }),
      buildParties(
        {
          title: "PRODAVAC (izdavalac)",
          party: parsed.supplier ?? issuerAsParty(issuer),
        },
        { title: "KUPAC (primalac)", party: parsed.customer },
      ),
    ];

    if (!row.ublXml)
      content.push(
        buildEmptyNotice(
          "UBL dokument nije generisan",
          "Za ovu stavku outbox-a nema sačuvanog XML-a — prikazani su samo podaci evidencije SEF slanja.",
        ),
      );
    else if (!parsed.ok)
      content.push(
        buildEmptyNotice(
          "UBL dokument se ne može pročitati",
          `XML je sačuvan, ali ga prikaz ne razume (${parsed.parseError ?? "nepoznata greška"}). Sirovi XML je i dalje u evidenciji.`,
        ),
      );

    content.push(this.buildLinesTable(parsed));
    if (parsed.lines.length || parsed.taxGroups.length) {
      content.push(this.buildTaxRecap(parsed));
      content.push(this.buildTotals(parsed));
    }
    if (parsed.note?.trim())
      content.push({ text: `Napomena: ${parsed.note.trim()}`, style: "note" });

    content.push(this.buildSefTechBlock(parsed, row));
    content.push(
      buildSignatureRow(["Sastavio", "Kontrolisao", "Odgovorno lice"]),
    );

    const dd: TDocumentDefinitions = {
      pageSize: "A4",
      pageMargins: PAGE_MARGINS,
      content,
      styles: DOC_STYLES,
      defaultStyle: { font: "Roboto", fontSize: 9 },
      footer: buildPageFooter(
        `Izlazna e-faktura ${parsed.invoiceNumber || `#${row.id}`} · SEF`,
        opts.printedBy ?? null,
      ),
    };
    // Dok nije poslata, dokument NE sme da izgleda kao važeća e-faktura.
    if (row.status === "PENDING")
      dd.watermark = draftWatermark("NIJE POSLATO NA SEF");
    if (row.status === "REJECTED") dd.watermark = draftWatermark("ODBIJENO");
    if (row.status === "CANCELLED") dd.watermark = draftWatermark("STORNIRANO");

    const buffer = await this.pdf.render(dd);
    const base = parsed.invoiceNumber || `outbox-${row.id}`;
    return { buffer, fileName: `e-faktura-izlazna-${safeFileName(base)}.pdf` };
  }

  // ──────────────────────────────────────────────── ulazna e-faktura (incoming)

  /** Čitljiv PDF ulazne e-fakture (`sef_incoming_invoices`, `raw_xml`). */
  async buildIncomingPdf(
    incomingId: number,
    opts: { printedBy?: string | null } = {},
  ): Promise<{ buffer: Buffer; fileName: string }> {
    const row = await this.prisma.sefIncomingInvoice.findUnique({
      where: { id: incomingId },
    });
    if (!row)
      throw new NotFoundException(`Ulazna e-faktura ${incomingId} ne postoji.`);

    const issuer = await this.loadIssuer();
    const parsed = parseUbl(row.rawXml);

    const supplier: PartyInfo = parsed.supplier ?? {
      name: row.supplierName ?? "(nepoznat dobavljač)",
      taxId: row.supplierPib,
    };

    const daysLeft =
      row.acceptDeadline != null
        ? Math.ceil((row.acceptDeadline.getTime() - Date.now()) / 86_400_000)
        : null;

    const content: Content[] = [
      buildDocHeader({
        title: "ULAZNA e-FAKTURA (SEF)",
        subtitle:
          "Čitljiv prikaz elektronske fakture primljene preko Sistema elektronskih faktura",
        issuer,
        status: incomingStatusBadge(row.status),
        meta: [
          { label: "Broj fakture", value: row.invoiceNumber },
          { label: "PIB dobavljača", value: row.supplierPib },
          { label: "Datum izdavanja", value: fmtDate(row.issueDate) },
          { label: "Datum prijema (SEF)", value: fmtDate(row.deliveryDate) },
          { label: "Rok plaćanja", value: fmtDate(row.dueDate) },
        ],
      }),
      buildParties(
        { title: "DOBAVLJAČ (izdavalac)", party: supplier },
        { title: "PRIMALAC", party: issuerAsParty(issuer) },
      ),
      this.buildDeadlineStrip(row.acceptDeadline, daysLeft, row.status),
    ];

    if (!row.rawXml)
      content.push(
        buildEmptyNotice(
          "Stavke fakture nisu dostupne",
          "SEF za ovaj dokument nije isporučio XML — prikazani su zbirni iznosi iz evidencije.",
        ),
      );
    else if (!parsed.ok)
      content.push(
        buildEmptyNotice(
          "UBL dokument se ne može pročitati",
          `XML je sačuvan uz dokument, ali ga prikaz ne razume (${parsed.parseError ?? "nepoznata greška"}).`,
        ),
      );

    content.push(this.buildLinesTable(parsed));
    if (parsed.taxGroups.length) content.push(this.buildTaxRecap(parsed));

    // Zbir se UVEK ispisuje iz evidencije (baza je merodavna za KUF), a iz XML-a
    // se prikazuje kontrolno — ako se razilaze, to mora da se vidi.
    content.push(
      this.buildIncomingTotals(
        row.totalAmount,
        row.vatAmount,
        row.currency,
        parsed,
      ),
    );
    content.push(this.buildIncomingStatusBlock(row));
    content.push(
      buildSignatureRow(["Primio", "Kontrolisao", "Odgovorno lice"]),
    );

    const dd: TDocumentDefinitions = {
      pageSize: "A4",
      pageMargins: PAGE_MARGINS,
      content,
      styles: DOC_STYLES,
      defaultStyle: { font: "Roboto", fontSize: 9 },
      footer: buildPageFooter(
        `Ulazna e-faktura ${row.invoiceNumber} · SEF`,
        opts.printedBy ?? null,
      ),
    };
    if (row.status === "REJECTED") dd.watermark = draftWatermark("ODBIJENO");

    const buffer = await this.pdf.render(dd);
    return {
      buffer,
      fileName: `e-faktura-ulazna-${safeFileName(row.invoiceNumber)}.pdf`,
    };
  }

  // ──────────────────────────────────────────────────────────── zajednički delovi

  /** Firma-primalac/izdavalac iz `companies` (primarna firma). */
  private async loadIssuer(): Promise<IssuerInfo> {
    const c = await this.prisma.company.findFirst({
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
    if (!c)
      return {
        companyName: "Servoteh d.o.o.",
        address: null,
        city: null,
        taxId: null,
        registrationNumber: null,
        bankAccount: null,
        phone: null,
        email: null,
        missing: true,
      };
    return { ...c, missing: false };
  }

  /** Tabela stavki (`cac:InvoiceLine`) — zaglavlje se ponavlja na svakoj strani. */
  private buildLinesTable(p: ParsedUbl): Content {
    if (!p.lines.length)
      return buildEmptyNotice(
        "Nema stavki za prikaz",
        "U elektronskoj fakturi nije pronađena nijedna stavka (cac:InvoiceLine).",
      );

    const head = [
      "R.br.",
      "Naziv / opis",
      "JM",
      "Količina",
      "Cena",
      "Rabat",
      "Osnovica",
      "PDV %",
      "Kat.",
    ];
    const widths: (string | number)[] = [24, "*", 26, 54, 58, 50, 66, 34, 26];
    const headerCells: Content[] = head.map((text, i) => ({
      text,
      style: "th",
      alignment: i >= 2 && i <= 7 ? "right" : "left",
    }));

    const body: Content[][] = p.lines.map((l, idx) => [
      { text: l.lineNo || String(idx + 1), style: "td" },
      { text: l.name, style: "td" },
      { text: l.unit, style: "tdNum" },
      { text: fmtQty(l.quantity), style: "tdNum" },
      { text: fmtMoney(l.unitPrice, 4), style: "tdNum" },
      {
        text: l.allowance.isZero() ? "—" : fmtMoney(l.allowance),
        style: "tdNum",
      },
      { text: fmtMoney(l.lineAmount), style: "tdNum" },
      { text: l.vatPercent ? `${l.vatPercent}%` : "—", style: "tdNum" },
      { text: l.vatCategory, style: "td" },
    ]);

    const sum = p.lines.reduce(
      (a, l) => a.plus(l.lineAmount),
      new Prisma.Decimal(0),
    );
    body.push([
      { text: "", style: "th" },
      { text: `UKUPNO STAVKE (redova: ${p.lines.length})`, style: "th" },
      { text: "", style: "th" },
      { text: "", style: "th" },
      { text: "", style: "th" },
      { text: "", style: "th" },
      { text: fmtMoney(sum), style: "th", alignment: "right" },
      { text: "", style: "th" },
      { text: "", style: "th" },
    ]);

    return {
      table: { headerRows: 1, widths, body: [headerCells, ...body] },
      layout: TABLE_LAYOUT,
    };
  }

  /** Poreska rekapitulacija po stopama (`cac:TaxSubtotal`). */
  private buildTaxRecap(p: ParsedUbl): Content {
    if (!p.taxGroups.length) return { text: "" };
    const headerCells: Content[] = [
      "Kategorija PDV",
      "Stopa",
      "Osnovica",
      "PDV",
      "Osnov oslobođenja",
    ].map((text, i) => ({
      text,
      style: "th",
      alignment: i === 1 || i === 2 || i === 3 ? "right" : "left",
    }));

    const body: Content[][] = p.taxGroups.map((g) => [
      { text: taxCategoryLabel(g.category), style: "td" },
      { text: g.percent ? `${g.percent}%` : "—", style: "tdNum" },
      { text: fmtMoney(g.taxableAmount), style: "tdNum" },
      { text: fmtMoney(g.taxAmount), style: "tdNum" },
      { text: g.exemptionReason ?? "—", style: "td" },
    ]);

    const base = p.taxGroups.reduce(
      (a, g) => a.plus(g.taxableAmount),
      new Prisma.Decimal(0),
    );
    const tax = p.taxGroups.reduce(
      (a, g) => a.plus(g.taxAmount),
      new Prisma.Decimal(0),
    );
    body.push([
      { text: "UKUPNO", style: "th" },
      { text: "", style: "th" },
      { text: fmtMoney(base), style: "th", alignment: "right" },
      { text: fmtMoney(tax), style: "th", alignment: "right" },
      { text: "", style: "th" },
    ]);

    return {
      margin: [0, 12, 0, 0],
      stack: [
        { text: "Rekapitulacija PDV", style: "sectionLbl" },
        {
          margin: [0, 4, 0, 0],
          table: {
            headerRows: 1,
            widths: [110, 44, 84, 84, "*"],
            body: [headerCells, ...body],
          },
          layout: TABLE_LAYOUT,
        },
      ],
    };
  }

  /** `cac:LegalMonetaryTotal` — zbirovi kako ih SEF vidi. */
  private buildTotals(p: ParsedUbl): Content {
    const rows: Array<[string, string]> = [
      ["Zbir stavki (bez PDV):", fmtMoney(p.lineExtensionAmount)],
      ["Osnovica ukupno:", fmtMoney(p.taxExclusiveAmount)],
      ["PDV ukupno:", fmtMoney(p.taxTotal)],
      ["Ukupno sa PDV:", fmtMoney(p.taxInclusiveAmount)],
    ];
    if (!p.prepaidAmount.isZero())
      rows.push(["Plaćeni avans:", fmtMoney(p.prepaidAmount)]);

    return {
      unbreakable: true,
      margin: [0, 12, 0, 0],
      stack: [
        {
          columns: [
            { width: "*", text: "" },
            {
              width: 260,
              table: {
                widths: ["*", 100],
                body: [
                  ...rows.map(([l, v]) => [
                    { text: l, style: "totLbl" },
                    { text: v, style: "totVal" },
                  ]),
                  [
                    { text: "ZA PLAĆANJE:", style: "grand" },
                    {
                      text: `${fmtMoney(p.payableAmount)} ${p.currency || "RSD"}`,
                      style: "grand",
                    },
                  ],
                ],
              },
              layout: {
                hLineWidth: (
                  i: number,
                  node: { table: { body: unknown[] } },
                ) =>
                  i === node.table.body.length - 1 ||
                  i === node.table.body.length
                    ? 0.8
                    : 0,
                vLineWidth: () => 0,
                hLineColor: () => "#333333",
                paddingTop: () => 2,
                paddingBottom: () => 2,
                paddingLeft: () => 4,
                paddingRight: () => 4,
              },
            },
          ],
        },
        {
          text: `Slovima: ${amountInWords(p.payableAmount, p.currency || "RSD")}`,
          fontSize: 8,
          italics: true,
          color: "#444",
          margin: [0, 6, 0, 0],
        },
      ],
    };
  }

  /** Zbir ulazne fakture iz evidencije + kontrola prema XML-u. */
  private buildIncomingTotals(
    totalAmount: Prisma.Decimal,
    vatAmount: Prisma.Decimal,
    currency: string,
    p: ParsedUbl,
  ): Content {
    const xmlPayable = p.payableAmount;
    const mismatch =
      p.ok && !xmlPayable.isZero() && !xmlPayable.equals(totalAmount);
    return {
      unbreakable: true,
      margin: [0, 12, 0, 0],
      stack: [
        {
          columns: [
            { width: "*", text: "" },
            {
              width: 260,
              table: {
                widths: ["*", 100],
                body: [
                  [
                    { text: "Osnovica (bez PDV):", style: "totLbl" },
                    {
                      text: fmtMoney(
                        toDec(totalAmount).minus(toDec(vatAmount)),
                      ),
                      style: "totVal",
                    },
                  ],
                  [
                    { text: "PDV:", style: "totLbl" },
                    { text: fmtMoney(vatAmount), style: "totVal" },
                  ],
                  [
                    { text: "UKUPNO:", style: "grand" },
                    {
                      text: `${fmtMoney(totalAmount)} ${currency}`,
                      style: "grand",
                    },
                  ],
                ],
              },
              layout: {
                hLineWidth: (
                  i: number,
                  node: { table: { body: unknown[] } },
                ) =>
                  i === node.table.body.length - 1 ||
                  i === node.table.body.length
                    ? 0.8
                    : 0,
                vLineWidth: () => 0,
                hLineColor: () => "#333333",
                paddingTop: () => 2,
                paddingBottom: () => 2,
                paddingLeft: () => 4,
                paddingRight: () => 4,
              },
            },
          ],
        },
        {
          text: `Slovima: ${amountInWords(totalAmount, currency)}`,
          fontSize: 8,
          italics: true,
          color: "#444",
          margin: [0, 6, 0, 0],
        },
        ...(mismatch
          ? [
              {
                text: `NEUSKLAĐENO: iznos u XML-u (${fmtMoney(xmlPayable)}) razlikuje se od iznosa u evidenciji (${fmtMoney(totalAmount)}).`,
                fontSize: 8,
                bold: true,
                color: "#a00000",
                margin: [0, 4, 0, 0] as [number, number, number, number],
              },
            ]
          : []),
      ],
    };
  }

  /** Rok od 15 dana za prihvatanje/odbijanje — zakonska obaveza, mora da bode oči. */
  private buildDeadlineStrip(
    deadline: Date | null,
    daysLeft: number | null,
    status: string,
  ): Content {
    const settled = status === "ACCEPTED" || status === "REJECTED";
    const text = settled
      ? `Dokument je obrađen (status ${status}) — rok za odgovor više ne teče.`
      : deadline == null
        ? "Rok za prihvatanje/odbijanje nije određen (nedostaje datum prijema na SEF)."
        : `Rok za prihvatanje ili odbijanje: ${fmtDate(deadline)} — ${
            daysLeft != null && daysLeft >= 0
              ? `preostalo dana: ${daysLeft}`
              : "ROK JE ISTEKAO"
          }`;
    const urgent =
      !settled && (deadline == null || (daysLeft != null && daysLeft <= 3));
    return {
      margin: [0, 0, 0, 10],
      table: {
        widths: ["*"],
        body: [
          [
            {
              text,
              fontSize: 9,
              bold: true,
              color: urgent ? "#a00000" : "#444",
              fillColor: urgent ? "#ffe8e8" : "#f5f5f5",
              margin: [8, 5, 8, 5] as [number, number, number, number],
            },
          ],
        ],
      },
      layout: {
        hLineWidth: () => 0.6,
        vLineWidth: () => 0.6,
        hLineColor: () => (urgent ? "#a00000" : "#dddddd"),
        vLineColor: () => (urgent ? "#a00000" : "#dddddd"),
      },
    };
  }

  /** Tehnički trag SEF slanja (identifikatori bez kojih reklamacija nije moguća). */
  private buildSefTechBlock(
    p: ParsedUbl,
    row: {
      requestId: string;
      status: string;
      sefInvoiceId: string | null;
      errorMessage: string | null;
      sentAt: Date | null;
      createdAt: Date;
    },
  ): Content {
    const pairs: Array<[string, string]> = [
      ["Status na SEF-u", row.status],
      ["SEF ID dokumenta", row.sefInvoiceId ?? "—"],
      ["RequestID (idempotencija)", row.requestId],
      ["Kreirano", fmtDate(row.createdAt)],
      ["Poslato", row.sentAt ? fmtDate(row.sentAt) : "—"],
      ["UBL CustomizationID", p.customizationId || "—"],
      ["UBL ProfileID", p.profileId || "—"],
      ["Vrsta dokumenta (UBL)", invoiceTypeLabel(p.invoiceTypeCode)],
      ["Veza (avans/osnov)", p.billingReference ?? "—"],
      ["Račun za uplatu", p.paymentMeansAccount ?? "—"],
      ["Poziv na broj", p.paymentReference ?? "—"],
    ];
    if (row.errorMessage) pairs.push(["Poruka SEF-a", row.errorMessage]);

    return {
      margin: [0, 14, 0, 0],
      stack: [
        { text: "Podaci o elektronskom slanju (SEF)", style: "sectionLbl" },
        {
          margin: [0, 4, 0, 0],
          table: {
            widths: [150, "*"],
            body: pairs.map(([l, v]) => [
              { text: l, fontSize: 7.5, color: "#666" },
              { text: v, fontSize: 7.5 },
            ]),
          },
          layout: {
            hLineWidth: () => 0.3,
            vLineWidth: () => 0,
            hLineColor: () => "#eeeeee",
            paddingTop: () => 1.5,
            paddingBottom: () => 1.5,
            paddingLeft: () => 0,
            paddingRight: () => 4,
          },
        },
      ],
    };
  }

  /** Status obrade ulazne fakture (dedup, KUF veza, razlog odbijanja). */
  private buildIncomingStatusBlock(row: {
    sefPurchaseId: string;
    status: string;
    alreadyExists: boolean;
    matchedKufEntryId: number | null;
    rejectComment: string | null;
    actionAt: Date | null;
    createdAt: Date;
    currency: string;
  }): Content {
    const pairs: Array<[string, string]> = [
      ["Status obrade", row.status],
      ["SEF PurchaseInvoiceId", row.sefPurchaseId],
      ["Povučeno sa SEF-a", fmtDate(row.createdAt)],
      ["Obrađeno", row.actionAt ? fmtDate(row.actionAt) : "—"],
      [
        "Već u evidenciji (KUF)",
        row.alreadyExists
          ? `da${row.matchedKufEntryId != null ? ` — KUF stavka #${row.matchedKufEntryId}` : ""}`
          : "ne",
      ],
      ["Valuta", row.currency],
    ];
    if (row.rejectComment) pairs.push(["Razlog odbijanja", row.rejectComment]);

    return {
      margin: [0, 14, 0, 0],
      stack: [
        { text: "Podaci o elektronskom prijemu (SEF)", style: "sectionLbl" },
        {
          margin: [0, 4, 0, 0],
          table: {
            widths: [150, "*"],
            body: pairs.map(([l, v]) => [
              { text: l, fontSize: 7.5, color: "#666" },
              { text: v, fontSize: 7.5 },
            ]),
          },
          layout: {
            hLineWidth: () => 0.3,
            vLineWidth: () => 0,
            hLineColor: () => "#eeeeee",
            paddingTop: () => 1.5,
            paddingBottom: () => 1.5,
            paddingLeft: () => 0,
            paddingRight: () => 4,
          },
        },
      ],
    };
  }
}

// ─────────────────────────────────────────────────────────── UBL parsiranje

/** Prazan (neuspešan) rezultat — dokument se i tada štampa. */
function emptyParsed(parseError: string | null): ParsedUbl {
  const z = () => new Prisma.Decimal(0);
  return {
    ok: false,
    parseError,
    invoiceNumber: "",
    issueDate: "",
    dueDate: "",
    deliveryDate: "",
    currency: "",
    invoiceTypeCode: "",
    note: null,
    customizationId: "",
    profileId: "",
    supplier: null,
    customer: null,
    paymentMeansAccount: null,
    paymentReference: null,
    lines: [],
    taxGroups: [],
    lineExtensionAmount: z(),
    taxExclusiveAmount: z(),
    taxInclusiveAmount: z(),
    prepaidAmount: z(),
    payableAmount: z(),
    taxTotal: z(),
    billingReference: null,
  };
}

/**
 * UBL 2.1 Invoice → podaci za prikaz. NIKAD ne baca: neispravan/nepostojeći XML
 * vraća `ok: false` i prazne vrednosti, pa dokument izađe sa napomenom.
 */
export function parseUbl(xml: string | null | undefined): ParsedUbl {
  if (!xml || !xml.trim()) return emptyParsed(null);
  let doc: XmlDocument;
  try {
    doc = new XmlDocument(xml);
  } catch (e) {
    return emptyParsed(e instanceof Error ? e.message : String(e));
  }

  try {
    const out = emptyParsed(null);
    out.ok = true;

    out.invoiceNumber = val(doc, "cbc:ID") ?? "";
    out.issueDate = val(doc, "cbc:IssueDate") ?? "";
    out.dueDate = val(doc, "cbc:DueDate") ?? "";
    out.currency = val(doc, "cbc:DocumentCurrencyCode") ?? "";
    out.invoiceTypeCode = val(doc, "cbc:InvoiceTypeCode") ?? "";
    out.note = val(doc, "cbc:Note") ?? null;
    out.customizationId = val(doc, "cbc:CustomizationID") ?? "";
    out.profileId = val(doc, "cbc:ProfileID") ?? "";

    const delivery = doc.childNamed("cac:Delivery");
    out.deliveryDate = delivery
      ? (val(delivery, "cbc:ActualDeliveryDate") ?? "")
      : "";

    out.supplier = parseParty(doc.childNamed("cac:AccountingSupplierParty"));
    out.customer = parseParty(doc.childNamed("cac:AccountingCustomerParty"));

    const means = doc.childNamed("cac:PaymentMeans");
    if (means) {
      const acct = means.childNamed("cac:PayeeFinancialAccount");
      out.paymentMeansAccount = acct ? (val(acct, "cbc:ID") ?? null) : null;
      out.paymentReference = val(means, "cbc:PaymentID") ?? null;
    }

    const billing = doc.childNamed("cac:BillingReference");
    if (billing) {
      const ref = billing.childNamed("cac:InvoiceDocumentReference");
      out.billingReference = ref ? (val(ref, "cbc:ID") ?? null) : null;
    }

    // ── stavke ──
    for (const line of doc.childrenNamed("cac:InvoiceLine")) {
      const item = line.childNamed("cac:Item");
      const priceEl = line.childNamed("cac:Price");
      const taxCat = item?.childNamed("cac:ClassifiedTaxCategory");
      const allowance = line.childNamed("cac:AllowanceCharge");
      out.lines.push({
        lineNo: val(line, "cbc:ID") ?? "",
        name:
          (item
            ? (val(item, "cbc:Name") ?? val(item, "cbc:Description"))
            : null) ?? "(bez naziva)",
        unit: attrOf(line, "cbc:InvoicedQuantity", "unitCode") ?? "",
        quantity: dec(val(line, "cbc:InvoicedQuantity")),
        unitPrice: priceEl ? dec(val(priceEl, "cbc:PriceAmount")) : dec(null),
        allowance: allowance ? dec(val(allowance, "cbc:Amount")) : dec(null),
        lineAmount: dec(val(line, "cbc:LineExtensionAmount")),
        vatPercent: taxCat ? (val(taxCat, "cbc:Percent") ?? "") : "",
        vatCategory: taxCat ? (val(taxCat, "cbc:ID") ?? "") : "",
      });
    }

    // ── poreska rekapitulacija ──
    const taxTotal = doc.childNamed("cac:TaxTotal");
    if (taxTotal) {
      out.taxTotal = dec(val(taxTotal, "cbc:TaxAmount"));
      for (const sub of taxTotal.childrenNamed("cac:TaxSubtotal")) {
        const cat = sub.childNamed("cac:TaxCategory");
        out.taxGroups.push({
          category: cat ? (val(cat, "cbc:ID") ?? "") : "",
          percent: cat ? (val(cat, "cbc:Percent") ?? "") : "",
          taxableAmount: dec(val(sub, "cbc:TaxableAmount")),
          taxAmount: dec(val(sub, "cbc:TaxAmount")),
          exemptionReason: cat
            ? (val(cat, "cbc:TaxExemptionReason") ??
              val(cat, "cbc:TaxExemptionReasonCode") ??
              null)
            : null,
        });
      }
    }

    // ── zbirovi ──
    const lmt = doc.childNamed("cac:LegalMonetaryTotal");
    if (lmt) {
      out.lineExtensionAmount = dec(val(lmt, "cbc:LineExtensionAmount"));
      out.taxExclusiveAmount = dec(val(lmt, "cbc:TaxExclusiveAmount"));
      out.taxInclusiveAmount = dec(val(lmt, "cbc:TaxInclusiveAmount"));
      out.prepaidAmount = dec(val(lmt, "cbc:PrepaidAmount"));
      out.payableAmount = dec(val(lmt, "cbc:PayableAmount"));
    }
    if (!out.currency)
      out.currency = attrOf(doc, "cbc:TaxInclusiveAmount", "currencyID") ?? "";

    return out;
  } catch (e) {
    return emptyParsed(e instanceof Error ? e.message : String(e));
  }
}

/** `cac:AccountingSupplierParty` / `…CustomerParty` → prikazni podaci strane. */
function parseParty(wrapper: XmlElement | undefined): PartyInfo | null {
  if (!wrapper) return null;
  const party = wrapper.childNamed("cac:Party");
  if (!party) return null;
  const legal = party.childNamed("cac:PartyLegalEntity");
  const addr = party.childNamed("cac:PostalAddress");
  const taxScheme = party.childNamed("cac:PartyTaxScheme");
  const contact = party.childNamed("cac:Contact");
  const nameEl = party.childNamed("cac:PartyName");

  const name =
    (legal ? val(legal, "cbc:RegistrationName") : null) ??
    (nameEl ? val(nameEl, "cbc:Name") : null) ??
    "(bez naziva)";

  return {
    name,
    address: addr ? (val(addr, "cbc:StreetName") ?? null) : null,
    postalCode: addr ? (val(addr, "cbc:PostalZone") ?? null) : null,
    city: addr ? (val(addr, "cbc:CityName") ?? null) : null,
    country: addr
      ? (() => {
          const c = addr.childNamed("cac:Country");
          return c ? (val(c, "cbc:IdentificationCode") ?? null) : null;
        })()
      : null,
    taxId: normalizePib(
      (taxScheme ? val(taxScheme, "cbc:CompanyID") : null) ??
        val(party, "cbc:EndpointID") ??
        null,
    ),
    registrationNumber: legal ? (val(legal, "cbc:CompanyID") ?? null) : null,
    email: contact ? (val(contact, "cbc:ElectronicMail") ?? null) : null,
    phone: contact ? (val(contact, "cbc:Telephone") ?? null) : null,
  };
}

/** Vrednost neposrednog deteta (leaf) — trimovana, prazno → undefined. */
function val(el: XmlDocument | XmlElement, name: string): string | undefined {
  const child = el.childNamed(name);
  if (!child) return undefined;
  const v = (child.val ?? "").trim();
  return v.length ? v : undefined;
}

/** Vrednost atributa neposrednog deteta (npr. `unitCode` na InvoicedQuantity). */
function attrOf(
  el: XmlDocument | XmlElement,
  name: string,
  attr: string,
): string | undefined {
  const child = el.childNamed(name);
  const v = child?.attr?.[attr];
  return v != null && String(v).length ? String(v) : undefined;
}

function dec(v: string | null | undefined): Prisma.Decimal {
  return toDec(v == null ? 0 : v.replace(/\s/g, ""));
}

function normalizePib(raw: string | null): string | null {
  if (!raw) return null;
  const v = raw.replace(/^(9948:|RS)[:\s]*/i, "").trim();
  return v.length ? v : null;
}

// ─────────────────────────────────────────────────────────────── prevodi/značke

/** UBL `InvoiceTypeCode` → srpski naziv (380 komercijalna, 386 avansna). */
function invoiceTypeLabel(code: string): string {
  switch (code) {
    case "380":
      return "380 — komercijalna faktura";
    case "386":
      return "386 — avansni račun";
    case "381":
      return "381 — knjižno odobrenje";
    case "383":
      return "383 — knjižno zaduženje";
    default:
      return code || "—";
  }
}

/** UBL PDV kategorija → srpski opis (S/Z/E/AE/O). */
function taxCategoryLabel(code: string): string {
  switch (code) {
    case "S":
      return "S — oporezivo";
    case "Z":
      return "Z — oslobođeno sa pravom odbitka (izvoz)";
    case "E":
      return "E — oslobođeno bez prava odbitka";
    case "AE":
      return "AE — obrnuto obračunavanje";
    case "O":
      return "O — nije predmet oporezivanja";
    default:
      return code || "—";
  }
}

function outboundStatusBadge(status: string): StatusBadgeSpec {
  switch (status) {
    case "PENDING":
      return { label: "PRIPREMLJENO (nije poslato)", tone: "draft" };
    case "SENT":
      return { label: "POSLATO NA SEF", tone: "neutral" };
    case "DELIVERED":
      return { label: "ISPORUČENO / PRIHVAĆENO", tone: "ok" };
    case "REJECTED":
      return { label: "ODBIJENO", tone: "danger" };
    case "CANCELLED":
      return { label: "STORNIRANO", tone: "danger" };
    default:
      return { label: status, tone: "neutral" };
  }
}

function incomingStatusBadge(status: string): StatusBadgeSpec {
  switch (status) {
    case "NEW":
      return { label: "NOVO — čeka odluku", tone: "draft" };
    case "SEEN":
      return { label: "PREGLEDANO — čeka odluku", tone: "draft" };
    case "ACCEPTED":
      return { label: "PRIHVAĆENO", tone: "ok" };
    case "REJECTED":
      return { label: "ODBIJENO", tone: "danger" };
    default:
      return { label: status, tone: "neutral" };
  }
}

/** Firma-izdavalac u obliku „strane" za dvokolonski blok. */
function issuerAsParty(issuer: IssuerInfo): PartyInfo {
  return {
    name: issuer.companyName,
    address: issuer.address,
    city: issuer.city,
    taxId: issuer.taxId,
    registrationNumber: issuer.registrationNumber,
    bankAccount: issuer.bankAccount,
    email: issuer.email,
    phone: issuer.phone,
  };
}
