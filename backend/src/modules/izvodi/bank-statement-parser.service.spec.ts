import { BankStatementParserService } from "./bank-statement-parser.service";

/**
 * PARSER IZVODA — NEPROČITAN RED SE PRIJAVLJUJE, NE PRESKAČE (defekt D1, 04.08.2026).
 * ============================================================================
 * Pre popravke je parser vraćao SAMO niz stavki: prekratak red, red bez `DatumDok` i red sa
 * neparsabilnim iznosom su nestajali uz `logger.debug`/`logger.warn`, a nepoznat `DugPotInd`
 * se tumačio kao priliv. Oba ishoda su „pogrešan novac": uplata koja je stigla na račun ne
 * postoji u sistemu, ili postoji sa obrnutim smerom (odliv proknjižen kao naplata zatvara dug
 * koji nije plaćen). Traka na formi je pri tom bila zelena, jer je kontrola salda poredila 0
 * sa 0 (v. D2 u `bank-statement.service.spec.ts`).
 *
 * Testovi gledaju `skipped` — kanal kojim razlog stiže do korisnika; log nije kanal.
 */

/** FX Import Specification: 220 znakova, 1-bazirani (Start, Width) — v. doc 21 §A. */
const RECORD_LENGTH = 220;

interface FxFields {
  matTR?: string; // (1,18)
  partnerName?: string; // (19,35)
  place?: string; // (54,43)
  paymentCode?: string; // (97,3)
  description?: string; // (100,35)
  amount?: string; // (135,13)
  dugPotInd?: string; // (148,1)
  partnerAccount?: string; // (149,18)
  model?: string; // (167,2)
  reference?: string; // (169,20)
  documentDate?: string; // (189,8)
}

/** Upiši polje u bafer na 1-bazirani `start`, sečeno na `width`. */
function put(buf: string[], start: number, width: number, value: string): void {
  const v = value.slice(0, width);
  for (let i = 0; i < v.length; i++) buf[start - 1 + i] = v[i];
}

/** Sastavi JEDAN pun FX red izvoda (podrazumevano: priliv 120.000,00 od kupca). */
function fxLine(over: FxFields = {}): string {
  const f: Required<FxFields> = {
    matTR: "160000000011061083",
    partnerName: "Metalprodukt d.o.o.",
    place: "Beograd",
    paymentCode: "221",
    description: "Uplata racuna 657-25",
    amount: "0000012000000", // 13 cifara → 120000.00
    dugPotInd: "C", // priliv
    partnerAccount: "205123456789011",
    model: "97",
    reference: "6572527",
    documentDate: "24072026", // DDMMYYYY
    ...over,
  };

  const buf = new Array<string>(RECORD_LENGTH).fill(" ");
  put(buf, 1, 18, f.matTR);
  put(buf, 19, 35, f.partnerName);
  put(buf, 54, 43, f.place);
  put(buf, 97, 3, f.paymentCode);
  put(buf, 100, 35, f.description);
  put(buf, 135, 13, f.amount);
  put(buf, 148, 1, f.dugPotInd);
  put(buf, 149, 18, f.partnerAccount);
  put(buf, 167, 2, f.model);
  put(buf, 169, 20, f.reference);
  put(buf, 189, 8, f.documentDate);
  put(buf, 197, 19, "REKL-1");
  put(buf, 216, 4, "0000");
  put(buf, 220, 1, "1");
  return buf.join("");
}

function makeParser(): BankStatementParserService {
  const parser = new BankStatementParserService();
  // Log nije predmet testa, ali ne treba ni da zaprlja izlaz.
  jest.spyOn(parser["logger"], "log").mockImplementation(() => undefined);
  jest.spyOn(parser["logger"], "warn").mockImplementation(() => undefined);
  return parser;
}

describe("BankStatementParserService.parse — nepročitan red (D1)", () => {
  it("pun red se čita ispravno (kontrolna grupa)", () => {
    const parsed = makeParser().parse(fxLine());

    expect(parsed.skipped).toEqual([]);
    expect(parsed.lines).toHaveLength(1);
    expect(parsed.lines[0].amount.toFixed(2)).toBe("120000.00");
    expect(parsed.lines[0].direction).toBe("CREDIT");
    expect(parsed.lines[0].referenceNumber).toBe("6572527");
    expect(parsed.lines[0].documentDate?.toISOString()).toBe(
      "2026-07-24T00:00:00.000Z",
    );
  });

  it("(a) PREKRATAK red se PRIJAVLJUJE sa brojem reda i razlogom, ne preskače tiho", () => {
    // Prekratak red je najverovatnije uplata koju parser ne ume da pročita. Pre popravke je
    // završavao u `logger.debug` i izvod se uvozio kao da tog novca nema.
    const txt = [fxLine(), "160000000011061083 KRATAK RED", fxLine()].join("\r\n");

    const parsed = makeParser().parse(txt);

    expect(parsed.lines).toHaveLength(2);
    expect(parsed.skipped).toHaveLength(1);
    expect(parsed.skipped[0].fileLineNo).toBe(2); // broj reda U FAJLU, 1-baziran
    expect(parsed.skipped[0].reason).toContain("dužina");
    expect(parsed.skipped[0].reason).toContain("196");
    expect(parsed.skipped[0].excerpt).toContain("KRATAK RED");
  });

  it("(b) NEPOZNAT DugPotInd je GREŠKA reda — nikad pretpostavka „priliv“", () => {
    // Pre popravke je nepoznat indikator vraćao CREDIT: odliv je ulazio kao naplata i
    // zatvarao dug koji nije plaćen. Smer se ne sme pretpostaviti.
    const parsed = makeParser().parse(fxLine({ dugPotInd: "X" }));

    expect(parsed.lines).toHaveLength(0); // NIJE ušlo kao priliv
    expect(parsed.skipped).toHaveLength(1);
    expect(parsed.skipped[0].reason).toContain("DugPotInd");
    expect(parsed.skipped[0].reason).toContain("smer se ne sme pretpostaviti");
  });

  it("PRAZAN DugPotInd je isto greška (nema „podrazumevanog“ smera)", () => {
    const parsed = makeParser().parse(fxLine({ dugPotInd: " " }));

    expect(parsed.lines).toHaveLength(0);
    expect(parsed.skipped[0].reason).toContain("DugPotInd");
  });

  it("oba priznata zapisa smera i dalje rade (D/1 = odliv, C/K/P/2 = priliv)", () => {
    const parser = makeParser();
    for (const ind of ["D", "1"]) {
      const p = parser.parse(fxLine({ dugPotInd: ind }));
      expect(p.skipped).toEqual([]);
      expect(p.lines[0].direction).toBe("DEBIT");
    }
    for (const ind of ["C", "K", "P", "2"]) {
      const p = parser.parse(fxLine({ dugPotInd: ind }));
      expect(p.skipped).toEqual([]);
      expect(p.lines[0].direction).toBe("CREDIT");
    }
  });

  it("red BEZ DatumDok se prijavljuje (pre popravke je ulazio sa documentDate = null)", () => {
    const parsed = makeParser().parse(fxLine({ documentDate: "        " }));

    expect(parsed.lines).toHaveLength(0);
    expect(parsed.skipped[0].reason).toContain("DatumDok");
  });

  it("neparsabilan IZNOS se prijavljuje (pre popravke: warn + preskoči)", () => {
    const parsed = makeParser().parse(fxLine({ amount: "   ----      " }));

    expect(parsed.lines).toHaveLength(0);
    expect(parsed.skipped[0].reason).toContain("iznos");
  });

  it("VIŠE razloga na istom redu ide u JEDNU prijavu (korisnik popravlja red jednom)", () => {
    const parsed = makeParser().parse(
      fxLine({ amount: "             ", dugPotInd: "?", documentDate: "99999999" }),
    );

    expect(parsed.skipped).toHaveLength(1);
    expect(parsed.skipped[0].reason).toContain("iznos");
    expect(parsed.skipped[0].reason).toContain("DugPotInd");
    expect(parsed.skipped[0].reason).toContain("DatumDok");
  });

  it("PRAZAN red nije prijava (završni prelaz reda nije zapis)", () => {
    const parsed = makeParser().parse(`${fxLine()}\r\n\r\n   \r\n`);

    expect(parsed.lines).toHaveLength(1);
    expect(parsed.skipped).toEqual([]);
  });

  it("redni broj stavke (lineNo) je gust — ne preskače brojeve zbog odbačenih redova", () => {
    // `lineNo` je redni broj STAVKE izvoda (ne reda u fajlu) i ide u bazu; rupa u nizu bi
    // izgledala kao da stavka postoji ali je ne vidimo.
    const txt = [fxLine(), "prekratak", fxLine(), fxLine()].join("\n");

    const parsed = makeParser().parse(txt);

    expect(parsed.lines.map((l) => l.lineNo)).toEqual([1, 2, 3]);
    expect(parsed.skipped.map((s) => s.fileLineNo)).toEqual([2]);
  });
});
