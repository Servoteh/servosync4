import { Prisma } from "@prisma/client";
import type { TDocumentDefinitions } from "pdfmake/interfaces";
import { PdfService } from "../../../documents/pdf.service";
import { exemptionFor, NEMA_TEXT } from "../../vat-exemption";
import { domacaRobaTemplate } from "./domaca-roba";
import { domacaUslugaTemplate } from "./domaca-usluga";
import type {
  InvoiceWithItems,
  PrintCtx,
  PrintCustomer,
  PrintIssuer,
  PrintLine,
} from "./ctx";

/**
 * Test-vektori su PREPISANI sa dva donesena BigBit papira
 * (`docs/zahtevi/fakture-obrasci-2026-08/IFR.pdf` = 657/25 i `IFGP.pdf` = 650/25).
 * Nisu izmišljeni: ako neki od ovih testova padne, papir bi kod kupca izašao drugačiji
 * nego što je izlazio do sada — to je greška, ne „promena izgleda“.
 *
 * Ne proveravaju se pikseli nego SADRŽAJ: koji tekst i koji broj se pojavljuju na papiru.
 * Razmaci, širine kolona i debljine linija su stvar oka i menjaće se; brojevi i natpisi ne.
 */

const d = (v: string | number): Prisma.Decimal => new Prisma.Decimal(v);

/** Firma izdavalac — podaci iz memoranduma donetih papira. */
const ISSUER: PrintIssuer = {
  companyName: "Servoteh d.o.o.",
  address: "Ugrinovačka 163",
  city: "Dobanovci",
  postalCode: "11272",
  taxId: "101017443",
  registrationNumber: "17400169",
  bankAccount: "160-110610-83",
  phone: "+381 11 31 41 564",
  fax: "+381 11 2399 265",
  email: "office@servoteh.rs",
  webAddress: "www.servoteh.rs",
  invoiceIssuingPlace: "Beograd",
  registryNumber: "01117400169",
  businessActivityCode: "3320",
  aprText: null,
  iban: null,
  swift: null,
  bankName: null,
  bankAddress: null,
};

/** Kupac sa oba papira. */
const CUSTOMER: PrintCustomer = {
  name: "HAP FLUID D.O.O.",
  address: "Ugrinovačka 163",
  city: "Dobanovci",
  postalCode: "11272",
  taxId: "107136558",
  registrationNumber: "20748346",
  country: "Srbija",
};

/**
 * Šablon dodiruje samo šačicu polja `Invoice`-a, a tip traži ceo red iz baze — zato
 * kastovanje. Test ne sme da zavisi od 60 kolona koje na papir ne izlaze.
 */
function makeInvoice(over: Record<string, unknown>): InvoiceWithItems {
  return {
    documentNumber: "657/25",
    documentDate: new Date(2025, 11, 25),
    dueDate: new Date(2025, 11, 25),
    supplyDate: new Date(2025, 11, 25),
    fco: "magacin kupca",
    paymentMethod: "virmanom",
    shipmentMethod: "lično",
    netTotal: d(0),
    vatTotal: d(0),
    grossTotal: d(0),
    // Podrazumevano nema odbijenog avansa — testovi koji ga proveravaju ga postavljaju.
    advanceAppliedAmount: d(0),
    advanceInvoiceId: null,
    items: [],
    ...over,
  } as unknown as InvoiceWithItems;
}

function makeLine(over: Partial<PrintLine>): PrintLine {
  return {
    ordinal: 1,
    catalogNumber: null,
    name: "",
    unit: "Kom",
    customsTariff: null,
    quantity: d(1),
    unitPrice: d(0),
    // Podrazumevano „stara stavka" (bez cene pre rabata) — testovi koji tu cenu
    // proveravaju je postavljaju izričito.
    unitPriceBeforeDiscount: null,
    discountPercent: d(0),
    lineTotal: d(0),
    vatRatePercent: 20,
    ...over,
  };
}

function makeCtx(over: Partial<PrintCtx>): PrintCtx {
  return {
    invoice: makeInvoice({}),
    lines: [],
    customer: CUSTOMER,
    issuer: ISSUER,
    signatory: { name: "Dragana Korkut" },
    warehouseName: "Magacin robe",
    currency: "RSD",
    advanceDeductions: [],
    withoutPrices: false,
    ...over,
  };
}

/** IFR 657/25 — dve stavke, PDV 20 %, magacin „Magacin robe“. */
function ifrCtx(over: Partial<PrintCtx> = {}): PrintCtx {
  return makeCtx({
    invoice: makeInvoice({
      documentNumber: "657/25",
      netTotal: d("99363.64"),
      vatTotal: d("19872.73"),
      grossTotal: d("119236.37"),
    }),
    lines: [
      makeLine({
        ordinal: 1,
        catalogNumber: "TO.44140391",
        name: "INSERT HME 212",
        quantity: d(5),
        unitPrice: d("16099.54"),
        lineTotal: d("80497.70"),
      }),
      makeLine({
        ordinal: 2,
        catalogNumber: "TO.44070090",
        name: "TO.4407009",
        quantity: d(2),
        unitPrice: d("9432.97"),
        lineTotal: d("18865.94"),
      }),
    ],
    warehouseName: "Magacin robe",
    ...over,
  });
}

/** IFGP 650/25 — ista forma, jedna stavka, magacin „Gotovi proizvodi“. */
function ifgpCtx(over: Partial<PrintCtx> = {}): PrintCtx {
  return makeCtx({
    invoice: makeInvoice({
      documentNumber: "650/25",
      documentDate: new Date(2025, 11, 22),
      dueDate: new Date(2025, 11, 22),
      supplyDate: new Date(2025, 11, 22),
      netTotal: d("23400.00"),
      vatTotal: d("4680.00"),
      grossTotal: d("28080.00"),
    }),
    lines: [
      makeLine({
        ordinal: 1,
        catalogNumber: "125859",
        name: "GRANULE GREASE HT2 15kg mast za industriju peleta",
        quantity: d(2),
        unitPrice: d("11700.00"),
        lineTotal: d("23400.00"),
      }),
    ],
    warehouseName: "Gotovi proizvodi",
    ...over,
  });
}

/** Skuplja sav `text` iz pdfmake stabla, da se tvrdnje pišu nad ravnim spiskom. */
function collectText(node: unknown, out: string[] = []): string[] {
  if (node == null) return out;
  if (Array.isArray(node)) {
    for (const n of node) collectText(n, out);
    return out;
  }
  if (typeof node === "object") {
    const o = node as Record<string, unknown>;
    if (typeof o.text === "string") out.push(o.text);
    for (const key of ["stack", "columns", "table", "body"]) {
      if (o[key] != null) collectText(o[key], out);
    }
  }
  return out;
}

const textOf = (ctx: PrintCtx): string[] =>
  collectText(domacaRobaTemplate(ctx));
const joinedOf = (ctx: PrintCtx): string => textOf(ctx).join("\n");

/**
 * Iznos koji stoji ODMAH IZA date labele u zbiru. U pdfmake stablu i robni i uslužni
 * obrazac slažu par „labela pa iznos", pa isti pomoćnik čita oba — a poređenje dva
 * obrasca ne zavisi od toga kako je koji uokviren.
 */
function amountAfter(texts: string[], label: string): string {
  const i = texts.indexOf(label);
  expect(i).toBeGreaterThanOrEqual(0);
  return texts[i + 1];
}

describe("obrazac domaće fakture za robu (IFR/IFGP)", () => {
  describe("zaglavlje tela", () => {
    it("nosi centriran red tekućeg računa (samo domaći obrasci ga imaju)", () => {
      expect(joinedOf(ifrCtx())).toContain("Tekući račun: 160-110610-83");
    });

    it("okvir kupca ima naslov razmaknutim slovima i podatke sa papira", () => {
      const joined = joinedOf(ifrCtx());
      expect(joined).toContain("K u p a c:");
      expect(joined).toContain("HAP FLUID D.O.O.");
      expect(joined).toContain("11272  Dobanovci");
      expect(joined).toContain("Ugrinovačka 163");
      expect(joined).toContain("PIB: 107136558  -  MB: 20748346");
    });

    it("desni blok nosi broj, datum izdavanja, valutu i mesto izdavanja", () => {
      const joined = joinedOf(ifrCtx());
      expect(joined).toContain("Račun br. 657/25");
      expect(joined).toContain("Datum izdavanja računa: 25-12-25");
      expect(joined).toContain("Valuta za plaćanje: 25-12-25");
      expect(joined).toContain("Mesto izdavanja računa:  Beograd");
    });
  });

  describe("traka uslova", () => {
    it("ima sve četiri kolone sa vrednostima sa papira", () => {
      const texts = textOf(ifrCtx());
      for (const header of [
        "Roba je FCO",
        "Način plaćanja",
        "Način otpreme robe",
        "Datum prometa dobara",
      ])
        expect(texts).toContain(header);
      expect(texts).toContain("magacin kupca");
      expect(texts).toContain("virmanom");
      expect(texts).toContain("lično");
      // Datum prometa je domaći format DD-MM-YY.
      expect(texts).toContain("25-12-25");
    });

    it("štampa se i kad su polja prazna — traka je deo okvira, ne uslovni blok", () => {
      const ctx = ifrCtx({
        invoice: makeInvoice({
          documentNumber: "657/25",
          fco: null,
          paymentMethod: null,
          shipmentMethod: null,
          supplyDate: null,
          netTotal: d("99363.64"),
          vatTotal: d("19872.73"),
          grossTotal: d("119236.37"),
        }),
      });
      const texts = textOf(ctx);
      expect(texts).toContain("Roba je FCO");
      expect(texts).toContain("Datum prometa dobara");
    });
  });

  describe("tabela stavki", () => {
    it("ima svih devet kolona, sa razmaknutim naslovima kakvi su na obrascu", () => {
      const texts = textOf(ifrCtx());
      for (const header of [
        "R.br.",
        "PDV",
        "Kat. br.",
        "N A Z I V   R O B E",
        "j.m.",
        "Količina",
        "C E N A",
        "R%",
        "VREDNOST",
      ])
        expect(texts).toContain(header);
    });

    it("stavka nosi stopu PDV-a, kataloški broj, j.m., cenu i vrednost", () => {
      const texts = textOf(ifrCtx());
      expect(texts).toContain("20%");
      expect(texts).toContain("TO.44140391");
      expect(texts).toContain("INSERT HME 212");
      expect(texts).toContain("Kom");
      expect(texts).toContain("16,099.54");
      expect(texts).toContain("80,497.70");
      expect(texts).toContain("9,432.97");
      expect(texts).toContain("18,865.94");
    });

    it("količina se štampa bez suvišnih nula (papir kaže „5“, ne „5.000“)", () => {
      const texts = textOf(ifrCtx());
      expect(texts).toContain("5");
      expect(texts).not.toContain("5.000");
    });

    it("kolona R% pokazuje 0 kad rabata nema (ne prazno)", () => {
      expect(textOf(ifrCtx())).toContain("0");
    });

    /**
     * NALAZ N1 (02.08.2026): kolone `C E N A` i `VREDNOST` su nosile cenu POSLE rabata, a
     * međuzbir iznad reda „Rabat:" računat je iz cene PRE rabata — pa se sa rabatom ≠ 0
     * nijedan broj u zbiru nije mogao dobiti sabiranjem odštampane kolone.
     *
     * Presuda je sa papira IFR 657/25: međuzbir 99.363,64 stoji NEPOSREDNO ISPOD kolone
     * VREDNOST i BEZ natpisa, pa se tek od njega oduzima `Rabat:` i dobija osnovica —
     * dakle međuzbir JESTE zbir kolone. Vektor: 10 kom × 1.000,00 uz rabat 10 %.
     */
    it("kolone `C E N A` i `VREDNOST` nose iznos PRE rabata", () => {
      const ctx = makeCtx({
        invoice: makeInvoice({
          netTotal: d("9000.00"),
          vatTotal: d("1800.00"),
          grossTotal: d("10800.00"),
        }),
        lines: [
          makeLine({
            name: "Roba sa rabatom",
            quantity: d(10),
            // U bazi stoji cena POSLE rabata; puna cena je na stavci od 02.08.2026.
            unitPrice: d("900.00"),
            unitPriceBeforeDiscount: d("1000.00"),
            discountPercent: d(10),
            lineTotal: d("9000.00"),
          }),
        ],
      });
      const texts = textOf(ctx);
      // Kolona nosi 1.000,00 i 10.000,00; cena posle rabata (900,00) i osnovica stavke
      // (9.000,00) su ispod rabata, pa u tabeli stavki nemaju šta da traže.
      expect(texts).toContain("1,000.00");
      expect(texts).not.toContain("900.00");
      // Međuzbir (red bez labele iznad „Rabat:") je BAŠ zbir kolone VREDNOST.
      expect(texts[texts.indexOf("Rabat:") - 1]).toBe("10,000.00");
      expect(texts.filter((t) => t === "10,000.00")).toHaveLength(2);
    });

    it("bez rabata kolone ostaju iste kao na donetom papiru", () => {
      // Doneti papiri svi imaju `R% 0` — na njima se ispravka ne sme videti.
      const texts = textOf(ifrCtx());
      expect(texts).toContain("16,099.54");
      expect(texts).toContain("80,497.70");
      expect(texts).toContain("9,432.97");
      expect(texts).toContain("18,865.94");
    });
  });

  describe("zbirni blok", () => {
    it("IFR 657/25 daje tačno brojeve sa papira", () => {
      const texts = textOf(ifrCtx());
      expect(texts).toContain("99,363.64"); // bruto zbir = osnovica (bez rabata)
      expect(texts).toContain("19,872.73"); // PDV 20 %
      expect(texts).toContain("119,236.37"); // za uplatu
      expect(texts).toContain("Vrednost bez PDV (osnovica):");
      expect(texts).toContain("Za uplatu (RSD):");
    });

    it("IFGP 650/25 daje tačno brojeve sa svog papira", () => {
      const texts = textOf(ifgpCtx());
      expect(texts).toContain("23,400.00");
      expect(texts).toContain("4,680.00");
      expect(texts).toContain("28,080.00");
      expect(texts).toContain("Za uplatu (RSD):");
    });

    it("red „Rabat: 0.00“ POSTOJI i kad rabata nema", () => {
      // §6 t.4: red se ne izostavlja. Kupac po istom papiru proverava da li mu je
      // rabat odobren — izostavljen red se čita kao da mesta za rabat nije ni bilo.
      const texts = textOf(ifrCtx());
      expect(texts).toContain("Rabat:");
      expect(texts).toContain("0.00");
    });

    /**
     * SCENARIO SA STVARNIM PODACIMA: 10 kom × 1.000,00 uz rabat 10 %.
     * `PricingService` upiše cenu POSLE rabata (`unitPrice = 900,00`) i osnovicu
     * 9.000,00, a `discountPercent = 10` ostaje samo kao podatak koliko je odbijeno.
     *
     * Do 02.08.2026. je obrazac bruto računao kao Σ(količina × `unitPrice`) = 9.000,00,
     * pa je rabat ispadao „9.000 − 9.000 = 0,00": papir je u koloni pokazivao `R% 10`,
     * a u zbiru `Rabat: 0.00` — dve tvrdnje koje se poriču. Sada se rabat izvodi unazad
     * (9.000 × 10 / 90 = 1.000,00), a bruto je osnovica uvećana za njega.
     */
    it("rabat 10 % na 10 × 1.000,00 daje bruto 10.000,00 i rabat 1.000,00", () => {
      const ctx = makeCtx({
        invoice: makeInvoice({
          netTotal: d("9000.00"),
          vatTotal: d("1800.00"),
          grossTotal: d("10800.00"),
        }),
        lines: [
          makeLine({
            name: "Roba sa rabatom",
            quantity: d(10),
            // Cena POSLE rabata — tako je zapisana u bazi (1.000,00 − 10 %).
            unitPrice: d("900.00"),
            discountPercent: d(10),
            lineTotal: d("9000.00"),
          }),
        ],
      });
      const texts = textOf(ctx);
      // Bruto je red BEZ labele, tačno iznad reda „Rabat:".
      expect(texts[texts.indexOf("Rabat:") - 1]).toBe("10,000.00");
      expect(amountAfter(texts, "Rabat:")).toBe("1,000.00");
      expect(amountAfter(texts, "Vrednost bez PDV (osnovica):")).toBe("9,000.00");
      expect(amountAfter(texts, "Za uplatu (RSD):")).toBe("10,800.00");
      expect(texts).toContain("10"); // R% na stavci
    });

    /**
     * Brana da se strukturna nula ne vrati: kad god kolona `R%` pokazuje rabat, red
     * „Rabat:" mora da pokaže novac — inače papir sam sebi protivreči.
     */
    it("kolona R% i red „Rabat:“ ne mogu da protivreče jedno drugom", () => {
      const ctx = makeCtx({
        invoice: makeInvoice({
          netTotal: d("9000.00"),
          vatTotal: d("1800.00"),
          grossTotal: d("10800.00"),
        }),
        lines: [
          makeLine({
            quantity: d(10),
            unitPrice: d("900.00"),
            discountPercent: d(10),
            lineTotal: d("9000.00"),
          }),
        ],
      });
      const texts = textOf(ctx);
      expect(texts).toContain("10"); // R% > 0 …
      expect(amountAfter(texts, "Rabat:")).not.toBe("0.00"); // … pa rabat NIJE nula
    });

    /**
     * RABAT OD 100 % — poslednji slučaj u kom je papir i dalje protivrečio sam sebi.
     * Cena posle rabata je 0, pa obračun unazad nema iz čega da radi; iznos dolazi iz
     * cene PRE rabata sa stavke (`unit_price_before_discount`, uvedena 02.08.2026).
     * 10 kom × 1.000,00 uz 100 % → osnovica 0,00, rabat 10.000,00, bruto 10.000,00.
     */
    it("rabat 100 % daje bruto 10.000,00 i rabat 10.000,00 uz osnovicu 0,00", () => {
      const ctx = makeCtx({
        invoice: makeInvoice({
          netTotal: d("0.00"),
          vatTotal: d("0.00"),
          grossTotal: d("0.00"),
        }),
        lines: [
          makeLine({
            name: "Roba bez naknade",
            quantity: d(10),
            unitPrice: d("0.00"),
            unitPriceBeforeDiscount: d("1000.00"),
            discountPercent: d(100),
            lineTotal: d("0.00"),
          }),
        ],
      });
      const texts = textOf(ctx);
      expect(texts[texts.indexOf("Rabat:") - 1]).toBe("10,000.00");
      expect(amountAfter(texts, "Rabat:")).toBe("10,000.00");
      expect(amountAfter(texts, "Vrednost bez PDV (osnovica):")).toBe("0.00");
    });

    /**
     * Rabat mora da zatvori zbir i kad je odobren na SAMO NEKIM stavkama i kad se
     * deljenjem ne dobija okrugao broj (zaokruživanje ide po stavci, kao i štampa).
     */
    it("zatvara zbir i uz mešavinu stavki sa rabatom i bez njega", () => {
      const ctx = makeCtx({
        invoice: makeInvoice({
          // 9.000,00 (sa rabatom 10 %) + 1.000,00 (bez rabata)
          netTotal: d("10000.00"),
          vatTotal: d("2000.00"),
          grossTotal: d("12000.00"),
        }),
        lines: [
          makeLine({
            ordinal: 1,
            name: "Sa rabatom",
            quantity: d(10),
            unitPrice: d("900.00"),
            discountPercent: d(10),
            lineTotal: d("9000.00"),
          }),
          makeLine({
            ordinal: 2,
            name: "Bez rabata",
            quantity: d(1),
            unitPrice: d("1000.00"),
            discountPercent: d(0),
            lineTotal: d("1000.00"),
          }),
        ],
      });
      const texts = textOf(ctx);
      // Rabat nosi SAMO prva stavka: 11.000,00 − 1.000,00 = 10.000,00 osnovice.
      expect(texts[texts.indexOf("Rabat:") - 1]).toBe("11,000.00");
      expect(amountAfter(texts, "Rabat:")).toBe("1,000.00");
      expect(amountAfter(texts, "Vrednost bez PDV (osnovica):")).toBe(
        "10,000.00",
      );
    });

    it("red PDV-a nosi OSNOVICU u tekstu, ne samo iznos", () => {
      expect(joinedOf(ifrCtx())).toContain("PDV po stopi 20% X 99,363.64 =");
      expect(joinedOf(ifgpCtx())).toContain("PDV po stopi 20% X 23,400.00 =");
    });

    it("dve poreske stope daju dva reda PDV-a, sa svojim osnovicama", () => {
      const ctx = makeCtx({
        invoice: makeInvoice({
          netTotal: d("2000.00"),
          vatTotal: d("300.00"),
          grossTotal: d("2300.00"),
        }),
        lines: [
          makeLine({
            ordinal: 1,
            name: "Roba 20%",
            quantity: d(1),
            unitPrice: d("1000.00"),
            lineTotal: d("1000.00"),
            vatRatePercent: 20,
          }),
          makeLine({
            ordinal: 2,
            name: "Roba 10%",
            quantity: d(1),
            unitPrice: d("1000.00"),
            lineTotal: d("1000.00"),
            vatRatePercent: 10,
          }),
        ],
      });
      const joined = joinedOf(ctx);
      expect(joined).toContain("PDV po stopi 10% X 1,000.00 =");
      expect(joined).toContain("PDV po stopi 20% X 1,000.00 =");
    });

    /**
     * NALAZ N4 (02.08.2026): raspoređivanje razlike zaokruživanja kod više stopa postojalo
     * je SAMO na uslužnom obrascu (`domaca-usluga.ts`), a robni ga nije imao — isti račun,
     * dva ishoda. Izmereno: osnovice 16.000,00 (20 %) i 4.000,00 (10 %) uz `vatTotal`
     * 3.599,99 sa dokumenta → robni papir je štampao 3.200,00 + 400,00 = 3.600,00, dakle
     * jednu paru više nego što je proknjiženo u glavnoj knjizi.
     *
     * 🔴 ISHOD PROMENJEN U SEDMOM KRUGU (02.08.2026, nalazi Z1/Z3): oba obrasca i dalje
     * rade ISTI račun — ali taj račun više ne guta razliku na redovnom računu. Osnovice
     * 16.000,00 i 4.000,00 daju 3.200,00 + 400,00 = 3.600,00, pa je `vatTotal 3.599,99`
     * pogrešno ZAGLAVLJE i mora da se vidi, a ne da se razmaže po grupama (razliku je
     * dobijala grupa po veličini osnovice, ne po poreklu — nalaz Z3).
     */
    it("🔴 pogrešan `vatTotal` se ne guta: oba obrasca i dalje računaju isto", () => {
      const ctx = makeCtx({
        invoice: makeInvoice({
          netTotal: d("20000.00"),
          vatTotal: d("3599.99"),
          grossTotal: d("23599.99"),
        }),
        lines: [
          makeLine({
            ordinal: 1,
            name: "Roba 20%",
            quantity: d(1),
            unitPrice: d("16000.00"),
            lineTotal: d("16000.00"),
            vatRatePercent: 20,
          }),
          makeLine({
            ordinal: 2,
            name: "Roba 10%",
            quantity: d(1),
            unitPrice: d("4000.00"),
            lineTotal: d("4000.00"),
            vatRatePercent: 10,
          }),
        ],
      });
      const texts = textOf(ctx);
      expect(amountAfter(texts, "PDV po stopi 20% X 16,000.00 =")).toBe(
        "3,200.00",
      );
      expect(amountAfter(texts, "PDV po stopi 10% X 4,000.00 =")).toBe("400.00");
      expect(texts).not.toContain("3,199.99");
    });

    it("bez avansa nema reda o avansu, a „Za uplatu“ je pun bruto zbir", () => {
      const texts = textOf(ifrCtx());
      expect(texts.join("\n")).not.toContain("Umanjenje za primljeni avans");
      expect(amountAfter(texts, "Za uplatu (RSD):")).toBe("119,236.37");
    });

    it("odbijen avans ide PRE završnog reda i umanjuje iznos za uplatu", () => {
      const texts = textOf(
        ifrCtx({
          invoice: makeInvoice({
            documentNumber: "657/25",
            netTotal: d("99363.64"),
            vatTotal: d("19872.73"),
            grossTotal: d("119236.37"),
            advanceAppliedAmount: d("19236.37"),
          }),
          advanceDeductions: [
            { documentNumber: "12/25", amount: d("19236.37") },
          ],
        }),
      );
      const advanceAt = texts.indexOf(
        "Umanjenje za primljeni avans (br. 12/25):",
      );
      const payableAt = texts.indexOf("Za uplatu (RSD):");
      expect(advanceAt).toBeGreaterThanOrEqual(0);
      // Red avansa je iznad završnog, a završni ostaje poslednji u zbiru.
      expect(advanceAt).toBeLessThan(payableAt);
      expect(texts[advanceAt + 1]).toBe("− 19,236.37");
      expect(amountAfter(texts, "Za uplatu (RSD):")).toBe("100,000.00");
      // Osnovica i PDV se NE diraju — avans umanjuje samo ono što se plaća.
      expect(texts).toContain("99,363.64");
      expect(texts).toContain("19,872.73");
    });

    it("bez broja avansnog računa red i dalje postoji, samo bez broja", () => {
      const texts = textOf(
        ifrCtx({
          invoice: makeInvoice({
            netTotal: d("1000.00"),
            vatTotal: d("200.00"),
            grossTotal: d("1200.00"),
            advanceAppliedAmount: d("200.00"),
          }),
          // AVR je obrisan (meki ref) — iznos se zna, broj ne.
          advanceDeductions: [{ documentNumber: null, amount: d("200.00") }],
        }),
      );
      expect(texts).toContain("Umanjenje za primljeni avans:");
      expect(amountAfter(texts, "Za uplatu (RSD):")).toBe("1,000.00");
    });

    it("avans veći od računa ne daje negativan iznos za uplatu", () => {
      const texts = textOf(
        ifrCtx({
          invoice: makeInvoice({
            netTotal: d("1000.00"),
            vatTotal: d("200.00"),
            grossTotal: d("1200.00"),
            advanceAppliedAmount: d("1500.00"),
          }),
          advanceDeductions: [
            { documentNumber: "12/25", amount: d("1500.00") },
          ],
        }),
      );
      expect(amountAfter(texts, "Za uplatu (RSD):")).toBe("0.00");
    });

    /**
     * REGRESIJA NA NOVO-A (02.08.2026): dva odbijena avansa = DVA REDA, svaki sa SVOJIM
     * brojem i SVOJIM iznosom.
     *
     * Izmereni ulaz: račun 10.000,00 zatvara `A-1/26` (3.000,00) i `A-2/26` (2.000,00).
     * Do ispravke je izlazio JEDAN red — broj iz `advance_invoice_id` (upisuje se samo pri
     * prvoj primeni) uz `advanceAppliedAmount` = zbir svih primena, dakle
     * „Umanjenje za primljeni avans (br. A-1/26): − 5,000.00" nad avansnim računom koji
     * glasi na 3.000,00.
     */
    it("dva odbijena avansa daju DVA reda, svaki sa svojim brojem i iznosom", () => {
      const texts = textOf(
        ifrCtx({
          invoice: makeInvoice({
            netTotal: d("10000.00"),
            vatTotal: d("0.00"),
            grossTotal: d("10000.00"),
            // Kolona nosi zbir — papir je više ne čita.
            advanceAppliedAmount: d("5000.00"),
          }),
          advanceDeductions: [
            { documentNumber: "A-1/26", amount: d("3000.00") },
            { documentNumber: "A-2/26", amount: d("2000.00") },
          ],
        }),
      );
      const prvi = texts.indexOf("Umanjenje za primljeni avans (br. A-1/26):");
      const drugi = texts.indexOf("Umanjenje za primljeni avans (br. A-2/26):");
      expect(prvi).toBeGreaterThanOrEqual(0);
      expect(drugi).toBeGreaterThan(prvi);
      expect(texts[prvi + 1]).toBe("− 3,000.00");
      expect(texts[drugi + 1]).toBe("− 2,000.00");
      // Zbir svih primena se NIGDE ne pojavljuje kao jedno umanjenje.
      expect(texts).not.toContain("− 5,000.00");
      // …ali „za uplatu" jeste umanjeno za oba: 10.000 − 3.000 − 2.000.
      expect(amountAfter(texts, "Za uplatu (RSD):")).toBe("5,000.00");
    });

    /**
     * REGRESIJA NA NOVO-E: papir i ekran moraju da gledaju u ISTI izvor. `getInvoice`
     * računa dug iz Σ AKTIVNIH primena; kolona `advance_applied_amount` ume da nosi uniju
     * zatečene 1:1 veze i nove N:M primene, pa je papir pokazivao manji dug od ekrana.
     */
    it("ignoriše kolonu `advanceAppliedAmount` kad primene postoje", () => {
      const texts = textOf(
        ifrCtx({
          invoice: makeInvoice({
            netTotal: d("10000.00"),
            vatTotal: d("0.00"),
            grossTotal: d("10000.00"),
            // Kolona (unija legacy 3.000 + primena 2.000) tvrdi 5.000…
            advanceAppliedAmount: d("5000.00"),
          }),
          // …a aktivna primena je samo jedna, na 2.000 — kao na ekranu.
          advanceDeductions: [{ documentNumber: "A-2/26", amount: d("2000.00") }],
        }),
      );
      expect(amountAfter(texts, "Za uplatu (RSD):")).toBe("8,000.00");
    });

    /**
     * NALAZ N4 (`docs/FAKTURE_ZAKONSKA_USKLADJENOST.md` §1.3): uslužni obrazac je avans
     * odbijao, robni nije — pa je za ISTU poslovnu situaciju kupac dobijao dva različita
     * iznosa „za uplatu", zavisno od toga da li mu je prodata roba ili usluga. Ovaj test
     * je brana da se ta razlika ne vrati ni na jednom od dva obrasca.
     */
    it("robna i uslužna faktura daju ISTI iznos za uplatu uz isti avans", () => {
      const invoice = makeInvoice({
        netTotal: d("16000.00"),
        vatTotal: d("3200.00"),
        grossTotal: d("19200.00"),
        advanceAppliedAmount: d("9200.00"),
      });
      const line = makeLine({
        name: "Ista stavka, isti novac",
        quantity: d(1),
        unitPrice: d("16000.00"),
        lineTotal: d("16000.00"),
      });
      const ctx = makeCtx({
        invoice,
        lines: [line],
        advanceDeductions: [{ documentNumber: "12/25", amount: d("9200.00") }],
      });

      const roba = amountAfter(
        collectText(domacaRobaTemplate(ctx)),
        "Za uplatu (RSD):",
      );
      const usluga = amountAfter(
        collectText(domacaUslugaTemplate(ctx)),
        "Ukupno za uplatu (RSD):",
      );
      expect(roba).toBe("10,000.00");
      expect(roba).toBe(usluga);
    });
  });

  describe("napomene", () => {
    it("štampa sve četiri, sa Privrednim sudom (usluga ima drugi sud)", () => {
      const texts = textOf(ifrCtx());
      expect(texts).toContain(NEMA_TEXT);
      expect(texts).toContain(
        "Reklamacije primamo u roku od 5 dana po prijemu robe.",
      );
      expect(texts).toContain("Za sve sporove nadležan je Privredni sud.");
      expect(texts).toContain(
        "U slučaju prekoračenja roka za plaćanje obračunavamo zakonom propisanu zateznu kamatu.",
      );
      expect(joinedOf(ifrCtx())).not.toContain("Trgovinski sud");
    });

    /**
     * REGRESIJA NA NALAZ N3 (`docs/FAKTURE_ZAKONSKA_USKLADJENOST.md` §1.3): napomena o
     * oslobođenju je bila tvrdo ukucana, pa je i račun BEZ obračunatog PDV-a tvrdio da
     * oslobođenja „NEMA". To je netačan obavezan element računa, ne kozmetika.
     */
    it("račun BEZ obračunatog PDV-a dobija pravu napomenu, ne „NEMA“", () => {
      const bezPdv = ifrCtx({
        invoice: makeInvoice({
          documentNumber: "657/25",
          netTotal: d("99363.64"),
          vatTotal: d(0),
          grossTotal: d("99363.64"),
        }),
      });
      const joined = joinedOf(bezPdv);
      expect(joined).not.toContain(NEMA_TEXT);
      expect(joined).toContain(exemptionFor("domestic-exempt")?.paperText);
    });

    it("račun SA obračunatim PDV-om i dalje nosi „NEMA“", () => {
      // IFR 657/25 nosi PDV 19.872,73 — tu oslobođenja zaista nema.
      expect(joinedOf(ifrCtx())).toContain(NEMA_TEXT);
      expect(joinedOf(ifgpCtx())).toContain(NEMA_TEXT);
    });

    it("tekst napomene dolazi iz `vat-exemption.ts`, ne iz šablona", () => {
      // Ako bi neko vratio ukucan tekst u šablon, ova tvrdnja bi i dalje prošla samo
      // ako je slovo u slovo ista — a onda bi se razišla sa SEF-om prvom izmenom tamo.
      const bezPdv = ifrCtx({
        invoice: makeInvoice({ vatTotal: d(0), grossTotal: d(0) }),
      });
      expect(textOf(bezPdv)).toContain(
        exemptionFor("domestic-exempt")?.paperText,
      );
    });
  });

  describe("blok potpisa", () => {
    it("ima tačno četiri kolone", () => {
      const content = domacaRobaTemplate(ifrCtx());
      const last = content[content.length - 1] as { columns?: unknown[] };
      expect(Array.isArray(last.columns)).toBe(true);
      expect(last.columns).toHaveLength(4);
    });

    it("nosi sva četiri naslova sa papira", () => {
      const texts = textOf(ifrCtx());
      expect(texts).toContain("Robu primio");
      expect(texts).toContain("Preuzeo za prevoz");
      expect(texts).toContain("Robu izdao");
      expect(texts).toContain("Odgovorno lice");
    });

    it("kolona „Robu izdao“ nosi magacin — IFR i IFGP se razlikuju samo po njemu", () => {
      expect(textOf(ifrCtx())).toContain("iz magacina Magacin robe");
      expect(textOf(ifgpCtx())).toContain("iz magacina Gotovi proizvodi");
    });

    it("kolona „Odgovorno lice“ nosi ime komercijaliste (odluka O-F2)", () => {
      expect(textOf(ifrCtx())).toContain("Dragana Korkut");
    });

    /**
     * ODLUKA O-F3, dosledno sprovedena (02.08.2026): ne štampa se ni broj lične karte ni
     * NATPIS uz praznu liniju. Prazno polje koje traži podatak o ličnosti bez pravnog
     * osnova i dalje traži taj podatak (`FAKTURE_ZAKONSKA_USKLADJENOST.md` §2.2, P3).
     */
    it("nigde ne pominje broj lične karte — ni natpis (O-F3)", () => {
      const joined = joinedOf(ifrCtx());
      expect(joined.toLowerCase()).not.toContain("l.k.");
      expect(joined.toLowerCase()).not.toContain("lične karte");
      expect(joined).not.toMatch(/_{3,}/); // ni prazna linija za ručni upis
    });

    it("sve četiri potpisne linije OSTAJU — one su dokaz o isporuci, ne potpis računa", () => {
      const content = domacaRobaTemplate(ifrCtx());
      const last = content[content.length - 1] as { columns?: unknown[] };
      expect(last.columns).toHaveLength(4);
      const joined = joinedOf(ifrCtx());
      // Kolona „Robu izdao" ostaje i posle skidanja natpisa o l.k.
      expect(joined).toContain("Robu izdao");
      expect(joined).toContain("iz magacina Magacin robe");
    });

    it("kolona prevoznika se gradi iz podataka firme, ne iz konstante u kodu", () => {
      const texts = textOf(
        ifrCtx({
          issuer: { ...ISSUER, companyName: "Druga Firma d.o.o." },
        }),
      );
      expect(texts).toContain("Druga Firma d.o.o.");
    });

    /**
     * ODLUKA O-F8 (03.08.2026) — BRANA NAD GREŠKOM KOJU JE BIGBIT NOSIO GODINAMA.
     *
     * Na papiru IFR 657/25 blok „Preuzeo za prevoz" nosi NAŠE podatke uz potpis, ali je
     * matični broj u njemu `20748346` — a to je matični broj KUPCA (isti broj stoji i u
     * okviru „HAP FLUID D.O.O. · PIB: 107136558 - MB: 20748346"). Naš pravi matični broj
     * `17400169` stoji u podnožju TE ISTE fakture. Greška je u samom BigBit obrascu, pa je
     * nosila svaka faktura za robu ikad odštampana iz njega; vlasnik je 03.08.2026. presudio
     * mogućnost A — štampa se NAŠ broj.
     *
     * Tvrdnje ispod moraju da padnu čim bi neko u ovaj blok uveo `ctx.customer`.
     */
    describe("matični broj uz potpis je NAŠ, nikad kupčev (O-F8)", () => {
      /** Tekstovi SAMO iz potpisnog bloka (poslednji element tela šablona). */
      const signatureTexts = (ctx: PrintCtx): string[] => {
        const content = domacaRobaTemplate(ctx);
        return collectText(content[content.length - 1]);
      };

      it("štampa matični broj firme; kupčev se u tom bloku ne pojavljuje", () => {
        const texts = signatureTexts(ifrCtx());
        expect(texts).toContain("PIB: 101017443 MB: 17400169");
        // 20748346 = MB kupca sa papira; u našem bloku nema šta da traži.
        expect(texts.join("\n")).not.toContain("20748346");
      });

      it("kad firma nema matični broj, red ostaje bez njega — ne posuđuje se kupčev", () => {
        const joined = signatureTexts(
          ifrCtx({ issuer: { ...ISSUER, registrationNumber: null } }),
        ).join("\n");
        expect(joined).toContain("PIB: 101017443");
        expect(joined).not.toContain("MB:");
        expect(joined).not.toContain("20748346");
      });

      it("izmena kupčevih identifikatora ne menja potpisni blok ni za jedan znak", () => {
        const nas = signatureTexts(ifrCtx());
        const tudji = signatureTexts(
          ifrCtx({
            customer: {
              ...CUSTOMER,
              taxId: "999999999",
              registrationNumber: "99999999",
            },
          }),
        );
        expect(tudji).toEqual(nas);
      });

      it("naziv firme je JEDAN oblik iz baze — bez velikih slova i bez grada (O-F9)", () => {
        const texts = signatureTexts(ifrCtx());
        expect(texts).toContain("Servoteh d.o.o.");
        // Papir je do sada nosio DVA oblika istog imena: memorandum „Servoteh d.o.o.
        // Dobanovci", potpisni blok „SERVOTEH doo".
        expect(texts.join("\n")).not.toContain("SERVOTEH doo");
        expect(texts.join("\n")).not.toContain("Servoteh d.o.o. Dobanovci");
      });

      it("prazan naziv firme ne ostavlja prazan red koji pomera raspored (O-F9)", () => {
        const texts = signatureTexts(
          ifrCtx({ issuer: { ...ISSUER, companyName: "" } }),
        );
        expect(texts).not.toContain("");
        expect(texts.join("\n")).toContain("Dobanovci, Ugrinovačka 163");
      });

      /**
       * ODLUKA O-F10: papir u ovom bloku poštanski broj NEMA — ni uz prevoznika
       * („Dobanovci, Ugrinovačka 163") ni uz magacin („Ugrinovačka 163, Dobanovci").
       * Dok je broj bio deo `companies.city`, ta dva reda nisu imala kako da ga izbace.
       */
      it("poštanski broj se u potpisnom bloku NE štampa (O-F10)", () => {
        const joined = signatureTexts(ifrCtx()).join("\n");
        expect(joined).toContain("Dobanovci, Ugrinovačka 163");
        expect(joined).toContain("Ugrinovačka 163, Dobanovci");
        expect(joined).not.toContain("11272");
      });
    });
  });

  describe("IFR i IFGP su ISTI šablon", () => {
    it("uz iste podatke razlikuju se samo u redu sa magacinom", () => {
      const base = ifrCtx();
      const gp = { ...base, warehouseName: "Gotovi proizvodi" };
      const a = collectText(domacaRobaTemplate(base));
      const b = collectText(domacaRobaTemplate(gp));
      expect(a).toHaveLength(b.length);
      const differing = a.filter((t, i) => t !== b[i]);
      expect(differing).toEqual(["iz magacina Magacin robe"]);
    });
  });

  describe("otpremnica bez cena (`withoutPrices`)", () => {
    it("izostavlja novčane kolone i ceo zbir, a ostalo zadržava", () => {
      const joined = joinedOf(ifrCtx({ withoutPrices: true }));
      expect(joined).not.toContain("C E N A");
      expect(joined).not.toContain("VREDNOST");
      expect(joined).not.toContain("Za uplatu");
      expect(joined).not.toContain("Rabat:");
      expect(joined).not.toContain("16,099.54");
      // Ostaje ono što otpremnica nosi: stavke, količine i potpisi.
      expect(joined).toContain("N A Z I V   R O B E");
      expect(joined).toContain("INSERT HME 212");
      expect(joined).toContain("Količina");
      expect(joined).toContain("iz magacina Magacin robe");
    });
  });

  describe("otpornost na nepotpune podatke", () => {
    it("bez kupca, magacina i komercijaliste ne puca i ne štampa prazne labele", () => {
      const ctx = ifrCtx({
        customer: null,
        warehouseName: null,
        signatory: null,
      });
      const joined = joinedOf(ctx);
      expect(joined).toContain("K u p a c:");
      expect(joined).not.toContain("iz magacina");
      expect(joined).toContain("Robu izdao");
    });

    it("bez tekućeg računa izostaje ceo red umesto prazne labele", () => {
      const joined = joinedOf(
        ifrCtx({ issuer: { ...ISSUER, bankAccount: null } }),
      );
      expect(joined).not.toContain("Tekući račun");
      expect(joined).toContain("Račun br. 657/25");
    });

    it("račun bez stavki i dalje daje ispravan okvir tabele", () => {
      const texts = textOf(ifrCtx({ lines: [] }));
      expect(texts).toContain("N A Z I V   R O B E");
    });
  });

  /**
   * Prava provera: telo mora da PROĐE kroz pdfmake. Uokviren iznos, `colSpan` u traci
   * uslova i canvas-linije potpisa su mesta na kojima pdfmake ume da pukne — ovde bi se
   * to videlo, umesto tek na produ pri skidanju PDF-a.
   */
  it("renderuje se kroz pdfmake u ispravan PDF", async () => {
    const dd: TDocumentDefinitions = {
      pageSize: "A4",
      pageMargins: [32, 32, 32, 40],
      content: domacaRobaTemplate(ifrCtx()),
      defaultStyle: { font: "Roboto", fontSize: 9 },
    };
    const buffer = await new PdfService().render(dd);
    expect(buffer.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(buffer.length).toBeGreaterThan(1000);
  }, 30000);
});
