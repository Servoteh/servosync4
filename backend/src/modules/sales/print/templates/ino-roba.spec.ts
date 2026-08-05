import { Prisma } from "@prisma/client";
import type { Content, TDocumentDefinitions } from "pdfmake/interfaces";
import { PdfService } from "../../../documents/pdf.service";
import { exemptionFor } from "../../vat-exemption";
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
  companyName: "Servoteh d.o.o.",
  address: "Ugrinovačka 163",
  city: "Dobanovci",
  postalCode: "11272",
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
  // Naziv stiže GOTOV, sa valutom: sklapa ga `composeBankName` u `invoice-pdf.service.ts`,
  // i to samo kad je devizni račun baš u valuti fakture. Obrazac ga štampa doslovno
  // (v. nalaz N12/N7 — do 02.08.2026. je valutu lepio i sam, pa je USD faktura na EUR
  // računu dobijala „…a.d. EUR" uz USD IBAN).
  bankName: "Banca Intesa a.d. EUR",
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
    // Papir nema rabat — cena pre rabata je ista kao cena stavke.
    unitPriceBeforeDiscount: D("125.00"),
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
    unitPriceBeforeDiscount: D("125.00"),
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
    // Datum prometa (`supplyDate`) — obavezan element računa; papir 228/25 ga nema,
    // ali obrazac ga od 02.08.2026. štampa (v. „datum prometa" niže).
    supplyDate: new Date(2025, 3, 25),
    currency: "EUR",
    isExport: true,
    netTotal: D("500.00"),
    vatTotal: D("0"),
    grossTotal: D("500.00"),
    // Bez odbijenog avansa; testovi avansa ga postavljaju sami.
    advanceAppliedAmount: D("0"),
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
    advanceDeductions: [],
    serviceRevenueNote: null,
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

    /**
     * REGRESIJA NA STRUKTURNU NULU (02.08.2026). `unitPrice` u bazi je cena POSLE rabata
     * (`pricing.service.ts`), pa je stari `TOTAL` (Σ količina × cena) bio jednak iznosu
     * za uplatu i `DISCOUNT` je uvek ispadao `0.00` — i kad je rabat stvarno odobren.
     *
     * Ovde: dve stavke po 250,00 neto uz rabat 20 % → rabat po stavci je
     * 250 × 20 / 80 = 62,50, ukupno 125,00; `TOTAL` je onda 625,00 (cena PRE rabata).
     */
    it("TOTAL − DISCOUNT uvek daje TOTAL AMOUNT, i kad rabat postoji", () => {
      // STARE stavke: cena pre rabata nije upisana, pa se rabat vraća unazad iz neto.
      const ctx = makeCtx({
        lines: LINES.map((l) => ({
          ...l,
          discountPercent: D("20"),
          unitPriceBeforeDiscount: null,
        })),
      });
      const texts = collectText(inoRobaTemplate(ctx));
      expect(texts).toContain("625.00"); // TOTAL = iznos PRE rabata
      expect(texts).toContain("125.00"); // DISCOUNT = stvarno odobren rabat
      expect(texts).toContain("500.00"); // TOTAL AMOUNT = grossTotal sa dokumenta
    });

    /**
     * NALAZ N1 (02.08.2026): kolone `Price` i `Total ( EUR)` su nosile cenu POSLE rabata,
     * a `TOTAL` iznad njih iznos PRE rabata — pa se sa rabatom ≠ 0 `TOTAL` NIJE mogao
     * dobiti sabiranjem kolone. Na papiru 228/25 `TOTAL` stoji neposredno ispod te kolone
     * i od njega se tek oduzima `DISCOUNT:`, dakle on JESTE njen zbir.
     *
     * Isti vektor kao gore: dve stavke po 250,00 neto uz rabat 20 % (puna cena 156,25).
     */
    it("`TOTAL` je ZBIR odštampane kolone `Total ( EUR)`", () => {
      const ctx = makeCtx({
        lines: LINES.map((l) => ({
          ...l,
          discountPercent: D("20"),
          unitPriceBeforeDiscount: null,
        })),
      });
      const texts = collectText(inoRobaTemplate(ctx));
      // Kolona: 2 × 156,25 = 312,50 po stavci, dve stavke → 625,00 = `TOTAL`.
      expect(texts.filter((t) => t === "156.25")).toHaveLength(2);
      expect(texts.filter((t) => t === "312.50")).toHaveLength(2);
      // Cena posle rabata (125,00) se u koloni više ne pojavljuje: 125,00 na papiru
      // ostaje samo kao ukupan `DISCOUNT:`. Neto iznos stavke (250,00) nestaje sasvim —
      // on je ispod rabata, a kolona je iznad njega.
      expect(texts.filter((t) => t === "125.00")).toHaveLength(1);
      expect(texts[texts.indexOf("DISCOUNT:") + 1]).toBe("125.00");
      expect(texts).not.toContain("250.00");
      expect(texts[texts.indexOf("TOTAL") + 1]).toBe("625.00");
    });

    /**
     * DVA IZVORA, JEDAN PAPIR: nova stavka nosi cenu PRE rabata (125,00 / 0,8 = 156,25),
     * stara je nema. Papir mora biti ISTI — inače bi isti posao izgledao različito zavisno
     * od toga kada je stavka uneta, a razlika bi se videla tek kod kupca.
     */
    it("stavka sa upisanom cenom pre rabata daje isti papir kao obračun unazad", () => {
      const stare = collectText(
        inoRobaTemplate(
          makeCtx({
            lines: LINES.map((l) => ({
              ...l,
              discountPercent: D("20"),
              unitPriceBeforeDiscount: null,
            })),
          }),
        ),
      );
      const nove = collectText(
        inoRobaTemplate(
          makeCtx({
            lines: LINES.map((l) => ({
              ...l,
              discountPercent: D("20"),
              unitPriceBeforeDiscount: D("156.25"),
            })),
          }),
        ),
      );
      expect(nove).toEqual(stare);
    });

    it("nema NIJEDAN PDV red — izvoz je oslobođen", () => {
      const text = renderText(makeCtx());
      expect(text).not.toContain("VAT");
      expect(text).not.toContain("PDV po stopi");
      expect(text).not.toContain("Osnovica");
    });

    /**
     * NALAZ N12 (02.08.2026): na papiru 228/25 uokvireni su `TOTAL` I `TOTAL AMOUNT`, a
     * `DISCOUNT` NIJE — kod je uokvirivao samo `TOTAL AMOUNT`. Okvir na tom obrascu nosi
     * iznose koji SU zbir, dok je rabat iznos koji se od zbira oduzima.
     */
    it("uokvireni su `TOTAL` i `TOTAL AMOUNT`, a `DISCOUNT` nije", () => {
      const boxed: string[] = [];
      const plain: string[] = [];
      walk(inoRobaTemplate(makeCtx()), (o) => {
        if (typeof o.text !== "string" || !Array.isArray(o.border)) return;
        (o.border.some(Boolean) ? boxed : plain).push(o.text);
      });
      // Oba iznosa su 500.00 — okvir ima onaj uz `TOTAL` i onaj uz `TOTAL AMOUNT ( EUR)`.
      expect(boxed).toEqual(["500.00", "500.00"]);
      expect(plain).toEqual(["TOTAL", "DISCOUNT:", "0.00", "TOTAL AMOUNT ( EUR)"]);
    });
  });

  /**
   * NALAZ (02.08.2026): ino obrasci NISU odbijali primljeni avans, iako sistem zna
   * koliko kupac stvarno duguje (`payableAmount` u `fakturisanje.service.ts`).
   * Stranom kupcu naplaćen avans 3.000 EUR + izvozna faktura na 10.000 EUR = papir sa
   * „TOTAL AMOUNT ( EUR) 10,000.00" i bez ijednog reda o avansu. Izvozna faktura NE ide
   * na SEF, pa je taj papir jedini dokument — kupac bi platio 10.000 umesto 7.000.
   */
  describe("odbijen avans (scenario 10.000 EUR − 3.000 EUR avansa)", () => {
    const saAvansom = (over: Record<string, unknown> = {}) =>
      makeCtx({
        invoice: makeInvoice({
          netTotal: D("10000.00"),
          grossTotal: D("10000.00"),
          advanceAppliedAmount: D("3000.00"),
        }),
        lines: [
          {
            ...LINES[0],
            quantity: D("1"),
            unitPrice: D("10000.00"),
            lineTotal: D("10000.00"),
          },
        ],
        advanceDeductions: [
          { documentNumber: "A-1/26", amount: D("3000.00") },
        ],
        ...over,
      });

    it("štampa umanjenje i traži 7.000, ne 10.000", () => {
      const texts = collectText(inoRobaTemplate(saAvansom()));
      const i = texts.indexOf("Less prepayment received (no. A-1/26):");
      expect(i).toBeGreaterThanOrEqual(0);
      expect(texts[i + 1]).toBe("− 3,000.00");
      expect(texts).toContain("Amount payable ( EUR)");
      expect(texts[texts.indexOf("Amount payable ( EUR)") + 1]).toBe("7,000.00");
    });

    it("`TOTAL AMOUNT` ostaje pun iznos fakture — avans dira samo ono što se plaća", () => {
      const texts = collectText(inoRobaTemplate(saAvansom()));
      const at = texts.indexOf("TOTAL AMOUNT ( EUR)");
      expect(texts[at + 1]).toBe("10,000.00");
      // Red avansa je ISPOD punog iznosa, a „Amount payable" je poslednji u zbiru.
      expect(at).toBeLessThan(texts.indexOf("Less prepayment received (no. A-1/26):"));
      expect(texts.indexOf("Amount payable ( EUR)")).toBeGreaterThan(at);
    });

    it("okvir seli na `Amount payable` — uokviren je uvek iznos koji se plaća", () => {
      const boxed: string[] = [];
      walk(inoRobaTemplate(saAvansom()), (o) => {
        if (typeof o.text !== "string" || !Array.isArray(o.border)) return;
        if (o.border.some(Boolean)) boxed.push(o.text);
      });
      // `TOTAL` (zbir kolone) zadržava svoj okvir sa papira; `TOTAL AMOUNT` ga ustupa
      // redu `Amount payable`, jer okvir uvek nosi ono što kupac treba da plati.
      expect(boxed).toEqual(["10,000.00", "7,000.00"]);
    });

    it("bez broja avansnog računa red i dalje postoji, samo bez broja", () => {
      const texts = collectText(
        inoRobaTemplate(
          saAvansom({
            advanceDeductions: [
              { documentNumber: null, amount: D("3000.00") },
            ],
          }),
        ),
      );
      expect(texts).toContain("Less prepayment received:");
      expect(texts[texts.indexOf("Amount payable ( EUR)") + 1]).toBe("7,000.00");
    });

    it("avans veći od fakture ne daje negativan iznos za uplatu", () => {
      const texts = collectText(
        inoRobaTemplate(
          saAvansom({
            invoice: makeInvoice({
              netTotal: D("10000.00"),
              grossTotal: D("10000.00"),
              advanceAppliedAmount: D("12000.00"),
            }),
            advanceDeductions: [
              { documentNumber: "A-1/26", amount: D("12000.00") },
            ],
          }),
        ),
      );
      expect(texts[texts.indexOf("Amount payable ( EUR)") + 1]).toBe("0.00");
    });

    /**
     * NOVO-A na izvoznom obrascu: dva avansa = dva reda „Less prepayment received".
     * Izmeren ulaz: 10.000 EUR fakture uz `A-1/26` (3.000) i `A-2/26` (2.000) — do
     * ispravke jedan red sa brojem PRVOG avansa i zbirom oba (− 5,000.00).
     */
    it("dva odbijena avansa daju dva reda, svaki sa svojim brojem", () => {
      const texts = collectText(
        inoRobaTemplate(
          saAvansom({
            advanceDeductions: [
              { documentNumber: "A-1/26", amount: D("3000.00") },
              { documentNumber: "A-2/26", amount: D("2000.00") },
            ],
          }),
        ),
      );
      const prvi = texts.indexOf("Less prepayment received (no. A-1/26):");
      const drugi = texts.indexOf("Less prepayment received (no. A-2/26):");
      expect(prvi).toBeGreaterThanOrEqual(0);
      expect(drugi).toBeGreaterThan(prvi);
      expect(texts[prvi + 1]).toBe("− 3,000.00");
      expect(texts[drugi + 1]).toBe("− 2,000.00");
      expect(texts).not.toContain("− 5,000.00");
      expect(texts[texts.indexOf("Amount payable ( EUR)") + 1]).toBe("5,000.00");
    });

    it("bez avansa papir ostaje kao na 228/25 — nema reda o avansu", () => {
      const text = renderText(makeCtx());
      expect(text).not.toContain("prepayment");
      expect(text).not.toContain("Amount payable");
    });
  });

  /**
   * NALAZ: predračun napravljen kao DOMAĆI (PDV 20 %, bruto 119.236,37) pa prepisan u
   * izvozni račun (`POST /sales/invoices/:id/from-proforma` sa ciljem `IZVRO`) davao je
   * papir na kom „TOTAL AMOUNT" nosi PDV, a `DISCOUNT` ispada NEGATIVAN — na dokumentu
   * koji dva reda niže tvrdi da je promet oslobođen PDV-a.
   */
  describe("brana: izvozni obrazac sa obračunatim PDV-om", () => {
    const saPdv = () =>
      makeCtx({
        invoice: makeInvoice({
          documentNumber: "229/25",
          netTotal: D("99363.64"),
          vatTotal: D("19872.73"),
          grossTotal: D("119236.37"),
        }),
      });

    it("puca umesto da izda pogrešan papir", () => {
      expect(() => inoRobaTemplate(saPdv())).toThrow(/nosi obračunat PDV/);
    });

    it("poruka imenuje račun, iznos PDV-a i šta da se uradi", () => {
      let message = "";
      try {
        inoRobaTemplate(saPdv());
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).toContain("229/25");
      expect(message).toContain("19,872.73");
      expect(message).toContain("poresku šifru");
    });

    it("ni jedan iznos ne izađe na papir — pada pre štampe, ne posle", () => {
      // Negativan DISCOUNT i PDV u „TOTAL AMOUNT" su bili vidljivi tek na gotovom PDF-u.
      expect(() => collectText(inoRobaTemplate(saPdv()))).toThrow();
    });

    it("otpremnica bez cena se i dalje štampa — na njoj nema nijednog iznosa", () => {
      // Brana čuva IZNOS ZA UPLATU; papir bez ijedne novčane kolone nema šta da slaže,
      // a magacin zbog greške u poreskoj šifri ne sme da ostane bez otpremnice.
      const text = renderText({ ...saPdv(), withoutPrices: true });
      expect(text).toContain("Invoice No. 229/25");
      expect(text).not.toContain("TOTAL AMOUNT");
    });
  });

  /**
   * Datum prometa je obavezan element računa (Zakon o PDV). Polje `supplyDate` se upisuje
   * pri knjiženju i ino USLUGA ga štampa od početka — robni obrazac nije, pa su dva
   * izvozna papira istom kupcu nosila različit skup obaveznih podataka.
   */
  describe("datum prometa", () => {
    it("štampa `Date of delivery:` u obliku `DD-MM-YY`, kao ino usluga", () => {
      const text = renderText(makeCtx());
      expect(text).toContain("Date of delivery:");
      expect(text).toContain("25-04-25");
    });

    it("razlikuje se od datuma izdavanja kad je promet bio drugog dana", () => {
      const text = renderText(
        makeCtx({ invoice: makeInvoice({ supplyDate: new Date(2025, 3, 20) }) }),
      );
      expect(text).toContain("20-04-25"); // datum prometa
      expect(text).toContain("25.04.2025."); // datum izdavanja, drugi oblik
    });

    it("bez datuma prometa nema prazne labele", () => {
      const text = renderText(
        makeCtx({ invoice: makeInvoice({ supplyDate: null }) }),
      );
      expect(text).not.toContain("Date of delivery:");
      expect(text).toContain("Invoice No. 228/25");
    });
  });

  describe("slobodan tekst", () => {
    it("nosi poziv na ponudu i broj izvozne deklaracije", () => {
      const text = renderText(makeCtx());
      expect(text).toContain(
        "Fakturisanje je izvršeno na osnovu ponude 0206-25",
      );
      expect(text).toContain("25-0401-000005");
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
      expect(text).toContain("Invoice No. 228/25"); // ostatak papira i dalje stoji
    });
  });

  /**
   * Do 02.08.2026. su se `Payment terms:` (gore, engleski) i `Način plaćanja:` (dole,
   * srpski) punili iz ISTOG polja `Invoice.paymentMethod`, pa je svaka naša ino faktura
   * istu reč nosila dva puta. Vlasnik je presudio da način plaćanja nije obavezan element
   * i da je suvišan (`docs/FAKTURE_ZAKONSKA_USKLADJENOST.md` §2.1 / P1) — ostaje jedan red.
   */
  describe("plaćanje se pominje TAČNO JEDNOM", () => {
    it("ima samo `Payment terms:`, nema srpski `Način plaćanja:`", () => {
      const texts = collectText(inoRobaTemplate(makeCtx()));
      const mentions = texts.filter(
        (t) => t.includes("Payment terms") || t.includes("Način plaćanja"),
      );
      expect(mentions).toEqual(["Payment terms:"]);
    });

    it("vrednost („virmanom“) se ne ponavlja na dva mesta", () => {
      const texts = collectText(inoRobaTemplate(makeCtx()));
      expect(texts.filter((t) => t.includes("virmanom"))).toHaveLength(1);
    });

    it("bez unetog načina plaćanja nema nijednog reda o plaćanju", () => {
      const text = renderText(
        makeCtx({ invoice: makeInvoice({ paymentMethod: null }) }),
      );
      expect(text).not.toContain("Payment terms:");
      expect(text).not.toContain("Način plaćanja");
    });
  });

  describe("poresko oslobođenje i pravne napomene", () => {
    it("koristi član 24. STAV 1 TAČKA 2 — član za ROBU", () => {
      const text = renderText(makeCtx());
      expect(text).toContain(
        "Napomena o poreskom oslobodjenju: Oslobodjeno PDV na osnovu člana 24. stav 1 tačka 2 Zakona o PDV.",
      );
    });

    /**
     * Tekst se od 02.08.2026. uzima iz `vat-exemption.ts` — istog mesta odakle ga uzima i
     * SEF builder. Time papir i XML fizički ne mogu da navedu različit član za isti posao
     * (`docs/FAKTURE_ZAKONSKA_USKLADJENOST.md` §3.1).
     */
    it("tekst je DOSLOVNO onaj iz `vat-exemption.ts`, ne kopija u šablonu", () => {
      expect(collectText(inoRobaTemplate(makeCtx()))).toContain(
        exemptionFor("export-goods")?.paperText,
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
      // Naziv DOSLOVNO iz `companies.company_name` (O-F9) — bez grada zalepljenog uz ime;
      // grad uz ime nosi samo memorandum strane, i to spajanjem iz `city`.
      expect(text).toContain("Servoteh d.o.o.");
      expect(text).not.toContain("Servoteh d.o.o. Dobanovci");
      // Adresa primaoca u međunarodnoj uplati ide SA poštanskim brojem (O-F10) —
      // za razliku od potpisnog bloka domaće robne fakture.
      expect(text).toContain("Ugrinovačka 163, 11272 Dobanovci");
      expect(text).toContain("Banca Intesa a.d. EUR");
      expect(text).toContain("Milentija Popovića 7b, 11070 New Belgrade");
      expect(text).toContain("Republic of Serbia");
    });

    /**
     * NALAZ N7 (02.08.2026): obrazac je uz naziv banke SAM lepio valutu dokumenta, iako to
     * `composeBankName` već radi — i to namerno SAMO kad je devizni račun baš u valuti
     * fakture. Posledica: USD faktura koja padne na EUR račun (drugi krug izbora u
     * `loadForeignAccount`) dobijala je red „Citibank EUR" uz USD IBAN, dakle dve tvrdnje
     * o istom računu. Ino USLUGA valutu nije lepila uopšte — isti podaci, dva reda.
     */
    it("naziv banke se štampa DOSLOVNO — obrazac mu ne dopisuje valutu", () => {
      const ctx = makeCtx({
        issuer: { ...SERVOTEH, bankName: "Citibank" },
        currency: "USD",
      });
      const text = renderText(ctx);
      expect(text).toContain("Citibank");
      expect(text).not.toContain("Citibank USD");
      expect(text).not.toContain("Citibank EUR");
    });

    it("ne udvaja valutu kad je već u nazivu banke", () => {
      expect(renderText(makeCtx())).not.toContain("Banca Intesa a.d. EUR EUR");
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

    /**
     * 🔴 IZMEREN KVAR (treći krug 02.08.2026): dinarski red iz `payment_accounts` nosi
     * SAMO naziv banke (iban/swift `null`) — i to je bilo dovoljno da blok izađe. Papir je
     * imao obe labele i naziv banke, a nijedan broj računa: IBAN i SWIFT prazni, a domaći
     * `bankAccount` se na ino obrascu nikad ne štampa. Merilo je zato BROJ RAČUNA.
     */
    it("naziv banke bez IBAN-a i SWIFT-a NE otvara blok", () => {
      const ctx = makeCtx({
        issuer: {
          ...SERVOTEH,
          iban: null,
          swift: null,
          bankName: "Banca Intesa a.d.",
          bankAddress: "Milentija Popovića 7b, 11070 New Belgrade",
        },
      });
      const text = renderText(ctx);
      expect(text).not.toContain("Beneficiary Customer:");
      expect(text).not.toContain("Bank of beneficiary:");
      expect(text).not.toContain("Banca Intesa");
      expect(text).not.toContain("Milentija Popovića");
    });

    /**
     * NALAZ N5 (02.08.2026): uslov je bio `!iban && !swift`, pa je SWIFT SAM otvarao ceo
     * blok — a SWIFT je oznaka BANKE, ne broj računa. Papir je tada imao „Beneficiary
     * Customer:", ime banke i SWIFT, a nijedan broj na koji se uplaćuje. Do tog stanja se
     * stiže svuda gde brana `requireBankDetails` ne važi i zato ne traži oba podatka:
     * IZVRO/IZVUS u dinarima, otpremnica, revers.
     */
    it("SWIFT bez IBAN-a NE otvara blok — SWIFT nije broj računa", () => {
      const ctx = makeCtx({
        issuer: { ...SERVOTEH, iban: null },
      });
      const text = renderText(ctx);
      expect(text).not.toContain("Beneficiary Customer:");
      expect(text).not.toContain("Bank of beneficiary:");
      expect(text).not.toContain("DBDBRSBG");
    });

    it("IBAN bez SWIFT-a blok OTVARA — broj računa je ono što kupcu treba", () => {
      const ctx = makeCtx({ issuer: { ...SERVOTEH, swift: null } });
      const text = renderText(ctx);
      expect(text).toContain("IBAN : RS35160005010003501186");
      expect(text).not.toContain("SWIFT:");
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
