import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";

/**
 * UBL 2.1 BUILDER — Invoice → SEF e-faktura XML (doc 07 §8, §6.2 field-mapping).
 * =============================================================================
 * Gradi UBL 2.1 Invoice dokument iz `Invoice` + `InvoiceItem[]` (49 cbc/cac
 * elemenata iz doc 07 §6.2/§8). Redosled elemenata i imena TAČNO po UBL 2.1
 * shemi koju SEF (MFIN) prihvata; odstupanje = odbijeni dokument.
 *
 * KLJUČNE ODLUKE MAPIRANJA:
 *   • CustomizationID = urn:cen.eu:en16931:2017#compliant#urn:mfin.gov.rs:srbdt:2021
 *     (SEF nacionalni CIUS — konstanta).
 *   • PDV kategorije (cac:TaxCategory/cbc:ID):
 *       - S  = standardna/snižena stopa >0% (20/10/8, domaći promet)  → percent stope
 *       - Z  = izvoz / oslobođeno sa pravom na odbitak                 → percent 0, osnov čl.24
 *       - E  = domaće oslobođenje bez izvoza (0%, bez export osnova)
 *     Osnov oslobođenja (cbc:TaxExemptionReasonCode) `PDV-RS-24-1-5` za BMTS izvoz.
 *   • PDV GRANULARNOST (Talas 2 A5): TaxTotal grupiše stavke po STVARNOJ stopi svake
 *     stavke (iz `vatRateCode`) → jedan cac:TaxSubtotal po stopi (20/10/8/0). Faktura
 *     sa 20% i 10% stavkom → dva TaxSubtotal-a. Isto važi za ClassifiedTaxCategory po
 *     liniji (svaka stavka nosi svoju stopu/kategoriju).
 *   • Avans (`za plaćanje = 0`): kada je grossTotal knjižen kroz avansnu fakturu,
 *     cac:BillingReference → cac:InvoiceDocumentReference nosi referencu avansa i
 *     LegalMonetaryTotal/PayableAmount = 0 (avans zatvara obavezu).
 *   • Rabat po stavci → cac:AllowanceCharge (ChargeIndicator=false).
 *   • PDF prilog (base64) → cac:AdditionalDocumentReference → cac:Attachment →
 *     cbc:EmbeddedDocumentBinaryObject.
 *
 * ⚠️ Ovaj servis je ČIST (bez baze, bez mreže): prima već učitane entitete i
 * vraća string. Prisma.Decimal se serijalizuje preko `.toFixed(2)` (novac) —
 * nikad Number(), da se ne izgubi preciznost.
 */

const D = Prisma.Decimal;

/** SEF nacionalni CIUS (CustomizationID) — konstanta koju MFIN očekuje. */
const SEF_CUSTOMIZATION_ID =
  "urn:cen.eu:en16931:2017#compliant#urn:mfin.gov.rs:srbdt:2021";
/** UBL profil (procurement). */
const SEF_PROFILE_ID = "urn:cen.eu:en16931:2017.poacc:billing:3.0";
/** Osnov oslobođenja za izvoz (BMTS) — čl. 24 st. 1 tač. 5. */
const EXPORT_EXEMPTION_CODE = "PDV-RS-24-1-5";
const EXPORT_EXEMPTION_REASON = "Izvoz dobara (čl. 24 st. 1 tač. 5 ZPDV)";
/**
 * Osnov DOMAĆEG oslobođenja (kategorija E — 0% bez izvoza). EN16931 BR-E-10: kategorija E
 * MORA imati BT-120 (tekst razloga) ILI BT-121 (šifra) — bez toga SEF/CIUS odbija dokument.
 * Privremeni tekst; TODO(Talas 2): tačan osnov i šifra PDV-RS kategorije iz šifarnika kad
 * knjigovođa definiše (tada dodati i cbc:TaxExemptionReasonCode = BT-121).
 */
const DOMESTIC_EXEMPTION_REASON = "Promet oslobodjen PDV";

/** UBL InvoiceTypeCode: 380 = komercijalna faktura, 386 = avansna. */
const INVOICE_TYPE_CODE_COMMERCIAL = "380";
const INVOICE_TYPE_CODE_PREPAYMENT = "386";

/**
 * PDV stopa (procenat) po `vatRateCode` — isto mapiranje kao PricingService
 * VAT_RATE_BY_CODE (doc 43 §4). "3"/"1" = 20%, "2" = 10%, "4" = 8%, "0" = 0%.
 * Nepoznata šifra → 20% (osnovna) kao default stavke.
 */
const VAT_PERCENT_BY_CODE: Readonly<Record<string, number>> = {
  "3": 20,
  "1": 20,
  "2": 10,
  "4": 8,
  "0": 0,
};

/** Procenat PDV stope za šifru (fallback 20% — osnovna). */
function vatPercentOf(code: string | null | undefined): number {
  if (code == null) return 20;
  return VAT_PERCENT_BY_CODE[code] ?? 20;
}

/**
 * PDV kategorija po stopi: >0% → S (standardna/snižena), 0% → Z (izvoz, uz osnov
 * oslobođenja) odn. E (domaće oslobođenje bez export osnova).
 */
function taxCategoryOf(percent: number, isExport: boolean): string {
  if (percent > 0) return "S";
  return isExport ? "Z" : "E";
}

/** Grupa PDV rekapitulacije (jedan cac:TaxSubtotal) — po jedinstvenoj stopi. */
interface TaxGroup {
  percent: number;
  category: string;
  taxableAmount: Prisma.Decimal;
  taxAmount: Prisma.Decimal;
}

/** Namespace deklaracije korena <Invoice>. */
const NS =
  'xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" ' +
  'xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" ' +
  'xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2"';

/** Podaci firme-izdavaoca za AccountingSupplierParty (iz Company). */
export interface UblSupplierParty {
  name: string;
  taxId: string; // PIB
  registrationNumber?: string | null; // matični broj
  address?: string | null;
  city?: string | null;
  bankAccount?: string | null;
}

/** Podaci kupca za AccountingCustomerParty (iz Customer). */
export interface UblCustomerParty {
  name: string;
  taxId?: string | null; // PIB
  registrationNumber?: string | null;
  address?: string | null;
  city?: string | null;
  publicSectorId?: string | null; // JBKJS (javni sektor → CIR ruta)
}

/** Minimalni oblik Invoice-a potreban builderu (podskup Prisma modela). */
export interface UblInvoiceInput {
  documentType: string;
  documentNumber: string;
  documentDate: Date;
  dueDate?: Date | null;
  currency: string;
  isExport: boolean;
  netTotal: Prisma.Decimal;
  vatTotal: Prisma.Decimal;
  grossTotal: Prisma.Decimal;
  note?: string | null;
  /** Broj narudžbenice kupca → cac:OrderReference/cbc:ID (SEF javni sektor, D6). */
  poNumber?: string | null;
  /** Referenca avansne fakture (cac:BillingReference) — kada je za plaćanje 0. */
  prepaymentReference?: string | null;
  /**
   * Odbijen (već plaćen) avans → cbc:PrepaidAmount; PayableAmount = grossTotal −
   * prepaidAmount. Kad se ne prosledi, važi staro ponašanje: sama referenca
   * avansa znači da avans zatvara CEO iznos (PayableAmount = 0).
   */
  prepaidAmount?: Prisma.Decimal | null;
  /** true = ova faktura je avansna (386). */
  isPrepayment?: boolean;
}

/** Minimalni oblik stavke (podskup InvoiceItem). */
export interface UblInvoiceItemInput {
  lineNo: number;
  description?: string | null;
  itemId?: number | null;
  quantity: Prisma.Decimal;
  unitPrice: Prisma.Decimal;
  discountPercent: Prisma.Decimal;
  /** Šifra PDV stope (InvoiceItem.vatRateCode) → stopa/kategorija po liniji. */
  vatRateCode: string;
  vatBase: Prisma.Decimal;
  vatAmount: Prisma.Decimal;
  lineTotal: Prisma.Decimal;
}

export interface UblBuildParams {
  invoice: UblInvoiceInput;
  items: UblInvoiceItemInput[];
  supplier: UblSupplierParty;
  customer: UblCustomerParty;
  /** PDF prilog (base64, bez data: prefiksa) — cac:Attachment. */
  pdfBase64?: string | null;
  pdfFileName?: string | null;
}

@Injectable()
export class UblBuilderService {
  /**
   * Sagradi UBL 2.1 XML string za jednu izlaznu fakturu. Vraća KOMPLETAN
   * dokument (sa XML deklaracijom). Ne dira bazu/mrežu.
   */
  build(params: UblBuildParams): string {
    const { invoice, items, supplier, customer } = params;
    const cur = invoice.currency || "RSD";

    const typeCode = invoice.isPrepayment
      ? INVOICE_TYPE_CODE_PREPAYMENT
      : INVOICE_TYPE_CODE_COMMERCIAL;

    // Za plaćanje: odbijen avans umanjuje obavezu za svoj iznos (delimičan avans
    // → ostatak; pun avans → 0). Bez `prepaidAmount` iznos se NE umanjuje —
    // ranije je sama referenca avansa obarala PayableAmount na nulu, pa je red sa
    // postavljenom vezom a nultim iznosom slao kupcu na SEF „ne duguješ ništa"
    // za pun račun (review Batch C, R6).
    const prepaid = invoice.prepaidAmount ?? null;
    const payable = prepaid
      ? maxZero(invoice.grossTotal.sub(prepaid))
      : invoice.grossTotal;

    const parts: string[] = [];
    parts.push('<?xml version="1.0" encoding="UTF-8"?>');
    parts.push(`<Invoice ${NS}>`);

    // — Zaglavlje —
    parts.push(el("cbc:CustomizationID", SEF_CUSTOMIZATION_ID));
    parts.push(el("cbc:ProfileID", SEF_PROFILE_ID));
    parts.push(el("cbc:ID", invoice.documentNumber));
    parts.push(el("cbc:IssueDate", fmtDate(invoice.documentDate)));
    if (invoice.dueDate) parts.push(el("cbc:DueDate", fmtDate(invoice.dueDate)));
    parts.push(el("cbc:InvoiceTypeCode", typeCode));
    if (invoice.note) parts.push(el("cbc:Note", invoice.note));
    parts.push(el("cbc:DocumentCurrencyCode", cur));

    // — Broj narudžbenice kupca (cac:OrderReference) — D6 —
    // UBL 2.1 redosled: OrderReference dolazi POSLE DocumentCurrencyCode a PRE
    // cac:BillingReference / cac:AdditionalDocumentReference / AccountingSupplierParty.
    // Javni sektor (JBKJS) često odbija fakturu bez broja narudžbenice.
    const poNumber = invoice.poNumber?.trim();
    if (poNumber) {
      parts.push("<cac:OrderReference>");
      parts.push(el("cbc:ID", poNumber));
      parts.push("</cac:OrderReference>");
    }

    // — Avansna referenca (cac:BillingReference) —
    if (invoice.prepaymentReference) {
      parts.push("<cac:BillingReference>");
      parts.push("<cac:InvoiceDocumentReference>");
      parts.push(el("cbc:ID", invoice.prepaymentReference));
      parts.push("</cac:InvoiceDocumentReference>");
      parts.push("</cac:BillingReference>");
    }

    // — PDF prilog (cac:AdditionalDocumentReference) —
    if (params.pdfBase64) {
      // Rezervno ime fajla se izvodi iz broja dokumenta, a broj po odluci O-F1 nosi
      // kosu crtu (`657/25`) — sirovo bi dalo „657/25.pdf", što je putanja, a ne ime
      // fajla (SEF validatori i klijenti to odbijaju/seku). Zato ista sanitizacija
      // kao u InvoicePdfService: separatori → crtica.
      const pdfFileName =
        params.pdfFileName ?? `${safeFileName(invoice.documentNumber)}.pdf`;
      parts.push("<cac:AdditionalDocumentReference>");
      parts.push(el("cbc:ID", pdfFileName));
      parts.push("<cac:Attachment>");
      parts.push(
        `<cbc:EmbeddedDocumentBinaryObject mimeCode="application/pdf" filename="${escapeXml(
          pdfFileName,
        )}">${params.pdfBase64}</cbc:EmbeddedDocumentBinaryObject>`,
      );
      parts.push("</cac:Attachment>");
      parts.push("</cac:AdditionalDocumentReference>");
    }

    // — Strane —
    parts.push(this.buildSupplier(supplier));
    parts.push(this.buildCustomer(customer));

    // — Rekapitulacija poreza (cac:TaxTotal → cac:TaxSubtotal PO STOPI) —
    // PDV granularnost (A5): grupiši stavke po stvarnoj stopi (20/10/8/0) → po jedan
    // TaxSubtotal. Zbir taxableAmount/taxAmount grupa = invoice.netTotal/vatTotal.
    parts.push("<cac:TaxTotal>");
    parts.push(amountEl("cbc:TaxAmount", invoice.vatTotal, cur));
    const taxGroups = groupTaxSubtotals(items, invoice.isExport);
    if (taxGroups.length === 0) {
      // Defanzivni fallback (faktura bez stavki) — jedan subtotal iz zaglavlja.
      parts.push("<cac:TaxSubtotal>");
      parts.push(amountEl("cbc:TaxableAmount", invoice.netTotal, cur));
      parts.push(amountEl("cbc:TaxAmount", invoice.vatTotal, cur));
      parts.push(
        this.buildTaxCategory(
          invoice.isExport ? "Z" : "S",
          invoice.isExport ? 0 : 20,
          invoice.isExport,
        ),
      );
      parts.push("</cac:TaxSubtotal>");
    } else {
      for (const g of taxGroups) {
        parts.push("<cac:TaxSubtotal>");
        parts.push(amountEl("cbc:TaxableAmount", g.taxableAmount, cur));
        parts.push(amountEl("cbc:TaxAmount", g.taxAmount, cur));
        // Export osnov oslobođenja samo za izvoznu 0% grupu; domaća 0% (E) bez njega.
        parts.push(
          this.buildTaxCategory(g.category, g.percent, invoice.isExport && g.percent === 0),
        );
        parts.push("</cac:TaxSubtotal>");
      }
    }
    parts.push("</cac:TaxTotal>");

    // — Zbirni iznosi (cac:LegalMonetaryTotal) —
    parts.push("<cac:LegalMonetaryTotal>");
    parts.push(amountEl("cbc:LineExtensionAmount", invoice.netTotal, cur));
    parts.push(amountEl("cbc:TaxExclusiveAmount", invoice.netTotal, cur));
    parts.push(amountEl("cbc:TaxInclusiveAmount", invoice.grossTotal, cur));
    // UBL 2.1 redosled: PrepaidAmount dolazi neposredno PRE PayableAmount.
    if (prepaid) parts.push(amountEl("cbc:PrepaidAmount", prepaid, cur));
    parts.push(amountEl("cbc:PayableAmount", payable, cur));
    parts.push("</cac:LegalMonetaryTotal>");

    // — Stavke (cac:InvoiceLine) — svaka nosi svoju stopu/kategoriju —
    for (const it of items) {
      parts.push(this.buildLine(it, cur, invoice.isExport));
    }

    parts.push("</Invoice>");
    return parts.join("");
  }

  // ───────────────────────────────────────────────────────────────────────────

  private buildSupplier(s: UblSupplierParty): string {
    const p: string[] = [];
    p.push("<cac:AccountingSupplierParty>");
    p.push("<cac:Party>");
    // EndpointID = PIB (SEF ruta preko PIB-a).
    p.push(`<cbc:EndpointID schemeID="9948">${escapeXml(s.taxId)}</cbc:EndpointID>`);
    p.push("<cac:PartyName>");
    p.push(el("cbc:Name", s.name));
    p.push("</cac:PartyName>");
    p.push(this.buildAddress(s.address, s.city));
    // Poreski podaci (PIB → PartyTaxScheme, matični broj → PartyLegalEntity).
    p.push("<cac:PartyTaxScheme>");
    p.push(el("cbc:CompanyID", `RS${s.taxId}`));
    p.push(taxScheme());
    p.push("</cac:PartyTaxScheme>");
    p.push("<cac:PartyLegalEntity>");
    p.push(el("cbc:RegistrationName", s.name));
    if (s.registrationNumber)
      p.push(el("cbc:CompanyID", s.registrationNumber));
    p.push("</cac:PartyLegalEntity>");
    p.push("</cac:Party>");
    p.push("</cac:AccountingSupplierParty>");
    return p.join("");
  }

  private buildCustomer(c: UblCustomerParty): string {
    const p: string[] = [];
    p.push("<cac:AccountingCustomerParty>");
    p.push("<cac:Party>");
    // Javni sektor → JBKJS ruta (schemeID 9948 za PIB inače).
    if (c.publicSectorId) {
      p.push(
        `<cbc:EndpointID schemeID="9948">${escapeXml(c.publicSectorId)}</cbc:EndpointID>`,
      );
    } else if (c.taxId) {
      p.push(`<cbc:EndpointID schemeID="9948">${escapeXml(c.taxId)}</cbc:EndpointID>`);
    }
    p.push("<cac:PartyName>");
    p.push(el("cbc:Name", c.name));
    p.push("</cac:PartyName>");
    p.push(this.buildAddress(c.address, c.city));
    if (c.taxId) {
      p.push("<cac:PartyTaxScheme>");
      p.push(el("cbc:CompanyID", `RS${c.taxId}`));
      p.push(taxScheme());
      p.push("</cac:PartyTaxScheme>");
    }
    p.push("<cac:PartyLegalEntity>");
    p.push(el("cbc:RegistrationName", c.name));
    if (c.registrationNumber)
      p.push(el("cbc:CompanyID", c.registrationNumber));
    p.push("</cac:PartyLegalEntity>");
    p.push("</cac:Party>");
    p.push("</cac:AccountingCustomerParty>");
    return p.join("");
  }

  private buildAddress(address?: string | null, city?: string | null): string {
    const p: string[] = [];
    p.push("<cac:PostalAddress>");
    if (address) p.push(el("cbc:StreetName", address));
    if (city) p.push(el("cbc:CityName", city));
    p.push("<cac:Country>");
    p.push(el("cbc:IdentificationCode", "RS"));
    p.push("</cac:Country>");
    p.push("</cac:PostalAddress>");
    return p.join("");
  }

  /**
   * cac:TaxCategory sa PDV kategorijom (S/Z/E) + osnov oslobođenja. EN16931 BR-Z-* i
   * BR-E-10: obe oslobođene kategorije MORAJU nositi razlog oslobođenja, inače SEF odbija:
   *   Z (izvoz)  → TaxExemptionReasonCode (čl.24) + TaxExemptionReason (tekst).
   *   E (domaće) → TaxExemptionReason (BT-120 tekst); šifra (BT-121) TODO Talas 2.
   *   S (>0%)    → bez razloga (oporeziva stavka).
   */
  private buildTaxCategory(
    category: string,
    percent: number,
    isExport: boolean,
  ): string {
    const p: string[] = [];
    p.push("<cac:TaxCategory>");
    p.push(el("cbc:ID", category));
    p.push(el("cbc:Percent", percent.toFixed(2)));
    if (category === "Z" || isExport) {
      p.push(el("cbc:TaxExemptionReasonCode", EXPORT_EXEMPTION_CODE));
      p.push(el("cbc:TaxExemptionReason", EXPORT_EXEMPTION_REASON));
    } else if (category === "E") {
      // BR-E-10: domaće oslobođenje MORA imati BT-120 (tekst) ili BT-121 (šifra).
      // TODO(Talas 2): tačan osnov/šifra PDV-RS kategorije iz šifarnika + TaxExemptionReasonCode.
      p.push(el("cbc:TaxExemptionReason", DOMESTIC_EXEMPTION_REASON));
    }
    p.push(taxScheme());
    p.push("</cac:TaxCategory>");
    return p.join("");
  }

  private buildLine(
    it: UblInvoiceItemInput,
    cur: string,
    isExport: boolean,
  ): string {
    // Stopa/kategorija po STVARNOJ stopi stavke (izvoz forsira 0%).
    const taxPercent = isExport ? 0 : vatPercentOf(it.vatRateCode);
    const taxCategory = taxCategoryOf(taxPercent, isExport);
    const p: string[] = [];
    p.push("<cac:InvoiceLine>");
    p.push(el("cbc:ID", String(it.lineNo)));
    p.push(
      `<cbc:InvoicedQuantity unitCode="H87">${fmtQty(it.quantity)}</cbc:InvoicedQuantity>`,
    );
    p.push(amountEl("cbc:LineExtensionAmount", it.vatBase, cur));

    // Rabat po stavci → cac:AllowanceCharge (ChargeIndicator=false = popust).
    if (!it.discountPercent.isZero()) {
      const gross = it.unitPrice.mul(it.quantity);
      const allowance = gross.minus(it.vatBase);
      if (allowance.greaterThan(0)) {
        p.push("<cac:AllowanceCharge>");
        p.push(el("cbc:ChargeIndicator", "false"));
        p.push(el("cbc:AllowanceChargeReason", "Rabat"));
        p.push(el("cbc:MultiplierFactorNumeric", fmtQty(it.discountPercent)));
        p.push(amountEl("cbc:Amount", allowance, cur));
        p.push(amountEl("cbc:BaseAmount", gross, cur));
        p.push("</cac:AllowanceCharge>");
      }
    }

    // Stavka poreza po liniji.
    p.push("<cac:Item>");
    p.push(el("cbc:Name", it.description ?? `Stavka ${it.lineNo}`));
    p.push("<cac:ClassifiedTaxCategory>");
    p.push(el("cbc:ID", taxCategory));
    p.push(el("cbc:Percent", taxPercent.toFixed(2)));
    if (taxCategory === "Z" || isExport) {
      p.push(el("cbc:TaxExemptionReasonCode", EXPORT_EXEMPTION_CODE));
    } else if (taxCategory === "E") {
      // BR-E-10: i po liniji domaće oslobođenje nosi razlog (BT-120 tekst).
      // TODO(Talas 2): tačan osnov/šifra PDV-RS kategorije iz šifarnika.
      p.push(el("cbc:TaxExemptionReason", DOMESTIC_EXEMPTION_REASON));
    }
    p.push(taxScheme());
    p.push("</cac:ClassifiedTaxCategory>");
    p.push("</cac:Item>");

    // Cena.
    p.push("<cac:Price>");
    p.push(amountEl("cbc:PriceAmount", it.unitPrice, cur));
    p.push("</cac:Price>");

    p.push("</cac:InvoiceLine>");
    return p.join("");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// XML helperi (čisti — bez stanja)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Grupiši stavke po stvarnoj PDV stopi → cac:TaxSubtotal grupe (A5 granularnost).
 * Izvoz: sve stavke u 0% grupu (Z). Domaći: 20/10/8/0 razdvojeno. Sortirano opadajuće
 * po stopi (20,10,8,0) radi determinističkog XML-a. Zbir taxableAmount = netTotal,
 * zbir taxAmount = vatTotal (denormalizacija u zaglavlju se poklapa).
 */
function groupTaxSubtotals(
  items: UblInvoiceItemInput[],
  isExport: boolean,
): TaxGroup[] {
  const byPercent = new Map<number, TaxGroup>();
  for (const it of items) {
    const percent = isExport ? 0 : vatPercentOf(it.vatRateCode);
    const existing = byPercent.get(percent);
    const group: TaxGroup = existing ?? {
      percent,
      category: taxCategoryOf(percent, isExport),
      taxableAmount: new D(0),
      taxAmount: new D(0),
    };
    group.taxableAmount = group.taxableAmount.add(it.vatBase);
    group.taxAmount = group.taxAmount.add(isExport ? new D(0) : it.vatAmount);
    byPercent.set(percent, group);
  }
  return [...byPercent.values()].sort((a, b) => b.percent - a.percent);
}

/** cac:TaxScheme sa ID=VAT (jedina PDV shema u SEF-u). */
function taxScheme(): string {
  return "<cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>";
}

/** Prost element sa escaped tekstom. */
function el(tag: string, value: string): string {
  return `<${tag}>${escapeXml(value)}</${tag}>`;
}

/** Odsecanje na 0 — PayableAmount nikad negativan (avans > iznosa računa). */
function maxZero(value: Prisma.Decimal): Prisma.Decimal {
  return value.greaterThan(0) ? value : new D(0);
}

/** Novčani element sa currencyID atributom. Decimal → 2 decimale (RSD/EUR). */
function amountEl(tag: string, value: Prisma.Decimal, cur: string): string {
  return `<${tag} currencyID="${cur}">${value.toFixed(2)}</${tag}>`;
}

/** Datum u UBL formatu YYYY-MM-DD (UTC). */
function fmtDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Količina — do 6 decimala bez trailing nula (UBL dozvoljava). */
function fmtQty(v: Prisma.Decimal): string {
  return v.toDecimalPlaces(6).toString();
}

/**
 * Broj dokumenta → bezbedno ime fajla. Broj po odluci O-F1 sadrži kosu crtu
 * (`657/25`), a ime priloga ne sme da izgleda kao putanja.
 */
function safeFileName(documentNumber: string): string {
  return documentNumber.replace(/[\\/:*?"<>|]+/g, "-");
}

/** XML escape za tekstualne čvorove i atribute. */
function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
