import { BadRequestException, Injectable } from "@nestjs/common";
import {
  KEP_VALUATION_LABEL,
  type KepValuation,
} from "../../../common/switches/kep-valuation";
import { Prisma } from "@prisma/client";
import type {
  Content,
  CustomTableLayout,
  TableCell,
  TDocumentDefinitions,
} from "pdfmake/interfaces";
import { PrismaService } from "../../../prisma/prisma.service";
import { PdfService } from "../../documents/pdf.service";
import { SERVOTEH_LOGO_DATA_URL } from "../../documents/servoteh-logo";
import {
  BASE_STYLES,
  DEFAULT_STYLE,
  PAGE_PORTRAIT,
  TABLE_LAYOUT,
  buildFormHeader,
  buildPageFooter,
  buildSignatureRow,
  fmtDate,
  fmtMoney,
  fmtMoneyOrBlank,
  loadIssuer,
  loadPrintedBy,
  safeFileName,
  sanitizeText,
  type IssuerInfo,
} from "../../documents/doc-layout";
import { KepuService, type KepuBookRow } from "../kepu.service";

/**
 * KNJIGA EVIDENCIJE PROMETA (KEP / BigBit „Knjiga KEPU") — ZAKONSKI OBRAZAC.
 * =========================================================================
 * Motor je već postojao (`KepuService.book` daje rbr po godini, stranu knjige i
 * kumulativni saldo; puni je robni tok kroz `robno/kepu-book.util.ts`) — falila
 * je isključivo štampa. Ovo je ta štampa.
 *
 * ŠTA JE OVDE TEŠKO I ZAŠTO JE URAĐENO RUČNO:
 * knjiga se po BigBitu vodi u stranicama od FIKSNIH 45 REDOVA, sa „DONOS:" na
 * vrhu i „ZA PRENOS:" na dnu svake strane (prenos zbirova sa strane na stranu).
 * pdfmake nema per-page carry — zato se prelom NE prepušta rendereru: redovi se
 * sami grupišu po broju strane knjige (`strana` = ((rbr−1) div 45) + 1, ista
 * formula koju `KepuService` već koristi), pa se svaka strana renderuje kao
 * ZASEBNA tabela sa `pageBreak: "before"`. Tako je strana papira = strana knjige,
 * a DONOS/ZA PRENOS su tačni i kad se štampa jedan mesec iz sredine godine.
 *
 * DONOS je zbir zaduženja/razduženja SVIH redova godine PRE prvog reda te strane
 * — dakle i onih koji se u izabranom mesecu ne štampaju. Zato se uvek učitava
 * cela godina pa se filtrira u memoriji; drugačije bi donos bio lažno nula.
 *
 * ZA PRENOS SE RAČUNA ISTO TAKO — IZ KUMULATIVE GODINE, NE IZ ODŠTAMPANIH REDOVA
 * (ispravka 27.07.2026, nalaz „ZA PRENOS ≠ DONOS sledeće strane"). Ranije je bio
 * `donos + Σ odštampanih redova te strane`, pa je pri štampi jednog meseca — kada
 * prva strana knjige skoro nikad nije odštampana cela — ZA PRENOS ispuštao redove
 * prethodnog meseca koje DONOS sledeće strane uredno sadrži. Papir je sam sebi
 * protivrečio na dve uzastopne strane zakonske knjige. Sada je ZA PRENOS strane N
 * po definiciji jednak DONOS-u strane N+1 (`carryBefore` prvog rbr sledeće strane).
 * Kad strana nije odštampana cela, to PIŠE na papiru — inače broj redova na listu
 * i razlika zbirova ne bi imali objašnjenje.
 *
 * ZAKONSKI OBLIK (Pravilnik o evidenciji prometa, „Sl. glasnik RS" 99/2015):
 *   • čl. 3 — knjiga se vodi POSEBNO za svako prodajno/veleprodajno mesto. Zato je
 *     obrazac KEP vezan za JEDAN magacin; bez izabranog magacina štampa je INTERNI
 *     PREGLED (drugi naslov, bez oznake obrasca i bez potpisnog mesta), a ne knjiga.
 *     To ujedno rešava i nestabilan redni broj: `ROW_NUMBER` se u `KepuService.book`
 *     računa POSLE filtera magacina, pa je numeracija ispravna baš za knjigu jednog
 *     magacina — a besmislena za izmešan pregled svih.
 *   • čl. 15 — obrazac ima PET kolona (1 rbr, 2 datum evidentiranja, 3 opis promene
 *     sa nazivom/brojem/datumom isprave, 4 zaduženje, 5 razduženje). BigBit-ova šesta
 *     kolona „Iznos uplate na račun" je pred-2015 oblik, kod nas nema izvor i uvek je
 *     bila prazna — IZBAČENA je, jer papir koji se zove „Obrazac KEP" mora imati
 *     raspored kolona iz važećeg propisa. To je jedino mesto u ovom talasu gde je
 *     BigBit paritet svesno odbijen u korist propisa.
 *
 * POŠTENJE (ono što ova štampa NE tvrdi):
 *   • „Odgovorno lice" nema izvor — prazno potpisno mesto;
 *   • kolona 3 nema poslovno ime dobavljača (čl. 15 ga traži pri nabavci) — punjenje
 *     knjige (`robno/kepu-book.util.ts`) danas upisuje samo vrstu i broj dokumenta;
 *     to je ispisano u nozi kao poznat nedostatak, ne prećutano;
 *   • vrednovanje reda je MALOPRODAJNO (MP), jer takvo punjenje danas radi
 *     `kepu-book.util.ts`; to je izričito ispisano u nozi obrasca da knjigovođa
 *     odmah vidi po kom principu je knjiga vođena (u BigBitu su to bile DVE
 *     odvojene knjige — KEPU i KEPU_MP — a mi imamo jednu tabelu).
 */

const D = Prisma.Decimal;
const ZERO = new D(0);

/** Broj redova po strani knjige — BigBit: strana = (N div 45) + 1. */
const ROWS_PER_PAGE = 45;

/**
 * Gornja granica reda godine koju štampa učitava odjednom. Knjiga je po prirodi
 * mala (stotine do par hiljada redova); preko ovoga se ne štampa tiho odsečeno
 * nego se traži uži period — odsečena zakonska knjiga je gora od nikakve.
 */
const MAX_YEAR_ROWS = 20_000;

/**
 * Najviše znakova opisa u redu. Opis se NE prelama: red knjige mora ostati
 * jednoredan da bi 45 redova stalo na jednu stranu — inače pdfmake prelije
 * stranu i „ZA PRENOS" ode na sledeću, pa prenos zbirova prestane da važi.
 */
const DESCRIPTION_MAX = 60;

const MONTH_NAMES = [
  "Januar",
  "Februar",
  "Mart",
  "April",
  "Maj",
  "Jun",
  "Jul",
  "Avgust",
  "Septembar",
  "Oktobar",
  "Novembar",
  "Decembar",
];

// Firma obveznik = zajednički `IssuerInfo` iz `documents/doc-layout` (isti skup
// podataka koji nose sve ostale štampe), pa se memorandum knjige ne može raziću
// sa memorandumom fakture ili otpremnice.

/** Jedna strana knjige: redovi + donos (pre strane) i za prenos (posle strane). */
interface BookPage {
  pageNo: number;
  rows: KepuBookRow[];
  /** DONOS — kumulativa godine PRE prvog reda ove strane knjige. */
  carryCharge: Prisma.Decimal;
  carryDischarge: Prisma.Decimal;
  /**
   * ZA PRENOS — kumulativa godine POSLE poslednjeg reda ove strane knjige. Računa se
   * iz kumulative, NE sabiranjem odštampanih redova: strana knjige može da sadrži i
   * redove van izabranog perioda (v. `printedAll`), a ZA PRENOS strane N mora ostati
   * jednak DONOS-u strane N+1.
   */
  carryAfterCharge: Prisma.Decimal;
  carryAfterDischarge: Prisma.Decimal;
  /** `false` = strana knjige ima i redova koji NISU odštampani (van izabranog perioda). */
  printedAll: boolean;
  /** Koliko redova ta strana knjige ima u celoj godini (odštampanih + preskočenih). */
  rowsInBook: number;
}

export interface KepuPrintArgs {
  year: number;
  /** 1..12; izostavljeno = cela godina. */
  month?: number;
  /** Filter magacina (meki ref `warehouses.id`); izostavljeno = svi magacini. */
  warehouseId?: number;
  userId?: number | null;
}

@Injectable()
export class KepuPdfService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pdf: PdfService,
    private readonly kepu: KepuService,
  ) {}

  /** PDF knjige evidencije prometa za period. Vraća `{ buffer, fileName }`. */
  async buildKepuPdf(
    args: KepuPrintArgs,
  ): Promise<{ buffer: Buffer; fileName: string }> {
    const { year, month, warehouseId } = this.assertArgs(args);

    // Cela godina — donos strane se ne može izračunati iz jednog meseca.
    const valuation = await this.kepu.currentValuation();
    const yearRows = await this.kepu.book(year, undefined, warehouseId);
    if (yearRows.length > MAX_YEAR_ROWS) {
      // Savet mora biti IZVRŠIV: provera se radi nad CELOM godinom (donos se bez nje
      // ne može izračunati), pa štampa po mesecima ovde ne pomaže — ranije je poruka
      // tražila baš to i vodila u krug. Izvršivo je suziti knjigu na jedan magacin.
      throw new BadRequestException(
        `Knjiga za ${year}.${warehouseId != null ? ` (magacin ${warehouseId})` : ""} ima ` +
          `${yearRows.length} redova, a štampa učitava celu godinu (bez nje se DONOS ne može ` +
          `izračunati) — granica je ${MAX_YEAR_ROWS}. ` +
          (warehouseId == null
            ? "Izaberi magacin: knjiga se po čl. 3 Pravilnika ionako vodi po prodajnom mestu, pa je po magacinu i kraća."
            : "Javi administratoru — knjiga ovog magacina je prerasla granicu štampe i traži podelu evidencije."),
      );
    }

    const selected = filterByMonth(yearRows, year, month);
    const pages = buildPages(yearRows, selected);

    const [issuer, printedBy, warehouseName] = await Promise.all([
      loadIssuer(this.prisma),
      loadPrintedBy(this.prisma, args.userId ?? null),
      this.loadWarehouseName(warehouseId),
    ]);

    const periodLabel =
      month != null ? `${MONTH_NAMES[month - 1]} ${year}.` : `${year}. godina`;

    // Obrazac KEP je vezan za JEDAN magacin (čl. 3). Bez izabranog magacina se
    // štampa interni pregled — drugi naslov, bez oznake obrasca i bez potpisa.
    const isLegalForm = warehouseId != null;

    const docDefinition = this.buildDoc({
      issuer,
      printedBy,
      warehouseName,
      periodLabel,
      pages,
      valuation,
      totalRows: selected.length,
      isLegalForm,
    });

    const buffer = await this.pdf.render(docDefinition);
    const suffix = month != null ? `-${String(month).padStart(2, "0")}` : "";
    const prefix = isLegalForm ? "KEP-knjiga" : "PREGLED-prometa";
    const wh = isLegalForm ? `-mag${warehouseId}` : "";
    return {
      buffer,
      fileName: safeFileName(`${prefix}-${year}${suffix}${wh}.pdf`),
    };
  }

  // ────────────────────────────────────────────────────────── ulaz / učitavanje

  private assertArgs(args: KepuPrintArgs): {
    year: number;
    month?: number;
    warehouseId?: number;
  } {
    const year = Number(args.year);
    if (!Number.isInteger(year) || year < 2000 || year > 2100) {
      throw new BadRequestException(`Nevalidna godina: ${args.year}.`);
    }
    let month: number | undefined;
    if (args.month != null && String(args.month) !== "") {
      month = Number(args.month);
      if (!Number.isInteger(month) || month < 1 || month > 12) {
        throw new BadRequestException(
          `Nevalidan mesec: ${args.month} (dozvoljeno 1–12 ili prazno za celu godinu).`,
        );
      }
    }
    let warehouseId: number | undefined;
    if (args.warehouseId != null && String(args.warehouseId) !== "") {
      warehouseId = Number(args.warehouseId);
      if (!Number.isInteger(warehouseId) || warehouseId <= 0) {
        throw new BadRequestException(
          `Nevalidan magacin: ${args.warehouseId}.`,
        );
      }
    }
    return { year, month, warehouseId };
  }

  /** Naziv magacina za zaglavlje („Magacin: …"); bez filtera → svi magacini. */
  private async loadWarehouseName(id?: number): Promise<string> {
    if (id == null) return "svi magacini";
    const w = await this.prisma.warehouse.findUnique({
      where: { id },
      select: { name: true },
    });
    return w?.name ?? `Magacin #${id}`;
  }

  // ─────────────────────────────────────────────────────── definicija dokumenta

  private buildDoc(args: {
    issuer: IssuerInfo;
    printedBy: string | null;
    warehouseName: string;
    periodLabel: string;
    pages: BookPage[];
    totalRows: number;
    /** `true` = izabran je jedan magacin → obrazac KEP; `false` = interni pregled. */
    isLegalForm: boolean;
    /** Princip vrednovanja (MP/VP) — ispisuje se u nozi obrasca. */
    valuation: KepValuation;
  }): TDocumentDefinitions {
    const {
      issuer,
      printedBy,
      warehouseName,
      periodLabel,
      pages,
      totalRows,
      isLegalForm,
      valuation,
    } = args;

    const content: Content[] = [
      this.buildHeader(issuer, warehouseName, periodLabel, isLegalForm),
    ];

    // Kratko zaglavlje koje se ponavlja iznad SVAKE strane knjige (odvojen list
    // zakonske knjige mora sam da kaže čiji je) — v. `buildPageTable`.
    const pageBanner =
      `${sanitizeText(issuer.companyName)}` +
      (issuer.taxId ? ` · PIB ${issuer.taxId}` : "") +
      ` · ${sanitizeText(warehouseName)} · ${periodLabel}`;

    if (!pages.length) {
      // Prazna knjiga se NE štampa nemo (BigBit izbaci praznu mrežu sa 0,00).
      content.push({
        margin: [0, 24, 0, 24],
        stack: [
          {
            text: "ZA IZABRANI PERIOD NEMA EVIDENTIRANOG PROMETA",
            style: "emptyBig",
          },
          {
            text:
              "Knjigu puni robni tok (ulaz, izlaz, nivelacija, prenos, višak/manjak). " +
              "Zaglavlje i potpisno mesto su odštampani da obrazac ostane upotrebljiv.",
            style: "note",
            alignment: "center",
            margin: [0, 6, 0, 0],
          },
        ],
      });
    } else {
      pages.forEach((page, idx) => {
        content.push(this.buildPageTable(page, idx > 0, pageBanner));
      });
    }

    content.push(this.buildLegend(totalRows, pages, isLegalForm, valuation));
    // Potpisno mesto „Odgovorno lice" postoji SAMO na zakonskom obrascu. Interni
    // pregled svih magacina se ne potpisuje kao knjiga — to bi ga predstavilo kao
    // obrazac KEP, a po čl. 3 Pravilnika knjiga se vodi po prodajnom mestu.
    if (isLegalForm) {
      content.push(buildSignatureRow(["Odgovorno lice"], true));
    }

    return {
      ...PAGE_PORTRAIT,
      content,
      styles: {
        ...BASE_STYLES,
        // Red knjige je namerno sitan — 45 redova + donos + za prenos mora da
        // stane na jednu stranu, inače prenos zbirova prestaje da važi.
        kepuTh: { fontSize: 7, bold: true, fillColor: "#f0f0f0" },
        kepuThNum: {
          fontSize: 7,
          bold: true,
          fillColor: "#f0f0f0",
          alignment: "right",
        },
        kepuTd: { fontSize: 7 },
        kepuTdNum: { fontSize: 7, alignment: "right" },
        kepuCarry: { fontSize: 7, bold: true, fillColor: "#fafafa" },
        kepuCarryNum: {
          fontSize: 7,
          bold: true,
          alignment: "right",
          fillColor: "#fafafa",
        },
      },
      defaultStyle: DEFAULT_STYLE,
      footer: buildPageFooter(
        (isLegalForm
          ? "Knjiga evidencije prometa (KEP)"
          : "Interni pregled prometa — NIJE obrazac KEP") +
          ` · ${sanitizeText(warehouseName)} · ${periodLabel}`,
        printedBy,
      ),
    };
  }

  /** Zaglavlje obrasca: zajednički memorandum + naziv obrasca, period i magacin. */
  private buildHeader(
    issuer: IssuerInfo,
    warehouseName: string,
    periodLabel: string,
    isLegalForm: boolean,
  ): Content {
    // ZAJEDNIČKO zaglavlje obrasca (`documents/doc-layout`) — isto kao na svim
    // ostalim štampama. Ranije je ova knjiga crtala svoje: isti podaci, druge
    // marže i drugi redosled, pa je korisniku izgledala kao druga aplikacija.
    const out: Content[] = [
      buildFormHeader({
        issuer,
        title: isLegalForm
          ? "KNJIGA EVIDENCIJE PROMETA"
          : "INTERNI PREGLED PROMETA",
        extraLines: [
          `Period: ${periodLabel}`,
          isLegalForm
            ? `Prodajno mesto / magacin: ${warehouseName}`
            : `Magacin: ${warehouseName}`,
        ],
        formCode: isLegalForm ? "Obrazac KEP" : null,
      }),
    ];

    // Objedinjena štampa svih magacina NIJE obrazac KEP i to mora da piše krupno,
    // a ne da se nasluti iz „Magacin: svi magacini" (Pravilnik 99/2015, čl. 3 —
    // knjiga se vodi posebno za svako prodajno mesto). Bez ovoga bi neko potpisao
    // izmešanu knjigu dva objekta kao zakonski obrazac.
    if (!isLegalForm) {
      out.push({
        margin: [0, 0, 0, 10],
        style: "warn",
        text:
          "OBJEDINJENI PREGLED SVIH MAGACINA — NIJE OBRAZAC KEP. Po čl. 3 Pravilnika o " +
          'evidenciji prometa („Sl. glasnik RS" 99/2015) knjiga evidencije vodi se posebno ' +
          "za svako veleprodajno mesto, prodajni objekat i drugo prodajno mesto. Redni " +
          "brojevi, strane knjige i zbirovi na ovom listu obuhvataju više magacina zajedno, " +
          "pa se ovaj papir ne sme predati kao knjiga. Za zakonski obrazac izaberi magacin.",
      });
    }

    return { stack: out };
  }

  /**
   * Jedna strana knjige = jedna strana papira: DONOS (vrh), do 45 redova,
   * ZA PRENOS (dno). `pageBreak: "before"` na svakoj osim prve.
   */
  private buildPageTable(
    page: BookPage,
    breakBefore: boolean,
    pageBanner: string,
  ): Content {
    // PET kolona — Pravilnik 99/2015 čl. 15. (BigBit-ova šesta „Iznos uplate na
    // račun" je pred-2015 oblik, bez izvora kod nas; v. blok na vrhu fajla.)
    const head: TableCell[] = [
      { text: "1\nR.br.", style: "kepuThNum" },
      { text: "2\nDatum\nevidentiranja", style: "kepuTh" },
      {
        text: "3\nOpis promene (naziv, broj i datum dokumenta)",
        style: "kepuTh",
      },
      { text: "4\nZaduženje", style: "kepuThNum" },
      { text: "5\nRazduženje", style: "kepuThNum" },
    ];

    const body: TableCell[][] = [head];

    // DONOS: prenos zbirova sa prethodnih strana knjige (nula na prvoj strani).
    body.push([
      { text: "", style: "kepuCarry" },
      { text: "", style: "kepuCarry" },
      { text: "D O N O S :", style: "kepuCarry" },
      { text: fmtMoney(page.carryCharge), style: "kepuCarryNum" },
      { text: fmtMoney(page.carryDischarge), style: "kepuCarryNum" },
    ]);

    for (const r of page.rows) {
      body.push([
        { text: String(r.rbr), style: "kepuTdNum" },
        { text: fmtDate(r.entryDate), style: "kepuTd", noWrap: true },
        {
          text: truncate(sanitizeText(describeRow(r)), DESCRIPTION_MAX),
          style: "kepuTd",
          noWrap: true,
        },
        { text: fmtMoneyOrBlank(r.charge), style: "kepuTdNum" },
        { text: fmtMoneyOrBlank(r.discharge), style: "kepuTdNum" },
      ]);
    }

    // ZA PRENOS = kumulativa godine na kraju ove strane knjige = DONOS sledeće
    // strane. NIKAD `donos + Σ odštampanih redova` — v. blok na vrhu fajla.
    body.push([
      { text: "", style: "kepuCarry" },
      { text: "", style: "kepuCarry" },
      { text: "Z A   P R E N O S :", style: "kepuCarry" },
      { text: fmtMoney(page.carryAfterCharge), style: "kepuCarryNum" },
      { text: fmtMoney(page.carryAfterDischarge), style: "kepuCarryNum" },
    ]);

    const skipped = page.rowsInBook - page.rows.length;
    const stack: Content[] = [
      // Zaglavlje obveznika se ponavlja na SVAKOJ strani knjige: odvojen list
      // zakonske knjige mora sam za sebe da kaže čija je i koji period pokriva.
      {
        text: pageBanner,
        style: "metaLbl",
        margin: [0, 0, 0, 3],
      },
      {
        text: `Strana knjige: ${page.pageNo}`,
        style: "metaLbl",
        margin: [0, 0, 0, 3],
      },
    ];

    if (!page.printedAll) {
      // Bez ovoga bi razlika (ZA PRENOS − DONOS) bila veća od zbira odštampanih
      // redova, a čitalac ne bi imao objašnjenje odakle razlika.
      stack.push({
        text:
          `Napomena: ova strana knjige ima ${page.rowsInBook} redova, od kojih je ` +
          `${page.rows.length} u izabranom periodu; ostalih ${skipped} pripada drugim ` +
          `mesecima iste godine. DONOS i ZA PRENOS su zbirovi CELE strane knjige, ` +
          `pa se lanac strana ne prekida.`,
        style: "warn",
        margin: [0, 0, 0, 3],
      });
    }

    stack.push({
      table: {
        headerRows: 1,
        dontBreakRows: true,
        widths: [26, 58, "*", 78, 78],
        body,
      },
      // Uži prelom od zajedničkog: 45 redova + DONOS + ZA PRENOS moraju da
      // stanu na jednu stranu, inače prenos zbirova prestaje da važi.
      // (`TableLayout` je unija sa `string`, pa se spread traži kroz cast.)
      layout: {
        ...(TABLE_LAYOUT as CustomTableLayout),
        paddingTop: () => 1.5,
        paddingBottom: () => 1.5,
        paddingLeft: () => 3,
        paddingRight: () => 3,
      },
    });

    return {
      ...(breakBefore ? { pageBreak: "before" as const } : {}),
      stack,
    };
  }

  /** Zbir za period + obavezna objašnjenja (šta obrazac NE tvrdi). */
  private buildLegend(
    totalRows: number,
    pages: BookPage[],
    isLegalForm: boolean,
    valuation: KepValuation,
  ): Content {
    let charge = ZERO;
    let discharge = ZERO;
    for (const p of pages) {
      for (const r of p.rows) {
        charge = charge.add(r.charge);
        discharge = discharge.add(r.discharge);
      }
    }
    const partial = pages.filter((p) => !p.printedAll).length;
    const stack: Content[] = [
      {
        style: "note",
        text:
          `Za period: redova ${totalRows}   ·   strana knjige ${pages.length}   ·   ` +
          `Σ zaduženje ${fmtMoney(charge)}   ·   Σ razduženje ${fmtMoney(discharge)}   ·   ` +
          `saldo ${fmtMoney(charge.sub(discharge))}`,
      },
      {
        style: "note",
        margin: [0, 4, 0, 0],
        text:
          "Strana papira odgovara strani knjige (45 redova po strani). DONOS i ZA PRENOS su " +
          "kumulativa od početka godine, pa je ZA PRENOS jedne strane uvek jednak DONOS-u " +
          "sledeće — i onda kad se štampa jedan mesec iz sredine godine.",
      },
    ];
    if (partial > 0) {
      stack.push({
        style: "note",
        margin: [0, 2, 0, 0],
        text:
          `Strana knjige koja nije odštampana cela: ${partial}. Na takvoj strani zbir ` +
          `odštampanih redova je MANJI od razlike ZA PRENOS − DONOS, jer strana knjige ` +
          `sadrži i redove drugih meseci iste godine (napomena stoji uz svaku takvu stranu).`,
      });
    }
    stack.push({
      style: "note",
      margin: [0, 2, 0, 0],
      text:
        'Obrazac ima pet kolona po čl. 15 Pravilnika o evidenciji prometa („Sl. glasnik RS" ' +
        '99/2015). BigBit-ova šesta kolona „Iznos uplate na račun" je pred-2015 oblik, nema ' +
        "izvor u evidenciji i namerno se ne štampa.",
    });
    stack.push({
      style: "note",
      margin: [0, 2, 0, 0],
      text:
        "Kolona 3 sadrži vrstu, broj i datum isprave. Poslovno ime dobavljača pri nabavci " +
        "(koje čl. 15 takođe traži) evidencija još ne pamti po redu knjige — dopunjuje se " +
        "ručno do dopune punjenja knjige.",
    });
    // Princip vrednovanja se ISPISUJE na obrascu, ne podrazumeva. Knjiga vođena po
    // jednom principu i knjiga vođena po drugom izgledaju isto na papiru — bez ovog
    // reda se ne bi videlo koja je koja, ni pri kontroli ni godinu dana kasnije.
    stack.push({
      style: "note",
      margin: [0, 2, 0, 0],
      text:
        `Vrednovanje reda: ${KEP_VALUATION_LABEL[valuation]} ` +
        `(${valuation}) — princip je podešen u Podešavanjima i primenjen na ceo period. ` +
        `Promena principa menja i ranije odštampane periode, jer se oba vrednovanja ` +
        `čuvaju uz svaki red.`,
    });
    if (!isLegalForm) {
      stack.push({
        style: "warn",
        margin: [0, 4, 0, 0],
        text:
          "Ovaj list je interni pregled više magacina i nema potpisno mesto odgovornog lica — " +
          "zakonska knjiga se štampa po magacinu.",
      });
    }
    return { margin: [0, 10, 0, 0], stack };
  }
}

// ─────────────────────────────────────────────────────────── čiste funkcije

/**
 * Kolona 3 obrasca („opis promene"): vrsta i broj isprave + DATUM isprave.
 *
 * `description` iz `kepu-book.util.ts` već glasi „{vrsta} {broj}", pa se broj NE
 * dodaje drugi put — ranije se dobijalo „0001/2026 — UFROB 0001/2026". Datum
 * isprave (`documentDate`) se dodaje jer ga čl. 15 izričito traži, a `entryDate`
 * je datum evidentiranja i stoji u koloni 2.
 */
export function describeRow(r: KepuBookRow): string {
  const desc = (r.description ?? "").trim();
  const num = (r.documentNumber ?? "").trim();
  // Broj se dopisuje samo ako ga opis već ne sadrži (ne dupliraj ispravu).
  const base = desc
    ? num && !desc.includes(num)
      ? `${desc} ${num}`
      : desc
    : num || "—";
  return r.documentDate ? `${base} od ${fmtDate(r.documentDate)}` : base;
}

/** Skraćenje opisa da red ostane jednoredan (v. `DESCRIPTION_MAX`). */
function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

/**
 * Podskup redova godine koji pada u izabrani mesec. Granice su UTC — iste kao u
 * `KepuService.book`, da se filter u memoriji i SQL filter ne raziđu.
 */
function filterByMonth(
  rows: KepuBookRow[],
  year: number,
  month?: number,
): KepuBookRow[] {
  if (month == null) return rows;
  const from = Date.UTC(year, month - 1, 1);
  const to = Date.UTC(year, month, 1);
  return rows.filter((r) => {
    const t = new Date(r.entryDate).getTime();
    return t >= from && t < to;
  });
}

/**
 * Grupisanje izabranih redova u strane knjige + DONOS i ZA PRENOS po strani.
 *
 * OBA zbira dolaze iz ISTE kumulative godine, po rednom broju reda:
 *   DONOS(strana N)     = Σ svih redova godine sa rbr < prvog rbr strane N
 *   ZA PRENOS(strana N) = Σ svih redova godine sa rbr ≤ poslednjeg rbr strane N
 *                       = DONOS(strana N+1)
 *
 * Zato se ZA PRENOS NIKAD ne računa sabiranjem odštampanih redova: pri štampi jednog
 * meseca strana knjige po pravilu sadrži i redove iz susednih meseci, pa bi zbir
 * odštampanog bio manji od kumulative i lanac strana bi pukao (nalaz 27.07.2026).
 */
function buildPages(
  yearRows: KepuBookRow[],
  selected: KepuBookRow[],
): BookPage[] {
  if (!selected.length) return [];

  // Kumulativni zbirovi po rbr — jedan prolaz kroz godinu.
  const carryBefore = new Map<
    number,
    { c: Prisma.Decimal; d: Prisma.Decimal }
  >();
  const rowsPerBookPage = new Map<number, number>();
  let c = ZERO;
  let d = ZERO;
  for (const r of yearRows) {
    carryBefore.set(r.rbr, { c, d });
    c = c.add(r.charge);
    d = d.add(r.discharge);
    const p = Math.floor((r.rbr - 1) / ROWS_PER_PAGE) + 1;
    rowsPerBookPage.set(p, (rowsPerBookPage.get(p) ?? 0) + 1);
  }
  // Kumulativa CELE godine — ZA PRENOS poslednje strane knjige.
  const yearTotal = { c, d };

  const byPage = new Map<number, KepuBookRow[]>();
  for (const r of selected) {
    const pageNo = Math.floor((r.rbr - 1) / ROWS_PER_PAGE) + 1;
    const list = byPage.get(pageNo);
    if (list) list.push(r);
    else byPage.set(pageNo, [r]);
  }

  return [...byPage.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([pageNo, rows]) => {
      // Donos strane se računa od PRVOG REDA STRANE KNJIGE (rbr strane), ne od
      // prvog odštampanog reda — inače bi delimično odštampana strana imala
      // donos koji ne odgovara knjizi.
      const firstRbrOfPage = (pageNo - 1) * ROWS_PER_PAGE + 1;
      const carry = carryBefore.get(firstRbrOfPage) ??
        carryBefore.get(rows[0].rbr) ?? { c: ZERO, d: ZERO };
      // ZA PRENOS = DONOS sledeće strane knjige. Kad sledeće strane nema (poslednja
      // strana knjige), to je kumulativa cele godine.
      const firstRbrOfNextPage = pageNo * ROWS_PER_PAGE + 1;
      const after = carryBefore.get(firstRbrOfNextPage) ?? yearTotal;
      const rowsInBook = rowsPerBookPage.get(pageNo) ?? rows.length;
      return {
        pageNo,
        rows,
        carryCharge: carry.c,
        carryDischarge: carry.d,
        carryAfterCharge: after.c,
        carryAfterDischarge: after.d,
        printedAll: rows.length === rowsInBook,
        rowsInBook,
      };
    });
}
