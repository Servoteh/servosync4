import {
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type {
  Column,
  Content,
  TDocumentDefinitions,
} from "pdfmake/interfaces";
import { companyAddressLine } from "../../../common/company-address";
import { PrismaService } from "../../../prisma/prisma.service";
import { loadInvoiceAdvanceDeductions } from "../advance-deduction";
import {
  documentVatBreakdown,
  vatPercentOf,
  vatRecapMismatch,
} from "../vat-totals";
import { paperNoteOf } from "../service-revenue-type";
import { BarcodeService } from "../../documents/barcode.service";
import { buildPageFooter } from "../../documents/doc-layout";
import { PdfService } from "../../documents/pdf.service";
import { SERVOTEH_LOGO_DATA_URL } from "../../documents/servoteh-logo";
import {
  MEMORANDUM_MAP_QR_URL,
  MEMORANDUM_STYLES,
  memorandumFooter,
  memorandumHeader,
} from "./memorandum";
import type {
  InvoiceTemplate,
  InvoiceWithItems,
  PrintAdvanceDeduction,
  PrintCtx,
  PrintCustomer,
  PrintIssuer,
  PrintLine,
  PrintSignatory,
} from "./templates/ctx";
import { domacaRobaTemplate } from "./templates/domaca-roba";
import { domacaUslugaTemplate } from "./templates/domaca-usluga";
import { inoRobaTemplate } from "./templates/ino-roba";
import {
  INO_USLUGA_PAGE_MARGINS,
  inoUslugaPageHeader,
  inoUslugaTemplate,
} from "./templates/ino-usluga";
import {
  assertExportWithoutVat,
  NON_PAYMENT_DOCUMENT_TYPES as SHARED_NON_PAYMENT_DOCUMENT_TYPES,
  printableDeductions,
  vatSummaryMismatch,
  vatSummaryMismatchLabel,
} from "./templates/totals";

/**
 * Štampa izlaznog računa (Invoice + InvoiceItem) u PDF.
 *
 * Ovaj servis više NE crta fakturu — on je samo **spona**: učita sve što obrazac
 * traži (jedno učitavanje, `PrintCtx` iz `templates/ctx.ts`), izabere obrazac po
 * VRSTI DOKUMENTA i obmota ga memorandumom (`memorandum.ts`). Sam izgled papira
 * živi u četiri šablona, po jedan po donetom BigBit izlazu:
 *
 *   IFR, IFGP    → `domacaRobaTemplate`     (traka uslova, Kat. br., četiri potpisa)
 *   IFUSL        → `domacaUslugaTemplate`   (bez Kat. br., Trgovinski sud, jedan potpis)
 *   IZVRO, IZVGP → `inoRobaTemplate`        (engleski, Stat. goods No., blok banke)
 *   IZVUS        → `inoUslugaTemplate`      (engleski, višestran, otpremni blok)
 *
 * ⚠️ ZAŠTO PO VRSTI, A NE PO `isExport`: do sada se obrazac birao isključivo po
 * `invoice.isExport`, pa je faktura za USLUGU izlazila na robnom papiru — sa
 * kolonom „Kat. br." koju usluga nema, sa pogrešnim nadležnim sudom i sa četiri
 * potpisna bloka umesto jednog. `isExport` razlikuje samo domaće od ino prometa;
 * robu od usluge razlikuje jedino vrsta dokumenta.
 *
 * ⚠️ DVA PUTA U ISTOM SERVISU (spajanje 02.08.2026, svesno):
 * ---------------------------------------------------------
 * Ispod četiri obrasca stoji i **zatečeni opšti renderer** (`buildLegacyPdf` i
 * `build*` metode uz njega). On NIJE ostatak koji je zaboravljen da se obriše nego
 * jedini papir koji imaju vrste dokumenata za koje vlasnik NIJE doneo obrazac:
 *
 *   • AVR  — avansni račun (osnov avansa, stanje naplate, ZPDV čl. 16 t. 2)
 *   • KO   — knjižno odobrenje (vrednosni dokument + klauzula o potvrdi primaoca)
 *   • KZ   — knjižno zaduženje (vrednosni dokument)
 *
 * Podela je jednoznačna: **`variant` iz te tri vrednosti → opšti renderer; sve ostalo
 * → obrazac po vrsti dokumenta.** Kad vlasnik donese papir za AVR/KO/KZ, ta vrsta
 * prelazi u `FORM_BY_DOCUMENT_TYPE`, a grana se briše — ne obrnuto.
 *
 * Renderer je zajednički `PdfService` (pdfmake 0.3, Roboto pokriva srpski Latin
 * Extended-A) — bez nove PDF zavisnosti.
 *
 * Iznosi su `Prisma.Decimal` (NIKAD Float); formatiranje radi `format.ts` (obrasci),
 * odnosno `formatDecimal` na dnu ovog fajla (opšti renderer).
 */

/**
 * Varijanta štampe.
 *
 * Prve tri idu kroz **obrazac po vrsti dokumenta**:
 *   • `withPrices`    — pun račun
 *   • `withoutPrices` — otpremnica (bez novčanih kolona)
 *   • `export`        — zadržana SAMO zbog rute `?variant=export` i starih pozivalaca;
 *     ništa više ne prebacuje, jer engleski obrazac dolazi od vrste dokumenta
 *     (IZVRO/IZVGP/IZVUS). Prekidač koji bi domaći račun odštampao na engleskom papiru
 *     (ili obrnuto) nema smisla — to je bilo jedino što je ta vrednost radila.
 *
 * Poslednje tri idu kroz **opšti renderer** (nemaju doneti obrazac):
 *   • `advance`, `creditNote`, `debitNote`
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

/**
 * Varijante koje NEMA nijedan doneti obrazac, pa ih crta zatečeni opšti renderer.
 * Sve ostalo ide kroz `FORM_BY_DOCUMENT_TYPE`.
 */
const LEGACY_RENDERER_VARIANTS: ReadonlySet<InvoicePrintVariant> = new Set<
  InvoicePrintVariant
>(["advance", "creditNote", "debitNote"]);

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

/**
 * Jedan odbijen avans na računu (N:M primena): broj AVR-a + BRUTO iznos te primene.
 * Isti oblik koristi i `PrintCtx` (`templates/ctx.ts`), pa oba puta štampe — i četiri
 * obrasca i opšti renderer — crtaju umanjenja iz istog podatka i po istom pravilu.
 */
type AdvanceDeduction = PrintAdvanceDeduction;

/**
 * Podaci firme izdavaoca za ZATEČENI opšti renderer (AVR/KO/KZ). Namerno je uži od
 * `PrintIssuer` iz `templates/ctx.ts`: memorandum četiri obrasca traži registarski red,
 * APR rečenicu i devizni račun, a opšti renderer sve to nema — pa se ni ne učitava.
 */
interface IssuerInfo {
  companyName: string;
  address: string | null;
  city: string | null;
  /** Poštanski broj sedišta (O-F10) — spaja se sa mestom u adresnom redu. */
  postalCode: string | null;
  taxId: string | null;
  registrationNumber: string | null;
  bankAccount: string | null;
  phone: string | null;
  email: string | null;
  iban?: string | null;
  swift?: string | null;
}

/** Četiri obrasca; imena su nazivi fajlova u `templates/`. */
export type InvoiceForm =
  | "domaca-roba"
  | "domaca-usluga"
  | "ino-roba"
  | "ino-usluga";

const TEMPLATES: Record<InvoiceForm, InvoiceTemplate> = {
  "domaca-roba": domacaRobaTemplate,
  "domaca-usluga": domacaUslugaTemplate,
  "ino-roba": inoRobaTemplate,
  "ino-usluga": inoUslugaTemplate,
};

/**
 * Preslikavanje vrste dokumenta u obrazac — jedino mesto na kom se to odlučuje.
 * Vrste su iz `Invoice.documentType` (`prisma/schema.prisma`), a podela roba/usluga
 * i domaći/ino je iz donetih papira (`docs/zahtevi/fakture-obrasci-2026-08/`).
 */
export const FORM_BY_DOCUMENT_TYPE: Readonly<Record<string, InvoiceForm>> = {
  IFR: "domaca-roba",
  IFGP: "domaca-roba",
  IFUSL: "domaca-usluga",
  IZVRO: "ino-roba",
  IZVGP: "ino-roba",
  IZVUS: "ino-usluga",
};

/**
 * Vrste koje postoje u modelu, ali za njih **nije donet obrazac**: ponuda, predračun,
 * avansni račun i revers. Štampaju se na najbližem obrascu (ino ili domaća roba, po
 * `isExport`) uz UPOZORENJE U LOGU — jer je poznato da papir nije proveren prema
 * originalu, a nije razlog da se štampa predračuna obori.
 *
 * ⚠️ Nepoznata vrsta (van ovog i gornjeg spiska) NE ide na fallback nego BACA: to je
 * podatak koji ne postoji u šifarniku, pa bi tihi izbor obrasca značio da kupcu ode
 * papir za koji niko ne zna da li je tačan.
 *
 * ⚠️ `AVR` je i dalje ovde, ali ga u praksi retko ko vidi: račun vrste AVR bez izričite
 * varijante ide na ZATEČENI avansni obrazac (`advance`), koji bar nosi osnov avansa,
 * stanje naplate i poresku napomenu. Ova stavka pokriva samo slučaj kad neko izričito
 * zatraži `withPrices`/`withoutPrices` nad avansnim računom.
 */
const FORMLESS_DOCUMENT_TYPES: ReadonlySet<string> = new Set([
  "PON",
  "PROF",
  "AVR",
  "REV",
]);

/**
 * Vrste koje NISU dokument po kome se plaća — jedine izuzete od NOVČANIH BRANA na ino
 * obrascu (bankarske instrukcije ovde, PDV na izvozu u `totals.ts`).
 *
 * ⚠️ SPISAK JE JEDAN, U `totals.ts` (ispravka 02.08.2026): dok je stajao samo ovde, važio
 * je za jednu jedinu branu — revers je bio izuzet od brane za IBAN, ali NIJE od
 * `assertExportWithoutVat`, pa je izvozni revers sa prepisanim PDV-om ostajao bez papira.
 *
 * ⚠️ IZMEREN KVAR (treći krug, 02.08.2026) koji je ovo preokrenuo: brana je gledala
 * SPISAK VRSTA (`IZVRO/IZVGP/IZVUS`), pa je predračun u stranoj valuti izlazio bez
 * ijedne bankarske instrukcije. Izmereno: `PROF-12/26`, EUR, `isExport`, bez ijednog
 * reda u `payment_accounts` → PDF se napravi, a blok `Beneficiary Customer:` / IBAN /
 * SWIFT ga uopšte nema. A **predračun u EUR je tačno dokument po kome strani kupac
 * plaća** — po njemu se novac šalje pre isporuke, pa je papir bez računa za uplatu
 * gori nego kod same fakture.
 *
 * Pravi uzrok prvobitnog kvara (IZVRO u dinarima neodštampiv) bila je VALUTA RSD, ne
 * vrsta dokumenta — za RSD `loadForeignAccount` namerno i ne traži devizni račun, pa se
 * brana nije imala čime zadovoljiti. Zato uslov sada gleda ono što je stvarno bitno:
 * ino obrazac + cene + strana valuta. Vrsta odlučuje samo tamo gde je zaista različita:
 *
 *   • `PROF`/`PON` — kupac po njima plaća unapred → instrukcije se TRAŽE;
 *   • `AVR`        — avansni račun je zahtev za uplatu → TRAŽE se;
 *   • `REV`        — revers je zapis o zaduženju/vraćanju opreme, po njemu se ne
 *                    uplaćuje ništa → izuzet (ostati bez papira bi bila čista šteta).
 */
const NON_PAYMENT_DOCUMENT_TYPES = SHARED_NON_PAYMENT_DOCUMENT_TYPES;

/** Domaća valuta — dokument u njoj nema šta da traži od deviznog računa. */
const DOMESTIC_CURRENCY = "RSD";

/** Širina sadržaja A4 strane pri levoj/desnoj margini 32 pt (595 − 32 − 32). */
const CONTENT_WIDTH = 531;

/**
 * Margine strane za tri „obična" obrasca. Gornja (104 pt) prima memorandum-zaglavlje
 * (logo + TÜV znak + linija + dva reda firme ≈ 75 pt), donja (96 pt) partnersku traku,
 * registarski red i APR rečenicu. Ino usluga ima svoje (`INO_USLUGA_PAGE_MARGINS`) —
 * njoj u zaglavlje ide i zaglavlje računa sa zaglavljem tabele.
 */
const PAGE_MARGINS: [number, number, number, number] = [32, 104, 32, 96];

/**
 * Margine SADRŽAJA zaglavlja/podnožja. pdfmake header/footer funkcijama ne primenjuje
 * margine strane — leva i desna MORAJU biti iste kao u `pageMargins`, inače memorandum
 * ne stoji u istoj koloni kao telo.
 */
const HEADER_MARGIN: [number, number, number, number] = [32, 20, 32, 0];
const FOOTER_MARGIN: [number, number, number, number] = [32, 0, 32, 0];

@Injectable()
export class InvoicePdfService {
  private readonly logger = new Logger(InvoicePdfService.name);
  /** QR „google mapa" iz podnožja — konstantan, pravi se jednom po procesu. */
  private qrSvgCache: string | null | undefined;

  constructor(
    private readonly prisma: PrismaService,
    private readonly pdf: PdfService,
    private readonly barcode: BarcodeService,
  ) {}

  /**
   * Generiši PDF fakture. Vraća `{ buffer, fileName }`.
   *
   * SKRETNICA (jedino mesto na kom se bira put):
   *   • `advance` / `creditNote` / `debitNote` → zatečeni opšti renderer, jer za te
   *     dokumente NEMA donetog obrasca (v. uvodni komentar fajla);
   *   • sve ostalo → obrazac po VRSTI DOKUMENTA, a `variant` samo kaže da li se
   *     štampaju cene (`withoutPrices` = otpremnica).
   *
   * Bez izričite varijante, dokument vrste `AVR` sam bira avansni obrazac — inače bi
   * avansni račun izlazio kao obična „FAKTURA", bez osnova avansa i bez napomene da
   * poreska obaveza nastaje naplatom.
   *
   * `printedBy` je trag štampe u nozi. Nose ga SAMO dokumenti opšteg renderera:
   * četiri donetа obrasca imaju podnožje prepisano sa BigBit papira (registarski red,
   * partnerska traka, QR) i dodatni red bi bio odstupanje od originala.
   */
  async buildInvoicePdf(
    invoiceId: number,
    variant?: InvoicePrintVariant,
    printedBy?: string,
  ): Promise<{ buffer: Buffer; fileName: string }> {
    const invoice = await this.prisma.invoice.findUnique({
      where: { id: invoiceId },
      include: {
        items: { orderBy: [{ lineNo: "asc" }, { id: "asc" }] },
        // Vrsta usluge nosi i poreski tretman (zbirni blok) i napomenu (dno obrasca) —
        // v. `templates/ctx.ts`, `InvoiceWithItems`.
        serviceRevenueType: true,
        // Izabran osnov oslobođenja — nosi DOSLOVAN tekst za dno obrasca. Isti red
        // e-faktura koristi za `TaxExemptionReasonCode`, pa se papir i SEF ne mogu
        // raziđi (v. `sales/vat-exemption.ts`, `resolveExemption`).
        vatExemptionBasis: true,
      },
    });
    if (!invoice) throw new NotFoundException(`Račun ${invoiceId} ne postoji.`);

    const effectiveVariant: InvoicePrintVariant =
      variant ??
      (invoice.documentType === ADVANCE_DOCUMENT_TYPE
        ? "advance"
        : "withPrices");
    const safeNumber = invoice.documentNumber.replace(/[\\/:*?"<>|]+/g, "-");
    const prefix = FILE_PREFIX_BY_VARIANT[effectiveVariant] ?? "FAK";

    if (LEGACY_RENDERER_VARIANTS.has(effectiveVariant)) {
      const buffer = await this.buildLegacyPdf(
        invoice,
        effectiveVariant,
        printedBy,
      );
      return { buffer, fileName: `${prefix}-${safeNumber}.pdf` };
    }

    const form = this.resolveForm(invoice);
    const ctx = await this.loadPrintCtx(
      invoice,
      form,
      effectiveVariant === "withoutPrices",
    );

    const buffer = await this.pdf.render(this.buildDocDefinition(ctx, form));
    return { buffer, fileName: `${prefix}-${safeNumber}.pdf` };
  }

  /** Convenience: otpremnica bez cena (2× štampa, §C). */
  async buildDeliveryNotePdf(
    invoiceId: number,
    printedBy?: string,
  ): Promise<{ buffer: Buffer; fileName: string }> {
    return this.buildInvoicePdf(invoiceId, "withoutPrices", printedBy);
  }

  /**
   * Convenience: ino faktura (izvoz).
   *
   * Ostaje zbog pozivalaca (`SalesController` na `?variant=export`), ali više ništa ne
   * prebacuje: engleski obrazac se dobija zato što je dokument IZVRO/IZVGP/IZVUS. Na
   * domaćem računu ovo namerno NE štampa ino papir — takav papir ne bi bio ni tačan
   * ni upotrebljiv.
   */
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

  // ------------------------------------------------------------ izbor obrasca

  /**
   * Obrazac po vrsti dokumenta. Redosled je namerno strog:
   *   1. vrsta ima doneti obrazac → taj obrazac, bez ijedne poruke;
   *   2. vrsta postoji u modelu ali obrazac nije donet → najbliži + `warn` u logu;
   *   3. vrsta uopšte nije poznata → izuzetak.
   */
  private resolveForm(invoice: InvoiceWithItems): InvoiceForm {
    const type = (invoice.documentType ?? "").trim().toUpperCase();
    const exact = FORM_BY_DOCUMENT_TYPE[type];
    if (exact) return exact;

    const nearest: InvoiceForm = invoice.isExport ? "ino-roba" : "domaca-roba";
    if (FORMLESS_DOCUMENT_TYPES.has(type)) {
      this.logger.warn(
        `Vrsta dokumenta „${type}" (račun ${invoice.documentNumber}, id=${invoice.id}) nema doneti ` +
          `obrazac — štampa se na najbližem („${nearest}"). Papir NIJE proveren prema originalu; ` +
          `kad vlasnik donese obrazac, dodaje se u FORM_BY_DOCUMENT_TYPE.`,
      );
      return nearest;
    }

    throw new UnprocessableEntityException(
      `Račun ${invoice.id} ima nepoznatu vrstu dokumenta „${invoice.documentType}" — ` +
        `štampa ne zna koji je to obrazac. Poznate vrste: ` +
        `${[...Object.keys(FORM_BY_DOCUMENT_TYPE), ...FORMLESS_DOCUMENT_TYPES].join(", ")}.`,
    );
  }

  // ------------------------------------------------------------ učitavanje

  /**
   * Jedno učitavanje za sva četiri obrasca (ugovor iz `templates/ctx.ts`: šablon ne sme
   * sam da čita bazu). Sve reference su MEKE — bez `@relation` JOIN-a, jer legacy zapisi
   * umeju da pokazuju na obrisane redove, a račun mora da se odštampa i tada.
   */
  private async loadPrintCtx(
    invoice: InvoiceWithItems,
    form: InvoiceForm,
    withoutPrices: boolean,
  ): Promise<PrintCtx> {
    const foreign = form === "ino-roba" || form === "ino-usluga";
    const currency = invoice.currency || DOMESTIC_CURRENCY;
    const currencyCode = currency.trim().toUpperCase();
    const documentType = (invoice.documentType ?? "").trim().toUpperCase();

    /**
     * ═══ KO SME DA BUDE ZAUSTAVLJEN ZBOG PRAZNOG IBAN-a ═══════════════════════════
     *
     * Brana traži bankarske instrukcije tamo gde one ZAISTA trebaju: PAPIR SA CENAMA,
     * NA INO OBRASCU, U STRANOJ VALUTI — dakle dokument po kome strani kupac uplaćuje
     * novac. Vrsta dokumenta iz uslova ISPADA (osim `REV`, v. `NON_PAYMENT_DOCUMENT_TYPES`):
     * merodavna je valuta, jer se za RSD devizni račun namerno i ne traži.
     *
     * ⚠️ DVA IZMERENA KVARA, oba u ovom uslovu:
     *
     *  1. (02.08.2026) uslov je bio „ino obrazac + sa cenama", pa je IZVRO u DINARIMA
     *     bio NEODŠTAMPIV. `loadForeignAccount` za RSD preskače i drugi krug i rezervu
     *     sa firme (dinarskom dokumentu se ne sme podmetnuti devizni IBAN), ali je
     *     `assertBankDetails` ipak pucao — sa porukom „unesi IBAN u Podešavanja → Firma
     *     → Devizni računi", koju operater NE MOŽE da posluša: i uredno upisan IBAN se
     *     za RSD ne čita. Do tog stanja se dolazi bez ijedne greške u radu — domaći
     *     predračun (RSD) → `from-proforma` → IZVRO, gde carry-over postavi `isExport`,
     *     a valutu ostavi dinarsku.
     *
     *  2. (treći krug, isti dan) ispravka pod 1. je uslov suzila na SPISAK VRSTA, pa su
     *     `PROF`/`PON` sa `isExport` počeli da zaobilaze branu kroz `resolveForm`
     *     fallback. Izmereno: `PROF-12/26`, EUR, bez ijednog reda u `payment_accounts`
     *     → predračun izlazi bez bloka banke, a to je BAŠ dokument po kome strani kupac
     *     plaća unapred. Vraćeno na valutu kao merilo.
     */
    const requireBankDetails =
      foreign &&
      !withoutPrices &&
      currencyCode !== DOMESTIC_CURRENCY &&
      !NON_PAYMENT_DOCUMENT_TYPES.has(documentType);

    /**
     * REDOSLED BRANA: PDV na izvozu je TAČNIJI uzrok od praznog IBAN-a.
     *
     * `loadPrintCtx` se izvršava pre šablona, pa bi izuzetak iz `loadIssuer` progutao
     * poruku `assertExportWithoutVat` — operater bi dobio uputstvo za unos IBAN-a nad
     * dokumentom čiji je pravi problem obračunat PDV na izvoznoj fakturi (prepis domaćeg
     * predračuna). Zato ista brana ide i ovde, pre učitavanja: poruka imenuje uzrok koji
     * se stvarno mora ispraviti. Šabloni je i dalje zovu — ovo im nije zamena nego red.
     */
    if (foreign && !withoutPrices) assertExportWithoutVat(invoice);

    /**
     * Izvozni dokument u domaćoj valuti je sam po sebi sumnjivo stanje: papir izlazi na
     * engleskom obrascu sa dinarskim iznosima. UPOZORENJE, a ne izuzetak — dokument mora
     * da se odštampa (v. gore), a jedina prava blokada na izvozu ostaje obračunat PDV.
     */
    if (foreign && currencyCode === DOMESTIC_CURRENCY)
      this.logger.warn(
        `Dokument ${invoice.documentNumber} (id=${invoice.id}, vrsta „${documentType}") je ` +
          `IZVOZNI, a valuta mu je domaća (${currencyCode}) — štampa se ino obrazac sa ` +
          `dinarskim iznosima i bez bankarskih instrukcija (za RSD se devizni račun ne ` +
          `traži). Najčešći uzrok je prepis domaćeg predračuna u izvozni račun, koji vrstu ` +
          `dokumenta promeni a valutu ostavi. Proveri valutu i kurs pre slanja kupcu.`,
      );

    const [
      customer,
      issuer,
      items,
      signatory,
      warehouseName,
      advanceDeductions,
    ] = await Promise.all([
      this.loadCustomer(invoice.customerId),
      // Otpremnica (`withoutPrices`) na sebi nema nijedan iznos, pa ni podatke za uplatu
      // ne očekuje — blokirati njeno štampanje zbog praznog IBAN-a bilo bi zaustavljanje
      // isporuke robe zbog polja u podešavanjima.
      this.loadIssuer(invoice.companyId, currency, requireBankDetails),
      this.loadItems(
        invoice.items.map((i) => i.itemId),
        foreign,
      ),
      this.loadSignatory(invoice.salespersonId),
      // Magacin nosi SAMO domaća robna faktura („Robu izdao → iz magacina …") — to je
      // i jedina razlika IFR od IFGP. Ostali obrasci ga nemaju, pa se ni ne traži.
      form === "domaca-roba"
        ? this.loadWarehouseName(invoice)
        : Promise.resolve(null),
      // ISTI izvor koji koristi i opšti renderer (AVR/KO/KZ) i ekran detalja računa:
      // jedan unos PO PRIMENI avansa, umesto broja prvog avansa uz zbir svih.
      this.loadAdvanceDeductions(invoice),
    ]);

    const lines: PrintLine[] = invoice.items.map((item, index) => {
      const master =
        item.itemId != null && item.itemId > 0
          ? items.get(item.itemId)
          : undefined;
      return {
        ordinal: index + 1,
        catalogNumber: master?.catalogNumber ?? null,
        name: master?.name ?? item.description ?? "",
        // Pravilo iz ugovora: stavka ima prednost nad šifarnikom — slobodna uslužna
        // stavka (itemId = null) j.m. nema odakle drugde da dobije.
        unit: item.unit?.trim() || master?.unit || null,
        customsTariff: master?.customsTariff ?? null,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        // Cena PRE rabata. U bazi stoji na nivou PRE koeficijenta dokumenta (isto kao
        // `baseUnitPrice`), a `unitPrice` je već pomnožen koeficijentom — zato se i ovde
        // množi, da bi obe cene bile uporedive i da bi `bruto − rabat` dalo baš osnovicu.
        // Bez koeficijenta (podrazumevano 1) množenje ništa ne menja.
        unitPriceBeforeDiscount:
          item.unitPriceBeforeDiscount != null
            ? item.unitPriceBeforeDiscount.mul(invoice.priceCoefficient ?? 1)
            : null,
        discountPercent: item.discountPercent,
        // ⚠️ NIJE `item.lineTotal`. U bazi je `lineTotal` = osnovica + PDV
        // (`pricing.service.ts:141`), a kolona „VREDNOST"/„I Z N O S"/`Total` na svih
        // pet papira nosi vrednost BEZ PDV-a: zbir tih kolona mora da da „Vrednost bez
        // PDV (osnovica)" iz zbirnog bloka. Zato ide `vatBase`.
        lineTotal: item.vatBase,
        // Ino promet nema PDV kolonu — stopa se ne prosleđuje da je neki budući ino
        // obrazac ne bi slučajno odštampao (ugovor `ctx.ts`: `null` = ino).
        //
        // ⚠️ IZVOR STOPE = `VAT_RATE_BY_CODE` (nalaz S2, ispravka 02.08.2026). Do tada se
        // čitala kolona `tax_rates.base_rate` IZ BAZE, dok je IZNOS poreza računat iz mape
        // u kodu — dva šifarnika za isti broj u istom redu papira. Tabela `tax_rates`
        // NEMA SEED ni u jednoj migraciji, pa je na praznoj bazi (a produkcija je takva
        // — 0 redova) `vatRates.get()` vraćao `undefined` i domaći obrazac je štampao
        // **„PDV po stopi 0% X 500,05 = 100,01"**: stopa nula, a porez obračunat po 20 %.
        // Pitanje seed-a je zapisano u `backend/docs/PREOSTALE_FAZE.md`.
        vatRatePercent: foreign
          ? null
          : vatPercentOf(item.vatRateCode).toNumber(),
      };
    });

    return {
      invoice,
      lines,
      customer,
      issuer,
      signatory,
      warehouseName,
      currency,
      advanceDeductions,
      // Napomena sa izabrane vrste usluge. `paperNoteOf` sama proverava da je dokument
      // uslužan i da napomena nije prazna — obrazac dobija ili tekst ili `null`, nikad
      // prazan red na poreskom dokumentu.
      serviceRevenueNote: paperNoteOf(invoice),
      // Izabran osnov oslobođenja (ceo red, ne gotov tekst) — v. `PrintCtx`.
      vatExemptionBasis: invoice.vatExemptionBasis ?? null,
      withoutPrices,
    };
  }

  /** Kupac (meki ref `customers.id`); bez kupca obrazac štampa crticu, ne puca. */
  private async loadCustomer(
    customerId: number | null,
  ): Promise<PrintCustomer | null> {
    if (customerId == null || customerId <= 0) return null;
    const c = await this.prisma.customer.findUnique({
      where: { id: customerId },
      select: {
        name: true,
        address: true,
        city: true,
        postalCode: true,
        country: true,
        taxId: true,
        registrationNumber: true,
      },
    });
    if (!c) return null;
    return {
      name: c.name,
      address: c.address,
      city: c.city,
      postalCode: c.postalCode,
      country: c.country,
      taxId: c.taxId,
      registrationNumber: c.registrationNumber,
    };
  }

  /**
   * Firma izdavalac iz `companies` + devizni račun iz `payment_accounts`.
   *
   * IBAN/SWIFT/naziv i adresa banke su do sada postojali samo kao TIP u štampi i nikad
   * se nisu punili — blok banke na ino fakturi bio je mrtav kod i nijedna izvozna faktura
   * nije izašla sa bankarskim instrukcijama. Ovde se ta grana oživljava.
   *
   * Kad firma ne postoji (legacy `companyId` bez reda u `companies`), podaci se NE
   * prepisuju u kod: memorandum ostane bez registarskog reda umesto da odštampa nešto
   * što možda više nije tačno. Ispravka je unos firme, ne konstanta ovde.
   *
   * `requireBankDetails` = ovo je papir sa cenama, na ino obrascu i u stranoj valuti, dakle
   * dokument po kom kupac PLAĆA (faktura, predračun, ponuda, avansni račun); bez bankarskih
   * instrukcija takav papir nije upotrebljiv i štampa ga odbija (uslov i obrazloženje:
   * `loadPrintCtx` i `loadForeignAccount`).
   */
  private async loadIssuer(
    companyId: number,
    currency: string,
    requireBankDetails = false,
  ): Promise<PrintIssuer> {
    const [company, account] = await Promise.all([
      this.prisma.company.findUnique({
        where: { id: companyId },
        select: {
          companyName: true,
          address: true,
          city: true,
          postalCode: true,
          taxId: true,
          registrationNumber: true,
          bankAccount: true,
          phone: true,
          fax: true,
          email: true,
          webAddress: true,
          invoiceIssuingPlace: true,
          registryNumber: true,
          businessActivityCode: true,
          aprText: true,
        },
      }),
      this.loadForeignAccount(companyId, currency, requireBankDetails),
    ]);

    return {
      // ⚠️ BEZ REZERVNOG IMENA U KODU (odluka O-F9): naziv firme ima JEDAN izvor —
      // `companies.company_name`. Dok je ovde stajalo `?? "Servoteh d.o.o."`, papir je
      // umeo da nosi ime koje u bazi ne postoji (i koje se, kad se firma preimenuje,
      // ne bi promenilo). Kad firme nema, blokovi naziv preskaču — isto kao svaki
      // drugi nepopunjen podatak, bez praznog reda koji pomera raspored.
      companyName: company?.companyName ?? "",
      address: company?.address ?? null,
      city: company?.city ?? null,
      postalCode: company?.postalCode ?? null,
      taxId: company?.taxId ?? null,
      registrationNumber: company?.registrationNumber ?? null,
      bankAccount: company?.bankAccount ?? null,
      phone: company?.phone ?? null,
      fax: company?.fax ?? null,
      email: company?.email ?? null,
      webAddress: company?.webAddress ?? null,
      invoiceIssuingPlace: company?.invoiceIssuingPlace ?? null,
      registryNumber: company?.registryNumber ?? null,
      businessActivityCode: company?.businessActivityCode ?? null,
      aprText: company?.aprText ?? null,
      iban: account?.iban ?? null,
      // Na papiru uz naziv banke stoji i valuta („Banca Intesa a.d. EUR"), a u bazi su to
      // dve kolone. Spajaju se ovde — jednom, za oba ino obrasca — i to samo kad je račun
      // baš u valuti fakture; inače bi na USD računu pisalo „… EUR" (v. GAP §5 t.8).
      bankName: composeBankName(
        account?.bankName ?? null,
        account?.currency ?? null,
        currency,
      ),
      swift: account?.swift ?? null,
      bankAddress: account?.bankAddress ?? null,
    };
  }

  /**
   * Devizni račun za valutu dokumenta.
   *
   * Prvi izbor je račun kome je `currency` baš valuta fakture I koji nosi IBAN ili SWIFT
   * (samo poklapanje valute nije dovoljno — v. komentar u telu). Kad takvog nema, a
   * faktura NIJE u dinarima, uzima se prvi račun koji uopšte ima IBAN ili SWIFT — inače
   * bi blok banke ostao prazan na svakoj ino fakturi.
   * Domaći račun (RSD) se u tom drugom krugu ne traži: domaći obrasci blok banke nemaju,
   * a odštampan tuđ IBAN je gore od praznog mesta.
   *
   * TREĆI KRUG — `companies.iban/swift` (dopuna 02.08.2026). Ta dva polja se od 27.07.
   * unose u „Podešavanja → Firma → Podaci za plaćanje", ali ih ovaj obrazac nije čitao,
   * pa je administrator mogao uredno da ih upiše i da NIŠTA ne stigne na papir. Uzimaju
   * se tek kad nijedan račun nema bankarske podatke: nose samo IBAN i SWIFT (naziv i
   * adresa banke u `companies` ne postoje), što je minimum po kom uplata može da se
   * izvrši. Puni blok se dobija tek unosom deviznog računa.
   *
   * ⚠️ Više deviznih računa po valuti je otvoreno pitanje (GAP §5 t.8) — do odluke se
   * uzima podrazumevani (`isDefault`), pa po `sortOrder`.
   *
   * ═══ ZAŠTO IZUZETAK, A NE UPOZORENJE ═════════════════════════════════════════════
   * `requireBankDetails` je tačno kad se štampa PAPIR SA CENAMA, NA INO OBRASCU I U
   * STRANOJ VALUTI, a nije revers (uslov se sklapa u `loadPrintCtx` — tamo i piše zašto
   * baš tako, i zašto dinarski izvozni dokument ovde NE SME da bude zaustavljen: za RSD se
   * devizni račun namerno i ne traži, pa se brana ne bi imala čime zadovoljiti). To je
   * papir po kom strani kupac plaća — i izvozna faktura i predračun po kome se uplaćuje
   * unapred. Bez IBAN-a i SWIFT-a šablon ceo blok banke izostavi (`ino-roba.ts` i
   * `ino-usluga.ts` → `bankBlock` vraća `[]`), pa PDF izgleda potpuno ispravno i tiho izađe
   * kupcu koji onda nema gde da uplati. Kvar se otkrije tek kad kupac pozove — a do tada je
   * papir već otišao i ne može se povući.
   *
   * Zato: 422 sa uputstvom gde se podatak unosi. Alternativa (upozorenje u logu ili
   * vodeni žig na papiru) odbačena je jer je log nevidljiv operateru, a žig bi značio da
   * neispravan papir ipak postoji kao fajl koji neko sme da pošalje.
   *
   * Provera je NA ŠTAMPI, ne na knjiženju, i to je namerno: knjiženje je računovodstveni
   * čin (glavna knjiga, saldakonti, SEF) i račun je po zakonu punovažan bez našeg bloka
   * banke — zaustaviti knjiženje zbog praznog polja u podešavanjima značilo bi zaustaviti
   * knjige zbog kozmetike. Papir je jedina tačka na kojoj podatak zaista nedostaje.
   */
  private async loadForeignAccount(
    companyId: number,
    currency: string,
    requireBankDetails = false,
  ): Promise<{
    iban: string | null;
    swift: string | null;
    bankName: string | null;
    bankAddress: string | null;
    currency: string | null;
  } | null> {
    const accounts = await this.prisma.paymentAccount.findMany({
      where: { companyId },
      select: {
        iban: true,
        swift: true,
        bankName: true,
        bankAddress: true,
        currency: true,
        isDefault: true,
        sortOrder: true,
      },
      orderBy: [{ isDefault: "desc" }, { sortOrder: "asc" }, { id: "asc" }],
    });
    const wanted = currency.trim().toUpperCase();
    const hasBankData = (a: {
      iban: string | null;
      swift: string | null;
    }): boolean => Boolean(a.iban?.trim() || a.swift?.trim());
    const inWantedCurrency = (a: { currency: string | null }): boolean =>
      (a.currency ?? "").trim().toUpperCase() === wanted;

    let chosen: {
      iban: string | null;
      swift: string | null;
      bankName: string | null;
      bankAddress: string | null;
      currency: string | null;
    } | null = null;

    /**
     * ⚠️ POKLAPANJE VALUTE NIJE DOVOLJNO — RED MORA I DA NOSI PODATAK (ispravka
     * 02.08.2026). Prvi krug je do tada uzimao PRVI red čija se valuta poklapa i tu stao,
     * pa ako je baš taj bio prazan, drugi krug („bilo koji sa bankarskim podacima") se
     * uopšte nije izvršio. IZMERENO: EUR faktura, red A `currency='EUR'` bez IBAN-a i
     * SWIFT-a (nastaje sam od sebe — dovoljno je uneti valutu i naziv banke, pa snimiti),
     * red B `currency=null` sa punim IBAN-om i SWIFT-om → 422 „za valutu EUR nije unet
     * IBAN ni SWIFT/BIC", iako podatak u bazi POSTOJI i vidi se u Podešavanjima. Operater
     * nema šta da ispravi — podatak je već tu.
     *
     * Redosled: račun u valuti fakture SA podacima → bilo koji sa podacima (samo za
     * stranu valutu; dinarskom dokumentu se devizni IBAN ne sme podmetnuti) → prazan
     * račun u valuti fakture, da naziv i adresa banke ne propadnu ako su jedini uneti.
     */
    const byCurrency = accounts.find(inWantedCurrency);
    const byCurrencyWithData = accounts.find(
      (a) => inWantedCurrency(a) && hasBankData(a),
    );
    if (byCurrencyWithData) chosen = byCurrencyWithData;
    else if (wanted !== "RSD")
      chosen = accounts.find((a) => hasBankData(a)) ?? byCurrency ?? null;
    else chosen = byCurrency ?? null;

    // Rezerva iz `companies` — jedina dva polja koja ta tabela ima. Traži se samo kad
    // izabrani račun nema ništa upotrebljivo, da uredno popunjen devizni račun nikad ne
    // bude potisnut starijim podatkom sa firme.
    if (wanted !== "RSD" && (!chosen || !hasBankData(chosen))) {
      const company = await this.prisma.company.findUnique({
        where: { id: companyId },
        select: { iban: true, swift: true },
      });
      if (company && (company.iban?.trim() || company.swift?.trim()))
        chosen = {
          iban: company.iban,
          swift: company.swift,
          // Naziv i adresa banke se NE izmišljaju: `companies` ih nema, a pogrešna banka
          // uz tačan IBAN je gora od izostavljenog reda.
          bankName: chosen?.bankName ?? null,
          bankAddress: chosen?.bankAddress ?? null,
          currency: chosen?.currency ?? null,
        };
    }

    if (requireBankDetails) this.assertBankDetails(chosen, wanted);
    return chosen;
  }

  /**
   * Brana: papir za inostranstvo po kome se plaća, bez bankarskih instrukcija, se NE štampa.
   *
   * Poruka mora da kaže tri stvari — šta fali, za koju valutu i GDE se unosi — jer je
   * čita komercijalista koji je pritisnuo „Štampaj", a ne onaj ko je pisao kod. Ne kaže
   * „faktura" nego „dokument": ista brana važi i za predračun/ponudu u stranoj valuti,
   * po kojima kupac plaća unapred (v. `NON_PAYMENT_DOCUMENT_TYPES`).
   */
  private assertBankDetails(
    account: {
      iban: string | null;
      swift: string | null;
    } | null,
    currency: string,
  ): void {
    const missing: string[] = [];
    if (!account?.iban?.trim()) missing.push("IBAN");
    if (!account?.swift?.trim()) missing.push("SWIFT/BIC");
    if (!missing.length) return;

    throw new UnprocessableEntityException(
      `Dokument za inostranstvo se ne može odštampati: za valutu ${currency} nije unet ` +
        `${missing.join(" ni ")}. Bez toga kupac u inostranstvu nema na koji račun da ` +
        `plati. Podatak se unosi u Podešavanja → Firma → Devizni računi ` +
        `(IBAN, SWIFT, naziv i adresa banke, valuta).`,
    );
  }

  /**
   * Artikli sa računa: naziv, j.m., kataloški broj i carinska tarifa.
   *
   * Do sada se učitavao i `unit`, pa se ODBACIVAO (kolone „j.m." nije ni bilo), a
   * `catalogNumber` i `customsTariff` se nisu ni tražili — zato su „Kat. br." i
   * „Stat. goods No." na papiru bili prazni. Sada izlaze sva četiri podatka.
   *
   * Za ino obrasce naziv ima `foreignName` (engleski) uz fallback na `name`. Uslužne
   * stavke (`itemId = null`) nose opis sa same stavke, pa ovde ne učestvuju.
   */
  private async loadItems(
    itemIds: (number | null)[],
    foreign: boolean,
  ): Promise<
    Map<
      number,
      {
        name: string;
        unit: string | null;
        catalogNumber: string | null;
        customsTariff: string | null;
      }
    >
  > {
    const ids = [
      ...new Set(itemIds.filter((i): i is number => i != null && i > 0)),
    ];
    const map = new Map<
      number,
      {
        name: string;
        unit: string | null;
        catalogNumber: string | null;
        customsTariff: string | null;
      }
    >();
    if (!ids.length) return map;
    const rows = await this.prisma.item.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        name: true,
        foreignName: true,
        unit: true,
        catalogNumber: true,
        customsTariff: true,
      },
    });
    for (const r of rows) {
      map.set(r.id, {
        name: foreign && r.foreignName?.trim() ? r.foreignName : r.name,
        unit: r.unit?.trim() || null,
        catalogNumber: r.catalogNumber?.trim() || null,
        customsTariff: r.customsTariff?.trim() || null,
      });
    }
    return map;
  }

  /**
   * „Odgovorno lice" u potpisnom bloku = komercijalista SA RAČUNA (odluka O-F2:
   * na robi Dragana Korkut, na usluzi Ana Golubović — ime prati dokument, ne firmu).
   *
   * `Salesperson` legacy drži prezime u `name`, a ime u `firstName` — na papiru stoji
   * „ime prezime", pa se spajaju tim redom. Broj lične karte (`idNumber`) se NE čita:
   * odluka O-F3 ga izbacuje i sa papira i iz štampe.
   */
  private async loadSignatory(
    salespersonId: number | null,
  ): Promise<PrintSignatory | null> {
    if (salespersonId == null || salespersonId <= 0) return null;
    const p = await this.prisma.salesperson.findUnique({
      where: { id: salespersonId },
      select: { name: true, firstName: true },
    });
    if (!p) return null;
    const name = [p.firstName?.trim(), p.name?.trim()]
      .filter((s): s is string => !!s)
      .join(" ");
    return name ? { name } : null;
  }

  /**
   * Naziv magacina za blok „Robu izdao" — jedina razlika IFR („Magacin robe") od
   * IFGP („Gotovi proizvodi").
   *
   * Kad račun nema svoj magacin (zatečeni zapisi ga nemaju — kolona je nova), uzima se
   * podrazumevani magacin te VRSTE dokumenta (`DocumentType.defaultWarehouseId`), baš
   * kako je i predviđeno u šemi. Bez oba — red se ne štampa (bolje ništa nego tuđ magacin).
   */
  private async loadWarehouseName(
    invoice: InvoiceWithItems,
  ): Promise<string | null> {
    let warehouseId = invoice.warehouseId ?? null;
    if (warehouseId == null) {
      const docType = await this.prisma.documentType.findUnique({
        where: { code: invoice.documentType },
        select: { defaultWarehouseId: true },
      });
      const fallback = docType?.defaultWarehouseId ?? 0;
      warehouseId = fallback > 0 ? fallback : null;
    }
    if (warehouseId == null) return null;
    const warehouse = await this.prisma.warehouse.findUnique({
      where: { id: warehouseId },
      select: { name: true },
    });
    return warehouse?.name?.trim() || null;
  }

  // --------------------------------------------------------- dokument (pdfmake)

  /**
   * Šablon + memorandum u jedan `TDocumentDefinitions`.
   *
   * Memorandum ide u pdfmake `header:`/`footer:` FUNKCIJE, ne u `content` — tako se
   * ponavlja na svakoj strani, a telo ne mora ništa da zna o njemu. Zato u telu ni nema
   * logoa: da je ostao i stari `buildHeader`, na strani bi bila DVA logotipa.
   */
  private buildDocDefinition(
    ctx: PrintCtx,
    form: InvoiceForm,
  ): TDocumentDefinitions {
    const issuer = ctx.issuer;
    const qrSvg = this.mapQrSvg();

    // Ino usluga je jedini višestran obrazac: zaglavlje računa i zaglavlje tabele se
    // ponavljaju na SVAKOJ strani (i na poslednjoj, gde je samo blok banke), pa idu u
    // `header:` uz memorandum — a strana nosi „Strana X od Y" dole desno.
    if (form === "ino-usluga") {
      return {
        pageSize: "A4",
        pageMargins: INO_USLUGA_PAGE_MARGINS,
        header: () => ({
          margin: HEADER_MARGIN,
          stack: [
            memorandumHeader(issuer, CONTENT_WIDTH),
            inoUslugaPageHeader(ctx),
          ],
        }),
        footer: (currentPage: number, pageCount: number) => ({
          margin: FOOTER_MARGIN,
          stack: [
            memorandumFooter(
              issuer,
              { qrSvg, pageText: `Strana ${currentPage} od ${pageCount}` },
              CONTENT_WIDTH,
            ),
          ],
        }),
        content: this.withVatMismatchNotice(ctx, inoUslugaTemplate(ctx), true),
        styles: { ...MEMORANDUM_STYLES },
        defaultStyle: { font: "Roboto", fontSize: 9 },
      };
    }

    return {
      pageSize: "A4",
      pageMargins: PAGE_MARGINS,
      header: () => ({
        margin: HEADER_MARGIN,
        stack: [memorandumHeader(issuer, CONTENT_WIDTH)],
      }),
      // Broj strane se NE štampa: nijedan od tri donesena papira ga nema, a kako izgleda
      // domaći račun preko jedne strane je otvoreno pitanje (GAP §5 t.12).
      footer: () => ({
        margin: FOOTER_MARGIN,
        stack: [memorandumFooter(issuer, { qrSvg }, CONTENT_WIDTH)],
      }),
      content: this.withVatMismatchNotice(
        ctx,
        TEMPLATES[form](ctx),
        form === "ino-roba",
      ),
      styles: { ...MEMORANDUM_STYLES },
      defaultStyle: { font: "Roboto", fontSize: 9 },
    };
  }

  /**
   * KONTROLNI RED NA ČETIRI DONESENA OBRASCA — vidi se samo kad se zbirni blok ne slaže
   * sa zaglavljem dokumenta.
   *
   * ⚠️ ZAŠTO OD SEDMOG KRUGA POSTOJI (02.08.2026, nalaz Z1): opšti renderer (AVR/KO/KZ)
   * ima rekapitulaciju sa kontrolnim redom, a četiri obrasca je nemaju — a upravo na
   * njima se štampa REDOVAN račun. Dok su grupe ćutke preuzimale `vat_total`, papir je
   * uvek „zatvarao"; sada se preuzima samo na dokumentu koji porez izvodi iz bruta, pa
   * pogrešan `vat_total` daje Σ PDV redova ≠ `vat_total`. Bez ovog reda bi kupac dobio
   * papir na kom `osnovica + Σ PDV redova` ne daje uokvireno „Za uplatu", a nigde ne
   * piše zašto.
   *
   * ⚠️ NE OBARA ŠTAMPU (za razliku od `assertExportWithoutVat`): tamo papir TVRDI nešto
   * netačno o poreskom tretmanu, ovde su brojevi tačno onakvi kakvi su u bazi — pa je
   * pravi lek da se vidi šta ne valja, a ne da račun ostane bez papira.
   *
   * Ide na KRAJ sadržaja, ispod potpisnog bloka: dodavanje u sam zbirni blok bi značilo
   * četiri kopije istog reda u četiri šablona, a upravo su kopije istog pravila (rabat,
   * avans, raspored razlike) svaki put i proizvele razlaz među obrascima.
   */
  private withVatMismatchNotice(
    ctx: PrintCtx,
    content: Content[],
    english: boolean,
  ): Content[] {
    if (ctx.withoutPrices) return content; // otpremnica nema novčane kolone
    const mismatch = vatSummaryMismatch(ctx);
    if (!mismatch) return content;
    return [
      ...content,
      {
        text: vatSummaryMismatchLabel(mismatch, english),
        fontSize: 8,
        bold: true,
        color: "#a00",
        margin: [0, 8, 0, 0],
      },
    ];
  }

  /**
   * QR kod „google mapa" iz podnožja. Sadržaj je konstanta, pa se pravi jednom.
   * Ako generisanje ikad pukne, podnožje se štampa BEZ koda — ukras ne sme da obori
   * izdavanje računa.
   */
  private mapQrSvg(): string | null {
    if (this.qrSvgCache !== undefined) return this.qrSvgCache;
    try {
      this.qrSvgCache = this.barcode.qrcodeSvg(MEMORANDUM_MAP_QR_URL);
    } catch (e) {
      this.logger.warn(
        `QR kod memoranduma se nije generisao (${(e as Error).message}) — podnožje ide bez njega.`,
      );
      this.qrSvgCache = null;
    }
    return this.qrSvgCache;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ZATEČENI (OPŠTI) RENDERER — avansni račun, knjižno odobrenje i zaduženje.
  // Nasleđen sa `main`-a i NAMERNO zadržan: to su vrste dokumenata za koje NEMA
  // donetog BigBit obrasca, pa ih četiri šablona iznad ne pokrivaju.
  //
  // Metode nose sufiks/prefiks „legacy" tamo gde bi se sudarile sa istoimenima iz
  // gornjeg puta (`loadIssuer`, `buildDocDefinition`). Sudar imena je i bio jedini
  // pravi sukob u spajanju: dva puta rade isti posao nad istim modelom, ali jedan
  // puni `PrintCtx` za doneti obrazac, a drugi crta opšti papir.
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Opšti papir (AVR/KO/KZ): učitaj meke ref-ove i renderuj. Vraća samo `Buffer` —
   * ime fajla pravi `buildInvoicePdf`, isto za oba puta.
   */
  private async buildLegacyPdf(
    invoice: InvoiceWithItems,
    variant: InvoicePrintVariant,
    printedBy?: string,
  ): Promise<Buffer> {
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
      this.loadLegacyIssuer(invoice.companyId),
      this.resolveItemNames(
        invoice.items.map((i) => i.itemId),
        variant === "export",
      ),
    ]);

    // Batch C §C1a: kad je na računu odbijen avans, štampa nosi red „Umanjenje za
    // primljeni avans (br. …)" po SVAKOM odbijenom avansu i završno „Za uplatu".
    const advanceDeductions = await this.loadAdvanceDeductions(invoice);
    // KO/KZ i AVR moraju da pokažu dokument na koji se odnose (BigBit: „Po dokumentu
    // broj …"). Izvor je carry-over trag (`copiedFromDocId`) ili PROF↔IFR veza.
    const referencedDocument = await this.loadReferencedDocument(invoice);

    return this.pdf.render(
      this.buildLegacyDocDefinition({
        invoice,
        customer,
        issuer,
        itemNames,
        variant,
        advanceDeductions,
        referencedDocument,
        printedBy,
      }),
    );
  }

  /**
   * Firma izdavalac iz `companies` (multi-firma numeracija). Ako firma ne postoji
   * (legacy companyId=0 bez reda), naziv ostaje PRAZAN i blokovi ga preskaču — ime se
   * ne prepisuje u kod (odluka O-F9: jedan oblik imena, iz jednog izvora).
   *
   * IBAN/SWIFT: štampa ih je ČITALA i pre nego što su kolone postojale (`IssuerInfo`
   * ih deklariše, ino faktura ih ispisuje) — polja su uvek bila `undefined`, pa je
   * izvozni račun izlazio BEZ podataka za plaćanje. Kolone `companies.iban` i
   * `companies.swift` su dodate 27.07.2026. i unose se u Podešavanja → Podaci firme.
   * Kad nisu popunjene, ino faktura i dalje ne ispisuje ništa — to je i dalje ispravno:
   * bolje bez reda nego red sa izmišljenim brojem.
   *
   * ⚠️ NIJE isto što i `loadIssuer` iznad: tamo se uz firmu učitava i DEVIZNI RAČUN iz
   * `payment_accounts` (blok banke ino obrasca) i memorandumski podaci; ovde ne treba
   * ništa od toga, pa se ni ne dodiruje.
   */
  private async loadLegacyIssuer(companyId: number): Promise<IssuerInfo> {
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
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
        iban: true,
        swift: true,
      },
    });
    if (!company) {
      return {
        companyName: "",
        address: null,
        city: null,
        postalCode: null,
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
      postalCode: company.postalCode,
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
   * Odbijeni avansi ovog računa — po JEDAN unos po AVANSU (N:M od migracije
   * 20260726120000). Ranije se štampao ZBIR svih primena uz broj SAMO PRVOG AVR-a,
   * pa je kupac dobijao poreski dokument sa umanjenjem većim od referenciranog
   * avansnog računa (revizija, VISOK).
   *
   * Od 02.08.2026. ovo hrani OBA puta štampe — i opšti renderer (AVR/KO/KZ) i četiri
   * obrasca kroz `PrintCtx.advanceDeductions`.
   *
   * PRAVILO SE OVDE VIŠE NE PIŠE — jedina tačka istine je `sales/advance-deduction.ts`
   * (`loadInvoiceAdvanceDeductions`): UNIJA aktivnih primena i zatečene 1:1 veze koja
   * nema svoj red u spojnoj tabeli, sa iznosom zatečenog reda `kolona − Σ primena`.
   * Puno obrazloženje (odakle zatečena veza, zašto ne „ili-ili", zašto ne cela kolona)
   * stoji u zaglavlju tog fajla. Ovde ostaje samo prevod u oblik koji šablon traži.
   *
   * Papir ne prikazuje `advanceInvoiceId` ni `fromLegacyLink` — kupca ne zanima kojim
   * je putem veza nastala, nego KOJI avans i KOLIKO.
   */
  private async loadAdvanceDeductions(
    invoice: InvoiceWithItems,
  ): Promise<AdvanceDeduction[]> {
    const { lines } = await loadInvoiceAdvanceDeductions(this.prisma, invoice);
    return lines.map((l) => ({
      documentNumber: l.advanceDocumentNumber,
      amount: l.amount,
    }));
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

  // ------------------------------------------- opšti dokument (pdfmake, AVR/KO/KZ)

  private buildLegacyDocDefinition(args: {
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
      companyAddressLine(issuer.address, issuer.postalCode, issuer.city),
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
        // ⚠️ STOPA IZ POREsKE ŠIFRE, ne iz odnosa iznosa (ispravka 02.08.2026, nalaz R3):
        // isti dokument je u ovoj koloni imao „efektivnu" stopu, a u rekapitulaciji ispod
        // stopu iz šifarnika — na avansu 19,99 % ovde i 20 % dole. Sada oba mesta čitaju
        // `VAT_RATE_BY_CODE`, istu mapu iz koje je porez i obračunat (`PricingService`).
        return [
          { text: String(idx + 1), style: "td" },
          {
            text: fmtPercent(itemVatPercent(invoice, item), english),
            style: "tdNum",
          },
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
   * KO/KZ i avansnog računa). Kontrolni red: Σ osnovica + Σ PDV = bruto dokumenta;
   * razlika se ispisuje crveno.
   *
   * ⚠️ GRUPIŠE JEDINA FUNKCIJA GRUPISANJA (`sales/vat-totals.ts` → `vatBreakdown`),
   * istim ključem (kategorija, stopa) kao zaglavlje i e-faktura (ispravka 02.08.2026,
   * nalaz R3). Ovde je do tada bio TREĆI ključ — efektivna stopa izvedena iz iznosa
   * (`vatAmount / vatBase`) — pa je isti račun umeo da se podeli drugačije nego u XML-u.
   *
   * ⚠️ STOPA DOLAZI IZ POREsKE ŠIFRE, ne iz iznosa (isti nalaz). „Efektivna stopa" je
   * na avansnom računu davala broj koji nije poreska stopa: AVR na 132,03 din nosi
   * osnovicu 110,03 i porez 22,00 (izvedene deljenjem — v. `grossToNet`), pa je
   * `22,00 / 110,03` štampalo **19,99 %** i uz njega porez `round2(110,03 × 19,99 %) =
   * 21,99`; red „Ukupno" je davao 132,02, a „Ukupno za uplatu" ispod 132,03.
   *
   * ⚠️ POREZ JE ONAJ KOJI JE DOKUMENT OBJAVIO (`invoice.vatTotal`), a ne ponovljeno
   * množenje (nalaz R1) — ali SAMO na dokumentu koji porez zaista izvodi deljenjem
   * (avans). Zato ide kroz `documentVatBreakdown`, kome se predaje ceo dokument, pa
   * odluku donosi `vat-totals.ts` po `documentType`. Kod avansa se to dvoje razlikuje za
   * paru na 16,67 % bruto iznosa; papir mora da pokaže ono što je proknjiženo i ono što
   * kupac plaća. Na svakom drugom dokumentu razlika ide u KONTROLNI RED, ne u iznos.
   */
  private buildVatRecap(
    invoice: InvoiceWithItems,
    t: Labels,
    currency: string,
  ): Content {
    // Rastuće po stopi — redosled je izgled ovog bloka (BigBit papir), a ne iznos;
    // `documentVatBreakdown` vraća opadajuće, jer je to redosled koji XML traži.
    const groups = documentVatBreakdown(invoice, invoice.items);
    const rates = groups
      .map((g) => ({ percent: g.ratePercent, base: g.base, vat: g.vat }))
      .sort((a, b) => a.percent.comparedTo(b.percent));
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

    // Kontrola tihe greške: rekapitulacija MORA da se poklopi sa ZAGLAVLJEM dokumenta.
    //
    // ⚠️ PRAG JE PARA, NE „VIŠE OD PARE" (ispravka 02.08.2026, nalaz R1): uslov je bio
    // `diff > 0,01`, pa je razlika od TAČNO 0,01 — jedina koja se u praksi i javljala —
    // prolazila nemo. Izmereno na avansu od 132,03 din: papir je štampao zbir 132,02 uz
    // „Ukupno za uplatu 132,03", bez ijednog upozorenja.
    //
    // 🔴 ⚠️ MERILO JE PROMENJENO (sedmi krug, 02.08.2026, nalaz Z1). Do sada je stajalo
    // `Σosn + Σpdv − grossTotal`, a taj izraz je PO KONSTRUKCIJI NULA kad je zaglavlje
    // interno dosledno (`bruto = neto + porez` — tako ga piše i uvoz i ručna izmena kroz
    // UI). Kontrola dakle nije mogla da vidi pogrešan `vat_total`: papir sa 99 redova @
    // 0 % i jednim redom @ 20 % sa osnovicom 0,05 uz `vat_total = 1,01` štampao je
    // `20 % | 0,05 | 1,01` (efektivna stopa 2020 %) — bez crvenog reda.
    //
    // Sada se mere OBE strane ODVOJENO (`vatRecapMismatch`), jer se u zbiru poništavaju:
    //   • Σ osnovica grupa ≠ `netTotal` → stavke i zaglavlje su se razišle;
    //   • Σ poreza grupa   ≠ `vatTotal` → objavljen porez nije ono što osnovice po stopi
    //     daju, a nije ni preuzet (dokument porez ne izvodi iz bruta, ili razlika nije
    //     prošla brane iz `vat-totals.ts`).
    const diff = vatRecapMismatch(groups, invoice);
    const mismatch: Content[] = diff
      ? [
          {
            text:
              `${t.recapMismatchLbl} ${t.recapBaseLbl} ` +
              `${formatDecimal(diff.baseDiff, 2, false)}, ${t.recapVatLbl} ` +
              `${formatDecimal(diff.vatDiff, 2, false)} ${currency}`,
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
    //
    // ⚠️ PRIMENA NA 0 NE IDE NA PAPIR (ispravka 02.08.2026, isto pravilo kao na četiri
    // donesena obrasca — `printableDeductions` u `totals.ts`). Stornirana pa ponovo
    // upisana primena ostaje u spisku sa iznosom 0,00 i davala je red
    // „Umanjenje za primljeni avans (br. …): − 0,00" — na KNJIŽNOM ODOBRENJU i avansnom
    // računu, dok ga faktura za isti avans nije imala. Kupac takav red čita kao avans koji
    // postoji, a ništa ne umanjuje.
    const deductions = printableDeductions(advanceDeductions);
    const advance = deductions.reduce(
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
      for (const deduction of deductions) {
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
              // Naziv može biti prazan (firma bez reda u `companies`, O-F9) — tada
              // ostaje goli natpis umesto „Za " sa visećim razmakom.
              issuer.companyName.trim()
                ? `${t.signForLbl} ${issuer.companyName.trim()}`
                : t.signForLbl,
            ];
    lines.push(buildSignatureRow(signatureLabels, t, !english));
    return { stack: lines };
  }
}

/**
 * Naziv banke kako stoji na papiru: `Banca Intesa a.d. EUR` = naziv + valuta računa.
 *
 * Valuta se lepi samo kad je devizni račun BAŠ u valuti fakture (tj. kad je izabran po
 * poklapanju valute) i kad je već nema u nazivu — neko je u BigBitu kucao „Banca Intesa
 * a.d. EUR" u samo polje naziva, pa se ne sme udvojiti.
 */
function composeBankName(
  bankName: string | null,
  accountCurrency: string | null,
  invoiceCurrency: string,
): string | null {
  const name = bankName?.trim();
  if (!name) return null;
  const accCur = (accountCurrency ?? "").trim().toUpperCase();
  if (!accCur || accCur !== invoiceCurrency.trim().toUpperCase()) return name;
  return name.toUpperCase().endsWith(accCur) ? name : `${name} ${accCur}`;
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

// `InvoiceWithItems` se NE deklariše ovde iako ga opšti renderer koristi: isti tip
// (`Prisma.InvoiceGetPayload<{ include: { items: true } }>`) živi u `templates/ctx.ts`
// kao deo ugovora sa obrascima i uvezen je na vrhu. Dve identične deklaracije bi se
// razišle prvog dana kad neko doda `include`.

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
  // ⚠️ Natpis imenuje OBE strane (osnovica i PDV) — v. `buildVatRecap`: u zbiru se te
  // dve greške poništavaju, pa jedan broj ne bi rekao ništa.
  recapMismatchLbl:
    "NEUSKLAĐENO — zbir rekapitulacije se razlikuje od zaglavlja dokumenta:",
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
  recapMismatchLbl: "MISMATCH — recapitulation differs from document header:",
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
 * PDV STOPA STAVKE ZA ŠTAMPU — iz poreske šifre (`VAT_RATE_BY_CODE`), izvoz uvek 0 %.
 *
 * ⚠️ ZAMENILA JE „EFEKTIVNU STOPU" `vatAmount / vatBase × 100` (ispravka 02.08.2026).
 * Namera efektivne stope je bila dobra — da odštampana stopa odgovara stvarno
 * obračunatom porezu i kad se šifarnik promeni — ali je bila vezana za POGREŠAN
 * šifarnik: porez obračunava `PricingService` iz mape `VAT_RATE_BY_CODE` (kod), a ne iz
 * tabele `tax_rates` (baza). Ista mapa je i ovde, pa je namera ispunjena bez izvođenja.
 *
 * ŠTA JE IZVOĐENJE LOMILO: ono NIJE bilo stopa nego posledica zaokruživanja. Na avansnom
 * računu (porez izveden deljenjem) `22,00 / 110,03` daje **19,99 %** — broj koji ne
 * postoji ni u jednom poreskom propisu, a uz to je papir grupisao po njemu dok su
 * zaglavlje i e-faktura grupisali po 20 %.
 */
function itemVatPercent(
  invoice: { isExport: boolean },
  item: { vatRateCode: string | null },
): Prisma.Decimal {
  if (invoice.isExport) return new Prisma.Decimal(0);
  return vatPercentOf(item.vatRateCode);
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
