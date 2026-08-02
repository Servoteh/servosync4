import { Prisma } from "@prisma/client";
import { XmlDocument, type XmlElement } from "xmldoc";

import { grossToNet } from "../pdv/vat-bridge.util";
import { vatSummaryRows } from "./print/templates/totals";
import type { PrintCtx, PrintLine } from "./print/templates/ctx";
import {
  UblBuilderService,
  type UblBuildParams,
  type UblInvoiceItemInput,
} from "./sef/ubl-builder.service";
import {
  documentVatTotals,
  VAT_RATE_BY_CODE,
  vatBreakdown,
  vatPercentOf,
} from "./vat-totals";

/**
 * BRANA: ZAGLAVLJE, PAPIR I E-FAKTURA MORAJU REĆI ISTI TROJAC.
 * =============================================================================
 *
 * Za jedan te isti dokument moraju se poklopiti (osnovica, porez, bruto) na sva tri
 * mesta koja kupac i poreska mogu da uporede:
 *
 *   ZAGLAVLJE   `invoices.net_total / vat_total / gross_total` (ekran, saldakonti, GK)
 *   PAPIR       zbirni blok obrasca (`vatSummaryRows`) i rekapitulacija poreza
 *   E-FAKTURA   `cac:TaxSubtotal` grupe + `cac:LegalMonetaryTotal` u UBL-u za SEF
 *
 * ⚠️ ZAŠTO POSTOJI (šesti krug, 02.08.2026): pravilo „PDV se računa na dokumentu po
 * stopi" je bilo tačno, ali sprovedeno u TRI računara sa TRI ključa grupisanja — po
 * ŠIFRI (zaglavlje), po STOPI (e-faktura) i po EFEKTIVNOJ stopi iz iznosa (papir). Svaki
 * je za sebe prolazio svoj test; razilazili su se tek KAD SE UPOREDE. Zato ova brana ne
 * meri nijedan od njih posebno, nego samo njihovo slaganje — i pada ako se ikad raziđu.
 *
 * Dva izmerena scenarija su ovde kao imenovani testovi, a ne kao slučajni uzorak:
 *   • AVANS na bruto 132,03 din (porez izveden deljenjem — `grossToNet`);
 *   • RAČUN sa dve šifre iste stope (izmereno na „1" i „3" dok su obe bile 20 %).
 *
 * ŠTA OVA BRANA NE POKRIVA: rekapitulaciju opšteg renderera (AVR/KO/KZ) — ona je
 * privatna metoda `InvoicePdfService`-a, pa se meri nad STVARNIM pdfmake stablom u
 * `print/invoice-pdf.legacy-forms.spec.ts` („avans 132,03: rekapitulacija štampa …").
 * Ovde se umesto toga proverava poziv koji ta metoda radi (`vatBreakdown` sa objavljenim
 * porezom), da bi se videlo i ako se razmimoiđe sa UBL-om.
 */

const D = (v: string | number): Prisma.Decimal => new Prisma.Decimal(v);
const ubl = new UblBuilderService();

// ───────────────────────────────────────────────────────────────────── model dokumenta

interface DocLine {
  vatRateCode: string;
  vatBase: Prisma.Decimal;
}

interface Doc {
  documentType: string;
  isExport: boolean;
  lines: DocLine[];
  netTotal: Prisma.Decimal;
  vatTotal: Prisma.Decimal;
  grossTotal: Prisma.Decimal;
}

/** REDOVAN račun — zaglavlje piše `SalesService.recalcTotals` kroz `documentVatTotals`. */
function regularDoc(lines: DocLine[], isExport = false): Doc {
  const t = documentVatTotals(lines, { isExport });
  return {
    documentType: isExport ? "IZVRO" : "IFR",
    isExport,
    lines,
    netTotal: t.netTotal,
    vatTotal: t.vatTotal,
    grossTotal: t.grossTotal,
  };
}

/**
 * AVANSNI račun — zaglavlje piše `AdvanceInvoiceService.splitAdvance` kroz `grossToNet`:
 * bruto je dat (uplata), osnovica se deli, porez je RAZLIKA. Jedna stavka, kao u bazi.
 */
function advanceDoc(gross: string, vatRateCode = "3"): Doc {
  const percent = vatPercentOf(vatRateCode).toNumber();
  const { net, vat } = grossToNet(gross, percent);
  return {
    documentType: "AVR",
    isExport: false,
    lines: [{ vatRateCode, vatBase: net }],
    netTotal: net,
    vatTotal: vat,
    grossTotal: net.add(vat),
  };
}

// ─────────────────────────────────────────────────────── tri potrošača istog dokumenta

interface Trojac {
  base: string;
  vat: string;
  gross: string;
}

function headerTrojac(doc: Doc): Trojac {
  return {
    base: doc.netTotal.toFixed(2),
    vat: doc.vatTotal.toFixed(2),
    gross: doc.grossTotal.toFixed(2),
  };
}

/** PAPIR — zbirni blok četiri donesena obrasca (`totals.ts`). */
function paperTrojac(doc: Doc): Trojac {
  const ctx = {
    invoice: {
      netTotal: doc.netTotal,
      vatTotal: doc.vatTotal,
      grossTotal: doc.grossTotal,
      isExport: doc.isExport,
    },
    lines: doc.lines.map(
      (l, i) =>
        ({
          ordinal: i + 1,
          quantity: D(1),
          unitPrice: l.vatBase,
          unitPriceBeforeDiscount: null,
          discountPercent: D(0),
          lineTotal: l.vatBase,
          vatRatePercent: doc.isExport
            ? null
            : vatPercentOf(l.vatRateCode).toNumber(),
        }) as unknown as PrintLine,
    ),
  } as unknown as PrintCtx;

  const rows = vatSummaryRows(ctx);
  const base = rows.reduce((s, r) => s.add(r.base), D(0));
  const vat = rows.reduce((s, r) => s.add(r.vat), D(0));
  return {
    base: base.toFixed(2),
    vat: vat.toFixed(2),
    gross: base.add(vat).toFixed(2),
  };
}

/** REKAPITULACIJA opšteg renderera — isti poziv koji radi `InvoicePdfService`. */
function recapTrojac(doc: Doc): Trojac {
  const groups = vatBreakdown(doc.lines, {
    isExport: doc.isExport,
    documentVatTotal: doc.vatTotal,
  });
  const base = groups.reduce((s, g) => s.add(g.base), D(0));
  const vat = groups.reduce((s, g) => s.add(g.vat), D(0));
  return {
    base: base.toFixed(2),
    vat: vat.toFixed(2),
    gross: base.add(vat).toFixed(2),
  };
}

function findFirst(
  node: XmlDocument | XmlElement,
  name: string,
): XmlElement | null {
  if ((node as XmlElement).name === name) return node as XmlElement;
  for (const child of node.children) {
    const el = child as XmlElement;
    if (el.name === undefined) continue;
    const hit = findFirst(el, name);
    if (hit) return hit;
  }
  return null;
}

function elementChildren(node: XmlDocument | XmlElement): XmlElement[] {
  return node.children.filter(
    (c): c is XmlElement => (c as XmlElement).name !== undefined,
  );
}

/** E-FAKTURA — pravi UBL XML, pa se čita kao što bi ga čitao SEF. */
function ublXml(doc: Doc): string {
  const items: UblInvoiceItemInput[] = doc.lines.map((l, i) => ({
    lineNo: i + 1,
    description: `Stavka ${i + 1}`,
    unit: "kom",
    quantity: D(1),
    unitPrice: l.vatBase,
    discountPercent: D(0),
    vatRateCode: l.vatRateCode,
    vatBase: l.vatBase,
    // Namerno NETAČAN PDV stavke: UBL ga ne sme koristiti ni posredno.
    vatAmount: D("999.99"),
    lineTotal: l.vatBase,
  }));
  const params: UblBuildParams = {
    invoice: {
      documentType: doc.documentType,
      documentNumber: "T-1/26",
      documentDate: new Date(2026, 6, 1),
      currency: "RSD",
      isExport: doc.isExport,
      netTotal: doc.netTotal,
      vatTotal: doc.vatTotal,
      grossTotal: doc.grossTotal,
      // Avansni račun (386) sme bez datuma prometa — kod avansa prometa još nema;
      // svi ostali ga MORAJU imati (builder ih inače odbija).
      isPrepayment: doc.documentType === "AVR",
      supplyDate: doc.documentType === "AVR" ? null : new Date(2026, 6, 1),
    },
    items,
    supplier: {
      name: "Servoteh d.o.o.",
      taxId: "101017443",
      bankAccount: "160-110610-83",
    },
    customer: { name: "KUPAC DOO", taxId: "101010101" },
  };
  return ubl.build(params);
}

function ublTrojac(doc: Doc): Trojac {
  const root = new XmlDocument(ublXml(doc));
  const taxTotal = findFirst(root, "cac:TaxTotal");
  if (!taxTotal) throw new Error("nema cac:TaxTotal");

  const subtotals = elementChildren(taxTotal).filter(
    (c) => c.name === "cac:TaxSubtotal",
  );
  const base = subtotals.reduce(
    (s, st) => s.add(D(findFirst(st, "cbc:TaxableAmount")?.val ?? "0")),
    D(0),
  );
  const vat = subtotals.reduce(
    (s, st) => s.add(D(findFirst(st, "cbc:TaxAmount")?.val ?? "0")),
    D(0),
  );

  // BR-CO-14: zaglavlje poreza mora biti Σ grupa. Ako nije, trojac se namerno „pokvari",
  // da brana padne umesto da uporedi brojeve koje SEF ionako ne bi prihvatio.
  const headerVat = findFirst(taxTotal, "cbc:TaxAmount")?.val ?? "";
  if (headerVat !== vat.toFixed(2)) {
    throw new Error(
      `BR-CO-14: cac:TaxTotal/cbc:TaxAmount ${headerVat} != Σ TaxSubtotal ${vat.toFixed(2)}`,
    );
  }

  return {
    base: base.toFixed(2),
    vat: vat.toFixed(2),
    gross: (findFirst(root, "cbc:TaxInclusiveAmount")?.val ?? "").toString(),
  };
}

/** Sve četiri tvrdnje o jednom dokumentu, u jednom pozivu. */
function expectSlaganje(doc: Doc): Trojac {
  const header = headerTrojac(doc);
  expect(paperTrojac(doc)).toEqual(header);
  expect(recapTrojac(doc)).toEqual(header);
  expect(ublTrojac(doc)).toEqual(header);
  // Bruto MORA da bude zbir — inače se „slažu" oko netačnog dokumenta.
  expect(D(header.base).add(D(header.vat)).toFixed(2)).toBe(header.gross);
  return header;
}

// ─────────────────────────────────────────────────────────────────────────────

describe("PDV trojac — zaglavlje, papir i e-faktura govore isti broj", () => {
  it("🔴 R1/R2 — AVANS 132,03 din (porez izveden deljenjem, ne množenjem)", () => {
    const doc = advanceDoc("132.03");
    // Izmereno: `grossToNet(132,03; 20)` → 110,03 + 22,00; množenje bi dalo 22,01.
    expect(headerTrojac(doc)).toEqual({
      base: "110.03",
      vat: "22.00",
      gross: "132.03",
    });
    expectSlaganje(doc);
  });

  it("🔴 R3 — RAČUN sa dve šifre iste stope (2 × 100,03 din)", () => {
    // Izmereno na šiframa „1" i „3" (obe su tada bile 20 %). Mapa je istog dana
    // ispravljena po `R_Tarife`, pa se par izvodi iz nje — brojevi su isti, jer ključ
    // grupisanja je STOPA (uz kategoriju), a ne šifra.
    const codes = Object.keys(VAT_RATE_BY_CODE).filter((c) =>
      vatPercentOf(c).equals(20),
    );
    expect(codes.length).toBeGreaterThanOrEqual(2);

    const doc = regularDoc([
      { vatRateCode: codes[0], vatBase: D("100.03") },
      { vatRateCode: codes[1], vatBase: D("100.03") },
    ]);
    expect(expectSlaganje(doc)).toEqual({
      base: "200.06",
      vat: "40.01", // NE 40,02 (dva puta `round2` nad polovinama iste osnovice)
      gross: "240.07",
    });
  });

  it("🔴 R3 — najmanji ulaz koji obara podelu po šifri (0,01 + 0,02)", () => {
    const codes = Object.keys(VAT_RATE_BY_CODE).filter((c) =>
      vatPercentOf(c).equals(20),
    );
    const doc = regularDoc([
      { vatRateCode: codes[0], vatBase: D("0.01") },
      { vatRateCode: codes[1], vatBase: D("0.02") },
    ]);
    expect(expectSlaganje(doc)).toEqual({
      base: "0.03",
      vat: "0.01",
      gross: "0.04",
    });
  });

  it("izmereni scenario pete ispravke — 5 stavki × 100,01 din uz 20 %", () => {
    const doc = regularDoc(
      [1, 2, 3, 4, 5].map(() => ({ vatRateCode: "3", vatBase: D("100.01") })),
    );
    expect(expectSlaganje(doc)).toEqual({
      base: "500.05",
      vat: "100.01",
      gross: "600.06",
    });
  });

  it("izvozni račun — sve u kategoriju Z, bez poreza", () => {
    const doc = regularDoc(
      [
        { vatRateCode: "3", vatBase: D("1000.01") },
        { vatRateCode: "4", vatBase: D("500.05") },
      ],
      true,
    );
    expect(expectSlaganje(doc)).toEqual({
      base: "1500.06",
      vat: "0.00",
      gross: "1500.06",
    });
  });

  /**
   * NASUMIČNI DOKUMENTI — 1–12 stavki, sve poreske šifre iz mape + prazna i nepoznata,
   * i posebno AVANSI (jer samo oni idu putem deljenja). Seme je fiksno, pa je svaki pad
   * ponovljiv; sve tri strane se porede za SVAKI dokument.
   */
  it("300 nasumičnih dokumenata (uključujući avanse) — sve tri strane se slažu", () => {
    const CODES = [...Object.keys(VAT_RATE_BY_CODE), "", "XX"];
    let seed = 20260802;
    const rnd = () => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return Math.abs(seed) / 2147483648;
    };

    let advances = 0;
    for (let n = 0; n < 300; n += 1) {
      // Svaki treći dokument je AVANS — put na kom porez nastaje deljenjem.
      if (n % 3 === 0) {
        advances += 1;
        const gross = (rnd() * 50000 + 1).toFixed(2);
        const code = rnd() < 0.5 ? "3" : "4";
        expectSlaganje(advanceDoc(gross, code));
        continue;
      }
      const isExport = rnd() < 0.15;
      const lines = Array.from({ length: 1 + Math.floor(rnd() * 12) }, () => ({
        vatRateCode: CODES[Math.floor(rnd() * CODES.length)],
        vatBase: D((rnd() * 5000 + 0.01).toFixed(2)),
      }));
      expectSlaganje(regularDoc(lines, isExport));
    }
    expect(advances).toBe(100);
  });
});
