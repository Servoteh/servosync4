import { BadRequestException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { UblBuilderService } from "./ubl-builder.service";

/**
 * UBL builder — broj dokumenta u SEF-u (odluka O-F1) i datum prometa (mera M1).
 *
 * Suština O-F1: broj koji stoji na papiru mora biti ISTI broj koji ide na SEF i u
 * glavnu knjigu. Ovaj test je brana za `cbc:ID` — da se broj ne „ulepšava",
 * ne dopunjava prefiksom vrste dokumenta i ne skraćuje pri slanju.
 */

const D = Prisma.Decimal;

interface ParamOverrides {
  documentNumber?: string;
  pdfFileName?: string | null;
  /** `null` = račun BEZ datuma prometa (provera brane). */
  deliveryDate?: Date | null;
  isPrepayment?: boolean;
}

function params(overrides: ParamOverrides = {}) {
  return {
    invoice: {
      documentType: "IFR",
      documentNumber: overrides.documentNumber ?? "657/25",
      documentDate: new Date("2025-12-31T00:00:00Z"),
      dueDate: new Date("2026-01-30T00:00:00Z"),
      // Datum prometa je obavezan element računa — svaki fixture ga nosi, osim
      // testova koji baš proveravaju branu.
      deliveryDate:
        overrides.deliveryDate === undefined
          ? new Date("2025-12-25T00:00:00Z")
          : overrides.deliveryDate,
      ...(overrides.isPrepayment !== undefined
        ? { isPrepayment: overrides.isPrepayment }
        : {}),
      currency: "RSD",
      isExport: false,
      netTotal: new D(10000),
      vatTotal: new D(2000),
      grossTotal: new D(12000),
    },
    items: [
      {
        lineNo: 1,
        description: "Usluga",
        quantity: new D(1),
        unitPrice: new D(10000),
        discountPercent: new D(0),
        vatRateCode: "3",
        vatBase: new D(10000),
        vatAmount: new D(2000),
        lineTotal: new D(12000),
      },
    ],
    supplier: { name: "Servoteh d.o.o.", taxId: "100000000" },
    customer: { name: "Kupac d.o.o.", taxId: "200000000" },
    ...(overrides.pdfFileName !== undefined
      ? { pdfBase64: "QUJD", pdfFileName: overrides.pdfFileName }
      : {}),
  };
}

describe("UblBuilderService — broj dokumenta (O-F1)", () => {
  const ubl = new UblBuilderService();

  it("cbc:ID nosi broj DOSLOVNO u obliku NNN/GG (papir = SEF = knjiga)", () => {
    const xml = ubl.build(params());
    expect(xml).toContain("<cbc:ID>657/25</cbc:ID>");
    // Stari oblik sa prefiksom vrste ne sme da se pojavi.
    expect(xml).not.toContain("IFR");
  });

  it("kosa crta u broju se NE escape-uje niti menja", () => {
    const xml = ubl.build(params({ documentNumber: "1/26" }));
    expect(xml).toContain("<cbc:ID>1/26</cbc:ID>");
  });

  it("rezervno ime PDF priloga ne sme da izgleda kao putanja (657/25 → 657-25.pdf)", () => {
    const xml = ubl.build(params({ documentNumber: "657/25", pdfFileName: null }));
    expect(xml).toContain("657-25.pdf");
    expect(xml).not.toContain("657/25.pdf");
  });

  it("prosleđeno ime PDF priloga (iz štampe) ima prednost", () => {
    const xml = ubl.build(
      params({ documentNumber: "657/25", pdfFileName: "FAK-657-25.pdf" }),
    );
    expect(xml).toContain("FAK-657-25.pdf");
  });
});

/**
 * DATUM PROMETA u SEF-u (mera M1 iz docs/FAKTURE_ZAKONSKA_USKLADJENOST.md).
 * Obavezan element računa po Zakonu o PDV koji builder do 02.08.2026. uopšte nije slao.
 */
describe("UblBuilderService — datum prometa (cac:Delivery/cbc:ActualDeliveryDate)", () => {
  const ubl = new UblBuilderService();

  it("datum prometa ide u cac:Delivery/cbc:ActualDeliveryDate kao YYYY-MM-DD", () => {
    const xml = ubl.build(params({ deliveryDate: new Date("2025-12-25T00:00:00Z") }));
    expect(xml).toContain(
      "<cac:Delivery><cbc:ActualDeliveryDate>2025-12-25</cbc:ActualDeliveryDate></cac:Delivery>",
    );
  });

  it("datum prometa je zaseban podatak — NE prepisuje se sa datuma izdavanja", () => {
    // Izdavanje 31.12., promet 25.12. — XML mora nositi oba, različita.
    const xml = ubl.build(params({ deliveryDate: new Date("2025-12-25T00:00:00Z") }));
    expect(xml).toContain("<cbc:IssueDate>2025-12-31</cbc:IssueDate>");
    expect(xml).toContain("<cbc:ActualDeliveryDate>2025-12-25</cbc:ActualDeliveryDate>");
  });

  it("cac:Delivery stoji POSLE kupca a PRE cac:TaxTotal (UBL 2.1 redosled)", () => {
    // Pogrešan redosled elemenata = odbijen dokument na SEF-u, pa je pozicija test, ne stil.
    const xml = ubl.build(params());
    const customerEnd = xml.indexOf("</cac:AccountingCustomerParty>");
    const delivery = xml.indexOf("<cac:Delivery>");
    const taxTotal = xml.indexOf("<cac:TaxTotal>");
    expect(customerEnd).toBeGreaterThan(-1);
    expect(delivery).toBeGreaterThan(customerEnd);
    expect(taxTotal).toBeGreaterThan(delivery);
  });

  it("račun BEZ datuma prometa ne odlazi tiho — build baca 400", () => {
    expect(() => ubl.build(params({ deliveryDate: null }))).toThrow(
      BadRequestException,
    );
    // Poruka mora da imenuje dokument i da kaže šta korisnik treba da uradi.
    expect(() => ubl.build(params({ deliveryDate: null }))).toThrow(
      /657\/25.*datum prometa/s,
    );
  });

  it("avansni račun (386) sme bez datuma prometa — promet se još nije desio", () => {
    const xml = ubl.build(params({ deliveryDate: null, isPrepayment: true }));
    expect(xml).toContain("<cbc:InvoiceTypeCode>386</cbc:InvoiceTypeCode>");
    expect(xml).not.toContain("<cac:Delivery>");
  });
});
