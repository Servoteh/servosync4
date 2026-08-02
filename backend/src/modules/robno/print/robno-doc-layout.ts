import { Prisma } from "@prisma/client";
import type {
  Content,
  StyleDictionary,
  TableCell,
  TableLayout,
} from "pdfmake/interfaces";
import {
  BADGE_PALETTE,
  BASE_STYLES,
  TABLE_LAYOUT as SHARED_TABLE_LAYOUT,
  amountInWords,
  buildFormHeader,
  buildStatusBadge as buildSharedStatusBadge,
  sanitizeText,
  type IssuerInfo,
} from "../../documents/doc-layout";

/**
 * IZGLED ŠTAMPE — Robno i zalihe.
 * ===============================
 * TEMA I FORMATIRANJE dolaze iz `documents/doc-layout` (jedan izvor istine za
 * celu aplikaciju: marže, logo 128 px, paleta stilova, prelom tabele, noga sa
 * „strana N/M", novac `1.234.567,89`, datum `dd.MM.yyyy.`, iznos u slovima).
 *
 * Ovde ostaju gradiči robnih obrazaca: memorandum sa delatnošću i barkodom,
 * blok magacina, mreža popisne liste i potpisna mesta sa BigBit natpisima.
 */

export {
  PAGE_PORTRAIT,
  PAGE_LANDSCAPE,
  PAGE_MARGINS,
  DEFAULT_STYLE,
  TABLE_LAYOUT,
  COMPACT_TABLE_LAYOUT,
  GRID_LAYOUT,
  TABLE_H_PADDING,
  GRID_H_PADDING,
  fmtDate,
  fmtDateTime,
  fmtMoney,
  fmtQty,
  fmtPercent,
  amountInWords,
  buildPageFooter,
  draftWatermark,
  copyWatermark,
  copyLabel,
  safeFileName,
  sanitizeText,
  sumRounded,
  roundingTolerance,
  widthSlack,
  contentWidth,
} from "../../documents/doc-layout";

type Num = Prisma.Decimal | string | number | null | undefined;

/** Paleta stilova robnih štampi — zajednička osnova + poravnanja robnih zbirova. */
export const ROBNO_STYLES: StyleDictionary = {
  ...BASE_STYLES,
  totLbl: { fontSize: 9, bold: true, alignment: "right" },
  totVal: { fontSize: 9, bold: true, alignment: "right" },
  grand: { fontSize: 11, bold: true, alignment: "right" },
};

// ─────────────────────────────────────────────────────── podaci izdavaoca

// `IssuerInfo` živi u zajedničkom `documents/doc-layout` (koristе ga i knjige van
// robnog); ovde se samo re-eksportuje da robni pozivaoci ne menjaju uvoze.
export type { IssuerInfo };

// `loadIssuer` / `loadPrintedBy` takođe žive u zajedničkom `documents/doc-layout` —
// isti izbor firme (po `companyId`, inače najmanji id) koriste SVE štampe, pa ekran
// „Podaci firme" i papir nikad ne gledaju u različit red. Ovde samo re-eksport.
export { loadIssuer, loadPrintedBy } from "../../documents/doc-layout";

// ───────────────────────────────────────────────────────────── zaglavlje

export type BadgeTone = "neutral" | "info" | "success" | "danger";

/** Robni rečnik tonova → zajednička paleta (`success` = `ok`). */
const TONE_MAP: Record<BadgeTone, keyof typeof BADGE_PALETTE> = {
  neutral: "neutral",
  info: "info",
  success: "ok",
  danger: "danger",
};

export interface DocBadge {
  text: string;
  tone: BadgeTone;
}

/**
 * Statusna značka — zajednički crtač, uz prevod robnog tona (`success` → `ok`).
 * BigBit je nema nigde (storniran i važeći dokument tamo izgledaju isto).
 */
export function buildStatusBadge(badge: DocBadge): Content {
  return buildSharedStatusBadge({
    text: badge.text,
    tone: TONE_MAP[badge.tone],
  });
}

export interface DocHeaderArgs {
  issuer: IssuerInfo;
  title: string;
  subtitle?: string | null;
  /** Npr. „Obrazac - KL" — propisana oznaka obrasca, gore desno kao u BigBitu. */
  formCode?: string | null;
  /**
   * Jedna značka ili više njih (npr. status dokumenta + „KOPIJA · primerak br. 3"
   * iz traga štampe). Niz se ispisuje jedna ispod druge, redom kojim je predat.
   */
  badge?: DocBadge | DocBadge[] | null;
  /** Code 128 SVG (broj dokumenta) — desno od naslova; magacioner skenira dokument. */
  barcodeSvg?: string | null;
  /** Uža leva kolona za položene (landscape) obrasce. */
  compact?: boolean;
}

/**
 * Zaglavlje robnog dokumenta — TANAK OMOTAČ oko zajedničkog `buildFormHeader`.
 *
 * Izgled (logo, memorandum, naslov, oznaka obrasca, značke, barkod) živi u
 * `documents/doc-layout` i deli ga CELA aplikacija; ovde ostaje samo prevod robnog
 * rečnika tonova (`success` → `ok`), da robni pozivaoci ne moraju da ga menjaju.
 */
export function buildDocHeader(args: DocHeaderArgs): Content {
  const { badge, ...rest } = args;
  const list = Array.isArray(badge) ? badge : badge ? [badge] : [];
  return buildFormHeader({
    ...rest,
    badge: list.map((b) => ({ text: b.text, tone: TONE_MAP[b.tone] })),
  });
}

// ──────────────────────────────────────────────────── strane / meta / filteri

export interface PartyBlock {
  /** Natpis po BigBit terminologiji: „Isporučilac robe", „Kupac", „IZ MAGACINA"… */
  label: string;
  name: string;
  lines: Array<string | null | undefined>;
}

/** Dvokolonski blok strana (npr. Isporučilac ↔ Magacin, IZ magacina ↔ U magacin). */
export function buildParties(
  left: PartyBlock,
  right?: PartyBlock | null,
): Content {
  const block = (p: PartyBlock): Content => ({
    stack: [
      { text: p.label, style: "sectionLbl" },
      { text: sanitizeText(p.name) || "—", style: "partyName" },
      ...p.lines
        .filter((l): l is string => !!l && l.trim() !== "")
        .map((l) => ({ text: sanitizeText(l), style: "partyLine" })),
    ],
  });
  return {
    columns: right ? [block(left), block(right)] : [block(left), { text: "" }],
    columnGap: 24,
    margin: [0, 4, 0, 8],
  };
}

/** Meta-parovi „Broj / Datum / Magacin…" u dve kolone (obrazac iz journal-print). */
export function buildMeta(pairs: Array<[string, string]>): Content {
  const rows: TableCell[][] = [];
  for (let i = 0; i < pairs.length; i += 2) {
    const a = pairs[i];
    const b = pairs[i + 1];
    rows.push([
      { text: a[0], style: "metaLbl" },
      { text: a[1] || "—", style: "metaVal" },
      { text: b ? b[0] : "", style: "metaLbl" },
      { text: b ? b[1] || "—" : "", style: "metaVal" },
    ]);
  }
  return {
    margin: [0, 2, 0, 8],
    table: { widths: ["auto", "*", "auto", "*"], body: rows },
    layout: "lightHorizontalLines",
  };
}

/**
 * Traka primenjenih filtera ispod zaglavlja — bez nje izveštaj nije dokaziv.
 * BigBit ovo radi samo na par izveštaja i to razbacano; kod nas je uredna traka.
 */
export function buildFilterStrip(pairs: Array<[string, string]>): Content {
  const shown = pairs.filter(([, v]) => v != null && v !== "");
  if (!shown.length) return { text: "" };
  return {
    margin: [0, 0, 0, 8],
    table: {
      widths: shown.map(() => "*"),
      body: [
        shown.map(([k, v]) => ({
          stack: [
            { text: k, style: "metaLbl" },
            { text: v, fontSize: 8 },
          ],
        })),
      ],
    },
    layout: {
      hLineWidth: () => 0.4,
      vLineWidth: () => 0,
      hLineColor: () => "#dddddd",
      paddingTop: () => 3,
      paddingBottom: () => 3,
      paddingLeft: () => 0,
      paddingRight: () => 8,
    },
  };
}

// ─────────────────────────────────────────────────────────── telo / tabela

export interface DocColumn {
  header: string;
  width: string | number;
  numeric?: boolean;
}

export interface DocTableArgs {
  columns: DocColumn[];
  rows: TableCell[][];
  /** Redovi zbira — ispisuju se podebljano ispod tela, u istoj mreži. */
  totals?: TableCell[][];
  layout?: TableLayout;
  /** Dodatni red iznad zaglavlja (grupisani nadnaslovi kod popisne liste). */
  groupHeader?: TableCell[];
}

/**
 * Tabela stavki sa OBAVEZNO ponovljenim zaglavljem kolona (`headerRows`), da knjiga
 * od 20 strana ostane čitljiva. Numeričke kolone su desno poravnate.
 */
export function buildDocTable(args: DocTableArgs): Content {
  const { columns, rows, totals, groupHeader } = args;
  const headerCells: TableCell[] = columns.map((c) => ({
    text: c.header,
    style: c.numeric ? "thNum" : "th",
  }));
  const body: TableCell[][] = [];
  if (groupHeader) body.push(groupHeader);
  body.push(headerCells);
  body.push(...rows);
  if (totals) body.push(...totals);
  return {
    table: {
      headerRows: groupHeader ? 2 : 1,
      dontBreakRows: true,
      widths: columns.map((c) => c.width),
      body,
    },
    layout: args.layout ?? SHARED_TABLE_LAYOUT,
  };
}

/**
 * Dokument bez stavki se NE štampa nemo (BigBit izbaci praznu tabelu sa 0,00).
 * Ispisuje se velika napomena + eventualni primenjeni filteri.
 */
export function buildEmptyNotice(
  message: string,
  hint?: string | null,
): Content {
  return {
    margin: [0, 24, 0, 24],
    stack: [
      { text: message.toUpperCase(), style: "emptyBig" },
      hint
        ? {
            text: hint,
            style: "note",
            alignment: "center",
            margin: [0, 6, 0, 0],
          }
        : { text: "" },
    ],
  };
}

/** Napomena „Kontrolni zbir" u nozi knjige (Σ redova + Σ vrednosti). */
export function buildControlSum(parts: Array<[string, string]>): Content {
  return {
    margin: [0, 8, 0, 0],
    text: parts.map(([k, v], i) => ({
      text: `${i > 0 ? "   ·   " : ""}${k}: ${v}`,
      bold: i === 0,
    })),
    style: "note",
  };
}

/** „SLOVIMA:" red — iznos u slovima ispod zbira. */
export function buildAmountInWords(v: Num, currency = "dinara"): Content {
  return {
    margin: [0, 6, 0, 0],
    text: [
      { text: "SLOVIMA: ", bold: true, fontSize: 8 },
      { text: amountInWords(v, currency), fontSize: 8, italics: true },
    ],
  };
}

// ───────────────────────────────────────────────────────────── potpisi / noga

/**
 * Potpisna mesta (1–4) sa linijom i natpisom. Natpisi se preuzimaju DOSLOVNO iz BigBita
 * (Robu izdao / Robu primio / Preuzeo za prevoz / Kontrolisao / Odgovorno lice…).
 * Blok se ne prelama preko strane (`unbreakable`).
 */
export function buildSignatureRow(
  labels: string[],
  opts?: { stampOn?: number[] },
): Content {
  const stampOn = new Set(opts?.stampOn ?? []);
  return {
    unbreakable: true,
    margin: [0, 26, 0, 0],
    columns: labels.map((label, i) => ({
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
        },
        { text: label, style: "signLbl", width: 150, margin: [0, 3, 0, 0] },
        stampOn.has(i)
          ? { text: "(M.P.)", style: "signLbl", margin: [0, 2, 0, 0] }
          : { text: "" },
      ],
    })),
    columnGap: 18,
  };
}
