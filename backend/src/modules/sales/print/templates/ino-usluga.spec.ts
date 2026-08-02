import { Prisma } from "@prisma/client";
import { PDFDocument } from "pdf-lib";
import type { Content, TDocumentDefinitions } from "pdfmake/interfaces";
import { BarcodeService } from "../../../documents/barcode.service";
import { PdfService } from "../../../documents/pdf.service";
import { exemptionFor } from "../../vat-exemption";
import {
  MEMORANDUM_MAP_QR_URL,
  MEMORANDUM_STYLES,
  memorandumFooter,
  memorandumHeader,
} from "../memorandum";
import type {
  InvoiceWithItems,
  PrintCtx,
  PrintCustomer,
  PrintIssuer,
  PrintLine,
} from "./ctx";
import {
  INO_USLUGA_PAGE_MARGINS,
  inoUslugaPageHeader,
  inoUslugaTemplate,
} from "./ino-usluga";

/**
 * Test-vektor je STVARNI papir: `docs/zahtevi/fakture-obrasci-2026-08/INOUslugaFaktura 060-26.pdf`
 * — šest stavki, EUR, tri strane. Brojevi (`1,119.96`, `4,683.37`, `10,530.75`), kilaža
 * (`1.720,00 kg`) i tekstovi su prepisani sa njega, pa svaka razlika u kodu ovde pukne.
 *
 * Ništa se ne dohvata iz baze: `PrintCtx` se sklapa ručno, kako i nalaže ugovor iz `ctx.ts`.
 */

const D = (v: string) => new Prisma.Decimal(v);

/**
 * `Invoice` u Prisma šemi ima pedesetak kolona, a ovaj šablon dodiruje njih desetak.
 * Zato se pravi realan objekat sa poljima koja štampa čita, pa se svede na `InvoiceWithItems`:
 * puna literalna kopija modela bi pukla pri svakoj sledećoj migraciji, a ništa ne bi dokazala.
 */
const invoice = {
  id: 1,
  documentType: "IZVUS",
  documentNumber: "060/26",
  level: 0,
  companyId: 1,
  customerId: 10,
  documentDate: new Date(2026, 2, 6),
  dueDate: new Date(2026, 2, 6),
  supplyDate: new Date(2026, 2, 6),
  currency: "EUR",
  netTotal: D("10530.75"),
  vatTotal: D("0"),
  grossTotal: D("10530.75"),
  advanceAppliedAmount: D("0"),
  status: "POSTED",
  isExport: true,
  note: null,
  // Otpremni blok (samo ovaj obrazac ga ima) — doslovno sa 060/26.
  deliveryTerm: "FCA Dobanovci-Beograd",
  packageDescription: "1 paleta",
  packageDimensions: "400 x 800 x 2400 mm",
  grossWeightKg: D("1720"),
  netWeightKg: D("1700"),
  unloadingPlace:
    "Hidraulika Flex d.o.o.\nJovana Cvijića 3\n78250 Laktaši, Bosna i Hercegovina",
  forwarderContact:
    "Evrounija d.o.o., CI Banja Luka\nTelefon: +387 51 490 727 / +387 65 768 476",
  items: [],
} as unknown as InvoiceWithItems;

const customer: PrintCustomer = {
  name: "Hidraulika Flex d.o.o.",
  address: "Jovana Cvijića 3",
  city: "Laktaši",
  postalCode: "78250",
  taxId: null,
  registrationNumber: null,
  country: "Bosna i Hercegovina",
};

const issuer: PrintIssuer = {
  companyName: "Servoteh d.o.o. Dobanovci",
  address: "Ugrinovačka 163",
  city: "11272 Dobanovci",
  taxId: "101017443",
  registrationNumber: "17400169",
  bankAccount: "160-5010003501-86",
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
  bankName: "Banca Intesa a.d. EUR",
  bankAddress: "Milentija Popovića 7b, 11070 New Belgrade\nRepublic of Serbia",
};

/** Šest stavki sa papira; `lineTotal` je prepisan, ne izračunat — papir je dokaz. */
const lines: PrintLine[] = [
  line(
    1,
    "520000 Bronza CuSn12 flah 62x12mm ; L=810mm x 7kom Bronza-flah",
    "kg",
    "40.8",
    "27.45",
    "1119.96",
  ),
  line(2, "520000 Bronza CuSn12 flah 62x12mm", "kg", "28.8", "28.47", "819.94"),
  line(3, "520000 Bronza CuSn12 flah 42x12mm", "kg", "27.8", "24.28", "674.98"),
  line(
    4,
    "520000 Bronza CuSn12 flah L=445mm x 9kom Bronza-flah",
    "kg",
    "19.6",
    "30.10",
    "590.00",
  ),
  line(
    5,
    "PS 670 2400/100/2312 Specijalna ploča",
    "kom",
    "1",
    "4683.37",
    "4683.37",
  ),
  line(
    6,
    "PS 270 650/75/2312 Specijalna ploča",
    "kom",
    "2",
    "1321.25",
    "2642.50",
  ),
];

function line(
  ordinal: number,
  name: string,
  unit: string,
  quantity: string,
  unitPrice: string,
  lineTotal: string,
): PrintLine {
  return {
    ordinal,
    catalogNumber: null,
    name,
    unit,
    customsTariff: null,
    quantity: D(quantity),
    unitPrice: D(unitPrice),
    // Papir nema rabat — cena pre rabata je ista kao cena stavke.
    unitPriceBeforeDiscount: D(unitPrice),
    discountPercent: D("0"),
    lineTotal: D(lineTotal),
    // Ino promet — nema PDV stope po stavci.
    vatRatePercent: null,
  };
}

const ctx: PrintCtx = {
  invoice,
  lines,
  customer,
  issuer,
  signatory: null,
  warehouseName: null,
  currency: "EUR",
  advanceDeductions: [],
  withoutPrices: false,
};

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

/** Sav tekst obrasca — telo + zaglavlje koje se ponavlja po stranama. */
function allText(c: PrintCtx = ctx): string {
  return [
    ...collectText(inoUslugaPageHeader(c)),
    ...collectText(inoUslugaTemplate(c)),
  ].join("\n");
}

describe("ino obrazac za uslugu (IZVUS, 060/26)", () => {
  describe("kolone stavki", () => {
    it("nosi tačno `No. | Description | Unit | Quantity | Price | Total`", () => {
      const head = collectText(inoUslugaPageHeader(ctx));
      for (const col of [
        "No.",
        "Description",
        "Unit",
        "Quantity",
        "Price",
        "Total",
      ])
        expect(head).toContain(col);
    });

    it("NEMA kolonu `Catalog No.` ni `Stat. goods No.` — usluga nema tarifu", () => {
      const joined = allText();
      expect(joined).not.toContain("Catalog No.");
      expect(joined).not.toContain("Stat. goods No.");
    });

    it("štampa šest stavki sa iznosima kao na papiru", () => {
      const joined = allText();
      expect(joined).toContain("1,119.96");
      expect(joined).toContain("819.94");
      expect(joined).toContain("674.98");
      expect(joined).toContain("590.00");
      expect(joined).toContain("4,683.37");
      expect(joined).toContain("2,642.50");
    });

    it("količinu piše bez suvišnih nula (`40.8`, `1`), a cenu sa dve decimale (`30.10`)", () => {
      const joined = allText();
      expect(joined).toContain("40.8");
      expect(joined).not.toContain("40.800");
      expect(joined).toContain("30.10");
    });
  });

  describe("zaglavlje koje se ponavlja na svakoj strani", () => {
    it("nosi broj računa, datum, kupca, adresu, isporuku i valutu plaćanja", () => {
      const joined = collectText(inoUslugaPageHeader(ctx)).join("\n");
      expect(joined).toMatch(/Invoice\s+No\.\s+060\/26/);
      expect(joined).toContain("Date:");
      expect(joined).toContain("06.03.2026.");
      expect(joined).toContain("Customer:");
      expect(joined).toContain("Hidraulika Flex d.o.o.");
      expect(joined).toContain("Address:");
      expect(joined).toContain("Date of delivery:");
      expect(joined).toContain("Payment terms:");
    });

    it("`Date of delivery` nosi DATUM I MESTO zajedno", () => {
      const joined = collectText(inoUslugaPageHeader(ctx)).join("\n");
      expect(joined).toContain("06-03-26 ,  Beograd");
    });

    it("adresa kupca je složena kao na papiru (ulica - mesto,država poštanski broj)", () => {
      const joined = collectText(inoUslugaPageHeader(ctx)).join("\n");
      expect(joined).toContain(
        "Jovana Cvijića 3 - Laktaši,Bosna i Hercegovina 78250",
      );
    });
  });

  describe("poresko oslobođenje", () => {
    it("koristi član 24. STAV 2 (usluga)", () => {
      expect(allText()).toContain(
        "Napomena: Oslobodjeno PDV-a na osnovu člana 24. stav 2 Zakona o pdv.",
      );
    });

    it("NE koristi član za robu (stav 1 tačka 2) — pogrešan član je poreski problem", () => {
      const joined = allText();
      expect(joined).not.toContain("stav 1");
      expect(joined).not.toContain("tačka 2");
    });

    /**
     * Tekst se od 02.08.2026. uzima iz `vat-exemption.ts`, odakle ga uzima i SEF builder —
     * pa papir i XML ne mogu da se raziđu (`FAKTURE_ZAKONSKA_USKLADJENOST.md` §3.3).
     */
    it("tekst je DOSLOVNO onaj iz `vat-exemption.ts`, ne kopija u šablonu", () => {
      expect(collectText(inoUslugaTemplate(ctx))).toContain(
        exemptionFor("export-service")?.paperText,
      );
    });

    it("nosi rok reklamacije i „Trgovinski sud u Beogradu“ (usluga, ne Privredni)", () => {
      const joined = allText();
      expect(joined).toContain("Reklamacije primamo u roku od 5 dana.");
      expect(joined).toContain(
        "Za sve sporove nadležan je Trgovinski sud u Beogradu.",
      );
    });
  });

  describe("otpremni blok (nema ga nijedan drugi obrazac)", () => {
    it("nosi sve stavke bloka sa papira", () => {
      const joined = allText();
      expect(joined).toContain("Paritet: FCA Dobanovci-Beograd");
      expect(joined).toContain("Količina: 1 paleta");
      expect(joined).toContain("Dimenzije: 400 x 800 x 2400 mm");
      expect(joined).toContain("Ukupna brutto: 1.720,00 kg");
      expect(joined).toContain("Ukupna Netto: 1.700,00 kg");
      expect(joined).toContain("Mesto istovara:");
      expect(joined).toContain("78250 Laktaši, Bosna i Hercegovina");
      expect(joined).toContain("Kontakt špeditera u uvozu:");
      expect(joined).toContain("Evrounija d.o.o., CI Banja Luka");
      expect(joined).toContain("Telefon: +387 51 490 727 / +387 65 768 476");
    });

    it("kilaža ima OBRNUTE separatore od iznosa na istoj strani", () => {
      const joined = allText();
      // 1.720,00 kg (kilaža) naspram 10,530.75 (iznos) — tako je na originalu.
      expect(joined).toContain("1.720,00 kg");
      expect(joined).not.toContain("1,720.00");
      expect(joined).toContain("10,530.75");
    });

    it("izostavlja redove za koje podatak ne postoji, bez praznih labela", () => {
      const bez: PrintCtx = {
        ...ctx,
        invoice: {
          ...invoice,
          deliveryTerm: null,
          packageDescription: null,
          packageDimensions: null,
          grossWeightKg: null,
          netWeightKg: null,
          unloadingPlace: null,
          forwarderContact: null,
        } as unknown as InvoiceWithItems,
      };
      const joined = allText(bez);
      expect(joined).not.toContain("Paritet:");
      expect(joined).not.toContain("Ukupna brutto:");
      expect(joined).not.toContain("Mesto istovara:");
      // Ostatak obrasca mora ostati netaknut.
      expect(joined).toContain("10,530.75");
    });
  });

  describe("zbir i blok banke", () => {
    it("zbir je `TOTAL` + uokvireno `TOTAL AMOUNT ( EUR)` bez reda DISCOUNT", () => {
      const joined = allText();
      expect(joined).toContain("TOTAL");
      expect(joined).toContain("TOTAL AMOUNT ( EUR)");
      expect(joined).toContain("10,530.75");
      // Ino ROBA ima red DISCOUNT; 060/26 ga nema ni sa nulom.
      expect(joined).not.toContain("DISCOUNT");
    });

    /**
     * NALAZ (02.08.2026): ni ovaj ino obrazac nije odbijao primljeni avans — kupcu je
     * na papiru tražen pun iznos fakture i kad je deo već platio avansno. Izvozna
     * faktura NE ide na SEF (`sef.service.ts` je odbija), pa je papir jedini dokument.
     */
    describe("odbijen avans", () => {
      const saAvansom = (over: Record<string, unknown> = {}): PrintCtx => ({
        ...ctx,
        invoice: {
          ...invoice,
          advanceAppliedAmount: D("3000.00"),
        } as unknown as InvoiceWithItems,
        advanceDeductions: [{ documentNumber: "A-1/26", amount: D("3000.00") }],
        ...over,
      });

      it("štampa umanjenje i traži razliku, ne pun iznos", () => {
        const texts = collectText(inoUslugaTemplate(saAvansom()));
        const i = texts.indexOf("Less prepayment received (no. A-1/26):");
        expect(i).toBeGreaterThanOrEqual(0);
        expect(texts[i + 1]).toBe("− 3,000.00");
        // 10.530,75 − 3.000,00
        const payableAt = texts.indexOf("Amount payable ( EUR)");
        expect(payableAt).toBeGreaterThan(i);
        expect(texts[payableAt + 1]).toBe("7,530.75");
      });

      it("`TOTAL AMOUNT` ostaje pun iznos fakture", () => {
        const texts = collectText(inoUslugaTemplate(saAvansom()));
        expect(texts[texts.indexOf("TOTAL AMOUNT ( EUR)") + 1]).toBe(
          "10,530.75",
        );
      });

      it("bez broja avansnog računa red i dalje postoji, samo bez broja", () => {
        const texts = collectText(
          inoUslugaTemplate(
            saAvansom({
              advanceDeductions: [
                { documentNumber: null, amount: D("3000.00") },
              ],
            }),
          ),
        );
        expect(texts).toContain("Less prepayment received:");
      });

      it("avans veći od fakture ne daje negativan iznos za uplatu", () => {
        const texts = collectText(
          inoUslugaTemplate(
            saAvansom({
              invoice: {
                ...invoice,
                advanceAppliedAmount: D("12000.00"),
              } as unknown as InvoiceWithItems,
              advanceDeductions: [
                { documentNumber: "A-1/26", amount: D("12000.00") },
              ],
            }),
          ),
        );
        expect(texts[texts.indexOf("Amount payable ( EUR)") + 1]).toBe("0.00");
      });

      /**
       * NOVO-A na višestranom ino obrascu: dva avansa = dva reda umanjenja, svaki uz
       * SVOJ broj. Ranije je izlazio jedan red — broj prvog avansa uz zbir svih.
       */
      it("dva odbijena avansa daju dva reda, a `Amount payable` odbija oba", () => {
        const texts = collectText(
          inoUslugaTemplate(
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
        // 10.530,75 − 3.000,00 − 2.000,00
        expect(texts[texts.indexOf("Amount payable ( EUR)") + 1]).toBe(
          "5,530.75",
        );
      });

      it("bez avansa papir ostaje kao na 060/26", () => {
        const joined = allText();
        expect(joined).not.toContain("prepayment");
        expect(joined).not.toContain("Amount payable");
      });
    });

    /**
     * Izvoz je oslobođen PDV-a. Dokument koji ipak nosi obračunat PDV (npr. prepis
     * domaćeg predračuna u izvozni račun) štampao bi PDV unutar „TOTAL AMOUNT" na
     * papiru koji tvrdi suprotno — zato pada glasno, kao i na ino robi.
     */
    it("izvozni obrazac sa obračunatim PDV-om puca umesto da izda pogrešan papir", () => {
      const saPdv: PrintCtx = {
        ...ctx,
        invoice: {
          ...invoice,
          netTotal: D("10530.75"),
          vatTotal: D("2106.15"),
          grossTotal: D("12636.90"),
        } as unknown as InvoiceWithItems,
      };
      expect(() => inoUslugaTemplate(saPdv)).toThrow(/nosi obračunat PDV/);
      expect(() => inoUslugaTemplate(saPdv)).toThrow(/060\/26/);
    });

    it("blok banke ide na zasebnu poslednju stranu (`pageBreak`)", () => {
      const content = inoUslugaTemplate(ctx);
      const last = content[content.length - 1] as Content & {
        pageBreak?: string;
      };
      expect(last.pageBreak).toBe("before");
      const lastText = collectText(last).join("\n");
      expect(lastText).toContain("Beneficiary Customer:");
      expect(lastText).toContain("Bank of beneficiary:");
      expect(lastText).toContain("IBAN : RS35160005010003501186");
      expect(lastText).toContain("SWIFT: DBDBRSBG");
      expect(lastText).toContain("Banca Intesa a.d. EUR");
      expect(lastText).toContain("Republic of Serbia");
      // Zbir i otpremni blok NISU na strani banke.
      expect(lastText).not.toContain("TOTAL AMOUNT");
      expect(lastText).not.toContain("Paritet:");
    });

    it("zbir i otpremni blok dele stranu, odvojenu od stavki", () => {
      const content = inoUslugaTemplate(ctx);
      const middle = content[content.length - 2] as Content & {
        pageBreak?: string;
      };
      expect(middle.pageBreak).toBe("before");
      const middleText = collectText(middle).join("\n");
      expect(middleText).toContain("TOTAL AMOUNT ( EUR)");
      expect(middleText).toContain("Paritet: FCA Dobanovci-Beograd");
    });
  });

  it("nigde ne prepisuje vodeni žig `www.BigBit.rs` sa tuđeg obrasca", () => {
    expect(allText().toLowerCase()).not.toContain("bigbit");
  });

  /**
   * Prava provera koraka 7 (GAP §4): 060/26 mora dati TAČNO TRI strane — stavke,
   * zbir + otpremni blok, banka — i memorandum-podnožje sa „Strana X od Y".
   * Ovo je i jedini način da se dokaže da vezivanje opisano u `ino-usluga.ts` radi.
   */
  it("renderuje se kroz pdfmake u tri strane sa ponovljenim zaglavljem", async () => {
    const qrSvg = new BarcodeService().qrcodeSvg(MEMORANDUM_MAP_QR_URL);
    const dd: TDocumentDefinitions = {
      pageSize: "A4",
      pageMargins: INO_USLUGA_PAGE_MARGINS,
      header: () => ({
        margin: [32, 20, 32, 0],
        stack: [memorandumHeader(issuer, 531), inoUslugaPageHeader(ctx)],
      }),
      footer: (currentPage: number, pageCount: number) => ({
        margin: [32, 0, 32, 0],
        stack: [
          memorandumFooter(
            issuer,
            { qrSvg, pageText: `Strana ${currentPage} od ${pageCount}` },
            531,
          ),
        ],
      }),
      content: inoUslugaTemplate(ctx),
      styles: { ...MEMORANDUM_STYLES },
      defaultStyle: { font: "Roboto", fontSize: 9 },
    };

    const buffer = await new PdfService().render(dd);
    expect(buffer.subarray(0, 5).toString("latin1")).toBe("%PDF-");

    const pdf = await PDFDocument.load(buffer);
    expect(pdf.getPageCount()).toBe(3);
  }, 30000);
});
