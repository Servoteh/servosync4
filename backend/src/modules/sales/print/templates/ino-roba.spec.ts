import { Prisma } from "@prisma/client";
import type { Content, TDocumentDefinitions } from "pdfmake/interfaces";
import { PdfService } from "../../../documents/pdf.service";
import { inoRobaTemplate } from "./ino-roba";
import type {
  InvoiceWithItems,
  PrintCtx,
  PrintIssuer,
  PrintLine,
} from "./ctx";

/**
 * Test-vektori su prepisani sa `docs/zahtevi/fakture-obrasci-2026-08/
 * InoFaktura GP 228-25.pdf` — računa koji je stvarno izašao kupcu. Ako neki od ovih
 * testova padne, papir bi izašao drugačiji nego original: to je greška, ne „promena
 * izgleda".
 */

// ------------------------------------------------------------------ obilazak stabla

/** Prolazi kroz pdfmake stablo (stack / columns / table.body) i zove `visit` na svakom čvoru. */
function walk(
  node: unknown,
  visit: (o: Record<string, unknown>) => void,
): void {
  if (node == null) return;
  if (Array.isArray(node)) {
    for (const n of node) walk(n, visit);
    return;
  }
  if (typeof node !== "object") return;
  const o = node as Record<string, unknown>;
  visit(o);
  for (const key of ["stack", "columns", "table", "body"]) {
    if (o[key] != null) walk(o[key], visit);
  }
}

/** Sav `text` iz stabla, da se tvrdnje pišu nad ravnim spiskom. */
function collectText(node: unknown): string[] {
  const out: string[] = [];
  walk(node, (o) => {
    if (typeof o.text === "string") out.push(o.text);
  });
  return out;
}

/** Broj `canvas` čvorova — potpisne linije su se u starom kodu crtale baš njima. */
function countCanvas(node: unknown): number {
  let n = 0;
  walk(node, (o) => {
    if (o.canvas != null) n++;
  });
  return n;
}

function renderText(ctx: PrintCtx): string {
  return collectText(inoRobaTemplate(ctx)).join("\n");
}

// ------------------------------------------------------------------ ctx sa papira

const D = (v: string) => new Prisma.Decimal(v);

/**
 * Firma izdavalac sa papira 228/25. IBAN/SWIFT/banka su ovde ključni: do ovog koraka su
 * bila mrtva polja koja `loadIssuer` nikad nije popunjavao (GAP §2.4).
 */
const SERVOTEH: PrintIssuer = {
  companyName: "Servoteh d.o.o. Dobanovci",
  address: "Ugrinovačka 163",
  city: "11272 Dobanovci",
  taxId: "101017443",
  registrationNumber: "17400169",
  bankAccount: "160-110610-83",
  phone: "+381 11 31 41 564; 373 29 59",
  fax: "+381 11 2399 265",
  email: "office@servoteh.rs",
  webAddress: "www.servoteh.rs",
  invoiceIssuingPlace: "Beograd",
  registryNumber: "01117400169",
  businessActivityCode: "3320",
  aprText:
    '"Servoteh" d.o.o. je jednočlano privredno društvo upisano u Agenciji za privredne registre pod brojem BD. 222785/2006',
  iban: "RS35160005010003501186",
  swift: "DBDBRSBG",
  bankName: "Banca Intesa a.d.",
  bankAddress: "Milentija Popovića 7b, 11070 New Belgrade\nRepublic of Serbia",
};

/** Dve stavke sa papira: 2 × 125.00 = 250.00, obe bez carinske tarife. */
const LINES: PrintLine[] = [
  {
    ordinal: 1,
    catalogNumber: "5326557-",
    name: "5326557 LL3-TV77",
    unit: "Kom",
    customsTariff: null,
    quantity: D("2"),
    unitPrice: D("125.00"),
    discountPercent: D("0"),
    lineTotal: D("250.00"),
    vatRatePercent: null,
  },
  {
    ordinal: 2,
    catalogNumber: "6063335-",
    name: "6063335 Sick GLL170-P334",
    unit: "Kom",
    customsTariff: null,
    quantity: D("2"),
    unitPrice: D("125.00"),
    discountPercent: D("0"),
    lineTotal: D("250.00"),
    vatRatePercent: null,
  },
];

/**
 * `Invoice` red ima šezdesetak kolona od kojih štampa dodiruje šačicu; test sklapa samo
 * njih i tvrdi tip. Da se ne prepisuje ceo model u svaki test.
 */
function makeInvoice(over: Record<string, unknown> = {}): InvoiceWithItems {
  return {
    id: 1,
    documentType: "IZVGP",
    documentNumber: "228/25",
    documentDate: new Date(2025, 3, 25),
    currency: "EUR",
    isExport: true,
    netTotal: D("500.00"),
    vatTotal: D("0"),
    grossTotal: D("500.00"),
    fco: "magacin kupca",
    paymentMethod: "virmanom",
    note: "Fakturisanje je izvršeno na osnovu ponude 0206-25",
    customsDeclarationNo: "25-0401-000005",
    items: [],
    ...over,
  } as unknown as InvoiceWithItems;
}

function makeCtx(over: Partial<PrintCtx> = {}): PrintCtx {
  return {
    invoice: makeInvoice(),
    lines: LINES,
    customer: {
      name: "TEHNIČKI REMONT a.d. Bratunac",
      address: "Podgradačka broj 11",
      city: "Bratunac",
      postalCode: "75420",
      taxId: null,
      registrationNumber: null,
      country: "Bosna i Hercegovina",
    },
    issuer: SERVOTEH,
    signatory: { name: "Dragana Korkut" },
    warehouseName: "Gotovi proizvodi",
    currency: "EUR",
    advanceInvoiceNumber: null,
    withoutPrices: false,
    ...over,
  };
}

// ------------------------------------------------------------------ testovi

describe("ino obrazac za robu (izvozna faktura 228/25)", () => {
  describe("zaglavlje i parovi labela/vrednost", () => {
    it("naslov je desno i glasi `Invoice No. 228/25`", () => {
      expect(renderText(makeCtx())).toContain("Invoice No. 228/25");
    });

    it("nosi svih pet labela sa papira", () => {
      const text = renderText(makeCtx());
      for (const label of [
        "Date:",
        "Customer:",
        "Address:",
        "Delivery term:",
        "Payment terms:",
      ])
        expect(text).toContain(label);
    });

    it("datum je ino oblik `25.04.2025.`", () => {
      expect(renderText(makeCtx())).toContain("25.04.2025.");
    });

    it("kupac i adresa idu kao na papiru", () => {
      const text = renderText(makeCtx());
      expect(text).toContain("TEHNIČKI REMONT a.d. Bratunac");
      expect(text).toContain("Podgradačka broj 11 - Bratunac 75420");
    });

    it("VREDNOSTI uslova ostaju na srpskom — ne prevode se", () => {
      // Dolaze iz šifarnika; prevod bi značio da papir i baza govore različito.
      const text = renderText(makeCtx());
      expect(text).toContain("magacin kupca");
      expect(text).toContain("virmanom");
      expect(text).not.toContain("customer's warehouse");
      expect(text).not.toContain("bank transfer");
    });
  });

  describe("tabela stavki", () => {
    it("ima svih osam kolona sa papira, u tom redosledu", () => {
      const texts = collectText(inoRobaTemplate(makeCtx()));
      const expected = [
        "No.",
        "Catalog No.",
        "Description",
        "Unit",
        "Stat. goods No.",
        "Quantity",
        "Price",
        "Total ( EUR)",
      ];
      const positions = expected.map((h) => texts.indexOf(h));
      expect(positions.some((p) => p < 0)).toBe(false);
      expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    });

    it("kolona `Stat. goods No.` postoji I KAD JE PRAZNA", () => {
      // Na 228/25 je prazna u obe stavke — kolona se ipak štampa, inače bi se ceo
      // raspored pomerio i obrazac više ne bi bio isti papir.
      const ctx = makeCtx();
      expect(renderText(ctx)).toContain("Stat. goods No.");
      expect(ctx.lines.every((l) => l.customsTariff == null)).toBe(true);
    });

    it("štampa carinsku tarifu kad je ima", () => {
      const ctx = makeCtx({
        lines: [{ ...LINES[0], customsTariff: "8536509000" }],
      });
      expect(renderText(ctx)).toContain("8536509000");
    });

    it("nosi brojeve sa papira: količina 2, cena 125.00, iznos 250.00", () => {
      const texts = collectText(inoRobaTemplate(makeCtx()));
      expect(texts).toContain("2"); // količina bez suvišnih nula (`2`, ne `2.000`)
      expect(texts.filter((t) => t === "125.00")).toHaveLength(2);
      expect(texts.filter((t) => t === "250.00")).toHaveLength(2);
    });

    it("kataloški broj, opis i j.m. idu doslovno sa stavke", () => {
      const text = renderText(makeCtx());
      expect(text).toContain("5326557-");
      expect(text).toContain("5326557 LL3-TV77");
      expect(text).toContain("6063335 Sick GLL170-P334");
      expect(text).toContain("Kom");
    });

    it("razlomljena količina zadržava decimale", () => {
      const ctx = makeCtx({ lines: [{ ...LINES[0], quantity: D("2.5") }] });
      expect(collectText(inoRobaTemplate(ctx))).toContain("2.5");
    });
  });

  describe("zbir", () => {
    it("štampa TOTAL / DISCOUNT / TOTAL AMOUNT ( EUR) sa razmakom iz originala", () => {
      const text = renderText(makeCtx());
      expect(text).toContain("TOTAL");
      expect(text).toContain("DISCOUNT:");
      expect(text).toContain("TOTAL AMOUNT ( EUR)");
      // Razmak u „( EUR)" je iz originala — bez njega papir nije isti.
      expect(text).not.toContain("TOTAL AMOUNT (EUR)");
    });

    it("zbir sa papira je 500.00, a rabat 0.00 (red se ne izostavlja)", () => {
      const texts = collectText(inoRobaTemplate(makeCtx()));
      expect(texts.filter((t) => t === "500.00")).toHaveLength(2); // TOTAL i TOTAL AMOUNT
      expect(texts).toContain("0.00");
    });

    it("TOTAL − DISCOUNT uvek daje TOTAL AMOUNT", () => {
      const ctx = makeCtx({
        invoice: makeInvoice({
          netTotal: D("450.00"),
          grossTotal: D("450.00"),
        }),
      });
      const texts = collectText(inoRobaTemplate(ctx));
      expect(texts).toContain("500.00"); // TOTAL = Σ količina × cena
      expect(texts).toContain("50.00"); // DISCOUNT
      expect(texts).toContain("450.00"); // TOTAL AMOUNT
    });

    it("nema NIJEDAN PDV red — izvoz je oslobođen", () => {
      const text = renderText(makeCtx());
      expect(text).not.toContain("VAT");
      expect(text).not.toContain("PDV po stopi");
      expect(text).not.toContain("Osnovica");
    });

    it("`TOTAL AMOUNT` je uokviren, a `TOTAL` i `DISCOUNT` nisu", () => {
      const boxed: string[] = [];
      const plain: string[] = [];
      walk(inoRobaTemplate(makeCtx()), (o) => {
        if (typeof o.text !== "string" || !Array.isArray(o.border)) return;
        (o.border.some(Boolean) ? boxed : plain).push(o.text);
      });
      // Jedina uokvirena ćelija na papiru je iznos uz `TOTAL AMOUNT ( EUR)`.
      expect(boxed).toEqual(["500.00"]);
      expect(plain).toEqual([
        "TOTAL",
        "500.00",
        "DISCOUNT:",
        "0.00",
        "TOTAL AMOUNT ( EUR)",
      ]);
    });
  });

  describe("slobodan tekst", () => {
    it("nosi poziv na ponudu, broj izvozne deklaracije i način plaćanja", () => {
      const text = renderText(makeCtx());
      expect(text).toContain(
        "Fakturisanje je izvršeno na osnovu ponude 0206-25",
      );
      expect(text).toContain("25-0401-000005");
      // Vrednost je „virmanom", a ne „avansno" kao na papiru, jer 4.0 model ima samo
      // jedno polje za način plaćanja (BigBit je imao payment_terms + payment_method).
      expect(text).toContain("Način plaćanja: virmanom");
    });

    it("bez podataka ne štampa prazne redove", () => {
      const ctx = makeCtx({
        invoice: makeInvoice({
          note: null,
          customsDeclarationNo: null,
          paymentMethod: null,
        }),
      });
      const text = renderText(ctx);
      expect(text).not.toContain("Način plaćanja:");
      expect(text).toContain("Invoice No. 228/25"); // ostatak papira i dalje stoji
    });
  });

  describe("poresko oslobođenje i pravne napomene", () => {
    it("koristi član 24. STAV 1 TAČKA 2 — član za ROBU", () => {
      const text = renderText(makeCtx());
      expect(text).toContain(
        "Napomena o poreskom oslobodjenju: Oslobodjeno PDV na osnovu člana 24. stav 1 tačka 2 Zakona o PDV.",
      );
    });

    it("NE koristi član za uslugu (stav 2) — pogrešan član je poreski problem", () => {
      const text = renderText(makeCtx());
      expect(text).not.toContain("člana 24. stav 2");
      expect(text.toLowerCase()).not.toContain("zakona o pdv-a");
    });

    it("blok reklamacije/sud/kamata štampa se TAČNO JEDNOM", () => {
      // U originalu je odštampan dvaput — to je greška BigBita i ne prepisuje se.
      const texts = collectText(inoRobaTemplate(makeCtx()));
      const count = (needle: string) =>
        texts.filter((t) => t.includes(needle)).length;
      expect(count("Reklamacije primamo u roku od 5 dana")).toBe(1);
      expect(count("Za sve sporove nadležan je Privredni sud.")).toBe(1);
      expect(count("propisanu zateznu kamatu")).toBe(1);
    });

    it("robna faktura ide na Privredni, ne na Trgovinski sud", () => {
      expect(renderText(makeCtx())).not.toContain("Trgovinski sud");
    });
  });

  describe("blok banke (regresija na mrtav kod)", () => {
    it("IBAN i SWIFT ZAISTA izlaze na papir", () => {
      // Zatečeni kod je imao granu za IBAN/SWIFT, ali `loadIssuer` ih nikad nije
      // popunjavao — ino fakture su izlazile bez ijedne bankarske instrukcije.
      const text = renderText(makeCtx());
      expect(text).toContain("IBAN : RS35160005010003501186");
      expect(text).toContain("SWIFT: DBDBRSBG");
    });

    it("nosi obe kolone i podatke banke sa papira", () => {
      const text = renderText(makeCtx());
      expect(text).toContain("Beneficiary Customer:");
      expect(text).toContain("Bank of beneficiary:");
      expect(text).toContain("Servoteh d.o.o. Dobanovci");
      expect(text).toContain("Ugrinovačka 163, 11272 Dobanovci");
      expect(text).toContain("Banca Intesa a.d. EUR");
      expect(text).toContain("Milentija Popovića 7b, 11070 New Belgrade");
      expect(text).toContain("Republic of Serbia");
    });

    it("ne udvaja valutu kad je već u nazivu banke", () => {
      const ctx = makeCtx({
        issuer: { ...SERVOTEH, bankName: "Banca Intesa a.d. EUR" },
      });
      expect(renderText(ctx)).not.toContain("Banca Intesa a.d. EUR EUR");
    });

    it("bez deviznih podataka se ceo blok izostavlja, bez praznih labela", () => {
      const ctx = makeCtx({
        issuer: {
          ...SERVOTEH,
          iban: null,
          swift: null,
          bankName: null,
          bankAddress: null,
        },
      });
      const text = renderText(ctx);
      expect(text).not.toContain("Beneficiary Customer:");
      expect(text).not.toContain("Bank of beneficiary:");
    });

    it("domaći tekući račun se NE štampa na ino fakturi", () => {
      // Nikad oboje na istom papiru (STAMPA_IZLAZNIH_FAKTURA.md §6 t.3).
      const text = renderText(makeCtx());
      expect(text).not.toContain("Tekući račun");
      expect(text).not.toContain("160-110610-83");
    });
  });

  describe("potpisi", () => {
    it("NEMA nijednu potpisnu liniju ni potpisni natpis", () => {
      const ctx = makeCtx();
      const text = renderText(ctx);
      for (const forbidden of [
        "Potpis",
        "Signature",
        "Odgovorno lice",
        "Robu izdao",
        "Robu primio",
        "Preuzeo za prevoz",
        "Broj l.k.",
      ])
        expect(text).not.toContain(forbidden);
      // Linije potpisa su se crtale `canvas`-om — u telu ovog obrasca ga nema uopšte.
      expect(countCanvas(inoRobaTemplate(ctx))).toBe(0);
    });

    it("ne štampa magacin — magacin ide samo na domaću robnu fakturu", () => {
      expect(renderText(makeCtx())).not.toContain("Gotovi proizvodi");
    });
  });

  describe("otpremnica (withoutPrices)", () => {
    it("izostavlja novčane kolone i ceo zbir", () => {
      const text = renderText(makeCtx({ withoutPrices: true }));
      expect(text).toContain("Stat. goods No."); // stavke ostaju
      expect(text).not.toContain("Price");
      expect(text).not.toContain("Total ( EUR)");
      expect(text).not.toContain("TOTAL AMOUNT ( EUR)");
      expect(text).not.toContain("DISCOUNT:");
    });
  });

  /**
   * Prava provera: telo mora da PROĐE kroz pdfmake. Šablon koristi samo inline svojstva
   * (bez imenovanih stilova), pa render ne zavisi od `styles` pozivaoca — ako bi neki
   * čvor bio neispravan, puklo bi baš ovde.
   */
  it("renderuje se kroz pdfmake u ispravan PDF", async () => {
    const dd: TDocumentDefinitions = {
      pageSize: "A4",
      pageMargins: [32, 32, 32, 40],
      content: inoRobaTemplate(makeCtx()) as Content[],
      defaultStyle: { font: "Roboto", fontSize: 9 },
    };
    const buffer = await new PdfService().render(dd);
    expect(buffer.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(buffer.length).toBeGreaterThan(1000);
  }, 30000);
});
