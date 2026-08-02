import { Prisma } from "@prisma/client";
import type { Content, TDocumentDefinitions } from "pdfmake/interfaces";
import { PdfService } from "../../../documents/pdf.service";
import { exemptionFor, NEMA_TEXT } from "../../vat-exemption";
import { MEMORANDUM_STYLES, memorandumHeader } from "../memorandum";
import type { InvoiceWithItems, PrintCtx, PrintLine } from "./ctx";
import { domacaUslugaTemplate } from "./domaca-usluga";

/**
 * Test-vektor je doneti papir `docs/zahtevi/fakture-obrasci-2026-08/IFUSL.pdf`
 * (račun 653/25, HAP FLUID d.o.o., zakup poslovnog prostora za decembar 2025).
 * Brojevi i natpisi ovde NISU izmišljeni — ako neki od ovih testova padne, znači
 * da bi papir izašao drugačiji nego onaj koji je već otišao kupcu.
 */

const d = (v: string | number) => new Prisma.Decimal(v);

/**
 * `InvoiceWithItems` je pun Prisma tip sa ~40 kolona, a šablon čita samo nekoliko
 * (broj, datumi, zbirovi, avans). Umesto da se u svakom testu prepisuje ceo red iz
 * baze, sklapa se ono što se stvarno štampa i tvrdi tip — kad šablon posegne za
 * poljem koje ovde ne postoji, testovi to odmah pokažu kao `undefined` na papiru.
 */
function makeInvoice(over: Partial<InvoiceWithItems> = {}): InvoiceWithItems {
  return {
    id: 1,
    documentType: "IFUSL",
    documentNumber: "653/25",
    level: 0,
    companyId: 1,
    customerId: 10,
    documentDate: new Date(2025, 11, 24),
    dueDate: new Date(2025, 11, 24),
    supplyDate: new Date(2025, 11, 24),
    currency: "RSD",
    netTotal: d(16000),
    vatTotal: d(3200),
    grossTotal: d(19200),
    advanceAppliedAmount: d(0),
    advanceInvoiceId: null,
    note: null,
    warehouseId: null,
    items: [],
    ...over,
  } as unknown as InvoiceWithItems;
}

/** Jedina stavka sa papira: 1 kom × 16.000,00, rabat 0, PDV 20 %. */
const ZAKUP: PrintLine = {
  ordinal: 1,
  catalogNumber: null,
  name: "Zakup poslovnog prostora za Decembar 2025.",
  unit: "kom",
  customsTariff: null,
  quantity: d(1),
  unitPrice: d(16000),
  // Bez rabata je cena pre rabata ista kao cena stavke.
  unitPriceBeforeDiscount: d(16000),
  discountPercent: d(0),
  lineTotal: d(16000),
  vatRatePercent: 20,
};

function makeCtx(over: Partial<PrintCtx> = {}): PrintCtx {
  return {
    invoice: makeInvoice(),
    lines: [ZAKUP],
    customer: {
      name: "HAP FLUID D.O.O.",
      address: "Ugrinovačka 163",
      city: "Dobanovci",
      postalCode: "11272",
      taxId: "107136558",
      registrationNumber: "20748346",
      country: "Srbija",
    },
    issuer: {
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
      aprText: null,
      iban: null,
      swift: null,
      bankName: null,
      bankAddress: null,
    },
    signatory: { name: "Ana Golubović" },
    // Namerno popunjeno: usluga NEMA magacin i šablon ovo mora da prećuti.
    warehouseName: "Magacin robe",
    currency: "RSD",
    advanceInvoiceNumber: null,
    withoutPrices: false,
    ...over,
  };
}

type Node = Record<string, unknown>;

/** Obilazi pdfmake stablo (stack / columns / table.body) i zove `visit` nad svakim čvorom. */
function walk(node: unknown, visit: (n: Node) => void): void {
  if (node == null) return;
  if (Array.isArray(node)) {
    for (const n of node) walk(n, visit);
    return;
  }
  if (typeof node !== "object") return;
  const o = node as Node;
  visit(o);
  for (const key of ["stack", "columns", "table", "body"]) {
    if (o[key] != null) walk(o[key], visit);
  }
}

/** Sav tekst sa papira, kao jedan string — nad njim se pišu tvrdnje „ima / nema". */
function text(content: Content[]): string {
  const out: string[] = [];
  walk(content, (n) => {
    if (typeof n.text === "string") out.push(n.text);
  });
  return out.join("\n");
}

/** Vraća čvor sa tačno tim tekstom (za tvrdnje o podvlačenju, poravnanju…). */
function nodeWithText(content: Content[], value: string): Node | undefined {
  let found: Node | undefined;
  walk(content, (n) => {
    if (n.text === value && !found) found = n;
  });
  return found;
}

/**
 * Uokvireni iznosi zbirnog bloka: tabela 1×1 sa svojim `layout`-om i tekstom u
 * ćeliji. Okvir kupca je takođe tabela 1×1, ali mu ćelija nosi `stack`, ne `text` —
 * zato se ovde ne broji.
 */
function framedAmounts(content: Content[]): { text: string; bold: boolean }[] {
  const out: { text: string; bold: boolean }[] = [];
  walk(content, (n) => {
    const table = n.table as { body?: unknown[][] } | undefined;
    if (!table || !n.layout || !Array.isArray(table.body)) return;
    if (table.body.length !== 1 || table.body[0].length !== 1) return;
    const cell = table.body[0][0] as Node;
    if (typeof cell?.text !== "string") return;
    out.push({ text: cell.text, bold: cell.bold === true });
  });
  return out;
}

describe("IFUSL — domaća faktura za uslugu (653/25)", () => {
  const content = domacaUslugaTemplate(makeCtx());
  const paper = text(content);

  describe("naslov i desni blok", () => {
    it("naslov je u DVA reda: `Račun` pa podvučeno `br. 653/25`", () => {
      const title = nodeWithText(content, "Račun");
      const number = nodeWithText(content, "br. 653/25");
      expect(title).toBeDefined();
      expect(number).toBeDefined();
      expect(title?.alignment).toBe("right");
      expect(number?.alignment).toBe("right");
      // Podvučen broj je deo obrasca, ne ukras.
      expect(number?.decoration).toBe("underline");
      // Roba ima „Račun br. 657/25" u JEDNOM redu — usluga ne sme tako.
      expect(paper).not.toContain("Račun br. 653/25");
    });

    it("nosi datum izdavanja, mesto, Rok za plaćanje i Datum prometa", () => {
      expect(paper).toContain("Datum izdavanja računa: 24-12-25");
      expect(paper).toContain("Mesto izdavanja računa: Beograd");
      expect(paper).toContain("Rok za plaćanje: 24-12-25");
      expect(paper).toContain("Datum prometa: 24-12-25");
    });

    it("NEMA „Valuta za plaćanje“ — to je robni obrazac", () => {
      expect(paper).not.toContain("Valuta za plaćanje");
    });

    it("nosi centriran tekući račun iznad kupca", () => {
      const account = nodeWithText(content, "Tekući račun: 160-110610-83");
      expect(account).toBeDefined();
      expect(account?.alignment).toBe("center");
    });
  });

  describe("blok kupca", () => {
    it("naziv, poštanski broj + mesto, ulica i PIB/MB — redosledom sa papira", () => {
      expect(paper).toContain("HAP FLUID D.O.O.");
      expect(paper).toContain("11272   Dobanovci");
      expect(paper).toContain("Ugrinovačka 163");
      expect(paper).toContain("PIB: 107136558");
      expect(paper).toContain("MB: 20748346");
      expect(nodeWithText(content, "K u p a c:")).toBeDefined();
    });

    it("ne štampa državu — obrazac je domaći", () => {
      expect(paper).not.toContain("Srbija");
    });
  });

  describe("tabela stavki", () => {
    it("ima tačno kolone sa papira", () => {
      for (const col of [
        "R.br.",
        "PDV",
        "O P I S",
        "j.m.",
        "Količina",
        "C E N A",
        "Rab%",
        "I Z N O S",
      ])
        expect(paper).toContain(col);
    });

    it("NEMA kolonu `Kat. br.` — usluga nema artikal", () => {
      expect(paper).not.toContain("Kat. br.");
      expect(paper).not.toContain("Kat.br.");
    });

    it("poslednja kolona je `I Z N O S`, a ne `VREDNOST` (kao na robi)", () => {
      expect(paper).not.toContain("VREDNOST");
      expect(paper).not.toContain("N A Z I V   R O B E");
    });

    it("rabat kolona se zove `Rab%`, ne `R%`", () => {
      expect(paper).toContain("Rab%");
      expect(paper).not.toMatch(/(^|\n)R%($|\n)/);
    });

    it("štampa stavku onako kako je na papiru (količina `1`, rabat `0`)", () => {
      expect(paper).toContain("Zakup poslovnog prostora za Decembar 2025.");
      expect(paper).toContain("kom");
      expect(paper).toContain("20%");
      expect(paper).toContain("16,000.00");
      // Količina i rabat su celi brojevi → bez decimala, tačno kao na obrascu.
      const cells: string[] = [];
      walk(content, (n) => {
        if (typeof n.text === "string") cells.push(n.text);
      });
      expect(cells).toContain("1");
      expect(cells).toContain("0");
      expect(cells).not.toContain("1.000");
    });
  });

  describe("NEMA trake uslova", () => {
    it("nijedna od četiri kolone robne trake se ne pojavljuje", () => {
      expect(paper).not.toContain("Roba je FCO");
      expect(paper).not.toContain("Način plaćanja");
      expect(paper).not.toContain("Način otpreme");
      // Usluga ima „Datum prometa:", ali NE i „Datum prometa dobara" iz trake.
      expect(paper).not.toContain("Datum prometa dobara");
    });
  });

  describe("zbirni blok", () => {
    it("ima PET redova i svaki je UOKVIREN", () => {
      const boxes = framedAmounts(content);
      expect(boxes.map((b) => b.text)).toEqual([
        "16,000.00",
        "0.00",
        "16,000.00",
        "3,200.00",
        "19,200.00",
      ]);
    });

    it("nosi zaseban red `Ukupno vrednost bez PDV (osnovica)`", () => {
      expect(paper).toContain("Vrednost bez PDV (osnovica):");
      expect(paper).toContain("Odobren rabat:");
      expect(paper).toContain("Ukupno vrednost bez PDV (osnovica):");
    });

    it("red PDV-a nosi i stopu i osnovicu u tekstu", () => {
      expect(paper).toContain("PDV po stopi 20% X 16,000.00 =");
    });

    it("poslednji red je `Ukupno za uplatu (RSD):` i podebljan je", () => {
      expect(paper).toContain("Ukupno za uplatu (RSD):");
      // Robni obrazac ima „Za uplatu (RSD):" — usluga ne sme tako.
      expect(paper).not.toContain("\nZa uplatu (RSD):");
      const boxes = framedAmounts(content);
      expect(boxes[boxes.length - 1]).toEqual({ text: "19,200.00", bold: true });
    });

    it("rabat se štampa i kad je nula (red se ne izostavlja)", () => {
      expect(framedAmounts(content)[1]).toEqual({ text: "0.00", bold: false });
    });

    /**
     * ⚠️ `unitPrice` je u bazi cena POSLE rabata (`pricing.service.ts`), pa je uz
     * količinu 1 jednak osnovici (16.000,00) — a NE ceni pre rabata. Do 02.08.2026.
     * je obrazac bruto računao kao Σ(količina × `unitPrice`), dakle opet 16.000,00,
     * pa je „Odobren rabat" bio strukturno `0.00` i kad je u koloni `Rab%` pisalo 20.
     * Sada se rabat izvodi unazad: 16.000 × 20 / 80 = 4.000,00, bruto 20.000,00.
     */
    it("rabat sa stavki zatvara račun: bruto − rabat = osnovica", () => {
      const withDiscount = domacaUslugaTemplate(
        makeCtx({
          // STARA stavka (pre kolone `unit_price_before_discount`): u bazi je samo cena
          // POSLE rabata, pa rabat ide obračunom unazad — 16.000 × 20 / 80 = 4.000.
          lines: [
            { ...ZAKUP, discountPercent: d(20), unitPriceBeforeDiscount: null },
          ],
        }),
      );
      expect(framedAmounts(withDiscount).map((b) => b.text)).toEqual([
        "20,000.00", // bruto = cena PRE rabata
        "4,000.00", // odobren rabat
        "16,000.00", // osnovica sa dokumenta
        "3,200.00",
        "19,200.00",
      ]);
    });

    /**
     * Isti scenario koji je otkrio kvar na robnom obrascu (10 kom × 1.000,00, rabat
     * 10 %), da se ponašanje dva domaća obrasca ne razmimoiđe: obrazac usluge nema
     * kolonu `Kat. br.`, ali rabat mora da računa istom aritmetikom.
     */
    it("rabat 10 % na 10 × 1.000,00 daje bruto 10.000,00 i rabat 1.000,00", () => {
      const content = domacaUslugaTemplate(
        makeCtx({
          invoice: makeInvoice({
            netTotal: d(9000),
            vatTotal: d(1800),
            grossTotal: d(10800),
          }),
          lines: [
            {
              ...ZAKUP,
              quantity: d(10),
              // Cena POSLE rabata, kako je i zapisana u bazi (1.000,00 − 10 %).
              unitPrice: d(900),
              // Puna cena se dobija i BEZ nove kolone, obračunom unazad — ovaj test čuva
              // baš taj put, jer njime izlaze svi zatečeni računi.
              unitPriceBeforeDiscount: null,
              discountPercent: d(10),
              lineTotal: d(9000),
            },
          ],
        }),
      );
      expect(framedAmounts(content).map((b) => b.text)).toEqual([
        "10,000.00",
        "1,000.00",
        "9,000.00",
        "1,800.00",
        "10,800.00",
      ]);
    });

    it("kod više PDV stopa daje red po stopi (pogrešna stopa je poreska greška)", () => {
      const druga: PrintLine = {
        ...ZAKUP,
        ordinal: 2,
        name: "Usluga po stopi 10%",
        unitPrice: d(4000),
        lineTotal: d(4000),
        vatRatePercent: 10,
      };
      const mixed = domacaUslugaTemplate(
        makeCtx({
          invoice: makeInvoice({
            netTotal: d(20000),
            vatTotal: d(3600),
            grossTotal: d(23600),
          }),
          lines: [ZAKUP, druga],
        }),
      );
      const t = text(mixed);
      expect(t).toContain("PDV po stopi 20% X 16,000.00 =");
      expect(t).toContain("PDV po stopi 10% X 4,000.00 =");
      expect(framedAmounts(mixed).map((b) => b.text)).toEqual([
        "20,000.00",
        "0.00",
        "20,000.00",
        "3,200.00",
        "400.00",
        "23,600.00",
      ]);
    });

    it("zbir odštampanih PDV redova uvek daje PDV sa dokumenta", () => {
      // Namerno „neokrugao" PDV na dokumentu (zaokruživanje po stavkama): razlika
      // sme da padne na najveću osnovicu, ali papir mora da se poklopi sa knjiženjem.
      const mixed = domacaUslugaTemplate(
        makeCtx({
          invoice: makeInvoice({
            netTotal: d(20000),
            vatTotal: d("3599.99"),
            grossTotal: d("23599.99"),
          }),
          lines: [
            ZAKUP,
            {
              ...ZAKUP,
              ordinal: 2,
              unitPrice: d(4000),
              lineTotal: d(4000),
              vatRatePercent: 10,
            },
          ],
        }),
      );
      const boxes = framedAmounts(mixed).map((b) => b.text);
      // 3,199.99 + 400.00 = 3,599.99 = `vatTotal`
      expect(boxes.slice(3, 5)).toEqual(["3,199.99", "400.00"]);
    });

    it("odbijen avans umanjuje uplatu, a poslednji red ostaje `Ukupno za uplatu`", () => {
      const withAdvance = domacaUslugaTemplate(
        makeCtx({
          invoice: makeInvoice({ advanceAppliedAmount: d(9200) }),
          advanceInvoiceNumber: "12/25",
        }),
      );
      const t = text(withAdvance);
      expect(t).toContain("Umanjenje za primljeni avans (br. 12/25):");
      expect(t).toContain("Ukupno za uplatu (RSD):");
      const boxes = framedAmounts(withAdvance);
      expect(boxes[boxes.length - 1]).toEqual({
        text: "10,000.00",
        bold: true,
      });
    });
  });

  describe("napomene", () => {
    it("reklamacije su „u roku od 5 dana“ — BEZ „po prijemu robe“", () => {
      expect(paper).toContain("Reklamacije primamo u roku od 5 dana.");
      expect(paper).not.toContain("po prijemu robe");
    });

    it("nadležan je Trgovinski sud u Beogradu, NE Privredni sud", () => {
      expect(paper).toContain(
        "Za sve sporove nadležan je Trgovinski sud u Beogradu.",
      );
      expect(paper).not.toContain("Privredni sud");
    });

    it("nosi i napomenu o oslobođenju i zateznu kamatu", () => {
      // 653/25 nosi PDV 3.200,00 — tu oslobođenja zaista nema.
      expect(paper).toContain(NEMA_TEXT);
      expect(paper).toContain("zakonom propisanu zateznu kamatu");
    });

    /**
     * REGRESIJA NA NALAZ N3 (`docs/FAKTURE_ZAKONSKA_USKLADJENOST.md` §1.3): tekst je bio
     * tvrdo ukucan, pa je i usluga bez obračunatog PDV-a tvrdila da oslobođenja „NEMA".
     * Napomena o odredbi po kojoj PDV nije obračunat je obavezan element računa.
     */
    it("usluga BEZ obračunatog PDV-a dobija pravu napomenu, ne „NEMA“", () => {
      const bezPdv = text(
        domacaUslugaTemplate(
          makeCtx({
            invoice: makeInvoice({
              netTotal: d(16000),
              vatTotal: d(0),
              grossTotal: d(16000),
            }),
          }),
        ),
      );
      expect(bezPdv).not.toContain(NEMA_TEXT);
      expect(bezPdv).toContain(exemptionFor("domestic-exempt")?.paperText);
    });

    it("tekst napomene dolazi iz `vat-exemption.ts` — isti izvor kao SEF", () => {
      expect(paper).toContain(exemptionFor("domestic-taxed")?.paperText ?? NEMA_TEXT);
    });
  });

  describe("potpis", () => {
    it("ima SAMO `Odgovorno lice` sa imenom — nijedan od tri robna potpisa", () => {
      expect(paper).toContain("Odgovorno lice");
      expect(paper.match(/Odgovorno lice/g)).toHaveLength(1);
      expect(paper).toContain("Ana Golubović");
      expect(paper).not.toContain("Robu primio");
      expect(paper).not.toContain("Preuzeo za prevoz");
      expect(paper).not.toContain("Robu izdao");
    });

    /**
     * REGRESIJA NA ODLUKU O-F3: original nosi `Br. l.k.:008165163`, ali broj lične
     * karte se NE štampa i NE čuva — podatak o ličnosti bez poslovne potrebe ne ide
     * na dokument koji putuje kupcu. Ovaj test čuva tu odluku od „popravke po papiru".
     */
    it("nigde ne pominje broj lične karte (O-F3)", () => {
      expect(paper.toLowerCase()).not.toContain("l.k.");
      expect(paper.toLowerCase()).not.toContain("lične karte");
      expect(paper).not.toContain("008165163");
    });
  });

  describe("usluga nema magacin", () => {
    it("`ctx.warehouseName` se ignoriše iako je popunjen", () => {
      expect(paper).not.toContain("Magacin robe");
      expect(paper).not.toContain("iz magacina");
    });
  });

  describe("otpremnica bez cena (`withoutPrices`)", () => {
    it("izostavlja novčane kolone i ceo zbir", () => {
      const t = text(domacaUslugaTemplate(makeCtx({ withoutPrices: true })));
      expect(t).toContain("O P I S");
      expect(t).toContain("Količina");
      expect(t).not.toContain("C E N A");
      expect(t).not.toContain("I Z N O S");
      expect(t).not.toContain("Rab%");
      expect(t).not.toContain("Ukupno za uplatu");
      expect(t).not.toContain("16,000.00");
    });
  });

  describe("otpornost", () => {
    it("bez kupca, bez potpisnika i bez datuma ne pada i ne ostavlja prazne labele", () => {
      const bare = domacaUslugaTemplate(
        makeCtx({
          customer: null,
          signatory: null,
          invoice: makeInvoice({ dueDate: null, supplyDate: null }),
          issuer: { ...makeCtx().issuer, invoiceIssuingPlace: null },
        }),
      );
      const t = text(bare);
      expect(t).toContain("br. 653/25");
      expect(t).not.toContain("Rok za plaćanje:");
      expect(t).not.toContain("Datum prometa:");
      expect(t).not.toContain("Mesto izdavanja računa:");
      expect(t).toContain("Odgovorno lice");
    });
  });

  /**
   * Prava provera: telo mora da PROĐE kroz pdfmake zajedno sa memorandumom.
   * Pogrešan `margin`, `layout` ili `canvas` ovde puca, a ne tek na produ.
   */
  it("renderuje se kroz pdfmake u ispravan PDF", async () => {
    const ctx = makeCtx();
    const dd: TDocumentDefinitions = {
      pageSize: "A4",
      pageMargins: [32, 110, 32, 90],
      header: () => memorandumHeader(ctx.issuer),
      content: domacaUslugaTemplate(ctx),
      styles: { ...MEMORANDUM_STYLES },
      defaultStyle: { font: "Roboto", fontSize: 9 },
    };
    const buffer = await new PdfService().render(dd);
    expect(buffer.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(buffer.length).toBeGreaterThan(1000);
  }, 30000);
});
