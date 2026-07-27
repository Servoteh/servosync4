/**
 * STATEMENT PDF SERVICE — štampa BILANSA STANJA i BILANSA USPEHA (Faza 7).
 * =========================================================================
 * Do sada je završni račun imao SAMO APR eFI XML (`AprXmlService`) — obračun se
 * nije mogao odštampati, potpisati ni priložiti uz Napomene. Ovaj servis štampa
 * ISTI sačuvani obračun (`FinancialStatement` + `FinancialStatementLine`) iz koga
 * se gradi i XML, pa se dva izlaza ne mogu raziću.
 *
 * OBRAZAC JE PROPISAN — NE IMPROVIZUJE SE. Kolone, redosled i AOP oznake prate
 * Pravilnik o sadržini i formi obrazaca finansijskih izveštaja („Sl. glasnik RS"
 * br. 89/2020), proveren nad PREDATIM obrascima Servoteha za 2023. godinu
 * (_legacy/BigBit26/ZR_validacija/„Биланс стања (6).pdf" i „Биланс успеха (6).pdf"):
 *
 *   BILANS STANJA (7 kolona):
 *     1 Grupa računa, račun | 2 POZICIJA | 3 AOP | 4 Napomena broj |
 *     5 Tekuća godina | 6 Prethodna godina — krajnje stanje |
 *     7 Prethodna godina — početno stanje 01.01.
 *   BILANS USPEHA (6 kolona):
 *     1 Grupa računa, račun | 2 POZICIJA | 3 AOP | 4 Napomena broj |
 *     5 Tekuća godina | 6 Prethodna godina
 *
 * Kolone 5/6/7 se pune iz `amount` / `amount2` / `amount3` — isti raspored koji
 * `AprXmlService` šalje kao Iznos_1/2/3 (BS 3 kolone, BU 2).
 *
 * KOLONA „Grupa računa, račun" nije u modelu (BalanceFormulaDefinition nema je) —
 * IZVODI SE iz same formule pozicije (maske konta iza D/P/PSD/PSP prefiksa). Zbirne
 * pozicije (A-reference) je nemaju ni u zvaničnom obrascu, pa ostaju prazne.
 *
 * ODSTUPANJE OD LEGACY UZORA (svesno): zvanični obrazac je na ĆIRILICI; ova štampa
 * je na SRPSKOJ LATINICI, po pravilu projekta (sav korisnički tekst = latinica) i
 * zato što su i seed-ovani nazivi pozicija latinični. Sadržaj, redosled i AOP oznake
 * su nepromenjeni.
 *
 * JEDINICA: obrazac se predaje U HILJADAMA DINARA, a motor (GKEval nad glavnom
 * knjigom) drži PUNE DINARE. Podrazumevano se štampa u hiljadama (deljenje sa 1.000,
 * HALF_UP) i to je izričito napisano u zaglavlju; `?jedinica=dinari` štampa sirove
 * iznose. NIKAD Float — sve je Prisma.Decimal (BACKEND_RULES §2).
 */

import { Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type { Column, Content, TDocumentDefinitions } from "pdfmake/interfaces";
import { PrismaService } from "../../prisma/prisma.service";
import { PdfService } from "../documents/pdf.service";
import { SERVOTEH_LOGO_DATA_URL } from "../documents/servoteh-logo";
import {
  LOGO_WIDTH,
  buildPageFooter,
  sanitizeText,
} from "../documents/doc-layout";
import { ControlRulesService, type ControlResult } from "./control-rules.service";
import { STATEMENT_TYPE } from "./statement-type";

const D = Prisma.Decimal;

/** Jedinica u kojoj se štampaju iznosi. */
export type StatementPrintUnit = "hiljade" | "dinari";

/** Pravni osnov obrasca — ispisuje se u nozi (kao na predatom obrascu). */
const LEGAL_BASIS =
  "Obrazac propisan Pravilnikom o sadržini i formi obrazaca finansijskih izveštaja " +
  '(„Službeni glasnik RS" br. 89/2020).';

/** Naslov i vremenska odrednica po tipu obrasca. */
interface FormSpec {
  title: string;
  /** true = bilans na dan (BS); false = bilans za period (BU). */
  asOfDate: boolean;
  /** Broj iznosnih kolona (BS 3, BU 2) — isti gating kao APR XML. */
  amountColumns: 2 | 3;
}

const FORM_SPEC: Readonly<Record<string, FormSpec>> = {
  [STATEMENT_TYPE.BALANCE_SHEET]: {
    title: "BILANS STANJA",
    asOfDate: true,
    amountColumns: 3,
  },
  [STATEMENT_TYPE.INCOME_STATEMENT]: {
    title: "BILANS USPEHA",
    asOfDate: false,
    amountColumns: 2,
  },
  [STATEMENT_TYPE.POPDV_ANNUAL]: {
    title: "STATISTIČKI IZVEŠTAJ",
    asOfDate: false,
    amountColumns: 3,
  },
};

/** Identifikacija obveznika (APR zaglavlje) — iz `companies`. */
interface Obveznik {
  naziv: string;
  pib: string | null;
  maticniBroj: string | null;
  sifraDelatnosti: string | null;
  mesto: string | null;
  adresa: string | null;
  /** true = red u `companies` ne postoji (zaglavlje mora da to kaže naglas). */
  missing: boolean;
}

/** Obračun tražen za štampu ne postoji. */
export class StatementPdfNotFoundException extends NotFoundException {
  readonly code = "ZR_STATEMENT_NOT_FOUND";
  constructor(statementId: number) {
    super(`FinancialStatement ${statementId} ne postoji.`);
    this.name = "StatementPdfNotFoundException";
  }
}

/** Tip obrasca nema definisanu štampu (podržani BS/BU/SI). */
export class StatementPdfUnsupportedFormException extends NotFoundException {
  readonly code = "ZR_PRINT_FORM_UNSUPPORTED";
  constructor(statementType: string) {
    super(`Tip obrasca "${statementType}" nema definisanu štampu (podržani: BS/BU/SI).`);
    this.name = "StatementPdfUnsupportedFormException";
  }
}

@Injectable()
export class StatementPdfService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pdf: PdfService,
    private readonly controlRules: ControlRulesService,
  ) {}

  /**
   * PDF sačuvanog obračuna (BS/BU/SI). Vraća `{ buffer, fileName }` — kontroler
   * ga isporučuje kao `application/pdf` inline.
   */
  async buildStatementPdf(
    statementId: number,
    opts: { unit?: StatementPrintUnit; printedBy?: string } = {},
  ): Promise<{ buffer: Buffer; fileName: string }> {
    const statement = await this.prisma.financialStatement.findUnique({
      where: { id: statementId },
      include: { lines: { orderBy: { ordinal: "asc" } } },
    });
    if (!statement) throw new StatementPdfNotFoundException(statementId);

    const spec = FORM_SPEC[statement.statementType];
    if (!spec) {
      throw new StatementPdfUnsupportedFormException(statement.statementType);
    }

    const unit: StatementPrintUnit = opts.unit === "dinari" ? "dinari" : "hiljade";
    const [obveznik, controls] = await Promise.all([
      this.loadObveznik(),
      // Kontrolna pravila se štampaju uz obrazac (aktiva=pasiva, rezultat) — BigBit
      // ih štampa nigde, a bez njih se predaje bilans za koji se ne zna da li zatvara.
      this.controlRules.evaluateControls(statementId).catch(() => [] as ControlResult[]),
    ]);

    const docDefinition = this.buildDocDefinition({
      spec,
      statement,
      obveznik,
      controls,
      unit,
      printedBy: opts.printedBy,
    });

    const buffer = await this.pdf.render(docDefinition);
    const shortCode = SHORT_CODE[statement.statementType] ?? "ZR";
    return {
      buffer,
      fileName: `${shortCode}-${statement.periodYear}.pdf`,
    };
  }

  // ── učitavanje ─────────────────────────────────────────────────────────────

  /**
   * Obveznik = primarna firma (najmanji id) — isti idiom kao `AprXmlService.loadObveznik`,
   * da se zaglavlje štampe i identitet u XML-u ne raziđu. Kad reda nema, `missing`
   * flag tera zaglavlje da to i napiše umesto tihog „Servoteh d.o.o. + prazno".
   */
  private async loadObveznik(): Promise<Obveznik> {
    const company = await this.prisma.company.findFirst({
      orderBy: { id: "asc" },
      select: {
        companyName: true,
        taxId: true,
        registrationNumber: true,
        businessActivityCode: true,
        city: true,
        address: true,
      },
    });
    if (!company) {
      return {
        naziv: "Servoteh d.o.o.",
        pib: null,
        maticniBroj: null,
        sifraDelatnosti: null,
        mesto: null,
        adresa: null,
        missing: true,
      };
    }
    return {
      naziv: company.companyName,
      pib: company.taxId,
      maticniBroj: company.registrationNumber,
      sifraDelatnosti: company.businessActivityCode,
      mesto: company.city,
      adresa: company.address,
      missing: false,
    };
  }

  // ── dokument (pdfmake) ─────────────────────────────────────────────────────

  private buildDocDefinition(args: {
    spec: FormSpec;
    statement: StatementWithLines;
    obveznik: Obveznik;
    controls: ControlResult[];
    unit: StatementPrintUnit;
    printedBy?: string;
  }): TDocumentDefinitions {
    const { spec, statement, obveznik, controls, unit } = args;
    const year = statement.periodYear;

    const content: Content[] = [
      this.buildHeader(spec, statement, obveznik, unit),
      this.buildIssuerBlock(obveznik),
      statement.lines.length === 0
        ? this.buildEmptyNote(year)
        : this.buildLinesTable(spec, statement, unit),
      this.buildControlBlock(controls, statement, unit),
      this.buildSignatureBlock(),
    ];

    return {
      pageSize: "A4",
      pageMargins: [32, 32, 32, 40],
      content,
      styles: {
        title: { fontSize: 18, bold: true },
        subtitle: { fontSize: 11, color: "#555", margin: [0, 2, 0, 0] },
        meta: { fontSize: 8, color: "#555", margin: [0, 1, 0, 0] },
        sectionLbl: { fontSize: 8, bold: true, color: "#555" },
        partyName: { fontSize: 11, bold: true },
        partyLine: { fontSize: 9, color: "#333" },
        th: { fontSize: 7, bold: true, fillColor: "#f0f0f0" },
        thNum: { fontSize: 6, bold: true, fillColor: "#f0f0f0", alignment: "center" },
        td: { fontSize: 7 },
        tdBold: { fontSize: 7, bold: true },
        tdNum: { fontSize: 7, alignment: "right" },
        tdNumBold: { fontSize: 7, bold: true, alignment: "right" },
        note: { fontSize: 8, color: "#555", margin: [0, 10, 0, 0] },
        signLbl: { fontSize: 8, color: "#555", alignment: "center" },
        emptyNote: { fontSize: 12, bold: true, alignment: "center", color: "#a00" },
      },
      defaultStyle: { font: "Roboto", fontSize: 9 },
      footer: buildPageFooter(`${spec.title} ${year}`, args.printedBy ?? null),
    };
  }

  /** Zaglavlje: logo, naslov obrasca, vremenska odrednica, jedinica, statusna značka. */
  private buildHeader(
    spec: FormSpec,
    statement: StatementWithLines,
    obveznik: Obveznik,
    unit: StatementPrintUnit,
  ): Content {
    const year = statement.periodYear;
    const period = spec.asOfDate
      ? `na dan 31.12.${year}.`
      : `za period od 01.01.${year}. do 31.12.${year}.`;
    const unitLine =
      unit === "hiljade"
        ? "(u hiljadama dinara)"
        : "(u dinarima — nije svedeno na hiljade)";

    return {
      columns: [
        { image: SERVOTEH_LOGO_DATA_URL, width: 128 },
        {
          width: "*",
          margin: [12, 4, 0, 0],
          stack: [
            { text: spec.title, style: "title" },
            { text: period, style: "subtitle" },
            { text: unitLine, style: "meta" },
            ...(obveznik.missing
              ? [
                  {
                    text: "(podaci firme nisu podešeni — dopuni Podešavanja → Firma)",
                    fontSize: 8,
                    color: "#a00",
                    margin: [0, 1, 0, 0] as [number, number, number, number],
                  },
                ]
              : []),
          ],
        },
        buildStatusBadge(statement),
      ],
      columnGap: 8,
    };
  }

  /** Blok identifikacije obveznika (APR zaglavlje: MB, šifra delatnosti, PIB, naziv, sedište). */
  private buildIssuerBlock(o: Obveznik): Content {
    const cell = (label: string, value: string | null): Content => ({
      stack: [
        { text: label, style: "sectionLbl" },
        { text: value ?? "—", fontSize: 9, margin: [0, 1, 0, 0] },
      ],
    });
    return {
      margin: [0, 14, 0, 10],
      table: {
        widths: ["auto", "auto", "auto", "*"],
        body: [
          [
            cell("Matični broj", o.maticniBroj),
            cell("Šifra delatnosti", o.sifraDelatnosti),
            cell("PIB", o.pib),
            {
              stack: [
                { text: "Pun naziv obveznika", style: "sectionLbl" },
                { text: o.naziv, style: "partyName", margin: [0, 1, 0, 0] },
                {
                  text: [o.adresa, o.mesto].filter(Boolean).join(", ") || "—",
                  style: "partyLine",
                },
              ],
            },
          ],
        ],
      },
      layout: {
        hLineWidth: () => 0.6,
        vLineWidth: () => 0.6,
        hLineColor: () => "#cccccc",
        vLineColor: () => "#cccccc",
        paddingTop: () => 4,
        paddingBottom: () => 4,
        paddingLeft: () => 5,
        paddingRight: () => 5,
      },
    };
  }

  /**
   * Tabela AOP pozicija. `headerRows: 2` — zaglavlje kolona I propisani red sa
   * brojevima kolona (1..7 / 1..6) se PONAVLJAJU na svakoj strani; bez toga obrazac
   * od 4 strane nije čitljiv ni verodostojan.
   */
  private buildLinesTable(
    spec: FormSpec,
    statement: StatementWithLines,
    unit: StatementPrintUnit,
  ): Content {
    const year = statement.periodYear;
    const three = spec.amountColumns === 3;

    const amountHeaders = three
      ? [
          `Tekuća godina\n31.12.${year}.`,
          `Prethodna godina\nkrajnje stanje 31.12.${year - 1}.`,
          `Prethodna godina\npočetno stanje 01.01.${year - 1}.`,
        ]
      : [`Tekuća godina\n${year}.`, `Prethodna godina\n${year - 1}.`];

    const headerRow: Content[] = [
      { text: "Grupa računa, račun", style: "th" },
      { text: "POZICIJA", style: "th" },
      { text: "AOP", style: "th", alignment: "center" },
      { text: "Napomena broj", style: "th", alignment: "center" },
      ...amountHeaders.map(
        (h): Content => ({ text: h, style: "th", alignment: "right" }),
      ),
    ];
    // Propisani red sa rednim brojevima kolona (obrazac ga izričito nosi).
    const numberRow: Content[] = Array.from(
      { length: 4 + spec.amountColumns },
      (_, i): Content => ({ text: String(i + 1), style: "thNum" }),
    );

    const bodyRows: Content[][] = statement.lines.map((line) => {
      // Zbirne pozicije („A.", „I.", „II. …") su u obrascu podebljane; listovi
      // („1.", „2. …") nisu. Kriterijum je sam naziv pozicije iz obrasca.
      const aggregate = !/^\s*\d+\./.test(line.label ?? "");
      const tdStyle = aggregate ? "tdBold" : "td";
      const numStyle = aggregate ? "tdNumBold" : "tdNum";
      const amounts = three
        ? [line.amount, line.amount2, line.amount3]
        : [line.amount, line.amount2];
      return [
        { text: accountGroups(line.formula), style: "td" },
        { text: line.label ?? "—", style: tdStyle },
        { text: line.aop, style: "td", alignment: "center" },
        { text: "", style: "td" },
        ...amounts.map(
          (a): Content => ({ text: fmtAmount(a, unit), style: numStyle }),
        ),
      ];
    });

    const widths: (string | number)[] = three
      ? [58, "*", 26, 30, 60, 60, 60]
      : [58, "*", 26, 30, 72, 72];

    return {
      margin: [0, 0, 0, 0],
      table: {
        headerRows: 2,
        widths,
        body: [headerRow, numberRow, ...bodyRows],
      },
      layout: {
        hLineWidth: (i: number) => (i <= 2 ? 0.8 : 0.4),
        vLineWidth: () => 0.4,
        hLineColor: () => "#cccccc",
        vLineColor: () => "#dddddd",
        paddingTop: () => 2,
        paddingBottom: () => 2,
        paddingLeft: () => 3,
        paddingRight: () => 3,
      },
    };
  }

  /** Prazan obrazac se NE štampa nemo — jasna napomena umesto tabele sa nulama. */
  private buildEmptyNote(year: number): Content {
    return {
      margin: [0, 24, 0, 24],
      stack: [
        { text: "NEMA POZICIJA ZA ZADATE USLOVE", style: "emptyNote" },
        {
          text:
            `Obračun za ${year}. godinu je sačuvan bez ijedne AOP pozicije. ` +
            "Pokreni „Izračunaj“ na ekranu Završni račun; ako i tada ostane prazan, " +
            "nisu seed-ovane AOP formule za ovaj obrazac.",
          style: "note",
          alignment: "center",
        },
      ],
    };
  }

  /**
   * Kontrolni blok (nema ga u BigBitu): rezultati kontrolnih pravila, broj pozicija i
   * napomena o usklađenosti sa APR XML predajom. Pravilo koje pada je crveno — bilans
   * koji ne zatvara ne sme da izgleda isto kao ispravan.
   */
  private buildControlBlock(
    controls: ControlResult[],
    statement: StatementWithLines,
    unit: StatementPrintUnit,
  ): Content {
    const rows: Content[][] = controls.map((c) => [
      {
        text: c.passed ? "PROLAZI" : "NE PROLAZI",
        style: "td",
        bold: true,
        color: c.passed ? "#276749" : "#a00",
      },
      { text: c.name, style: "td" },
      { text: fmtAmount(new D(c.left), unit), style: "tdNum" },
      { text: fmtAmount(new D(c.right), unit), style: "tdNum" },
    ]);

    const stack: Content[] = [
      {
        text: `Kontrola: pozicija u obrascu ${statement.lines.length}`,
        style: "sectionLbl",
        margin: [0, 14, 0, 3],
      },
    ];
    if (rows.length > 0) {
      stack.push({
        table: {
          headerRows: 1,
          widths: [60, "*", 80, 80],
          body: [
            [
              { text: "Ishod", style: "th" },
              { text: "Kontrolno pravilo", style: "th" },
              { text: "Leva strana", style: "th", alignment: "right" },
              { text: "Desna strana", style: "th", alignment: "right" },
            ],
            ...rows,
          ],
        },
        layout: {
          hLineWidth: (i: number) => (i <= 1 ? 0.8 : 0.4),
          vLineWidth: () => 0,
          hLineColor: () => "#cccccc",
          paddingTop: () => 3,
          paddingBottom: () => 3,
          paddingLeft: () => 4,
          paddingRight: () => 4,
        },
      });
    } else {
      stack.push({
        text: "Za ovaj obrazac nema definisanih kontrolnih pravila.",
        style: "note",
        margin: [0, 0, 0, 0],
      });
    }
    stack.push({
      text:
        "Iznosi su iz istog obračuna iz koga se generiše i APR eFI (FiForma) XML — " +
        (unit === "hiljade"
          ? "u XML-u su zaokruženi na ceo broj u jedinici glavne knjige (dinar), a ovde svedeni na hiljade."
          : "u XML-u su zaokruženi na ceo broj."),
      style: "note",
    });
    stack.push({ text: LEGAL_BASIS, style: "note", margin: [0, 4, 0, 0] });

    return { unbreakable: true, stack };
  }

  /** Mesto i datum + potpis zakonskog zastupnika (kao na predatom obrascu). */
  private buildSignatureBlock(): Content {
    return {
      margin: [0, 26, 0, 0],
      unbreakable: true,
      columns: [
        {
          width: "*",
          stack: [
            { canvas: [{ type: "line", x1: 0, y1: 0, x2: 180, y2: 0, lineWidth: 0.5 }] },
            {
              text: "U ______________________ , dana ______________ 20____. godine",
              style: "signLbl",
              margin: [0, 2, 0, 0],
            },
          ],
        },
        {
          width: "*",
          stack: [
            { canvas: [{ type: "line", x1: 0, y1: 0, x2: 180, y2: 0, lineWidth: 0.5 }] },
            { text: "Zakonski zastupnik", style: "signLbl", margin: [0, 2, 0, 0] },
            { text: "(M.P.)", style: "signLbl", margin: [0, 1, 0, 0] },
          ],
        },
      ],
      columnGap: 24,
    };
  }
}

// ---------------------------------------------------------------- pomoćno

type StatementWithLines = Prisma.FinancialStatementGetPayload<{
  include: { lines: true };
}>;

/** Kratke oznake obrasca za ime fajla (isti skup kao APR XML export). */
const SHORT_CODE: Readonly<Record<string, string>> = {
  [STATEMENT_TYPE.BALANCE_SHEET]: "BS",
  [STATEMENT_TYPE.INCOME_STATEMENT]: "BU",
  [STATEMENT_TYPE.POPDV_ANNUAL]: "SI",
};

/** Statusna značka: NACRT (DRAFT) / PREDAT (FINALIZED). */
function buildStatusBadge(statement: StatementWithLines): Column {
  const finalized = statement.status === "FINALIZED";
  const color = finalized ? "#276749" : "#8a6d00";
  const text = finalized ? "PREDAT" : "NACRT";
  return {
    width: 92,
    margin: [0, 6, 0, 0],
    table: {
      widths: [84],
      body: [
        [
          {
            text,
            fontSize: 9,
            bold: true,
            color,
            alignment: "center",
            margin: [0, 3, 0, 3],
          },
        ],
      ],
    },
    layout: {
      hLineWidth: () => 1,
      vLineWidth: () => 1,
      hLineColor: () => color,
      vLineColor: () => color,
    },
  };
}

/**
 * Kolona „Grupa računa, račun" izvedena iz GKEval formule pozicije: skupljaju se
 * maske konta iza prefiksa D/P/PSD/PSP (npr. `D011*-P011*+D012*-P012*+D014*-P014*`
 * → „011, 012 i 014"). Zbirne pozicije (A-reference) i MANUAL nemaju konta — vraća
 * se prazno, tačno kao u zvaničnom obrascu.
 */
export function accountGroups(formula: string | null): string {
  if (!formula) return "";
  const codes = new Set<string>();
  const re = /(?:PSD|PSP|D|P)(\d{2,6})/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(formula)) !== null) codes.add(m[1]);
  if (codes.size === 0) return "";
  const list = [...codes].sort();
  const shown = list.slice(0, 4);
  const head = shown.slice(0, -1).join(", ");
  const tail = shown[shown.length - 1];
  const base = head ? `${head} i ${tail}` : tail;
  return list.length > shown.length ? `${base} …` : base;
}

/**
 * Iznos u odabranoj jedinici, sa TAČKOM kao razdelnikom hiljada i zarezom kao
 * decimalnim znakom. „hiljade" = ceo broj (deljenje sa 1.000, HALF_UP — obrazac se
 * predaje u hiljadama i nema decimale); „dinari" = dve decimale.
 */
export function fmtAmount(
  value: Prisma.Decimal,
  unit: StatementPrintUnit,
): string {
  const scaled =
    unit === "hiljade"
      ? value.div(1000).toDecimalPlaces(0, D.ROUND_HALF_UP)
      : value;
  const decimals = unit === "hiljade" ? 0 : 2;
  const raw = scaled.toFixed(decimals);
  const negative = raw.startsWith("-");
  const [intPart, fracPart] = (negative ? raw.slice(1) : raw).split(".");
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  const body = fracPart ? `${grouped},${fracPart}` : grouped;
  return negative ? `-${body}` : body;
}

/** Datum i vreme dd.MM.yyyy. HH:mm (trag štampe u nozi). */
function fmtDateTime(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()}. ${p(d.getHours())}:${p(d.getMinutes())}`;
}
