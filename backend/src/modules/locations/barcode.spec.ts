import {
  isHallType,
  isOperationBarcode,
  isShelfType,
  normalizeBarcodeText,
  normalizeLocMovementKeys,
  parseBigTehnBarcode,
  parseShelfCompositeBarcodeToken,
  parseShortShelfBarcodePair,
  placementRowMatchesPredmetTp,
  resolveCompositeShelfScan,
  type ShelfLoc,
} from "./barcode";

/**
 * Unit paritet parsera barkoda (MODULE_SPEC_lokacije_30.md §3) — primeri su
 * STVARNI iz 1.0 `barcodeParse.js` komentara (RNZ/short/compact) + `shelfBarcode.js`.
 * Ako se ovi primeri promene, port više NIJE veran 1.0.
 */
describe("parseBigTehnBarcode — RNZ / short / compact", () => {
  it("RNZ osnovni: RNZ:8693:7351/1088:0:39757", () => {
    const p = parseBigTehnBarcode("RNZ:8693:7351/1088:0:39757");
    expect(p).toMatchObject({
      orderNo: "7351",
      itemRefId: "1088",
      drawingNo: "",
      format: "rnz",
      idrn: "8693",
      varijanta: "0",
      field4: "39757",
    });
  });

  it("RNZ sa alfanumeričkim TP: RNZ:9833:9400/7-5-S1:1:44963", () => {
    const p = parseBigTehnBarcode("RNZ:9833:9400/7-5-S1:1:44963");
    expect(p).toMatchObject({
      orderNo: "9400",
      itemRefId: "7-5-S1",
      format: "rnz",
      varijanta: "1",
    });
  });

  it("RNZ sa kosom crtom u TP: RNZ:10348:9400/1/300:0:44706", () => {
    const p = parseBigTehnBarcode("RNZ:10348:9400/1/300:0:44706");
    expect(p).toMatchObject({
      orderNo: "9400",
      itemRefId: "1/300",
      format: "rnz",
    });
  });

  it("RNZ predmet-9400 branch fold: 9400-2/415 → nalog 9400, TP 2/415", () => {
    const p = parseBigTehnBarcode("RNZ:100:9400-2/415:0:0");
    expect(p).toMatchObject({
      orderNo: "9400",
      itemRefId: "2/415",
      format: "rnz",
    });
  });

  it("RNZ sa | separatorom (čitač): RNZ|8693|7351/1088|0|39757", () => {
    const p = parseBigTehnBarcode("RNZ|8693|7351/1088|0|39757");
    expect(p).toMatchObject({
      orderNo: "7351",
      itemRefId: "1088",
      format: "rnz",
    });
  });

  it("short format: 7351/1091063 → orderNo + crtež (itemRefId = crtež)", () => {
    const p = parseBigTehnBarcode("7351/1091063");
    expect(p).toMatchObject({
      orderNo: "7351",
      itemRefId: "1091063",
      drawingNo: "1091063",
      format: "short",
    });
  });

  it("compact nalepnica: 9833:9400/7-5:0", () => {
    const p = parseBigTehnBarcode("9833:9400/7-5:0");
    expect(p).toMatchObject({
      orderNo: "9400",
      itemRefId: "7-5",
      format: "compact",
      idrn: "9833",
      varijanta: "0",
    });
  });

  it("compact sa | umesto : (normalizeNonRnzSeparators): 9833|9400/7-5|0", () => {
    const p = parseBigTehnBarcode("9833|9400/7-5|0");
    expect(p).toMatchObject({
      orderNo: "9400",
      itemRefId: "7-5",
      format: "compact",
    });
  });

  it("nepoznat format → null", () => {
    expect(parseBigTehnBarcode("HELLO WORLD")).toBeNull();
    expect(parseBigTehnBarcode("")).toBeNull();
    expect(parseBigTehnBarcode(null)).toBeNull();
  });
});

/**
 * REGRESIJA 30.07 — „barkod naloga koji SAMI štampamo se ne može pročitati".
 * Polje 5 RNZ-a je verzioni pečat: legacy BigTehn je tu imao numerički `PrnTimer`,
 * a 3.0 `formatOrderBarcode` štampa SLOVNU `work_orders.revision` (default „A").
 * Regex je tražio samo cifre pa je magacin odbijao NAŠE naloge. Uzorci su stvarni
 * (testirani na pogonskim nalozima) i moraju svi ostati zeleni.
 */
describe("parseBigTehnBarcode — RNZ polje 5 alfanumeričko (revizija, ne PrnTimer)", () => {
  it("naš 3.0 nalog sa revizijom A: RNZ:10354:9811-3/77:0:A", () => {
    expect(parseBigTehnBarcode("RNZ:10354:9811-3/77:0:A")).toMatchObject({
      orderNo: "9811-3",
      itemRefId: "77",
      format: "rnz",
      idrn: "10354",
      varijanta: "0",
      field4: "A",
    });
  });

  it("naš 3.0 nalog sa revizijom A: RNZ:2597:06/93-4:0:A", () => {
    expect(parseBigTehnBarcode("RNZ:2597:06/93-4:0:A")).toMatchObject({
      orderNo: "06",
      itemRefId: "93-4",
      format: "rnz",
      idrn: "2597",
      varijanta: "0",
      field4: "A",
    });
  });

  it("stari BigTehn PrnTimer i dalje prolazi: RNZ:8693:7351/1088:0:39757", () => {
    expect(parseBigTehnBarcode("RNZ:8693:7351/1088:0:39757")).toMatchObject({
      orderNo: "7351",
      itemRefId: "1088",
      format: "rnz",
      field4: "39757",
    });
  });

  it("nalepnica TP i dalje prolazi: RNZ:0:9811-17/158:0:0", () => {
    expect(parseBigTehnBarcode("RNZ:0:9811-17/158:0:0")).toMatchObject({
      orderNo: "9811-17",
      itemRefId: "158",
      format: "rnz",
      idrn: "0",
      field4: "0",
    });
  });

  it("mala slova revizije (nestabilan CapsLock na wedge čitaču)", () => {
    expect(parseBigTehnBarcode("RNZ:2597:06/93-4:0:a")).toMatchObject({
      orderNo: "06",
      itemRefId: "93-4",
      format: "rnz",
      field4: "a",
    });
  });

  it("applyPredmet9400BranchFold radi i sa slovnom revizijom", () => {
    expect(parseBigTehnBarcode("RNZ:100:9400-2/415:0:A")).toMatchObject({
      orderNo: "9400",
      itemRefId: "2/415",
      format: "rnz",
      field4: "A",
    });
  });

  it("barkod OPERACIJE ostaje null (S: nije stavka za magacin)", () => {
    expect(parseBigTehnBarcode("S:20:8.4:0:A")).toBeNull();
    expect(parseBigTehnBarcode("S:30:7351:0:39757")).toBeNull();
  });

  it("prazno / predugačko polje 5 i dalje pada (nije zamagljen oblik)", () => {
    expect(parseBigTehnBarcode("RNZ:2597:06/93-4:0:")).toBeNull();
    expect(parseBigTehnBarcode("RNZ:2597:06/93-4:0")).toBeNull();
    expect(parseBigTehnBarcode("RNZ:2597:06/93-4:0:AAAAAAAAA")).toBeNull();
    expect(parseBigTehnBarcode("RNZ:2597:06/93-4:0:A:X")).toBeNull();
    // Polje 4 (varijanta) je i dalje SAMO cifre — nije prošireno.
    expect(parseBigTehnBarcode("RNZ:2597:06/93-4:A:A")).toBeNull();
  });

  it("short i compact grane ostaju nedirnute (bez pogrešnog svrstavanja)", () => {
    expect(parseBigTehnBarcode("7351/1091063")).toMatchObject({
      format: "short",
      drawingNo: "1091063",
    });
    expect(parseBigTehnBarcode("9833:9400/7-5:0")).toMatchObject({
      format: "compact",
    });
  });
});

describe("isOperationBarcode — S:{op}:{rc}:0:{rev}", () => {
  it("prepoznaje barkod operacije", () => {
    expect(isOperationBarcode("S:20:8.4:0:A")).toBe(true);
    expect(isOperationBarcode("S:30:7351:0:39757")).toBe(true);
    expect(isOperationBarcode("s|20|8.4|0|A")).toBe(true);
    expect(isOperationBarcode("*S:20:8.4:0:A*")).toBe(true); // Code39 okvir
  });

  it("NE prijavljuje ni jedan drugi format kao operaciju", () => {
    expect(isOperationBarcode("RNZ:10354:9811-3/77:0:A")).toBe(false);
    expect(isOperationBarcode("RNZ:0:9811-17/158:0:0")).toBe(false);
    expect(isOperationBarcode("7351/1091063")).toBe(false);
    expect(isOperationBarcode("9833:9400/7-5:0")).toBe(false);
    expect(isOperationBarcode("H1 - P1")).toBe(false);
    expect(isOperationBarcode("P1")).toBe(false);
    expect(
      isOperationBarcode(
        "LP:11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222",
      ),
    ).toBe(false);
    expect(isOperationBarcode("S:20:8.4:0")).toBe(false); // 3 separatora
    expect(isOperationBarcode("")).toBe(false);
    expect(isOperationBarcode(null)).toBe(false);
  });
});

describe("normalizeBarcodeText / normalizeLocMovementKeys", () => {
  it("skida Code39 *...* okvir", () => {
    expect(normalizeBarcodeText("*7351/1088*")).toBe("7351/1088");
  });

  it("skida CR/LF/TAB i zero-width znakove", () => {
    expect(normalizeBarcodeText("7351/1088\r\n")).toBe("7351/1088");
    expect(normalizeBarcodeText("7351/1088\u200B\uFEFF")).toBe("7351/1088");
  });

  it("9400-2 / 415 → {9400, '2/415'} (kanonski ključ)", () => {
    expect(normalizeLocMovementKeys("9400-2", "415")).toEqual({
      orderNo: "9400",
      itemRefId: "2/415",
    });
  });

  it("9400 / -2/415 → strip vodeće '-' → {9400, '2/415'}", () => {
    expect(normalizeLocMovementKeys("9400", "-2/415")).toEqual({
      orderNo: "9400",
      itemRefId: "2/415",
    });
  });

  it("obični nalog/TP ostaje netaknut", () => {
    expect(normalizeLocMovementKeys("7351", "1088")).toEqual({
      orderNo: "7351",
      itemRefId: "1088",
    });
  });
});

describe("placementRowMatchesPredmetTp", () => {
  it("tačan (order_no, item_ref_id=TP) match", () => {
    const row = {
      orderNo: "7351",
      itemRefId: "1088",
      drawingNo: "",
      quantity: 2,
    };
    expect(placementRowMatchesPredmetTp(row, "7351", "1088")).toBe(true);
  });

  it("nulta količina → ne matchuje", () => {
    const row = {
      orderNo: "7351",
      itemRefId: "1088",
      drawingNo: "",
      quantity: 0,
    };
    expect(placementRowMatchesPredmetTp(row, "7351", "1088")).toBe(false);
  });

  it("drawing_no match uz isti nalog", () => {
    const row = {
      orderNo: "7351",
      itemRefId: "x",
      drawingNo: "1091063",
      quantity: 1,
    };
    expect(placementRowMatchesPredmetTp(row, "7351", "1088", "1091063")).toBe(
      true,
    );
  });

  it("različit nalog → ne matchuje", () => {
    const row = {
      orderNo: "9999",
      itemRefId: "1088",
      drawingNo: "",
      quantity: 1,
    };
    expect(placementRowMatchesPredmetTp(row, "7351", "1088")).toBe(false);
  });
});

describe("shelf barkod: LP:uuid:uuid + HALA-POLICA + šifra police", () => {
  const HALL_ID = "11111111-1111-4111-8111-111111111111";
  const SHELF_ID = "22222222-2222-4222-8222-222222222222";
  const hall: ShelfLoc = {
    id: HALL_ID,
    locationCode: "H1",
    locationType: "WAREHOUSE",
    parentId: null,
    isActive: true,
  };
  const shelf: ShelfLoc = {
    id: SHELF_ID,
    locationCode: "P1",
    locationType: "SHELF",
    parentId: HALL_ID,
    isActive: true,
  };
  const locs = [hall, shelf];
  const locById = new Map(locs.map((l) => [l.id, l]));

  it("tip predikati", () => {
    expect(isHallType("WAREHOUSE")).toBe(true);
    expect(isShelfType("SHELF")).toBe(true);
    expect(isShelfType("WAREHOUSE")).toBe(false);
  });

  it("LP:hala_uuid:polica_uuid → polica + preset hala", () => {
    const tok = parseShelfCompositeBarcodeToken(`LP:${HALL_ID}:${SHELF_ID}`);
    expect(tok).toEqual({ hallId: HALL_ID, shelfId: SHELF_ID });
    const res = resolveCompositeShelfScan(
      `LP:${HALL_ID}:${SHELF_ID}`,
      locs,
      locById,
    );
    expect(res).toEqual({
      ok: true,
      loc: shelf,
      presetHallFilterId: HALL_ID,
    });
  });

  it("kratko 'H1 - P1' → polica + preset hala", () => {
    const pair = parseShortShelfBarcodePair("H1 - P1");
    expect(pair).toEqual({ hallCode: "H1", shelfCode: "P1" });
    const res = resolveCompositeShelfScan("H1 - P1", locs, locById);
    expect(res).toMatchObject({ ok: true, presetHallFilterId: HALL_ID });
    expect(res && res.ok && res.loc.id).toBe(SHELF_ID);
  });

  it("sama šifra police 'P1' (globalno jedinstvena) → polica", () => {
    const res = resolveCompositeShelfScan("P1", locs, locById);
    expect(res).toMatchObject({ ok: true });
    expect(res && res.ok && res.loc.id).toBe(SHELF_ID);
  });

  it("nepoznata šifra police → null (nije naš kompozit)", () => {
    expect(resolveCompositeShelfScan("ZZZ", locs, locById)).toBeNull();
  });
});
