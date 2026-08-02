import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { PricingService } from "./pricing.service";

/**
 * Cenovni motor — lanac `fakturna → rabat → kasa → PDV` i DVA kanala prekucane cene
 * (PLAN_UNOS_DOKUMENATA §4.2/§4.4 „Zamka u našem kodu" + §8/O2).
 *
 * Srce paketa je test „prekucana cena + rabat kupca = ta ista cena": pre ispravke je
 * ekran imao SAMO `overrideUnitPrice` (baznu cenu), pa je dogovorena krajnja cena od 85
 * uz rabat kupca 10% završavala na 76,50 — umanjena DRUGI put. Sad postoji kanal
 * `netUnitPrice` koji rabat izvodi unazad, a stari kanal ostaje „cena pre rabata"
 * (odluka vlasnika §8/O2).
 */

const D = Prisma.Decimal;

function prismaMock() {
  return {
    item: { findUnique: jest.fn().mockResolvedValue(null) },
    priceListEntry: { findFirst: jest.fn().mockResolvedValue(null) },
    customerDiscount: { findMany: jest.fn().mockResolvedValue([]) },
    customer: { findUnique: jest.fn().mockResolvedValue(null) },
    stockLevel: { findUnique: jest.fn().mockResolvedValue(null) },
  };
}

/** Artikal bez kapa rabata (max 100%), PDV 20%. */
function item(overrides: Record<string, unknown> = {}) {
  return {
    wholesalePrice: 100,
    maxDiscountPercent: 100,
    goodsTaxRateCode: "3",
    groupCode: "01",
    ...overrides,
  };
}

describe("PricingService", () => {
  let service: PricingService;
  let prisma: ReturnType<typeof prismaMock>;

  beforeEach(async () => {
    prisma = prismaMock();
    const mod: TestingModule = await Test.createTestingModule({
      providers: [PricingService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = mod.get(PricingService);
  });

  /** Rabat kupca 10% (flat, u važnosti). */
  function customerWith10Percent() {
    prisma.customerDiscount.findMany.mockResolvedValue([
      { itemGroupCode: null, discountPercent: new D("10"), validFrom: new Date("2020-01-01") },
    ]);
  }

  // ── DVOSTRUKO UMANJENJE (§4.4 / §8/O2) ────────────────────────────────────

  describe("prekucana cena i rabat kupca", () => {
    it("kanal NETO: prekucana cena 85 + rabat kupca 10% = TAČNO 85 (pre ispravke: 76,50)", async () => {
      prisma.item.findUnique.mockResolvedValue(item());
      customerWith10Percent();

      const p = await service.priceItem({
        customerId: 5,
        itemId: 1,
        quantity: 1,
        netUnitPrice: 85,
      });

      // Ovo je red zbog kog paket postoji: staro ponašanje je davalo 76.5000.
      expect(p.unitPrice.toFixed(4)).toBe("85.0000");
      expect(p.priceSource).toBe("OVERRIDE_NET");
      expect(p.priceOverridden).toBe(true);
      // Rabat je izveden unazad iz cenovnika (100 → 85), a ne rabat kupca od 10%.
      expect(p.discountPercent.toFixed(4)).toBe("15.0000");
      expect(p.basePrice.toFixed(4)).toBe("100.0000");
      expect(p.discountCapped).toBe(false);

      // Kontrola razlike: isti broj kroz STARI (jedini) kanal i dalje daje 76,50.
      // Baš zato kanal NETO postoji — ekran mora da bira kroz koji šalje.
      const staroPonasanje = await service.priceItem({
        customerId: 5,
        itemId: 1,
        quantity: 1,
        overrideUnitPrice: 85,
      });
      expect(staroPonasanje.unitPrice.toFixed(4)).toBe("76.5000");
    });

    it("kanal CENA ostaje BigBit ponašanje: prekucano 100 + rabat 10% = 90 (rabat OSTAJE, §8/O2)", async () => {
      prisma.item.findUnique.mockResolvedValue(item());
      customerWith10Percent();

      const p = await service.priceItem({
        customerId: 5,
        itemId: 1,
        quantity: 1,
        overrideUnitPrice: 100,
      });

      expect(p.unitPrice.toFixed(4)).toBe("90.0000");
      expect(p.basePrice.toFixed(4)).toBe("100.0000");
      expect(p.priceSource).toBe("OVERRIDE");
      expect(p.discountPercent.toFixed(4)).toBe("10.0000");
    });

    it("rabat se primenjuje TAČNO JEDNOM i pri kasi (85 neto uz kasu 5% ostaje 85)", async () => {
      prisma.item.findUnique.mockResolvedValue(item());
      customerWith10Percent();

      const p = await service.priceItem({
        customerId: 5,
        itemId: 1,
        quantity: 1,
        netUnitPrice: 85,
        cashDiscountPercent: 5,
      });

      expect(p.unitPrice.toFixed(4)).toBe("85.0000");
      expect(p.cashDiscountPercent.toFixed(4)).toBe("5.0000");
      // Invarijanta §4.2: base × (1−r) × (1−k) == neto.
      const recomputed = p.basePrice
        .mul(new D(100).sub(p.discountPercent).div(100))
        .mul(new D(100).sub(p.cashDiscountPercent).div(100));
      expect(recomputed.toFixed(2)).toBe("85.00");
    });

    it("povratak vrednosti iz odgovora u isti kanal NE umanjuje drugi put (round-trip)", async () => {
      prisma.item.findUnique.mockResolvedValue(item());
      customerWith10Percent();

      const first = await service.priceItem({ customerId: 5, itemId: 1, quantity: 1 });
      expect(first.unitPrice.toFixed(4)).toBe("90.0000");

      // Ekran vraća `basePrice` u kanal CENA…
      const echoBase = await service.priceItem({
        customerId: 5,
        itemId: 1,
        quantity: 1,
        overrideUnitPrice: first.basePrice,
      });
      expect(echoBase.unitPrice.toFixed(4)).toBe(first.unitPrice.toFixed(4));

      // …a `unitPrice` u kanal NETO. Oba puta ista cena — nema drugog umanjenja.
      const echoNet = await service.priceItem({
        customerId: 5,
        itemId: 1,
        quantity: 1,
        netUnitPrice: first.unitPrice,
      });
      expect(echoNet.unitPrice.toFixed(4)).toBe(first.unitPrice.toFixed(4));
    });

    it("oba kanala zajedno → 400 (protivrečan unos se ne razrešava tiho)", async () => {
      prisma.item.findUnique.mockResolvedValue(item());
      await expect(
        service.priceItem({
          itemId: 1,
          quantity: 1,
          overrideUnitPrice: 100,
          netUnitPrice: 85,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("neto cena + eksplicitan rabat → 400 (neto sam određuje rabat)", async () => {
      prisma.item.findUnique.mockResolvedValue(item());
      await expect(
        service.priceItem({
          itemId: 1,
          quantity: 1,
          netUnitPrice: 85,
          requestedDiscountPercent: 10,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("negativna cena → 400 (u oba kanala)", async () => {
      await expect(
        service.priceItem({ itemId: 1, quantity: 1, overrideUnitPrice: -1 }),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        service.priceItem({ itemId: 1, quantity: 1, netUnitPrice: -1 }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("neto IZNAD fakturne → rabat 0, fakturna se podiže (bez negativnog rabata)", async () => {
      prisma.item.findUnique.mockResolvedValue(item());

      const p = await service.priceItem({ itemId: 1, quantity: 1, netUnitPrice: 120 });

      expect(p.unitPrice.toFixed(4)).toBe("120.0000");
      expect(p.discountPercent.toFixed(4)).toBe("0.0000");
      expect(p.basePrice.toFixed(4)).toBe("120.0000");
    });

    it("kap rabata pobeđuje otkucanu neto cenu, ali GLASNO (warning + discountCapped)", async () => {
      // Artikal dozvoljava najviše 5% rabata; neto 85 bi tražio 15%.
      prisma.item.findUnique.mockResolvedValue(item({ maxDiscountPercent: 5 }));

      const p = await service.priceItem({ itemId: 1, quantity: 1, netUnitPrice: 85 });

      expect(p.discountCapped).toBe(true);
      expect(p.discountPercent.toFixed(4)).toBe("5.0000");
      expect(p.unitPrice.toFixed(4)).toBe("95.0000");
      expect(p.warnings.join(" ")).toContain("rabat");
    });
  });

  // ── LANAC, KAP, BRANE ──────────────────────────────────────────────────────

  describe("lanac cene", () => {
    it("cenovnik ima prednost nad VP sa artikla i vraća poreklo PRICE_LIST", async () => {
      prisma.item.findUnique.mockResolvedValue(item());
      prisma.priceListEntry.findFirst.mockResolvedValue({
        priceWithoutVat: new D("200"),
      });

      const p = await service.priceItem({ itemId: 1, quantity: 2, documentType: "IFR" });

      expect(p.basePrice.toFixed(4)).toBe("200.0000");
      expect(p.priceSource).toBe("PRICE_LIST");
      expect(p.vatBase.toFixed(4)).toBe("400.0000");
      expect(p.vatAmount.toFixed(4)).toBe("80.0000");
      expect(p.lineTotal.toFixed(4)).toBe("480.0000");
    });

    it("`priceListCode` ima prioritet nad `documentType` kao ključ cenovnika (§4.3)", async () => {
      prisma.item.findUnique.mockResolvedValue(item());
      prisma.priceListEntry.findFirst.mockResolvedValue({
        priceWithoutVat: new D("150"),
      });

      await service.priceItem({
        itemId: 1,
        quantity: 1,
        documentType: "IFR",
        priceListCode: "MP01",
      });

      expect(prisma.priceListEntry.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ documentTypeId: "MP01" }),
        }),
      );
    });

    it("bez cenovnika pada na VP sa artikla (ITEM_WHOLESALE), bez cene → NONE", async () => {
      prisma.item.findUnique.mockResolvedValue(item());
      const withPrice = await service.priceItem({ itemId: 1, quantity: 1 });
      expect(withPrice.priceSource).toBe("ITEM_WHOLESALE");

      prisma.item.findUnique.mockResolvedValue(item({ wholesalePrice: 0 }));
      const without = await service.priceItem({ itemId: 1, quantity: 1 });
      expect(without.priceSource).toBe("NONE");
      expect(without.unitPrice.toFixed(4)).toBe("0.0000");
    });

    it("rabat po grupi artikla pobeđuje flat rabat kupca", async () => {
      prisma.item.findUnique.mockResolvedValue(item());
      prisma.customerDiscount.findMany.mockResolvedValue([
        { itemGroupCode: "01", discountPercent: new D("20"), validFrom: new Date("2024-01-01") },
        { itemGroupCode: null, discountPercent: new D("10"), validFrom: new Date("2024-01-01") },
      ]);

      const p = await service.priceItem({ customerId: 5, itemId: 1, quantity: 1 });

      expect(p.discountPercent.toFixed(4)).toBe("20.0000");
      expect(p.unitPrice.toFixed(4)).toBe("80.0000");
    });

    it("kap na max rabat artikla seče traženi rabat i prijavljuje ga", async () => {
      prisma.item.findUnique.mockResolvedValue(item({ maxDiscountPercent: 15 }));

      const p = await service.priceItem({
        itemId: 1,
        quantity: 1,
        requestedDiscountPercent: 40,
      });

      expect(p.discountCapped).toBe(true);
      expect(p.discountPercent.toFixed(4)).toBe("15.0000");
      expect(p.maxDiscountPercent.toFixed(4)).toBe("15.0000");
      expect(p.warnings.length).toBeGreaterThan(0);
    });

    it("pokvaren šifarnik (max rabat 200%) NE sme dati negativnu cenu", async () => {
      prisma.item.findUnique.mockResolvedValue(item({ maxDiscountPercent: 200 }));

      const p = await service.priceItem({
        itemId: 1,
        quantity: 1,
        requestedDiscountPercent: 150,
      });

      expect(p.discountPercent.toFixed(4)).toBe("100.0000");
      expect(p.unitPrice.toFixed(4)).toBe("0.0000");
      expect(p.unitPrice.isNegative()).toBe(false);
    });

    it("kasa iznad 100% se ograničava (cena ne postaje negativna)", async () => {
      prisma.item.findUnique.mockResolvedValue(item());

      const p = await service.priceItem({
        itemId: 1,
        quantity: 1,
        cashDiscountPercent: 150,
      });

      expect(p.cashDiscountPercent.toFixed(4)).toBe("100.0000");
      expect(p.unitPrice.toFixed(4)).toBe("0.0000");
    });

    it("nepoznata poreska šifra i dalje daje 0% PDV, ali se sada PRIJAVI", async () => {
      prisma.item.findUnique.mockResolvedValue(item({ goodsTaxRateCode: "9" }));

      const p = await service.priceItem({ itemId: 1, quantity: 1 });

      expect(p.vatAmount.toFixed(4)).toBe("0.0000");
      expect(p.vatRatePercent.toFixed(2)).toBe("0.00");
      expect(p.warnings.join(" ")).toContain("Nepoznata poreska šifra");
    });

    it("PDV 10% po šifri 2 (stopa ne curi iz šifre 3)", async () => {
      prisma.item.findUnique.mockResolvedValue(item({ goodsTaxRateCode: "2" }));

      const p = await service.priceItem({ itemId: 1, quantity: 1 });

      expect(p.vatRatePercent.toFixed(2)).toBe("10.00");
      expect(p.vatAmount.toFixed(4)).toBe("10.0000");
    });
  });

  // ── CENA PRE RABATA (za štampu) ────────────────────────────────────────────

  /**
   * `unitPriceBeforeDiscount` je jedini podatak iz kog papir može da iskaže rabat.
   * Do 02.08.2026. se cena pre rabata računala (`basePrice`) i BACALA — nijedan pisac
   * je nije čuvao, pa je štampa rabat vraćala unazad iz cene POSLE rabata. Kod rabata
   * od 100 % ta cena je 0 i unazad se nema iz čega računati.
   */
  describe("cena PRE rabata (upisuje se na stavku, štampa je čita)", () => {
    it("rabat 100 % nuluje cenu, ali puna cena OSTAJE zapisana", async () => {
      prisma.item.findUnique.mockResolvedValue(item());

      const p = await service.priceItem({
        itemId: 1,
        quantity: 10,
        requestedDiscountPercent: 100,
      });

      expect(p.unitPrice.toFixed(4)).toBe("0.0000");
      expect(p.unitPriceBeforeDiscount.toFixed(4)).toBe("100.0000");
    });

    it("važi `unitPrice = unitPriceBeforeDiscount × (1 − rabat/100)`", async () => {
      prisma.item.findUnique.mockResolvedValue(item());

      const p = await service.priceItem({
        itemId: 1,
        quantity: 1,
        requestedDiscountPercent: 10,
      });

      expect(p.unitPriceBeforeDiscount.toFixed(4)).toBe("100.0000");
      expect(p.unitPrice.toFixed(4)).toBe("90.0000");
    });

    it("KASA je već unutra — inače bi red „Rabat“ na papiru nosio i nju", async () => {
      prisma.item.findUnique.mockResolvedValue(item());

      const p = await service.priceItem({
        itemId: 1,
        quantity: 1,
        requestedDiscountPercent: 10,
        cashDiscountPercent: 5,
      });

      // 100 × (1 − 5/100) = 95 → rabat na papiru je 95 − 85,50 = 9,50, tačno 10 % od 95.
      expect(p.unitPriceBeforeDiscount.toFixed(4)).toBe("95.0000");
      expect(p.unitPrice.toFixed(4)).toBe("85.5000");
    });

    it("bez rabata je jednaka ceni stavke (red „Rabat“ ostaje 0,00)", async () => {
      prisma.item.findUnique.mockResolvedValue(item());

      const p = await service.priceItem({ itemId: 1, quantity: 1 });

      expect(p.unitPriceBeforeDiscount.toFixed(4)).toBe(p.unitPrice.toFixed(4));
    });
  });

  // ── NABAVNA / RUC ──────────────────────────────────────────────────────────

  describe("nabavna neto i RUC", () => {
    it("bez magacina se NE izmišljaju (oba null) i zaliha se ne čita", async () => {
      prisma.item.findUnique.mockResolvedValue(item());

      const p = await service.priceItem({ itemId: 1, quantity: 1 });

      expect(p.purchasePriceNet).toBeNull();
      expect(p.markupPercent).toBeNull();
      expect(prisma.stockLevel.findUnique).not.toHaveBeenCalled();
    });

    it("uz magacin daje prosečnu nabavnu i RUC %", async () => {
      prisma.item.findUnique.mockResolvedValue(item());
      prisma.stockLevel.findUnique.mockResolvedValue({
        avgPurchaseNet: new D("80"),
        lastPurchaseNet: new D("70"),
      });

      const p = await service.priceItem({ itemId: 1, quantity: 1, warehouseId: 3 });

      expect(p.purchasePriceNet?.toFixed(4)).toBe("80.0000");
      // (100 − 80)/80 = 25%
      expect(p.markupPercent?.toFixed(4)).toBe("25.0000");
      expect(p.warnings).toEqual([]);
    });

    it("kad prosek nije obračunat uzima poslednju nabavnu", async () => {
      prisma.item.findUnique.mockResolvedValue(item());
      prisma.stockLevel.findUnique.mockResolvedValue({
        avgPurchaseNet: new D("0"),
        lastPurchaseNet: new D("50"),
      });

      const p = await service.priceItem({ itemId: 1, quantity: 1, warehouseId: 3 });

      expect(p.purchasePriceNet?.toFixed(4)).toBe("50.0000");
      expect(p.markupPercent?.toFixed(4)).toBe("100.0000");
    });

    it("cena ispod nabavne → negativan RUC + upozorenje", async () => {
      prisma.item.findUnique.mockResolvedValue(item());
      prisma.stockLevel.findUnique.mockResolvedValue({
        avgPurchaseNet: new D("120"),
        lastPurchaseNet: new D("120"),
      });

      const p = await service.priceItem({ itemId: 1, quantity: 1, warehouseId: 3 });

      expect(p.markupPercent?.isNegative()).toBe(true);
      expect(p.warnings.join(" ")).toContain("ispod nabavne");
    });
  });

  // ── KOMPATIBILNOST SA ŽIVIM TOKOM (createProforma) ─────────────────────────

  it("stari ulaz (bez novih polja) daje isti rezultat kao pre — 100 × rabat 10% = 90", async () => {
    prisma.item.findUnique.mockResolvedValue(item());
    customerWith10Percent();

    const p = await service.priceItem({
      customerId: 5,
      itemId: 1,
      quantity: 3,
      documentType: "PROF",
    });

    expect(p.unitPrice.toFixed(4)).toBe("90.0000");
    expect(p.vatBase.toFixed(4)).toBe("270.0000");
    expect(p.vatAmount.toFixed(4)).toBe("54.0000");
    expect(p.lineTotal.toFixed(4)).toBe("324.0000");
    expect(p.priceOverridden).toBe(false);
  });

  // ── IZNOS STAVKE JE NA PARU (nalaz N2, 02.08.2026) ─────────────────────────

  /**
   * 🔴 IZMEREN KVAR: `vatBase = količina × cena` se upisivalo NEZAOKRUŽENO (kolona je
   * `Decimal(19,4)`), a zbirovi dokumenta (`recalcTotals`) sabirali takve iznose. Štampa
   * svaku stavku prikazuje na dve decimale, zbir ne — pa je račun sa DVE stavke
   * 1,5 × 21,3300 (= 31,9950 po stavci) na papiru imao kolonu `32.00 + 32.00 = 64.00`, a
   * osnovicu `63.99`. Kupac koji sabere odštampanu kolonu dobije drugi broj nego što na
   * računu piše.
   *
   * Ispravka je NA IZVORU, ne u štampi: isti iznos ide u glavnu knjigu, PDV evidenciju,
   * na SEF i u saldakonta — svi moraju da vide ISTI broj. Doneti papir
   * `INOUslugaFaktura 060-26.pdf` to i potvrđuje kao zatečeno pravilo: stavka
   * 19,6 kg × 30,1020 = 589,9992 na njemu stoji kao `590.00`, a zbir svih šest stavki
   * (10.530,75) je zbir BAŠ tako zaokruženih iznosa.
   */
  describe("iznos stavke se zaokružuje na paru (cena ostaje na 4 decimale)", () => {
    it("1,5 × 21,3300 daje osnovicu 32,00 — ne 31,9950", async () => {
      prisma.item.findUnique.mockResolvedValue(item());

      const p = await service.priceItem({
        itemId: 1,
        quantity: new D("1.5"),
        overrideUnitPrice: new D("21.33"),
      });

      // Cena po jedinici ostaje netaknuta — 21,3300 (i 30,1020 din/kg) je legitimna cena;
      // zaokružuje se IZNOS, jer njega kupac plaća i njega papir prikazuje.
      expect(p.unitPrice.toFixed(4)).toBe("21.3300");
      expect(p.vatBase.toFixed(4)).toBe("32.0000");
      expect(p.vatAmount.toFixed(4)).toBe("6.4000"); // 32,00 × 20 %
      expect(p.lineTotal.toFixed(4)).toBe("38.4000");
    });

    it("zbir dve takve stavke je BAŠ zbir odštampanih iznosa (64,00)", async () => {
      prisma.item.findUnique.mockResolvedValue(item());
      const one = async () =>
        (
          await service.priceItem({
            itemId: 1,
            quantity: new D("1.5"),
            overrideUnitPrice: new D("21.33"),
          })
        ).vatBase;

      const zbir = (await one()).add(await one());
      // Papir štampa `32.00 + 32.00`; osnovica dokumenta mora biti TAJ ISTI zbir.
      // Do ispravke: 2 × 31,9950 = 63,9900 → papir je pokazivao kolonu 64,00 uz
      // osnovicu 63,99, dakle broj koji se sabiranjem kolone ne može dobiti.
      expect(zbir.toFixed(2)).toBe("64.00");
      expect(zbir.toFixed(4)).toBe("64.0000");
    });

    it("PDV se računa iz ZAOKRUŽENE osnovice, pa se može ponoviti nad papirom", async () => {
      prisma.item.findUnique.mockResolvedValue(item());

      const p = await service.priceItem({
        itemId: 1,
        quantity: new D("19.6"),
        overrideUnitPrice: new D("30.1020"),
      });

      // 19,6 × 30,1020 = 589,9992 → 590,00 (tako je i na donetom papiru 060/26).
      expect(p.vatBase.toFixed(2)).toBe("590.00");
      expect(p.vatAmount.toFixed(2)).toBe("118.00");
      expect(p.lineTotal.toFixed(2)).toBe("708.00");
    });
  });
});
