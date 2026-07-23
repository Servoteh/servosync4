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
 *       - S  = standardna stopa 20% (domaći promet, S20)  → percent 20
 *       - Z  = izvoz / oslobođeno sa pravom na odbitak     → percent 0, osnov čl.24
 *     Osnov oslobođenja (cbc:TaxExemptionReasonCode) `PDV-RS-24-1-5` za BMTS izvoz.
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

/** UBL InvoiceTypeCode: 380 = komercijalna faktura, 386 = avansna. */
const INVOICE_TYPE_CODE_COMMERCIAL = "380";
const INVOICE_TYPE_CODE_PREPAYMENT = "386";

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

    // PDV kategorija cele fakture: izvoz → Z (0%, oslobođeno čl.24), inače S (20%).
    const taxCategory = invoice.isExport ? "Z" : "S";
    const taxPercent = invoice.isExport ? 0 : 20;

    const typeCode = invoice.isPrepayment
      ? INVOICE_TYPE_CODE_PREPAYMENT
      : INVOICE_TYPE_CODE_COMMERCIAL;

    // Za plaćanje: avansna referenca zatvara obavezu → PayableAmount = 0.
    const payable = invoice.prepaymentReference
      ? new D(0)
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
      parts.push("<cac:AdditionalDocumentReference>");
      parts.push(
        el("cbc:ID", params.pdfFileName ?? `${invoice.documentNumber}.pdf`),
      );
      parts.push("<cac:Attachment>");
      parts.push(
        `<cbc:EmbeddedDocumentBinaryObject mimeCode="application/pdf" filename="${escapeXml(
          params.pdfFileName ?? `${invoice.documentNumber}.pdf`,
        )}">${params.pdfBase64}</cbc:EmbeddedDocumentBinaryObject>`,
      );
      parts.push("</cac:Attachment>");
      parts.push("</cac:AdditionalDocumentReference>");
    }

    // — Strane —
    parts.push(this.buildSupplier(supplier));
    parts.push(this.buildCustomer(customer));

    // — Rekapitulacija poreza (cac:TaxTotal → cac:TaxSubtotal) —
    parts.push("<cac:TaxTotal>");
    parts.push(amountEl("cbc:TaxAmount", invoice.vatTotal, cur));
    parts.push("<cac:TaxSubtotal>");
    parts.push(amountEl("cbc:TaxableAmount", invoice.netTotal, cur));
    parts.push(amountEl("cbc:TaxAmount", invoice.vatTotal, cur));
    parts.push(this.buildTaxCategory(taxCategory, taxPercent, invoice.isExport));
    parts.push("</cac:TaxSubtotal>");
    parts.push("</cac:TaxTotal>");

    // — Zbirni iznosi (cac:LegalMonetaryTotal) —
    parts.push("<cac:LegalMonetaryTotal>");
    parts.push(amountEl("cbc:LineExtensionAmount", invoice.netTotal, cur));
    parts.push(amountEl("cbc:TaxExclusiveAmount", invoice.netTotal, cur));
    parts.push(amountEl("cbc:TaxInclusiveAmount", invoice.grossTotal, cur));
    parts.push(amountEl("cbc:PayableAmount", payable, cur));
    parts.push("</cac:LegalMonetaryTotal>");

    // — Stavke (cac:InvoiceLine) —
    for (const it of items) {
      parts.push(this.buildLine(it, cur, taxCategory, taxPercent, invoice.isExport));
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

  /** cac:TaxCategory sa PDV kategorijom (S/Z) + osnov oslobođenja za izvoz. */
  private buildTaxCategory(
    category: string,
    percent: number,
    isExport: boolean,
  ): string {
    const p: string[] = [];
    p.push("<cac:TaxCategory>");
    p.push(el("cbc:ID", category));
    p.push(el("cbc:Percent", percent.toFixed(2)));
    if (isExport) {
      p.push(el("cbc:TaxExemptionReasonCode", EXPORT_EXEMPTION_CODE));
      p.push(el("cbc:TaxExemptionReason", EXPORT_EXEMPTION_REASON));
    }
    p.push(taxScheme());
    p.push("</cac:TaxCategory>");
    return p.join("");
  }

  private buildLine(
    it: UblInvoiceItemInput,
    cur: string,
    taxCategory: string,
    taxPercent: number,
    isExport: boolean,
  ): string {
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
    if (isExport) {
      p.push(el("cbc:TaxExemptionReasonCode", EXPORT_EXEMPTION_CODE));
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

/** cac:TaxScheme sa ID=VAT (jedina PDV shema u SEF-u). */
function taxScheme(): string {
  return "<cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>";
}

/** Prost element sa escaped tekstom. */
function el(tag: string, value: string): string {
  return `<${tag}>${escapeXml(value)}</${tag}>`;
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

/** XML escape za tekstualne čvorove i atribute. */
function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
