import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { PricingService } from "./pricing.service";
import {
  PricingController,
  validatePricePreview,
  type PricePreviewDto,
} from "./pricing.controller";

/**
 * `POST /v1/sales/price-preview` — ugovor rute (PLAN_UNOS_DOKUMENATA §5.7).
 * Proverava se: omotač `{ data, meta }`, novac kao STRING (nikad Float), tvrda
 * kontrola ulaza na srpskom i da obe zamke dvostrukog umanjenja padaju sa 400.
 */

const D = Prisma.Decimal;

function prismaMock() {
  return {
    item: {
      findUnique: jest.fn().mockResolvedValue({
        wholesalePrice: 100,
        maxDiscountPercent: 100,
        goodsTaxRateCode: "3",
        groupCode: "01",
      }),
    },
    priceListEntry: { findFirst: jest.fn().mockResolvedValue(null) },
    customerDiscount: {
      findMany: jest.fn().mockResolvedValue([
        {
          itemGroupCode: null,
          discountPercent: new D("10"),
          validFrom: new Date("2020-01-01"),
        },
      ]),
    },
    customer: { findUnique: jest.fn().mockResolvedValue(null) },
    stockLevel: {
      findUnique: jest.fn().mockResolvedValue({
        avgPurchaseNet: new D("60"),
        lastPurchaseNet: new D("60"),
      }),
    },
  };
}

describe("PricingController — POST /v1/sales/price-preview", () => {
  let controller: PricingController;
  let prisma: ReturnType<typeof prismaMock>;

  beforeEach(async () => {
    prisma = prismaMock();
    const mod: TestingModule = await Test.createTestingModule({
      controllers: [PricingController],
      providers: [PricingService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    controller = mod.get(PricingController);
  });

  it("vraća { data, meta }, novac kao string, poreklo cene, nabavnu i RUC", async () => {
    const res = await controller.pricePreview({
      itemId: 1,
      customerId: 5,
      quantity: 2,
      warehouseId: 3,
    });

    expect(res.data.unitPrice).toBe("90.0000");
    expect(res.data.basePrice).toBe("100.0000");
    expect(res.data.discountPercent).toBe("10.0000");
    expect(res.data.vatRatePercent).toBe("20.00");
    expect(res.data.vatBase).toBe("180.0000");
    expect(res.data.vatAmount).toBe("36.0000");
    expect(res.data.lineTotal).toBe("216.0000");
    expect(res.data.priceSource).toBe("ITEM_WHOLESALE");
    expect(res.data.purchasePriceNet).toBe("60.0000");
    expect(res.data.markupPercent).toBe("50.0000");
    expect(res.meta.itemId).toBe(1);
    expect(res.meta.warehouseId).toBe(3);

    // Nijedan iznos ne sme izaći kao Float.
    for (const key of ["unitPrice", "basePrice", "vatBase", "vatAmount", "lineTotal"] as const) {
      expect(typeof res.data[key]).toBe("string");
    }
  });

  it("kanal NETO kroz rutu: 85 uz rabat kupca 10% ostaje 85", async () => {
    const res = await controller.pricePreview({
      itemId: 1,
      customerId: 5,
      quantity: 1,
      netUnitPrice: 85,
    });

    expect(res.data.unitPrice).toBe("85.0000");
    expect(res.data.priceSource).toBe("OVERRIDE_NET");
    expect(res.data.priceOverridden).toBe(true);
  });

  describe("tvrda kontrola ulaza (poruke na srpskom)", () => {
    const expectErrors = (dto: PricePreviewDto, fragment: string) => {
      try {
        validatePricePreview(dto);
        throw new Error("očekivana je greška validacije");
      } catch (e) {
        expect(e).toBeInstanceOf(BadRequestException);
        const body = (e as BadRequestException).getResponse() as {
          message: string[];
        };
        expect(body.message.join(" | ")).toContain(fragment);
      }
    };

    it("količina 0 → greška", () => {
      expectErrors({ itemId: 1, quantity: 0 }, "Količina mora biti veća od 0");
    });

    it("oba kanala cene → greška", () => {
      expectErrors(
        { itemId: 1, quantity: 1, overrideUnitPrice: 100, netUnitPrice: 85 },
        "ne obe",
      );
    });

    it("neto cena + rabat → greška", () => {
      expectErrors(
        { itemId: 1, quantity: 1, netUnitPrice: 85, discountPercent: 10 },
        "Neto cena sama određuje rabat",
      );
    });

    it("rabat preko 100% → greška (§4.2: rabat i kasa < 100)", () => {
      expectErrors({ itemId: 1, quantity: 1, discountPercent: 120 }, "Rabat");
      expectErrors(
        { itemId: 1, quantity: 1, cashDiscountPercent: 120 },
        "Kasa-skonto",
      );
    });

    it("stavka bez artikla i bez ručne cene → greška (cena ne nastaje sama)", () => {
      expectErrors({ quantity: 1 }, "cena mora biti uneta ručno");
    });

    it("slobodna uslužna stavka SA ručnom cenom prolazi", () => {
      const args = validatePricePreview({ quantity: 1, overrideUnitPrice: 500 });
      expect(args.itemId).toBeNull();
      // Cena je od 28.07. `Prisma.Decimal`, ne broj — novac više ne prolazi kroz
      // Float ni na ULAZU (v. `base-unit-price.spec.ts`, nalaz 3).
      expect(args.overrideUnitPrice?.toFixed(2)).toBe("500.00");
    });

    it("prazan `priceListCode` se ne šalje kao filter cenovnika", () => {
      const args = validatePricePreview({
        itemId: 1,
        quantity: 1,
        priceListCode: "",
        documentType: "IFR",
      });
      expect(args.priceListCode).toBeNull();
      expect(args.documentType).toBe("IFR");
    });
  });
});
