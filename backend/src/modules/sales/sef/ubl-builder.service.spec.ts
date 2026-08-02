import { BadRequestException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { XmlDocument, type XmlElement } from "xmldoc";

import {
  UblBuilderService,
  unitCodeOf,
  type UblBuildParams,
  type UblInvoiceItemInput,
} from "./ubl-builder.service";

/**
 * UBL BUILDER — struktura izlazne e-fakture (grupa D) + broj dokumenta (O-F1)
 * i datum prometa (mera M1).
 * ============================================================================
 * ⚠️ U repou (ni u `_legacy/`) NEMA UBL 2.1 XSD ni SEF CIUS Schematron datoteke, a
 * novi npm paketi nisu dozvoljeni — pa se NE radi prava validacija po shemi. Umesto
 * toga se proverava ono što se bez sheme može proveriti pošteno:
 *   1) dokument je dobro formiran XML (parsira ga `xmldoc`, već zavisnost repoa),
 *   2) REDOSLED dece korenog <Invoice> prati UBL 2.1 sekvencu (odstupanje = odbijen
 *      dokument na SEF-u; to je najčešća greška kod ručno građenog XML-a),
 *   3) sadržaj novih blokova (cac:PaymentMeans, cac:Delivery) i @unitCode po stavci,
 *   4) da broj računa ide na SEF DOSLOVNO onako kako stoji na papiru (odluka O-F1),
 *   5) da račun bez datuma prometa PADNE umesto da tiho ode bez obaveznog elementa.
 * Pravu XSD/Schematron validaciju treba uraditi na SEF demo okruženju pre prod-a.
 *
 * ⚠️ SPAJANJE 02.08.2026: tačke 1–3 su stigle sa `main`-a, tačke 4–5 sa grane za
 * štampu faktura. Obe strane su ovaj fajl stvorile nezavisno; spojene su, a ne
 * izabrane, jer proveravaju različite stvari nad istim builderom. Usput je i podatak
 * ujednačen: datum prometa se svuda zove `supplyDate` (ranije i `deliveryDate`).
 */

/**
 * UBL 2.1 `Invoice` — redosled elemenata (podskup koji builder ume da ispiše).
 * Izvor: OASIS UBL 2.1 `UBL-Invoice-2.1.xsd` (sekvenca `InvoiceType`). Indeks u nizu
 * je jedini bitan podatak: XML sme da preskoči element, ali ne sme da ga premesti.
 */
const UBL_INVOICE_ORDER = [
  "cbc:CustomizationID",
  "cbc:ProfileID",
  "cbc:ID",
  "cbc:IssueDate",
  "cbc:DueDate",
  "cbc:InvoiceTypeCode",
  "cbc:Note",
  "cbc:DocumentCurrencyCode",
  "cac:OrderReference",
  "cac:BillingReference",
  "cac:AdditionalDocumentReference",
  "cac:AccountingSupplierParty",
  "cac:AccountingCustomerParty",
  "cac:Delivery",
  "cac:PaymentMeans",
  "cac:TaxTotal",
  "cac:LegalMonetaryTotal",
  "cac:InvoiceLine",
] as const;

/** Nazivi dece elementa, redom kako su ispisani. */
function childNames(node: XmlDocument | XmlElement): string[] {
  return elementChildren(node).map((c) => c.name);
}

/** Elementi-deca (bez tekstualnih čvorova). */
function elementChildren(node: XmlDocument | XmlElement): XmlElement[] {
  return node.children.filter(
    (c): c is XmlElement => (c as XmlElement).name !== undefined,
  );
}

/** Prvi element sa datim imenom (bilo gde u stablu). */
function findFirst(
  node: XmlDocument | XmlElement,
  name: string,
): XmlElement | null {
  for (const child of elementChildren(node)) {
    if (child.name === name) return child;
    const deeper = findFirst(child, name);
    if (deeper) return deeper;
  }
  return null;
}

const D = (v: string | number) => new Prisma.Decimal(v);

function line(over: Partial<UblInvoiceItemInput> = {}): UblInvoiceItemInput {
  return {
    lineNo: 1,
    description: "Testni artikal",
    itemId: 1,
    unit: "Kom",
    quantity: D(2),
    unitPrice: D(100),
    discountPercent: D(0),
    vatRateCode: "3",
    vatBase: D(200),
    vatAmount: D(40),
    lineTotal: D(240),
    ...over,
  };
}

function params(over: Partial<UblBuildParams> = {}): UblBuildParams {
  return {
    invoice: {
      documentType: "IFR",
      documentNumber: "IFR-00042/2026",
      documentDate: new Date("2026-07-27T00:00:00Z"),
      dueDate: new Date("2026-08-26T00:00:00Z"),
      currency: "RSD",
      isExport: false,
      // DATUM PROMETA je obavezan element računa i builder bez njega ODBIJA dokument
      // (osim avansnog), pa ga podrazumevani fixture nosi. Testovi koji proveravaju
      // baš tu branu ga izričito gase (`supplyDate: null`).
      supplyDate: new Date("2026-07-25T00:00:00Z"),
      netTotal: D(200),
      vatTotal: D(40),
      grossTotal: D(240),
      ...(over.invoice ?? {}),
    },
    items: over.items ?? [line()],
    supplier: {
      name: "SERVOTEH DOO",
      taxId: "100000000",
      registrationNumber: "07000000",
      address: "Industrijska 1",
      city: "Beograd",
      bankAccount: "160-1234567890123-45",
      ...(over.supplier ?? {}),
    },
    customer: {
      name: "KUPAC DOO",
      taxId: "101010101",
      address: "Glavna 5",
      city: "Novi Sad",
      ...(over.customer ?? {}),
    },
    // Prilog se prosleđuje samo kad ga test traži — inače bi svaki XML nosio prazan
    // `cac:AdditionalDocumentReference`.
    ...(over.pdfBase64 !== undefined ? { pdfBase64: over.pdfBase64 } : {}),
    ...(over.pdfFileName !== undefined
      ? { pdfFileName: over.pdfFileName }
      : {}),
  };
}

describe("UblBuilderService — struktura (grupa D)", () => {
  let service: UblBuilderService;

  beforeEach(() => {
    service = new UblBuilderService();
  });

  it("gradi dobro formiran XML sa UBL 2.1 redosledom elemenata", () => {
    const xml = service.build(
      params({
        invoice: {
          ...params().invoice,
          poNumber: "NAR-77",
          supplyDate: new Date("2026-07-25T00:00:00Z"),
          paymentReference: "97 12-3456789",
        },
      }),
    );
    const doc = new XmlDocument(xml);
    expect(doc.name).toBe("Invoice");

    const seen = childNames(doc);
    // Svaki ispisani element mora biti poznat i ne sme da „skoči" ispred prethodnog.
    const positions = seen.map((name) =>
      UBL_INVOICE_ORDER.indexOf(name as (typeof UBL_INVOICE_ORDER)[number]),
    );
    expect(seen.filter((_, i) => positions[i] < 0)).toEqual([]);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    // cac:Delivery i cac:PaymentMeans MORAJU stajati između kupca i poreza.
    expect(seen.indexOf("cac:Delivery")).toBeGreaterThan(
      seen.indexOf("cac:AccountingCustomerParty"),
    );
    expect(seen.indexOf("cac:PaymentMeans")).toBeGreaterThan(
      seen.indexOf("cac:Delivery"),
    );
    expect(seen.indexOf("cac:TaxTotal")).toBeGreaterThan(
      seen.indexOf("cac:PaymentMeans"),
    );
  });

  describe("cac:PaymentMeans", () => {
    it("nosi šifru 42 (BigBit paritet), poziv na broj i račun za uplatu", () => {
      const xml = service.build(
        params({
          invoice: {
            ...params().invoice,
            paymentReference: "97 12-3456789",
          },
        }),
      );
      const pm = findFirst(new XmlDocument(xml), "cac:PaymentMeans");
      expect(pm).not.toBeNull();
      expect(pm!.valueWithPath("cbc:PaymentMeansCode")).toBe("42");
      expect(pm!.valueWithPath("cbc:PaymentID")).toBe("97 12-3456789");
      expect(pm!.valueWithPath("cac:PayeeFinancialAccount.cbc:ID")).toBe(
        "160-1234567890123-45",
      );
      expect(pm!.valueWithPath("cac:PayeeFinancialAccount.cbc:Name")).toBe(
        "SERVOTEH DOO",
      );
    });

    it("koristi IBAN i SWIFT kad postoje (ino uplata)", () => {
      const xml = service.build(
        params({
          supplier: {
            ...params().supplier,
            iban: "RS35 1600 0000 0000 1234 56",
            swift: "DBDBRSBG",
          },
        }),
      );
      const pm = findFirst(new XmlDocument(xml), "cac:PaymentMeans")!;
      // IBAN se šalje bez razmaka i ima prednost nad domaćim tekućim računom.
      expect(pm.valueWithPath("cac:PayeeFinancialAccount.cbc:ID")).toBe(
        "RS35160000000000123456",
      );
      expect(
        pm.valueWithPath(
          "cac:PayeeFinancialAccount.cac:FinancialInstitutionBranch.cbc:ID",
        ),
      ).toBe("DBDBRSBG");
    });

    it("bez eksplicitnog poziva na broj koristi broj dokumenta (BigBit paritet)", () => {
      const xml = service.build(params());
      const pm = findFirst(new XmlDocument(xml), "cac:PaymentMeans")!;
      expect(pm.valueWithPath("cbc:PaymentID")).toBe("IFR-00042/2026");
    });

    it("bez računa firme ostaje samo šifra i poziv na broj (nema izmišljenog računa)", () => {
      const xml = service.build(
        params({ supplier: { ...params().supplier, bankAccount: null } }),
      );
      const pm = findFirst(new XmlDocument(xml), "cac:PaymentMeans")!;
      expect(childNames(pm)).toEqual(["cbc:PaymentMeansCode", "cbc:PaymentID"]);
    });
  });

  describe("cac:Delivery", () => {
    it("ispisuje datum prometa i mesto isporuke", () => {
      const xml = service.build(
        params({
          invoice: {
            ...params().invoice,
            supplyDate: new Date("2026-07-25T00:00:00Z"),
            deliveryStreet: "Skladišna 3",
            deliveryCity: "Kragujevac",
          },
        }),
      );
      const d = findFirst(new XmlDocument(xml), "cac:Delivery")!;
      expect(d.valueWithPath("cbc:ActualDeliveryDate")).toBe("2026-07-25");
      expect(
        d.valueWithPath("cac:DeliveryLocation.cac:Address.cbc:StreetName"),
      ).toBe("Skladišna 3");
      expect(
        d.valueWithPath("cac:DeliveryLocation.cac:Address.cbc:CityName"),
      ).toBe("Kragujevac");
    });

    it("bez mesta isporuke nosi SAMO datum — mesto se ne izmišlja", () => {
      const xml = service.build(params());
      const d = findFirst(new XmlDocument(xml), "cac:Delivery")!;
      expect(childNames(d)).toEqual(["cbc:ActualDeliveryDate"]);
    });

    it("se NE ispisuje na avansnom računu (BigBit F_IF_ImaDelivery)", () => {
      const xml = service.build(
        params({
          invoice: {
            ...params().invoice,
            isPrepayment: true,
            supplyDate: new Date("2026-07-25T00:00:00Z"),
          },
        }),
      );
      expect(findFirst(new XmlDocument(xml), "cac:Delivery")).toBeNull();
      expect(xml).toContain("<cbc:InvoiceTypeCode>386</cbc:InvoiceTypeCode>");
    });

    it("datum prometa je zaseban podatak — datum izdavanja se NE podmeće", () => {
      // Izdavanje 27.07., promet 25.07. — XML mora nositi oba, različita.
      const xml = service.build(params());
      expect(xml).toContain("<cbc:IssueDate>2026-07-27</cbc:IssueDate>");
      expect(xml).toContain(
        "<cbc:ActualDeliveryDate>2026-07-25</cbc:ActualDeliveryDate>",
      );
    });
  });

  describe("jedinica mere (@unitCode)", () => {
    it("mapira stvarnu jedinicu artikla, a ne tvrdo H87", () => {
      const xml = service.build(
        params({
          items: [
            line({ lineNo: 1, unit: "kg" }),
            line({ lineNo: 2, unit: "m2" }),
            line({ lineNo: 3, unit: "Kom." }),
            line({ lineNo: 4, unit: "set" }),
          ],
        }),
      );
      expect(xml).toContain('<cbc:InvoicedQuantity unitCode="KGM">');
      expect(xml).toContain('<cbc:InvoicedQuantity unitCode="MTK">');
      expect(xml).toContain('<cbc:InvoicedQuantity unitCode="H87">');
      expect(xml).toContain('<cbc:InvoicedQuantity unitCode="SET">');
    });

    it("nepoznata jedinica pada na H87 (bez rušenja dokumenta)", () => {
      const xml = service.build(params({ items: [line({ unit: "cet" })] }));
      expect(xml).toContain('<cbc:InvoicedQuantity unitCode="H87">');
    });
  });

  describe("unitCodeOf", () => {
    it.each([
      ["Kom", "H87"],
      ["Kom.", "H87"],
      ["kom", "H87"],
      ["pc", "H87"],
      ["Each", "H87"],
      ["kg", "KGM"],
      ["KG", "KGM"],
      ["t", "TNE"],
      ["m", "MTR"],
      ["m.", "MTR"],
      ["mm", "MMT"],
      [" m2", "MTK"],
      ["m²", "MTK"],
      ["m3", "MTQ"],
      ["l", "LTR"],
      ["Lit", "LTR"],
      ["h", "HUR"],
      ["min", "MIN"],
      ["dan", "DAY"],
      ["set", "SET"],
      ["kompl", "SET"],
      ["Pack", "XPK"],
      ["par", "PR"],
      ["usl", "E48"],
      ["šar", "H87"], // nepoznato → fallback
    ])("%s -> %s", (raw, expected) => {
      expect(unitCodeOf(raw).code).toBe(expected);
    });

    it("prazna/neuneta jedinica nije greška (H87, bez upozorenja)", () => {
      expect(unitCodeOf(null)).toEqual({ code: "H87", recognized: true });
      expect(unitCodeOf("   ")).toEqual({ code: "H87", recognized: true });
    });

    it("nepoznata jedinica se prijavljuje kao neprepoznata", () => {
      expect(unitCodeOf("cet").recognized).toBe(false);
      expect(unitCodeOf("cet").code).toBe("H87");
    });
  });

  it("avansni deo ostaje netaknut (PrepaidAmount pre PayableAmount)", () => {
    const xml = service.build(
      params({
        invoice: {
          ...params().invoice,
          prepaymentReferences: ["AVR-00013/2026"],
          prepaidAmount: D(100),
        },
      }),
    );
    const lmt = findFirst(new XmlDocument(xml), "cac:LegalMonetaryTotal")!;
    const order = childNames(lmt);
    expect(order.indexOf("cbc:PrepaidAmount")).toBeLessThan(
      order.indexOf("cbc:PayableAmount"),
    );
    expect(lmt.valueWithPath("cbc:PayableAmount")).toBe("140.00");
  });
});

/**
 * BROJ DOKUMENTA U SEF-u (odluka O-F1).
 *
 * Suština O-F1: broj koji stoji na papiru mora biti ISTI broj koji ide na SEF i u
 * glavnu knjigu. Ovi testovi su brana za `cbc:ID` — da se broj ne „ulepšava",
 * ne dopunjava prefiksom vrste dokumenta i ne skraćuje pri slanju.
 */
describe("UblBuilderService — broj dokumenta (O-F1)", () => {
  const ubl = new UblBuilderService();

  /** Fixture sa brojem u obliku sa papira (`657/25`). */
  const withNumber = (documentNumber: string, over: Partial<UblBuildParams> = {}) =>
    params({
      ...over,
      invoice: { ...params().invoice, documentNumber },
    });

  it("cbc:ID nosi broj DOSLOVNO u obliku NNN/GG (papir = SEF = knjiga)", () => {
    const xml = ubl.build(withNumber("657/25"));
    expect(xml).toContain("<cbc:ID>657/25</cbc:ID>");
    // Stari oblik sa prefiksom vrste ne sme da se pojavi.
    expect(xml).not.toContain("IFR");
  });

  it("kosa crta u broju se NE escape-uje niti menja", () => {
    const xml = ubl.build(withNumber("1/26"));
    expect(xml).toContain("<cbc:ID>1/26</cbc:ID>");
  });

  it("rezervno ime PDF priloga ne sme da izgleda kao putanja (657/25 → 657-25.pdf)", () => {
    const xml = ubl.build(
      withNumber("657/25", { pdfBase64: "QUJD", pdfFileName: null }),
    );
    expect(xml).toContain("657-25.pdf");
    expect(xml).not.toContain("657/25.pdf");
  });

  it("prosleđeno ime PDF priloga (iz štampe) ima prednost", () => {
    const xml = ubl.build(
      withNumber("657/25", {
        pdfBase64: "QUJD",
        pdfFileName: "FAK-657-25.pdf",
      }),
    );
    expect(xml).toContain("FAK-657-25.pdf");
  });
});

/**
 * DATUM PROMETA kao BRANA (mera M1 iz docs/FAKTURE_ZAKONSKA_USKLADJENOST.md).
 *
 * Obavezan element računa po Zakonu o PDV koji builder do 02.08.2026. uopšte nije slao.
 * Kod domaćeg B2B prometa e-faktura na SEF-u JESTE račun (§4.2) — papir je samo kopija.
 * Zato dokument bez tog podatka ne sme tiho da ode: glasan 400 pri slanju je jeftiniji
 * od storniranja već poslatog neispravnog računa.
 */
describe("UblBuilderService — datum prometa je brana, ne preporuka", () => {
  const ubl = new UblBuilderService();

  const withoutSupplyDate = (isPrepayment?: boolean) =>
    params({
      invoice: {
        ...params().invoice,
        documentNumber: "657/25",
        supplyDate: null,
        ...(isPrepayment !== undefined ? { isPrepayment } : {}),
      },
    });

  it("račun BEZ datuma prometa ne odlazi tiho — build baca 400", () => {
    expect(() => ubl.build(withoutSupplyDate())).toThrow(BadRequestException);
    // Poruka mora da imenuje dokument i da kaže šta korisnik treba da uradi.
    expect(() => ubl.build(withoutSupplyDate())).toThrow(
      /657\/25.*datum prometa/s,
    );
  });

  it("avansni račun (386) sme bez datuma prometa — promet se još nije desio", () => {
    const xml = ubl.build(withoutSupplyDate(true));
    expect(xml).toContain("<cbc:InvoiceTypeCode>386</cbc:InvoiceTypeCode>");
    expect(xml).not.toContain("<cac:Delivery>");
  });
});
