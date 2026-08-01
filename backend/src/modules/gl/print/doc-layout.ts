/**
 * IZGLED ŠTAMPE — Finansije (GL, izvodi, saldakonti).
 * ===================================================
 * TEMA I FORMATIRANJE dolaze iz `documents/doc-layout` (jedan izvor istine za
 * celu aplikaciju: marže, logo, paleta stilova, prelom tabele, noga, novac,
 * datum, iznos u slovima). Ovde ostaju samo gradiči visokog nivoa koje koriste
 * finansijske knjige — zaglavlje memoranduma, blok strana, tabela sa
 * ponovljenim zaglavljem i potpisni blok.
 */

import { Prisma } from "@prisma/client";
import type {
  Column,
  Content,
  ContentTable,
  TableCell,
} from "pdfmake/interfaces";
import { SERVOTEH_LOGO_DATA_URL } from "../../documents/servoteh-logo";
import {
  BADGE_PALETTE,
  BASE_STYLES,
  LOGO_WIDTH,
  TABLE_LAYOUT as TABLE_LAYOUT_LOCAL,
  fmtDateOrDash,
  sanitizeText,
} from "../../documents/doc-layout";

export {
  PAGE_MARGINS,
  PAGE_LANDSCAPE,
  PAGE_PORTRAIT,
  DEFAULT_STYLE,
  TABLE_LAYOUT,
  GRID_LAYOUT,
  fmtDateTime,
  fmtMoney,
  fmtMoneyOrBlank,
  fmtQty,
  fmtRate,
  fmtPercent,
  amountInWords,
  buildPageFooter,
  buildControlNote,
  buildCardControlNote,
  draftWatermark,
  sanitizeText,
  safeFileName,
  sumRounded,
  roundingTolerance,
  widthSlack,
  contentWidth,
} from "../../documents/doc-layout";

/** Finansijske knjige štampaju „—" za prazan datum (ćelija ne sme da ostane nema). */
export const fmtDate = fmtDateOrDash;

/**
 * Paleta stilova finansijskih štampi — zajednička osnova, uz jednu razliku:
 * natpis reda UKUPNO ostaje levo poravnat jer se prostire preko više kolona.
 */
export const DOC_STYLES = {
  ...BASE_STYLES,
  totLbl: { fontSize: 9, bold: true },
};

// ────────────────────────────────────────────────────────────── izdavalac

/** Firma izdavalac (zaglavlje memoranduma). `configured=false` → nema reda u `companies`. */
export interface IssuerInfo {
  companyName: string;
  address: string | null;
  city: string | null;
  taxId: string | null;
  registrationNumber: string | null;
  bankAccount: string | null;
  phone: string | null;
  email: string | null;
  configured: boolean;
}

/** Minimalni ugovor nad Prisma klijentom — samo `company.findFirst`. */
interface CompanyReader {
  company: {
    findFirst(args: unknown): Promise<{
      companyName: string;
      address: string | null;
      city: string | null;
      taxId: string | null;
      registrationNumber: string | null;
      bankAccount: string | null;
      phone: string | null;
      email: string | null;
    } | null>;
  };
}

/**
 * Podaci firme izdavaoca (primarna firma = najmanji id). Kad tabela `companies`
 * nije popunjena vraća `configured: false` — zaglavlje tada ISPISUJE napomenu
 * umesto da tiho odštampa „Servoteh d.o.o." bez PIB-a i računa.
 */
export async function loadIssuer(prisma: CompanyReader): Promise<IssuerInfo> {
  const company = await prisma.company.findFirst({
    orderBy: { id: "asc" },
    select: {
      companyName: true,
      address: true,
      city: true,
      taxId: true,
      registrationNumber: true,
      bankAccount: true,
      phone: true,
      email: true,
    },
  });
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
      configured: false,
    };
  }
  return { ...company, configured: true };
}

/** Redovi memoranduma izdavaoca (naziv je prvi red). */
export function issuerLines(issuer: IssuerInfo): string[] {
  return [
    issuer.companyName,
    [issuer.address, issuer.city].filter(Boolean).join(", "),
    issuer.taxId ? `PIB: ${issuer.taxId}` : "",
    issuer.registrationNumber ? `MB: ${issuer.registrationNumber}` : "",
    issuer.bankAccount ? `Tekući račun: ${issuer.bankAccount}` : "",
    [issuer.phone ? `Tel: ${issuer.phone}` : "", issuer.email ?? ""]
      .filter(Boolean)
      .join("   ·   "),
  ].filter((l) => l !== "");
}

// ────────────────────────────────────────────────────────────── zaglavlje

/** Statusna značka u zaglavlju (BigBit je nema — v. „Uzor" §B4). */
export interface StatusBadge {
  label: string;
  tone: "neutral" | "ok" | "warn" | "danger";
}

export interface DocHeaderArgs {
  /** Naslov dokumenta (velikim slovima). */
  title: string;
  /** Podnaslov — broj/period dokumenta. */
  subtitle?: string;
  issuer: IssuerInfo;
  /** Meta parovi ispod podnaslova („Datum knjiženja: …"). */
  meta?: Array<[string, string]>;
  badge?: StatusBadge;
}

/**
 * Zaglavlje dokumenta: levo logo + memorandum firme, desno naslov, podnaslov,
 * meta-parovi i (opciono) statusna značka.
 */
export function buildDocHeader(args: DocHeaderArgs): Content {
  const { title, subtitle, issuer, meta, badge } = args;
  const lines = issuerLines(issuer);

  const rightStack: Content[] = [
    { text: sanitizeText(title), style: "title" },
    ...(subtitle
      ? [{ text: sanitizeText(subtitle), style: "subtitle" } as Content]
      : []),
  ];

  if (meta && meta.length > 0) {
    // Meta parovi u dve kolone (levo/desno), po dva u redu.
    for (let i = 0; i < meta.length; i += 2) {
      const pair = meta.slice(i, i + 2);
      rightStack.push({
        margin: [0, i === 0 ? 6 : 2, 0, 0],
        columns: pair.map((p, idx) => ({
          width: idx === 0 && pair.length > 1 ? "*" : "auto",
          text: [
            { text: `${p[0]}: `, style: "metaLbl" },
            { text: sanitizeText(p[1]), style: "metaVal" },
          ],
        })),
      });
    }
  }

  const header: Content = {
    columns: [
      {
        width: LOGO_WIDTH + 4,
        stack: [
          { image: SERVOTEH_LOGO_DATA_URL, width: LOGO_WIDTH },
          {
            margin: [0, 4, 0, 0],
            stack: [
              { text: lines[0] ?? "", style: "partyName" },
              ...lines.slice(1).map((l) => ({ text: l, style: "issuerLine" })),
            ],
          },
        ],
      },
      { width: "*", margin: [12, 4, 0, 0], stack: rightStack },
      ...(badge ? [buildBadge(badge)] : []),
    ],
    columnGap: 8,
  };

  if (issuer.configured) return header;
  return {
    stack: [
      header,
      {
        text: "Napomena: podaci firme izdavaoca nisu podešeni (šifarnik „Firme“) — zaglavlje je nepotpuno.",
        style: "noteWarn",
        margin: [0, 4, 0, 0],
      },
    ],
  };
}

/** Uokvirena statusna značka (desni gornji ugao zaglavlja). */
function buildBadge(badge: StatusBadge): Column {
  const c = BADGE_PALETTE[badge.tone];
  return {
    width: "auto",
    margin: [8, 6, 0, 0],
    table: {
      body: [
        [
          {
            text: badge.label.toUpperCase(),
            style: "badge",
            color: c.text,
            fillColor: c.fill,
            margin: [6, 3, 6, 3],
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
  };
}

/**
 * Traka primenjenih filtera ispod zaglavlja (dokaz šta izveštaj pokriva —
 * BigBit `APGK_IZVStavke` obrazac). Prazni parovi se izostavljaju.
 */
export function buildFilterStrip(
  pairs: Array<[string, string | null | undefined]>,
): Content {
  const used = pairs.filter((p) => p[1] != null && String(p[1]).trim() !== "");
  const text = used.length
    ? used.map((p) => `${p[0]}: ${sanitizeText(String(p[1]))}`).join("   ·   ")
    : "Filteri: nisu zadati (ceo obim)";
  return {
    margin: [0, 10, 0, 0],
    table: {
      widths: ["*"],
      body: [[{ text, style: "tdMuted", margin: [4, 3, 4, 3] }]],
    },
    layout: {
      hLineWidth: () => 0.4,
      vLineWidth: () => 0,
      hLineColor: () => "#dddddd",
      paddingLeft: () => 0,
      paddingRight: () => 0,
      paddingTop: () => 0,
      paddingBottom: () => 0,
    },
  };
}

/** Dvokolonski blok strana (npr. POVERILAC / DUŽNIK). */
export function buildParties(
  left: { title: string; lines: string[] },
  right: { title: string; lines: string[] },
): Content {
  const party = (p: { title: string; lines: string[] }): Column => ({
    width: "*",
    stack: [
      { text: p.title, style: "sectionLbl", margin: [0, 0, 0, 3] },
      { text: sanitizeText(p.lines[0] ?? ""), style: "partyName" },
      ...p.lines
        .slice(1)
        .map((l) => ({ text: sanitizeText(l), style: "partyLine" })),
    ],
  });
  return {
    margin: [0, 14, 0, 4],
    columns: [party(left), party(right)],
    columnGap: 24,
  };
}

// ────────────────────────────────────────────────────────────── tabela

export interface DocColumn {
  /** Natpis kolone. */
  header: string;
  /** pdfmake širina kolone ("auto" | "*" | broj). */
  width: string | number;
  /** Numerička kolona → desno poravnanje (zaglavlje i telo). */
  numeric?: boolean;
}

/**
 * Red zaglavlja tabele. Uvek ide kao prvi red `body`-ja uz `headerRows: 1`, pa se
 * PONAVLJA na svakoj strani (dugačke knjige inače postaju nečitljive).
 */
export function headerRow(columns: DocColumn[]): TableCell[] {
  return columns.map((c) => ({
    text: c.header,
    style: "th",
    alignment: c.numeric ? ("right" as const) : ("left" as const),
  }));
}

/** Jedan red „nema stavki" preko svih kolona (prazan dokument ne sme da pukne). */
export function emptyRow(columns: DocColumn[], text: string): TableCell[] {
  const first: TableCell = {
    text,
    italics: true,
    style: "td",
    colSpan: columns.length,
    alignment: "center",
  };
  return [first, ...Array.from({ length: columns.length - 1 }, () => ({}))];
}

/**
 * Red zbira: natpis preko prvih `labelSpan` kolona, pa vrednosti u preostalim.
 * `values` mora imati tačno `columns.length - labelSpan` elemenata.
 */
export function totalRow(
  columns: DocColumn[],
  label: string,
  labelSpan: number,
  values: string[],
  style: "totLbl" | "subLbl" = "totLbl",
): TableCell[] {
  const numStyle = style === "totLbl" ? "totNum" : "subNum";
  const cells: TableCell[] = [
    { text: label, style, colSpan: labelSpan },
    ...Array.from({ length: labelSpan - 1 }, () => ({})),
  ];
  for (const v of values) cells.push({ text: v, style: numStyle });
  return cells;
}

/**
 * Tabela dokumenta sa ponovljenim zaglavljem i standardnim prelomom.
 * `dontBreakRows: true` — jedan red stavke se NE lomi preko strane (bez toga
 * nastavak opisa pada na sledeću stranu bez rednog broja i bez iznosa).
 */
export function buildDocTable(
  columns: DocColumn[],
  body: TableCell[][],
): ContentTable {
  return {
    table: {
      headerRows: 1,
      dontBreakRows: true,
      widths: columns.map((c) => c.width),
      body,
    },
    layout: TABLE_LAYOUT_LOCAL,
    margin: [0, 8, 0, 0],
  };
}

/** Velika napomena kad izveštaj nema nijednu stavku (BigBit štampa nemu nulu). */
export function buildEmptyNotice(text: string): Content {
  return { text, style: "empty", margin: [0, 24, 0, 12] };
}

// ────────────────────────────────────────────────────────────── potpisi

/**
 * Potpisni blok — 1..3 mesta sa linijom i natpisom (BigBit natpisi doslovno).
 * `unbreakable` da se blok ne prelomi preko strane.
 */
export function buildSignatureRow(
  labels: string[],
  withStamp = false,
): Content {
  const block = (label: string): Column => ({
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
      ...(withStamp ? [{ text: "(M.P.)", style: "signLbl" } as Content] : []),
    ],
  });
  return {
    unbreakable: true,
    margin: [0, 24, 0, 0],
    columns: labels.map(block),
    columnGap: 24,
  };
}

/** Zbir kolone nad Decimal vrednostima (bez Float aritmetike). */
export function sumDecimals(values: Prisma.Decimal[]): Prisma.Decimal {
  return values.reduce((a, b) => a.plus(b), new Prisma.Decimal(0));
}
