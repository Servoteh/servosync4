import { ValidationPipe } from "@nestjs/common";
import { BadRequestException } from "@nestjs/common";
import {
  CreateStockDocumentItemBodyDto,
  UpdateStockDocumentDto,
  UpdateStockDocumentItemDto,
} from "./update-stock-document.dto";

/**
 * DTO klase izmene robnog dokumenta pod PRAVIM globalnim `ValidationPipe`-om
 * (`transform: true, whitelist: true`, isto kao `main.ts`).
 *
 * ZAŠTO OVAJ TEST POSTOJI: `whitelist: true` iz tela BRIŠE svako polje bez `class-validator`
 * dekoratora. Polje koje se „izgubi" ne pravi grešku — dokument se snimi bez njega i korisnik
 * misli da je sačuvano. Tačno taj bag je 27.07.2026. nađen na `UpdateStockDocumentShippingDto`
 * (bio interfejs → telo je prolazilo nevalidirano). Zato se ovde proverava da SVAKO polje
 * preživi pipe, a ne samo da validacija odbija smeće.
 */

const pipe = new ValidationPipe({ transform: true, whitelist: true });

function run<T>(cls: new () => T, value: unknown): Promise<T> {
  return pipe.transform(value, {
    type: "body",
    metatype: cls,
  }) as Promise<T>;
}

describe("UpdateStockDocumentDto (zaglavlje)", () => {
  it("propušta sva polja zaglavlja (nijedno ne pada kroz whitelist)", async () => {
    const out = await run(UpdateStockDocumentDto, {
      documentDate: "2026-07-25",
      postingDate: "2026-07-26",
      supplierId: 42,
      customerId: 7,
      warehouseId: 2,
      shippingMethod: "sopstveni prevoz",
      note: "napomena",
      deliveryNoteNumber: "OTP-55",
      paymentTerms: "30 dana",
    });
    expect(out).toEqual({
      documentDate: "2026-07-25",
      postingDate: "2026-07-26",
      supplierId: 42,
      customerId: 7,
      warehouseId: 2,
      shippingMethod: "sopstveni prevoz",
      note: "napomena",
      deliveryNoteNumber: "OTP-55",
      paymentTerms: "30 dana",
    });
  });

  it("nepoznato polje se odbacuje (whitelist), poznata ostaju", async () => {
    const out = await run(UpdateStockDocumentDto, {
      note: "ok",
      documentTypeCode: "IFR", // vrsta se NE menja PATCH-om
      documentNumber: "9999/2026", // ni broj
    });
    expect(out).toEqual({ note: "ok" });
  });

  it("`null` na opcionoj vezi je dozvoljen (= briši)", async () => {
    const out = await run(UpdateStockDocumentDto, { supplierId: null });
    expect(out).toEqual({ supplierId: null });
  });

  it("`null` na obaveznom polju (warehouseId) je 400, ne tiho ništa", async () => {
    await expect(
      run(UpdateStockDocumentDto, { warehouseId: null }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("pogrešan tip (broj umesto teksta) je 400 sa srpskom porukom", async () => {
    expect.assertions(2);
    try {
      await run(UpdateStockDocumentDto, { note: 123 });
    } catch (e) {
      expect(e).toBeInstanceOf(BadRequestException);
      const res = (e as BadRequestException).getResponse() as {
        message: string[];
      };
      expect(res.message.join(" ")).toContain("mora biti tekst");
    }
  });
});

describe("CreateStockDocumentItemBodyDto (dodavanje stavke)", () => {
  it("propušta sva kalkulativna polja stavke", async () => {
    const body = {
      itemId: 3,
      warehouseId: 1,
      lineNo: 5,
      quantity: "12.5",
      kgQuantity: "40",
      invoicePrice: "1234.5678",
      discountPercent: "5",
      cashDiscountPercent: "2",
      dependentCostOwn: "10",
      dependentCostSupplier: "20",
      actualWholesalePrice: "1500",
      actualRetailPrice: "1800",
      markupAmount: "100",
      excise: "1",
      fee: "2",
      fixedTax: "3",
      fxPurchasePrice: "10.5",
      customsRate: "5",
      goodsTaxRateCode: "3",
      recalculate: true,
    };
    await expect(run(CreateStockDocumentItemBodyDto, body)).resolves.toEqual(
      body,
    );
  });

  it("prihvata iznos i kao broj i kao string (BACKEND_RULES §6)", async () => {
    await expect(
      run(CreateStockDocumentItemBodyDto, { itemId: 1, quantity: 12.5 }),
    ).resolves.toMatchObject({ quantity: 12.5 });
    await expect(
      run(CreateStockDocumentItemBodyDto, { itemId: 1, quantity: "12.5" }),
    ).resolves.toMatchObject({ quantity: "12.5" });
  });

  it("odbija tekst koji nije broj (inače bi `toDec` tiho vratio 0)", async () => {
    expect.assertions(2);
    try {
      await run(CreateStockDocumentItemBodyDto, {
        itemId: 1,
        quantity: "dvanaest",
      });
    } catch (e) {
      expect(e).toBeInstanceOf(BadRequestException);
      const res = (e as BadRequestException).getResponse() as {
        message: string[];
      };
      expect(res.message.join(" ")).toContain("mora biti broj");
    }
  });

  it("stavka bez artikla / bez količine je 400", async () => {
    await expect(
      run(CreateStockDocumentItemBodyDto, { quantity: 1 }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      run(CreateStockDocumentItemBodyDto, { itemId: 1 }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe("UpdateStockDocumentItemDto (izmena stavke)", () => {
  it("sva polja su opciona — prazno telo prolazi pipe (422 dolazi iz servisa)", async () => {
    await expect(run(UpdateStockDocumentItemDto, {})).resolves.toEqual({});
  });

  it("`quantity: null` je 400 (stavka bez količine ne postoji)", async () => {
    await expect(
      run(UpdateStockDocumentItemDto, { quantity: null }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("propušta zamenu artikla i premeštanje u drugi magacin", async () => {
    await expect(
      run(UpdateStockDocumentItemDto, { itemId: 9, warehouseId: 2 }),
    ).resolves.toEqual({ itemId: 9, warehouseId: 2 });
  });
});
