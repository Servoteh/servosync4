import { Prisma } from "@prisma/client";
import {
  amountInWords,
  buildCardControlNote,
  buildControlNote,
  buildPageFooter,
  contentWidth,
  fmtDate,
  fmtMoney,
  fmtQty,
  roundingTolerance,
  safeFileName,
  sanitizeText,
  sumRounded,
  widthSlack,
} from "./index";

const D = (v: string) => new Prisma.Decimal(v);

/**
 * ZAJEDNIČKI IZGLED — tvrdnje koje važe za SVE štampe aplikacije. Ovo je jedini
 * izvor formata koji korisnik vidi (novac, datum, iznos u slovima, noga), pa se
 * ovde brane i nalazi revizije koji su nastali baš zato što su četiri modula
 * imala četiri kopije ovih funkcija.
 */
describe("doc-layout — formatiranje", () => {
  it("novac: hiljade tačkom, decimale zarezom, ASCII minus", () => {
    expect(fmtMoney(D("1234567.89"))).toBe("1.234.567,89");
    expect(fmtMoney(D("0"))).toBe("0,00");
    // U+2212 se iz PDF-a lepi u Excel kao TEKST — kolona tiho da 0.
    expect(fmtMoney(D("-45.5"))).toBe("-45,50");
    expect(fmtMoney(D("-45.5")).charCodeAt(0)).toBe(45);
  });

  it("količina skida suvišne nule, datum je dd.MM.yyyy.", () => {
    expect(fmtQty(D("12.500"))).toBe("12,5");
    expect(fmtQty(D("12"))).toBe("12");
    expect(fmtDate(new Date(2026, 6, 5))).toBe("05.07.2026.");
    expect(fmtDate(null)).toBe("");
  });

  it("naziv fajla ne nosi zabranjene znakove", () => {
    expect(safeFileName("FAK 12/2026")).toBe("FAK_12-2026");
  });
});

describe("doc-layout — iznos u slovima", () => {
  it("valuta se slaže sa brojem", () => {
    expect(amountInWords(D("1"))).toBe("jedan dinar i 00/100");
    expect(amountInWords(D("21"))).toBe("dvadeset jedan dinar i 00/100");
    expect(amountInWords(D("101"))).toBe("sto jedan dinar i 00/100");
    expect(amountInWords(D("5"))).toBe("pet dinara i 00/100");
    expect(amountInWords(D("11"))).toBe("jedanaest dinara i 00/100");
  });

  it("pare se zaokružuju JEDNOM — nikad „100/100“", () => {
    // Kolone su Decimal(19,4): 1000,9950 se štampa kao 1.001,00, pa slova
    // moraju reći isto, a ne „hiljadu dinara i 100/100".
    expect(amountInWords(D("1000.9950"))).toBe("hiljadu jedan dinar i 00/100");
    expect(amountInWords(D("0.9999"))).toBe("jedan dinar i 00/100");
    expect(amountInWords(D("999.995"))).toBe("hiljadu dinara i 00/100");
    expect(amountInWords(D("1250.35"))).toContain("35/100");
  });

  it("pokriva bilion/trilion, a preko opsega ne laže", () => {
    expect(amountInWords(D("1234567890123.45"))).toContain("bilion");
    expect(amountInWords(D("1000000000000"))).not.toContain("nula dinara");
    expect(amountInWords(D("1000000000000000000"))).toBe(
      "iznos prevazilazi opseg ispisa slovima",
    );
  });

  it("strana valuta ide oznakom", () => {
    expect(amountInWords(D("10"), "EUR")).toBe("deset EUR i 00/100");
  });
});

describe("doc-layout — glifovi van Roboto podskupa", () => {
  it("⌀ i ∅ postaju Ø, strelice se ispisuju", () => {
    expect(sanitizeText("Šipka Č.4732 ⌀60")).toBe("Šipka Č.4732 Ø60");
    expect(sanitizeText("Naručeno ↔ primljeno")).toBe("Naručeno / primljeno");
    expect(sanitizeText("A → B")).toBe("A -> B");
  });

  it("srpska slova ostaju netaknuta", () => {
    expect(sanitizeText("ćčđšž ĆČĐŠŽ Ø °")).toBe("ćčđšž ĆČĐŠŽ Ø °");
  });
});

describe("doc-layout — zbirovi i kontrole", () => {
  it("zbir se računa NAD ZAOKRUŽENIM stavkama (red UKUPNO = zbir kolone)", () => {
    // 3 × 0,125 → odštampano 3 × „0,13" = 0,39; pun zbir bi dao 0,38.
    const lines = [D("0.125"), D("0.125"), D("0.125")];
    expect(fmtMoney(sumRounded(lines))).toBe("0,39");
    const printed = lines
      .map((l) => l.toDecimalPlaces(2))
      .reduce((a, b) => a.plus(b), new Prisma.Decimal(0));
    expect(sumRounded(lines).equals(printed)).toBe(true);
  });

  it("tolerancija kontrole raste sa brojem stavki", () => {
    expect(roundingTolerance(1).toString()).toBe("0.01");
    expect(roundingTolerance(50).toString()).toBe("0.5");
  });

  it("knjiga alarmira na nesaglasan zbir, kartica NIKAD", () => {
    const book = JSON.stringify(buildControlNote(2, D("100"), D("90")));
    expect(book).toContain("NEUSKLAĐENO");

    // Na kartici razlika duguje/potražuje NIJE greška — ona JE saldo.
    const card = JSON.stringify(buildCardControlNote(39, D("100"), D("90")));
    expect(card).not.toContain("NEUSKLAĐENO");
    expect(card).toContain("dugovni saldo");
    expect(
      JSON.stringify(buildCardControlNote(1, D("90"), D("100"))),
    ).toContain("potražni saldo");
  });

  it("knjiga je usklađena kad su zbirovi jednaki", () => {
    expect(JSON.stringify(buildControlNote(2, D("100"), D("100")))).toContain(
      "usklađeno",
    );
  });
});

describe("doc-layout — noga strane", () => {
  it("nosi oznaku dokumenta, trag štampe i „strana N/M“", () => {
    const f = JSON.stringify(
      buildPageFooter("Prijemnica 1/2026", "pera")(2, 5),
    );
    expect(f).toContain("Prijemnica 1/2026");
    expect(f).toContain("Štampao: pera");
    expect(f).toContain("strana 2/5");
    expect(f).toContain("ServoSync 4.0");
  });

  it("ino dokument koristi engleske natpise", () => {
    const f = JSON.stringify(
      buildPageFooter("Invoice 1", "pera", undefined, {
        printedBy: "Printed by",
        page: "page",
      })(1, 1),
    );
    expect(f).toContain("Printed by: pera");
    expect(f).toContain("page 1/1");
  });
});

describe("doc-layout — širine kolona moraju stati u stranu", () => {
  it("uspravni i položeni A4 imaju očekivanu širinu sadržaja", () => {
    expect(Math.round(contentWidth(false))).toBe(531);
    expect(Math.round(contentWidth(true))).toBe(794);
  });

  it("prepoznaje prelivanje tabele preko desne ivice", () => {
    // Zatečeno stanje nivelacije (uspravno): 460 pt fiksno + 10 × 8 pt padding
    // = 540 pt > 531 pt — poslednja kolona je ispadala VAN PAPIRA.
    const nivPortrait = [22, 62, "*", 24, 50, 54, 54, 66, 66, 62];
    expect(widthSlack(nivPortrait, false, 8, 110)).toBeLessThan(0);
    // Isti obrazac položeno — staje sa rezervom za naziv artikla.
    expect(widthSlack(nivPortrait, true, 8, 110)).toBeGreaterThan(0);
  });
});
