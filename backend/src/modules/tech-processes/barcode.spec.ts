import { BadRequestException } from "@nestjs/common";
import {
  parseBarcode,
  formatOrderBarcode,
  formatOperationBarcode,
  formatLabelBarcode,
  normalizeScannerLayout,
} from "./barcode";

describe("barcode — parseBarcode", () => {
  it("parsira nalog-barkod (RNZ) sa revizijom u polju 5", () => {
    const d = parseBarcode("RNZ:2597:06/93-4:0:A");
    expect(d.type).toBe("nalog");
    if (d.type !== "nalog") return;
    expect(d.fields).toEqual({
      projectId: 2597,
      identNumber: "06/93-4",
      variant: 0,
      revision: "A",
    });
  });

  it("parsira operacija-barkod (S); polje 4 = identMark, polje 5 = revizija", () => {
    const d = parseBarcode("S:20:RC12:0:B");
    expect(d.type).toBe("operacija");
    if (d.type !== "operacija") return;
    expect(d.fields.operationNumber).toBe(20);
    expect(d.fields.workCenterCode).toBe("RC12");
    expect(d.fields.identMark).toBe("0");
    expect(d.fields.revision).toBe("B");
  });

  it("operationNumber je null kad 'Operacija' nije ceo broj", () => {
    const d = parseBarcode("S:20A:RC12:0:A");
    if (d.type !== "operacija") throw new Error("očekivana operacija");
    expect(d.fields.operationNumber).toBeNull();
    expect(d.fields.operationRaw).toBe("20A");
  });

  it("prihvata legacy numeričku vrednost u polju 5 (stari PrnTimer) kao reviziju-string", () => {
    const d = parseBarcode("RNZ:2597:06/93-4:0:44963");
    if (d.type !== "nalog") throw new Error("očekivan nalog");
    expect(d.fields.revision).toBe("44963");
  });

  it("keyboard-wedge tolerancija: ';' umesto ':' i obrnuta slova (prod logovi 2026-07-10)", () => {
    // Skener na pogonskom računaru šalje ';' (propušten Shift) i mala slova (CapsLock).
    const d = parseBarcode("rnz;10350;9400/3/120;0;44474");
    expect(d.type).toBe("nalog");
    if (d.type !== "nalog") return;
    expect(d.fields).toEqual({
      projectId: 10350,
      identNumber: "9400/3/120",
      variant: 0,
      revision: "44474",
    });

    const op = parseBarcode("S;5;1.10;0:44474"); // mešano ';' i ':'
    expect(op.type).toBe("operacija");
    if (op.type !== "operacija") return;
    expect(op.fields.operationNumber).toBe(5);
    expect(op.fields.workCenterCode).toBe("1.10");
    expect(op.fields.revision).toBe("44474");
  });

  it("revizija se normalizuje u velika slova (nestabilan CapsLock ne kvari isti-otisak poređenje)", () => {
    const d = parseBarcode("RNZ:2597:06/93-4:0:a");
    if (d.type !== "nalog") throw new Error("očekivan nalog");
    expect(d.fields.revision).toBe("A");
  });

  it("baca kad nema tačno 4 separatora", () => {
    expect(() => parseBarcode("RNZ:2597:06/93-4:0")).toThrow(
      BadRequestException,
    );
    expect(() => parseBarcode("RNZ:2597:06/93-4:0:A:X")).toThrow(
      BadRequestException,
    );
  });

  it("baca na nepoznat marker", () => {
    expect(() => parseBarcode("RNS:20:RC12:0:A")).toThrow(BadRequestException);
    expect(() => parseBarcode("X:1:2:3:4")).toThrow(BadRequestException);
  });

  it("IDPredmet=0 je LEGALAN (kratki barkod nalepnice / legacy 1.0, 22.07) — negativan i prazna revizija bacaju", () => {
    const d = parseBarcode("RNZ:0:06/93-4:0:0");
    expect(d.type).toBe("nalog");
    expect(d.fields).toEqual({
      projectId: 0,
      identNumber: "06/93-4",
      variant: 0,
      revision: "0",
    });
    expect(() => parseBarcode("RNZ:-1:06/93-4:0:A")).toThrow(
      BadRequestException,
    );
    expect(() => parseBarcode("RNZ:2597:06/93-4:0:")).toThrow(
      BadRequestException,
    );
  });

  it("baca kad operacija nema radni centar", () => {
    expect(() => parseBarcode("S:20::0:A")).toThrow(BadRequestException);
  });
});

describe("barcode — SR raspored tastature (keyboard-wedge, pogon 2026-07-17)", () => {
  it("normalizuje tačan izobličen sken iz produkcije (SR latinica) u nalog", () => {
    // Očitano "RNYČ9470Č9000-236Č0Č33769" umesto "RNZ:9470:9000/236:0:33769":
    // Z↔Y (QWERTZ), Č→':', '-'→'/'.
    const d = parseBarcode("RNYČ9470Č9000-236Č0Č33769");
    expect(d.type).toBe("nalog");
    if (d.type !== "nalog") return;
    expect(d.fields).toEqual({
      projectId: 9470,
      identNumber: "9000/236",
      variant: 0,
      revision: "33769",
    });
  });

  it("mala slova (nestabilan CapsLock): 'č'→';'→':' preko postojeće zamene", () => {
    const d = parseBarcode("rnyč9470č9000-236č0č33769");
    expect(d.type).toBe("nalog");
    if (d.type !== "nalog") return;
    expect(d.fields).toEqual({
      projectId: 9470,
      identNumber: "9000/236",
      variant: 0,
      revision: "33769",
    });
  });

  it("operacija na SR rasporedu", () => {
    const d = parseBarcode("SČ5Č1.10Č0Č33769");
    expect(d.type).toBe("operacija");
    if (d.type !== "operacija") return;
    expect(d.fields.operationNumber).toBe(5);
    expect(d.fields.workCenterCode).toBe("1.10");
    expect(d.fields.revision).toBe("33769");
  });

  it("pravi minus preživljava round-trip ('/'→'-', '-'→''')", () => {
    // Štampano "06/93-4": '/' na SR daje '-', a '-' daje ''' — obrni oboje.
    const d = parseBarcode("RNYČ2597Č06-93'4Č0ČA");
    expect(d.type).toBe("nalog");
    if (d.type !== "nalog") return;
    expect(d.fields.identNumber).toBe("06/93-4");
  });

  it("bez SR signala NEMA izmene (y/z i minus se ne diraju)", () => {
    const d = parseBarcode("RNZ:1:ABY-1:0:B");
    expect(d.type).toBe("nalog");
    if (d.type !== "nalog") return;
    expect(d.fields.identNumber).toBe("ABY-1");
  });

  it("ćirilica: pogonski računar na SR ćirilici (Р→R, Н→N, Ѕ→Z, Ч→':')", () => {
    const d = parseBarcode("РНЅЧ9470Ч9000-236Ч0Ч33769");
    expect(d.type).toBe("nalog");
    if (d.type !== "nalog") return;
    expect(d.fields).toEqual({
      projectId: 9470,
      identNumber: "9000/236",
      variant: 0,
      revision: "33769",
    });
  });

  it("normalizeScannerLayout: SR latinica → US po poziciji tastera", () => {
    expect(normalizeScannerLayout("RNYČ9470Č9000-236Č0Č33769")).toBe(
      "RNZ:9470:9000/236:0:33769",
    );
  });

  it("normalizeScannerLayout: bez signala vraća ulaz neizmenjen", () => {
    expect(normalizeScannerLayout("RNZ:1:ABY-1:0:B")).toBe("RNZ:1:ABY-1:0:B");
  });
});

describe("barcode — formatOrderBarcode / formatOperationBarcode", () => {
  it("sastavlja nalog-barkod", () => {
    expect(
      formatOrderBarcode({
        projectId: 2597,
        identNumber: "06/93-4",
        variant: 0,
        revision: "A",
      }),
    ).toBe("RNZ:2597:06/93-4:0:A");
  });

  it("sastavlja operacija-barkod sa podrazumevanim poljem 4 = '0'", () => {
    expect(
      formatOperationBarcode({
        operationNumber: 20,
        workCenterCode: "RC12",
        revision: "A",
      }),
    ).toBe("S:20:RC12:0:A");
  });

  it("dozvoljava override polja 4 (identMark/Toznaka)", () => {
    expect(
      formatOperationBarcode({
        operationNumber: 20,
        workCenterCode: "RC12",
        revision: "A",
        identMark: "T7",
      }),
    ).toBe("S:20:RC12:T7:A");
  });

  it("baca na nevalidan ulaz", () => {
    expect(() =>
      formatOrderBarcode({
        projectId: 0,
        identNumber: "x",
        variant: 0,
        revision: "A",
      }),
    ).toThrow();
    expect(() =>
      formatOrderBarcode({
        projectId: 1,
        identNumber: "",
        variant: 0,
        revision: "A",
      }),
    ).toThrow();
    expect(() =>
      formatOrderBarcode({
        projectId: 1,
        identNumber: "a:b",
        variant: 0,
        revision: "A",
      }),
    ).toThrow(/':'/);
    expect(() =>
      formatOperationBarcode({
        operationNumber: 1,
        workCenterCode: "",
        revision: "A",
      }),
    ).toThrow();
  });
});

describe("barcode — round-trip (format → parse)", () => {
  it("nalog: format pa parse vraća ista polja", () => {
    const s = formatOrderBarcode({
      projectId: 123,
      identNumber: "1234/5",
      variant: 2,
      revision: "C",
    });
    const d = parseBarcode(s);
    if (d.type !== "nalog") throw new Error("očekivan nalog");
    expect(d.fields).toEqual({
      projectId: 123,
      identNumber: "1234/5",
      variant: 2,
      revision: "C",
    });
  });

  it("operacija: format pa parse vraća ista polja (identMark='0')", () => {
    const s = formatOperationBarcode({
      operationNumber: 30,
      workCenterCode: "RC99",
      revision: "C",
    });
    const d = parseBarcode(s);
    if (d.type !== "operacija") throw new Error("očekivana operacija");
    expect(d.fields.operationNumber).toBe(30);
    expect(d.fields.workCenterCode).toBe("RC99");
    expect(d.fields.identMark).toBe("0");
    expect(d.fields.revision).toBe("C");
  });

  it("nalepnica (formatLabelBarcode): kratki oblik RNZ:0:{ident}:0:0 i round-trip", () => {
    const s = formatLabelBarcode("9811-17/158");
    expect(s).toBe("RNZ:0:9811-17/158:0:0");
    const d = parseBarcode(s);
    if (d.type !== "nalog") throw new Error("očekivan nalog");
    expect(d.fields.projectId).toBe(0); // servis razrešava predmet po identu
    expect(d.fields.identNumber).toBe("9811-17/158");
    expect(() => formatLabelBarcode("")).toThrow();
    expect(() => formatLabelBarcode("a:b")).toThrow();
  });

  it("nalog i operacija istog otiska dele istu reviziju (isti otisak)", () => {
    const rev = "B";
    const order = parseBarcode(
      formatOrderBarcode({
        projectId: 1,
        identNumber: "10/1",
        variant: 0,
        revision: rev,
      }),
    );
    const op = parseBarcode(
      formatOperationBarcode({
        operationNumber: 10,
        workCenterCode: "RC1",
        revision: rev,
      }),
    );
    if (order.type !== "nalog" || op.type !== "operacija")
      throw new Error("tip");
    expect(order.fields.revision).toBe(op.fields.revision);
  });
});
