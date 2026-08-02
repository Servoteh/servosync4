import { Prisma } from "@prisma/client";
import { BarcodeService } from "../../documents/barcode.service";
import { PdfService } from "../../documents/pdf.service";
import type { PrismaService } from "../../../prisma/prisma.service";
import { InvoicePdfService } from "./invoice-pdf.service";

/**
 * ZATEČENI (OPŠTI) RENDERER — AVR / knjižno odobrenje / knjižno zaduženje.
 *
 * Zašto ovaj test postoji: spajanjem 02.08.2026. je `InvoicePdfService` dobio DVA puta —
 * četiri donetа BigBit obrasca (po vrsti dokumenta) i zatečeni opšti renderer za vrste
 * za koje obrazac NIJE donet. Prvi put pokriva `invoice-pdf.service.spec.ts`; drugi do
 * sada nije pokrivao niko osim smoke-skripte kojoj treba baza. Bez ovoga bi neko sutra
 * „počistio mrtav kod" i tiho ugasio štampu avansnog računa i knjižnih dokumenata.
 *
 * Proverava se ono što se bez baze može proveriti pošteno: da se skretnica odlučuje po
 * varijanti/vrsti dokumenta, da PDF stvarno izađe iz pdfmake-a i da ime fajla nosi
 * ispravan prefiks (AVR/KO/KZ) — po tome korisnik razlikuje dokumente u prilozima.
 */

const D = (v: string | number) => new Prisma.Decimal(v);

function row(over: Record<string, unknown> = {}) {
  return {
    id: 1,
    documentType: "AVR",
    documentNumber: "A-1/26",
    level: 0,
    companyId: 1,
    customerId: 10,
    documentDate: new Date(2026, 6, 25),
    dueDate: null,
    supplyDate: null,
    currency: "RSD",
    netTotal: D("10000"),
    vatTotal: D("2000"),
    grossTotal: D("12000"),
    advanceInvoiceId: null,
    advanceAppliedAmount: D("0"),
    advancePaidAt: null,
    advancePaidAmount: D("0"),
    advanceBasis: "Ugovor 12/26",
    copiedFromDocId: null,
    linkedInvoiceDocId: null,
    status: "POSTED",
    isExport: false,
    note: null,
    items: [
      {
        id: 1,
        lineNo: 1,
        itemId: 100,
        description: "Avans po ugovoru",
        unit: "kom",
        quantity: D("1"),
        unitPrice: D("10000"),
        discountPercent: D("0"),
        vatRateCode: "3",
        vatBase: D("10000"),
        vatAmount: D("2000"),
        lineTotal: D("12000"),
      },
    ],
    ...over,
  };
}

function prismaFor(invoice: Record<string, unknown>) {
  return {
    invoice: {
      findUnique: jest.fn((args: { where: { id: number } }) =>
        Promise.resolve(args.where.id === invoice.id ? invoice : null),
      ),
    },
    customer: {
      findUnique: jest.fn(() =>
        Promise.resolve({
          name: "KUPAC DOO",
          address: "Glavna 5",
          city: "Novi Sad",
          postalCode: "21000",
          country: "Srbija",
          taxId: "101010101",
          registrationNumber: "20748346",
        }),
      ),
    },
    company: {
      findUnique: jest.fn(() =>
        Promise.resolve({
          companyName: "Servoteh d.o.o.",
          address: "Ugrinovačka 163",
          city: "Dobanovci",
          taxId: "101017443",
          registrationNumber: "17400169",
          bankAccount: "160-110610-83",
          phone: null,
          email: null,
          iban: "RS35160005010003501186",
          swift: "DBDBRSBG",
        }),
      ),
    },
    item: {
      findMany: jest.fn(() =>
        Promise.resolve([{ id: 100, name: "Avans", foreignName: null, unit: "kom" }]),
      ),
    },
    invoiceAdvanceApplication: { findMany: jest.fn(() => Promise.resolve([])) },
  };
}

/** Sav `text` iz pdfmake stabla — tvrdnje se pišu nad ravnim spiskom. */
function collectText(node: unknown, out: string[] = []): string[] {
  if (node == null) return out;
  if (Array.isArray(node)) {
    for (const n of node) collectText(n, out);
    return out;
  }
  if (typeof node === "object") {
    const o = node as Record<string, unknown>;
    if (typeof o.text === "string") out.push(o.text);
    else if (o.text != null) collectText(o.text, out);
    for (const key of ["stack", "columns", "table", "body"])
      if (o[key] != null) collectText(o[key], out);
  }
  return out;
}

describe("InvoicePdfService — vrste bez donetog obrasca idu na opšti renderer", () => {
  it.each([
    // Avansni račun bez izričite varijante sam bira avansni obrazac (documentType=AVR).
    ["avansni račun (bez varijante)", undefined, "AVR-A-1-26.pdf"],
    ["knjižno odobrenje", "creditNote" as const, "KO-A-1-26.pdf"],
    ["knjižno zaduženje", "debitNote" as const, "KZ-A-1-26.pdf"],
  ])("%s daje PDF sa svojim prefiksom", async (_n, variant, expected) => {
    const prisma = prismaFor(row());
    const service = new InvoicePdfService(
      prisma as unknown as PrismaService,
      new PdfService(),
      new BarcodeService(),
    );
    const out = await service.buildInvoicePdf(1, variant, "tester@servoteh");
    expect(out.fileName).toBe(expected);
    expect(out.buffer.length).toBeGreaterThan(1000);
  }, 30000);

  /**
   * 🔴 NALAZ N8 (02.08.2026): filtriranje primena sa iznosom 0 postojalo je SAMO na četiri
   * donesena obrasca (`printableAdvanceDeductions`), a opšti renderer ga nije imao — pa je
   * red „Umanjenje za primljeni avans (br. …): − 0,00" izlazio na KNJIŽNOM ODOBRENJU i
   * avansnom računu, dok ga faktura za isti avans nije imala.
   *
   * ULAZ: dve AKTIVNE primene, jedna na 0,00 (stornirana pa ponovo upisana / ručna
   * ispravka u bazi) i jedna na 2.000,00. Kupac red od 0,00 čita kao avans koji postoji, a
   * ništa ne umanjuje.
   */
  it("primena sa iznosom 0 ne daje red „− 0,00“ ni na opštem obrascu", async () => {
    const prisma = prismaFor(row({ documentType: "KO", documentNumber: "KO-3/26" }));
    prisma.invoiceAdvanceApplication.findMany = jest.fn(() =>
      Promise.resolve([
        {
          advanceInvoiceId: 9,
          appliedAmount: D("0"),
          advance: { documentNumber: "A-9/26" },
        },
        {
          advanceInvoiceId: 2,
          appliedAmount: D("2000"),
          advance: { documentNumber: "A-2/26" },
        },
      ]),
    ) as unknown as typeof prisma.invoiceAdvanceApplication.findMany;

    const pdf = new PdfService();
    let captured: { content?: unknown } | undefined;
    jest.spyOn(pdf, "render").mockImplementation(async (dd) => {
      captured = dd as { content?: unknown };
      return Buffer.from("x");
    });
    const service = new InvoicePdfService(
      prisma as unknown as PrismaService,
      pdf,
      new BarcodeService(),
    );

    await service.buildInvoicePdf(1, "creditNote");
    const texts = collectText(captured?.content);
    const joined = texts.join("\n");

    expect(joined).toContain("A-2/26");
    expect(joined).not.toContain("A-9/26");
    expect(texts).not.toContain("− 0,00");
    expect(texts).not.toContain("− 0.00");
    // „Za uplatu" i dalje odbija tačno ono što je na papiru navedeno: 12.000 − 2.000.
    expect(joined).toContain("10.000,00");
  });
});
