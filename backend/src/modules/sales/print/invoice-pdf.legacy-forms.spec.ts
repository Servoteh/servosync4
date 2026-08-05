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

  /**
   * 🔴 VISOK NALAZ (peti krug, 02.08.2026): rekapitulacija poreza je PDV grupe dobijala
   * SABIRANJEM zaokruženih PDV-a po stavci, pa je odštampani red poricao sam sebe —
   * `20 %  500,05  100,00`, a `500,05 × 20 % = 100,01`. Doneti papir `IFR.pdf` (657/25)
   * tu jednačinu drži tačnu (`99.363,64 × 20 % = 19.872,73`).
   *
   * ULAZ: pet stavki po 100,01 din. Zbir PDV-a po stavci je 5 × 20,00 = 100,00; porez
   * dokumenta (i zaglavlje, i GK, i SEF) je `round2(500,05 × 20 %) = 100,01`.
   */
  it("rekapitulacija PDV-a množi osnovicu stopom, ne sabira PDV po stavkama", async () => {
    const items = [1, 2, 3, 4, 5].map((n) => ({
      id: n,
      lineNo: n,
      itemId: 100,
      description: `Stavka ${n}`,
      unit: "kom",
      quantity: D("1"),
      unitPrice: D("100.01"),
      discountPercent: D("0"),
      vatRateCode: "3",
      vatBase: D("100.01"),
      // Zaokružen PDV STAVKE (izvedena informacija) — zbir mu je 100,00.
      vatAmount: D("20.00"),
      lineTotal: D("120.01"),
    }));
    const prisma = prismaFor(
      row({
        documentType: "KO",
        documentNumber: "KO-5/26",
        netTotal: D("500.05"),
        vatTotal: D("100.01"),
        grossTotal: D("600.06"),
        items,
      }),
    );

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
    const i = texts.indexOf("500,05");
    expect(i).toBeGreaterThanOrEqual(0);
    // Red rekapitulacije: osnovica → PDV → ukupno. Množenje odštampanih brojeva mora
    // da da odštampan rezultat.
    expect(texts[i + 1]).toBe("100,01");
    expect(texts[i + 2]).toBe("600,06");
    // Kontrolni red se poklapa sa bruto iznosom → nema crvenog upozorenja o razlici.
    expect(texts.join("\n")).not.toContain("razlika");
  });

  /**
   * 🔴 NALAZ R1 (šesti krug, 02.08.2026): AVANSNI RAČUN. Prethodna ispravka je uvela
   * `PDV_grupe = round2(osnovica × stopa)` i u rekapitulaciju — ali AVR porez NE MNOŽI
   * nego DELI (`advance-invoice.service.ts` → `grossToNet`).
   *
   * IZMERENO — AVR na bruto 132,03 din uz 20 %:
   *     osnovica = round2(132,03 / 1,2) = 110,03      porez = 132,03 − 110,03 = 22,00
   *   (to je ono što stoji u zaglavlju, u glavnoj knjizi i u redu „Ukupno za uplatu")
   *
   *   Papir je štampao `19,99 % | 110,03 | 21,99 | 132,02`:
   *     • stopa 19,99 % = `22,00 / 110,03` (efektivna stopa iz iznosa) — nije poreska stopa;
   *     • porez 21,99 = `round2(110,03 × 19,99 %)` — ponovljeno množenje po toj stopi;
   *     • zbir 132,02 naspram „Ukupno za uplatu 132,03" — papir ne sabira u svoj bruto.
   *   Crveno upozorenje NIJE izlazilo, jer je prag bio `razlika > 0,01`, a razlika je bila
   *   TAČNO 0,01. Učestalost (brute force, svi bruto iznosi): 16,67 % avansa po 20 %.
   */
  it("avans 132,03: rekapitulacija štampa 20 % | 110,03 | 22,00 | 132,03", async () => {
    const prisma = prismaFor(
      row({
        documentType: "AVR",
        documentNumber: "A-7/26",
        netTotal: D("110.03"),
        vatTotal: D("22.00"),
        grossTotal: D("132.03"),
        items: [
          {
            id: 1,
            lineNo: 1,
            itemId: null,
            description: "Avans po ugovoru 12/26",
            unit: null,
            quantity: D("1"),
            unitPrice: D("110.03"),
            discountPercent: D("0"),
            vatRateCode: "3",
            vatBase: D("110.03"),
            vatAmount: D("22.00"),
            lineTotal: D("132.03"),
          },
        ],
      }),
    );

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

    await service.buildInvoicePdf(1);
    const texts = collectText(captured?.content);
    const joined = texts.join("\n");

    // Stopa je poreska (20 %), a ne izvedena iz odnosa iznosa (19,99 %).
    expect(joined).not.toContain("19,99%");
    const i = texts.indexOf("20%");
    expect(i).toBeGreaterThanOrEqual(0);
    expect(texts[i + 1]).toBe("110,03");
    expect(texts[i + 2]).toBe("22,00"); // NE 21,99
    expect(texts[i + 3]).toBe("132,03"); // NE 132,02 — zatvara se u naplaćen bruto

    // I dalje bez crvenog upozorenja — ali sada zato što se zbir STVARNO poklapa.
    expect(joined).not.toContain("NEUSKLAĐENO");
  });

  /**
   * 🔴 NALAZ Z1 (sedmi krug, 02.08.2026): KONTROLNI RED JE MERIO IZRAZ KOJI JE PO
   * KONSTRUKCIJI NULA. Do sada je bio `Σosnovica + ΣPDV − grossTotal`, a `grossTotal` je
   * u zaglavlju uvek `netTotal + vatTotal` (tako ga piše i uvoz i ručna izmena kroz UI),
   * pa se izraz skraćivao u nulu ma koliko `vat_total` bio pogrešan.
   *
   * ULAZ (izmeren): 20 stavki × 1.000,00 uz 20 %. Tačan porez je 4.000,00, a zaglavlje
   * nosi 3.999,80. Stari pojas (`0,01 × 20 redova` = 0,20) je razliku usisao u grupu, pa
   * je papir štampao `20 % | 20.000,00 | 3.999,80 | 23.999,80` BEZ crvenog reda.
   */
  it("🔴 Z1 — rekapitulacija prijavljuje pogrešan `vat_total` (3.999,80 umesto 4.000,00)", async () => {
    const items = Array.from({ length: 20 }, (_, n) => ({
      id: n + 1,
      lineNo: n + 1,
      itemId: 100,
      description: `Stavka ${n + 1}`,
      unit: "kom",
      quantity: D("1"),
      unitPrice: D("1000.00"),
      discountPercent: D("0"),
      vatRateCode: "3",
      vatBase: D("1000.00"),
      vatAmount: D("200.00"),
      lineTotal: D("1200.00"),
    }));
    const prisma = prismaFor(
      row({
        documentType: "KO",
        documentNumber: "KO-9/26",
        netTotal: D("20000.00"),
        vatTotal: D("3999.80"),
        // Zaglavlje je INTERNO DOSLEDNO — baš zato ga staro merilo nije videlo.
        grossTotal: D("23999.80"),
        items,
      }),
    );

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
    const i = texts.indexOf("20.000,00");
    expect(i).toBeGreaterThanOrEqual(0);
    expect(texts[i + 1]).toBe("4.000,00"); // NE 3.999,80 — razlika se ne guta

    const joined = texts.join("\n");
    expect(joined).toContain("NEUSKLAĐENO");
    // Natpis imenuje OBE strane: osnovica se poklapa, porez ne.
    expect(joined).toContain("Osnovica 0,00");
    expect(joined).toContain("PDV 0,20");
  });

  // Isti kontrolni red na ČETIRI DONESENA OBRASCA meri `invoice-pdf.service.spec.ts`
  // (samo tamo postoji lažni klijent sa magacinima i vrstama dokumenata).
});
