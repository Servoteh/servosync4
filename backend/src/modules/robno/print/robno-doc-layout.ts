import { Prisma } from "@prisma/client";
import type {
  Content,
  StyleDictionary,
  TableCell,
  TableLayout,
} from "pdfmake/interfaces";
import { SERVOTEH_LOGO_DATA_URL } from "../../documents/servoteh-logo";
import type { PrismaService } from "../../../prisma/prisma.service";
import {
  BADGE_PALETTE,
  BASE_STYLES,
  LOGO_WIDTH,
  TABLE_LAYOUT as SHARED_TABLE_LAYOUT,
  amountInWords,
  sanitizeText,
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

export interface IssuerInfo {
  companyName: string;
  address: string | null;
  city: string | null;
  taxId: string | null;
  registrationNumber: string | null;
  bankAccount: string | null;
  phone: string | null;
  email: string | null;
  businessActivity: string | null;
  /** true = tabela `companies` nema red — zaglavlje nosi vidljivo upozorenje, ne tihi fallback. */
  isFallback: boolean;
}

/**
 * Podaci firme izdavaoca. Dokument vezan za firmu → `companyId`; kad tog reda nema
 * (robno je jednofirmno, companyId=0), uzima se primarna firma po najmanjem id.
 *
 * NIKAD tihi fallback: kad u bazi nema nijedne firme, vraća se `isFallback: true`, pa
 * zaglavlje ispisuje „(podaci firme nisu podešeni)" — knjigovođa odmah vidi da dokument
 * nije za predaju.
 */
export async function loadIssuer(
  prisma: PrismaService,
  companyId?: number | null,
): Promise<IssuerInfo> {
  const select = {
    companyName: true,
    address: true,
    city: true,
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

/** Statusna značka dokumenta — BigBit je nema nigde (storniran i važeći izgledaju isto). */
export function buildStatusBadge(badge: DocBadge): Content {
  const c = BADGE_PALETTE[TONE_MAP[badge.tone]];
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

export interface DocHeaderArgs {
  issuer: IssuerInfo;
  title: string;
  subtitle?: string | null;
  /** Npr. „Obrazac - KL" — propisana oznaka obrasca, gore desno kao u BigBitu. */
  formCode?: string | null;
  badge?: DocBadge | null;
  /** Code 128 SVG (broj dokumenta) — desno od naslova; magacioner skenira dokument. */
  barcodeSvg?: string | null;
  /** Uža leva kolona za položene (landscape) obrasce. */
  compact?: boolean;
}

/**
 * Zaglavlje dokumenta: levo logo + memorandum firme (BigBit `Memorandum_Header_STD` skup),
 * desno naslov dokumenta, oznaka obrasca, statusna značka i barkod broja dokumenta.
 */
export function buildDocHeader(args: DocHeaderArgs): Content {
  const { issuer, title, subtitle, formCode, badge, barcodeSvg, compact } =
    args;

  const issuerLines: Content[] = [
    { text: issuer.companyName, style: "issuerName" },
  ];
  const line = (t: string | null | undefined) => {
    if (t && t.trim())
      issuerLines.push({ text: t.trim(), style: "issuerLine" });
  };
  line([issuer.address, issuer.city].filter(Boolean).join(", "));
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
  if (formCode)
    rightStack.push({
      text: formCode,
      style: "legalForm",
      alignment: "right",
      margin: [0, 4, 0, 0],
    });
  if (badge) rightStack.push(buildStatusBadge(badge));
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
