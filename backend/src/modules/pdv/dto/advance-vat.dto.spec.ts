/**
 * VALIDACIJA AVANSNIH DTO-a — novac sme da stigne kao DECIMAL-STRING.
 * =========================================================================
 * ZAŠTO POSTOJI: drugi krug nezavisnog pregleda je izmerio da dijalog „Označi
 * plaćanje" za ULAZNI avans od izmene FE-a šalje `amount` kao string, a ruta
 * `POST /pdv/advances/incoming/:id/mark-paid` je primala isključivo `number` — pa je
 * vraćala 400 „Plaćen iznos mora biti broj." i pretporez po plaćenom avansu nije mogao
 * da uđe ni u KUF ni u jednu PP-PDV prijavu. Izlazni smer (sales DTO `parseAmount`)
 * string prima od početka; asimetrija dva DTO-a je bila koren.
 *
 * Jedinični testovi servisa ovo nisu videli jer zovu servis sa brojevima.
 */

import { BadRequestException } from "@nestjs/common";
import {
  validateMarkIncomingAdvancePaid,
  validateRecordIncomingAdvance,
} from "./advance-vat.dto";

describe("validateMarkIncomingAdvancePaid — iznos", () => {
  const base = { id: 42, paidAt: "2026-08-05" };

  it("prima DECIMAL-STRING (telo koje ekran zaista šalje)", () => {
    expect(() =>
      validateMarkIncomingAdvancePaid({ ...base, amount: "6000.00" }),
    ).not.toThrow();
  });

  it("prima i broj (staro telo — kompatibilnost)", () => {
    expect(() =>
      validateMarkIncomingAdvancePaid({ ...base, amount: 6000 }),
    ).not.toThrow();
  });

  it("odbija nula i negativan iznos u oba zapisa", () => {
    expect(() =>
      validateMarkIncomingAdvancePaid({ ...base, amount: "0.00" }),
    ).toThrow(BadRequestException);
    expect(() =>
      validateMarkIncomingAdvancePaid({ ...base, amount: -5 }),
    ).toThrow(BadRequestException);
  });

  it("odbija tekst koji nije broj i srpski zapis sa zarezom", () => {
    expect(() =>
      validateMarkIncomingAdvancePaid({ ...base, amount: "6.000,00" }),
    ).toThrow(BadRequestException);
    expect(() =>
      validateMarkIncomingAdvancePaid({
        ...base,
        amount: "šest hiljada",
      }),
    ).toThrow(BadRequestException);
  });

  it("odbija nedostajući iznos", () => {
    expect(() =>
      validateMarkIncomingAdvancePaid({
        ...base,
        amount: undefined as unknown as number,
      }),
    ).toThrow(BadRequestException);
  });
});

describe("validateRecordIncomingAdvance — bruto iznos", () => {
  const base = {
    partnerId: 501,
    documentNumber: "AV-DOB-1/2026",
    documentDate: "2026-07-10",
    vatRateCode: "20",
  };

  it("prima bruto iznos kao string i kao broj", () => {
    expect(() =>
      validateRecordIncomingAdvance({ ...base, grossAmount: "12000.00" }),
    ).not.toThrow();
    expect(() =>
      validateRecordIncomingAdvance({ ...base, grossAmount: 12000 }),
    ).not.toThrow();
  });

  it("odbija prazan i neispravan iznos", () => {
    expect(() =>
      validateRecordIncomingAdvance({ ...base, grossAmount: "" }),
    ).toThrow(BadRequestException);
    expect(() =>
      validateRecordIncomingAdvance({ ...base, grossAmount: Number.NaN }),
    ).toThrow(BadRequestException);
  });
});
