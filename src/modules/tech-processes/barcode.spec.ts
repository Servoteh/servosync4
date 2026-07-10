import { BadRequestException } from "@nestjs/common";
import {
  parseBarcode,
  formatOrderBarcode,
  formatOperationBarcode,
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

  it("baca kad je IDPredmet ≤ 0 ili revizija prazna", () => {
    expect(() => parseBarcode("RNZ:0:06/93-4:0:A")).toThrow(
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
