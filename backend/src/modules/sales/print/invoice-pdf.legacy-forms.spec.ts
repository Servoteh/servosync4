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
});
