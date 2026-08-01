import { Prisma } from "@prisma/client";
import { UblBuilderService } from "./ubl-builder.service";

/**
 * UBL builder — broj dokumenta u SEF-u (odluka O-F1).
 *
 * Suština O-F1: broj koji stoji na papiru mora biti ISTI broj koji ide na SEF i u
 * glavnu knjigu. Ovaj test je brana za `cbc:ID` — da se broj ne „ulepšava",
 * ne dopunjava prefiksom vrste dokumenta i ne skraćuje pri slanju.
 */

const D = Prisma.Decimal;

function params(overrides: { documentNumber?: string; pdfFileName?: string | null } = {}) {
  return {
    invoice: {
      documentType: "IFR",
      documentNumber: overrides.documentNumber ?? "657/25",
      documentDate: new Date("2025-12-31T00:00:00Z"),
      dueDate: new Date("2026-01-30T00:00:00Z"),
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
