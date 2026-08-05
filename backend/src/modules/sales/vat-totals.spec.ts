import { Test, TestingModule } from "@nestjs/testing";
import { UnprocessableEntityException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { PostingEngineService } from "../gl/posting/posting.service";
import { GlWriteService } from "../gl/gl-write.service";
import { ReservationService } from "../robno/reservation.service";
import { DocumentNumberSequenceService } from "./numbering.service";
import { PricingService } from "./pricing.service";
import { SefService } from "./sef/sef.service";
import {
  buildSalesLedgerLines,
  FakturisanjeService,
} from "./fakturisanje.service";
import {
  documentVatBreakdown,
  documentVatTotals,
  roundAmount,
  vatBreakdown,
  vatRecapMismatch,
  VAT_RATE_BY_CODE,
  vatIsDerivedFromGross,
  vatPercentOf,
} from "./vat-totals";
import { grossToNet } from "../pdv/vat-bridge.util";
import type { AuthUser } from "../auth/jwt.strategy";

/**
 * PDV DOKUMENTA PO STOPI — pravilo, glavna knjiga i put kroz `createProforma`.
 * =============================================================================
 *
 * 🔴 VISOK NALAZ (peti krug, 02.08.2026): `vatTotal` je bio ZBIR ZAOKRUŽENIH PDV-a PO
 * STAVCI. Dok je PDV stavke bio nezaokružen, to je davalo isti broj po distributivnosti;
 * čim je i on zaokružen na paru (istog dana, da bi `osnovica × stopa` moglo da se ponovi
 * nad odštampanom stavkom), jednakost je pala:
 *
 *     5 stavki × 100,01 din uz 20 %  →  osnovica 500,05
 *       Σ PDV po stavci = 5 × 20,00 = 100,00
 *       500,05 × 20 %                = 100,01
 *
 * Papir tu jednačinu ŠTAMPA, SEF je proverava (EN 16931 BR-CO-17), a KIF iz PDV-a IZVODI
 * osnovicu — pa razlika od pare nije kozmetika ni na jednom od ta tri mesta.
 *
 * Ovaj spec pokriva tri stvari koje ostali ne mogu:
 *   1) samo pravilo (`documentVatTotals`) i njegove granične slučajeve,
 *   2) GLAVNU KNJIGU (`buildSalesLedgerLines`) — da nalog balansira i da kupčev dug bude
 *      BAŠ bruto iznos fakture, na sve tri putanje po kojima PDV ulazi u GK,
 *   3) `createProforma` — drugi pisac zaglavlja (pored `SalesService.recalcTotals`).
 */

const D = (v: string | number) => new Prisma.Decimal(v);

const actor: AuthUser = {
  userId: 7,
  email: "fakturista@servoteh",
  role: "racunovodja",
  workerId: null,
};

// ─────────────────────────────────────────────────────────────────────────────
// 1) PRAVILO
// ─────────────────────────────────────────────────────────────────────────────

describe("documentVatTotals — porez se računa iz osnovice po stopi", () => {
  it("5 × 100,01 uz 20 % → 500,05 + 100,01 = 600,06 (a ne 100,00)", () => {
    const t = documentVatTotals(
      [1, 2, 3, 4, 5].map(() => ({ vatRateCode: "3", vatBase: D("100.01") })),
    );
    expect(t.netTotal.toFixed(2)).toBe("500.05");
    expect(t.vatTotal.toFixed(2)).toBe("100.01");
    expect(t.grossTotal.toFixed(2)).toBe("600.06");
  });

  it("grupe idu opadajuće po stopi i svaka nosi `round2(osnovica × stopa)`", () => {
    // Šifra „4" = snižena stopa 10 % (`R_Tarife`, NIZA) — v. `gl/posting/vat-rates.ts`.
    const t = documentVatTotals([
      { vatRateCode: "4", vatBase: D("100.05") },
      { vatRateCode: "3", vatBase: D("100.01") },
      { vatRateCode: "4", vatBase: D("100.05") },
      { vatRateCode: "3", vatBase: D("100.01") },
    ]);
    expect(t.groups.map((g) => g.ratePercent.toFixed(0))).toEqual(["20", "10"]);
    expect(t.groups[0].base.toFixed(2)).toBe("200.02");
    expect(t.groups[0].vat.toFixed(2)).toBe("40.00"); // 40,004 → 40,00
    expect(t.groups[1].base.toFixed(2)).toBe("200.10");
    expect(t.groups[1].vat.toFixed(2)).toBe("20.01");
    expect(t.vatTotal.toFixed(2)).toBe("60.01");
  });

  it("izvoz obara SVE stavke na 0 % bez obzira na nasleđenu šifru (čl. 24)", () => {
    const t = documentVatTotals(
      [
        { vatRateCode: "3", vatBase: D("1000") },
        { vatRateCode: "2", vatBase: D("500") },
      ],
      { isExport: true },
    );
    expect(t.groups).toHaveLength(1);
    expect(t.vatTotal.toFixed(2)).toBe("0.00");
    expect(t.grossTotal.toFixed(2)).toBe("1500.00");
  });

  it("nepoznata šifra znači 0 % (isto kao u `PricingService`), ne tihih 20 %", () => {
    expect(vatPercentOf("XX").toFixed(0)).toBe("0");
    const t = documentVatTotals([{ vatRateCode: "XX", vatBase: D("100") }]);
    expect(t.vatTotal.toFixed(2)).toBe("0.00");
  });

  /**
   * 🔴 NALAZ S4 (šesti krug): ključ je bila ŠIFRA sa `?? "0"`, pa je prazan string ostajao
   * `""` i pravio SVOJU grupu. Izmereno: `""`, `"0"` i `"9"` su davali TRI grupe od po 0 %
   * — a u e-fakturi tri `cac:TaxSubtotal`-a za isti oslobođen promet (BR-S-08/BR-E-08
   * traže po jedan po paru kategorija+stopa) i tri identična reda „PDV po stopi 0%" na
   * papiru. Od ispravke je ključ (kategorija, stopa), pa sve troje čine JEDNU grupu (E, 0).
   */
  it("prazna, nulta i nepoznata šifra su JEDNA grupa od 0 %, a ne tri", () => {
    const t = documentVatTotals([
      { vatRateCode: "", vatBase: D("10.00") },
      { vatRateCode: "0", vatBase: D("20.00") },
      { vatRateCode: "9", vatBase: D("30.00") },
      { vatRateCode: null, vatBase: D("40.00") },
    ]);
    expect(t.groups).toHaveLength(1);
    expect(t.groups[0].category).toBe("E");
    expect(t.groups[0].base.toFixed(2)).toBe("100.00");
    expect(t.vatTotal.toFixed(2)).toBe("0.00");
  });

  /**
   * 🔴 NALAZ R3 (šesti krug): zaglavlje je grupisalo po ŠIFRI, e-faktura po STOPI, papir po
   * efektivnoj stopi iz iznosa. Dve šifre sa ISTOM stopom su zato davale različit porez:
   *
   *   izmereno na šiframa „3" i „1" (obe su tada bile 20 %), dve stavke po 100,03 din:
   *     po šifri  → round2(100,03 × 20 %) × 2 = 20,01 + 20,01 = 40,02   (zaglavlje)
   *     po stopi  → round2(200,06 × 20 %)     =         40,01           (e-faktura, papir)
   *   najmanji ulaz koji to pokazuje: osnovice 0,01 i 0,02.
   *
   * ⚠️ Mapa stopa je istog dana ispravljena po `R_Tarife` (šifra „1" je BEZPDV = 0 %), pa
   * par sa istom stopom sada čine „3" i „6" (obe 20 %). BROJEVI SU ISTI, jer ključ i jeste
   * STOPA a ne šifra — što ovaj test i dokazuje. Par se izvodi IZ MAPE, da bi test preživeo
   * i sledeću njenu ispravku.
   */
  it("dve različite šifre sa ISTOM stopom daju JEDNU grupu (100,03 + 100,03 → 40,01)", () => {
    const codes = Object.keys(VAT_RATE_BY_CODE).filter((c) =>
      vatPercentOf(c).equals(20),
    );
    expect(codes.length).toBeGreaterThanOrEqual(2);
    const [first, second] = codes;

    const t = documentVatTotals([
      { vatRateCode: first, vatBase: D("100.03") },
      { vatRateCode: second, vatBase: D("100.03") },
    ]);
    expect(t.groups).toHaveLength(1);
    expect(t.groups[0].base.toFixed(2)).toBe("200.06");
    expect(t.vatTotal.toFixed(2)).toBe("40.01"); // NE 40,02 (dva puta round2 po šifri)
    expect(t.grossTotal.toFixed(2)).toBe("240.07");
  });

  it("najmanji ulaz koji obara podelu po šifri: osnovice 0,01 i 0,02", () => {
    const codes = Object.keys(VAT_RATE_BY_CODE).filter((c) =>
      vatPercentOf(c).equals(20),
    );
    const t = documentVatTotals([
      { vatRateCode: codes[0], vatBase: D("0.01") },
      { vatRateCode: codes[1], vatBase: D("0.02") },
    ]);
    // Po šifri: round2(0,002) + round2(0,004) = 0,00 + 0,00 = 0,00.
    // Po stopi: round2(0,03 × 20 %) = round2(0,006) = 0,01.
    expect(t.vatTotal.toFixed(2)).toBe("0.01");
  });

  /**
   * Izvozna 0 % (Z) i domaća oslobođena 0 % (E) NE SMEJU u istu grupu: u UBL-u nose
   * različit osnov oslobođenja (`TaxExemptionReasonCode` čl. 24 vs bez njega). Zato je
   * ključ (kategorija, stopa), a ne sama stopa.
   */
  it("kategorija je deo ključa: izvoz daje Z, domaće oslobođenje E", () => {
    expect(
      documentVatTotals([{ vatRateCode: "0", vatBase: D("100") }], {
        isExport: true,
      }).groups[0].category,
    ).toBe("Z");
    expect(
      documentVatTotals([{ vatRateCode: "0", vatBase: D("100") }]).groups[0]
        .category,
    ).toBe("E");
  });

  /**
   * NALAZ S2: kolona je `Decimal(19,4)`, pa uvoz / ručna ispravka u bazi / budući BigBit
   * uvoz mogu da donesu NEZAOKRUŽENU osnovicu. Zbir se brani NA SABIRANJU.
   */
  it("nezaokružena osnovica se zaokruži PRE sabiranja (31,995 + 32,00 = 64,00)", () => {
    const t = documentVatTotals([
      { vatRateCode: "3", vatBase: D("31.995") },
      { vatRateCode: "3", vatBase: D("32.00") },
    ]);
    expect(t.netTotal.toFixed(2)).toBe("64.00");
    expect(t.vatTotal.toFixed(2)).toBe("12.80");
  });

  it("dokument bez stavki daje čiste nule (prazan nacrt se ne obara)", () => {
    const t = documentVatTotals([]);
    expect(t.netTotal.toFixed(2)).toBe("0.00");
    expect(t.vatTotal.toFixed(2)).toBe("0.00");
    expect(t.grossTotal.toFixed(2)).toBe("0.00");
    expect(t.groups).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 1b) OBJAVLJEN POREZ — dokument koji PDV izvodi IZ BRUTA (avans)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 🔴 NALAZI R1 i R2 (šesti krug). Avansni račun porez NE MNOŽI nego DELI: bruto koji je
 * kupac uplatio je dat, pa `grossToNet` (pdv/vat-bridge.util) iz njega izvodi osnovicu, a
 * porez dobija RAZLIKOM. Za takav dokument `round2(osnovica × stopa)` ne mora da vrati
 * porez koji je proknjižen — i za 16,67 % bruto iznosa ne vraća.
 *
 * IZMERENO: AVR bruto 132,03 uz 20 % → osnovica 110,03, porez 22,00; a
 * `110,03 × 20 % = 22,006 → 22,01`.
 */
describe("documentVatBreakdown — zaglađivanje SAMO tamo gde porez dolazi iz bruta", () => {
  /** Avansni račun ima TAČNO JEDNU stavku i JEDNU stopu: iz `grossToNet`. */
  const advance = (gross: string, ratePct = 20) => {
    const { net, vat } = grossToNet(gross, ratePct);
    return { net, vat, gross: net.add(vat) };
  };

  /** Zaglavlje dokumenta koji se PRIKAZUJE — vrsta odlučuje da li se zaglađuje. */
  const header = (documentType: string, vatTotal: Prisma.Decimal) => ({
    documentType,
    isExport: false,
    vatTotal,
  });

  it("izmereni AVR 132,03 din: `grossToNet` daje 110,03 + 22,00, a množenje 22,01", () => {
    const a = advance("132.03");
    expect(a.net.toFixed(2)).toBe("110.03");
    expect(a.vat.toFixed(2)).toBe("22.00");
    expect(a.gross.toFixed(2)).toBe("132.03");
    expect(roundAmount(a.net.mul(20).div(100)).toFixed(2)).toBe("22.01");
  });

  it("AVANS preuzima objavljen porez → osnovica + porez == bruto (132,03, ne 132,02)", () => {
    const a = advance("132.03");
    const groups = documentVatBreakdown(header("AVR", a.vat), [
      { vatRateCode: "3", vatBase: a.net },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].ratePercent.toFixed(0)).toBe("20");
    expect(groups[0].base.toFixed(2)).toBe("110.03");
    expect(groups[0].vat.toFixed(2)).toBe("22.00");
    expect(groups[0].base.add(groups[0].vat).toFixed(2)).toBe("132.03");
  });

  /**
   * 🔴 NALAZ Z1 (sedmi krug): osobina „porez je izveden iz bruta" je osobina VRSTE
   * DOKUMENTA, a ne poziva. Isti brojevi pod vrstom `IFR` NISU avans — tu je 22,00 uz
   * osnovicu 110,03 obična greška u zaglavlju, i mora da ostane vidljiva.
   */
  it("🔴 Z1 — ISTI brojevi pod vrstom IFR se NE zaglađuju (22,01, ne 22,00)", () => {
    const a = advance("132.03");
    const lines = [{ vatRateCode: "3", vatBase: a.net }];
    expect(vatIsDerivedFromGross({ documentType: "IFR" })).toBe(false);
    expect(
      documentVatBreakdown(header("IFR", a.vat), lines)[0].vat.toFixed(2),
    ).toBe("22.01");
    // Isto i za vrste koje ni ne postoje u spisku, i za prazan `documentType`.
    expect(
      documentVatBreakdown(header("", a.vat), lines)[0].vat.toFixed(2),
    ).toBe("22.01");
  });

  it("goli `vatBreakdown` uopšte ne zna za objavljen porez — uvek množi", () => {
    const a = advance("132.03");
    const groups = vatBreakdown([{ vatRateCode: "3", vatBase: a.net }]);
    expect(groups[0].vat.toFixed(2)).toBe("22.01");
  });

  it("vrsta je neosetljiva na razmake i mala slova (`documentType` iz uvoza)", () => {
    const a = advance("132.03");
    expect(vatIsDerivedFromGross({ documentType: " avr " })).toBe(true);
    expect(
      documentVatBreakdown(header(" avr ", a.vat), [
        { vatRateCode: "3", vatBase: a.net },
      ])[0].vat.toFixed(2),
    ).toBe("22.00");
  });

  /**
   * Ovo NIJE nasumično uzorkovanje nego iscrpna provera: svaki bruto iznos od 1,00 do
   * 5.000,00 (499.901 iznos) po obe stope. Papir i e-faktura moraju da se zatvore na
   * SVAKOM od njih, a ne na „skoro svakom".
   */
  it("svih 499.901 bruto iznosa 1,00–5.000,00 (20 % i 10 %): AVR se zatvara u bruto", () => {
    let divergedFromMultiplication = 0;
    let total = 0;
    for (const ratePct of [20, 10]) {
      for (let cents = 100; cents <= 500000; cents += 1) {
        const gross = new Prisma.Decimal(cents).div(100);
        const { net, vat } = grossToNet(gross, ratePct);
        const groups = documentVatBreakdown(header("AVR", vat), [
          { ratePercent: ratePct, vatBase: net },
        ]);
        total += 1;
        // JEDINA tvrdnja koja mora da važi uvek: papir se zatvara u naplaćen bruto.
        if (!groups[0].base.add(groups[0].vat).equals(gross)) {
          throw new Error(
            `bruto ${gross.toFixed(2)} @ ${ratePct}%: ` +
              `${groups[0].base.toFixed(2)} + ${groups[0].vat.toFixed(2)}`,
          );
        }
        if (!roundAmount(net.mul(ratePct).div(100)).equals(vat)) {
          divergedFromMultiplication += 1;
        }
      }
    }
    expect(total).toBe(999802);
    // Udeo iznosa za koje NE POSTOJI osnovica koja zadovoljava obe jednačine:
    // 1/6 na 20 % (16,67 %) i 1/11 na 10 % (9,09 %) — v. uvod `vat-totals.ts`.
    expect(divergedFromMultiplication / total).toBeGreaterThan(0.12);
    expect(divergedFromMultiplication / total).toBeLessThan(0.14);
  });

  /**
   * BRANA NAD PREUZIMANJEM: pokvareno zaglavlje se NE zaglađuje ni na avansu. Bez granice
   * bi dokument sa `vat_total = 0` uz osnovicu od 500,00 dobio papir i XML koji ga
   * POTVRĐUJU.
   */
  it("razlika veća od zaokruživanja se NE preuzima — ostaje vidljiva", () => {
    const groups = documentVatBreakdown(header("AVR", D("0")), [
      { vatRateCode: "3", vatBase: D("500.00") },
    ]);
    expect(groups[0].vat.toFixed(2)).toBe("100.00"); // ne 0,00
  });

  it("para poreza se NIKAD ne dodeljuje grupi od 0 % (oslobođen promet)", () => {
    const groups = documentVatBreakdown(header("AVR", D("0.01")), [
      { vatRateCode: "0", vatBase: D("100.00") },
    ]);
    expect(groups[0].vat.toFixed(2)).toBe("0.00");
  });

  /**
   * 🔴 NALAZ Z2 — GRANICA JE BILA 2× ŠIRA NEGO ŠTO TREBA. Matematički
   * `≤ 0,005n + 0,005G ≤ 0,01n`; brute force sedmog kruga (120.000 nasumičnih dokumenata)
   * je izmerio najveći odnos `razlika/tolerancija` = 0,5000, tj. nijedan dokument nije ni
   * prišao staroj granici. Stvarno potrebno je `max(0,01; 0,005 × n)`.
   */
  it("🔴 Z2 — tolerancija je `max(0,01; 0,005 × n)`, ne `0,01 × n`", () => {
    // 4 reda sa iznosom → tolerancija 0,02. Razlika 0,02 prolazi ako je pripisiva…
    const lines = [1, 2, 3, 4].map(() => ({
      vatRateCode: "3",
      vatBase: D("100.00"),
    }));
    // …a 0,03 (što je bilo unutar starog pojasa 0,04) više ne prolazi.
    expect(
      documentVatBreakdown(header("AVR", D("79.97")), lines)[0].vat.toFixed(2),
    ).toBe("80.00");
  });

  /**
   * 🔴 NALAZ Z1/B — pojas je rastao po `lines.length`, pa je 500 legitimnih redova od
   * 0,00 (rabat 100 %) davalo toleranciju 5,01 RSD. Broje se samo redovi SA IZNOSOM.
   */
  it("🔴 Z1/B — redovi od 0,00 ne šire pojas (194,99 umesto 200,00 ne prolazi)", () => {
    const lines = [{ vatRateCode: "3", vatBase: D("1000.00") }];
    for (let i = 0; i < 500; i += 1)
      lines.push({ vatRateCode: "3", vatBase: D("0.00") });
    expect(
      documentVatBreakdown(header("AVR", D("194.99")), lines)[0].vat.toFixed(2),
    ).toBe("200.00");
  });

  /**
   * 🔴 NALAZ Z1/A — meta se birala po najvećoj osnovici, bez odnosa prema iznosu koji joj
   * se dodaje: 99 redova @ 0 % × 100,00 + 1 red @ 20 % sa osnovicom 0,05 uz
   * `vat_total = 1,01` davalo je `20 % | 0,05 | 1,01`, tj. efektivnu stopu od 2020 %.
   */
  it("🔴 Z1/A — pripisana razlika ne sme da promeni efektivnu stopu grupe", () => {
    const lines = Array.from({ length: 99 }, () => ({
      vatRateCode: "0",
      vatBase: D("100.00"),
    }));
    lines.push({ vatRateCode: "3", vatBase: D("0.05") });
    const groups = documentVatBreakdown(header("AVR", D("1.01")), lines);
    const taxed = groups.find((g) => g.ratePercent.equals(20));
    expect(taxed?.vat.toFixed(2)).toBe("0.01"); // NE 1,01
  });

  /**
   * 🔴 NALAZ Z3 — RAZLIKA ROĐENA U JEDNOJ GRUPI JE PADALA NA NEVINU. Izmereno: red
   * 110,03 @ 20 % (porez izveden deljenjem) + red 1.000,00 @ 10 % uz `vat_total = 122,00`
   * → 20 % je dobijala svoju tačnu matematiku (22,01), a 10 % je dobijala 99,99
   * (efektivna stopa 9,999 %), pa je BR-CO-17 padao na grupi koja problem nije ni imala.
   */
  it("🔴 Z3 — razlika iz grupe od 20 % ne sme da završi na grupi od 10 %", () => {
    const groups = documentVatBreakdown(header("AVR", D("122.00")), [
      { vatRateCode: "3", vatBase: D("110.03") },
      { vatRateCode: "4", vatBase: D("1000.00") },
    ]);
    const byRate = new Map(groups.map((g) => [g.ratePercent.toFixed(0), g]));
    // Razlika se vraća TAMO GDE JE ROĐENA: 110,03 + 22,00 = 132,03 je valjan izvod iz
    // bruta, a 1.000,00 + 99,99 nije (`grossToNet(1.099,99; 10) = (999,99; 100,00)`).
    expect(byRate.get("20")?.vat.toFixed(2)).toBe("22.00");
    expect(byRate.get("10")?.vat.toFixed(2)).toBe("100.00"); // NE 99,99 (staro ponašanje)
    // Zbir i dalje zatvara objavljen porez — ali bez laži o efektivnoj stopi 10 % grupe.
    expect(groups.reduce((s, g) => s.add(g.vat), D(0)).toFixed(2)).toBe(
      "122.00",
    );
  });

  /**
   * 🔴 Z3, druga polovina — KAD SE NE ZNA ČIJA JE RAZLIKA, NE ZAGLAĐUJE SE.
   *
   * Konstruisan ulaz (iscrpna pretraga po osnovicama do 20.000,00): i grupa od 20 % sa
   * osnovicom 0,13 i grupa od 10 % sa osnovicom 0,25 su, sa pripisanom razlikom od
   * −0,01, valjan izvod iz bruta. Pripisivanje je dvosmisleno → nijedna se ne dira, a
   * razlika ostaje VIDLJIVA (kontrolni red na papiru, pad BR-CO-14 na SEF-u).
   */
  it("🔴 Z3 — dvosmisleno pripisivanje se NE zaglađuje (0,13 @ 20 % + 0,25 @ 10 %)", () => {
    const groups = documentVatBreakdown(header("AVR", D("0.05")), [
      { vatRateCode: "3", vatBase: D("0.13") },
      { vatRateCode: "4", vatBase: D("0.25") },
    ]);
    const byRate = new Map(groups.map((g) => [g.ratePercent.toFixed(0), g]));
    expect(byRate.get("20")?.vat.toFixed(2)).toBe("0.03");
    expect(byRate.get("10")?.vat.toFixed(2)).toBe("0.03");
    expect(groups.reduce((s, g) => s.add(g.vat), D(0)).toFixed(2)).toBe("0.06");
  });

  /**
   * 🔴 NALAZ Z4 — „nula pada glasno" nije važilo za male iznose: granica je apsolutna, a
   * primer u komentaru (100,00) je prolazio samo zato što je bio mnogo veći od nje.
   * 20 redova @ 20 % sa osnovicom 0,05 (grupa 1,00, tačan PDV 0,20) uz `vat_total = 0`
   * davalo je papir `20 % | 1,00 | 0,00` bez crvenog reda.
   */
  it("🔴 Z4 — `vat_total = 0` na maloj grupi (1,00 uz 20 %) NE prolazi", () => {
    const lines = Array.from({ length: 20 }, () => ({
      vatRateCode: "3",
      vatBase: D("0.05"),
    }));
    const groups = documentVatBreakdown(header("AVR", D("0")), lines);
    expect(groups[0].base.toFixed(2)).toBe("1.00");
    expect(groups[0].vat.toFixed(2)).toBe("0.20"); // NE 0,00
  });

  it("🔴 Z4 — ni JEDAN red od 0,05 uz `vat_total = 0` ne prolazi kroz toleranciju", () => {
    // Razlika je tačno 0,01 (unutar tolerancije) i efektivna stopa se „ne menja" za više
    // od pare — obara je četvrta brana: `grossToNet(0,05; 20) = (0,04; 0,01) ≠ (0,05; 0)`.
    const groups = documentVatBreakdown(header("AVR", D("0")), [
      { vatRateCode: "3", vatBase: D("0.05") },
    ]);
    expect(groups[0].vat.toFixed(2)).toBe("0.01");
  });

  /**
   * 🔴 NALAZ Z5 — meta se birala `greaterThan` nad osnovicom, a to kod negativnih iznosa
   * bira NAJMANJU po apsolutnoj vrednosti; ogledalski par (faktura i knjižno odobrenje)
   * se zato nije poništavao PO STOPI. Sada je izbor po `|osnovica|`, pa je par simetričan.
   */
  it("🔴 Z5 — ogledalski avans: osnovica i porez se poništavaju do pare", () => {
    const a = advance("132.03");
    const plus = documentVatBreakdown(header("AVR", a.vat), [
      { vatRateCode: "3", vatBase: a.net },
    ]);
    const minus = documentVatBreakdown(header("AVR", a.vat.neg()), [
      { vatRateCode: "3", vatBase: a.net.neg() },
    ]);
    expect(minus[0].vat.toFixed(2)).toBe("-22.00");
    expect(plus[0].base.add(minus[0].base).toFixed(2)).toBe("0.00");
    expect(plus[0].vat.add(minus[0].vat).toFixed(2)).toBe("0.00");
  });
});

/**
 * 🔴 NALAZ Z1 (sedmi krug) — KONTROLNI RED JE MERIO IZRAZ KOJI JE PO KONSTRUKCIJI NULA.
 * `Σosn + Σpdv − bruto` je nula kad god je zaglavlje interno dosledno (`bruto = neto +
 * porez`), a tako ga piše i uvoz i ručna izmena kroz UI — pa kontrola nije mogla da vidi
 * pogrešan `vat_total`.
 */
describe("vatRecapMismatch — merilo koje STVARNO hvata pogrešno zaglavlje", () => {
  const groups = (base: string, vat: string) => [
    { base: D(base), vat: D(vat) },
  ];

  it("zdrav dokument → `null` (nema crvenog reda)", () => {
    expect(
      vatRecapMismatch(groups("1000.00", "200.00"), {
        netTotal: D("1000.00"),
        vatTotal: D("200.00"),
      }),
    ).toBeNull();
  });

  it("pogrešan `vat_total` se vidi, iako je zaglavlje interno dosledno", () => {
    // Staro merilo: (1000 + 200) − 1199,99 … ali je i `grossTotal` upisan kao 1.199,99,
    // pa je izraz bio 0,00. Novo merilo poredi sa `vat_total` direktno.
    const m = vatRecapMismatch(groups("1000.00", "200.00"), {
      netTotal: D("1000.00"),
      vatTotal: D("199.99"),
    });
    expect(m?.baseDiff.toFixed(2)).toBe("0.00");
    expect(m?.vatDiff.toFixed(2)).toBe("0.01");
  });

  it("osnovica i porez se mere ODVOJENO — u zbiru bi se poništili", () => {
    // +0,01 na osnovici i −0,01 na porezu: zbirno merilo daje 0,00 i ćuti.
    const m = vatRecapMismatch(groups("1000.01", "199.99"), {
      netTotal: D("1000.00"),
      vatTotal: D("200.00"),
    });
    expect(m).not.toBeNull();
    expect(m?.baseDiff.toFixed(2)).toBe("0.01");
    expect(m?.vatDiff.toFixed(2)).toBe("-0.01");
  });

  it("ostatak ispod pare (`Decimal(19,4)`) se ne prijavljuje — na papiru se ne vidi", () => {
    expect(
      vatRecapMismatch(groups("1000.0001", "200.00"), {
        netTotal: D("1000.00"),
        vatTotal: D("200.00"),
      }),
    ).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2) GLAVNA KNJIGA
// ─────────────────────────────────────────────────────────────────────────────

describe("buildSalesLedgerLines — GK po stopi, i dalje balansira", () => {
  const invoice = (over: Record<string, unknown> = {}) => ({
    documentType: "IFUSL",
    documentNumber: "12/26",
    customerId: 5,
    isExport: false,
    ...over,
  });

  const balance = (lines: ReturnType<typeof buildSalesLedgerLines>) => {
    const zero = D(0);
    const debit = lines.reduce((s, l) => s.add(l.debit), zero);
    const credit = lines.reduce((s, l) => s.add(l.credit), zero);
    return { debit, credit };
  };

  it("PDV linija nosi `round2(osnovica × stopa)`, a kupac BAŠ bruto fakture", () => {
    const items = [1, 2, 3, 4, 5].map(() => ({
      vatRateCode: "3",
      vatBase: D("100.01"),
    }));
    const lines = buildSalesLedgerLines(invoice(), items);

    const byAcc = new Map(lines.map((l) => [l.accountCode, l]));
    expect(byAcc.get("2040")?.debit.toFixed(2)).toBe("600.06");
    expect(byAcc.get("6140")?.credit.toFixed(2)).toBe("500.05");
    // ⚠️ 4703, ne 4702 (ispravka 05.08.2026): dokument je IFUSL — USLUGA — pa porez
    // ide na uslužni konto, kao i prihod dva reda iznad (6140). Do 05.08. je ovaj test
    // tvrdio prihod usluge uz PDV robe na istom nalogu.
    expect(byAcc.get("4703")?.credit.toFixed(2)).toBe("100.01");

    const { debit, credit } = balance(lines);
    expect(debit.toFixed(4)).toBe(credit.toFixed(4));
  });

  it("dve stope → dva PDV konta (4702/4710), nalog i dalje balansira", () => {
    const lines = buildSalesLedgerLines(invoice({ documentType: "IFR" }), [
      { vatRateCode: "3", vatBase: D("100.01") },
      { vatRateCode: "3", vatBase: D("100.01") },
      { vatRateCode: "4", vatBase: D("100.05") },
      { vatRateCode: "4", vatBase: D("100.05") },
    ]);
    const byAcc = new Map(lines.map((l) => [l.accountCode, l]));
    expect(byAcc.get("2040")?.debit.toFixed(2)).toBe("460.13");
    expect(byAcc.get("6040")?.credit.toFixed(2)).toBe("400.12");
    expect(byAcc.get("4702")?.credit.toFixed(2)).toBe("40.00");
    expect(byAcc.get("4710")?.credit.toFixed(2)).toBe("20.01");

    const { debit, credit } = balance(lines);
    expect(debit.toFixed(4)).toBe(credit.toFixed(4));
  });

  it("izvoz: kupac 2050, prihod = bruto, bez ijedne PDV linije", () => {
    const lines = buildSalesLedgerLines(
      invoice({ documentType: "IZVUS", isExport: true }),
      [{ vatRateCode: "3", vatBase: D("1000") }],
    );
    expect(lines.map((l) => l.accountCode)).toEqual(["2050", "6140"]);
    const { debit, credit } = balance(lines);
    expect(debit.toFixed(2)).toBe("1000.00");
    expect(credit.toFixed(2)).toBe("1000.00");
  });

  /**
   * 🔶 ZATEČENO, prijavljeno u `docs/PREOSTALE_FAZE.md`: stopa od 8 % (POLJO — PDV
   * nadoknada poljoprivrednicima, poreska šifra „5" po `R_Tarife`) je do 02.08.2026.
   * padala u granu „inače", pa se knjižila na `4702 — PDV 20 % na prodate robe`. Nalog bi
   * balansirao, ali bi POPDV polje 3.2 iz tog konta izvodilo osnovicu deljenjem sa 0,2 —
   * osnovica prometa po 8 % bi u obrazac ušla umanjena za 60 %.
   *
   * Konto izlaznog PDV-a od 8 % u kontnom planu NE POSTOJI (postoji samo
   * `4750 — PDV po osnovu SOPSTVENE POTROŠNJE 8 %`, što nije promet po izdatoj fakturi),
   * pa se ne izmišlja: knjiženje se odbija sa objašnjenjem.
   */
  it("stopa bez konta (8 %) se ne knjiži tiho na konto od 20 % — 422 sa objašnjenjem", () => {
    expect(vatPercentOf("5").toFixed(0)).toBe("8");
    expect(() =>
      buildSalesLedgerLines(invoice(), [
        { vatRateCode: "5", vatBase: D("1000") },
      ]),
    ).toThrow(UnprocessableEntityException);
    expect(() =>
      buildSalesLedgerLines(invoice(), [
        { vatRateCode: "5", vatBase: D("1000") },
      ]),
    ).toThrow(/8%.*ne postoji konto izlaznog PDV-a/s);
  });

  it("stavka sa 0 % ne pravi praznu PDV liniju", () => {
    const lines = buildSalesLedgerLines(invoice(), [
      { vatRateCode: "0", vatBase: D("1000") },
    ]);
    expect(lines.map((l) => l.accountCode)).toEqual(["2040", "6140"]);
  });

  /** Invarijanta nad nasumičnim dokumentima: nalog uvek balansira i uvek je bruto. */
  it("nasumični dokumenti (1–20 stavki): ΣDug == ΣPot == bruto fakture", () => {
    // „3" i „6" su OBE 20 % — nasumični dokument tako uvek meša i par koji se spaja u
    // jednu grupu. „5" (8 %) je izostavljen jer nema konto izlaznog PDV-a (pokriveno gore).
    const CODES = ["3", "6", "4", "1", "0"] as const;
    let seed = 20260802;
    const rnd = () => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return Math.abs(seed) / 2147483648;
    };

    for (let doc = 0; doc < 200; doc += 1) {
      const items = Array.from({ length: 1 + Math.floor(rnd() * 20) }, () => ({
        vatRateCode: CODES[Math.floor(rnd() * CODES.length)],
        vatBase: D((rnd() * 1000 + 0.01).toFixed(2)),
      }));
      const totals = documentVatTotals(items);
      const lines = buildSalesLedgerLines(invoice(), items);
      const { debit, credit } = balance(lines);

      expect(debit.toFixed(4)).toBe(credit.toFixed(4));
      expect(debit.toFixed(2)).toBe(totals.grossTotal.toFixed(2));
      // Jednačina koju papir štampa, po svakoj stopi.
      for (const g of totals.groups) {
        expect(g.vat.toFixed(2)).toBe(
          roundAmount(g.base.mul(g.ratePercent).div(100)).toFixed(2),
        );
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3) createProforma — drugi pisac zaglavlja
// ─────────────────────────────────────────────────────────────────────────────

describe("createProforma — zaglavlje nosi PDV po stopi", () => {
  interface WrittenHeader {
    netTotal: Prisma.Decimal;
    vatTotal: Prisma.Decimal;
    grossTotal: Prisma.Decimal;
  }

  /** Zbirovi iz PRVOG `invoice.create` — ono što bi stvarno otišlo u bazu. */
  function writtenHeader(create: jest.Mock): WrittenHeader {
    const calls = create.mock.calls as unknown as [{ data: WrittenHeader }][];
    return calls[0][0].data;
  }

  /** Cena stavke: `PricingService` je zamenjen, ali vraća BAŠ ono što bi i pravi. */
  function pricedItem(vatBase: string, vatRateCode = "3") {
    const rate = vatRateCode === "2" ? "0.10" : "0.20";
    return {
      quantity: D(1),
      unitPrice: D(vatBase),
      unitPriceBeforeDiscount: D(vatBase),
      discountPercent: D(0),
      cashDiscountPercent: D(0),
      vatRateCode,
      vatBase: D(vatBase),
      vatAmount: D(vatBase)
        .mul(rate)
        .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP),
    };
  }

  async function makeService(priceItem: jest.Mock) {
    const prisma = {
      invoice: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockImplementation((args: { data: unknown }) => ({
          id: 1,
          items: [],
          ...(args.data as object),
        })),
      },
      customer: {
        findUnique: jest.fn().mockResolvedValue({
          id: 5,
          salespersonId: null,
          paymentMethod: null,
        }),
      },
      $queryRaw: jest.fn().mockResolvedValue([{ balance: D(0) }]),
      $transaction: jest.fn(),
    };
    prisma.$transaction.mockImplementation((arg: unknown) =>
      Array.isArray(arg)
        ? Promise.all(arg)
        : (arg as (tx: unknown) => unknown)(prisma),
    );

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FakturisanjeService,
        { provide: PrismaService, useValue: prisma },
        { provide: PricingService, useValue: { priceItem } },
        {
          provide: DocumentNumberSequenceService,
          useValue: { next: jest.fn().mockResolvedValue("12/26") },
        },
        {
          provide: PostingEngineService,
          useValue: { postManualEntry: jest.fn() },
        },
        { provide: GlWriteService, useValue: { reverse: jest.fn() } },
        { provide: SefService, useValue: { enqueue: jest.fn() } },
        { provide: ReservationService, useValue: { release: jest.fn() } },
      ],
    }).compile();

    return { service: module.get(FakturisanjeService), prisma };
  }

  it("pet stavki po 100,01 din daje `vatTotal` 100,01, ne 100,00", async () => {
    const priceItem = jest.fn().mockResolvedValue(pricedItem("100.01"));
    const { service, prisma } = await makeService(priceItem);

    await service.createProforma(
      {
        customerId: 5,
        documentDate: "2026-07-01",
        items: [1, 2, 3, 4, 5].map(() => ({
          description: "Stavka",
          quantity: 1,
        })),
      },
      actor,
    );

    const written = writtenHeader(prisma.invoice.create);
    expect(written.netTotal.toFixed(2)).toBe("500.05");
    expect(written.vatTotal.toFixed(2)).toBe("100.01");
    expect(written.grossTotal.toFixed(2)).toBe("600.06");
  });

  it("izvoz: PDV je 0 i bruto je jednak osnovici", async () => {
    const priceItem = jest.fn().mockResolvedValue(pricedItem("100.01"));
    const { service, prisma } = await makeService(priceItem);

    await service.createProforma(
      {
        customerId: 5,
        documentDate: "2026-07-01",
        isExport: true,
        items: [1, 2, 3].map(() => ({ description: "Stavka", quantity: 1 })),
      },
      actor,
    );

    const written = writtenHeader(prisma.invoice.create);
    expect(written.netTotal.toFixed(2)).toBe("300.03");
    expect(written.vatTotal.toFixed(2)).toBe("0.00");
    expect(written.grossTotal.toFixed(2)).toBe("300.03");
  });
});
