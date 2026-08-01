import {
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import type { TDocumentDefinitions } from "pdfmake/interfaces";
import { PrismaService } from "../../../prisma/prisma.service";
import { BarcodeService } from "../../documents/barcode.service";
import { PdfService } from "../../documents/pdf.service";
import {
  MEMORANDUM_MAP_QR_URL,
  MEMORANDUM_STYLES,
  memorandumFooter,
  memorandumHeader,
} from "./memorandum";
import type {
  InvoiceTemplate,
  InvoiceWithItems,
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
 * Renderer je zajednički `PdfService` (pdfmake 0.3, Roboto pokriva srpski Latin
 * Extended-A) — bez nove PDF zavisnosti.
 *
 * Iznosi su `Prisma.Decimal` (NIKAD Float); formatiranje radi `format.ts`.
 */

/**
 * Varijanta štampe. Obrazac se NE bira ovde (bira ga vrsta dokumenta) — varijanta
 * kaže samo da li se štampaju novčane kolone.
 *
 * Stara treća vrednost `"export"` je uklonjena: ino obrazac se sada dobija zato što
 * je dokument IZVRO/IZVGP/IZVUS, a ne zato što je pozivalac tražio „export". Prekidač
 * koji bi domaći račun odštampao na engleskom papiru (ili obrnuto) nema smisla — to je
 * bilo jedino što je ta vrednost radila.
 */
export type InvoicePrintVariant = "withPrices" | "withoutPrices";

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
 */
const FORMLESS_DOCUMENT_TYPES: ReadonlySet<string> = new Set([
  "PON",
  "PROF",
  "AVR",
  "REV",
]);

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
   * Generiši PDF fakture. Obrazac bira vrsta dokumenta; `variant` samo kaže da li se
   * štampaju cene (`withoutPrices` = otpremnica). Vraća `{ buffer, fileName }`.
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

    const form = this.resolveForm(invoice);
    const ctx = await this.loadPrintCtx(
      invoice,
      form,
      variant === "withoutPrices",
    );

    const buffer = await this.pdf.render(this.buildDocDefinition(ctx, form));
    const safeNumber = invoice.documentNumber.replace(/[\\/:*?"<>|]+/g, "-");
    const prefix = ctx.withoutPrices ? "OTP" : "FAK";
    return { buffer, fileName: `${prefix}-${safeNumber}.pdf` };
  }

  /** Convenience: otpremnica bez cena (2× štampa, §C). */
  async buildDeliveryNotePdf(
    invoiceId: number,
  ): Promise<{ buffer: Buffer; fileName: string }> {
    return this.buildInvoicePdf(invoiceId, "withoutPrices");
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
  ): Promise<{ buffer: Buffer; fileName: string }> {
    return this.buildInvoicePdf(invoiceId);
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
    const currency = invoice.currency || "RSD";

    const [
      customer,
      issuer,
      items,
      vatRates,
      signatory,
      warehouseName,
      advanceInvoiceNumber,
    ] = await Promise.all([
      this.loadCustomer(invoice.customerId),
      this.loadIssuer(invoice.companyId, currency),
      this.loadItems(
        invoice.items.map((i) => i.itemId),
        foreign,
      ),
      this.loadVatRates(invoice.items.map((i) => i.vatRateCode)),
      this.loadSignatory(invoice.salespersonId),
      // Magacin nosi SAMO domaća robna faktura („Robu izdao → iz magacina …") — to je
      // i jedina razlika IFR od IFGP. Ostali obrasci ga nemaju, pa se ni ne traži.
      form === "domaca-roba"
        ? this.loadWarehouseName(invoice)
        : Promise.resolve(null),
      this.loadAdvanceInvoiceNumber(invoice),
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
        discountPercent: item.discountPercent,
        // ⚠️ NIJE `item.lineTotal`. U bazi je `lineTotal` = osnovica + PDV
        // (`pricing.service.ts:141`), a kolona „VREDNOST"/„I Z N O S"/`Total` na svih
        // pet papira nosi vrednost BEZ PDV-a: zbir tih kolona mora da da „Vrednost bez
        // PDV (osnovica)" iz zbirnog bloka. Zato ide `vatBase`.
        lineTotal: item.vatBase,
        // Ino promet nema PDV kolonu — stopa se ne prosleđuje da je neki budući ino
        // obrazac ne bi slučajno odštampao (ugovor `ctx.ts`: `null` = ino).
        vatRatePercent: foreign
          ? null
          : (vatRates.get(item.vatRateCode) ?? null),
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
      advanceInvoiceNumber,
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
   */
  private async loadIssuer(
    companyId: number,
    currency: string,
  ): Promise<PrintIssuer> {
    const [company, account] = await Promise.all([
      this.prisma.company.findUnique({
        where: { id: companyId },
        select: {
          companyName: true,
          address: true,
          city: true,
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
      this.loadForeignAccount(companyId, currency),
    ]);

    return {
      companyName: company?.companyName ?? "Servoteh d.o.o.",
      address: company?.address ?? null,
      city: company?.city ?? null,
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
   * Prvi izbor je račun kome je `currency` baš valuta fakture. Kad valuta na računu nije
   * upisana (kolona je nova), a faktura NIJE u dinarima, uzima se prvi račun koji uopšte
   * ima IBAN ili SWIFT — inače bi blok banke ostao prazan na svakoj ino fakturi.
   * Domaći račun (RSD) se u tom drugom krugu ne traži: domaći obrasci blok banke nemaju,
   * a odštampan tuđ IBAN je gore od praznog mesta.
   *
   * ⚠️ Više deviznih računa po valuti je otvoreno pitanje (GAP §5 t.8) — do odluke se
   * uzima podrazumevani (`isDefault`), pa po `sortOrder`.
   */
  private async loadForeignAccount(
    companyId: number,
    currency: string,
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
    const byCurrency = accounts.find(
      (a) => (a.currency ?? "").trim().toUpperCase() === wanted,
    );
    if (byCurrency) return byCurrency;
    if (wanted === "RSD") return null;
    return accounts.find((a) => a.iban?.trim() || a.swift?.trim()) ?? null;
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
   * Šifra poreske stope → procenat (`20`) za kolonu „PDV" i za red
   * „PDV po stopi 20% X … =" u zbiru. Uzima se `baseRate` — dodatne stope
   * (železnička, gradska…) na izlaznoj fakturi ne postoje.
   */
  private async loadVatRates(codes: string[]): Promise<Map<string, number>> {
    const wanted = [...new Set(codes.map((c) => c?.trim()).filter(Boolean))];
    const map = new Map<string, number>();
    if (!wanted.length) return map;
    const rows = await this.prisma.taxRate.findMany({
      where: { code: { in: wanted } },
      select: { code: true, baseRate: true },
    });
    for (const r of rows) map.set(r.code, r.baseRate ?? 0);
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

  /**
   * Broj odbijenog avansnog računa (Batch C §C1a). Meki ref — bez JOIN-a.
   * Doneti obrasci red o avansu nemaju; šablon sam odlučuje hoće li ga štampati.
   */
  private async loadAdvanceInvoiceNumber(
    invoice: InvoiceWithItems,
  ): Promise<string | null> {
    if (
      invoice.advanceInvoiceId == null ||
      !invoice.advanceAppliedAmount.greaterThan(0)
    )
      return null;
    const advance = await this.prisma.invoice.findUnique({
      where: { id: invoice.advanceInvoiceId },
      select: { documentNumber: true },
    });
    return advance?.documentNumber ?? null;
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
        content: inoUslugaTemplate(ctx),
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
      content: TEMPLATES[form](ctx),
      styles: { ...MEMORANDUM_STYLES },
      defaultStyle: { font: "Roboto", fontSize: 9 },
    };
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
