import type { Content, TDocumentDefinitions } from "pdfmake/interfaces";
import { companyAddressLine } from "../../../common/company-address";
import { SERVOTEH_LOGO_DATA_URL } from "../../documents/servoteh-logo";
import {
  BADGE_PALETTE,
  BASE_STYLES,
  LOGO_WIDTH,
  sanitizeText,
} from "../../documents/doc-layout";

/**
 * IZGLED ŠTAMPE — Nabavka i SEF.
 * ==============================
 * TEMA I FORMATIRANJE dolaze iz `documents/doc-layout` (jedan izvor istine za
 * celu aplikaciju: marže, logo 128 px, paleta stilova, prelom tabele, noga sa
 * „strana N/M", novac `1.234.567,89`, datum `dd.MM.yyyy.`, iznos u slovima).
 *
 * Ovde ostaju gradiči nabavnih obrazaca: zaglavlje sa meta-parovima desno,
 * blok naručilac/dobavljač, traka filtera i uokvirena napomena o praznom
 * dokumentu. Renderer je i dalje isključivo `PdfService` (pdfmake 0.3).
 */

export {
  PAGE_MARGINS,
  PAGE_PORTRAIT,
  PAGE_LANDSCAPE,
  DEFAULT_STYLE,
  LOGO_WIDTH,
  TABLE_LAYOUT,
  GRID_LAYOUT,
  TABLE_H_PADDING,
  fmtDate,
  fmtDateTime,
  fmtMoney,
  fmtMoneyOrBlank,
  fmtQty,
  fmtPercent,
  toDec,
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

// ─────────────────────────────────────────────────────────────── tema / stilovi

/** Paleta stilova nabavnih štampi — zajednička osnova + poravnanja zbirova. */
export const DOC_STYLES: TDocumentDefinitions["styles"] = {
  ...BASE_STYLES,
  issuerName: { fontSize: 10, bold: true },
  issuerLine: { fontSize: 7.5, color: "#555555" },
  totLbl: { fontSize: 9, bold: true, alignment: "right" },
  totVal: { fontSize: 9, bold: true, alignment: "right" },
  grand: { fontSize: 11, bold: true, alignment: "right" },
  note: { fontSize: 8, color: "#555555", margin: [0, 8, 0, 0] },
};

// ─────────────────────────────────────────────────────────────── zaglavlje

/** Podaci izdavaoca (firme) — čitaju se iz `Company`. */
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
  /** true = firma nije podešena (Company tabela prazna) → ispiši upozorenje. */
  missing?: boolean;
}

/** Podaci druge strane (dobavljač / kupac). */
export interface PartyInfo {
  name: string;
  address?: string | null;
  postalCode?: string | null;
  city?: string | null;
  country?: string | null;
  taxId?: string | null;
  registrationNumber?: string | null;
  bankAccount?: string | null;
  email?: string | null;
  phone?: string | null;
}

/** Statusna značka u zaglavlju (BigBit je NEMA — nacrt izgleda kao važeći). */
export interface StatusBadgeSpec {
  label: string;
  tone: "draft" | "danger" | "ok" | "neutral";
}

/** Nabavni rečnik tonova → zajednička paleta (`draft` = `warn`). */
const TONE_MAP: Record<StatusBadgeSpec["tone"], keyof typeof BADGE_PALETTE> = {
  draft: "warn",
  danger: "danger",
  ok: "ok",
  neutral: "neutral",
};

function issuerLines(issuer: IssuerInfo): string[] {
  return [
    companyAddressLine(issuer.address, issuer.postalCode, issuer.city),
    issuer.taxId ? `PIB: ${issuer.taxId}` : "",
    issuer.registrationNumber ? `MB: ${issuer.registrationNumber}` : "",
    issuer.bankAccount ? `Tekući račun: ${issuer.bankAccount}` : "",
    [issuer.phone ? `Tel: ${issuer.phone}` : "", issuer.email ?? ""]
      .filter(Boolean)
      .join("   ·   "),
  ].filter((l) => l.length > 0);
}

/**
 * Zaglavlje dokumenta: levo logo + memorandum firme, desno naslov, podnaslov,
 * statusna značka i meta-parovi („Broj / Datum / Valuta…").
 */
export function buildDocHeader(args: {
  title: string;
  subtitle?: string;
  issuer: IssuerInfo;
  meta?: Array<{ label: string; value: string }>;
  status?: StatusBadgeSpec;
}): Content {
  const { title, subtitle, issuer, meta = [], status } = args;

  const rightStack: Content[] = [
    { text: sanitizeText(title), style: "title", alignment: "right" },
  ];
  if (subtitle)
    rightStack.push({
      text: sanitizeText(subtitle),
      style: "subtitle",
      alignment: "right",
    });
  if (status) {
    const c = BADGE_PALETTE[TONE_MAP[status.tone]];
    rightStack.push({
      margin: [0, 4, 0, 0],
      alignment: "right",
      table: {
        body: [
          [
            {
              text: status.label,
              fontSize: 8,
              bold: true,
              color: c.text,
              fillColor: c.fill,
              alignment: "center",
              margin: [6, 2, 6, 2],
            },
          ],
        ],
      },
      layout: {
        hLineWidth: () => 0.6,
        vLineWidth: () => 0.6,
        hLineColor: () => c.border,
        vLineColor: () => c.border,
      },
    });
  }
  if (meta.length) {
    rightStack.push({
      margin: [0, 6, 0, 0],
      alignment: "right",
      columns: [
        {
          width: "*",
          stack: meta.map((m) => ({
            text: [
              { text: `${m.label}: `, style: "metaLbl" },
              { text: sanitizeText(m.value) || "—", style: "metaVal" },
            ],
            alignment: "right",
            margin: [0, 0, 0, 1] as [number, number, number, number],
          })),
        },
      ],
    });
  }

  return {
    columns: [
      {
        width: "auto",
        stack: [
          { image: SERVOTEH_LOGO_DATA_URL, width: LOGO_WIDTH },
          {
            text: issuer.companyName,
            style: "issuerName",
            margin: [0, 4, 0, 0],
          },
          ...issuerLines(issuer).map((l) => ({ text: l, style: "issuerLine" })),
          ...(issuer.missing
            ? [
                {
                  text: "(podaci firme nisu podešeni)",
                  fontSize: 7.5,
                  color: "#a00",
                  italics: true,
                },
              ]
            : []),
        ],
      },
      { width: "*", margin: [12, 0, 0, 0], stack: rightStack },
    ],
    columnGap: 8,
  };
}

/** Dvokolonski blok strana; natpisi se biraju po vrsti dokumenta (BigBit rečnik). */
export function buildParties(
  left: { title: string; party: PartyInfo | null },
  right: { title: string; party: PartyInfo | null },
): Content {
  // Bez eksplicitnog `Content` tipa: kolona nosi `width`, što `Content` unija
  // ne dozvoljava (pdfmake `Column` = Content & { width }).
  const partyStack = (title: string, party: PartyInfo | null) => {
    const lines = party
      ? [
          [party.address, party.postalCode, party.city]
            .filter(Boolean)
            .join(", "),
          party.country ?? "",
          [
            party.taxId ? `PIB: ${party.taxId}` : "",
            party.registrationNumber ? `MB: ${party.registrationNumber}` : "",
          ]
            .filter(Boolean)
            .join("   ·   "),
          party.bankAccount ? `Tekući račun: ${party.bankAccount}` : "",
          [party.phone ? `Tel: ${party.phone}` : "", party.email ?? ""]
            .filter(Boolean)
            .join("   ·   "),
        ].filter((l) => l.length > 0)
      : [];
    return {
      width: "*",
      stack: [
        {
          text: title,
          style: "sectionLbl",
          margin: [0, 0, 0, 3] as [number, number, number, number],
        },
        { text: sanitizeText(party?.name) || "—", style: "partyName" },
        ...lines.map((l) => ({ text: l, style: "partyLine" })),
      ],
    };
  };

  return {
    margin: [0, 14, 0, 12],
    columns: [
      partyStack(left.title, left.party),
      partyStack(right.title, right.party),
    ],
    columnGap: 24,
  };
}

/**
 * Traka primenjenih filtera ispod zaglavlja (BigBit `APGK_IZVStavke` ima 12 polja
 * razbacanih po zaglavlju — mi ih ispisujemo uredno). Bez ovoga izveštaj nije dokaziv.
 */
export function buildFilterStrip(
  filters: Array<{ label: string; value: string }>,
): Content {
  if (!filters.length) return { text: "" };
  return {
    margin: [0, 8, 0, 8],
    table: {
      widths: filters.map(() => "*"),
      body: [
        filters.map((f) => ({
          stack: [
            { text: f.label.toUpperCase(), style: "metaLbl" },
            { text: f.value || "sve", fontSize: 8.5, bold: true },
          ],
          margin: [4, 3, 4, 3] as [number, number, number, number],
        })),
      ],
    },
    layout: {
      hLineWidth: () => 0.5,
      vLineWidth: () => 0,
      hLineColor: () => "#dddddd",
      paddingTop: () => 0,
      paddingBottom: () => 0,
      paddingLeft: () => 0,
      paddingRight: () => 0,
      fillColor: () => "#fafafa",
    },
  };
}

/**
 * Poruka umesto prazne tabele. BigBit ćutke izbaci tabelu sa 0,00 — mi kažemo
 * jasno da stavki nema, pa dokument ne izgleda kao da su podaci izgubljeni.
 */
export function buildEmptyNotice(text: string, hint?: string): Content {
  return {
    margin: [0, 16, 0, 16],
    table: {
      widths: ["*"],
      body: [
        [
          {
            stack: [
              { text: text.toUpperCase(), style: "emptyBox" },
              ...(hint
                ? [
                    {
                      text: hint,
                      fontSize: 8,
                      color: "#666",
                      alignment: "center" as const,
                      margin: [0, 4, 0, 0] as [number, number, number, number],
                    },
                  ]
                : []),
            ],
            margin: [8, 14, 8, 14] as [number, number, number, number],
          },
        ],
      ],
    },
    layout: {
      hLineWidth: () => 0.8,
      vLineWidth: () => 0.8,
      hLineColor: () => "#e0b4b4",
      vLineColor: () => "#e0b4b4",
    },
  };
}

/** Red potpisnih mesta (1–3). Ne prelama se — `unbreakable`. */
export function buildSignatureRow(labels: string[], withStamp = true): Content {
  return {
    unbreakable: true,
    margin: [0, 34, 0, 0],
    columns: labels.map((label) => ({
      width: "*",
      stack: [
        {
          canvas: [
            { type: "line", x1: 0, y1: 0, x2: 150, y2: 0, lineWidth: 0.5 },
          ],
        },
        { text: label, style: "signLbl", margin: [0, 3, 0, 0] },
      ],
      alignment: "center" as const,
    })),
    columnGap: 16,
    ...(withStamp ? {} : {}),
  };
}

/** Mesto pečata — zaseban blok, jer ga BigBit crta uz potpis odgovornog lica. */
export function buildStampBox(): Content {
  return {
    margin: [0, 12, 0, 0],
    text: "(M.P.)",
    fontSize: 8,
    color: "#777",
  };
}
