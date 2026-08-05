import { Prisma } from "@prisma/client";
import { XmlDocument, type XmlElement } from "xmldoc";

import { grossToNet } from "../pdv/vat-bridge.util";
import { vatSummaryMismatch, vatSummaryRows } from "./print/templates/totals";
import type { PrintCtx, PrintLine } from "./print/templates/ctx";
import {
  UblBuilderService,
  type UblBuildParams,
  type UblInvoiceItemInput,
} from "./sef/ubl-builder.service";
import {
  documentVatBreakdown,
  documentVatTotals,
  VAT_RATE_BY_CODE,
  vatCategoryOf,
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
 * je za sebe prolazio svoj test; razilazili su se tek KAD SE UPOREDE.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * 🔴 ZAŠTO JE PREKROJENA (sedmi krug, 02.08.2026, nalaz Z6) — BRANA JE BILA SLEPA
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * Prethodna verzija je zaglavlje redovnog računa PRAVILA POZIVOM `documentVatTotals` nad
 * ISTIM redovima koje kasnije dobija `vatBreakdown`. Posledice, izmerene:
 *
 *  1. Razlika je bila IDENTIČKI NULA, pa se grana zaglađivanja za redovne dokumente
 *     NIKAD nije izvršila (200/200 redovnih dokumenata u generatoru imalo je drift 0,00).
 *  2. A kad zaglađivanje radi, provera je bila TAUTOLOŠKA: `Σ vat` po grupama je po
 *     konstrukciji `= documentVatTotal = doc.vatTotal`, što je tačno ono što
 *     `headerTrojac` vraća — poređenje ne može da padne.
 *
 * Zato su oba scenarija iz nalaza Z1 (20 × 1.000,00 uz `vat_total = 3.999,80` i
 * 100 × 1.000,00 uz `vat_total = 19.999,00`) prolazila kroz celu branu.
 *
 * OD SEDMOG KRUGA ZAGLAVLJE DOLAZI IZ NEZAVISNOG IZVORA — kao što u životu i dolazi, iz
 * KOLONA U BAZI. U testu ga daje `referenceHeader`: DRUGA implementacija istog pravila,
 * napisana ovde po opisu iz `vat-totals.ts` i bez ijednog poziva modula koji se proverava.
 * Generator uz to namerno KVARI zaglavlje (drift preko tolerancije), pravi NEGATIVNE
 * osnovice (storno / knjižno odobrenje) i REDOVE OD 0,00 (rabat 100 %).
 *
 * ŠTA OVA BRANA NE POKRIVA: izgled rekapitulacije opšteg renderera (AVR/KO/KZ) — ona se
 * meri nad STVARNIM pdfmake stablom u `print/invoice-pdf.legacy-forms.spec.ts`. Ovde se
 * proverava poziv koji ta metoda radi (`documentVatBreakdown`).
 */

const D = (v: string | number): Prisma.Decimal => new Prisma.Decimal(v);
const ZERO = D(0);
const ubl = new UblBuilderService();

function round2(v: Prisma.Decimal): Prisma.Decimal {
  return v.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
}

// ───────────────────────────────────────────────────────────────────── model dokumenta

interface DocLine {
  vatRateCode: string;
  vatBase: Prisma.Decimal;
}

interface Doc {
  documentType: string;
  isExport: boolean;
  lines: DocLine[];
  /** ZAGLAVLJE — u životu kolone u bazi; ovde NIKAD rezultat modula koji se proverava. */
  netTotal: Prisma.Decimal;
  vatTotal: Prisma.Decimal;
  grossTotal: Prisma.Decimal;
}

/**
 * NEZAVISNO ZAGLAVLJE — druga implementacija pravila iz `vat-totals.ts`:
 *
 *   osnovica_grupe = Σ round2(osnovica stavke)     grupa = (kategorija, stopa)
 *   PDV_grupe      = round2(osnovica_grupe × stopa)
 *   net = Σ osnovica_grupa    vat = Σ PDV_grupa    gross = net + vat
 *
 * ⚠️ NAMERNO NE ZOVE `documentVatTotals` ni `vatBreakdown` (nalaz Z6): kad zaglavlje daje
 * ista funkcija koja se posle proverava, poređenje ne meri ništa. Jedino što deli sa
 * modulom je MAPA STOPA (`VAT_RATE_BY_CODE`) — ona je podatak, a ne račun koji se ovde
 * proverava; da je i ona prepisana, test bi zastario uz prvu ispravku tarifa.
 */
function referenceHeader(
  lines: DocLine[],
  isExport: boolean,
): {
  netTotal: Prisma.Decimal;
  vatTotal: Prisma.Decimal;
  grossTotal: Prisma.Decimal;
} {
  const bases = new Map<
    string,
    { pct: Prisma.Decimal; base: Prisma.Decimal }
  >();
  for (const l of lines) {
    const pct = isExport ? ZERO : vatPercentOf(l.vatRateCode);
    const category = vatCategoryOf(pct, isExport);
    const key = `${category}|${pct.toFixed(2)}`;
    const acc = bases.get(key) ?? { pct, base: ZERO };
    acc.base = acc.base.add(round2(l.vatBase));
    bases.set(key, acc);
  }
  let netTotal = ZERO;
  let vatTotal = ZERO;
  for (const g of bases.values()) {
    netTotal = netTotal.add(g.base);
    vatTotal = vatTotal.add(round2(g.base.mul(g.pct).div(100)));
  }
  return { netTotal, vatTotal, grossTotal: netTotal.add(vatTotal) };
}

/** ZDRAV redovan račun: zaglavlje je ono što nezavisna referenca kaže. */
function healthyDoc(lines: DocLine[], isExport = false): Doc {
  return {
    documentType: isExport ? "IZVRO" : "IFR",
    isExport,
    lines,
    ...referenceHeader(lines, isExport),
  };
}

/**
 * POKVAREN redovan račun: `vat_total` (a po potrebi i `net_total`) je pomeren, ali je
 * zaglavlje INTERNO DOSLEDNO — `gross = net + vat`, baš kako ga piše i uvoz i ručna
 * izmena kroz UI. Upravo zato stari kontrolni red (`Σosn + Σpdv − gross`) ovo nije mogao
 * da vidi: taj izraz je tada identički nula.
 */
function brokenDoc(
  lines: DocLine[],
  shift: { vat?: string; net?: string },
  isExport = false,
): Doc {
  const ref = referenceHeader(lines, isExport);
  const netTotal = ref.netTotal.add(D(shift.net ?? "0"));
  const vatTotal = ref.vatTotal.add(D(shift.vat ?? "0"));
  return {
    documentType: isExport ? "IZVRO" : "IFR",
    isExport,
    lines,
    netTotal,
    vatTotal,
    grossTotal: netTotal.add(vatTotal),
  };
}

/**
 * AVANSNI račun — jedini dokument koji porez IZVODI IZ BRUTA. Zaglavlje piše
 * `AdvanceInvoiceService.splitAdvance` kroz `grossToNet`: bruto je dat (uplata), osnovica
 * se deli, porez je RAZLIKA. Jedna stavka i JEDNA stopa, kao u bazi (v. `splitAdvance`:
 * „avans nosi JEDNU stopu").
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

function printCtx(doc: Doc): PrintCtx {
  return {
    invoice: {
      documentType: doc.documentType,
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
}

/** PAPIR — zbirni blok četiri donesena obrasca (`totals.ts`). */
function paperTrojac(doc: Doc): Trojac {
  const rows = vatSummaryRows(printCtx(doc));
  const base = rows.reduce((s, r) => s.add(r.base), ZERO);
  const vat = rows.reduce((s, r) => s.add(r.vat), ZERO);
  return {
    base: base.toFixed(2),
    vat: vat.toFixed(2),
    gross: base.add(vat).toFixed(2),
  };
}

/** KONTROLNI RED papira — `null` kad se zbirni blok slaže sa zaglavljem. */
function paperMismatch(doc: Doc): { base: string; vat: string } | null {
  const m = vatSummaryMismatch(printCtx(doc));
  return m ? { base: m.baseDiff.toFixed(2), vat: m.vatDiff.toFixed(2) } : null;
}

/** REKAPITULACIJA opšteg renderera — isti poziv koji radi `InvoicePdfService`. */
function recapTrojac(doc: Doc): Trojac {
  const groups = documentVatBreakdown(doc, doc.lines);
  const base = groups.reduce((s, g) => s.add(g.base), ZERO);
  const vat = groups.reduce((s, g) => s.add(g.vat), ZERO);
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
    ZERO,
  );
  const vat = subtotals.reduce(
    (s, st) => s.add(D(findFirst(st, "cbc:TaxAmount")?.val ?? "0")),
    ZERO,
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

/** Σ poreza po grupama u e-fakturi, bez BR-CO-14 brane (za pokvarene dokumente). */
function ublGroupVat(doc: Doc): string {
  const root = new XmlDocument(ublXml(doc));
  const taxTotal = findFirst(root, "cac:TaxTotal");
  if (!taxTotal) throw new Error("nema cac:TaxTotal");
  return elementChildren(taxTotal)
    .filter((c) => c.name === "cac:TaxSubtotal")
    .reduce(
      (s, st) => s.add(D(findFirst(st, "cbc:TaxAmount")?.val ?? "0")),
      ZERO,
    )
    .toFixed(2);
}

/** ZDRAV dokument: sve četiri tvrdnje o njemu, u jednom pozivu. */
function expectSlaganje(doc: Doc): Trojac {
  const header = headerTrojac(doc);
  expect(paperTrojac(doc)).toEqual(header);
  expect(recapTrojac(doc)).toEqual(header);
  expect(ublTrojac(doc)).toEqual(header);
  expect(paperMismatch(doc)).toBeNull();
  // Bruto MORA da bude zbir — inače se „slažu" oko netačnog dokumenta.
  expect(D(header.base).add(D(header.vat)).toFixed(2)).toBe(header.gross);
  return header;
}

/**
 * POKVAREN dokument: nijedan potrošač ne sme da PONOVI pogrešno zaglavlje. Papir i
 * e-faktura moraju da nose ono što osnovice po stopi daju, papir mora da prijavi razliku,
 * a e-faktura mora da padne na BR-CO-14 (SEF je odbija) — umesto da prođe kao ispravna.
 */
function expectVidljivoNeslaganje(doc: Doc): void {
  const ref = referenceHeader(doc.lines, doc.isExport);
  const honest = {
    base: ref.netTotal.toFixed(2),
    vat: ref.vatTotal.toFixed(2),
    gross: ref.grossTotal.toFixed(2),
  };
  expect(paperTrojac(doc)).toEqual(honest);
  expect(recapTrojac(doc)).toEqual(honest);
  expect(ublGroupVat(doc)).toBe(honest.vat);

  const mismatch = paperMismatch(doc);
  expect(mismatch).not.toBeNull();
  expect(mismatch).toEqual({
    base: ref.netTotal.sub(doc.netTotal).toFixed(2),
    vat: ref.vatTotal.sub(doc.vatTotal).toFixed(2),
  });

  // Ako se raziđe SAMO porez, e-faktura obara BR-CO-14 i SEF je ne prima.
  if (!ref.vatTotal.equals(doc.vatTotal)) {
    expect(() => ublTrojac(doc)).toThrow(/BR-CO-14/);
  }
}

// ─────────────────────────────────────────────────────────────────────────────

describe("PDV trojac — zaglavlje, papir i e-faktura govore isti broj", () => {
  it("nezavisna referenca i `documentVatTotals` daju isto zaglavlje (zdrav dokument)", () => {
    // Jedina tvrdnja u fajlu koja poredi DVE implementacije istog pravila. Sve ostalo
    // koristi referencu kao IZVOR zaglavlja — v. nalaz Z6 u uvodu.
    const lines = [
      { vatRateCode: "3", vatBase: D("100.03") },
      { vatRateCode: "6", vatBase: D("100.03") },
      { vatRateCode: "4", vatBase: D("100.05") },
      { vatRateCode: "0", vatBase: D("50.01") },
      { vatRateCode: "3", vatBase: D("0.00") },
      { vatRateCode: "3", vatBase: D("-100.03") },
    ];
    const ref = referenceHeader(lines, false);
    const t = documentVatTotals(lines);
    expect(ref.netTotal.toFixed(2)).toBe(t.netTotal.toFixed(2));
    expect(ref.vatTotal.toFixed(2)).toBe(t.vatTotal.toFixed(2));
    expect(ref.grossTotal.toFixed(2)).toBe(t.grossTotal.toFixed(2));
  });

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

    const doc = healthyDoc([
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
    const doc = healthyDoc([
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
    const doc = healthyDoc(
      [1, 2, 3, 4, 5].map(() => ({ vatRateCode: "3", vatBase: D("100.01") })),
    );
    expect(expectSlaganje(doc)).toEqual({
      base: "500.05",
      vat: "100.01",
      gross: "600.06",
    });
  });

  it("izvozni račun — sve u kategoriju Z, bez poreza", () => {
    const doc = healthyDoc(
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

  // ───────────────────────────────────────────────────────────────────────────
  // 🔴 NALAZ Z1 (sedmi krug) — POGREŠAN `vat_total` NA REDOVNOM RAČUNU
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Oba scenarija su IZMERENA izvršavanjem stvarnih modula. Do sedmog kruga su prolazila
   * kroz celu ovu branu: zaglavlje je pravila ista funkcija koja se posle proverava, pa
   * pogrešnog `vat_total` u testu uopšte nije ni moglo da bude (nalaz Z6).
   */
  it("🔴 Z1 — 20 × 1.000,00 @ 20 % uz `vat_total` 3.999,80: 0,20 se NE guta", () => {
    const doc = brokenDoc(
      Array.from({ length: 20 }, () => ({
        vatRateCode: "3",
        vatBase: D("1000.00"),
      })),
      { vat: "-0.20" },
    );
    expect(headerTrojac(doc).vat).toBe("3999.80");
    // Tačan porez je 4.000,00; stari pojas (`0,01 × 20 redova` = 0,20) ga je usisao
    // i papir je štampao 3.999,80, bez ijednog upozorenja.
    expect(paperTrojac(doc).vat).toBe("4000.00");
    expectVidljivoNeslaganje(doc);
  });

  it("🔴 Z1 — 100 × 1.000,00 @ 20 % uz `vat_total` 19.999,00: 1,00 RSD se NE guta", () => {
    const doc = brokenDoc(
      Array.from({ length: 100 }, () => ({
        vatRateCode: "3",
        vatBase: D("1000.00"),
      })),
      { vat: "-1.00" },
    );
    expect(paperTrojac(doc).vat).toBe("20000.00");
    expectVidljivoNeslaganje(doc);
  });

  /**
   * 🔴 POJAČIVAČ A uz Z1: meta razlike se birala po NAJVEĆOJ OSNOVICI, bez ikakve veze sa
   * iznosom koji joj se dodaje. 99 redova @ 0 % × 100,00 + 1 red @ 20 % sa osnovicom
   * 0,05 uz `vat_total = 1,01` davalo je red `20 % | 0,05 | 1,01` — efektivna stopa
   * **2020 %**, na papiru, bez upozorenja.
   */
  it("🔴 Z1/A — 99 redova @ 0 % + red od 0,05 @ 20 %: papir ne štampa stopu od 2020 %", () => {
    const lines: DocLine[] = Array.from({ length: 99 }, () => ({
      vatRateCode: "0",
      vatBase: D("100.00"),
    }));
    lines.push({ vatRateCode: "3", vatBase: D("0.05") });
    const doc = brokenDoc(lines, { vat: "+1.00" });

    expect(headerTrojac(doc).vat).toBe("1.01");
    const rows = vatSummaryRows(printCtx(doc));
    const taxed = rows.find((r) => r.rate === 20);
    expect(taxed?.base.toFixed(2)).toBe("0.05");
    expect(taxed?.vat.toFixed(2)).toBe("0.01"); // NE 1,01
    expectVidljivoNeslaganje(doc);
  });

  /**
   * 🔴 POJAČIVAČ B uz Z1: pojas je rastao po `lines.length`, a red sa osnovicom 0,00 je
   * legitiman (rabat 100 %). 1 red od 1.000,00 uz 500 praznih redova davao je toleranciju
   * 5,01 RSD, pa je `vat_total = 194,99` (tačno 200,00) prolazio nemo.
   */
  it("🔴 Z1/B — 500 redova od 0,00 ne smeju da rašire pojas (194,99 umesto 200,00)", () => {
    const lines: DocLine[] = [{ vatRateCode: "3", vatBase: D("1000.00") }];
    for (let i = 0; i < 500; i += 1)
      lines.push({ vatRateCode: "3", vatBase: D("0.00") });
    const doc = brokenDoc(lines, { vat: "-5.01" });

    expect(headerTrojac(doc).vat).toBe("194.99");
    expect(paperTrojac(doc).vat).toBe("200.00");
    expectVidljivoNeslaganje(doc);
  });

  it("razišla se OSNOVICA, a ne porez — kontrolni red to i dalje vidi", () => {
    // Stari kontrolni red je merio `Σosn + Σpdv − bruto`; kad je zaglavlje interno
    // dosledno, taj izraz je nula i za ovaj slučaj.
    const doc = brokenDoc([{ vatRateCode: "3", vatBase: D("1000.00") }], {
      net: "-0.50",
    });
    expect(paperMismatch(doc)).toEqual({ base: "0.50", vat: "0.00" });
  });

  /**
   * NASUMIČNI DOKUMENTI — četiri vrste u smeni: avans (jedini put deljenja), zdrav
   * redovan, POKVAREN redovan (drift preko tolerancije) i zdrav ogledalski (negativne
   * osnovice). Svaki dokument dobija i redove od 0,00. Seme je fiksno, pa je svaki pad
   * ponovljiv.
   */
  it("400 nasumičnih dokumenata (avansi, pokvarena zaglavlja, minus i nule)", () => {
    const CODES = [...Object.keys(VAT_RATE_BY_CODE), "", "XX"];
    let seed = 20260802;
    const rnd = () => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return Math.abs(seed) / 2147483648;
    };

    /** Redovi: uvek bar jedan sa iznosom, uz nule i (po potrebi) minus. */
    const makeLines = (negative: boolean): DocLine[] => {
      const lines: DocLine[] = [];
      const n = 1 + Math.floor(rnd() * 12);
      for (let i = 0; i < n; i += 1) {
        const zero = rnd() < 0.25; // rabat 100 % — legitiman red bez iznosa
        const sign = negative ? -1 : 1;
        lines.push({
          vatRateCode: CODES[Math.floor(rnd() * CODES.length)],
          vatBase: zero
            ? D("0.00")
            : D((sign * (rnd() * 5000 + 0.01)).toFixed(2)),
        });
      }
      if (lines.every((l) => l.vatBase.isZero()))
        lines.push({
          vatRateCode: "3",
          vatBase: D(negative ? "-123.45" : "123.45"),
        });
      return lines;
    };

    const counts = { advance: 0, healthy: 0, broken: 0, mirror: 0 };
    let brokenWithVatDrift = 0;
    let zeroLines = 0;
    let negativeLines = 0;

    for (let n = 0; n < 400; n += 1) {
      switch (n % 4) {
        case 0: {
          counts.advance += 1;
          const gross = (rnd() * 50000 + 1).toFixed(2);
          expectSlaganje(advanceDoc(gross, rnd() < 0.5 ? "3" : "4"));
          break;
        }
        case 1: {
          counts.healthy += 1;
          const lines = makeLines(false);
          zeroLines += lines.filter((l) => l.vatBase.isZero()).length;
          expectSlaganje(healthyDoc(lines, rnd() < 0.15));
          break;
        }
        case 2: {
          counts.broken += 1;
          const lines = makeLines(false);
          // Drift PREKO svake tolerancije: 0,51–5,50 RSD (tolerancija je najviše
          // `0,005 × broj redova sa iznosom`, a redova je najviše 13).
          const shift = (rnd() * 5 + 0.51).toFixed(2);
          const onVat = rnd() < 0.7;
          if (onVat) brokenWithVatDrift += 1;
          expectVidljivoNeslaganje(
            brokenDoc(
              lines,
              onVat
                ? { vat: rnd() < 0.5 ? shift : `-${shift}` }
                : { net: rnd() < 0.5 ? shift : `-${shift}` },
            ),
          );
          break;
        }
        default: {
          counts.mirror += 1;
          const lines = makeLines(true);
          negativeLines += lines.filter((l) => l.vatBase.isNegative()).length;
          expectSlaganje(healthyDoc(lines));
          break;
        }
      }
    }

    expect(counts).toEqual({
      advance: 100,
      healthy: 100,
      broken: 100,
      mirror: 100,
    });
    // Generator STVARNO proizvodi ono zbog čega postoji (nalaz Z6: stari je proizvodio
    // isključivo dokumente sa driftom 0,00).
    expect(brokenWithVatDrift).toBeGreaterThan(50);
    expect(zeroLines).toBeGreaterThan(50);
    expect(negativeLines).toBeGreaterThan(50);
  });

  /**
   * 🔴 NALAZ Z5 — OGLEDALSKI PAR. Faktura i njeno knjižno odobrenje moraju da se ponište
   * PO STOPI, ne samo u dokumentarnom zbiru: KIF i POPDV se vode po stopi, pa je razlika
   * koja preživi trajan ostatak. Meta razlike se birala po `greaterThan` nad osnovicom, a
   * to kod negativnih iznosa bira NAJMANJU po apsolutnoj vrednosti — suprotno od
   * obrazloženja; izmereno je ostajalo ±0,02 po stopi.
   */
  it("🔴 Z5 — avans i njegovo ogledalo se poništavaju PO STOPI (do pare)", () => {
    const plus = advanceDoc("132.03");
    const minus: Doc = {
      ...plus,
      lines: plus.lines.map((l) => ({ ...l, vatBase: l.vatBase.neg() })),
      netTotal: plus.netTotal.neg(),
      vatTotal: plus.vatTotal.neg(),
      grossTotal: plus.grossTotal.neg(),
    };
    expectSlaganje(plus);
    expectSlaganje(minus);

    const a = documentVatBreakdown(plus, plus.lines);
    const b = documentVatBreakdown(minus, minus.lines);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a[0].base.add(b[0].base).toFixed(2)).toBe("0.00");
    expect(a[0].vat.add(b[0].vat).toFixed(2)).toBe("0.00");
  });
});
