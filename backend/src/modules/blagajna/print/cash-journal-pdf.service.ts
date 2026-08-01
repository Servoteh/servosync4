import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type {
  Content,
  CustomTableLayout,
  TableCell,
  TDocumentDefinitions,
} from "pdfmake/interfaces";
import { PrismaService } from "../../../prisma/prisma.service";
import { PdfService } from "../../documents/pdf.service";

import {
  BASE_STYLES,
  DEFAULT_STYLE,
  PAGE_PORTRAIT,
  TABLE_LAYOUT,
  GRID_LAYOUT,
  amountInWords,
  buildFormHeader,
  buildPageFooter,
  loadIssuer,
  buildSignatureRow,
  fmtDate,
  fmtMoney,
  fmtMoneyOrBlank,
  safeFileName,
  sanitizeText,
  type IssuerInfo,
} from "../../documents/doc-layout";
import { BlagajnaService } from "../blagajna.service";

/**
 * BLAGAJNIČKI DNEVNIK / IZVEŠTAJ — BigBit `Blagajna` („blagajnički izveštaj"),
 * `BlagajnaDetaljno`, `Dnevnik blagajne`.
 * =========================================================================
 * Registar štampi je ovaj obrazac vodio kao „velik posao — 4.0 nema blagajnu".
 * To nije tačno: modul je živ i na backendu (uplatnica/isplatnica sa
 * auto-knjiženjem u GK, brojač NNNN/god pod advisory lock-om) i na frontendu —
 * falila je isključivo štampa, a 80 % podataka je već bilo tu:
 *
 *   • „Prethodni saldo" / „Novi saldo"  → `BlagajnaService.balanceOf(id, asOf)`
 *   • „Temeljnica"                      → `cash_entries.journalEntryId` (nalog GK)
 *   • Konto / Komitent / Opis           → `contraAccount` / `partnerId` / `description`
 *   • Iznos u slovima                   → `amountInWords` iz zajedničkog doc-layout-a
 *
 * ŠTA OVAJ PAPIR NE TVRDI (nema izvor u evidenciji, pa se štampa kao prazno):
 *   • APOENSKA SPECIFIKACIJA (5000…1 + „ČEKOVI") — mreža se štampa PRAZNA, kao
 *     obrazac koji blagajnik popunjava pri brojanju gotovine. Popunjavanje bilo
 *     kojim izvedenim brojem bilo bi izmišljanje rezultata brojanja.
 *   • „Broj priloga ____" — prazna linija.
 *   • „Blagajnik" / „Kontrolisao" — potpisna mesta; u bazi postoji samo
 *     `createdByUserId` po stavci, što nije isto što i odgovorno lice blagajne.
 *
 * REPRODUKTIVNOST — POŠTENO UPOZORENJE NA PAPIRU: saldo se računa iz stavki pri
 * svakoj štampi (`balanceOf`), a ne iz zaključenog dana. Naknadno unesena stavka
 * sa ranijim datumom TIHO menja već potpisan izveštaj. Dok ne postoji zaključenje
 * dana, to je izričito napisano u nozi obrasca — da niko ne pretpostavi da je
 * papir konačan.
 */

const D = Prisma.Decimal;
const ZERO = new D(0);

/** Apoeni dinarske gotovine (BigBit `Blagajna` — dno izveštaja). */
const RSD_DENOMINATIONS = [
  "5000",
  "1000",
  "500",
  "200",
  "100",
  "50",
  "20",
  "10",
  "5",
  "2",
  "1",
];

/** Apoeni devizne gotovine (BigBit `DevBlagajna`). */
const FX_DENOMINATIONS = [
  "500",
  "200",
  "100",
  "50",
  "20",
  "10",
  "5",
  "1",
  "0,50",
];

export interface CashJournalPrintArgs {
  journalId: number;
  /** ISO datum (YYYY-MM-DD) — početak perioda; podrazumevano danas. */
  from?: string;
  /** ISO datum (YYYY-MM-DD) — kraj perioda (uključivo); podrazumevano `from`. */
  to?: string;
  userId?: number | null;
}

@Injectable()
export class CashJournalPdfService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pdf: PdfService,
    private readonly blagajna: BlagajnaService,
  ) {}

  /** PDF blagajničkog izveštaja za period. Vraća `{ buffer, fileName }`. */
  async buildPdf(
    args: CashJournalPrintArgs,
  ): Promise<{ buffer: Buffer; fileName: string }> {
    const journal = await this.prisma.cashJournal.findUnique({
      where: { id: args.journalId },
      select: {
        id: true,
        companyId: true,
        name: true,
        accountCode: true,
        currency: true,
      },
    });
    if (!journal) {
      throw new NotFoundException(`Blagajna ${args.journalId} ne postoji.`);
    }

    const { from, to } = parseRange(args.from, args.to);

    const entries = await this.prisma.cashEntry.findMany({
      where: {
        cashJournalId: journal.id,
        entryDate: { gte: from, lte: to },
      },
      orderBy: [{ entryDate: "asc" }, { id: "asc" }],
      select: {
        entryNumber: true,
        direction: true,
        amount: true,
        entryDate: true,
        partnerId: true,
        contraAccount: true,
        description: true,
        status: true,
        journalEntryId: true,
      },
    });

    // Prethodni saldo = stanje neposredno PRE početka perioda (ista metoda koja
    // hrani saldo na ekranu — jedan računar salda, ne dva).
    const openingAsOf = new Date(from.getTime() - 1);
    const [issuer, printedBy, opening, partnerNames] = await Promise.all([
      loadIssuer(this.prisma, journal.companyId),
      this.loadPrintedBy(args.userId ?? null),
      this.blagajna.balanceOf(journal.id, openingAsOf),
      this.loadPartnerNames(entries.map((e) => e.partnerId)),
    ]);

    const docDefinition = this.buildDoc({
      journal,
      from,
      to,
      entries,
      opening,
      issuer,
      printedBy,
      partnerNames,
    });

    const buffer = await this.pdf.render(docDefinition);
    const label =
      from.getTime() === startOfDay(to).getTime()
        ? isoDay(from)
        : `${isoDay(from)}_${isoDay(to)}`;
    return {
      buffer,
      fileName: safeFileName(`BLAGAJNA-${journal.name}-${label}.pdf`),
    };
  }

  // ────────────────────────────────────────────────────────────── učitavanje

  private async loadPrintedBy(userId: number | null): Promise<string | null> {
    if (userId == null || userId <= 0) return null;
    try {
      const u = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { fullName: true, email: true },
      });
      return u?.fullName?.trim() || u?.email || null;
    } catch {
      return null;
    }
  }

  /** Mapa partnerId → naziv komitenta (meki ref; obrisan partner → bez unosa). */
  private async loadPartnerNames(
    ids: (number | null)[],
  ): Promise<Map<number, string>> {
    const unique = [
      ...new Set(ids.filter((i): i is number => i != null && i > 0)),
    ];
    if (!unique.length) return new Map();
    const rows = await this.prisma.customer.findMany({
      where: { id: { in: unique } },
      select: { id: true, name: true },
    });
    return new Map(rows.map((r) => [r.id, r.name]));
  }

  // ─────────────────────────────────────────────────── definicija dokumenta

  private buildDoc(args: {
    journal: {
      id: number;
      name: string;
      accountCode: string;
      currency: string;
    };
    from: Date;
    to: Date;
    entries: Array<{
      entryNumber: string;
      direction: string;
      amount: Prisma.Decimal;
      entryDate: Date;
      partnerId: number | null;
      contraAccount: string;
      description: string | null;
      status: string;
      journalEntryId: number | null;
    }>;
    opening: Prisma.Decimal;
    issuer: IssuerInfo;
    printedBy: string | null;
    partnerNames: Map<number, string>;
  }): TDocumentDefinitions {
    const {
      journal,
      from,
      to,
      entries,
      opening,
      issuer,
      printedBy,
      partnerNames,
    } = args;

    const singleDay = startOfDay(from).getTime() === startOfDay(to).getTime();
    const periodLabel = singleDay
      ? fmtDate(from)
      : `${fmtDate(from)} — ${fmtDate(to)}`;

    let totalIn = ZERO;
    let totalOut = ZERO;
    let draftCount = 0;

    const rows: TableCell[][] = entries.map((e, idx) => {
      const isIn = e.direction === "IN";
      if (isIn) totalIn = totalIn.add(e.amount);
      else totalOut = totalOut.add(e.amount);
      if (e.status !== "POSTED") draftCount += 1;

      const partner =
        e.partnerId != null
          ? (partnerNames.get(e.partnerId) ?? `#${e.partnerId}`)
          : "";
      return [
        { text: String(idx + 1), style: "tdNum" },
        // „Temeljnica" u BigBitu = broj naloga u glavnoj knjizi. Neproknjižena
        // stavka nema nalog — crtica, ne izmišljen broj.
        {
          text: e.journalEntryId != null ? String(e.journalEntryId) : "—",
          style: "tdNum",
        },
        { text: e.entryNumber, style: "td" },
        { text: fmtDate(e.entryDate), style: "td", noWrap: true },
        { text: e.contraAccount, style: "td" },
        { text: sanitizeText(partner), style: "td" },
        { text: sanitizeText(e.description ?? ""), style: "td" },
        { text: isIn ? fmtMoneyOrBlank(e.amount) : "", style: "tdNum" },
        { text: isIn ? "" : fmtMoneyOrBlank(e.amount), style: "tdNum" },
      ];
    });

    const closing = opening.add(totalIn).sub(totalOut);

    const content: Content[] = [
      this.buildHeader(issuer, journal, periodLabel),
      entries.length
        ? {
            table: {
              headerRows: 1,
              dontBreakRows: true,
              widths: [20, 36, 42, 46, 30, "*", "*", 58, 58],
              body: [
                [
                  { text: "Red.\nbroj", style: "thNum" },
                  { text: "Temelj-\nnica", style: "thNum" },
                  { text: "Broj\ndokumenta", style: "th" },
                  { text: "Datum", style: "th" },
                  { text: "Konto", style: "th" },
                  { text: "Komitent", style: "th" },
                  { text: "O P I S", style: "th" },
                  { text: "Ulaz", style: "thNum" },
                  { text: "Izlaz", style: "thNum" },
                ],
                ...rows,
                [
                  { text: "UKUPNO", colSpan: 7, style: "totLbl" },
                  { text: "" },
                  { text: "" },
                  { text: "" },
                  { text: "" },
                  { text: "" },
                  { text: "" },
                  { text: fmtMoney(totalIn), style: "totVal" },
                  { text: fmtMoney(totalOut), style: "totVal" },
                ],
              ],
            },
            // 9 kolona na uspravnom A4 — uži padding, da „Komitent" i „O P I S"
            // dobiju upotrebljivu širinu (v. `widthSlack` račun u testu).
            // (`TableLayout` je unija sa `string`, pa se spread traži kroz cast.)
            layout: {
              ...(TABLE_LAYOUT as CustomTableLayout),
              paddingLeft: () => 2,
              paddingRight: () => 2,
            },
          }
        : {
            margin: [0, 24, 0, 24],
            stack: [
              {
                text: "ZA IZABRANI PERIOD NEMA PROMETA U BLAGAJNI",
                style: "emptyBig",
              },
              {
                text:
                  "Izveštaj je odštampan sa prenetim stanjem i potpisnim mestima da " +
                  "obrazac ostane upotrebljiv.",
                style: "note",
                alignment: "center",
                margin: [0, 6, 0, 0],
              },
            ],
          },
      this.buildRecap(opening, totalIn, totalOut, closing),
      // „SLOVIMA:" ide uz NOVI SALDO — to je iznos koji blagajnik predaje dalje.
      {
        margin: [0, 6, 0, 0],
        text: [
          { text: "SLOVIMA: ", bold: true, fontSize: 8 },
          {
            text: cashAmountInWords(closing, journal.currency),
            fontSize: 8,
            italics: true,
          },
        ],
      },
      this.buildDenominationGrid(journal.currency),
      this.buildAttachmentLine(),
      this.buildNotes(entries.length, draftCount, singleDay),
      buildSignatureRow(["Blagajnik", "Kontrolisao"], false),
    ];

    return {
      ...PAGE_PORTRAIT,
      content,
      styles: {
        ...BASE_STYLES,
        recapLbl: { fontSize: 9, bold: false },
        recapVal: { fontSize: 9, bold: true, alignment: "right" },
        recapStrong: { fontSize: 11, bold: true, alignment: "right" },
        denomLbl: { fontSize: 8, alignment: "right" },
        denomCell: { fontSize: 8, alignment: "center" },
      },
      defaultStyle: DEFAULT_STYLE,
      footer: buildPageFooter(
        `Blagajnički izveštaj · ${journal.name} · ${periodLabel}`,
        printedBy,
      ),
    };
  }

  /**
   * Zaglavlje kroz ZAJEDNIČKI `buildFormHeader` (`documents/doc-layout`) — isti
   * memorandum, marže i redosled kao na fakturi, otpremnici i KEP knjizi. Ranije je
   * ovaj izveštaj crtao svoje zaglavlje rukom, pa je blagajna izgledala kao papir iz
   * druge aplikacije (i nije nosila delatnost, račun i kontakt firme).
   */
  private buildHeader(
    issuer: IssuerInfo,
    journal: { name: string; accountCode: string; currency: string },
    periodLabel: string,
  ): Content {
    return buildFormHeader({
      issuer,
      title: "BLAGAJNIČKI IZVEŠTAJ",
      subtitle: `${journal.name}   ·   konto ${journal.accountCode}   ·   ${journal.currency}`,
      extraLines: [`Period: ${periodLabel}`],
    });
  }

  /** Prethodni saldo → primitak → izdatak → novi saldo + iznos u slovima. */
  private buildRecap(
    opening: Prisma.Decimal,
    totalIn: Prisma.Decimal,
    totalOut: Prisma.Decimal,
    closing: Prisma.Decimal,
  ): Content {
    const row = (label: string, value: Prisma.Decimal, strong = false) => [
      { text: label, style: "recapLbl" },
      { text: fmtMoney(value), style: strong ? "recapStrong" : "recapVal" },
    ];
    return {
      margin: [0, 12, 0, 0],
      columns: [
        { width: "*", text: "" },
        {
          width: 260,
          stack: [
            {
              table: {
                widths: ["*", 100],
                body: [
                  row("Prethodni saldo", opening),
                  row("Ukupni primitak", totalIn),
                  row("Odbija se izdatak", totalOut),
                  row("NOVI SALDO", closing, true),
                ],
              },
              layout: "lightHorizontalLines",
            },
          ],
        },
      ],
      columnGap: 12,
    };
  }

  /**
   * Apoenska specifikacija — PRAZAN obrazac za brojanje gotovine (BigBit ga ima
   * na dnu izveštaja). Evidencija nema apoene, pa se ništa ne popunjava; zbir
   * apoena mora ručno da se poklopi sa novim saldom i to piše ispod mreže.
   */
  private buildDenominationGrid(currency: string): Content {
    const isRsd = currency === "RSD" || currency === "";
    const denominations = isRsd ? RSD_DENOMINATIONS : FX_DENOMINATIONS;
    const checksLabel = isRsd ? "ČEKOVI Din." : `ČEKOVI ${currency}`;

    const body: TableCell[][] = [
      [
        { text: "Apoen", style: "th" },
        { text: "Komada", style: "th" },
        { text: "Iznos", style: "th" },
      ],
      ...denominations.map((d) => [
        { text: d, style: "denomLbl" },
        { text: "", style: "denomCell" },
        { text: "", style: "denomCell" },
      ]),
      [
        { text: `SVEGA ${isRsd ? "Din." : currency}`, style: "subLbl" },
        { text: "", style: "denomCell" },
        { text: "", style: "denomCell" },
      ],
      [
        { text: checksLabel, style: "subLbl" },
        { text: "", style: "denomCell" },
        { text: "", style: "denomCell" },
      ],
      [
        { text: `UKUPNO ${isRsd ? "Din." : currency}`, style: "totLbl" },
        { text: "", style: "denomCell" },
        { text: "", style: "denomCell" },
      ],
    ];

    return {
      margin: [0, 14, 0, 0],
      unbreakable: true,
      stack: [
        {
          text: "APOENSKA SPECIFIKACIJA (popunjava blagajnik pri brojanju gotovine)",
          style: "sectionLbl",
        },
        {
          columns: [
            {
              width: 240,
              table: { headerRows: 1, widths: [70, 70, 70], body },
              layout: GRID_LAYOUT,
            },
            {
              width: "*",
              margin: [12, 12, 0, 0],
              stack: [
                {
                  text:
                    "Kontrola: zbir apoena (Σ apoen × komada) + čekovi MORA biti jednak " +
                    "novom saldu iznad. Aplikacija apoene ne evidentira, pa ovu mrežu ne " +
                    "popunjava — prazna polja su namerna, ne greška štampe.",
                  style: "note",
                },
              ],
            },
          ],
          columnGap: 12,
        },
      ],
    };
  }

  /** „Broj priloga ____" — prazna linija (broj priloga se ne evidentira). */
  private buildAttachmentLine(): Content {
    return {
      margin: [0, 12, 0, 0],
      text: [
        { text: "Broj priloga: ", bold: true, fontSize: 9 },
        { text: "______________", fontSize: 9 },
      ],
    };
  }

  /** Iznos u slovima + poštena upozorenja o obimu i reproduktivnosti. */
  private buildNotes(
    rowCount: number,
    draftCount: number,
    singleDay: boolean,
  ): Content {
    const stack: Content[] = [];
    if (draftCount > 0) {
      stack.push({
        style: "noteWarn",
        margin: [0, 10, 0, 0],
        text:
          `U izveštaju je ${draftCount} stavki u statusu NACRT (nisu proknjižene u glavnu knjigu) — ` +
          "one ulaze u saldo blagajne, ali ih glavna knjiga još ne vidi.",
      });
    }
    stack.push({
      style: "note",
      margin: [0, 10, 0, 0],
      text: `Stavki u izveštaju: ${rowCount}.`,
    });
    stack.push({
      style: "note",
      margin: [0, 2, 0, 0],
      text:
        "Saldo se računa iz stavki u trenutku štampe — dan još nije zaključen. Stavka uneta " +
        "naknadno sa datumom iz ovog perioda promeniće i ovaj izveštaj, pa odštampan primerak " +
        (singleDay
          ? "važi kao dnevni obračun samo uz potpise blagajnika i kontrolora."
          : "važi samo uz potpise."),
    });
    return { stack };
  }
}

// ────────────────────────────────────────────────────────── čiste funkcije

/** Iznos u slovima (izvezeno radi testova/ponovne upotrebe u modulu). */
export function cashAmountInWords(
  value: Prisma.Decimal,
  currency: string,
): string {
  return amountInWords(value, currency === "RSD" ? "dinara" : currency);
}

function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function isoDay(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * Period izveštaja. Bez parametara = današnji dan. `to` je UKLJUČIVO — poredi se
 * sa krajem dana, inače bi stavka uneta u 14:30 ispala iz izveštaja za taj dan.
 */
function parseRange(
  fromRaw?: string,
  toRaw?: string,
): { from: Date; to: Date } {
  const parse = (s: string, label: string): Date => {
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) {
      throw new BadRequestException(
        `Nevalidan ${label} perioda: "${s}" (očekuje se YYYY-MM-DD).`,
      );
    }
    return d;
  };
  const from = startOfDay(fromRaw ? parse(fromRaw, "početak") : new Date());
  const toStart = startOfDay(toRaw ? parse(toRaw, "kraj") : from);
  if (toStart.getTime() < from.getTime()) {
    throw new BadRequestException(
      "Kraj perioda ne može biti pre početka perioda.",
    );
  }
  const to = new Date(toStart);
  to.setHours(23, 59, 59, 999);
  return { from, to };
}
