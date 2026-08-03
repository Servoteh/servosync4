/**
 * ZAJEDNIČKI IZGLED ŠTAMPE (ServoSync obrazac) — JEDAN IZVOR ISTINE.
 * =================================================================
 * Ovde žive tema (marže, logo, paleta stilova, prelom tabele), formatiranje
 * (datum / novac / količina / iznos u slovima), noga strane i vodeni žig.
 *
 * Zašto jedan fajl: štampe su građene u četiri odvojena paketa, pa su nastale
 * tri kopije istog zaglavlja sa različitim logotipom, maržama, formatom para i
 * nogom. Korisniku to izgleda kao četiri različite aplikacije. Moduli i dalje
 * imaju svoje gradiče visokog nivoa (zaglavlje, strane, tabele), ali TEMU i
 * FORMATIRANJE uvoze isključivo odavde.
 *
 * Renderer ostaje `PdfService` (pdfmake 0.3, DocumentsModule) — bez novih
 * zavisnosti; ovde nema NestJS DI, samo čiste funkcije i tipovi.
 *
 * PRAVILA (obavezna za svaku novu štampu):
 *   • A4; uspravno za dokumente, položeno za knjige i tabele preko 8 kolona.
 *   • Zaglavlje tabele se PONAVLJA na svakoj strani (`headerRows`).
 *   • Novac: `Prisma.Decimal` → `1.234.567,89`; numeričke kolone desno.
 *   • Datum `dd.MM.yyyy.`
 *   • Prazan dokument se štampa sa jasnom napomenom, nikad ne puca.
 *   • Noga uvek nosi „strana N/M" + trag štampe (ko i kada).
 *   • Zbir reda UKUPNO se računa nad ZAOKRUŽENIM iznosima stavki, da se zbir
 *     poklopi sa sabiranjem odštampane kolone.
 */

import { Prisma } from "@prisma/client";
import type {
  Content,
  StyleDictionary,
  TableLayout,
  TDocumentDefinitions,
} from "pdfmake/interfaces";
import { SERVOTEH_LOGO_DATA_URL } from "../servoteh-logo";
import { companyAddressLine } from "../../../common/company-address";
import type { PrismaService } from "../../../prisma/prisma.service";

// ─────────────────────────────────────────────────────────────────── tema

/** Marže uspravne strane (levo, gore, desno, dole) — isto za sve dokumente. */
export const PAGE_MARGINS: [number, number, number, number] = [32, 32, 32, 40];

/** Marže položene strane (knjige i široke tabele). */
export const PAGE_MARGINS_LANDSCAPE: [number, number, number, number] = [
  24, 28, 24, 40,
];

/** Uspravno A4 — dokumenti. */
export const PAGE_PORTRAIT = {
  pageSize: "A4" as const,
  pageOrientation: "portrait" as const,
  pageMargins: PAGE_MARGINS,
};

/** Položeno A4 — knjige i tabele preko 8 kolona. */
export const PAGE_LANDSCAPE = {
  pageSize: "A4" as const,
  pageOrientation: "landscape" as const,
  pageMargins: PAGE_MARGINS_LANDSCAPE,
};

/** Širina A4 u tačkama (pdfmake radi u pt). */
export const A4_WIDTH_PT = 595.28;
export const A4_HEIGHT_PT = 841.89;

/** Podrazumevani font/veličina tela dokumenta. */
export const DEFAULT_STYLE = { font: "Roboto", fontSize: 9 } as const;

/** Širina logotipa u zaglavlju — FIKSNA svuda (bilo je 110/120/128). */
export const LOGO_WIDTH = 128;

/**
 * Paleta stilova — zajednička osnova. Moduli je proširuju
 * (`{ ...BASE_STYLES, ...overrides }`), ali veličine i boje ne menjaju.
 */
export const BASE_STYLES: StyleDictionary = {
  title: { fontSize: 18, bold: true },
  titleDanger: { fontSize: 18, bold: true, color: "#b00020" },
  subtitle: { fontSize: 11, color: "#555555", margin: [0, 2, 0, 0] },
  legalForm: { fontSize: 8, bold: true, color: "#555555" },
  issuerName: { fontSize: 11, bold: true, margin: [0, 4, 0, 0] },
  issuerLine: { fontSize: 8, color: "#333333" },
  sectionLbl: {
    fontSize: 8,
    bold: true,
    color: "#555555",
    margin: [0, 0, 0, 2],
  },
  sectionTitle: { fontSize: 10, bold: true, margin: [0, 12, 0, 4] },
  partyName: { fontSize: 11, bold: true },
  partyLine: { fontSize: 9, color: "#333333" },
  metaLbl: { fontSize: 8, bold: true, color: "#555555" },
  metaVal: { fontSize: 9, color: "#333333" },
  th: { fontSize: 8, bold: true, fillColor: "#f0f0f0" },
  thNum: { fontSize: 8, bold: true, fillColor: "#f0f0f0", alignment: "right" },
  td: { fontSize: 8 },
  tdCode: { fontSize: 8, bold: true },
  tdNum: { fontSize: 8, alignment: "right" },
  tdMuted: { fontSize: 8, color: "#777777" },
  subLbl: { fontSize: 8, bold: true, fillColor: "#fafafa" },
  subNum: { fontSize: 8, bold: true, alignment: "right", fillColor: "#fafafa" },
  totLbl: { fontSize: 9, bold: true },
  totVal: { fontSize: 9, bold: true, alignment: "right" },
  totNum: { fontSize: 9, bold: true, alignment: "right" },
  grand: { fontSize: 11, bold: true },
  note: { fontSize: 8, color: "#555555" },
  noteWarn: { fontSize: 8, color: "#b00020", bold: true },
  warn: { fontSize: 9, bold: true, color: "#b00020" },
  words: { fontSize: 8, color: "#333333", italics: true },
  intro: { fontSize: 9, color: "#333333" },
  empty: { fontSize: 11, bold: true, color: "#b00020", alignment: "center" },
  emptyBig: { fontSize: 13, bold: true, alignment: "center", color: "#777777" },
  emptyBox: { fontSize: 11, bold: true, alignment: "center", color: "#b00020" },
  signLbl: {
    fontSize: 8,
    color: "#333333",
    alignment: "center",
    margin: [0, 2, 0, 0],
  },
  badge: { fontSize: 8, bold: true, alignment: "center" },
};

/** Prelom tabele: deblja linija ispod zaglavlja kolona, bez vertikala. */
export const TABLE_LAYOUT: TableLayout = {
  hLineWidth: (i: number) => (i === 1 ? 0.8 : 0.4),
  vLineWidth: () => 0,
  hLineColor: (i: number) => (i === 1 ? "#999999" : "#dddddd"),
  paddingTop: () => 3,
  paddingBottom: () => 3,
  paddingLeft: () => 4,
  paddingRight: () => 4,
};

/**
 * Uži prelom za obrasce sa 14+ kolona (kalkulacija KL, popisna lista): padding
 * od 4 pt po ivici troši 120 pt na 15 kolona, što je razlika između čitljivog
 * naziva artikla i naziva prelomljenog u pet redova.
 */
export const COMPACT_TABLE_LAYOUT: TableLayout = {
  ...TABLE_LAYOUT,
  paddingLeft: () => 2,
  paddingRight: () => 2,
};

/** Mreža sa okvirom — obrasci koji po propisu imaju uokvirene ćelije (popis). */
export const GRID_LAYOUT: TableLayout = {
  hLineWidth: () => 0.5,
  vLineWidth: () => 0.5,
  hLineColor: () => "#999999",
  vLineColor: () => "#bbbbbb",
  paddingTop: () => 3,
  paddingBottom: () => 3,
  paddingLeft: () => 3,
  paddingRight: () => 3,
};

/** Vodoravni padding koji `TABLE_LAYOUT` troši po koloni (levo + desno). */
export const TABLE_H_PADDING = 8;
/** Isto za `GRID_LAYOUT`. */
export const GRID_H_PADDING = 6;

/** Boje statusne značke — jedna paleta za sve module. */
export type BadgeTone = "neutral" | "info" | "ok" | "warn" | "danger";

export const BADGE_PALETTE: Record<
  BadgeTone,
  { border: string; text: string; fill: string }
> = {
  neutral: { border: "#999999", text: "#555555", fill: "#f4f4f4" },
  info: { border: "#3b6ea5", text: "#2b5580", fill: "#eef4fb" },
  ok: { border: "#2e7d32", text: "#2e7d32", fill: "#eef7ef" },
  warn: { border: "#b26a00", text: "#b26a00", fill: "#fff6dd" },
  danger: { border: "#b00020", text: "#b00020", fill: "#fdeeee" },
};

// ───────────────────────────────────────────────── raspoloživa širina strane

/**
 * Raspoloživa širina sadržaja (pt) za date marže. Fiksne širine kolona plus
 * padding MORAJU stati u ovo — inače pdfmake „*" koloni da negativnu širinu i
 * tabela se prelije preko desne ivice papira (poslednja kolona se ne odštampa).
 */
export function contentWidth(landscape: boolean): number {
  const m = landscape ? PAGE_MARGINS_LANDSCAPE : PAGE_MARGINS;
  const page = landscape ? A4_HEIGHT_PT : A4_WIDTH_PT;
  return page - m[0] - m[2];
}

/**
 * Provera da fiksne širine kolona + padding staju u stranu; vraća rezervu (pt).
 * Negativna rezerva = tabela se prelije. Koristi se u testovima svakog obrasca.
 */
export function widthSlack(
  widths: Array<string | number>,
  landscape: boolean,
  hPadding = TABLE_H_PADDING,
  minStarWidth = 0,
): number {
  let fixed = 0;
  let stars = 0;
  for (const w of widths) {
    if (typeof w === "number") fixed += w;
    else if (w === "*") stars += 1;
    else fixed += 0; // "auto" — pdfmake meri sadržaj, ne rezervišemo
  }
  return (
    contentWidth(landscape) -
    fixed -
    widths.length * hPadding -
    stars * minStarWidth
  );
}

// ─────────────────────────────────────────────────────────────── formatiranje

export type Num = Prisma.Decimal | string | number | null | undefined;

/** Bilo koji numerički ulaz → Decimal (nikad Float aritmetika nad novcem). */
export function toDec(v: Num): Prisma.Decimal {
  if (v == null || v === "") return new Prisma.Decimal(0);
  if (v instanceof Prisma.Decimal) return v;
  try {
    return new Prisma.Decimal(v);
  } catch {
    return new Prisma.Decimal(0);
  }
}

/** Datum `dd.MM.yyyy.`; null → prazno. */
export function fmtDate(d: Date | string | null | undefined): string {
  if (d == null || d === "") return "";
  const date = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(date.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(date.getDate())}.${p(date.getMonth() + 1)}.${date.getFullYear()}.`;
}

/** Datum sa crticom kad podatka nema (meta-parovi na dokumentima). */
export function fmtDateOrDash(d: Date | string | null | undefined): string {
  return fmtDate(d) || "—";
}

/** Datum i vreme `dd.MM.yyyy. HH:mm` — trag štampe u nozi. */
export function fmtDateTime(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${fmtDate(d)} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Grupisanje hiljada nad `toFixed` stringom („1234567.89" → „1.234.567,89"). */
function groupThousands(fixed: string, decimals: number): string {
  const neg = fixed.startsWith("-");
  const body = neg ? fixed.slice(1) : fixed;
  const [whole, frac] = body.split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  const out = decimals > 0 && frac != null ? `${grouped},${frac}` : grouped;
  // ASCII „-", ne U+2212: iznos se iz PDF-a kopira u Excel, koji minus znak
  // ne prepoznaje kao broj (kolona tiho da 0).
  return neg ? `-${out}` : out;
}

/** Novac: `1.234.567,89`. `toFixed` ide NAD Decimal-om (bez prelaska u Number). */
export function fmtMoney(v: Num, decimals = 2): string {
  return groupThousands(toDec(v).toFixed(decimals), decimals);
}

/** Novac, ali nula → prazno (kolone duguje/potražuje u knjigama). */
export function fmtMoneyOrBlank(v: Num, decimals = 2): string {
  const d = toDec(v);
  if (v == null || d.isZero()) return "";
  return fmtMoney(d, decimals);
}

/**
 * Količina — do `decimals` decimala, bez suvišnih nula (`12`, `12,5`, `12,125`).
 * Razdelnik hiljada je tačka, pa ga skidanje nula sa kraja ne dira.
 */
export function fmtQty(v: Num, decimals = 3): string {
  const s = fmtMoney(v, decimals);
  if (decimals === 0 || !s.includes(",")) return s;
  return s.replace(/0+$/, "").replace(/,$/, "");
}

/** Procenat `12,5 %` (prazno za nulu). */
export function fmtPercent(v: Num): string {
  const d = toDec(v);
  if (d.isZero()) return "";
  return `${fmtQty(d, 2)} %`;
}

/** Kurs (6 decimala). */
export function fmtRate(v: Num): string {
  if (v == null) return "—";
  return fmtMoney(v, 6);
}

/**
 * Znakovi koje Roboto (pdfmake vfs) NEMA ili tiho izbacuje. Prolaze SVI tekstovi
 * ćelija, jer je ⌀ (prečnik) u nazivima artikala mašinogradnje svakodnevan, a
 * štampao se kao prazan kvadratić. Strelice i kvačice Roboto tiho briše — pa
 * rečenica gubi reč bez ijedne greške.
 */
const GLYPH_FALLBACK: Array<[RegExp, string]> = [
  [/[⌀∅]/g, "Ø"], // ⌀ / ∅ → Ø (Roboto ga ima)
  [/[ \t]*↔[ \t]*/g, " / "], // ↔
  [/[→➡➔]/g, "->"], // →
  [/←/g, "<-"], // ←
  [/↑/g, "^"], // ↑
  [/↓/g, "v"], // ↓
  [/[✓✔]/g, "DA"], // ✓ ✔
  [/[✗✘✕✖]/g, "NE"], // ✗ ✘
  [/⚠️?/g, "!"], // ⚠
  [/−/g, "-"], // U+2212 MINUS → ASCII
];

/** Zamena znakova van Roboto podskupa; sve ostalo (čćđšž) ostaje netaknuto. */
export function sanitizeText(s: string | null | undefined): string {
  if (s == null) return "";
  let out = String(s);
  for (const [re, rep] of GLYPH_FALLBACK) out = out.replace(re, rep);
  return out;
}

/** Bezbedan naziv fajla (broj dokumenta nosi „/" — NNNN/god). */
export function safeFileName(s: string): string {
  return sanitizeText(s)
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, "_");
}

// ────────────────────────────────────────── iznos u slovima („SLOVIMA:")

const ONES_M = [
  "",
  "jedan",
  "dva",
  "tri",
  "četiri",
  "pet",
  "šest",
  "sedam",
  "osam",
  "devet",
];
const ONES_F = [
  "",
  "jedna",
  "dve",
  "tri",
  "četiri",
  "pet",
  "šest",
  "sedam",
  "osam",
  "devet",
];
const TEENS = [
  "deset",
  "jedanaest",
  "dvanaest",
  "trinaest",
  "četrnaest",
  "petnaest",
  "šesnaest",
  "sedamnaest",
  "osamnaest",
  "devetnaest",
];
const TENS = [
  "",
  "",
  "dvadeset",
  "trideset",
  "četrdeset",
  "pedeset",
  "šezdeset",
  "sedamdeset",
  "osamdeset",
  "devedeset",
];
const HUNDREDS = [
  "",
  "sto",
  "dvesta",
  "trista",
  "četiristo",
  "petsto",
  "šeststo",
  "sedamsto",
  "osamsto",
  "devetsto",
];

/** 1–999 na srpskom; `feminine` za grupe hiljada/milijarda/bilion. */
function groupToWords(n: number, feminine: boolean): string {
  const parts: string[] = [];
  const h = Math.floor(n / 100);
  const rest = n % 100;
  if (h > 0) parts.push(HUNDREDS[h]);
  if (rest >= 10 && rest < 20) {
    parts.push(TEENS[rest - 10]);
  } else {
    const t = Math.floor(rest / 10);
    const o = rest % 10;
    if (t > 0) parts.push(TENS[t]);
    if (o > 0) parts.push((feminine ? ONES_F : ONES_M)[o]);
  }
  return parts.join(" ");
}

/** Srpska deklinacija: 1 → jednina, 2–4 → paukal, ostalo → množina. */
export function pluralForm(
  n: number,
  one: string,
  few: string,
  many: string,
): string {
  const mod100 = n % 100;
  const mod10 = n % 10;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

/** Gornja granica ispisa slovima (999 triliona i 999…). */
const WORDS_MAX = 1e18;

const SCALES: Array<{
  div: number;
  forms: [string, string, string];
  feminine: boolean;
}> = [
  { div: 1e15, forms: ["trilion", "triliona", "triliona"], feminine: false },
  { div: 1e12, forms: ["bilion", "biliona", "biliona"], feminine: false },
  { div: 1e9, forms: ["milijarda", "milijarde", "milijardi"], feminine: true },
  { div: 1e6, forms: ["milion", "miliona", "miliona"], feminine: false },
  { div: 1e3, forms: ["hiljada", "hiljade", "hiljada"], feminine: true },
];

/** Ceo deo broja u reči (0 .. 999.999.999.999.999.999). */
function integerToWords(whole: number): string {
  if (whole === 0) return "nula";
  const parts: string[] = [];
  let rest = whole;
  for (const s of SCALES) {
    const n = Math.floor(rest / s.div);
    if (n > 0) {
      // „jedna hiljada" se u knjigovodstvenom običaju piše „hiljadu".
      if (n === 1 && s.div === 1e3) parts.push("hiljadu");
      else
        parts.push(
          `${groupToWords(n, s.feminine)} ${pluralForm(n, ...s.forms)}`.trim(),
        );
      rest -= n * s.div;
    }
  }
  if (rest > 0) parts.push(groupToWords(rest, false));
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

/**
 * Iznos u slovima. Zaokružuje se JEDNOM na 2 decimale pa se razlaže — inače
 * broj i slova na istom dokumentu daju različit iznos („1.001,00" naspram
 * „hiljadu dinara i 100/100"). Valuta se slaže sa brojem („jedan dinar").
 * Preko opsega ispisa vraća jasno upozorenje umesto tihe laži.
 */
export function amountInWords(v: Num, currency = "dinara"): string {
  const raw = toDec(v);
  const rounded = raw.abs().toDecimalPlaces(2);
  const whole = Number(rounded.floor().toFixed(0));
  const cents = Number(rounded.sub(rounded.floor()).mul(100).toFixed(0));
  if (!Number.isFinite(whole) || whole >= WORDS_MAX) {
    return "iznos prevazilazi opseg ispisa slovima";
  }
  const isDinar =
    currency === "dinara" || currency === "dinar" || currency === "RSD";
  const unit = isDinar
    ? pluralForm(whole, "dinar", "dinara", "dinara")
    : currency;
  const sign = raw.isNegative() ? "minus " : "";
  return `${sign}${integerToWords(whole)} ${unit} i ${String(cents).padStart(2, "0")}/100`;
}

// ─────────────────────────────────────────────────────────────── noga / žig

/**
 * Noga strane — ISTA na svim štampama: levo oznaka dokumenta, sredina trag
 * štampe (BigBit štampa samo `=Now()` bez korisnika), desno „strana N/M"
 * (BigBit na pola izveštaja ima samo `[Page]`, pa se ne vidi da fali strana).
 */
export function buildPageFooter(
  docLabel: string,
  printedBy?: string | null,
  marginX = PAGE_MARGINS[0],
  /** Natpisi za dokumente na stranom jeziku (ino faktura). */
  labels?: { printedBy: string; page: string },
  /**
   * Redni broj primerka iz traga štampe (`document_prints`). 1 = original (ne piše se),
   * >= 2 → „· primerak br. N" uz trag štampe. `null`/izostavljeno = trag nije upisan, pa
   * se NE tvrdi ništa (v. `copyWatermark`).
   */
  copyNo?: number | null,
): (currentPage: number, pageCount: number) => Content {
  const who = printedBy && printedBy.trim() !== "" ? printedBy.trim() : "—";
  const printedLbl = labels?.printedBy ?? "Štampao";
  const pageLbl = labels?.page ?? "strana";
  const copyPart =
    copyNo != null && copyNo >= 2 ? ` · primerak br. ${copyNo}` : "";
  const stamp = `${printedLbl}: ${who} · ${fmtDateTime(new Date())} · ServoSync 4.0${copyPart}`;
  return (currentPage: number, pageCount: number): Content => ({
    margin: [marginX, 8, marginX, 0],
    columns: [
      {
        width: "*",
        text: sanitizeText(docLabel),
        fontSize: 7,
        color: "#888888",
      },
      {
        width: "auto",
        text: stamp,
        fontSize: 7,
        color: "#888888",
        alignment: "center",
      },
      {
        width: "*",
        text: `${pageLbl} ${currentPage}/${pageCount}`,
        fontSize: 7,
        color: "#888888",
        alignment: "right",
      },
    ],
    columnGap: 12,
  });
}

/**
 * Potpisni blok — 1..4 mesta sa linijom i natpisom (BigBit natpisi doslovno).
 * `unbreakable`, da se blok ne prelomi preko strane.
 */
export function buildSignatureRow(
  labels: string[],
  withStamp = false,
): Content {
  return {
    unbreakable: true,
    margin: [0, 24, 0, 0],
    columns: labels.map((label) => ({
      width: "*",
      stack: [
        {
          canvas: [
            {
              type: "line",
              x1: 0,
              y1: 0,
              x2: 150,
              y2: 0,
              lineWidth: 0.6,
              lineColor: "#666666",
            },
          ],
          margin: [0, 34, 0, 0],
        },
        { text: label, style: "signLbl" },
        ...(withStamp ? [{ text: "(M.P.)", style: "signLbl" }] : []),
      ],
    })),
    columnGap: 24,
  };
}

/** Vodeni žig (nacrt/storno — da se ne zameni sa važećim dokumentom). */
export function draftWatermark(
  text: string,
): TDocumentDefinitions["watermark"] {
  return { text: sanitizeText(text), opacity: 0.12, bold: true, angle: -35 };
}

/**
 * Žig „KOPIJA" na PONOVLJENOJ štampi (trag štampe, `document_prints`).
 * JEDAN izvor izgleda za sve obrasce — ne prekucavati po servisima.
 *
 * `copyNo` je redni broj primerka: 1 = original (nema žiga), >= 2 = kopija. `null`
 * znači da trag nije upisan — tada NEMA žiga, jer ne znamo koji je primerak u ruci
 * i lakše je opravdati odsustvo žiga nego lažnu tvrdnju „original".
 *
 * Opacitet je 0.10 (a ne 0.12 kao „NACRT"), jer se KOPIJA štampa preko punog
 * dokumenta sa tabelom, pa jači žig guta brojeve.
 */
export function copyWatermark(
  copyNo: number | null | undefined,
): TDocumentDefinitions["watermark"] | undefined {
  if (copyNo == null || copyNo < 2) return undefined;
  return { text: "KOPIJA", opacity: 0.1, bold: true, angle: -35 };
}

/**
 * Natpis primerka za nogu/značku: `null` (original ili nepoznato) → bez natpisa.
 * Tekst je namerno pun („KOPIJA · primerak br. 3"), da se sa papira u ruci vidi
 * i to KOJI je primerak, ne samo da nije original.
 */
export function copyLabel(copyNo: number | null | undefined): string | null {
  if (copyNo == null || copyNo < 2) return null;
  return `KOPIJA · primerak br. ${copyNo}`;
}

// ──────────────────────────────────────────── izdavalac i zaglavlje obrasca

/**
 * Podaci firme izdavaoca za memorandum. `isFallback` znači da u `companies` NEMA
 * nijednog reda — zaglavlje tada ispisuje vidljivo upozorenje, nikad tihi default.
 */
export interface IssuerInfo {
  companyName: string;
  address: string | null;
  city: string | null;
  /** Poštanski broj (O-F10) — od 03.08.2026. zasebna kolona, ne više deo mesta. */
  postalCode?: string | null;
  taxId: string | null;
  registrationNumber: string | null;
  bankAccount: string | null;
  phone: string | null;
  email: string | null;
  businessActivity: string | null;
  isFallback: boolean;
}

/**
 * Podaci firme izdavaoca. Dokument vezan za firmu → `companyId`; kad tog reda nema
 * (moduli koji su jednofirmni pišu `companyId = 0`), uzima se primarna firma po
 * najmanjem id.
 *
 * NIKAD tihi fallback: kad u bazi nema nijedne firme, vraća se `isFallback: true`,
 * pa zaglavlje ispisuje „(podaci firme nisu podešeni)" — knjigovođa odmah vidi da
 * dokument nije za predaju.
 *
 * Uvoz `PrismaService` je TYPE-ONLY: ovaj fajl namerno nema NestJS DI ni runtime
 * zavisnost na Prismu (v. blok na vrhu).
 */
export async function loadIssuer(
  prisma: PrismaService,
  companyId?: number | null,
): Promise<IssuerInfo> {
  const select = {
    companyName: true,
    address: true,
    city: true,
    postalCode: true,
    taxId: true,
    registrationNumber: true,
    bankAccount: true,
    phone: true,
    email: true,
    businessActivity: true,
  } as const;

  const byId =
    companyId != null && companyId > 0
      ? await prisma.company.findUnique({ where: { id: companyId }, select })
      : null;
  const company =
    byId ??
    (await prisma.company.findFirst({ orderBy: { id: "asc" }, select }));

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
      businessActivity: null,
      isFallback: true,
    };
  }
  return { ...company, isFallback: false };
}

/** Ime korisnika koji štampa (trag u nozi). Nikad ne baca — štampa ne sme da padne zbog imena. */
export async function loadPrintedBy(
  prisma: PrismaService,
  userId?: number | null,
): Promise<string | null> {
  if (userId == null || userId <= 0) return null;
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { fullName: true, email: true },
    });
    return user?.fullName?.trim() || user?.email || null;
  } catch {
    return null;
  }
}

export interface DocBadge {
  text: string;
  tone: BadgeTone;
}

/**
 * Statusna značka dokumenta (NACRT / PROKNJIŽEN / „KOPIJA · primerak br. 3").
 * BigBit je nema nigde — storniran i važeći dokument tamo izgledaju isto.
 */
export function buildStatusBadge(badge: DocBadge): Content {
  const c = BADGE_PALETTE[badge.tone];
  return {
    table: {
      widths: ["auto"],
      body: [
        [
          {
            text: sanitizeText(badge.text),
            fontSize: 8,
            bold: true,
            color: c.text,
            fillColor: c.fill,
            alignment: "center",
            margin: [4, 2, 4, 2],
          },
        ],
      ],
    },
    layout: {
      hLineWidth: () => 0.8,
      vLineWidth: () => 0.8,
      hLineColor: () => c.border,
      vLineColor: () => c.border,
      paddingLeft: () => 0,
      paddingRight: () => 0,
      paddingTop: () => 0,
      paddingBottom: () => 0,
    },
    alignment: "right",
    margin: [0, 6, 0, 0],
  };
}

export interface FormHeaderArgs {
  issuer: IssuerInfo;
  title: string;
  subtitle?: string | null;
  /** Npr. „Obrazac - KL" / „Obrazac KEP" — propisana oznaka, gore desno kao u BigBitu. */
  formCode?: string | null;
  /** Jedna značka ili više njih; ispisuju se jedna ispod druge, redom kojim su predate. */
  badge?: DocBadge | DocBadge[] | null;
  /** Code 128 SVG (broj dokumenta) — desno od naslova; magacioner skenira dokument. */
  barcodeSvg?: string | null;
  /** Uža leva kolona za položene (landscape) obrasce. */
  compact?: boolean;
  /**
   * Dodatni redovi ispod naslova (npr. „Period: Jul 2026." i „Magacin: …" na
   * knjigama). Ispisuju se stilom `subtitle`, desno poravnati, pre oznake obrasca.
   */
  extraLines?: Array<string | null | undefined>;
}

/**
 * ZAGLAVLJE OBRASCA — JEDAN izvor za sve module.
 *
 * Levo: logo + memorandum firme (BigBit `Memorandum_Header_STD` skup).
 * Desno: naslov, podnaslov, dodatni redovi, oznaka obrasca, značke i barkod.
 *
 * Do 27.07.2026. je ova funkcija živela u `robno/print/robno-doc-layout.ts`, pa su
 * knjige iz drugih modula (KEP u PDV-u, blagajnički izveštaj) crtale SVOJE zaglavlje
 * rukom — isti podaci, druge marže i drugi redosled. Korisniku je to izgledalo kao
 * dve aplikacije. Robni `buildDocHeader` je sada tanak omotač oko ove funkcije.
 */
export function buildFormHeader(args: FormHeaderArgs): Content {
  const {
    issuer,
    title,
    subtitle,
    formCode,
    badge,
    barcodeSvg,
    compact,
    extraLines,
  } = args;

  const issuerLines: Content[] = [
    { text: sanitizeText(issuer.companyName), style: "issuerName" },
  ];
  const line = (t: string | null | undefined) => {
    if (t && t.trim())
      issuerLines.push({ text: t.trim(), style: "issuerLine" });
  };
  // Adresa sedišta sa poštanskim brojem — mesto i broj su dva podatka (O-F10), a spaja
  // ih jedan zajednički formatirač za sve štampe u aplikaciji.
  line(companyAddressLine(issuer.address, issuer.postalCode, issuer.city));
  line(issuer.businessActivity);
  line(
    [
      issuer.taxId ? `PIB: ${issuer.taxId}` : null,
      issuer.registrationNumber ? `MB: ${issuer.registrationNumber}` : null,
    ]
      .filter(Boolean)
      .join("   ·   "),
  );
  line(issuer.bankAccount ? `Tekući račun: ${issuer.bankAccount}` : null);
  line(
    [issuer.phone ? `Tel: ${issuer.phone}` : null, issuer.email]
      .filter(Boolean)
      .join("   ·   "),
  );
  if (issuer.isFallback) {
    issuerLines.push({
      text: "(podaci firme nisu podešeni — dokument nije za predaju)",
      style: "warn",
    });
  }

  const rightStack: Content[] = [
    { text: sanitizeText(title), style: "title", alignment: "right" },
  ];
  if (subtitle)
    rightStack.push({
      text: sanitizeText(subtitle),
      style: "subtitle",
      alignment: "right",
    });
  for (const extra of extraLines ?? [])
    if (extra && extra.trim())
      rightStack.push({
        text: sanitizeText(extra),
        style: "subtitle",
        alignment: "right",
      });
  if (formCode)
    rightStack.push({
      text: formCode,
      style: "legalForm",
      alignment: "right",
      margin: [0, 4, 0, 0],
    });
  for (const b of Array.isArray(badge) ? badge : badge ? [badge] : [])
    rightStack.push(buildStatusBadge(b));
  if (barcodeSvg)
    rightStack.push({
      svg: barcodeSvg,
      fit: [compact ? 150 : 180, 34],
      alignment: "right",
      margin: [0, 6, 0, 0],
    });

  return {
    columns: [
      {
        width: compact ? 210 : 250,
        stack: [
          { image: SERVOTEH_LOGO_DATA_URL, width: LOGO_WIDTH },
          ...issuerLines,
        ],
      },
      { width: "*", stack: rightStack },
    ],
    columnGap: 12,
    margin: [0, 0, 0, 10],
  };
}

// ────────────────────────────────────────────────────────── zbirovi / kontrole

/**
 * Zbir NAD ZAOKRUŽENIM iznosima stavki. Red UKUPNO mora biti jednak zbiru
 * odštampane kolone — inače dobavljač koji sabere kolonu dobije drugi broj.
 */
export function sumRounded(values: Num[], decimals = 2): Prisma.Decimal {
  return values.reduce<Prisma.Decimal>(
    (acc, v) => acc.plus(toDec(v).toDecimalPlaces(decimals)),
    new Prisma.Decimal(0),
  );
}

/**
 * Tolerancija kontrolnog reda mora da RASTE sa brojem stavki: svaka stavka
 * nosi do pola pare zaokružne razlike, pa fiksni prag na 40 stavki lažno pali
 * „NEUSKLAĐENO" nad savršeno ispravnim podacima.
 */
export function roundingTolerance(
  rowCount: number,
  perRow = 0.01,
): Prisma.Decimal {
  return new Prisma.Decimal(perRow).mul(Math.max(1, rowCount));
}

/**
 * Kontrolni red KNJIGE (dnevnik, nalog): Σ duguje mora biti = Σ potražuje.
 * NE koristiti na kartici — tamo razlika NIJE greška nego saldo.
 */
export function buildControlNote(
  rowCount: number,
  totalDebit: Prisma.Decimal,
  totalCredit: Prisma.Decimal,
): Content {
  const diff = totalDebit.sub(totalCredit);
  const base =
    `Redova: ${rowCount} · Σ duguje ${fmtMoney(totalDebit)} · ` +
    `Σ potražuje ${fmtMoney(totalCredit)} · razlika ${fmtMoney(diff)}`;
  if (diff.isZero()) {
    return {
      text: `${base} — usklađeno.`,
      style: "note",
      margin: [0, 8, 0, 0],
    };
  }
  return {
    text: `${base} — NEUSKLAĐENO (Σ duguje ≠ Σ potražuje).`,
    style: "noteWarn",
    margin: [0, 8, 0, 0],
  };
}

/**
 * Kontrolni red KARTICE (konto, komitent, artikal): razlika je SALDO, ne greška.
 * Nikad ne ispisuje „NEUSKLAĐENO" — kartica sa saldom je normalno stanje.
 */
export function buildCardControlNote(
  rowCount: number,
  totalDebit: Prisma.Decimal,
  totalCredit: Prisma.Decimal,
): Content {
  const bal = totalDebit.sub(totalCredit);
  const side = bal.isZero()
    ? "izravnato"
    : bal.isPositive()
      ? "dugovni saldo"
      : "potražni saldo";
  return {
    text:
      `Redova: ${rowCount} · Σ duguje ${fmtMoney(totalDebit)} · ` +
      `Σ potražuje ${fmtMoney(totalCredit)} · saldo ${fmtMoney(bal.abs())} (${side}).`,
    style: "note",
    margin: [0, 8, 0, 0],
  };
}
