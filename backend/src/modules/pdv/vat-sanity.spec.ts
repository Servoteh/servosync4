import { Prisma } from "@prisma/client";
import {
  assertVatPeriodSane,
  evaluateVatSanity,
  fmtRsd,
  VAT_RECON_TOLERANCE,
  VAT_RATE_CODE_NO_DEDUCTION_SANITY,
  VAT_SETTLEMENT_ORDER_TYPE,
  VAT_TRANSIT_ACCOUNTS,
  VatSanityException,
  type VatSanityInput,
} from "./vat-sanity";
import { VAT_RATE_CODE_NO_DEDUCTION } from "./dto/manual-vat-entry.dto";

/**
 * Spec zaštite od TIHE greške u PDV evidenciji.
 *
 * Brojevi u testovima NISU izmišljeni — to su iznosi REPRODUKOVANI nad uvezenim
 * BigBit podacima na dev bazi za 03/2026 (pre i posle ispravke). Test time
 * zaključava tačno one otkaze koji su prošli neopaženo do štampe:
 *   • KUF 625 stavki a UKUPNO 0,00        (tehnički nalog u zbiru)
 *   • KIF PDV −1.236.156,30 uz osnovicu 0 (pogrešno mapiran konto 2050)
 *   • povraćaj 1.236.156,30 umesto 21.602.291,00 (kontrola vs BigBit)
 */

const D = (v: string | number) => new Prisma.Decimal(v);

/** Prazna ručna odstupnica — period bez ijedne ručno unete stavke. */
const NO_MANUAL = {
  count: 0,
  output: D(0),
  input: D(0),
  outputAll: D(0),
  inputAll: D(0),
  noDeduction: D(0),
};

function input(over: Partial<VatSanityInput> = {}): VatSanityInput {
  return {
    year: 2026,
    months: [3],
    kif: { count: 43, base: D("25465063.95"), vat: D("5086854.53") },
    kuf: { count: 666, base: D("193600721.05"), vat: D("26689144.42") },
    // Podrazumevano bez grupa po stopama — pravilo P5 se testira zasebno, da
    // ovi testovi ostanu vezani za ono što zaključavaju (P1–P4).
    rateGroups: [],
    manual: NO_MANUAL,
    bigbitControl: D("21602291.00"),
    unmappedAccounts: [],
    ...over,
  };
}

describe("evaluateVatSanity — ispravan mesec (03/2026 posle ispravke)", () => {
  it("prolazi: razlika prema BigBitu je 1,11 RSD (zaokruženje na ceo dinar)", () => {
    const r = evaluateVatSanity(input());
    expect(r.problems).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.computedRefund.toFixed(2)).toBe("21602289.89");
    expect(r.controlDiff!.toFixed(2)).toBe("-1.11");
    expect(r.controlDiff!.abs().lte(VAT_RECON_TOLERANCE)).toBe(true);
  });

  it("mesec BEZ prometa (0 stavki, sve nule) NIJE greška — nema lažne uzbune", () => {
    const r = evaluateVatSanity(
      input({
        kif: { count: 0, base: D(0), vat: D(0) },
        kuf: { count: 0, base: D(0), vat: D(0) },
        bigbitControl: D(0),
      }),
    );
    expect(r.problems).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("razlika tačno na pragu (2,00 RSD) prolazi — prag ne sme biti preuzak", () => {
    const r = evaluateVatSanity(
      input({ bigbitControl: D("21602287.89") }), // razlika +2,00
    );
    expect(r.controlDiff!.toFixed(2)).toBe("2.00");
    expect(r.ok).toBe(true);
  });
});

describe("evaluateVatSanity — reprodukovani otkazi (03/2026 pre ispravke)", () => {
  it("P1: KUF ima 625 stavki a ukupan PDV je 0,00 → problem", () => {
    const r = evaluateVatSanity(
      input({ kuf: { count: 625, base: D(0), vat: D(0) } }),
    );
    expect(r.ok).toBe(false);
    expect(r.problems.some((p) => /KUF za 03\/2026 ima 625 stavki/.test(p))).toBe(true);
    expect(r.problems.some((p) => /ukupan PDV je 0,00/.test(p))).toBe(true);
    // poruka mora reći i UZROK, ne samo da nešto ne valja
    expect(r.problems.some((p) => /tehnički\s+nalog zatvaranja PDV konta/.test(p))).toBe(true);
  });

  it("P2: KIF ima stavke i PDV −1.236.156,30 a osnovicu 0,00 → problem", () => {
    const r = evaluateVatSanity(
      input({ kif: { count: 34, base: D(0), vat: D("-1236156.30") } }),
    );
    expect(r.ok).toBe(false);
    expect(
      r.problems.some((p) => /ukupna osnovica je 0,00/.test(p) && /-1\.236\.156,30/.test(p)),
    ).toBe(true);
  });

  it("P3: |osnovica| < |PDV| (inverzija) → problem, jer je nemoguće do stope 20%", () => {
    const r = evaluateVatSanity(
      input({ kif: { count: 5, base: D("1000"), vat: D("5000") } }),
    );
    expect(r.ok).toBe(false);
    expect(r.problems.some((p) => /manja od ukupnog PDV/.test(p))).toBe(true);
  });

  it("P4: povraćaj 1.236.156,30 umesto BigBit-ovih 21.602.291,00 → problem", () => {
    const r = evaluateVatSanity(
      input({
        kif: { count: 34, base: D(0), vat: D("-1236156.30") },
        kuf: { count: 625, base: D(0), vat: D(0) },
      }),
    );
    expect(r.ok).toBe(false);
    const recon = r.problems.find((p) => /NE slaže sa BigBitom/.test(p));
    expect(recon).toBeDefined();
    expect(recon).toContain("21.602.291,00");
    expect(r.controlDiff!.toFixed(2)).toBe("-20366134.70");
  });

  it("kontrola je vezana za konto 2790/4790 i vrstu naloga PDV", () => {
    expect(VAT_SETTLEMENT_ORDER_TYPE).toBe("PDV");
    expect([...VAT_TRANSIT_ACCOUNTS]).toEqual(["2790", "4790"]);
  });
});

describe("evaluateVatSanity — upozorenja (ne blokiraju)", () => {
  it("otvoren period bez naloga zatvaranja → SAMO upozorenje", () => {
    const r = evaluateVatSanity(input({ months: [7], bigbitControl: null }));
    expect(r.ok).toBe(true);
    expect(r.controlDiff).toBeNull();
    expect(r.warnings.some((w) => /ne postoji nalog zatvaranja PDV konta/.test(w))).toBe(true);
  });

  it("27x/47x konto sa prometom van registara → upozorenje, ne blokada", () => {
    const r = evaluateVatSanity(
      input({ unmappedAccounts: [{ account: "27999", net: D("-12020399.30") }] }),
    );
    expect(r.ok).toBe(true);
    expect(r.warnings.some((w) => /27999/.test(w) && /tiho ispada/.test(w))).toBe(true);
  });
});

describe("assertVatPeriodSane", () => {
  it("ne baca za ispravan period", () => {
    expect(() => assertVatPeriodSane(evaluateVatSanity(input()), "Štampa")).not.toThrow();
  });

  it("baca 409 sa srpskom porukom i spiskom problema u details", () => {
    const report = evaluateVatSanity(
      input({ kuf: { count: 625, base: D(0), vat: D(0) } }),
    );
    let thrown: VatSanityException | null = null;
    try {
      assertVatPeriodSane(report, "Štampa KUF specifikacije za 03/2026");
    } catch (e) {
      thrown = e as VatSanityException;
    }
    expect(thrown).toBeInstanceOf(VatSanityException);
    expect(thrown!.getStatus()).toBe(409);
    const body = thrown!.getResponse() as {
      message: string;
      code: string;
      details: { period: string; problems: string[] };
    };
    expect(body.code).toBe("PDV_OBRACUN_NEISPRAVAN");
    // Rodno neutralan oblik: `what` je čas muški („Obračun"), čas ženski
    // („Štampa") — pridev se uz njega ne sme slagati.
    expect(body.message).toContain(
      "Zaustavljeno: Štampa KUF specifikacije za 03/2026",
    );
    expect(body.message).not.toContain("je zaustavljena");
    expect(body.details.period).toBe("03/2026");
    expect(body.details.problems.length).toBeGreaterThan(0);
  });

  it("uputstvo pominje SAMO ono što u aplikaciji postoji (ne nepostojeći ekran)", () => {
    const report = evaluateVatSanity(
      input({ kuf: { count: 625, base: D(0), vat: D(0) } }),
    );
    let body: { message: string } | null = null;
    try {
      assertVatPeriodSane(report, "Obračun PDV za 03/2026");
    } catch (e) {
      body = (e as VatSanityException).getResponse() as { message: string };
    }
    // Ekran „Podešavanja → PDV konta" NE POSTOJI (registar se menja migracijom);
    // ranija poruka je knjigovođu slala u zid.
    expect(body!.message).not.toContain("Podešavanja");
    expect(body!.message).toContain("Napuni iz GK");
    expect(body!.message).toContain("Ipak prikaži");
    expect(body!.message).toContain("PDV_OBRACUN_NEISPRAVAN");
  });
});

describe("P5 — osnovica mora odgovarati stopi (klasa greške koju P4 NE vidi)", () => {
  /** Grupa po stopi: (smer, stopa) → count/base/vat. */
  const g = (
    direction: "input" | "output",
    rateCode: string | null,
    count: number,
    base: string,
    vat: string,
  ) => ({ direction, rateCode, count, base: D(base), vat: D(vat) });

  it("reprodukovan KIF 02/2026: osnovica 308,8 mil uz PDV 21,5 mil (6,99%) → problem", () => {
    // Izmereno na dev bazi PRE ukidanja `has_base`: konto 47200 („pokrivanje
    // avansa") je skidao 40,7 mil PDV-a a nije skidao osnovicu.
    const r = evaluateVatSanity(
      input({
        months: [2],
        kif: { count: 37, base: D("308851171.00"), vat: D("21575667.23") },
        rateGroups: [g("output", "20", 37, "308851171.00", "21575667.23")],
        bigbitControl: null,
      }),
    );
    expect(r.ok).toBe(false);
    const p = r.problems.find((x) => /stopa 20%/.test(x));
    expect(p).toBeDefined();
    expect(p).toContain("308.851.171,00");
    expect(p).toContain("21.575.667,23");
  });

  it("P4 tu grešku NE bi uhvatio — zato P5 mora da postoji", () => {
    // Ista knjiga, ali kontrola prema BigBitu se poklapa do 0,80 RSD: neto PDV
    // je tačan, pogrešna je samo osnovica. Bez P5 bi period prošao kao ispravan.
    const withoutP5 = evaluateVatSanity(
      input({
        months: [2],
        kif: { count: 37, base: D("308851171.00"), vat: D("21575667.23") },
        kuf: { count: 505, base: D("63741139.30"), vat: D("11893338.03") },
        rateGroups: [],
        bigbitControl: D("-9682330.00"),
      }),
    );
    expect(withoutP5.controlDiff!.abs().lte(D("2.00"))).toBe(true);
    expect(withoutP5.ok).toBe(true);
  });

  it("ispravna knjiga (osnovica × 20% = PDV) prolazi", () => {
    const r = evaluateVatSanity(
      input({
        rateGroups: [
          g("output", "20", 40, "25000000.00", "5000000.00"),
          g("output", "10", 3, "4348545.30", "434854.53"),
        ],
      }),
    );
    expect(r.problems.filter((p) => /stopa/.test(p))).toEqual([]);
  });

  it("zaokruživanje po dokumentu ne diže lažnu uzbunu (prag 1,00 + 0,1%)", () => {
    const r = evaluateVatSanity(
      input({
        // 5.000.000 očekivano, u knjizi 5.004.000 → 0,08% odstupanja
        rateGroups: [g("output", "20", 400, "25000000.00", "5004000.00")],
      }),
    );
    expect(r.problems.filter((p) => /stopa 20%/.test(p))).toEqual([]);
  });

  it('marker „VP" (bez prava na odbitak) se NE meri stopom — upozorenje, ne problem', () => {
    const r = evaluateVatSanity(
      input({
        rateGroups: [g("input", "VP", 1, "100000.00", "20000.00")],
      }),
    );
    expect(r.ok).toBe(true);
    expect(
      r.warnings.some((w) => /bez prava na odbitak/.test(w) && /20\.000,00/.test(w)),
    ).toBe(true);
  });

  it("stavke BEZ upisane stope koje nose PDV → upozorenje (kontu fali stopa)", () => {
    const r = evaluateVatSanity(
      input({ rateGroups: [g("output", null, 2, "0.00", "1236156.30")] }),
    );
    expect(r.ok).toBe(true);
    expect(r.warnings.some((w) => /bez upisane stope/.test(w))).toBe(true);
  });
});

describe("ručne KIF/KUF stavke (D4) NE smeju da obore period", () => {
  it("jedna ručna KUF stavka od 20.000,00 ne ruši kontrolu prema BigBitu", () => {
    // Reprodukovano na dev bazi: ručna stavka nema nalog u glavnoj knjizi, pa je
    // nema ni u BigBit-ovom nalogu zatvaranja. Ranije je razlika = iznos stavke
    // i punjenje/obračun/štampa su padali 409 za CEO period.
    const r = evaluateVatSanity(
      input({
        kuf: { count: 667, base: D("193700721.05"), vat: D("26709144.42") },
        manual: {
          ...NO_MANUAL,
          count: 1,
          input: D("20000.00"),
          inputAll: D("20000.00"),
        },
      }),
    );
    expect(r.ok).toBe(true);
    expect(r.controlDiff!.toFixed(2)).toBe("-1.11"); // kao da ručne stavke nema
    // ali u prijavljenom rezultatu ručna stavka JESTE
    expect(r.computedRefund.toFixed(2)).toBe("21622289.89");
    expect(r.gkRefund.toFixed(2)).toBe("21602289.89");
  });

  it("ručna stavka se imenuje kao odstupnica, ne prećutkuje", () => {
    const r = evaluateVatSanity(
      input({
        kuf: { count: 667, base: D("193700721.05"), vat: D("26709144.42") },
        manual: {
          ...NO_MANUAL,
          count: 1,
          input: D("20000.00"),
          inputAll: D("20000.00"),
        },
      }),
    );
    expect(
      r.warnings.some(
        (w) => /ručno unetu\/e KIF\/KUF/.test(w) && /ne ulaze u poređenje/.test(w),
      ),
    ).toBe(true);
  });

  it('„van PDV" ručna stavka: obračun je ne broji u pretporez, knjiga je vidi', () => {
    // `computed` (VatReturn) je BEZ VP stavke, zbir knjige je SA njom. Kontrola
    // mora da oduzme tačno onaj deo koji je u njen ulaz i ušao — inače štampa
    // pada a obračun prolazi, pa je isti period „i jeste i nije" ispravan.
    const r = evaluateVatSanity(
      input({
        kuf: { count: 667, base: D("193700721.05"), vat: D("26709144.42") },
        computed: { outputVat: D("5086854.53"), inputVat: D("26689144.42") },
        manual: {
          ...NO_MANUAL,
          count: 1,
          input: D(0), // VP ne ulazi u pretporez
          inputAll: D("20000.00"), // ali jeste u knjizi
          noDeduction: D("20000.00"),
        },
      }),
    );
    expect(r.ok).toBe(true);
    expect(r.controlDiff!.toFixed(2)).toBe("-1.11");
  });
});

describe("prag kontrole raste sa dužinom perioda", () => {
  it("kvartal trpi tri zaokruženja (3 × 2,00 = 6,00), mesec samo jedno", () => {
    const mesecni = evaluateVatSanity(input({ months: [3] }));
    expect(mesecni.controlTolerance.toFixed(2)).toBe("2.00");
    const kvartalni = evaluateVatSanity(input({ months: [1, 2, 3] }));
    expect(kvartalni.controlTolerance.toFixed(2)).toBe("6.00");
  });

  it("ispravan kvartal sa 3,33 RSD zaokruženja NE diže lažnu uzbunu", () => {
    const r = evaluateVatSanity(
      input({ months: [1, 2, 3], bigbitControl: D("21602286.56") }),
    );
    expect(r.controlDiff!.toFixed(2)).toBe("3.33");
    expect(r.ok).toBe(true);
  });

  it("ali kvartal van praga i dalje pada", () => {
    const r = evaluateVatSanity(
      input({ months: [1, 2, 3], bigbitControl: D("21602000.00") }),
    );
    expect(r.ok).toBe(false);
    expect(r.problems.some((p) => /NE slaže sa BigBitom/.test(p))).toBe(true);
  });
});

describe('jedna definicija „van PDV" markera, ne dve', () => {
  it("konstanta u vat-sanity je ista kao u DTO sloju", () => {
    // Dve nezavisne definicije pretporeza su bile uzrok toga da isti period
    // istovremeno „jeste i nije" ispravan (obračun prolazi, štampa pada).
    expect(VAT_RATE_CODE_NO_DEDUCTION_SANITY).toBe(VAT_RATE_CODE_NO_DEDUCTION);
  });
});

describe("fmtRsd", () => {
  it("srpski novčani zapis (tačka=hiljade, zarez=decimala), i za negativne", () => {
    expect(fmtRsd(D("21602291"))).toBe("21.602.291,00");
    expect(fmtRsd(D("-1236156.3"))).toBe("-1.236.156,30");
    expect(fmtRsd(D(0))).toBe("0,00");
  });
});
