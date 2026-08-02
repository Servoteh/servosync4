import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import {
  vatBreakdown,
  vatCategoryOf,
  vatPercentOf as vatPercentOfCode,
} from "../vat-totals";

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
 *   • DATUM PROMETA → cac:Delivery/cbc:ActualDeliveryDate (BT-72). Obavezan element
 *     računa po Zakonu o PDV; builder ODBIJA da sagradi dokument bez njega (osim
 *     avansnog, 386 — kod avansa prometa još nema). v. guard u `build()`.
 *   • Rabat po stavci → cac:AllowanceCharge (ChargeIndicator=false).
 *   • PDF prilog (base64) → cac:AdditionalDocumentReference → cac:Attachment →
 *     cbc:EmbeddedDocumentBinaryObject.
 *   • PLAĆANJE (grupa D): cac:PaymentMeans nosi način plaćanja (42 = uplata na račun,
 *     BigBit paritet), poziv na broj (cbc:PaymentID = BT-83) i račun za uplatu
 *     (cac:PayeeFinancialAccount → cbc:ID = IBAN ili tekući račun, cbc:Name = naziv
 *     vlasnika, cac:FinancialInstitutionBranch → cbc:ID = SWIFT/BIC).
 *   • ISPORUKA (grupa D): cac:Delivery → cbc:ActualDeliveryDate (BT-72 = datum prometa
 *     dobara i usluga) + cac:DeliveryLocation/cac:Address (mesto isporuke). Blok se
 *     ispisuje SAMO kad su podaci prosleđeni i NIKAD na avansnom računu (BigBit
 *     `F_IF_ImaDelivery`); datum prometa se NE izvodi iz `documentDate` — to bi bila
 *     izmišljena činjenica na poreskom dokumentu.
 *   • JEDINICA MERE (grupa D): `cbc:InvoicedQuantity/@unitCode` se mapira iz `items.unit`
 *     u UN/ECE Rec 20 kod (`unitCodeOf`), a ne šalje se više tvrdo „H87" za svaku stavku.
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
 * Procenat PDV stope za šifru — iz JEDNE mape sistema (`sales/vat-totals.ts` →
 * `gl/posting/vat-rates.ts`). Vrednosti se NE prepisuju ovde: spisak stopa u komentaru je
 * već jednom zastareo (pisalo je „„1" = 20 %, „2" = 10 %, „4" = 8 %", a po stvarnim
 * redovima `R_Tarife` „1" je BEZPDV 0 %, „2" ne postoji, „4" je NIZA 10 %).
 *
 * ⚠️ OVDE JE DO 02.08.2026. STAJAO PREPIS TE MAPE, sa jednom razlikom: nepoznata šifra
 * je davala 20 % umesto 0 %. Dok je `TaxAmount` bio zbir poreza po stavkama, razlika se
 * nije videla (stavka sa nepoznatom šifrom nosi PDV 0, pa je grupa ostajala nula bez
 * obzira na deklarisanu stopu). Od ispravke se `TaxAmount` RAČUNA iz stope, pa bi ista
 * razlika napravila `TaxSubtotal` sa 20 % poreza na promet koji je u zaglavlju računa
 * (i u GK, i u KIF-u) proknjižen bez poreza — dokument koji SEF odbija, a knjigovodstvo
 * ne može da objasni. Sada je mapa jedna: nepoznata šifra svuda znači 0 % (i `PricingService`
 * uz nju upisuje upozorenje na stavku).
 */
function vatPercentOf(code: string | null | undefined): number {
  return vatPercentOfCode(code).toNumber();
}

/**
 * PDV kategorija po stopi: >0% → S (standardna/snižena), 0% → Z (izvoz, uz osnov
 * oslobođenja) odn. E (domaće oslobođenje bez export osnova).
 *
 * ⚠️ SAMO PREVODI STOPU U `Decimal` I ZOVE ZAJEDNIČKU (`sales/vat-totals.ts`): kategorija
 * je pola ključa po kom se grade `cac:TaxSubtotal` grupe, pa bi drugi primerak ovog
 * pravila značio da se linija (`ClassifiedTaxCategory`) i grupa (`TaxCategory`) istog
 * prometa razidu u kategoriji — dokument koji SEF odbija, bez ijedne izmene koda.
 */
function taxCategoryOf(percent: number, isExport: boolean): string {
  return vatCategoryOf(new D(percent), isExport);
}

/**
 * UN/ECE Rec 20 kod za nepoznatu/neunetu jedinicu mere. H87 = „piece" (komad) — u
 * srpskoj praksi (SEF) podrazumevana jedinica. Fallback, NE tiha pretpostavka: svaka
 * ne-prazna jedinica koja se ne prepozna se loguje da bi se šifarnik očistio.
 */
const DEFAULT_UNIT_CODE = "H87";

/**
 * MAPA JEDINICA MERE → UN/ECE Rec 20 (`cbc:InvoicedQuantity/@unitCode`).
 * ---------------------------------------------------------------------
 * Ključevi su NORMALIZOVANI oblici (`normalizeUnit`): mala slova, bez tačke na kraju,
 * bez razmaka, `²`/`³` prevedeni u `2`/`3`, srpski dijakritici svedeni (č/ć→c, š→s…).
 *
 * Spisak je sastavljen iz STVARNIH vrednosti `R_Artikli."Jedinica mere"` u BigBit dumpu
 * (BB_T_26_11-07-26.mdb, ~90k artikala) — pokriva ~99,5% redova. Najčešće: Kom/Kom.
 * (83k), kg (2,9k), m (1,2k), pc (0,6k), m2, set, m3, mm, l, pack, par, h.
 *
 * NAMERNO NEMAPIRANO (ostaje fallback + upozorenje, jer značenje nije utvrđeno):
 *   „c" (~1050 redova), „cet" (~192), „reb"/„rebro", „šar", „čl"/„član", „st", „md",
 *   „MO", „CNP", „KD", „ž", „đ", „Kog" i numeričko smeće („0", „8", „920", „693.5").
 *   To su prljavi unosi legacy šifarnika — pogađati ih značilo bi izmišljati podatak
 *   na poreskom dokumentu. Kad ih knjigovođa/magacin razreši, dodaju se ovde.
 */
const UNIT_CODE_BY_UNIT: Readonly<Record<string, string>> = {
  // — komad (H87 = piece; EA/„each" se namerno svodi na H87 radi doslednosti sa SEF-om) —
  kom: "H87",
  komad: "H87",
  komada: "H87",
  kos: "H87",
  kom1: "H87",
  pc: "H87",
  pcs: "H87",
  psc: "H87",
  piece: "H87",
  pieces: "H87",
  each: "H87",
  ea: "H87",
  qty: "H87",
  un: "H87",
  nr: "H87",
  // — masa —
  kg: "KGM",
  g: "GRM",
  gr: "GRM",
  mg: "MGM",
  t: "TNE",
  tona: "TNE",
  // — dužina —
  m: "MTR",
  m1: "MTR",
  met: "MTR",
  metar: "MTR",
  mm: "MMT",
  cm: "CMT",
  km: "KMT",
  // — površina / zapremina —
  m2: "MTK",
  mm2: "MMK",
  cm2: "CMK",
  m3: "MTQ",
  // — zapremina (tečnost) —
  l: "LTR",
  lit: "LTR",
  litar: "LTR",
  ml: "MLT",
  // — vreme —
  h: "HUR",
  sat: "HUR",
  cas: "HUR",
  min: "MIN",
  d: "DAY",
  dan: "DAY",
  day: "DAY",
  mes: "MON",
  god: "ANN",
  // — set / pakovanje / par —
  set: "SET",
  komp: "SET",
  kompl: "SET",
  komplet: "SET",
  kpl: "SET",
  kmp: "SET",
  gar: "SET",
  garnitura: "SET",
  pak: "XPK",
  pack: "XPK",
  packs: "XPK",
  pakovanje: "XPK",
  pk: "XPK",
  pkt: "XPK",
  par: "PR",
  pair: "PR",
  // — usluga / procenat —
  usl: "E48",
  usluga: "E48",
  "%": "P1",
  procenat: "P1",
};

/**
 * Normalizacija zapisa jedinice pre traženja u mapi: „Kom." · „KOM" · „kom" · „ m2"
 * · „m²" → isti ključ. Dijakritici se svode (č/ć→c, š→s, ž→z, đ→dj) jer legacy
 * šifarnik meša ćirilične/latinične i skraćene oblike.
 */
function normalizeUnit(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/²/g, "2")
    .replace(/³/g, "3")
    .replace(/[čć]/g, "c")
    .replace(/š/g, "s")
    .replace(/ž/g, "z")
    .replace(/đ/g, "dj")
    .replace(/[\s.]+$/g, "")
    .replace(/\s+/g, "");
}

/**
 * `items.unit` → UN/ECE Rec 20 kod za `cbc:InvoicedQuantity/@unitCode`.
 * Vraća `{ code, recognized }`: `recognized=false` znači da je vraćen fallback H87 —
 * pozivalac to loguje jednom po jedinici (da se ne zatrpa log po stavci).
 * Prazna/neuneta jedinica NIJE greška (artikal bez JM) → H87 bez upozorenja.
 */
export function unitCodeOf(unit: string | null | undefined): {
  code: string;
  recognized: boolean;
} {
  if (unit == null) return { code: DEFAULT_UNIT_CODE, recognized: true };
  const key = normalizeUnit(unit);
  if (key.length === 0) return { code: DEFAULT_UNIT_CODE, recognized: true };
  const code = UNIT_CODE_BY_UNIT[key];
  if (code) return { code, recognized: true };
  return { code: DEFAULT_UNIT_CODE, recognized: false };
}

/**
 * UNCL 4461 šifra načina plaćanja = 42 („payment to bank account", uplata na račun).
 * BIGBIT PARITET, ne pretpostavka: `Module__ER_Module.txt` → `UBL_SifraPlacanja()`
 * vraća tvrdo "42" i sa tom šifrom BigBit godinama šalje na SEF. (EN16931 primeri
 * češće koriste 30 = „credit transfer"; obe su važeće UNCL 4461 šifre, ali se ovde
 * drži ono što je u produkciji dokazano prošlo.)
 */
const PAYMENT_MEANS_CODE = "42";

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
  /** Tekući račun za uplatu → cac:PayeeFinancialAccount/cbc:ID (BT-84). */
  bankAccount?: string | null;
  /**
   * IBAN (`companies.iban`) — ima PREDNOST nad `bankAccount` u
   * cac:PayeeFinancialAccount/cbc:ID (BT-84), jer ino kupac plaća po IBAN-u.
   */
  iban?: string | null;
  /** SWIFT/BIC (`companies.swift`) → cac:FinancialInstitutionBranch/cbc:ID (BT-86). */
  swift?: string | null;
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
   * SVE avansne reference (N:M od migracije 20260726120000) — jedan
   * `cac:BillingReference` po odbijenom avansu. Kad se prosledi, ima prednost nad
   * `prepaymentReference`: bez toga bi e-faktura nosila ZBIR svih primena uz broj
   * samo PRVOG avansa, tj. netačnu referencu na poreskom dokumentu (revizija).
   */
  prepaymentReferences?: string[] | null;
  /**
   * Odbijen (već plaćen) avans → cbc:PrepaidAmount; PayableAmount = grossTotal −
   * prepaidAmount. Kad se ne prosledi, važi staro ponašanje: sama referenca
   * avansa znači da avans zatvara CEO iznos (PayableAmount = 0).
   */
  prepaidAmount?: Prisma.Decimal | null;
  /** true = ova faktura je avansna (386). */
  isPrepayment?: boolean;

  // — Grupa D: plaćanje i isporuka —
  /**
   * DATUM PROMETA DOBARA I USLUGA (BT-72) → cac:Delivery/cbc:ActualDeliveryDate.
   * Propisan sadržaj računa (ZPDV čl. 42), kolona `invoices.supply_date`.
   * NIKAD ne izvoditi iz `documentDate`: datum izdavanja i datum prometa se razlikuju
   * i pretpostavka bi bila laž na poreskom dokumentu.
   *
   * ⚠️ JEDNO IME ZA JEDAN PODATAK (spajanje 02.08.2026): grana za štampu je isti
   * podatak nakratko zvala `deliveryDate` (po koloni `invoices.delivery_date`). Ostalo
   * je `supplyDate` — ime je preciznije („datum prometa", ne „datum isporuke") i već je
   * vezano end-to-end. Ne uvoditi drugo polje za isti podatak.
   *
   * Tip je opcion samo zbog avansnog računa (386): kod avansa promet se još nije
   * dogodio. Za sve ostalo `build()` ovo polje ZAHTEVA i baca ako nedostaje.
   */
  supplyDate?: Date | null;
  /** Mesto isporuke (ulica i broj) → cac:Delivery/cac:DeliveryLocation/cac:Address. */
  deliveryStreet?: string | null;
  /** Mesto isporuke (grad) → isto, cbc:CityName. */
  deliveryCity?: string | null;
  /**
   * POZIV NA BROJ (BT-83) → cac:PaymentMeans/cbc:PaymentID. Kad se ne prosledi, koristi
   * se BROJ DOKUMENTA (BigBit paritet — `UBL_ModelPozivNaBroj`). ⚠️ Kolona
   * `invoices.payment_reference` u 4.0 još NE POSTOJI (dodaje je grupa B); čim stigne,
   * prosleđena vrednost preuzima prvenstvo nad brojem dokumenta.
   */
  paymentReference?: string | null;
}

/** Minimalni oblik stavke (podskup InvoiceItem). */
export interface UblInvoiceItemInput {
  lineNo: number;
  description?: string | null;
  itemId?: number | null;
  /**
   * Jedinica mere artikla (`items.unit`) — mapira se u UN/ECE Rec 20 kod
   * (`unitCodeOf`) za `cbc:InvoicedQuantity/@unitCode`. Prazno/nepoznato → H87.
   */
  unit?: string | null;
  quantity: Prisma.Decimal;
  unitPrice: Prisma.Decimal;
  discountPercent: Prisma.Decimal;
  /** Šifra PDV stope (InvoiceItem.vatRateCode) → stopa/kategorija po liniji. */
  vatRateCode: string;
  /** Osnovica stavke → `cbc:LineExtensionAmount` i `TaxableAmount` svoje grupe. */
  vatBase: Prisma.Decimal;
  /**
   * PDV STAVKE — UBL ga NEMA (stavka nosi samo osnovicu, `cac:InvoiceLine` nema element
   * za iznos poreza), pa se od 02.08.2026. u XML ne prenosi ni posredno: `TaxAmount`
   * grupe se računa iz osnovice i stope (BR-CO-17). Polje ostaje u ulazu jer ga pozivalac
   * čita sa stavke zajedno sa ostalim iznosima; ovde je namerno neupotrebljeno.
   */
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
  private readonly logger = new Logger(UblBuilderService.name);
  /**
   * Jedinice mere koje su već prijavljene kao nepoznate — upozorenje ide JEDNOM po
   * zapisu jedinice, a ne po stavci (faktura sa 200 redova iste „c" jedinice bi
   * inače ispisala 200 identičnih redova u logu).
   */
  private readonly warnedUnits = new Set<string>();

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

    // ── DATUM PROMETA: brana, ne tiho izostavljanje ───────────────────────────
    // Da li je BT-72 (ActualDeliveryDate) obavezan po SAMOJ shemi: u ovom repou nema
    // nijednog dokaza da jeste — EN16931 ga u jezgru vodi kao 0..1, a naš CIUS profil
    // (SEF_CUSTOMIZATION_ID) nemamo lokalno u pisanom obliku. 🔴 Tačan status u SEF
    // CIUS-u ostaje za proveru na demo okruženju (FAKTURE_ZAKONSKA_USKLADJENOST.md §7).
    // Zašto ipak PUCA, a ne šalje bez njega: datum prometa je obavezan element RAČUNA po
    // Zakonu o PDV, a kod domaćeg B2B prometa e-faktura na SEF-u JESTE račun (§4.2) —
    // papir je samo kopija. Dokument bez tog podatka je zato manjkav bez obzira na to
    // da li ga XSD propušta, a jednom poslat na SEF se ispravlja samo storniranjem.
    // Glasan 400 pri slanju je jeftiniji od tihog slanja neispravnog računa.
    // IZUZETAK — avansni račun (386): kod avansa promet se JOŠ NIJE dogodio (poreska
    // obaveza nastaje od naplate), pa datum prometa nema šta da nosi. 🔴 Tačan sadržaj
    // avansnog računa je otvoreno pitanje za knjigovođu (§7 t.5).
    if (!invoice.isPrepayment && !invoice.supplyDate) {
      throw new BadRequestException(
        `Račun ${invoice.documentNumber} nema datum prometa — bez njega ne sme na SEF ` +
          `(obavezan element računa po Zakonu o PDV). Unesi datum prometa pa ponovi slanje.`,
      );
    }

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

    // — Avansne reference (cac:BillingReference) — po JEDNA za svaki odbijen avans.
    const prepaymentRefs =
      invoice.prepaymentReferences && invoice.prepaymentReferences.length > 0
        ? invoice.prepaymentReferences
        : invoice.prepaymentReference
          ? [invoice.prepaymentReference]
          : [];
    for (const reference of prepaymentRefs) {
      parts.push("<cac:BillingReference>");
      parts.push("<cac:InvoiceDocumentReference>");
      parts.push(el("cbc:ID", reference));
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

    // — Isporuka i plaćanje (grupa D) —
    // UBL 2.1 redosled u <Invoice>: … AccountingCustomerParty → cac:Delivery →
    // cac:PaymentMeans → cac:PaymentTerms → cac:AllowanceCharge → cac:TaxTotal …
    // Odstupanje od redosleda = shema odbija dokument, pa oba bloka idu OVDE, a ne
    // uz strane ni uz iznose.
    //
    // ⚠️ SPAJANJE 02.08.2026: ovde je nakratko stajao i naš inline `<cac:Delivery>`
    // blok koji je emitovao samo datum prometa. Obrisan je, jer `buildDelivery` radi
    // isto TO plus mesto isporuke (BG-15) i preskakanje bloka na avansnom računu
    // (BigBit `F_IF_ImaDelivery`). Dva bloka bi inače dala dva `<cac:Delivery>`.
    parts.push(this.buildDelivery(invoice));
    parts.push(this.buildPaymentMeans(invoice, supplier));

    // — Rekapitulacija poreza (cac:TaxTotal → cac:TaxSubtotal PO STOPI) —
    // PDV granularnost (A5): grupiši stavke po stvarnoj stopi (20/10/8/0) → po jedan
    // TaxSubtotal. Zbir taxableAmount/taxAmount grupa = invoice.netTotal/vatTotal.
    parts.push("<cac:TaxTotal>");
    parts.push(amountEl("cbc:TaxAmount", invoice.vatTotal, cur));
    const taxGroups = groupTaxSubtotals(items, invoice);
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

  /**
   * cac:Delivery — datum prometa (BT-72) i mesto isporuke (BG-15).
   *
   * BIGBIT PARITET: `Module__ER_Module.txt` → `F_IF_ImaDelivery()` isključuje blok
   * isporuke za AVANS i za knjižno odobrenje/zaduženje. Avansni račun po definiciji
   * nema promet (PDV obaveza nastaje naplatom), pa se blok preskače na AVR-u.
   *
   * Vraća PRAZAN string i kada nema nijednog podatka: prazan <cac:Delivery/> ne nosi
   * informaciju, a izmišljen datum (npr. datum izdavanja) bi bio netačan poreski podatak.
   * Redosled unutar cac:Delivery po UBL 2.1: cbc:ActualDeliveryDate → cac:DeliveryLocation.
   *
   * ⚠️ Tiho izostavljanje datuma prometa VAŽI SAMO za avansni račun: za sve ostale je
   * `build()` odbio dokument pre nego što se stiglo dovde (v. branu u `build`). Račun
   * bez obaveznog elementa ne sme da ode na SEF „bez reda", nego da padne glasno.
   */
  private buildDelivery(inv: UblInvoiceInput): string {
    if (inv.isPrepayment) return "";
    const street = inv.deliveryStreet?.trim() || null;
    const city = inv.deliveryCity?.trim() || null;
    const hasLocation = !!street || !!city;
    if (!inv.supplyDate && !hasLocation) return "";

    const p: string[] = [];
    p.push("<cac:Delivery>");
    if (inv.supplyDate) {
      p.push(el("cbc:ActualDeliveryDate", fmtDate(inv.supplyDate)));
    }
    if (hasLocation) {
      p.push("<cac:DeliveryLocation>");
      p.push("<cac:Address>");
      if (street) p.push(el("cbc:StreetName", street));
      if (city) p.push(el("cbc:CityName", city));
      p.push("<cac:Country>");
      p.push(el("cbc:IdentificationCode", "RS"));
      p.push("</cac:Country>");
      p.push("</cac:Address>");
      p.push("</cac:DeliveryLocation>");
    }
    p.push("</cac:Delivery>");
    return p.join("");
  }

  /**
   * cac:PaymentMeans — kako i na koji račun kupac plaća.
   * Redosled po UBL 2.1: cbc:PaymentMeansCode → cbc:PaymentID → cac:PayeeFinancialAccount
   * (a unutar njega cbc:ID → cbc:Name → cac:FinancialInstitutionBranch).
   *
   * POZIV NA BROJ (BT-83): eksplicitan `paymentReference` kad postoji, inače BROJ
   * DOKUMENTA — to nije pogađanje nego BIGBIT PARITET: `Module__ER_Module.txt` →
   * `UBL_ModelPozivNaBroj(BrojDokumenta)` vraća baš broj dokumenta (varijanta sa
   * prefiksom modela „00 " je u izvoru zakomentarisana). Kad grupa B doda kolonu
   * `invoices.payment_reference`, ona preuzima prvenstvo bez izmene ovog koda.
   *
   * Firma bez računa za uplatu se loguje kao upozorenje (propust u podešavanju firme).
   */
  private buildPaymentMeans(
    inv: UblInvoiceInput,
    supplier: UblSupplierParty,
  ): string {
    // IBAN ima prednost (ino uplata); domaći tekući račun je fallback.
    const account =
      supplier.iban?.replace(/\s+/g, "").trim() ||
      supplier.bankAccount?.trim() ||
      null;
    const reference =
      inv.paymentReference?.trim() || inv.documentNumber.trim() || null;
    if (!account) {
      this.logger.warn(
        `Faktura ${inv.documentNumber}: firma nema ni tekući račun ni IBAN — ` +
          "UBL ide bez računa za uplatu (kupac nema na šta da uplati).",
      );
    }
    if (!account && !reference) return "";

    const p: string[] = [];
    p.push("<cac:PaymentMeans>");
    p.push(el("cbc:PaymentMeansCode", PAYMENT_MEANS_CODE));
    if (reference) p.push(el("cbc:PaymentID", reference));
    if (account) {
      p.push("<cac:PayeeFinancialAccount>");
      p.push(el("cbc:ID", account));
      p.push(el("cbc:Name", supplier.name));
      const swift = supplier.swift?.trim() || null;
      if (swift) {
        p.push("<cac:FinancialInstitutionBranch>");
        p.push(el("cbc:ID", swift));
        p.push("</cac:FinancialInstitutionBranch>");
      }
      p.push("</cac:PayeeFinancialAccount>");
    }
    p.push("</cac:PaymentMeans>");
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
      `<cbc:InvoicedQuantity unitCode="${this.unitCodeFor(it)}">${fmtQty(
        it.quantity,
      )}</cbc:InvoicedQuantity>`,
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

  /**
   * UN/ECE Rec 20 kod jedinice za stavku, uz JEDNOKRATNO upozorenje po nepoznatom
   * zapisu jedinice. Fallback je H87 (komad) — SEF traži važeći kod, pa se stavka ne
   * sme poslati bez njega; ali se u logu ostavlja trag da šifarnik treba očistiti.
   */
  private unitCodeFor(it: UblInvoiceItemInput): string {
    const { code, recognized } = unitCodeOf(it.unit);
    if (!recognized) {
      const raw = (it.unit ?? "").trim();
      if (!this.warnedUnits.has(raw)) {
        this.warnedUnits.add(raw);
        this.logger.warn(
          `Jedinica mere "${raw}" nije u UN/ECE Rec 20 mapi — u UBL ide fallback ` +
            `unitCode="${DEFAULT_UNIT_CODE}" (komad). Dopuniti UNIT_CODE_BY_UNIT ili ` +
            "ispraviti šifarnik artikala.",
        );
      }
    }
    return code;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// XML helperi (čisti — bez stanja)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * cac:TaxSubtotal grupe (A5 granularnost) — PREKO JEDINOG GRUPISANJA U SISTEMU
 * (`sales/vat-totals.ts` → `vatBreakdown`). Ključ je (kategorija, stopa) = BT-118 +
 * BT-119, tačno kako EN 16931 definiše grupu BG-23. Sortirano opadajuće po stopi
 * (20, 10, 8, 0) radi determinističkog XML-a.
 *
 * ⚠️ ZAŠTO VIŠE NEMA SVOG RAČUNA (ispravka 02.08.2026, nalazi R2 i R3): ovde je stajao
 * drugi primerak istog pravila, sa ključem `byPercent`, dok je zaglavlje grupisalo po
 * ŠIFRI. Izmereno na šiframa „1" i „3" (obe su tada bile 20 %): račun sa dve stavke po
 * 100,03 din davao je zaglavlje `vatTotal 40,02` a jedan `TaxSubtotal` sa
 * `TaxAmount 40,01` → **BR-CO-14** (`TaxTotal/TaxAmount = Σ TaxSubtotal/TaxAmount`) pada.
 * (Mapa je istog dana ispravljena po `R_Tarife` — par sa istom stopom sada čine „3" i „6";
 * brojevi su isti, jer ključ je stopa a ne šifra.)
 *
 * ⚠️ `documentVatTotal` = `invoice.vatTotal` (ispravka R1/R2): avansni račun porez IZVODI
 * IZ BRUTA (`grossToNet`), pa `round2(osnovica × stopa)` za 16,67 % bruto iznosa vraća
 * paru više nego što je proknjiženo — izmereno na AVR-u od 132,03 din (osnovica 110,03,
 * porez 22,00, a `110,03 × 20 % = 22,01`). Grupe zato preuzimaju OBJAVLJEN porez
 * dokumenta: BR-CO-14 i BR-CO-15 važe, a neizbežnih 0,01 na BR-CO-17 kod avansa je
 * svojstvo preračunate stope — obrazloženo u uvodu `vat-totals.ts`.
 */
function groupTaxSubtotals(
  items: UblInvoiceItemInput[],
  invoice: { isExport: boolean; vatTotal: Prisma.Decimal },
): TaxGroup[] {
  return vatBreakdown(items, {
    isExport: invoice.isExport,
    documentVatTotal: invoice.vatTotal,
  }).map((g) => ({
    percent: g.ratePercent.toNumber(),
    category: g.category,
    taxableAmount: g.base,
    taxAmount: g.vat,
  }));
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
