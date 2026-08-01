import "reflect-metadata";
import { BadRequestException } from "@nestjs/common";
import { SYNC_MAP } from "../sync/sync-map.generated";
import {
  ADDITIVE_REFRESH_TABLES,
  NATIVE_COLUMN_TABLES,
  OWNED_PRODUCTION_TABLES,
} from "../sync/table-ownership";
import {
  assertItemIsNative,
  assertItemWritesAllowed,
  isNativeItemId,
  ITEMS_ENTITY,
  ITEMS_WRITE_OPEN,
  ITEM_FIELDS_REQUIRING_MIGRATION,
  itemsSurviveSync,
  NATIVE_ITEM_ID_BASE,
} from "./items.write-policy";
import {
  computeKilogramsPerPiece,
  ITEM_FIELDS,
  toItemColumns,
  validateCreateItem,
  validateUpdateItem,
  type CreateItemDto,
} from "./dto/upsert-item.dto";
import { Prisma } from "@prisma/client";

/** Minimalan ispravan artikal — pojedinačni testovi menjaju po jedno polje. */
function validCreateDto(over: Partial<CreateItemDto> = {}): CreateItemDto {
  return {
    catalogNumber: "00042",
    name: "Lim 3mm S235",
    groupCode: "SIR",
    ...over,
  };
}

function messagesOf(e: unknown): string[] {
  const response = (e as BadRequestException).getResponse() as {
    message: string[];
  };
  return response.message;
}

// ═════════════════════════════════════════════ brana upisa (stanje sinhronizacije)

describe("items.write-policy — brana upisa", () => {
  it("ZATEČENO STANJE: sync ČUVA native artikal, ali je unos i dalje zatvoren", () => {
    // Do 28.07.2026 je ovaj test tvrdio da `items` nije ni u jednom zaštićenom
    // skupu i da je zato upis zatvoren. Rezervisan opseg ključeva je to promenio:
    // native artikal SADA preživljava sync. Razlog za 409 se time PREMESTIO sa
    // tehnike na odluku — i test to mora da kaže, inače bi sledeći čitalac
    // zaključio da je zaštita i dalje jedini razlog.
    expect(ADDITIVE_REFRESH_TABLES.has(ITEMS_ENTITY)).toBe(false);
    expect(NATIVE_COLUMN_TABLES.has(ITEMS_ENTITY)).toBe(false);
    expect(OWNED_PRODUCTION_TABLES.has(ITEMS_ENTITY)).toBe(false);
    expect(itemsSurviveSync()).toBe(true); // ← činjenica (rezervisan opseg)
    expect(ITEMS_WRITE_OPEN).toBe(false); // ← odluka (drži 409)
  });

  it("činjenica i prekidač su ODVOJENI — ispravka jednog ne otvara unos", () => {
    // Srž integracije: jedna funkcija je nekad bila i „preživljava li red" i
    // „sme li se pisati". Ko bi ispravio prvu, otvorio bi drugu bez namere.
    expect(itemsSurviveSync()).toBe(true);
    expect(() => assertItemWritesAllowed()).toThrow(); // i dalje 409
  });

  it("assertItemWritesAllowed(): 409 sa stabilnim `code` i srpskim uputstvom", () => {
    let thrown: unknown;
    try {
      assertItemWritesAllowed();
    } catch (e) {
      thrown = e;
    }
    const body = (thrown as { getResponse: () => Record<string, unknown> })
      .getResponse();
    expect(body.statusCode).toBe(409);
    expect(body.code).toBe("BIGBIT_OWNED_READ_ONLY");
    expect(String(body.message)).toContain("BigBit");
    expect(String(body.message)).toContain("Sinhronizacije");
  });

  it("`items` je FULL REFRESH (watermark: null) — zato brana i postoji", () => {
    const mapping = SYNC_MAP.find((m) => m.source === "R_Artikli");
    expect(mapping).toBeDefined();
    expect(mapping?.watermark).toBeNull();
    expect(mapping?.targetDb).toBe(ITEMS_ENTITY);
  });

  it("NATIVE_COLUMN_TABLES ne bi spasao `items`: nijedno polje forme nije van sync mape", () => {
    // Zaštita „nemapiranih kolona" čuva SAMO ono čega u mapi nema. Za `items` je
    // taj skup PRAZAN, pa upis ne postaje bezbedan ni kad bi se tabela tu upisala.
    const mapping = SYNC_MAP.find((m) => m.source === "R_Artikli");
    const mapped = new Set(mapping?.columns.map((c) => c.field));
    const unmapped = Object.keys(ITEM_FIELDS).filter((f) => !mapped.has(f));
    expect(unmapped).toEqual([]);
  });

  it("popis „traži migraciju” pominje raster i multi-barkod — prateće tabele", () => {
    const all = ITEM_FIELDS_REQUIRING_MIGRATION.map((x) => x.what).join(" | ");
    expect(all).toContain("RasterDef");
    expect(all).toContain("R_Artikli_BarKod");
    expect(ITEM_FIELDS_REQUIRING_MIGRATION.every((x) => x.why.length > 20)).toBe(
      true,
    );
  });

  it("popis NE nabraja ono što je migracija 20260728170000 već isporučila", () => {
    // Popis je radni nalog za vlasnika. Da su isporučene stavke ostale u njemu,
    // sledeći talas bi drugi put platio `source`, `updated_at`, Decimal cene,
    // širi `shelf` i pomerenu sekvencu. Test pada ako se ijedna vrati.
    const all = ITEM_FIELDS_REQUIRING_MIGRATION.map((x) => x.what).join(" | ");
    expect(all).not.toContain("Marker porekla");
    expect(all).not.toContain("updated_at");
    expect(all).not.toContain("Decimal(19,4)");
    expect(all).not.toContain("shelf");
    expect(all).not.toContain("setval");
  });
});

// ═══════════════════════════════════════════════════════ opseg id-a i poreklo

describe("items.write-policy — odvojen opseg id-a (marker porekla)", () => {
  it("BigBit prostor ključeva nije native; native opseg jeste", () => {
    expect(isNativeItemId(1)).toBe(false);
    expect(isNativeItemId(91_199)).toBe(false);
    expect(isNativeItemId(NATIVE_ITEM_ID_BASE - 1)).toBe(false);
    expect(isNativeItemId(NATIVE_ITEM_ID_BASE)).toBe(true);
  });

  it("granica opsega je iznad svakog realnog BigBit id-a (~92k redova)", () => {
    expect(NATIVE_ITEM_ID_BASE).toBeGreaterThan(10_000_000);
  });

  it("assertItemIsNative(): BigBit-origin red → 409 sa uputstvom da se menja u BigBit-u", () => {
    expect(() => assertItemIsNative({ id: NATIVE_ITEM_ID_BASE })).not.toThrow();
    let thrown: unknown;
    try {
      assertItemIsNative({ id: 500 });
    } catch (e) {
      thrown = e;
    }
    const body = (thrown as { getResponse: () => Record<string, unknown> })
      .getResponse();
    expect(body.code).toBe("BIGBIT_OWNED_READ_ONLY");
    expect(String(body.message)).toContain("BigBit");
  });
});

// ═══════════════════════════════════════════════════════════ pokrivenost polja

describe("Katalog polja artikla — paritet sa BigBit formom", () => {
  it("pokriva sve kolone modela `Item` osim četiri koje drži server", () => {
    const mapping = SYNC_MAP.find((m) => m.source === "R_Artikli");
    const serverOwned = ["id", "externalItemId", "signature", "createdAt"];
    const expected = (mapping?.columns ?? [])
      .map((c) => c.field)
      .filter((f) => !serverOwned.includes(f))
      .sort();
    expect(Object.keys(ITEM_FIELDS).sort()).toEqual(expected);
  });

  it("svako polje nosi srpsku oznaku i BigBit izvor", () => {
    for (const [name, spec] of Object.entries(ITEM_FIELDS)) {
      expect(spec.label.length).toBeGreaterThan(1);
      expect(spec.src.length).toBeGreaterThan(1);
      expect(typeof name).toBe("string");
    }
  });

  it("obavezna pri kreiranju su tačno kataloški broj, naziv i grupa", () => {
    const required = Object.entries(ITEM_FIELDS)
      .filter(([, s]) => s.requiredOnCreate)
      .map(([k]) => k)
      .sort();
    expect(required).toEqual(["catalogNumber", "groupCode", "name"]);
  });
});

// ══════════════════════════════════════════════════════════════════ validacija

describe("validateCreateItem", () => {
  it("prolazi minimalan ispravan unos", () => {
    expect(() => validateCreateItem(validCreateDto())).not.toThrow();
  });

  it("nedostaju obavezna polja → 400 sa SVA tri razloga odjednom", () => {
    let thrown: unknown;
    try {
      validateCreateItem({} as CreateItemDto);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(BadRequestException);
    expect(messagesOf(thrown)).toEqual([
      "Kataloški broj je obavezan.",
      "Naziv je obavezan.",
      "Grupa je obavezan.",
    ]);
  });

  it("predugačak tekst → poruka kaže granicu i uneto (BigBit Text(20)/Text(50))", () => {
    let thrown: unknown;
    try {
      validateCreateItem(
        validCreateDto({ catalogNumber: "X".repeat(21), name: "N".repeat(51) }),
      );
    } catch (e) {
      thrown = e;
    }
    expect(messagesOf(thrown)).toEqual([
      "Kataloški broj je duži od dozvoljenih 20 znakova (uneto 21).",
      "Naziv je duži od dozvoljenih 50 znakova (uneto 51).",
    ]);
  });

  it("`shelf` poštuje NAŠU užu kolonu VarChar(10), iako BigBit prima 20", () => {
    expect(() =>
      validateCreateItem(validCreateDto({ shelf: "A".repeat(11) })),
    ).toThrow(BadRequestException);
    expect(() =>
      validateCreateItem(validCreateDto({ shelf: "A".repeat(10) })),
    ).not.toThrow();
  });

  it("HPS van CHECK skupa H/P/S/O → 400", () => {
    let thrown: unknown;
    try {
      validateCreateItem(validCreateDto({ hps: "X" }));
    } catch (e) {
      thrown = e;
    }
    expect(messagesOf(thrown)[0]).toBe(
      "HPS mora biti jedna od vrednosti: H, P, S, O.",
    );
    expect(() =>
      validateCreateItem(validCreateDto({ hps: "S" })),
    ).not.toThrow();
  });

  it("negativna cena i procenat preko 100 → 400 (CHECK-ovi iz BigBit-a)", () => {
    let thrown: unknown;
    try {
      validateCreateItem(
        validCreateDto({ wholesalePrice: -1, maxDiscountPercent: 120, box: -0.5 }),
      );
    } catch (e) {
      thrown = e;
    }
    expect(messagesOf(thrown)).toEqual([
      "Kutija (kg/kom) ne sme biti manji od 0.",
      "VP cena ne sme biti manji od 0.",
      "Maksimalan rabat ne sme biti veći od 100.",
    ]);
  });

  it("cena kao string sa decimalama prolazi; smeće ne prolazi", () => {
    expect(() =>
      validateCreateItem(validCreateDto({ wholesalePrice: "1234.5678" })),
    ).not.toThrow();
    expect(() =>
      validateCreateItem(validCreateDto({ wholesalePrice: "1234.56789" })),
    ).toThrow(BadRequestException);
    expect(() =>
      validateCreateItem(validCreateDto({ wholesalePrice: "abc" })),
    ).toThrow(BadRequestException);
    expect(() =>
      validateCreateItem(validCreateDto({ wholesalePrice: Number.NaN })),
    ).toThrow(BadRequestException);
  });

  it("`paymentTermDays` poštuje SmallInt granicu kolone", () => {
    expect(() =>
      validateCreateItem(validCreateDto({ paymentTermDays: 32_767 })),
    ).not.toThrow();
    expect(() =>
      validateCreateItem(validCreateDto({ paymentTermDays: 32_768 })),
    ).toThrow(BadRequestException);
  });

  it("nepoznato polje se ODBIJA, ne ignoriše tiho", () => {
    let thrown: unknown;
    try {
      validateCreateItem({
        ...validCreateDto(),
        rasterDimenzije: "1000x2000",
      } as CreateItemDto);
    } catch (e) {
      thrown = e;
    }
    expect(messagesOf(thrown)[0]).toBe("Nepoznata polja: rasterDimenzije.");
  });
});

describe("validateUpdateItem", () => {
  it("prazno telo → 400 „Nema polja za izmenu.”", () => {
    let thrown: unknown;
    try {
      validateUpdateItem({});
    } catch (e) {
      thrown = e;
    }
    expect(messagesOf(thrown)).toEqual(["Nema polja za izmenu."]);
  });

  it("podskup polja je dozvoljen (PATCH semantika)", () => {
    expect(() => validateUpdateItem({ name: "Nov naziv" })).not.toThrow();
  });

  it("`null` briše opciono polje, ali ne i obavezno", () => {
    expect(() => validateUpdateItem({ barCode: null })).not.toThrow();
    let thrown: unknown;
    try {
      validateUpdateItem({ name: null as unknown as string });
    } catch (e) {
      thrown = e;
    }
    expect(messagesOf(thrown)).toEqual(["Naziv ne sme biti prazan."]);
  });
});

// ═══════════════════════════════════════════ raster = dimenzije lima (§4.10)

describe("Raster kod Servoteha — kilogrami po komadu table", () => {
  it("verni port `DugmePreracunajTezinuUKomadu` (gustina čelika 7850)", () => {
    // Tabla 1000 × 2000 mm, debljina 3 mm:
    //   3 * 1000 * 2000 * 7850 / 1e9 = 47,1 kg
    expect(computeKilogramsPerPiece(3, 1000, 2000)).toBe(47.1);
    // 2 mm, 1250 × 2500 → 49,0625 kg
    expect(computeKilogramsPerPiece(2, 1250, 2500)).toBe(49.0625);
  });

  it("nula ili negativna dimenzija ne daje rezultat (nema tihe nule)", () => {
    expect(computeKilogramsPerPiece(0, 1000, 2000)).toBeNull();
    expect(computeKilogramsPerPiece(3, -1000, 2000)).toBeNull();
    expect(computeKilogramsPerPiece(3, 1000, "x")).toBeNull();
  });

  it("jedna dimenzija bez druge → 400 sa objašnjenjem", () => {
    let thrown: unknown;
    try {
      validateCreateItem(validCreateDto({ thickness: 3, rasterWidthMm: 1000 }));
    } catch (e) {
      thrown = e;
    }
    expect(messagesOf(thrown)[0]).toContain("i širinu i dužinu table");
  });

  it("dimenzije bez debljine → 400 (debljina je ulaz u formulu)", () => {
    let thrown: unknown;
    try {
      validateCreateItem(
        validCreateDto({ rasterWidthMm: 1000, rasterLengthMm: 2000 }),
      );
    } catch (e) {
      thrown = e;
    }
    expect(messagesOf(thrown)[0]).toContain("debljina mora biti veća od nule");
  });

  it("izmena sme da zada dimenzije uz zatečenu debljinu iz baze", () => {
    expect(() =>
      validateUpdateItem({ rasterWidthMm: 1000, rasterLengthMm: 2000 }, 3),
    ).not.toThrow();
    expect(() =>
      validateUpdateItem({ rasterWidthMm: 1000, rasterLengthMm: 2000 }, 0),
    ).toThrow(BadRequestException);
  });

  it("ručno poslata `box` uz dimenzije → 400 (koja bi vrednost pobedila?)", () => {
    let thrown: unknown;
    try {
      validateCreateItem(
        validCreateDto({
          thickness: 3,
          rasterWidthMm: 1000,
          rasterLengthMm: 2000,
          box: 99,
        }),
      );
    } catch (e) {
      thrown = e;
    }
    expect(messagesOf(thrown)[0]).toContain("se ne šalje zajedno sa dimenzijama");
  });
});

// ══════════════════════════════════════════════════════ mapiranje u kolone

describe("toItemColumns", () => {
  it("prenosi SAMO poslata polja (PATCH ne sme da resetuje ostatak)", () => {
    expect(toItemColumns({ name: "A" })).toEqual({ name: "A" });
  });

  it("prazan tekst postaje NULL, tekst se trimuje", () => {
    expect(toItemColumns({ barCode: "  3800123  ", memo: "   " })).toEqual({
      barCode: "3800123",
      memo: null,
    });
  });

  it("novac se validira kao Decimal, a spušta u broj samo za legacy `Float` kolone", () => {
    const out = toItemColumns({
      wholesalePrice: "1234.5678",
      manualMarkupPercent: "12.5000",
    });
    // `wholesale_price` je `Float` u šemi (traži migraciju) — zato broj.
    expect(out.wholesalePrice).toBe(1234.5678);
    expect(typeof out.wholesalePrice).toBe("number");
    // `manual_markup_percent` JESTE `Decimal(19,4)` — ostaje Decimal.
    expect(out.manualMarkupPercent).toBeInstanceOf(Prisma.Decimal);
    expect(String(out.manualMarkupPercent)).toBe("12.5");
  });

  it("zarez kao decimalni znak se prihvata (srpski unos)", () => {
    expect(toItemColumns({ thickness: "3,5" }).thickness).toBe(3.5);
  });
});
