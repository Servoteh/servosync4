import { Prisma } from "@prisma/client";
import type { PrintAdvanceDeduction, PrintCtx, PrintLine } from "./ctx";
import {
  advanceTotal,
  assertExportWithoutVat,
  discountFromLines,
  lineDiscountAmount,
  lineGross,
  payableAfterAdvance,
  printableAdvanceDeductions,
  printableDeductions,
  vatSummaryRows,
} from "./totals";

/**
 * Aritmetika zbirnog bloka — ono što je zajedničko svim obrascima.
 *
 * Obrasci imaju svoje testove nad papirom; ovde su GRANIČNI slučajevi do kojih se kroz
 * papir teško dolazi (rabat 100 %, preplata, protivrečan dokument), da bi ostali
 * zapisani na jednom mestu umesto da se ponavljaju u četiri spec fajla.
 */

const D = (v: string) => new Prisma.Decimal(v);

function line(over: Partial<PrintLine> = {}): PrintLine {
  return {
    ordinal: 1,
    catalogNumber: null,
    name: "Stavka",
    unit: "kom",
    customsTariff: null,
    quantity: D("1"),
    unitPrice: D("100.00"),
    // Podrazumevano STARA stavka (kolona `unit_price_before_discount` je novija od nje):
    // tako svaki test koji je ne postavi proverava REZERVNI put, obračun unazad.
    unitPriceBeforeDiscount: null,
    discountPercent: D("0"),
    lineTotal: D("100.00"),
    vatRatePercent: 20,
    ...over,
  };
}

describe("rabat iz cene PRE rabata (prvi izvor)", () => {
  /**
   * RUPA ZBOG KOJE JE KOLONA I UVEDENA: rabat od 100 %. Cena posle rabata je 0, pa
   * obračun unazad (`neto × p / (100 − p)`) deli nulom i daje 0 — papir je pokazivao
   * „R% 100" uz „Rabat: 0,00". Sa cenom pre rabata na stavci iznos je pun.
   */
  it("rabat 100 %: 10 kom × 1.000,00 daje rabat 10.000,00 (bruto 10.000,00)", () => {
    const osnovica = D("0");
    const rabat = lineDiscountAmount(
      line({
        quantity: D("10"),
        unitPrice: D("0"),
        unitPriceBeforeDiscount: D("1000.00"),
        discountPercent: D("100"),
        lineTotal: osnovica,
      }),
    );
    expect(rabat.toFixed(2)).toBe("10000.00");
    // Obrasci bruto računaju kao `osnovica + rabat`, pa invarijanta
    // „bruto − rabat = osnovica" stoji sama od sebe; ovde se proverava da je bruto
    // baš puna cena robe (10 × 1.000,00), a ne nula kao do sada.
    expect(osnovica.add(rabat).toFixed(2)).toBe("10000.00");
  });

  it("rabat 10 %: isti vektor daje isti iznos kao obračun unazad", () => {
    const withPrice = lineDiscountAmount(
      line({
        quantity: D("10"),
        unitPrice: D("900.00"),
        unitPriceBeforeDiscount: D("1000.00"),
        discountPercent: D("10"),
        lineTotal: D("9000.00"),
      }),
    );
    expect(withPrice.toFixed(2)).toBe("1000.00");
    expect(withPrice.add(D("9000.00")).toFixed(2)).toBe("10000.00");
  });

  it("bez rabata je tačno 0,00 i kad je puna cena upisana", () => {
    // Kolona `R%` je prazna → red „Rabat" mora biti 0,00 bez zaokružne sitnine, pa se
    // oduzimanje uopšte ne izvodi. Bez te brane bi 3 × 33,3333 − 99,99 dalo „rabat" od
    // jedne pare na papiru koji rabat nema.
    const rabat = lineDiscountAmount(
      line({
        quantity: D("3"),
        unitPrice: D("33.3333"),
        unitPriceBeforeDiscount: D("33.3333"),
        discountPercent: D("0"),
        lineTotal: D("99.99"),
      }),
    );
    expect(rabat.toFixed(2)).toBe("0.00");
  });

  it("protivrečna stavka (puna cena manja od neto) pada na rezervu, ne štampa minus", () => {
    // Negativan „Rabat" je greška vidljiva kupcu; bolje iznos iz obračuna unazad.
    const rabat = lineDiscountAmount(
      line({
        quantity: D("10"),
        unitPrice: D("900.00"),
        unitPriceBeforeDiscount: D("500.00"), // pokvaren podatak
        discountPercent: D("10"),
        lineTotal: D("9000.00"),
      }),
    );
    expect(rabat.toFixed(2)).toBe("1000.00");
  });
});

describe("rabat izveden iz cene POSLE rabata (rezerva za stare stavke)", () => {
  /**
   * Scenario koji je otkrio kvar: 10 kom × 1.000,00 uz rabat 10 %. U bazi stoji
   * `unitPrice = 900,00` i `lineTotal (vatBase) = 9.000,00`; stavka je starija od kolone
   * sa cenom pre rabata (`unitPriceBeforeDiscount = null`), pa se rabat vraća unazad.
   */
  it("9.000,00 uz 10 % daje rabat 1.000,00 (bruto 10.000,00)", () => {
    const rabat = lineDiscountAmount(
      line({
        quantity: D("10"),
        unitPrice: D("900.00"),
        discountPercent: D("10"),
        lineTotal: D("9000.00"),
      }),
    );
    expect(rabat.toFixed(2)).toBe("1000.00");
    expect(rabat.add(D("9000.00")).toFixed(2)).toBe("10000.00");
  });

  it("bez rabata je tačno nula — ne para gore ni dole", () => {
    // Da red „Rabat: 0.00" ostane 0.00, zaokruživanje ne sme da proizvede sitninu.
    expect(discountFromLines([line(), line({ lineTotal: D("33.33") })]).toFixed(2)).toBe(
      "0.00",
    );
  });

  it("sabira rabat po stavkama, i kad ga nemaju sve", () => {
    const total = discountFromLines([
      line({ lineTotal: D("9000.00"), discountPercent: D("10") }), // 1.000,00
      line({ lineTotal: D("1000.00"), discountPercent: D("0") }), // 0
    ]);
    expect(total.toFixed(2)).toBe("1000.00");
  });

  it("meša stare i nove stavke na istom papiru", () => {
    // Jedan račun ume da nosi i prepisanu (staru) i novu stavku — zbir mora biti tačan.
    const total = discountFromLines([
      line({
        quantity: D("10"),
        unitPriceBeforeDiscount: D("1000.00"),
        discountPercent: D("100"),
        lineTotal: D("0"),
      }), // 10.000,00 iz pune cene
      line({ lineTotal: D("9000.00"), discountPercent: D("10") }), // 1.000,00 unazad
    ]);
    expect(total.toFixed(2)).toBe("11000.00");
  });

  it("zaokružuje po stavci na dve decimale, kao i štampa", () => {
    // 100 × 3 / 97 = 3,0927835… → 3,09
    expect(
      lineDiscountAmount(
        line({ lineTotal: D("100.00"), discountPercent: D("3") }),
      ).toFixed(2),
    ).toBe("3.09");
  });

  /**
   * Stara stavka sa rabatom od 100 %: cena posle rabata je 0, a pune cene u bazi nema
   * ni u jednom obliku — iznos se ne može rekonstruisati. Bolje 0 nego deljenje nulom
   * ili izmišljen iznos (v. komentar u `totals.ts`).
   */
  it("rabat od 100 % bez pune cene ne obara štampu (vraća 0, ne beskonačno)", () => {
    const rabat = lineDiscountAmount(
      line({ unitPrice: D("0"), discountPercent: D("100"), lineTotal: D("0") }),
    );
    expect(rabat.toFixed(2)).toBe("0.00");
  });

  it("negativan rabat se ignoriše", () => {
    expect(
      lineDiscountAmount(line({ discountPercent: D("-5") })).toFixed(2),
    ).toBe("0.00");
  });
});

describe("iznos za uplatu posle avansa", () => {
  it("umanjuje za primljeni avans", () => {
    expect(payableAfterAdvance(D("10000.00"), D("3000.00")).toFixed(2)).toBe(
      "7000.00",
    );
  });

  it("avans veći od računa daje nulu, nikad minus", () => {
    // Preplata se rešava odobrenjem, ne negativnim iznosom na fakturi.
    expect(payableAfterAdvance(D("10000.00"), D("12000.00")).toFixed(2)).toBe(
      "0.00",
    );
  });
});

describe("odbijeni avansi (N:M primene)", () => {
  const ctx = (deductions: PrintAdvanceDeduction[]): PrintCtx =>
    ({ advanceDeductions: deductions }) as PrintCtx;

  it("zbir je zbir PRIKAZANIH primena, ne kolone sa dokumenta", () => {
    // Izmereni ulaz: račun 10.000,00 zatvara `A-1/26` (3.000) i `A-2/26` (2.000).
    const list = printableAdvanceDeductions(
      ctx([
        { documentNumber: "A-1/26", amount: D("3000.00") },
        { documentNumber: "A-2/26", amount: D("2000.00") },
      ]),
    );
    expect(list).toHaveLength(2);
    expect(advanceTotal(list).toFixed(2)).toBe("5000.00");
  });

  it("bez primena je nula (ne pada na kolonu i ne štampa red)", () => {
    expect(printableAdvanceDeductions(ctx([]))).toEqual([]);
    expect(advanceTotal([]).toFixed(2)).toBe("0.00");
  });

  /**
   * Primena na 0 (stornirana pa ponovo upisana, ručna ispravka) ne sme da proizvede red
   * „Umanjenje za primljeni avans (br. …): − 0,00" — kupac bi ga čitao kao postojeći
   * avans koji ništa ne umanjuje.
   */
  it("primena sa iznosom 0 ne ide na papir", () => {
    const list = printableAdvanceDeductions(
      ctx([
        { documentNumber: "A-1/26", amount: D("0") },
        { documentNumber: "A-2/26", amount: D("2000.00") },
      ]),
    );
    expect(list.map((d) => d.documentNumber)).toEqual(["A-2/26"]);
    expect(advanceTotal(list).toFixed(2)).toBe("2000.00");
  });

  /**
   * NALAZ N8 (02.08.2026): isto pravilo mora da važi i za OPŠTI renderer (AVR/KO/KZ), koji
   * `PrintCtx` nema nego golu listu. Dok ga nije bilo, red „− 0,00" je izlazio na knjižnom
   * odobrenju, a na fakturi za isti avans ne.
   */
  it("pravilo važi i nad golom listom (opšti renderer: AVR/KO/KZ)", () => {
    const list = printableDeductions([
      { documentNumber: "A-1/26", amount: D("0") },
      { documentNumber: "A-2/26", amount: D("-5.00") },
      { documentNumber: "A-3/26", amount: D("2000.00") },
    ]);
    expect(list.map((d) => d.documentNumber)).toEqual(["A-3/26"]);
  });
});

describe("brana: izvozni papir bez PDV-a", () => {
  const doc = (vatTotal: string, documentType = "IZVRO") => ({
    documentNumber: "228/25",
    documentType,
    vatTotal: D(vatTotal),
  });

  it("propušta izvoz bez PDV-a", () => {
    expect(() => assertExportWithoutVat(doc("0"))).not.toThrow();
  });

  it("puca na dokument sa obračunatim PDV-om i imenuje ga", () => {
    expect(() => assertExportWithoutVat(doc("19872.73"))).toThrow(
      /Dokument IZVRO 228\/25 .* nosi obračunat PDV 19,872\.73/,
    );
  });

  /**
   * NALAZ N9 (02.08.2026): poruka je SVAKI dokument zvala „Izvozna faktura", a na ino
   * obrazac kroz `resolveForm` fallback padaju i predračun i ponuda. Operater je nad
   * predračunom `12/26` dobijao uputstvo da ispravi „izvoznu fakturu 12/26" — dokument
   * koji pod tim imenom ne postoji.
   */
  it("ne zove predračun „izvoznom fakturom“", () => {
    const message = (() => {
      try {
        assertExportWithoutVat(doc("2106.15", "PROF"));
      } catch (e) {
        return (e as Error).message;
      }
      return "";
    })();
    expect(message).toContain("Dokument PROF 228/25");
    expect(message).not.toContain("Izvozna faktura");
  });

  /**
   * NALAZ N9, glavni deo: REVERS je izuzet. Po reversu se ne uplaćuje ništa, pa PDV na
   * njemu i ne može da bude „odštampan kao deo iznosa za uplatu" — a to je jedina šteta
   * zbog koje brana postoji. Izmereno: revers nastao prepisom nosi PREPISAN `vatTotal` sa
   * izvorne fakture i, ako je `isExport`, pada na ino obrazac — pa je ostajao bez papira.
   * Isti spisak ga već izuzima od brane za bankarske instrukcije.
   */
  it("revers sa prepisanim PDV-om PROLAZI (po njemu se ne uplaćuje ništa)", () => {
    expect(() => assertExportWithoutVat(doc("19872.73", "REV"))).not.toThrow();
  });

  /**
   * `vat_total` je `Decimal(19,4)`, pa zatečeni dokument ume da nosi ostatak zaokruživanja
   * ispod pare. `isZero()` je i na njega obarao štampu, iako se na papiru sa dve decimale
   * ne vidi uopšte. Sve što se VIDI (0,01 pa naviše, u oba smera) i dalje obara.
   */
  it("ostatak ispod pare ne obara papir, a jedna para obara", () => {
    expect(() => assertExportWithoutVat(doc("0.0001"))).not.toThrow();
    expect(() => assertExportWithoutVat(doc("-0.0001"))).not.toThrow();
    expect(() => assertExportWithoutVat(doc("0.01"))).toThrow();
    expect(() => assertExportWithoutVat(doc("-0.01"))).toThrow();
  });
});

/**
 * NALAZ N1 (02.08.2026): kolona `C E N A`/`Price` je štampala cenu POSLE rabata, a
 * međuzbir iznad reda „Rabat" računat je iz cene PRE rabata — pa se sa rabatom ≠ 0
 * nijedan broj u zbirnom bloku nije mogao dobiti sabiranjem odštampane kolone.
 *
 * Presuda je sa papira: na `IFR.pdf` međuzbir stoji NEPOSREDNO ISPOD kolone VREDNOST i
 * BEZ natpisa, pa se tek od njega oduzima `Rabat:` — dakle međuzbir JESTE zbir kolone.
 */
describe("bruto po stavci (kolona CENA / VREDNOST)", () => {
  it("bez rabata kolona ostaje netaknuta — cena i iznos iz baze", () => {
    // Doneti papiri svi imaju `R% 0`; oni ne smeju da se promene ni za pixel.
    const g = lineGross(
      line({ quantity: D("5"), unitPrice: D("16099.54"), lineTotal: D("80497.70") }),
    );
    expect(g.unitPrice.toFixed(2)).toBe("16099.54");
    expect(g.total.toFixed(2)).toBe("80497.70");
    expect(g.discount.toFixed(2)).toBe("0.00");
  });

  it("sa rabatom kolona nosi PUNU cenu i PUN iznos (10 × 1.000,00, rabat 10 %)", () => {
    const g = lineGross(
      line({
        quantity: D("10"),
        unitPrice: D("900.00"),
        unitPriceBeforeDiscount: D("1000.00"),
        discountPercent: D("10"),
        lineTotal: D("9000.00"),
      }),
    );
    expect(g.unitPrice.toFixed(2)).toBe("1000.00");
    expect(g.total.toFixed(2)).toBe("10000.00");
    // Ono zbog čega papir zatvara sam sa sobom: iznos − rabat = osnovica, do pare.
    expect(g.total.sub(g.discount).toFixed(2)).toBe("9000.00");
  });

  it("bez upisane pune cene (stara stavka) kolona se izvodi iz istog bruta", () => {
    const g = lineGross(
      line({
        quantity: D("10"),
        unitPrice: D("900.00"),
        discountPercent: D("10"),
        lineTotal: D("9000.00"),
      }),
    );
    // Cena se dobija iz izvedenog bruta (10.000,00 / 10), pa kolona i međuzbir dolaze iz
    // ISTOG broja — isti papir kao za stavku koja punu cenu ima.
    expect(g.unitPrice.toFixed(2)).toBe("1000.00");
    expect(g.total.toFixed(2)).toBe("10000.00");
  });

  it("rabat 100 %: kolona pokazuje punu cenu, a iznos ceo bruto", () => {
    const g = lineGross(
      line({
        quantity: D("10"),
        unitPrice: D("0"),
        unitPriceBeforeDiscount: D("1000.00"),
        discountPercent: D("100"),
        lineTotal: D("0"),
      }),
    );
    expect(g.unitPrice.toFixed(2)).toBe("1000.00");
    expect(g.total.toFixed(2)).toBe("10000.00");
    expect(g.total.sub(g.discount).toFixed(2)).toBe("0.00");
  });

  it("količina 0 ne deli nulom — cena ostaje ona sa stavke", () => {
    const g = lineGross(
      line({
        quantity: D("0"),
        unitPrice: D("900.00"),
        discountPercent: D("10"),
        lineTotal: D("0"),
      }),
    );
    expect(g.unitPrice.toFixed(2)).toBe("900.00");
    expect(g.total.toFixed(2)).toBe("0.00");
  });

  /**
   * ZBIR KOLONE = MEĐUZBIR: to je cela poenta nalaza. Zbir odštampanih iznosa mora da
   * bude BAŠ `osnovica dokumenta + Σ rabata`, a ne broj blizu njega.
   */
  it("zbir kolone je tačno „osnovica + rabat“, i uz mešavinu stavki", () => {
    const lines = [
      line({
        quantity: D("10"),
        unitPrice: D("900.00"),
        discountPercent: D("10"),
        lineTotal: D("9000.00"),
      }),
      line({ quantity: D("1"), unitPrice: D("1000.00"), lineTotal: D("1000.00") }),
    ];
    const kolona = lines.reduce((s, l) => s.add(lineGross(l).total), D("0"));
    const osnovica = D("10000.00"); // Σ lineTotal
    expect(kolona.toFixed(2)).toBe(osnovica.add(discountFromLines(lines)).toFixed(2));
    expect(kolona.toFixed(2)).toBe("11000.00");
  });
});

/**
 * NALAZ N3 (02.08.2026): red sa NEGATIVNIM iznosom i rabatom od 100 % davao je
 * „Rabat 0,00" uz `R% 100`. Uslov u prvom izvoru je odbacivao svaki negativan iznos kao
 * „protivrečan podatak", a kad iznos poništava raniju fakturu je negativan rabat tačan.
 *
 * ⚠️ OGRANIČENJE OPISA (peti krug): ovakav red NE POSTOJI u tabeli `invoice_items` —
 * migracija `20260725200000_faza2_constraint_mreza` na njoj ima
 * `CHECK (quantity > 0 AND discount_percent BETWEEN 0 AND 100 …)`. Testovi ispod mere
 * ponašanje ČISTE FUNKCIJE nad `PrintLine` (koji gradi i opšti renderer, i ovaj spec),
 * ne zatečeni red u bazi — tvrdnja da je scenario viđen na podacima je povučena.
 */
describe("red sa negativnim iznosom (poništenje ranije fakture)", () => {
  const storno = line({
    quantity: D("-10"),
    unitPrice: D("0"),
    unitPriceBeforeDiscount: D("1000.00"),
    discountPercent: D("100"),
    lineTotal: D("0"),
  });

  it("rabat 100 % na negativnom redu daje −10.000,00, ne 0,00", () => {
    expect(lineDiscountAmount(storno).toFixed(2)).toBe("-10000.00");
  });

  it("kolona nosi punu cenu, a iznos negativan bruto", () => {
    const g = lineGross(storno);
    expect(g.unitPrice.toFixed(2)).toBe("1000.00");
    expect(g.total.toFixed(2)).toBe("-10000.00");
    // Papir i na negativnom redu zatvara sam sa sobom: bruto − rabat = osnovica (0,00).
    expect(g.total.sub(g.discount).toFixed(2)).toBe("0.00");
  });

  it("negativan red sa rabatom 10 % ide istim putem (−9.000,00 → rabat −1.000,00)", () => {
    const g = lineGross(
      line({
        quantity: D("-10"),
        unitPrice: D("900.00"),
        unitPriceBeforeDiscount: D("1000.00"),
        discountPercent: D("10"),
        lineTotal: D("-9000.00"),
      }),
    );
    expect(g.discount.toFixed(2)).toBe("-1000.00");
    expect(g.total.toFixed(2)).toBe("-10000.00");
  });

  it("bruto i osnovica različitog znaka su i dalje POKVAREN podatak → rezerva", () => {
    // Puna cena −500 uz osnovicu +9.000 nije storno nego neispravan red; papir tada ide
    // na obračun unazad umesto da odštampa besmislen bruto.
    const g = lineGross(
      line({
        quantity: D("1"),
        unitPrice: D("900.00"),
        unitPriceBeforeDiscount: D("-500.00"),
        discountPercent: D("10"),
        lineTotal: D("9000.00"),
      }),
    );
    expect(g.discount.toFixed(2)).toBe("1000.00");
    expect(g.total.toFixed(2)).toBe("10000.00");
  });
});

/**
 * NALAZ N4 (02.08.2026): raspoređivanje razlike zaokruživanja kod više PDV stopa
 * postojalo je SAMO na uslužnom obrascu, pa je isti račun na robnom papiru umeo da pokaže
 * Σ PDV redova različit od `vatTotal` za 0,01. Račun je sada zajednički.
 */
describe("redovi PDV-a u zbiru", () => {
  const ctxWith = (
    invoice: { netTotal: string; vatTotal: string },
    rates: { rate: number | null; base: string }[],
  ): PrintCtx =>
    ({
      invoice: {
        netTotal: D(invoice.netTotal),
        vatTotal: D(invoice.vatTotal),
      },
      lines: rates.map((r) =>
        line({ lineTotal: D(r.base), vatRatePercent: r.rate }),
      ),
    }) as unknown as PrintCtx;

  it("jedna stopa: iznosi su SA DOKUMENTA, do pare", () => {
    const rows = vatSummaryRows(
      ctxWith({ netTotal: "16000.00", vatTotal: "3200.00" }, [
        { rate: 20, base: "16000.00" },
      ]),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].base.toFixed(2)).toBe("16000.00");
    expect(rows[0].vat.toFixed(2)).toBe("3200.00");
  });

  it("dve stope: zbir odštampanih redova je TAČNO `vatTotal`", () => {
    // Izmeren ulaz: 16.000,00 (20 %) + 4.000,00 (10 %) uz `vatTotal` 3.599,99 sa dokumenta.
    // Bez raspoređivanja razlike papir bi pisao 3.200,00 + 400,00 = 3.600,00 — paru više
    // nego što je proknjiženo.
    const rows = vatSummaryRows(
      ctxWith({ netTotal: "20000.00", vatTotal: "3599.99" }, [
        { rate: 20, base: "16000.00" },
        { rate: 10, base: "4000.00" },
      ]),
    );
    const sum = rows.reduce((s, r) => s.add(r.vat), D("0"));
    expect(sum.toFixed(2)).toBe("3599.99");
    // Razlika pada na grupu sa NAJVEĆOM osnovicom, gde je relativno najmanja.
    expect(rows.find((r) => r.rate === 20)?.vat.toFixed(2)).toBe("3199.99");
    expect(rows.find((r) => r.rate === 10)?.vat.toFixed(2)).toBe("400.00");
  });

  /**
   * ⚠️ IZMENA 02.08.2026 (nalaz R3/S4): stavka bez poznate stope više NE pravi svoj red
   * pored reda od 0 %. Papir je oba štampao istim natpisom („PDV po stopi 0% X …"), pa su
   * to bila dva reda koja se razlikuju samo po iznosu osnovice — a u e-fakturi dva
   * `cac:TaxSubtotal`-a za isti oslobođen promet. Ključ je sada (kategorija, stopa), pa se
   * spajaju: 1.000,00 + 1.000,00 = 2.000,00 uz porez 0,00.
   */
  it("stavke bez poznate stope idu u ISTI red sa ostalim prometom po 0 %", () => {
    const rows = vatSummaryRows(
      ctxWith({ netTotal: "2000.00", vatTotal: "200.00" }, [
        { rate: 20, base: "1000.00" },
        { rate: null, base: "1000.00" },
      ]),
    );
    expect(rows.map((r) => r.rate)).toEqual([0, 20]);
    expect(rows.find((r) => r.rate === 0)?.base.toFixed(2)).toBe("1000.00");
    expect(rows.find((r) => r.rate === 0)?.vat.toFixed(2)).toBe("0.00");
    // Porez zaglavlja (200,00) ostaje na jedinoj oporezovanoj grupi — para se nikad ne
    // dodeljuje oslobođenom prometu.
    expect(rows.find((r) => r.rate === 20)?.vat.toFixed(2)).toBe("200.00");
  });

  /**
   * 🔴 NALAZ R3 (šesti krug): papir je grupisao po jednom ključu, e-faktura po drugom.
   * Ovde se meri POSLEDICA na papiru: dve stavke po 100,03 din sa različitim šiframa iste
   * stope davale su `200,06 + 40,01 = 240,07`, dok je zaglavlje (grupisano po šifri) reklo
   * `vatTotal 40,02`, pa je „Ukupno" ispod glasilo 240,08.
   */
  it("dve stavke po 100,03 uz istu stopu: red se zatvara u `vatTotal` zaglavlja", () => {
    const rows = vatSummaryRows(
      ctxWith({ netTotal: "200.06", vatTotal: "40.01" }, [
        { rate: 20, base: "100.03" },
        { rate: 20, base: "100.03" },
      ]),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].base.toFixed(2)).toBe("200.06");
    expect(rows[0].vat.toFixed(2)).toBe("40.01");
    expect(rows[0].base.add(rows[0].vat).toFixed(2)).toBe("240.07");
  });

  /**
   * 🔴 NALAZ R1: avansni račun (porez izveden deljenjem). Red mora da pokaže OBJAVLJEN
   * porez, da bi se zbir zatvorio u naplaćen bruto — v. `sales/vat-totals.ts`.
   */
  it("avans 132,03: red nosi 110,03 + 22,00 (ne 21,99 iz ponovljenog množenja)", () => {
    const rows = vatSummaryRows(
      ctxWith({ netTotal: "110.03", vatTotal: "22.00" }, [
        { rate: 20, base: "110.03" },
      ]),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].vat.toFixed(2)).toBe("22.00");
    expect(rows[0].base.add(rows[0].vat).toFixed(2)).toBe("132.03");
  });
});
